-- EduOS 32.7.0: the offline school node, the aggregation gate, EDEN (the
-- root -> district -> school -> edge exchange) and DECN (partner-node
-- failover). Student-level personal data stays in the school tier: the only
-- functions here that read it for EDEN return counts (eduos_eden_source), the
-- names/ids the gate must refuse to release (eduos_eden_identifiers), or the
-- minimum continuity package that is sealed to ONE partner node before it
-- leaves the node (eduos_decn_continuity).

-- ---------------------------------------------------------------------------
-- 1. Offline writes from phones: when it happened vs when it arrived.
-- Live writes leave observed_at NULL (= recorded_at). Replayed writes carry
-- the time the adult saw it, so a late replay never overwrites a newer
-- observation ("latest" is ordered by coalesce(observed_at, recorded_at)).
-- ---------------------------------------------------------------------------
ALTER TABLE safety_rollcall_entries ADD COLUMN observed_at timestamptz, ADD COLUMN queued boolean NOT NULL DEFAULT false;
ALTER TABLE transport_checkins ADD COLUMN observed_at timestamptz, ADD COLUMN queued boolean NOT NULL DEFAULT false;
ALTER TABLE attendance_events ADD COLUMN observed_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX safety_rollcall_observed ON safety_rollcall_entries(incident_id, student_id, (coalesce(observed_at, recorded_at)) DESC);
CREATE INDEX transport_checkins_observed ON transport_checkins(run_id, student_id, (coalesce(observed_at, recorded_at)) DESC);

-- Idempotent replay receipts (Idempotency-Key per user). Opaque: no payload.
CREATE TABLE offline_replays (
  district_id uuid NOT NULL REFERENCES districts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  idem_key text NOT NULL CHECK(idem_key ~ '^[A-Za-z0-9_-]{16,80}$'),
  route text NOT NULL CHECK(route IN ('rollcall','checkin','attendance')),
  status_code integer,
  queued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, idem_key)
);
CREATE INDEX offline_replays_age ON offline_replays(created_at);

-- The node's own actor for audit rows written by the EDEN agent (sync,
-- failover activation, purge). It cannot sign in: no identity provider
-- issues the urn:eduos:system issuer.
INSERT INTO users(id, oidc_issuer, oidc_subject, display_name, email, status)
VALUES ('eeeeeeee-0000-4000-8000-000000000001', 'urn:eduos:system', 'eden-agent', 'EduOS node agent', 'eden-agent@system.invalid', 'disabled')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. District hub: enrolled nodes, enrollment tokens, replay nonces.
-- ---------------------------------------------------------------------------
CREATE TABLE eden_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
  tier text NOT NULL DEFAULT 'school' CHECK(tier IN ('school','edge')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  sign_public text NOT NULL CHECK(length(sign_public) BETWEEN 40 AND 200),
  box_public text NOT NULL CHECK(length(box_public) BETWEEN 40 AND 200),
  cert jsonb NOT NULL,
  cert_serial uuid NOT NULL UNIQUE,
  version text CHECK(version IS NULL OR version ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}$'),
  partner_node_id uuid REFERENCES eden_nodes(id),
  enrolled_by uuid NOT NULL REFERENCES users(id),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  last_health jsonb,
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  revoke_reason text CHECK(revoke_reason IS NULL OR length(revoke_reason) <= 300),
  CHECK(partner_node_id IS NULL OR partner_node_id <> id),
  CHECK((status='revoked') = (revoked_at IS NOT NULL)),
  UNIQUE(district_id, id),
  FOREIGN KEY(district_id, school_id) REFERENCES schools(district_id, id)
);
CREATE UNIQUE INDEX eden_nodes_school_active ON eden_nodes(district_id, school_id, tier) WHERE status='active';
CREATE TABLE eden_enrollment_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  node_id uuid REFERENCES eden_nodes(id),
  CHECK(expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  FOREIGN KEY(district_id, school_id) REFERENCES schools(district_id, id)
);
CREATE TABLE eden_nonces (
  district_id uuid NOT NULL REFERENCES districts(id),
  node_id uuid NOT NULL REFERENCES eden_nodes(id),
  nonce text NOT NULL CHECK(nonce ~ '^[0-9a-f]{32}$'),
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(node_id, nonce)
);
CREATE INDEX eden_nonces_age ON eden_nonces(seen_at);

-- Signed, versioned bundles published down the tree (district-signed, or
-- root-signed and imported by the district). Never updated or deleted.
CREATE TABLE eden_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  kind text NOT NULL CHECK(kind IN ('catalog','branding','lessons','content','revocations')),
  version integer NOT NULL CHECK(version >= 1),
  signer_kind text NOT NULL CHECK(signer_kind IN ('root','district')),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer NOT NULL CHECK(bytes > 0),
  bundle jsonb NOT NULL,
  published_by uuid NOT NULL REFERENCES users(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(district_id, kind, version)
);
CREATE TABLE eden_node_bundles (
  district_id uuid NOT NULL REFERENCES districts(id),
  node_id uuid NOT NULL REFERENCES eden_nodes(id),
  kind text NOT NULL,
  version integer NOT NULL,
  acked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(node_id, kind)
);

-- Aggregates received from nodes (gate output, re-validated on arrival).
-- Versioned: a node's message sequence only moves forward per (kind, period).
CREATE TABLE eden_aggregates (
  district_id uuid NOT NULL REFERENCES districts(id),
  node_id uuid NOT NULL REFERENCES eden_nodes(id),
  school_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind ~ '^[a-z_]{3,40}$'),
  period text NOT NULL CHECK(period ~ '^[0-9A-Za-z:._-]{1,40}$'),
  seq bigint NOT NULL CHECK(seq >= 1),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(node_id, kind, period),
  FOREIGN KEY(district_id, school_id) REFERENCES schools(district_id, id)
);
-- Every inbound message, accepted or not (append-only).
CREATE TABLE eden_inbound_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  node_id uuid REFERENCES eden_nodes(id),
  message_id uuid,
  kind text CHECK(kind IS NULL OR length(kind) <= 40),
  decision text NOT NULL CHECK(decision IN ('accepted','rejected','duplicate','stale')),
  reason text CHECK(reason IS NULL OR length(reason) <= 200),
  bytes integer,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX eden_inbound_message ON eden_inbound_log(node_id, message_id) WHERE decision='accepted';
