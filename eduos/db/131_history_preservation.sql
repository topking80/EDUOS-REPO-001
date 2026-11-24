-- TC-08: preserving student history media (archival storage and capacity).
--
-- * Every stored history photo gets a SHA-256 checksum. A scheduled job
--   (npm run history:preserve) re-reads each photo on the district's
--   schedule and compares it; a mismatch or a missing object is flagged to
--   the superintendent.
-- * Photos older than the district's "archive after" age move to a cheaper
--   storage class that still reads instantly (S3 Standard-IA or Glacier
--   Instant Retrieval), in place: same key, same permissions, same links.
--   The copy is re-verified against its checksum before it is recorded.
-- * Legal holds: the records office places one on a student; only the
--   superintendent releases it. While a hold is on, nothing about that
--   student can be deleted (items can't be withdrawn for deletion, photos
--   aren't released from storage) and no Time Capsule is released.
-- * Capacity reporting per school for the records office, without names.
--
-- Donations never enter into any of this: the policy and the quota are
-- district settings only. Numbered 131: 129 is TC-06a (transfer packages),
-- 130 is left for the weather fix's renumbered migration.

DO $$
DECLARE def text; kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='notification_outbox'::regclass AND conname='notification_outbox_kind_check';
  kinds := ARRAY(SELECT DISTINCT (regexp_matches(def, '[''{,]([a-z0-9_]+)(?=[''},])', 'g'))[1]);
  IF NOT 'history_preservation' = ANY(kinds) THEN
    kinds := kinds || 'history_preservation'::text;
    ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check;
    EXECUTE format('ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_kind_check CHECK(kind = ANY(%L::text[]))', kinds);
  END IF;
END $$;

ALTER TABLE private_media_objects
  ADD COLUMN sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN storage_tier text NOT NULL DEFAULT 'standard' CHECK (storage_tier IN ('standard','archive')),
  ADD COLUMN tier_changed_at timestamptz,
  ADD COLUMN integrity_status text NOT NULL DEFAULT 'unverified' CHECK (integrity_status IN ('unverified','ok','mismatch','missing')),
  ADD COLUMN verified_at timestamptz;
-- PR #71 finding 4 (defense in depth): db/056 already confines the runtime
-- role to its own school (district leaders excepted). History photos go
-- further: the runtime role never reads or changes their rows directly, only
-- through the definer functions that check the student relationship
-- (eduos_history_media_get, eduos_capsule_photo_get, ...). This keeps storage
-- keys of other students out of reach even for same-school sessions.
CREATE POLICY history_rows_via_functions ON private_media_objects AS RESTRICTIVE
  USING (purpose <> 'history' OR eduos_is_table_owner())
  WITH CHECK (purpose <> 'history' OR eduos_is_table_owner());

CREATE INDEX private_media_objects_preservation_idx ON private_media_objects(district_id, verified_at NULLS FIRST)
  WHERE purpose = 'history' AND processing_status = 'processed';

CREATE TABLE district_history_preservation_policies (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  verify_every_days integer NOT NULL DEFAULT 90 CHECK (verify_every_days BETWEEN 7 AND 365),
  archive_after_days integer CHECK (archive_after_days IS NULL OR archive_after_days BETWEEN 30 AND 3650),
  capacity_alert_percent integer NOT NULL DEFAULT 80 CHECK (capacity_alert_percent BETWEEN 50 AND 99),
  records_schedule_ref text NOT NULL DEFAULT '' CHECK (length(records_schedule_ref) <= 300),
  set_by uuid NOT NULL REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE district_history_preservation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE district_history_preservation_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON district_history_preservation_policies
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);
CREATE POLICY scope_write ON district_history_preservation_policies AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() = 'superintendent' AND set_by = eduos_ctx_user()));
CREATE POLICY scope_update ON district_history_preservation_policies AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent')
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() = 'superintendent' AND set_by = eduos_ctx_user()));

