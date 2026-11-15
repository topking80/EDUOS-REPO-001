// SIS batch import, shared by the CSV/JSON import routes (src/server.js) and
// the OneRoster and Ed-Fi connectors (src/integrations/). One place for the
// rules: a student belongs to one school, a batch id is imported once,
// attendance events are de-duplicated by source event id, district caps hold,
// and every run is audited.
import crypto from "node:crypto";

export const SIS_CHUNK=2000;
// District-configurable caps (32.2.0, district_settings). NULL = unlimited, the default.
export const DISTRICT_CAPS=["max_schools","max_students","max_users","max_active_webhooks","max_apps"];
export async function districtCap(client,districtId,key){
  if(!DISTRICT_CAPS.includes(key))throw new Error("unknown district cap");
  const r=await client.query(`SELECT ${key} AS v FROM district_settings WHERE district_id=$1`,[districtId]);
  return r.rows[0]?.v??null;
}

/**
 * Writes a validated batch inside the caller's tenant transaction. Returns
 * {status:201,data} or {status,error,runId}; throws errors with code
 * SIS_STUDENT_SCHOOL_CONFLICT, SIS_STUDENT_NOT_FOUND or
 * DISTRICT_LIMIT_MAX_STUDENTS (the transaction then rolls back).
 */
export async function applySisBatch(client,actor,batch,requestId){
  const {schoolId,sourceSystem,sourceBatchId,students=[],attendance=[]}=batch;
  const payloadHash=crypto.createHash("sha256").update(JSON.stringify(batch)).digest("hex");
  const school=await client.query("SELECT id FROM schools WHERE id=$1 AND district_id=$2 AND status='active'",[schoolId,actor.districtId]);
  if(!school.rowCount)return {status:404,error:"school_not_found"};
  const duplicate=await client.query(
    "SELECT id,status FROM sis_sync_runs WHERE district_id=$1 AND source_system=$2 AND source_batch_id=$3",
    [actor.districtId,sourceSystem.trim(),sourceBatchId.trim()]
  );
  if(duplicate.rowCount)return {status:409,error:"batch_already_imported",runId:duplicate.rows[0].id};
  const run=await client.query(
    `INSERT INTO sis_sync_runs(district_id,school_id,initiated_by,source_system,source_batch_id,status,
      students_received,attendance_received,payload_sha256)
     VALUES($1,$2,$3,$4,$5,'completed',$6,$7,$8) RETURNING id`,
    [actor.districtId,schoolId,actor.userId,sourceSystem.trim(),sourceBatchId.trim(),students.length,attendance.length,payloadHash]
  );
  let studentCount=0,attendanceCount=0;
  const src=sourceSystem.trim();
  const cap=await districtCap(client,actor.districtId,"max_students");
  // Last row wins for a repeated student number, as with the row-by-row import.
  const uniqueStudents=[...new Map(students.map(s=>[String(s.localStudentNumber).trim(),s])).values()];
  for(let k=0;k<uniqueStudents.length;k+=SIS_CHUNK){
    const chunk=uniqueStudents.slice(k,k+SIS_CHUNK);
    const saved=await client.query(
      `INSERT INTO students(district_id,school_id,local_student_number,display_name,grade_level)
       SELECT $1,$2,n,d,g FROM unnest($3::text[],$4::text[],$5::text[]) AS t(n,d,g)
       ON CONFLICT(district_id,local_student_number) DO UPDATE
         SET display_name=EXCLUDED.display_name,grade_level=EXCLUDED.grade_level
         WHERE students.school_id=EXCLUDED.school_id
       RETURNING id`,
      [actor.districtId,schoolId,chunk.map(s=>String(s.localStudentNumber).trim()),chunk.map(s=>s.displayName.trim()),chunk.map(s=>s.gradeLevel||null)]
    );
    // A row that already belongs to another school is not updated (and not returned).
    if(saved.rowCount!==chunk.length)throw Object.assign(new Error("student_school_conflict"),{code:"SIS_STUDENT_SCHOOL_CONFLICT"});
    studentCount+=saved.rowCount;
  }
  if(cap!==null&&students.length){
    const n=(await client.query("SELECT count(*)::int AS n FROM students WHERE district_id=$1",[actor.districtId])).rows[0].n;
    if(n>cap)throw Object.assign(new Error("district_student_limit"),{code:"DISTRICT_LIMIT_MAX_STUDENTS"});
  }
  for(let k=0;k<attendance.length;k+=SIS_CHUNK){
    const chunk=attendance.slice(k,k+SIS_CHUNK);
    const args=[actor.districtId,schoolId,chunk.map(a=>a.sourceEventId.trim()),chunk.map(a=>String(a.localStudentNumber).trim()),chunk.map(a=>a.eventDate),chunk.map(a=>a.status),src,run.rows[0].id];
    const missing=await client.query(
      `SELECT count(*)::int AS n FROM unnest($3::text[]) AS t(num)
        WHERE NOT EXISTS(SELECT 1 FROM students s WHERE s.district_id=$1 AND s.school_id=$2 AND s.local_student_number=t.num)`,
      [actor.districtId,schoolId,args[3]]);
    if(missing.rows[0].n)throw Object.assign(new Error("attendance_student_not_found"),{code:"SIS_STUDENT_NOT_FOUND"});
    // Events already imported (by source_event_id) are skipped, as before.
    const inserted=await client.query(
      `WITH input AS (
         SELECT DISTINCT ON (eid) eid,num,d,st
           FROM unnest($3::text[],$4::text[],$5::date[],$6::text[]) WITH ORDINALITY AS t(eid,num,d,st,ord)
          ORDER BY eid,ord),
       fresh AS MATERIALIZED (
         SELECT gen_random_uuid() AS new_id,i.eid,i.d,i.st,s.id AS sid FROM input i
           JOIN students s ON s.district_id=$1 AND s.school_id=$2 AND s.local_student_number=i.num
          WHERE NOT EXISTS(SELECT 1 FROM sis_attendance_imports x WHERE x.district_id=$1 AND x.source_system=$7 AND x.source_event_id=i.eid)),
       ev AS (INSERT INTO attendance_events(id,district_id,student_id,event_date,status) SELECT new_id,$1,sid,d,st FROM fresh RETURNING id),
       imp AS (INSERT INTO sis_attendance_imports(district_id,source_system,source_event_id,attendance_event_id,sync_run_id)
               SELECT $1,$7,f.eid,f.new_id,$8 FROM fresh f JOIN ev ON ev.id=f.new_id RETURNING 1)
       SELECT count(*)::int AS n FROM imp`,args);
    attendanceCount+=inserted.rows[0].n;
  }
  await client.query(
    `UPDATE sis_sync_runs SET students_upserted=$1,attendance_imported=$2 WHERE id=$3`,
    [studentCount,attendanceCount,run.rows[0].id]
  );
  await client.query(
    `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
     VALUES($1,$2,$3,'sis_import','sis_sync_run',$4,'success',$5,$6)`,
    [actor.districtId,actor.userId,actor.role,run.rows[0].id,
     JSON.stringify({sourceSystem,students:studentCount,attendance:attendanceCount,payloadHash}),requestId]
  );
  return {status:201,data:{runId:run.rows[0].id,studentsUpserted:studentCount,attendanceImported:attendanceCount,payloadSha256:payloadHash}};
}