CREATE INDEX eden_inbound_time ON eden_inbound_log(district_id, received_at DESC);
CREATE TRIGGER eden_inbound_log_append_only BEFORE UPDATE OR DELETE ON eden_inbound_log
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- DECN: the latest SEALED continuity package from each node, addressed to its
-- partner. The district stores ciphertext only (it holds no key to open it).
CREATE TABLE eden_continuity_packages (
  node_id uuid PRIMARY KEY REFERENCES eden_nodes(id),
  district_id uuid NOT NULL REFERENCES districts(id),
  partner_node_id uuid NOT NULL REFERENCES eden_nodes(id),
  envelope jsonb NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer NOT NULL,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE eden_failovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  failed_node_id uuid NOT NULL REFERENCES eden_nodes(id),
  partner_node_id uuid NOT NULL REFERENCES eden_nodes(id),
  status text NOT NULL DEFAULT 'authorized' CHECK(status IN ('authorized','active','handing_back','returned','closed','cancelled')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 300),
  authorized_by uuid NOT NULL REFERENCES users(id),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  package_sha256 text NOT NULL CHECK(package_sha256 ~ '^[0-9a-f]{64}$'),
  activated_at timestamptz,
  restored_counts jsonb,
  handback_reason text CHECK(handback_reason IS NULL OR handback_reason IN ('expired','origin_recovered','ended_by_district')),
  handback_started_at timestamptz,
  ended_by uuid REFERENCES users(id),
  return_envelope jsonb,
  return_sha256 text,
  returned_at timestamptz,
  purge_counts jsonb,
  purged_at timestamptz,
  import_counts jsonb,
  imported_at timestamptz,
  closed_at timestamptz,
  CHECK(failed_node_id <> partner_node_id),
  CHECK(expires_at > authorized_at AND expires_at <= authorized_at + interval '72 hours'),
  UNIQUE(district_id, id),
  FOREIGN KEY(district_id, school_id) REFERENCES schools(district_id, id)
);
CREATE UNIQUE INDEX eden_failovers_open ON eden_failovers(failed_node_id) WHERE status IN ('authorized','active','handing_back','returned');
CREATE TABLE eden_failover_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  failover_id uuid NOT NULL,
  event text NOT NULL CHECK(event IN ('authorized','package_released','activated','handback_started','return_uploaded','purged','imported','closed','cancelled','ended_early')),
  actor text NOT NULL CHECK(length(actor) <= 80),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(length(detail::text) <= 2000),
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id, failover_id) REFERENCES eden_failovers(district_id, id)
);
CREATE TRIGGER eden_failover_events_append_only BEFORE UPDATE OR DELETE ON eden_failover_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- ---------------------------------------------------------------------------
-- 3. School node: outbox, egress log, bundle cache, consent exceptions,
--    hosted (partner) data manifest.
-- ---------------------------------------------------------------------------
CREATE TABLE eden_node_state (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  node_id uuid,
  school_id uuid,
  enrolled_at timestamptz,
  last_attempt_at timestamptz,
  last_ok_at timestamptz,
  last_error text CHECK(last_error IS NULL OR length(last_error) <= 200),
  consecutive_failures integer NOT NULL DEFAULT 0,
  partner jsonb,
  directives jsonb NOT NULL DEFAULT '{}'::jsonb,
  continuity_sha256 text,
  continuity_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Only src/eden/egress.js writes here, and only gate output (checked in code,
-- by a static test, and again at send time).
CREATE TABLE eden_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  seq bigserial NOT NULL UNIQUE,
  kind text NOT NULL CHECK(kind ~ '^[a-z_]{3,40}$'),
  period text NOT NULL,
  payload jsonb NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text CHECK(last_error IS NULL OR length(last_error) <= 200),
  sent_at timestamptz,
  superseded_at timestamptz
);
CREATE INDEX eden_outbox_pending ON eden_outbox(district_id, seq) WHERE sent_at IS NULL AND superseded_at IS NULL;
-- What left (or was refused at) the node: append-only.
CREATE TABLE eden_egress_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  at timestamptz NOT NULL DEFAULT now(),
  destination text NOT NULL CHECK(destination IN ('district','partner_sealed')),
  kind text NOT NULL CHECK(length(kind) <= 40),
  period text CHECK(period IS NULL OR length(period) <= 40),
  decision text NOT NULL CHECK(decision IN ('queued','sent','blocked','consent_exception','sealed_package')),
  reason text CHECK(reason IS NULL OR length(reason) <= 200),
  cells integer,
  cells_suppressed integer,
  bytes integer,
  sha256 text,
  outbox_id uuid,
  actor_user_id uuid REFERENCES users(id)
);
CREATE INDEX eden_egress_time ON eden_egress_log(district_id, at DESC);
CREATE TRIGGER eden_egress_log_append_only BEFORE UPDATE OR DELETE ON eden_egress_log
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TABLE eden_bundle_cache (
  district_id uuid NOT NULL REFERENCES districts(id),
  kind text NOT NULL CHECK(kind IN ('catalog','branding','lessons','content','revocations')),
  version integer NOT NULL,
  signer text NOT NULL,
  sha256 text NOT NULL,
  bundle jsonb NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(district_id, kind)
);
-- Consent-gated exceptions (off unless EDEN_CONSENT_EXCEPTIONS=on).
CREATE TABLE eden_consent_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('records_transfer')),
  consent_reference text NOT NULL CHECK(length(btrim(consent_reference)) BETWEEN 3 AND 120),
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','used','revoked')),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK(approved_by IS NULL OR approved_by <> requested_by),
  CHECK(expires_at <= requested_at + interval '30 days'),
  FOREIGN KEY(district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY(district_id, school_id) REFERENCES schools(district_id, id)
);
-- DECN on the partner: what was restored for a hosted school (so exactly
-- that can be purged at handback), and on the origin: what was merged back.
CREATE TABLE decn_hosting (
  failover_id uuid PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  hosted_school_id uuid NOT NULL,
  origin_node_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','returning','purged')),
  activated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  package_sha256 text NOT NULL,
  restored_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  return_sha256 text,
  returned_at timestamptz,
  purge_counts jsonb,
  purged_at timestamptz,
  FOREIGN KEY(district_id, hosted_school_id) REFERENCES schools(district_id, id)
);
CREATE TABLE decn_hosted_rows (
  district_id uuid NOT NULL REFERENCES districts(id),
  failover_id uuid NOT NULL REFERENCES decn_hosting(failover_id),
  table_name text NOT NULL CHECK(table_name IN ('students','users','district_users','memberships','memberships_reenabled','teacher_student_rosters',
    'transport_routes','transport_stops','transport_rider_assignments','pickup_adults','pickup_tags','pickup_restrictions')),
  row_id text NOT NULL,
  PRIMARY KEY(failover_id, table_name, row_id)
);
CREATE TABLE decn_imports (
  failover_id uuid PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  return_sha256 text NOT NULL,
  counts jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 4. Row-level security.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['offline_replays','eden_nodes','eden_enrollment_tokens','eden_nonces','eden_bundles','eden_node_bundles',
    'eden_aggregates','eden_inbound_log','eden_continuity_packages','eden_failovers','eden_failover_events','eden_node_state',
    'eden_outbox','eden_egress_log','eden_bundle_cache','eden_consent_exceptions','decn_hosting','decn_hosted_rows','decn_imports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

CREATE FUNCTION eduos_eden_reader() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT eduos_owner_session() OR eduos_ctx_role() IN ('eden_hub','eden_agent','superintendent','it_admin')
$$;
-- Replay receipts: your own only.
CREATE POLICY scope_rw ON offline_replays AS RESTRICTIVE FOR ALL
  USING (eduos_is_table_owner() OR user_id = eduos_ctx_user()) WITH CHECK (eduos_is_table_owner() OR user_id = eduos_ctx_user());
-- Hub tables: the hub process (eden_hub) and district superintendent / IT.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['eden_nodes','eden_enrollment_tokens','eden_nonces','eden_bundles','eden_node_bundles','eden_aggregates',
    'eden_inbound_log','eden_continuity_packages','eden_failover_events'] LOOP
    EXECUTE format($p$CREATE POLICY scope_rw ON %I AS RESTRICTIVE FOR ALL
      USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('eden_hub','superintendent','it_admin'))
      WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role() IN ('eden_hub','superintendent','it_admin'))$p$, t);
  END LOOP;
