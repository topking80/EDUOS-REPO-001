-- Retire timeline_entries (083), a second student-history model that no route
-- ever used. Student history and Time Capsules use student_history_entries
-- (086), with relationship rules in 088; TC-02 onward builds on it. Keeping
-- both would let two sets of privacy rules drift apart.
--
-- Nothing writes timeline_entries, so it should be empty. If a deployment has
-- rows anyway, stop rather than drop them. Forced row-level security would
-- hide every row from the owner, so it is lifted before counting.
ALTER TABLE timeline_entries NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM timeline_entries;
  IF n > 0 THEN
    RAISE EXCEPTION 'timeline_entries has % row(s); move them to student_history_entries before upgrading', n;
  END IF;
END $$;
DROP TABLE timeline_entries;
DROP FUNCTION eduos_timeline_can_read(uuid,uuid,uuid,uuid,text,text,uuid);
DROP FUNCTION eduos_timeline_can_insert(uuid,uuid,uuid,uuid,text,text,uuid,text);