CREATE TABLE history_legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  matter_ref text CHECK (matter_ref IS NULL OR length(btrim(matter_ref)) BETWEEN 1 AND 120),
  placed_by uuid NOT NULL REFERENCES users(id),
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES users(id),
  released_at timestamptz,
  release_note text CHECK (release_note IS NULL OR length(btrim(release_note)) BETWEEN 5 AND 500),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  CHECK ((released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_note IS NULL))
);
CREATE INDEX history_legal_holds_active ON history_legal_holds(district_id, student_id) WHERE released_at IS NULL;
ALTER TABLE history_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE history_legal_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON history_legal_holds
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);
CREATE POLICY scope_read ON history_legal_holds AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_records_office(school_id));
CREATE POLICY owner_write ON history_legal_holds AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY owner_update ON history_legal_holds AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner());

-- What happened to preserved media and holds. Append-only; no student names.
CREATE TABLE history_preservation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid,
  student_id uuid,
  asset_id uuid,
  hold_id uuid REFERENCES history_legal_holds(id),
  kind text NOT NULL CHECK (kind IN ('checksum_recorded','mismatch','missing','recovered','archived','archive_failed',
    'kept_for_hold','release_held','hold_placed','hold_released','policy_set')),
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 500),
  actor_user_id uuid REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX history_preservation_events_recent ON history_preservation_events(district_id, at DESC);
ALTER TABLE history_preservation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE history_preservation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON history_preservation_events
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);
CREATE POLICY scope_read ON history_preservation_events AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent' OR (school_id IS NOT NULL AND eduos_records_office(school_id)));
CREATE POLICY owner_write ON history_preservation_events AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());

CREATE FUNCTION eduos_history_on_hold(p_district uuid, p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM history_legal_holds h WHERE h.district_id = p_district AND h.student_id = p_student AND h.released_at IS NULL)
$$;

