-- HSP-06 part 2: compliance profiles (design: docs/product/hsp-06b-compliance-profiles.md).
--
-- A planning aid, not a determination of legal compliance:
--   * Templates describe one jurisdiction's requirements for homeschool
--     families or private schools. Only the platform publishes them, from a
--     reviewed file (src/compliance-template.js), and each must name its
--     sources, effective date, last-reviewed date and reviewer. The runtime
--     role can only read published ones.
--   * A family or school adopts a template, or sets up its own requirements
--     (labelled as set by them), for a school year. The adopted requirements
--     are copied, so a later template change doesn't silently change a year
--     already planned.
--   * Progress (days and hours) is computed from the tenant's own attendance;
--     checklist items record what the tenant says it has done and where its
--     evidence is kept. Nothing is filed with, or sent to, any agency.

CREATE TABLE compliance_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^US-[A-Z]{2}$'),
  applies_to text NOT NULL CHECK (applies_to IN ('homeschool_family','private_school')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 160),
  version text NOT NULL CHECK (version ~ '^[0-9]{4}\.[0-9]+$'),
  requirements jsonb NOT NULL CHECK (jsonb_typeof(requirements) = 'object' AND length(requirements::text) <= 20000),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) BETWEEN 1 AND 10),
  authority_name text NOT NULL CHECK (length(btrim(authority_name)) BETWEEN 3 AND 200),
  authority_url text NOT NULL CHECK (authority_url ~ '^https://'),
  effective_from date NOT NULL,
  last_reviewed_on date NOT NULL,
  reviewed_by text NOT NULL CHECK (length(btrim(reviewed_by)) BETWEEN 3 AND 200),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published','retired')),
  published_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  UNIQUE (jurisdiction, applies_to, version)
);
CREATE FUNCTION eduos_compliance_template_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'templates are retired, not deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.requirements IS DISTINCT FROM OLD.requirements OR NEW.sources IS DISTINCT FROM OLD.sources OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction OR NEW.applies_to IS DISTINCT FROM OLD.applies_to OR NEW.last_reviewed_on IS DISTINCT FROM OLD.last_reviewed_on THEN
    RAISE EXCEPTION 'a published template does not change; publish a new version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compliance_templates_fixed BEFORE UPDATE OR DELETE ON compliance_templates FOR EACH ROW EXECUTE FUNCTION eduos_compliance_template_fixed();

CREATE TABLE compliance_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_kind text NOT NULL CHECK (tenant_kind IN ('homeschool_family','private_school')),
  family_id uuid REFERENCES homeschool_families(id),
  school_id uuid REFERENCES private_schools(id),
  school_year text NOT NULL CHECK (school_year ~ '^[0-9]{4}-[0-9]{4}$'),
  template_id uuid REFERENCES compliance_templates(id),
  requirements jsonb NOT NULL CHECK (jsonb_typeof(requirements) = 'object' AND length(requirements::text) <= 20000),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 3 AND 200),
  retention_years integer CHECK (retention_years IS NULL OR retention_years BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  adopted_by uuid NOT NULL REFERENCES users(id),
  adopted_at timestamptz NOT NULL DEFAULT now(),
  ended_by uuid REFERENCES users(id),
  ended_at timestamptz,
  CHECK ((tenant_kind = 'homeschool_family') = (family_id IS NOT NULL) AND (tenant_kind = 'private_school') = (school_id IS NOT NULL)),
  CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX compliance_profiles_one_family ON compliance_profiles(family_id, school_year) WHERE status = 'active' AND family_id IS NOT NULL;
CREATE UNIQUE INDEX compliance_profiles_one_school ON compliance_profiles(school_id, school_year) WHERE status = 'active' AND school_id IS NOT NULL;

CREATE TABLE compliance_checklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES compliance_profiles(id),
  family_id uuid,
  school_id uuid,
  item_key text NOT NULL CHECK (item_key ~ '^[a-z0-9_]{2,60}$'),
  learner_id uuid,
  status text NOT NULL CHECK (status IN ('done','not_applicable','to_do')),
  done_on date,
  evidence_ref text CHECK (evidence_ref IS NULL OR length(btrim(evidence_ref)) BETWEEN 2 AND 300),
  note text CHECK (note IS NULL OR length(note) <= 500),
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((family_id IS NULL) <> (school_id IS NULL)),
  CHECK ((status = 'done') = (done_on IS NOT NULL))
);
CREATE UNIQUE INDEX compliance_checklist_item ON compliance_checklist(profile_id, item_key, coalesce(learner_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------- RLS
ALTER TABLE compliance_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY published_only ON compliance_templates USING (eduos_is_table_owner() OR status = 'published' OR EXISTS (SELECT 1 FROM compliance_profiles p WHERE p.template_id = compliance_templates.id))
  WITH CHECK (eduos_is_table_owner());

-- Who reads a tenant's compliance planning, and who changes it.
CREATE FUNCTION eduos_compliance_reads(p_family uuid, p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_family IS NOT NULL THEN p_family = eduos_ctx_family() AND coalesce(eduos_family_role() IN ('owner','co_educator'), false)
              ELSE p_school = eduos_ctx_private_school() AND eduos_ps_has(ARRAY['school_admin','registrar','campus_admin']) END
$$;
CREATE FUNCTION eduos_compliance_writes(p_family uuid, p_school uuid, p_adopt boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_family IS NOT NULL THEN p_family = eduos_ctx_family() AND (eduos_family_role() = 'owner' OR (NOT p_adopt AND eduos_family_role() = 'co_educator'))
              ELSE p_school = eduos_ctx_private_school() AND (eduos_ps_has(ARRAY['school_admin']) OR (NOT p_adopt AND eduos_ps_has(ARRAY['registrar']))) END
$$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['compliance_profiles','compliance_checklist'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (eduos_is_table_owner() OR eduos_compliance_reads(family_id, school_id))
      WITH CHECK (eduos_is_table_owner() OR eduos_compliance_reads(family_id, school_id))$p$, t);
  END LOOP;
END $$;
CREATE POLICY adopt ON compliance_profiles AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_compliance_writes(family_id, school_id, true) AND adopted_by = eduos_ctx_user() END);
CREATE POLICY adopt_update ON compliance_profiles AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_compliance_writes(family_id, school_id, true) END);
CREATE POLICY checklist_write ON compliance_checklist AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_compliance_writes(family_id, school_id, false) AND recorded_by = eduos_ctx_user() END);
CREATE POLICY checklist_update ON compliance_checklist AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_compliance_writes(family_id, school_id, false) END);

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['eduos_compliance_reads(uuid,uuid)','eduos_compliance_writes(uuid,uuid,boolean)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eduos_app', fn); END IF;
  END LOOP;
END $$;
