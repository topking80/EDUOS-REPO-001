-- TC-11: what a family can see about their child's preserved history: how
-- much of the district's per-student allowance is used, how many photos,
-- and how many are in long-term (archive) storage. For the student, or a
-- linked guardian who isn't under a custody restriction while the student
-- doesn't yet hold their own record rights. Totals only: no storage paths,
-- no other students, no legal-hold or integrity details (those are for the
-- records office). Donations play no part: nothing here reads them.

CREATE FUNCTION eduos_history_family_storage(p_student uuid)
RETURNS TABLE(used_bytes bigint, photos bigint, archived_photos bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record;
BEGIN
  SELECT st.id, st.district_id INTO s FROM students st WHERE st.id = p_student AND st.district_id = eduos_ctx_district();
  IF NOT FOUND OR NOT (eduos_is_student_self(s.id) OR (eduos_is_linked_guardian(s.id) AND NOT eduos_student_holds_rights(s.id))) THEN
    RAISE EXCEPTION 'student_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  WITH links AS (
    SELECT asset_id FROM student_history_entry_attachments WHERE district_id = s.district_id AND student_id = s.id
    UNION SELECT asset_id FROM student_history_contribution_photos WHERE district_id = s.district_id AND student_id = s.id
    UNION SELECT asset_id FROM student_time_capsule_photos WHERE district_id = s.district_id AND student_id = s.id)
  SELECT coalesce(sum(o.byte_size), 0)::bigint, count(*)::bigint, count(*) FILTER (WHERE o.storage_tier = 'archive')::bigint
    FROM links l JOIN private_media_objects o ON o.asset_id = l.asset_id AND o.district_id = s.district_id
   WHERE o.purpose = 'history' AND o.scan_status <> 'blocked' AND o.processing_status <> 'failed';
END $$;
REVOKE ALL ON FUNCTION eduos_history_family_storage(uuid) FROM PUBLIC;