END $$;
-- Failover: only a superintendent authorizes (as themself); the hub and IT move it along.
CREATE POLICY scope_read ON eden_failovers AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('eden_hub','superintendent','it_admin'));
CREATE POLICY scope_insert ON eden_failovers AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role()='superintendent' AND authorized_by=eduos_ctx_user()));
CREATE POLICY scope_update ON eden_failovers AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('eden_hub','superintendent','it_admin'))
  WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role() IN ('eden_hub','superintendent','it_admin'));
-- Node tables: the node agent writes; leads and district IT read.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['eden_node_state','eden_outbox','eden_bundle_cache','decn_hosting','decn_hosted_rows','decn_imports'] LOOP
    EXECUTE format($p$CREATE POLICY scope_read ON %I AS RESTRICTIVE FOR SELECT
      USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('eden_agent','superintendent','it_admin','principal'))$p$, t);
    EXECUTE format($p$CREATE POLICY scope_insert ON %I AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role()='eden_agent')$p$, t);
    EXECUTE format($p$CREATE POLICY scope_update ON %I AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_ctx_role()='eden_agent')
      WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role()='eden_agent')$p$, t);
  END LOOP;
END $$;
CREATE POLICY scope_read ON eden_egress_log AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('eden_agent','superintendent','it_admin','principal'));
CREATE POLICY scope_insert ON eden_egress_log AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role() IN ('eden_agent','superintendent','principal'));
CREATE POLICY scope_read ON eden_consent_exceptions AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('eden_agent','superintendent') OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school()));
CREATE POLICY scope_insert ON eden_consent_exceptions AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() IN ('principal','superintendent') AND requested_by=eduos_ctx_user() AND status='requested'
    AND (eduos_ctx_role()='superintendent' OR school_id=eduos_ctx_school())));
CREATE POLICY scope_update ON eden_consent_exceptions AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('eden_agent','superintendent'))
  WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role() IN ('eden_agent','superintendent'));

-- ---------------------------------------------------------------------------
-- 5. What the node agent may read for EDEN: counts only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION eduos_eden_agent_only() RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT (eduos_ctx_role() = 'eden_agent' OR eduos_owner_session()) THEN RAISE EXCEPTION 'EDEN agent context required' USING ERRCODE = '42501'; END IF;
  IF eduos_ctx_district() IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
END; $$;