-- The student (and school) a history photo belongs to.
CREATE FUNCTION eduos_history_asset_owner(p_asset uuid, OUT student_id uuid, OUT school_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.student_id, x.school_id FROM (
    SELECT a.student_id, a.school_id FROM student_history_entry_attachments a WHERE a.asset_id = p_asset
    UNION ALL SELECT p.student_id, p.school_id FROM student_history_contribution_photos p WHERE p.asset_id = p_asset
    UNION ALL SELECT p.student_id, p.school_id FROM student_time_capsule_photos p WHERE p.asset_id = p_asset) x LIMIT 1
$$;

CREATE FUNCTION eduos_history_preservation_event(p_district uuid, p_school uuid, p_student uuid, p_asset uuid, p_hold uuid, p_kind text, p_detail text, p_actor uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO history_preservation_events(district_id, school_id, student_id, asset_id, hold_id, kind, detail, actor_user_id)
  VALUES (p_district, p_school, p_student, p_asset, p_hold, p_kind, left(coalesce(p_detail, ''), 500), p_actor)
$$;

-- In-app notice to every active superintendent of the district.
CREATE FUNCTION eduos_history_preservation_notify(p_district uuid, p_title text, p_body text, p_ref uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prior text := current_setting('app.district_id', true);
BEGIN
  -- The outbox is tenant-scoped; the job runs outside any one district.
  PERFORM set_config('app.district_id', p_district::text, true);
  INSERT INTO notification_outbox(district_id, school_id, recipient_user_id, channel, kind, title, body, ref_type, ref_id, status, delivered_at)
  SELECT DISTINCT p_district, NULL::uuid, m.user_id, 'in_app', 'history_preservation', left(p_title, 160), left(p_body, 500), 'history_media', p_ref, 'delivered', now()
    FROM memberships m WHERE m.district_id = p_district AND m.role = 'superintendent' AND m.status = 'active';
  PERFORM set_config('app.district_id', coalesce(prior, ''), true);
END $$;

-- ---------- legal holds ----------
CREATE FUNCTION eduos_history_hold_place(p_student uuid, p_reason text, p_matter text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record; id uuid;
BEGIN
  SELECT st.id, st.school_id, st.district_id INTO s FROM students st WHERE st.id = p_student AND st.district_id = eduos_ctx_district();
  IF NOT FOUND OR NOT eduos_records_office(s.school_id) THEN RAISE EXCEPTION 'student_not_found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO history_legal_holds(district_id, school_id, student_id, reason, matter_ref, placed_by)
    VALUES (s.district_id, s.school_id, s.id, btrim(p_reason), nullif(btrim(coalesce(p_matter, '')), ''), eduos_ctx_user()) RETURNING history_legal_holds.id INTO id;
  PERFORM eduos_history_preservation_event(s.district_id, s.school_id, s.id, NULL, id, 'hold_placed', '', eduos_ctx_user());
  RETURN id;
END $$;

CREATE FUNCTION eduos_history_hold_release(p_hold uuid, p_note text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE h history_legal_holds%ROWTYPE;
BEGIN
  IF coalesce(eduos_ctx_role(), '') <> 'superintendent' THEN RAISE EXCEPTION 'superintendent_only' USING ERRCODE = '42501'; END IF;
  SELECT * INTO h FROM history_legal_holds WHERE id = p_hold AND district_id = eduos_ctx_district() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hold_not_found' USING ERRCODE = 'P0002'; END IF;
  IF h.released_at IS NOT NULL THEN RETURN false; END IF;
  UPDATE history_legal_holds SET released_by = eduos_ctx_user(), released_at = now(), release_note = btrim(p_note) WHERE id = h.id;
  PERFORM eduos_history_preservation_event(h.district_id, h.school_id, h.student_id, NULL, h.id, 'hold_released', '', eduos_ctx_user());
  RETURN true;
END $$;

-- While a hold is on, history items can't be withdrawn for deletion or deleted.
CREATE FUNCTION eduos_history_entry_hold_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF eduos_history_on_hold(OLD.district_id, OLD.student_id) THEN RAISE EXCEPTION 'legal_hold_active' USING ERRCODE = '55000'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.status IN ('pending_deletion','deleted') AND OLD.status IS DISTINCT FROM NEW.status
     AND eduos_history_on_hold(NEW.district_id, NEW.student_id) THEN
    RAISE EXCEPTION 'legal_hold_active' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER history_entry_hold_guard BEFORE UPDATE OF status OR DELETE ON student_history_entries
  FOR EACH ROW EXECUTE FUNCTION eduos_history_entry_hold_guard();

-- A photo being released from storage (a rejected contribution, a cancelled
-- capsule) is kept instead while its student is on hold: the release
-- functions return only the keys they actually released, so the bucket copy
-- stays too.
CREATE FUNCTION eduos_history_media_hold_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o record; hold uuid;
BEGIN
  IF OLD.purpose <> 'history' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'UPDATE' AND NOT (OLD.processing_status = 'processed' AND NEW.processing_status = 'failed') THEN RETURN NEW; END IF;
  SELECT * INTO o FROM eduos_history_asset_owner(OLD.asset_id);
  IF o.student_id IS NULL THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  SELECT h.id INTO hold FROM history_legal_holds h WHERE h.district_id = OLD.district_id AND h.student_id = o.student_id AND h.released_at IS NULL
   ORDER BY h.placed_at LIMIT 1;
  IF hold IS NULL THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  PERFORM eduos_history_preservation_event(OLD.district_id, o.school_id, o.student_id, OLD.asset_id, hold, 'kept_for_hold', lower(TG_OP), eduos_ctx_user());
  RETURN NULL;
END $$;
CREATE TRIGGER history_media_hold_guard BEFORE UPDATE OF processing_status OR DELETE ON private_media_objects
  FOR EACH ROW EXECUTE FUNCTION eduos_history_media_hold_guard();

-- Capsules: a hold blocks release (logged once a day, retried by later runs).
CREATE OR REPLACE FUNCTION eduos_capsule_try_release(p_capsule uuid, p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.student_time_capsules%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.student_time_capsules WHERE id = p_capsule FOR UPDATE;
  IF NOT FOUND OR c.status NOT IN ('sealed','scheduled') THEN RETURN 'not_releasable'; END IF;
  IF public.eduos_history_on_hold(c.district_id, c.student_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.student_time_capsule_events e WHERE e.capsule_id = c.id AND e.event_type = 'release_blocked'
                    AND e.reason_code = 'legal_hold' AND e.occurred_at > now() - interval '1 day') THEN
      PERFORM public.eduos_capsule_event(c, p_actor, 'release_blocked', 'denied', 'legal_hold');
      PERFORM public.eduos_history_preservation_event(c.district_id, c.school_id, c.student_id, NULL, NULL, 'release_held', 'capsule', p_actor);
    END IF;
    RETURN 'held';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.student_time_capsule_recipients r WHERE r.capsule_id = c.id
                  AND r.district_id = c.district_id AND r.consent_status = 'approved'
                  AND public.eduos_history_user_is(c.district_id, c.school_id, c.student_id, r.recipient_user_id, r.recipient_type)) THEN
    IF NOT EXISTS (SELECT 1 FROM public.student_time_capsule_events e WHERE e.capsule_id = c.id AND e.event_type = 'release_blocked'
                    AND e.occurred_at > now() - interval '1 day') THEN
      PERFORM public.eduos_capsule_event(c, p_actor, 'release_blocked', 'denied', 'no_consenting_recipient');
    END IF;
    RETURN 'blocked';
  END IF;
  UPDATE public.student_time_capsules SET status = 'released', released_at = now(), updated_at = now() WHERE id = c.id;
  PERFORM public.eduos_capsule_event(c, p_actor, 'released', 'success', NULL);
  RETURN 'released';
END $$;

CREATE OR REPLACE FUNCTION eduos_capsule_release_milestone(p_capsule uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.student_time_capsules%ROWTYPE; outcome text;
BEGIN
  SELECT * INTO c FROM public.student_time_capsules WHERE id = p_capsule;
  IF NOT FOUND OR coalesce(public.eduos_history_relation(c.district_id, c.school_id, c.student_id), '') NOT IN ('school_lead','district') THEN
    RAISE EXCEPTION 'capsule_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF c.release_kind <> 'milestone' OR c.status <> 'sealed' THEN RAISE EXCEPTION 'capsule_not_awaiting_milestone' USING ERRCODE = '55000'; END IF;
  IF public.eduos_history_on_hold(c.district_id, c.student_id) THEN RAISE EXCEPTION 'legal_hold_active' USING ERRCODE = '55000'; END IF;
  PERFORM public.eduos_capsule_event(c, eduos_ctx_user(), 'release_attempted', 'success', 'milestone_confirmed');
  outcome := public.eduos_capsule_try_release(c.id, eduos_ctx_user());
  IF outcome = 'blocked' THEN RAISE EXCEPTION 'capsule_has_no_consenting_recipient' USING ERRCODE = '55000'; END IF;
  RETURN outcome;
END $$;

-- ---------- checksums, verification and tiers ----------
-- The upload path records the processed photo's checksum once, right after storing it.
CREATE FUNCTION eduos_history_media_checksum(p_asset uuid, p_sha256 text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  UPDATE private_media_objects SET sha256 = p_sha256, integrity_status = 'ok', verified_at = now()
   WHERE asset_id = p_asset AND district_id = eduos_ctx_district() AND purpose = 'history' AND processing_status = 'processed'
     AND sha256 IS NULL AND updated_at > now() - interval '1 hour';
  RETURN FOUND;
END $$;

-- Work for the preservation job, across districts: photos due for a check,
-- and verified photos old enough to move to the archive class.
CREATE FUNCTION eduos_history_preservation_due(p_limit integer DEFAULT 200)
RETURNS TABLE(asset_id uuid, district_id uuid, storage_key text, sha256 text, byte_size bigint, action text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.asset_id, o.district_id, o.storage_key, o.sha256, o.byte_size,
         CASE WHEN o.integrity_status = 'ok' AND o.storage_tier = 'standard' AND p.archive_after_days IS NOT NULL
                   AND o.created_at < now() - make_interval(days => p.archive_after_days) THEN 'archive' ELSE 'verify' END
    FROM private_media_objects o LEFT JOIN district_history_preservation_policies p ON p.district_id = o.district_id
   WHERE o.purpose = 'history' AND o.processing_status = 'processed' AND o.scan_status = 'clean'
     AND (o.verified_at IS NULL OR o.verified_at < now() - make_interval(days => coalesce(p.verify_every_days, 90))
          OR o.integrity_status IN ('mismatch','missing')
          OR (o.integrity_status = 'ok' AND o.storage_tier = 'standard' AND p.archive_after_days IS NOT NULL
              AND o.created_at < now() - make_interval(days => p.archive_after_days)))
   ORDER BY o.verified_at NULLS FIRST, o.asset_id
   LIMIT greatest(1, least(p_limit, 2000))
$$;

-- The job's result for one photo: ok (sha256 = what it read), mismatch,
-- missing, archived (sha256 must match the recorded checksum), archive_failed.
CREATE FUNCTION eduos_history_preservation_record(p_asset uuid, p_outcome text, p_sha256 text, p_detail text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o private_media_objects%ROWTYPE; w record; was text;
BEGIN
  IF p_outcome NOT IN ('ok','mismatch','missing','archived','archive_failed') THEN RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = '22023'; END IF;
  SELECT * INTO o FROM private_media_objects WHERE asset_id = p_asset AND purpose = 'history' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT * INTO w FROM eduos_history_asset_owner(o.asset_id);
  was := o.integrity_status;
  IF p_outcome = 'ok' THEN
    IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_checksum' USING ERRCODE = '22023'; END IF;
    IF o.sha256 IS NOT NULL AND o.sha256 <> p_sha256 THEN p_outcome := 'mismatch';
    ELSE
      UPDATE private_media_objects SET sha256 = p_sha256, integrity_status = 'ok', verified_at = now() WHERE asset_id = o.asset_id;
      IF o.sha256 IS NULL THEN PERFORM eduos_history_preservation_event(o.district_id, w.school_id, w.student_id, o.asset_id, NULL, 'checksum_recorded', 'first check', NULL); END IF;
      IF was IN ('mismatch','missing') THEN PERFORM eduos_history_preservation_event(o.district_id, w.school_id, w.student_id, o.asset_id, NULL, 'recovered', was, NULL); END IF;
      RETURN 'ok';
    END IF;
  END IF;
  IF p_outcome = 'archived' THEN
    IF o.sha256 IS NULL OR p_sha256 IS DISTINCT FROM o.sha256 THEN p_outcome := 'archive_failed'; p_detail := 'checksum after copy did not match';
    ELSE
      UPDATE private_media_objects SET storage_tier = 'archive', tier_changed_at = now(), integrity_status = 'ok', verified_at = now() WHERE asset_id = o.asset_id;
      PERFORM eduos_history_preservation_event(o.district_id, w.school_id, w.student_id, o.asset_id, NULL, 'archived', p_detail, NULL);
      RETURN 'archived';
    END IF;
  END IF;
  IF p_outcome = 'archive_failed' THEN
    PERFORM eduos_history_preservation_event(o.district_id, w.school_id, w.student_id, o.asset_id, NULL, 'archive_failed', p_detail, NULL);
    RETURN 'archive_failed';
  END IF;
  -- mismatch / missing
  UPDATE private_media_objects SET integrity_status = p_outcome, verified_at = now() WHERE asset_id = o.asset_id;
  IF was IS DISTINCT FROM p_outcome THEN
    PERFORM eduos_history_preservation_event(o.district_id, w.school_id, w.student_id, o.asset_id, NULL, p_outcome, p_detail, NULL);
    PERFORM eduos_history_preservation_notify(o.district_id,
      CASE p_outcome WHEN 'missing' THEN 'A student history photo is missing from storage' ELSE 'A student history photo failed its integrity check' END,
      'The preservation check could not confirm a stored photo. Restore it from the bucket''s versions or backup (see Preservation in Student history).', o.asset_id);
  END IF;
  RETURN p_outcome;
END $$;

-- Capacity per school, for the records office (superintendent: every
-- school; principal / vice principal: their own). Counts only, no names.
CREATE FUNCTION eduos_history_capacity_report()
RETURNS TABLE(school_id uuid, school_name text, students_with_media bigint, used_bytes bigint, archive_bytes bigint,
              near_limit bigint, at_limit bigint, unverified bigint, verified bigint, mismatch bigint, missing bigint, active_holds bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH pol AS (
    SELECT coalesce(m.max_bytes_per_student, 262144000) AS max_bytes, coalesce(m.max_image_bytes, 10485760) AS max_image,
           coalesce(p.capacity_alert_percent, 80) AS alert
      FROM (SELECT eduos_ctx_district() AS d) x
      LEFT JOIN district_history_media_policies m ON m.district_id = x.d
      LEFT JOIN district_history_preservation_policies p ON p.district_id = x.d),
  links AS (
    SELECT a.school_id, a.student_id, a.asset_id FROM student_history_entry_attachments a WHERE a.district_id = eduos_ctx_district()
    UNION SELECT p.school_id, p.student_id, p.asset_id FROM student_history_contribution_photos p WHERE p.district_id = eduos_ctx_district()
    UNION SELECT p.school_id, p.student_id, p.asset_id FROM student_time_capsule_photos p WHERE p.district_id = eduos_ctx_district()),
  live AS (
    SELECT l.school_id, l.student_id, o.byte_size, o.storage_tier, o.integrity_status FROM links l
      JOIN private_media_objects o ON o.asset_id = l.asset_id AND o.district_id = eduos_ctx_district()
     WHERE o.purpose = 'history' AND o.scan_status <> 'blocked' AND o.processing_status <> 'failed'),
  per_student AS (SELECT l.school_id, l.student_id, sum(l.byte_size) AS used FROM live l GROUP BY 1, 2)
  SELECT s.id, s.name,
         (SELECT count(*) FROM per_student ps WHERE ps.school_id = s.id),
         coalesce((SELECT sum(l.byte_size) FROM live l WHERE l.school_id = s.id), 0)::bigint,
         coalesce((SELECT sum(l.byte_size) FROM live l WHERE l.school_id = s.id AND l.storage_tier = 'archive'), 0)::bigint,
         (SELECT count(*) FROM per_student ps, pol WHERE ps.school_id = s.id AND ps.used * 100 >= pol.max_bytes * pol.alert),
         (SELECT count(*) FROM per_student ps, pol WHERE ps.school_id = s.id AND ps.used + pol.max_image > pol.max_bytes),
         (SELECT count(*) FROM live l WHERE l.school_id = s.id AND l.integrity_status = 'unverified'),
         (SELECT count(*) FROM live l WHERE l.school_id = s.id AND l.integrity_status = 'ok'),
         (SELECT count(*) FROM live l WHERE l.school_id = s.id AND l.integrity_status = 'mismatch'),
         (SELECT count(*) FROM live l WHERE l.school_id = s.id AND l.integrity_status = 'missing'),
         (SELECT count(*) FROM history_legal_holds h WHERE h.district_id = s.district_id AND h.school_id = s.id AND h.released_at IS NULL)
    FROM schools s
   WHERE s.district_id = eduos_ctx_district() AND eduos_records_office(s.id)
   ORDER BY s.name
$$;

-- When the preservation job last confirmed a photo in my district (records office).
CREATE FUNCTION eduos_history_last_check() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT max(o.verified_at) FROM private_media_objects o
   WHERE o.district_id = eduos_ctx_district() AND o.purpose = 'history'
     AND coalesce(eduos_ctx_role(), '') IN ('superintendent','principal','vice_principal')
$$;

REVOKE ALL ON FUNCTION eduos_history_last_check(), eduos_history_on_hold(uuid, uuid), eduos_history_asset_owner(uuid),
  eduos_history_preservation_event(uuid, uuid, uuid, uuid, uuid, text, text, uuid), eduos_history_preservation_notify(uuid, text, text, uuid),
  eduos_history_hold_place(uuid, text, text), eduos_history_hold_release(uuid, text), eduos_history_entry_hold_guard(), eduos_history_media_hold_guard(),
  eduos_history_media_checksum(uuid, text), eduos_history_preservation_due(integer), eduos_history_preservation_record(uuid, text, text, text),
  eduos_history_capacity_report() FROM PUBLIC;
