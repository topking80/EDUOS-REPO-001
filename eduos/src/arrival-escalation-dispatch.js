// 34.6 scheduled arrival exception escalation.
// Run with the migration-owner database URL on a 5-minute scheduler:
//   node src/arrival-escalation-dispatch.js
// Notification adapters retain their existing off/log dry-run defaults.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import { config } from "./config.js";
import { outboxRows } from "./notify.js";
import { classifyArrivalExceptions } from "./arrival-exceptions.js";

export async function dispatchArrivalEscalations({db=pool,now=new Date(),log=()=>{}}={}) {
  const districts=(await db.query("SELECT id FROM districts WHERE status='active' ORDER BY id")).rows;
  let created=0,notified=0;
  for(const district of districts){
    const client=await db.connect();
    try{
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.district_id',$1,true)",[district.id]);
      const rows=(await client.query(`SELECT h.id,h.school_id,h.student_id,h.status,h.initiated_at,s.display_name,
          EXISTS(SELECT 1 FROM attendance_events ae WHERE ae.district_id=h.district_id
            AND ae.student_id=h.student_id AND ae.event_date=eduos_school_today(h.school_id)) AS attendance_recorded,
          sc.name AS school_name
        FROM arrival_handoffs h JOIN students s ON s.id=h.student_id AND s.district_id=h.district_id
        JOIN schools sc ON sc.id=h.school_id AND sc.district_id=h.district_id
        WHERE h.district_id=$1
          AND h.initiated_at >= (eduos_school_today(h.school_id)::timestamp AT TIME ZONE sc.timezone)
          AND h.initiated_at < ((eduos_school_today(h.school_id)+1)::timestamp AT TIME ZONE sc.timezone)
        ORDER BY h.initiated_at LIMIT 2000`,[district.id])).rows;
      const detected=classifyArrivalExceptions(rows.map(r=>({
        id:r.id,schoolId:r.school_id,studentId:r.student_id,status:r.status,
        initiatedAt:new Date(r.initiated_at).toISOString(),attendanceRecorded:r.attendance_recorded
      })),{now});
      for(const item of detected){
        const source=rows.find(r=>r.id===item.handoffId);
        if(!source) continue;
        const kind=item.kind, severity=item.severity;
        const resolution=(await client.query(`SELECT assigned_to FROM arrival_exception_resolutions
          WHERE district_id=$1 AND handoff_id=$2 AND exception_kind=$3`,[district.id,source.id,kind])).rows[0];
        const recipientRows=(await client.query(`SELECT DISTINCT m.user_id
          FROM memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
          WHERE m.district_id=$1 AND m.school_id=$2 AND m.role='principal' AND m.status='active'
          UNION SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id
          WHERE $3::uuid IS NOT NULL AND u.id=$3 AND u.status='active'
            AND m.district_id=$1 AND m.school_id=$2 AND m.status='active'
          UNION SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
          WHERE $4='high' AND m.district_id=$1 AND m.role='superintendent' AND m.status='active'`,
          [district.id,source.school_id,resolution?.assigned_to||null,severity])).rows;
        const recipients=[...new Set(recipientRows.map(r=>r.user_id))];
        // Do not consume the dedupe key when no eligible recipient exists; a later run can retry.
        if(!recipients.length) continue;
        const ledger=(await client.query(`INSERT INTO arrival_escalation_alerts
          (district_id,school_id,handoff_id,exception_kind,severity,threshold_minutes)
          VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(district_id,handoff_id,exception_kind,severity) DO NOTHING RETURNING id`,
          [district.id,source.school_id,source.id,kind,severity,kind==="handoff_awaiting_receipt"?10:15])).rows[0];
        if(!ledger) continue;
        created++;
        const title=severity==="high"?"Urgent arrival exception":"Arrival exception needs attention";
        const description=kind==="handoff_awaiting_receipt"?"Arrival is awaiting independent staff receipt":"First attendance has not been recorded after receipt";
        const prepared=outboxRows({districtId:district.id,schoolId:source.school_id,recipients,kind:"transport",
          title,body:`\${description}: \${source.display_name} at \${source.school_name}. Please review the Arrival Exceptions queue.`,
          refType:"arrival_exception",refId:source.id},config);
        for(const n of prepared){
          await client.query(`INSERT INTO notification_outbox
            (district_id,school_id,recipient_user_id,channel,kind,title,body,ref_type,ref_id,status,delivered_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10='delivered' THEN now() END)`,
            [n.districtId,n.schoolId,n.recipient,n.channel,n.kind,n.title,n.body,n.refType,n.refId,n.status]);
          notified++;
        }
      }
      await client.query("COMMIT");
    }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}
    finally{client.release();}
  }
  log(`arrival escalation dispatch: \${created} alerts, \${notified} notification rows`);
  return {alertsCreated:created,notificationRows:notified};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  dispatchArrivalEscalations().then(async r=>{console.log(JSON.stringify(r));await pool.end();})
    .catch(async e=>{console.error(`arrival escalation failed: \${e.message}`);await pool.end();process.exit(1);});
}