CREATE FUNCTION eduos_eden_source(p_kind text, p_school uuid, p_day date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); cells jsonb; meta jsonb := NULL;
BEGIN
  PERFORM eduos_eden_agent_only();
  IF p_kind = 'enrollment_by_grade' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('grade', g, 'count', n)), '[]') INTO cells FROM (
      SELECT grade_level g, count(*)::int n FROM students WHERE district_id=d AND school_id=p_school AND grade_level ~ '^(PK|K|[0-9]{1,2})$' GROUP BY 1) x;
  ELSIF p_kind = 'attendance_daily' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('date', p_day::text, 'grade', g, 'status', st, 'count', n)), '[]') INTO cells FROM (
      SELECT s.grade_level g, coalesce(l.status, 'not_recorded') st, count(*)::int n
        FROM students s
        LEFT JOIN LATERAL (SELECT e.status FROM attendance_events e WHERE e.student_id=s.id AND e.district_id=d AND e.event_date=p_day
                            ORDER BY e.observed_at DESC, e.id DESC LIMIT 1) l ON true
       WHERE s.district_id=d AND s.school_id=p_school AND s.grade_level ~ '^(PK|K|[0-9]{1,2})$'
       GROUP BY 1, 2) x;
  ELSIF p_kind = 'mastery_by_standard' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('standard', code, 'level', lvl, 'count', n)), '[]') INTO cells FROM (
      SELECT ls.code, m.level lvl, count(*)::int n FROM standard_mastery m JOIN learning_standards ls ON ls.id=m.standard_id
       WHERE m.district_id=d AND m.school_id=p_school AND ls.code ~ '^[A-Za-z0-9._-]{1,60}$' GROUP BY 1, 2) x;
  ELSIF p_kind = 'transport_checkins_daily' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('date', p_day::text, 'route', rl, 'event', ev, 'count', n)), '[]') INTO cells FROM (
      SELECT left(regexp_replace(r.bus_label, '[^A-Za-z0-9 #.&()-]', '', 'g'), 32) || ' ' || upper(r.direction) rl,
             coalesce(l.event, 'no_checkin') ev, count(*)::int n
        FROM transport_rider_assignments a JOIN transport_routes r ON r.id=a.route_id
        LEFT JOIN transport_runs run ON run.route_id=r.id AND run.service_date=p_day
        LEFT JOIN LATERAL (SELECT c.event FROM transport_checkins c WHERE c.run_id=run.id AND c.student_id=a.student_id
                            ORDER BY coalesce(c.observed_at, c.recorded_at) DESC, c.id DESC LIMIT 1) l ON true
       WHERE a.district_id=d AND a.school_id=p_school AND a.revoked_at IS NULL AND r.status='active'
       GROUP BY 1, 2) x;
  ELSIF p_kind = 'gradebook_distribution' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('course', cl, 'letter', lt, 'count', n)), '[]') INTO cells FROM (
      SELECT left(regexp_replace(c.subject || ' ' || c.grade_level, '[^A-Za-z0-9 #.&()-]', '', 'g'), 40) cl, left(g.letter, 1) lt, count(*)::int n
        FROM course_final_grades g JOIN courses c ON c.id=g.course_id
       WHERE g.district_id=d AND g.school_id=p_school AND NOT EXISTS(SELECT 1 FROM course_final_grades g2 WHERE g2.supersedes=g.id)
       GROUP BY 1, 2) x;
  ELSIF p_kind = 'safety_summary' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('incident', inc::text, 'status', st, 'count', n)), '[]') INTO cells FROM (
      SELECT i.id inc, coalesce(l.status, 'not_reported') st, count(*)::int n
        FROM safety_incidents i JOIN students s ON s.school_id=i.school_id AND s.district_id=i.district_id
        LEFT JOIN LATERAL (SELECT e.status FROM safety_rollcall_entries e WHERE e.incident_id=i.id AND e.student_id=s.id
                            ORDER BY coalesce(e.observed_at, e.recorded_at) DESC, e.id DESC LIMIT 1) l ON true
       WHERE i.district_id=d AND i.school_id=p_school AND (i.status IN ('pending','active','reunification') OR i.initiated_at >= p_day::timestamptz - interval '1 day')
       GROUP BY 1, 2) x;
    SELECT coalesce(jsonb_object_agg(i.id::text, jsonb_build_object('kind', i.kind, 'drill', i.is_drill, 'status', i.status,
             'startedAt', to_char(i.initiated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'endedAt', CASE WHEN i.closed_at IS NULL THEN NULL ELSE to_char(i.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END)), '{}')
      INTO meta FROM safety_incidents i
     WHERE i.district_id=d AND i.school_id=p_school AND (i.status IN ('pending','active','reunification') OR i.initiated_at >= p_day::timestamptz - interval '1 day');
  ELSE
    RAISE EXCEPTION 'unknown EDEN source %', p_kind;
  END IF;
  RETURN jsonb_build_object('cells', cells, 'meta', meta);
END; $$;

-- Everything the gate must refuse to release (never sent anywhere).
CREATE FUNCTION eduos_eden_identifiers(p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district();
BEGIN
  PERFORM eduos_eden_agent_only();
  RETURN jsonb_build_object(
    'ids', (SELECT coalesce(jsonb_agg(id::text), '[]') FROM students WHERE district_id=d),
    'numbers', (SELECT coalesce(jsonb_agg(local_student_number), '[]') FROM students WHERE district_id=d),
    'names', (SELECT coalesce(jsonb_agg(DISTINCT n), '[]') FROM (
       SELECT display_name n FROM students WHERE district_id=d
       UNION SELECT full_name FROM pickup_adults WHERE district_id=d
       UNION SELECT u.display_name FROM student_user_links l JOIN users u ON u.id=l.user_id WHERE l.district_id=d) x));
END; $$;

-- ---------------------------------------------------------------------------
-- 6. DECN continuity: the MINIMUM a partner needs to run attendance, roll
-- call / SafetyOS, bus check-ins and safe pick-up for this school. No grades,
-- health, cases, messages, contact details of families, or history.
-- ---------------------------------------------------------------------------
CREATE FUNCTION eduos_decn_continuity(p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); staff uuid[];
BEGIN
  PERFORM eduos_eden_agent_only();
  SELECT coalesce(array_agg(DISTINCT m.user_id), '{}') INTO staff FROM memberships m
   WHERE m.district_id=d AND m.school_id=p_school AND m.status='active' AND m.role IN ('principal','teacher','driver');
  RETURN jsonb_build_object(
    'v', 1, 'schoolId', p_school, 'districtId', d,
    'students', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', local_student_number, 'name', display_name, 'grade', grade_level) ORDER BY id), '[]')
                   FROM students WHERE district_id=d AND school_id=p_school),
    'staff', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'issuer', u.oidc_issuer, 'subject', u.oidc_subject, 'name', u.display_name, 'email', u.email,
                'roles', (SELECT jsonb_agg(DISTINCT m.role) FROM memberships m WHERE m.user_id=u.id AND m.district_id=d AND m.school_id=p_school AND m.status='active'
                           AND m.role IN ('principal','teacher','driver'))) ORDER BY u.id), '[]')
                FROM users u WHERE u.id = ANY(staff) AND u.status='active'),
    'rosters', (SELECT coalesce(jsonb_agg(jsonb_build_object('teacher', teacher_user_id, 'student', student_id)), '[]')
                  FROM teacher_student_rosters WHERE district_id=d AND school_id=p_school AND teacher_user_id = ANY(staff)),
    'routes', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'bus', bus_label, 'direction', direction,
                 'driver', CASE WHEN driver_user_id = ANY(staff) THEN driver_user_id END)), '[]')
                 FROM transport_routes WHERE district_id=d AND school_id=p_school AND status='active'),
    'stops', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'route', s.route_id, 'seq', s.seq, 'name', s.name, 'time', s.scheduled_time, 'isSchool', s.is_school)), '[]')
                FROM transport_stops s JOIN transport_routes r ON r.id=s.route_id WHERE s.district_id=d AND s.school_id=p_school AND r.status='active'),
    'riders', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'route', a.route_id, 'stop', a.stop_id, 'student', a.student_id)), '[]')
                 FROM transport_rider_assignments a JOIN transport_routes r ON r.id=a.route_id
                WHERE a.district_id=d AND a.school_id=p_school AND a.revoked_at IS NULL AND r.status='active'),
    'pickupAdults', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'student', student_id, 'name', full_name, 'relationship', relationship, 'kind', kind)), '[]')
                       FROM pickup_adults WHERE district_id=d AND school_id=p_school AND status='approved'),
    'pickupTags', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'adult', t.adult_id, 'hash', t.code_hash, 'hint', t.code_hint,
                     'issuedAt', t.issued_at, 'expiresAt', t.expires_at)), '[]')
                     FROM pickup_tags t JOIN pickup_adults a ON a.id=t.adult_id
                    WHERE t.district_id=d AND t.school_id=p_school AND t.revoked_at IS NULL AND t.expires_at > now() AND a.status='approved'),
    'restrictions', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'student', student_id, 'kind', kind, 'person', person_name,
                       'adult', adult_id, 'detail', detail, 'documentOnFile', document_on_file)), '[]')
                       FROM pickup_restrictions WHERE district_id=d AND school_id=p_school AND status='active'));
