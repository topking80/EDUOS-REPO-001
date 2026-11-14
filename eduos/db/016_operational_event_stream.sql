-- 32.20.0: publish minimal audit-row identifiers to PostgreSQL listeners.
-- Payload intentionally excludes actor, school, resource, detail and student data.
CREATE OR REPLACE FUNCTION notify_eduos_operational_event() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM pg_notify(
    'eduos_operational_events',
    json_build_object('districtId', NEW.district_id, 'eventId', NEW.id)::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_notify_operational_event ON audit_events;
CREATE TRIGGER audit_notify_operational_event
AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION notify_eduos_operational_event();