END; $$;

-- Restore a partner's package into the real tables (so the existing SafetyOS,
-- pick-up, bus and attendance screens work unchanged) and record every row.
CREATE FUNCTION eduos_decn_restore(p_failover uuid, p_origin uuid, p_expires timestamptz, p_sha text, p_pkg jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); sch uuid := (p_pkg->>'schoolId')::uuid; lead uuid; r jsonb; rid text; v_role text;
        c jsonb := '{}'::jsonb; n int;
BEGIN
  PERFORM eduos_eden_agent_only();
  IF (p_pkg->>'districtId')::uuid IS DISTINCT FROM d THEN RAISE EXCEPTION 'continuity package is for another district'; END IF;
  IF EXISTS(SELECT 1 FROM eden_node_state WHERE district_id=d AND school_id=sch) THEN RAISE EXCEPTION 'a node cannot host its own school'; END IF;
  IF EXISTS(SELECT 1 FROM decn_hosting WHERE failover_id=p_failover) THEN RETURN (SELECT restored_counts FROM decn_hosting WHERE failover_id=p_failover); END IF;
  IF NOT EXISTS(SELECT 1 FROM schools WHERE id=sch AND district_id=d) THEN RAISE EXCEPTION 'hosted school is not in this district directory'; END IF;
  INSERT INTO decn_hosting(failover_id, district_id, hosted_school_id, origin_node_id, expires_at, package_sha256)
  VALUES(p_failover, d, sch, p_origin, p_expires, p_sha);
  -- Staff identities (sign-in by the same district IdP subject).
  FOR r IN SELECT * FROM jsonb_array_elements(p_pkg->'staff') LOOP
    INSERT INTO users(id, oidc_issuer, oidc_subject, display_name, email) VALUES((r->>'id')::uuid, r->>'issuer', r->>'subject', r->>'name', r->>'email')
    ON CONFLICT DO NOTHING RETURNING id::text INTO rid;
    IF rid IS NOT NULL THEN INSERT INTO decn_hosted_rows VALUES(d, p_failover, 'users', rid); END IF;
    IF EXISTS(SELECT 1 FROM users WHERE id=(r->>'id')::uuid AND oidc_subject=r->>'subject') THEN
      INSERT INTO district_users(district_id, user_id) VALUES(d, (r->>'id')::uuid) ON CONFLICT DO NOTHING RETURNING user_id::text INTO rid;
      IF rid IS NOT NULL THEN INSERT INTO decn_hosted_rows VALUES(d, p_failover, 'district_users', rid); END IF;
      FOR v_role IN SELECT jsonb_array_elements_text(coalesce(r->'roles', '[]')) LOOP
        rid := NULL;
        IF EXISTS(SELECT 1 FROM memberships WHERE user_id=(r->>'id')::uuid AND district_id=d AND school_id=sch AND role=v_role AND status='active') THEN
          NULL; -- already able to work here
        ELSIF EXISTS(SELECT 1 FROM memberships WHERE user_id=(r->>'id')::uuid AND district_id=d AND school_id=sch AND role=v_role) THEN
          -- A directory copy of this staff member was disabled when the node was
          -- provisioned: enable it for the failover only (disabled again on purge).
          UPDATE memberships SET status='active' WHERE id=(SELECT id FROM memberships WHERE user_id=(r->>'id')::uuid AND district_id=d AND school_id=sch AND role=v_role LIMIT 1)
          RETURNING id::text INTO rid;
          INSERT INTO decn_hosted_rows VALUES(d, p_failover, 'memberships_reenabled', rid);
        ELSIF NOT EXISTS(SELECT 1 FROM memberships WHERE user_id=(r->>'id')::uuid AND district_id=d) THEN
          -- (one membership per user per district: staff already placed at another school here are not re-homed)
          INSERT INTO memberships(user_id, district_id, school_id, role, status, is_default)
          VALUES((r->>'id')::uuid, d, sch, v_role, 'active', NOT EXISTS(SELECT 1 FROM memberships WHERE user_id=(r->>'id')::uuid AND is_default))
          RETURNING id::text INTO rid;
          INSERT INTO decn_hosted_rows VALUES(d, p_failover, 'memberships', rid);
        END IF;
        IF v_role='principal' AND lead IS NULL THEN lead := (r->>'id')::uuid; END IF;
      END LOOP;
    END IF;
  END LOOP;
  lead := coalesce(lead, 'eeeeeeee-0000-4000-8000-000000000001'::uuid);
  FOR r IN SELECT * FROM jsonb_array_elements(p_pkg->'students') LOOP
    INSERT INTO students(id, district_id, school_id, local_student_number, display_name, grade_level)
    VALUES((r->>'id')::uuid, d, sch, r->>'number', r->>'name', r->>'grade') ON CONFLICT DO NOTHING RETURNING id::text INTO rid;
    IF rid IS NOT NULL THEN INSERT INTO decn_hosted_rows VALUES(d, p_failover, 'students', rid); END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(p_pkg->'rosters') LOOP
    IF EXISTS(SELECT 1 FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='students' AND row_id=r->>'student')
       AND EXISTS(SELECT 1 FROM district_users WHERE district_id=d AND user_id=(r->>'teacher')::uuid) THEN
      INSERT INTO teacher_student_rosters(district_id, school_id, teacher_user_id, student_id, created_by)
      VALUES(d, sch, (r->>'teacher')::uuid, (r->>'student')::uuid, (r->>'teacher')::uuid) ON CONFLICT DO NOTHING RETURNING (teacher_user_id::text || ':' || student_id::text) INTO rid;
      IF rid IS NOT NULL THEN INSERT INTO decn_hosted_rows VALUES(d, p_failover, 'teacher_student_rosters', rid); END IF;
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(p_pkg->'routes') LOOP
    INSERT INTO transport_routes(id, district_id, school_id, name, bus_label, direction, driver_user_id, created_by)
    VALUES((r->>'id')::uuid, d, sch, r->>'name', r->>'bus', r->>'direction',
           CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=(r->>'driver')::uuid) THEN (r->>'driver')::uuid END, lead)
    ON CONFLICT DO NOTHING RETURNING id::text INTO rid;
    IF rid IS NOT NULL THEN INSERT INTO decn_hosted_rows VALUES(d, p_failover, 'transport_routes', rid); END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(p_pkg->'stops') LOOP
    INSERT INTO transport_stops(id, district_id, school_id, route_id, seq, name, scheduled_time, is_school)
    SELECT (r->>'id')::uuid, d, sch, (r->>'route')::uuid, (r->>'seq')::int, r->>'name', (r->>'time')::time, coalesce((r->>'isSchool')::boolean, false)
     WHERE EXISTS(SELECT 1 FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='transport_routes' AND row_id=r->>'route')
    ON CONFLICT DO NOTHING RETURNING id::text INTO rid;
    IF rid IS NOT NULL THEN INSERT INTO decn_hosted_rows VALUES(d, p_failover, 'transport_stops', rid); rid := NULL; END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(p_pkg->'riders') LOOP
    INSERT INTO transport_rider_assignments(id, district_id, school_id, route_id, stop_id, student_id, created_by)
    SELECT (r->>'id')::uuid, d, sch, (r->>'route')::uuid, (r->>'stop')::uuid, (r->>'student')::uuid, lead
     WHERE EXISTS(SELECT 1 FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='transport_stops' AND row_id=r->>'stop')
       AND EXISTS(SELECT 1 FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='students' AND row_id=r->>'student')
    ON CONFLICT DO NOTHING RETURNING id::text INTO rid;
    IF rid IS NOT NULL THEN INSERT INTO decn_hosted_rows VALUES(d, p_failover, 'transport_rider_assignments', rid); rid := NULL; END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(p_pkg->'pickupAdults') LOOP
    INSERT INTO pickup_adults(id, district_id, school_id, student_id, full_name, relationship, kind, status, requested_by, decided_by, decided_at)
    SELECT (r->>'id')::uuid, d, sch, (r->>'student')::uuid, r->>'name', r->>'relationship', r->>'kind', 'approved', lead, lead, now()
     WHERE EXISTS(SELECT 1 FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='students' AND row_id=r->>'student')
    ON CONFLICT DO NOTHING RETURNING id::text INTO rid;
    IF rid IS NOT NULL THEN INSERT INTO decn_hosted_rows VALUES(d, p_failover, 'pickup_adults', rid); rid := NULL; END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(p_pkg->'pickupTags') LOOP
    INSERT INTO pickup_tags(id, district_id, school_id, adult_id, code_hash, code_hint, issued_by, issued_at, expires_at)
    SELECT (r->>'id')::uuid, d, sch, (r->>'adult')::uuid, r->>'hash', r->>'hint', lead, (r->>'issuedAt')::timestamptz, (r->>'expiresAt')::timestamptz
     WHERE EXISTS(SELECT 1 FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='pickup_adults' AND row_id=r->>'adult')
    ON CONFLICT DO NOTHING RETURNING id::text INTO rid;
    IF rid IS NOT NULL THEN INSERT INTO decn_hosted_rows VALUES(d, p_failover, 'pickup_tags', rid); rid := NULL; END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(p_pkg->'restrictions') LOOP
    INSERT INTO pickup_restrictions(id, district_id, school_id, student_id, kind, person_name, adult_id, detail, document_on_file, created_by)
    SELECT (r->>'id')::uuid, d, sch, (r->>'student')::uuid, r->>'kind', r->>'person',
           CASE WHEN EXISTS(SELECT 1 FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='pickup_adults' AND row_id=r->>'adult') THEN (r->>'adult')::uuid END,
           r->>'detail', coalesce((r->>'documentOnFile')::boolean, false), lead
     WHERE EXISTS(SELECT 1 FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='students' AND row_id=r->>'student')
    ON CONFLICT DO NOTHING RETURNING id::text INTO rid;
    IF rid IS NOT NULL THEN INSERT INTO decn_hosted_rows VALUES(d, p_failover, 'pickup_restrictions', rid); rid := NULL; END IF;
  END LOOP;
  SELECT coalesce(jsonb_object_agg(table_name, cnt), '{}') INTO c FROM (SELECT table_name, count(*) cnt FROM decn_hosted_rows WHERE failover_id=p_failover GROUP BY 1) x;
  UPDATE decn_hosting SET restored_counts=c WHERE failover_id=p_failover;
  RETURN c;
END; $$;

-- Everything recorded for the hosted school while hosting: the events the
-- origin node must merge back (append-only; nothing here overwrites).
CREATE FUNCTION eduos_decn_return_package(p_failover uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); h decn_hosting; studs uuid[];
BEGIN
  PERFORM eduos_eden_agent_only();
  SELECT * INTO h FROM decn_hosting WHERE failover_id=p_failover AND district_id=d;
  IF h.failover_id IS NULL THEN RAISE EXCEPTION 'not hosting this failover'; END IF;
  SELECT coalesce(array_agg(row_id::uuid), '{}') INTO studs FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='students';
  RETURN jsonb_build_object('v', 1, 'failoverId', p_failover, 'schoolId', h.hosted_school_id, 'from', h.activated_at,
    'attendance', (SELECT coalesce(jsonb_agg(to_jsonb(e) - 'family_acknowledged_at' - 'family_acknowledged_by'), '[]') FROM attendance_events e WHERE e.district_id=d AND e.student_id = ANY(studs)),
    'incidents', (SELECT coalesce(jsonb_agg(to_jsonb(i)), '[]') FROM safety_incidents i WHERE i.district_id=d AND i.school_id=h.hosted_school_id),
    'safetyEvents', (SELECT coalesce(jsonb_agg(to_jsonb(e)), '[]') FROM safety_events e WHERE e.district_id=d AND e.school_id=h.hosted_school_id),
    'rollcall', (SELECT coalesce(jsonb_agg(to_jsonb(e)), '[]') FROM safety_rollcall_entries e WHERE e.district_id=d AND e.school_id=h.hosted_school_id),
    'runs', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]') FROM transport_runs r WHERE r.district_id=d AND r.school_id=h.hosted_school_id),
    'checkins', (SELECT coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('route_id', r.route_id, 'service_date', r.service_date)), '[]')
                   FROM transport_checkins c JOIN transport_runs r ON r.id=c.run_id WHERE c.district_id=d AND c.school_id=h.hosted_school_id),
    'pickupEvents', (SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]') FROM pickup_events p WHERE p.district_id=d AND p.school_id=h.hosted_school_id),
    'audit', (SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]') FROM audit_events a WHERE a.district_id=d AND a.school_id=h.hosted_school_id AND a.occurred_at >= h.activated_at));
END; $$;

-- Origin node: merge a return package. Inserts only, by id; existing rows win.
CREATE FUNCTION eduos_decn_import_return(p_failover uuid, p_sha text, p_pkg jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); sch uuid := (p_pkg->>'schoolId')::uuid; c jsonb := '{}'::jsonb; n int; skipped int := 0;
BEGIN
  PERFORM eduos_eden_agent_only();
  IF EXISTS(SELECT 1 FROM decn_imports WHERE failover_id=p_failover) THEN RETURN (SELECT counts FROM decn_imports WHERE failover_id=p_failover); END IF;
  IF (p_pkg->>'failoverId')::uuid IS DISTINCT FROM p_failover THEN RAISE EXCEPTION 'return package is for another failover'; END IF;
  IF NOT EXISTS(SELECT 1 FROM eden_node_state WHERE district_id=d AND school_id=sch) THEN RAISE EXCEPTION 'return package is for another school'; END IF;
  INSERT INTO attendance_events(id, district_id, student_id, event_date, status, observed_at)
  SELECT x.id, d, x.student_id, x.event_date, x.status, x.observed_at FROM jsonb_populate_recordset(NULL::attendance_events, p_pkg->'attendance') x
   WHERE EXISTS(SELECT 1 FROM students s WHERE s.id=x.student_id AND s.school_id=sch) ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('attendance', n);
  INSERT INTO safety_incidents SELECT (jsonb_populate_record(NULL::safety_incidents, x || jsonb_build_object('district_id', d))).*
    FROM jsonb_array_elements(p_pkg->'incidents') x
   WHERE (x->>'school_id')::uuid=sch AND EXISTS(SELECT 1 FROM users u WHERE u.id=(x->>'initiated_by')::uuid) ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('incidents', n);
  INSERT INTO safety_events SELECT (jsonb_populate_record(NULL::safety_events, x || jsonb_build_object('district_id', d))).*
    FROM jsonb_array_elements(p_pkg->'safetyEvents') x
   WHERE (x->>'school_id')::uuid=sch AND EXISTS(SELECT 1 FROM safety_incidents i WHERE i.id=(x->>'incident_id')::uuid)
     AND EXISTS(SELECT 1 FROM users u WHERE u.id=(x->>'actor_user_id')::uuid) ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('safety_events', n);
  INSERT INTO safety_rollcall_entries SELECT (jsonb_populate_record(NULL::safety_rollcall_entries, x || jsonb_build_object('district_id', d))).*
    FROM jsonb_array_elements(p_pkg->'rollcall') x
   WHERE (x->>'school_id')::uuid=sch AND EXISTS(SELECT 1 FROM safety_incidents i WHERE i.id=(x->>'incident_id')::uuid)
     AND EXISTS(SELECT 1 FROM students s WHERE s.id=(x->>'student_id')::uuid) AND EXISTS(SELECT 1 FROM users u WHERE u.id=(x->>'recorded_by')::uuid)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('rollcall_entries', n);
  INSERT INTO transport_runs SELECT (jsonb_populate_record(NULL::transport_runs, x || jsonb_build_object('district_id', d))).*
    FROM jsonb_array_elements(p_pkg->'runs') x
   WHERE (x->>'school_id')::uuid=sch AND EXISTS(SELECT 1 FROM transport_routes r WHERE r.id=(x->>'route_id')::uuid)
     AND EXISTS(SELECT 1 FROM users u WHERE u.id=(x->>'driver_user_id')::uuid) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('transport_runs', n);
  -- A run the origin already had for that route and day keeps its id; check-ins follow it.
  INSERT INTO transport_checkins(id, district_id, school_id, run_id, student_id, stop_id, event, recorded_by, recorded_at, note, observed_at, queued)
  SELECT (x->>'id')::uuid, d, sch, run.id, (x->>'student_id')::uuid, (x->>'stop_id')::uuid, x->>'event', (x->>'recorded_by')::uuid,
         (x->>'recorded_at')::timestamptz, x->>'note', (x->>'observed_at')::timestamptz, coalesce((x->>'queued')::boolean, false)
    FROM jsonb_array_elements(p_pkg->'checkins') x
    JOIN transport_runs run ON run.route_id=(x->>'route_id')::uuid AND run.service_date=(x->>'service_date')::date
   WHERE EXISTS(SELECT 1 FROM students s WHERE s.id=(x->>'student_id')::uuid) AND EXISTS(SELECT 1 FROM transport_stops s WHERE s.id=(x->>'stop_id')::uuid)
     AND EXISTS(SELECT 1 FROM users u WHERE u.id=(x->>'recorded_by')::uuid)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('transport_checkins', n);
  INSERT INTO pickup_events SELECT (jsonb_populate_record(NULL::pickup_events, x || jsonb_build_object('district_id', d))).*
    FROM jsonb_array_elements(p_pkg->'pickupEvents') x
   WHERE (x->>'school_id')::uuid=sch AND EXISTS(SELECT 1 FROM students s WHERE s.id=(x->>'student_id')::uuid)
     AND ((x->>'adult_id') IS NULL OR EXISTS(SELECT 1 FROM pickup_adults a WHERE a.id=(x->>'adult_id')::uuid))
     AND ((x->>'tag_id') IS NULL OR EXISTS(SELECT 1 FROM pickup_tags t WHERE t.id=(x->>'tag_id')::uuid))
     AND ((x->>'incident_id') IS NULL OR EXISTS(SELECT 1 FROM safety_incidents i WHERE i.id=(x->>'incident_id')::uuid))
     AND (x->>'early_dismissal_id') IS NULL
     AND EXISTS(SELECT 1 FROM users u WHERE u.id=(x->>'recorded_by')::uuid) ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('pickup_events', n);
  INSERT INTO audit_events SELECT (jsonb_populate_record(NULL::audit_events, x || jsonb_build_object('district_id', d))).*
    FROM jsonb_array_elements(p_pkg->'audit') x
   WHERE EXISTS(SELECT 1 FROM users u WHERE u.id=(x->>'actor_user_id')::uuid) ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('audit_events', n);
  INSERT INTO decn_imports(failover_id, district_id, return_sha256, counts) VALUES(p_failover, d, p_sha, c);
  RETURN c;
END; $$;

-- Partner node: erase everything held for the hosted school.
CREATE FUNCTION eduos_decn_purge(p_failover uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); h decn_hosting; sid uuid; c jsonb := '{}'::jsonb; n int; kept int := 0; deleted int := 0; r record;
BEGIN
  PERFORM eduos_eden_agent_only();
  SELECT * INTO h FROM decn_hosting WHERE failover_id=p_failover AND district_id=d FOR UPDATE;
  IF h.failover_id IS NULL THEN RAISE EXCEPTION 'not hosting this failover'; END IF;
  IF h.status = 'purged' THEN RETURN h.purge_counts; END IF;
  -- Sessions of hosted staff end first.
  UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL AND school_id=h.hosted_school_id AND district_id=d;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('sessions_revoked', n);
  n := 0;
  FOR sid IN SELECT row_id::uuid FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='students' LOOP
    PERFORM eduos_purge_student(sid); n := n + 1;
  END LOOP;
  c := c || jsonb_build_object('students', n);
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM pickup_events WHERE district_id=d AND school_id=h.hosted_school_id;
  DELETE FROM safety_rollcall_entries WHERE district_id=d AND school_id=h.hosted_school_id;
  DELETE FROM safety_events WHERE district_id=d AND school_id=h.hosted_school_id; GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('safety_events', n);
  DELETE FROM safety_incidents WHERE district_id=d AND school_id=h.hosted_school_id; GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('incidents', n);
  DELETE FROM transport_checkins WHERE district_id=d AND school_id=h.hosted_school_id;
  DELETE FROM transport_runs WHERE district_id=d AND school_id=h.hosted_school_id; GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('transport_runs', n);
  DELETE FROM transport_rider_assignments WHERE id IN (SELECT row_id::uuid FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='transport_rider_assignments');
  DELETE FROM transport_stops WHERE id IN (SELECT row_id::uuid FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='transport_stops');
  DELETE FROM transport_routes WHERE id IN (SELECT row_id::uuid FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='transport_routes');
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('transport_routes', n);
  DELETE FROM notification_outbox WHERE district_id=d AND school_id=h.hosted_school_id;
  DELETE FROM flow_events WHERE district_id=d AND school_id=h.hosted_school_id AND occurred_at >= h.activated_at;
  DELETE FROM memberships WHERE id IN (SELECT row_id::uuid FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='memberships');
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('memberships', n);
  UPDATE memberships SET status='disabled' WHERE id IN (SELECT row_id::uuid FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='memberships_reenabled');
  -- Staff accounts created for hosting: deleted, or disabled when this node's
  -- own audit trail references them (audit rows are never deleted).
  FOR r IN SELECT row_id FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='district_users' LOOP
    BEGIN DELETE FROM district_users WHERE district_id=d AND user_id=r.row_id::uuid; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  END LOOP;
  FOR r IN SELECT row_id FROM decn_hosted_rows WHERE failover_id=p_failover AND table_name='users' LOOP
    BEGIN DELETE FROM users WHERE id=r.row_id::uuid; deleted := deleted + 1;
    EXCEPTION WHEN foreign_key_violation THEN UPDATE users SET status='disabled' WHERE id=r.row_id::uuid; kept := kept + 1; END;
  END LOOP;
  c := c || jsonb_build_object('staff_accounts_deleted', deleted, 'staff_accounts_disabled_for_audit', kept);
  PERFORM set_config('eduos.retention_purge', 'off', true);
  c := c || jsonb_build_object('remaining_students', (SELECT count(*) FROM students WHERE district_id=d AND school_id=h.hosted_school_id),
                               'remaining_memberships', (SELECT count(*) FROM memberships WHERE district_id=d AND school_id=h.hosted_school_id AND status='active'),
                               'remaining_pickup_adults', (SELECT count(*) FROM pickup_adults WHERE district_id=d AND school_id=h.hosted_school_id));
  DELETE FROM decn_hosted_rows WHERE failover_id=p_failover;
  UPDATE decn_hosting SET status='purged', purged_at=now(), purge_counts=c WHERE failover_id=p_failover;
  RETURN c;
END; $$;

-- Provisioning helper (owner only): keep one school on a school node.
CREATE FUNCTION eduos_node_prune_to_school(p_keep uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); sid uuid; n int := 0; c jsonb := '{}'::jsonb; m int;
BEGIN
  IF NOT eduos_owner_session() THEN RAISE EXCEPTION 'owner session required' USING ERRCODE='42501'; END IF;
  FOR sid IN SELECT id FROM students WHERE district_id=d AND school_id<>p_keep LOOP PERFORM eduos_purge_student(sid); n := n + 1; END LOOP;
  c := c || jsonb_build_object('students_purged', n);
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM pickup_events WHERE district_id=d AND school_id<>p_keep;
  DELETE FROM safety_rollcall_entries WHERE district_id=d AND school_id<>p_keep;
  DELETE FROM safety_events WHERE district_id=d AND school_id<>p_keep;
  DELETE FROM safety_incidents WHERE district_id=d AND school_id<>p_keep;
  DELETE FROM transport_checkins WHERE district_id=d AND school_id<>p_keep;
  DELETE FROM transport_runs WHERE district_id=d AND school_id<>p_keep;
  DELETE FROM transport_rider_assignments WHERE district_id=d AND school_id<>p_keep;
  DELETE FROM transport_stops WHERE district_id=d AND school_id<>p_keep;
  DELETE FROM transport_routes WHERE district_id=d AND school_id<>p_keep;
  DELETE FROM notification_outbox WHERE district_id=d AND school_id IS NOT NULL AND school_id<>p_keep;
  PERFORM set_config('eduos.retention_purge', 'off', true);
  UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL AND school_id IS NOT NULL AND school_id<>p_keep;
  UPDATE memberships SET status='disabled' WHERE district_id=d AND school_id IS NOT NULL AND school_id<>p_keep AND status='active';
  GET DIAGNOSTICS m = ROW_COUNT; c := c || jsonb_build_object('memberships_disabled', m);
  RETURN c;
END; $$;

REVOKE ALL ON FUNCTION eduos_eden_source(text, uuid, date), eduos_eden_identifiers(uuid), eduos_decn_continuity(uuid),
  eduos_decn_restore(uuid, uuid, timestamptz, text, jsonb), eduos_decn_return_package(uuid), eduos_decn_import_return(uuid, text, jsonb),
  eduos_decn_purge(uuid), eduos_node_prune_to_school(uuid) FROM PUBLIC;
