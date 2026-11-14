// Seed the synthetic demo district (local evaluation only, 32.1.0).
//   DATABASE_URL=<owner role URL> OIDC_ISSUER=<issuer the demo users sign in with> node dev/seed-demo.js
// Refuses NODE_ENV=production. Idempotent: re-running leaves existing rows alone.
// Runs as the migration OWNER role; FORCE ROW LEVEL SECURITY still applies, so
// every tenant write happens with app.district_id set, as in the API.
import pg from "pg";
import crypto from "node:crypto";
import { DISTRICT, SCHOOLS, USERS, STUDENTS, ROSTERS, LINKS, ASSIGNMENTS, APPS, APP_REQUESTS, BRANDING, MASCOT_SVGS,
  TRANSPORT_ROUTES, CHRISTIE_SKILLS, CHRISTIE_MASTERY, ANNOUNCEMENTS, THREADS,
  PICKUP_ADULTS, PICKUP_PASSES, PICKUP_RESTRICTIONS, PAST_DRILL,
  STANDARDS, PRIMARY_SOURCES, COURSES, UNITS, LESSONS, SKILL_LINKS, COURSE_WORK, ACCOMMODATIONS } from "./demo-fixture.js";
import { scoreItem } from "../src/quiz-scoring.js";
import { rubricTotals } from "../src/gradebook.js";
import { appendEntry } from "../src/edal.js";
import { recomputeMastery } from "../src/learning-service.js";
import { hashPassCode, normalizePassCode } from "../src/safety-model.js";
import { processMascot } from "../src/branding-images.js";
import { BrandModel } from "../src/brand-model.js";

export async function seedDemo({ databaseUrl = process.env.DATABASE_URL, issuer = process.env.OIDC_ISSUER, env = process.env } = {}) {
  if ((env.NODE_ENV || "development") === "production") throw new Error("Refusing to seed demo data with NODE_ENV=production");
  if (env.EDUOS_ALLOW_DEMO_SEED !== "true") throw new Error("Set EDUOS_ALLOW_DEMO_SEED=true to seed the synthetic demo district");
  if (!databaseUrl || !issuer) throw new Error("DATABASE_URL (owner role) and OIDC_ISSUER are required");
  const client = new pg.Client({ connectionString: databaseUrl, application_name: "eduos-demo-seed" });
  await client.connect();
  const q = (sql, params) => client.query(sql, params);
  try {
    await q("BEGIN");
    await q("SELECT set_config('app.district_id',$1,true)", [DISTRICT.id]);
    const existing = await q("SELECT 1 FROM districts WHERE id=$1", [DISTRICT.id]);
    await q("INSERT INTO districts(id,name) VALUES($1,$2) ON CONFLICT (id) DO NOTHING", [DISTRICT.id, DISTRICT.name]);
    for (const s of Object.values(SCHOOLS))
      await q("INSERT INTO schools(id,district_id,name,school_level) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
        [s.id, DISTRICT.id, s.name, s.level]);
    for (const u of Object.values(USERS)) {
      await q(`INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES($1,$2,$3,$4,$5)
               ON CONFLICT (id) DO UPDATE SET oidc_issuer=EXCLUDED.oidc_issuer`, [u.id, issuer, u.sub, u.name, u.email]);
      await q(`INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES($1,$2,$3,$4,true)
               ON CONFLICT DO NOTHING`, [u.id, DISTRICT.id, u.school ? SCHOOLS[u.school].id : null, u.role]);
    }
    for (const s of Object.values(STUDENTS))
      await q(`INSERT INTO students(id,district_id,school_id,local_student_number,display_name,grade_level)
               VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [s.id, DISTRICT.id, SCHOOLS[s.school].id, s.number, s.name, s.grade]);
    for (const [teacher, student] of ROSTERS)
      await q(`INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by)
               VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [DISTRICT.id, SCHOOLS[STUDENTS[student].school].id, USERS[teacher].id, STUDENTS[student].id, USERS.principal.id]);
    for (const [user, student, relationship] of LINKS)
      await q(`INSERT INTO student_user_links(district_id,user_id,student_id,relationship) VALUES($1,$2,$3,$4)
               ON CONFLICT DO NOTHING`, [DISTRICT.id, USERS[user].id, STUDENTS[student].id, relationship]);
    for (const a of ASSIGNMENTS)
      await q(`INSERT INTO assignments(id,district_id,school_id,created_by,title,instructions,due_at,status)
               VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(days=>$7),$8) ON CONFLICT (id) DO NOTHING`,
        [a.id, DISTRICT.id, SCHOOLS[a.school].id, USERS[a.by].id, a.title, a.instructions, a.dueInDays, a.status]);
    // 32.2.0 demo app catalog (idempotent by fixed ids).
    const su = USERS.superintendent.id;
    for (const a of APPS) {
      const created = await q(`INSERT INTO apps(id,district_id,owner_school_id,name,vendor,description,category,launch_url,integration_type,integration_config,
                 data_sharing_scope,dpa_status,dpa_expires_on,coppa_compliant,ferpa_school_official,created_by)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [a.id, DISTRICT.id, a.owner ? SCHOOLS[a.owner].id : null, a.name, a.vendor, a.description, a.category, a.url, a.type, JSON.stringify(a.config || {}),
         a.scope, a.dpa, a.dpaEnds || null, a.coppa, a.ferpa, su]);
      if (!created.rowCount) continue;
      for (const l of a.licenses)
        await q(`INSERT INTO app_licenses(district_id,app_id,purchased_by_school_id,seat_limit,starts_on,ends_on,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [DISTRICT.id, a.id, l.school ? SCHOOLS[l.school].id : null, l.seats, l.starts, l.ends, su]);
      for (const x of a.assign)
        await q(`INSERT INTO app_assignments(district_id,app_id,scope,school_id,grade_levels,roles,shared_by_school_id,assigned_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [DISTRICT.id, a.id, x.scope, x.school ? SCHOOLS[x.school].id : null, x.grades || null, x.roles, x.sharedBy ? SCHOOLS[x.sharedBy].id : null, su]);
    }
    for (const r of APP_REQUESTS)
      await q(`INSERT INTO app_requests(id,district_id,school_id,requested_by,requested_name,requested_vendor,requested_url,reason)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [r.id, DISTRICT.id, SCHOOLS[r.school].id, USERS[r.by].id, r.name, r.vendor, r.url, r.reason]);
    // 32.3.0 demo branding: district default + two schools, published as v1.
    // Mascots go through the same sanitizer/re-encoder as uploads.
    for (const b of BRANDING) {
      const schoolId = b.school ? SCHOOLS[b.school].id : null;
      const has = await q("SELECT 1 FROM branding_profiles WHERE district_id=$1 AND school_id IS NOT DISTINCT FROM $2", [DISTRICT.id, schoolId]);
      if (has.rowCount) continue;
      let uploadId = null;
      if (b.mascot) {
        const src = Buffer.from(MASCOT_SVGS[b.mascot]), out = await processMascot(src);
        uploadId = (await q(`INSERT INTO branding_uploads(district_id,school_id,source_type,source_sha256,removed,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [DISTRICT.id, schoolId, out.type, crypto.createHash("sha256").update(src).digest("hex"), JSON.stringify(out.removed), su])).rows[0].id;
        for (const v of out.variants)
          await q(`INSERT INTO branding_assets(upload_id,district_id,school_id,variant,mime,width,height,bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [uploadId, DISTRICT.id, schoolId, v.variant, v.mime, v.width, v.height, v.bytes]);
      }
      const report = BrandModel.contrastPairs(BrandModel.effective({ ...b, mascotUploadId: uploadId }), BrandModel.SAMPLE_TILES);
      if (!BrandModel.summarize(report).ok) throw new Error(`demo branding for ${b.school || "district"} fails WCAG AA`);
      await q(`INSERT INTO branding_profiles(district_id,school_id,status,version,mascot_name,motto,primary_color,secondary_color,accent_color,font,mascot_upload_id,tiles,contrast_report,created_by,updated_by,published_by,published_at)
               VALUES($1,$2,'published',1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12,now())`,
        [DISTRICT.id, schoolId, b.mascotName || null, b.motto || null, b.primary, b.secondary, b.accent, b.font, uploadId, b.tiles, JSON.stringify(report.filter(r => r.level !== "ok")), su]);
    }
    if (!existing.rowCount) {
      // Two weeks of attendance for the grade-4 roster, with a few absences.
      for (const key of ["ava", "noah", "liam", "sofia"]) {
        for (let d = 14; d >= 1; d--) {
          const status = (key === "noah" && d % 4 === 0) ? "absent" : (key === "liam" && d === 3) ? "tardy" : "present";
          await q(`INSERT INTO attendance_events(district_id,student_id,event_date,status)
                   SELECT $1,$2,(current_date - $3::int),$4 WHERE extract(isodow FROM current_date - $3::int) < 6`,
            [DISTRICT.id, STUDENTS[key].id, d, status]);
        }
      }
      await q(`INSERT INTO assignment_submissions(district_id,assignment_id,student_id,response_text)
               VALUES($1,$2,$3,'Read "Charlotte''s Web", pages 1-48.')`, [DISTRICT.id, ASSIGNMENTS[1].id, STUDENTS.ava.id]);
      await q(`INSERT INTO student_intervention_cases(district_id,student_id,school_id,created_by,owner_user_id,category,priority,title,summary,support_plan,follow_up_at)
               VALUES($1,$2,$3,$4,$4,'attendance','high','Attendance check-in','Three absences in two weeks.','Call family; weekly check-in with counselor.',now()+interval '3 days')`,
        [DISTRICT.id, STUDENTS.noah.id, SCHOOLS.elementary.id, USERS.teacher.id]);
    }
    await seed324(q);
    await seed325(q);
    await seed326(q);
    await q("COMMIT");
    return { seeded: !existing.rowCount, district: DISTRICT.name };
  } catch (error) {
    await q("ROLLBACK").catch(() => {});
    throw error;
  } finally { await client.end(); }
}

// 32.4.0 transport, Christie and Comms Hub demo content (idempotent by fixed ids).
const fid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function seed324(q) {
  const D = DISTRICT.id, principal = USERS.principal.id;
  for (const r of TRANSPORT_ROUTES) {
    const school = SCHOOLS[r.school].id;
    const made = await q(`INSERT INTO transport_routes(id,district_id,school_id,name,bus_label,direction,driver_user_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING RETURNING id`, [r.id, D, school, r.name, r.bus, r.direction, USERS[r.driver].id, principal]);
    if (!made.rowCount) continue;
    for (const st of r.stops)
      await q(`INSERT INTO transport_stops(id,district_id,school_id,route_id,seq,name,scheduled_time,is_school) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [st.id, D, school, r.id, st.seq, st.name, st.time, !!st.school]);
    for (const [student, stop] of r.riders)
      await q(`INSERT INTO transport_rider_assignments(district_id,school_id,route_id,stop_id,student_id,created_by) VALUES($1,$2,$3,$4,$5,$6)`,
        [D, school, r.id, fid(stop), STUDENTS[student].id, principal]);
  }
  const am = TRANSPORT_ROUTES[0];
  // Today's morning run, partly done, so the driver/guardian/admin screens have
  // something to show. Only check-in events at stops; no location data.
  const run = await q(`INSERT INTO transport_runs(district_id,school_id,route_id,driver_user_id,service_date)
      VALUES($1,$2,$3,$4,(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=$2))::date)
      ON CONFLICT (route_id,service_date) DO NOTHING RETURNING id`, [D, SCHOOLS[am.school].id, am.id, USERS[am.driver].id]);
  if (run.rowCount)
    for (const [student, stop] of [["ava", 711], ["noah", 711]])
      await q(`INSERT INTO transport_checkins(district_id,school_id,run_id,student_id,stop_id,event,recorded_by) VALUES($1,$2,$3,$4,$5,'boarded',$6)`,
        [D, SCHOOLS[am.school].id, run.rows[0].id, STUDENTS[student].id, fid(stop), USERS[am.driver].id]);
  if (run.rowCount) // the in-app alert a guardian gets for a check-in (what the API enqueues)
    await q(`INSERT INTO notification_outbox(district_id,school_id,recipient_user_id,channel,kind,title,ref_type,status,delivered_at)
        VALUES($1,$2,$3,'in_app','transport','Ava boarded Bus 7 at Maple Ave & 3rd St (demo)','transport_checkin','delivered',now())`,
      [D, SCHOOLS.elementary.id, USERS.parent.id]);

  // A small grading queue for the teacher app (synthetic work).
  for (const [student, text] of [["noah", "1/2 = 2/4, 2/3 = 4/6, 3/4 = 6/8 (problems 1-3 shown)."], ["liam", "I drew pizzas: 1/2 = 3/6. Problems 1-12 done."], ["sofia", "All 12 done. Number 9 was tricky: 4/8 = 1/2."]])
    await q(`INSERT INTO assignment_submissions(district_id,assignment_id,student_id,response_text,submitted_at) VALUES($1,$2,$3,$4,now()-interval '3 hours')
        ON CONFLICT (assignment_id,student_id) DO NOTHING`, [D, ASSIGNMENTS[0].id, STUDENTS[student].id, `${text} (demo)`]);

  for (const k of CHRISTIE_SKILLS) {
    const made = await q(`INSERT INTO christie_skills(id,district_id,school_id,subject,grade_level,code,title,sequence,explanation,source,status,created_by,approved_by,approved_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'EduOS demo content (synthetic)','approved',$10,$11,now()) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [k.id, D, SCHOOLS.elementary.id, k.subject, k.grade, k.code, k.title, k.seq, k.explanation, USERS.teacher.id, principal]);
    if (!made.rowCount) continue;
    let n = 0;
    for (const it of k.items)
      await q(`INSERT INTO christie_items(district_id,skill_id,seq,prompt,answer,hints) VALUES($1,$2,$3,$4,$5,$6)`, [D, k.id, ++n, it.prompt, it.answer, it.hints]);
  }
  for (const [student, skill, mastery] of CHRISTIE_MASTERY)
    await q(`INSERT INTO student_skill_mastery(district_id,school_id,student_id,skill_id,attempts,correct,hints_used,mastery,mastered_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8>=80 THEN now() END) ON CONFLICT DO NOTHING`,
      [D, SCHOOLS[STUDENTS[student].school].id, STUDENTS[student].id, fid(skill), 6, Math.round(mastery / 17), 3, mastery]);

  for (const a of ANNOUNCEMENTS)
    await q(`INSERT INTO comms_announcements(id,district_id,school_id,scope,class_teacher_id,title,body,audience,author_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [a.id, D, SCHOOLS[a.school].id, a.scope, a.scope === "class" ? USERS[a.by].id : null, a.title, a.body, a.audience, USERS[a.by].id]);
  for (const t of THREADS) {
    const school = SCHOOLS[t.school].id;
    const made = await q(`INSERT INTO comms_threads(id,district_id,school_id,kind,subject,student_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO NOTHING RETURNING id`, [t.id, D, school, t.kind, t.subject, t.student ? STUDENTS[t.student].id : null, USERS[t.by].id]);
    if (!made.rowCount) continue;
    for (const p of t.participants)
      await q(`INSERT INTO comms_participants(thread_id,district_id,user_id,role,added_by) VALUES($1,$2,$3,$4,$5)`, [t.id, D, USERS[p].id, USERS[p].role, USERS[t.by].id]);
    let minutes = t.messages.length * 30;
    for (const [author, body] of t.messages) {
      await q(`INSERT INTO comms_messages(district_id,school_id,thread_id,author_user_id,body,created_at) VALUES($1,$2,$3,$4,$5,now()-make_interval(mins=>$6))`,
        [D, school, t.id, USERS[author].id, body, minutes]);
      minutes -= 30;
    }
    await q(`UPDATE comms_threads SET last_message_at=now() WHERE id=$1`, [t.id]);
    // Read receipts: the other participants have read the seeded messages.
    await q(`INSERT INTO comms_message_reads(message_id,district_id,user_id)
        SELECT m.id,$2,p.user_id FROM comms_messages m JOIN comms_participants p ON p.thread_id=m.thread_id AND p.user_id<>m.author_user_id
         WHERE m.thread_id=$1 ON CONFLICT DO NOTHING`, [t.id, D]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedDemo().then(r => console.log(r.seeded ? `Seeded ${r.district}` : `${r.district} already present (refreshed accounts)`))
    .catch(e => { console.error(`seed failed: ${e.message}`); process.exit(1); });
}

// 32.5.0 SafetyOS and car pick-up demo content (idempotent by fixed ids).
async function seed325(q) {
  const D = DISTRICT.id, principal = USERS.principal.id, school = SCHOOLS.elementary.id;
  // Alex Morgan's own guardian row (the API also creates this on first use).
  await q(`INSERT INTO pickup_adults(id,district_id,school_id,student_id,user_id,full_name,relationship,kind,status,requested_by,decided_at,decision_note)
      VALUES($1,$2,$3,$4,$5,$6,'Guardian','guardian','approved',$5,now(),'Linked guardian account') ON CONFLICT DO NOTHING`,
    [fid(1001), D, school, STUDENTS.ava.id, USERS.parent.id, USERS.parent.name]);
  for (const a of PICKUP_ADULTS)
    await q(`INSERT INTO pickup_adults(id,district_id,school_id,student_id,full_name,relationship,kind,status,requested_by,decided_by,decided_at)
        VALUES($1,$2,$3,$4,$5,$6,'authorized',$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [a.id, D, SCHOOLS[STUDENTS[a.student].school].id, STUDENTS[a.student].id, a.name, a.relationship, a.status,
       a.student === "ava" ? USERS.parent.id : principal, a.status === "approved" ? principal : null, a.status === "approved" ? new Date() : null]);
  for (const p of PICKUP_PASSES) {
    const norm = normalizePassCode(p.code);
    await q(`INSERT INTO pickup_tags(id,district_id,school_id,adult_id,code_hash,code_hint,issued_by,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now(),now()+interval '30 days')
        ON CONFLICT (id) DO UPDATE SET issued_at=now(), expires_at=now()+interval '30 days', revoked_at=NULL`,
      [p.id, D, school, p.adult, hashPassCode(norm), norm.slice(-2), principal]);
  }
  for (const r of PICKUP_RESTRICTIONS)
    await q(`INSERT INTO pickup_restrictions(id,district_id,school_id,student_id,kind,person_name,detail,document_on_file,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [r.id, D, school, STUDENTS[r.student].id, r.kind, r.person, r.detail, r.doc, principal]);
  // An early-dismissal request waiting for the office (tomorrow, school time).
  await q(`INSERT INTO pickup_early_dismissals(id,district_id,school_id,student_id,adult_id,dismissal_date,dismissal_time,reason,requested_by)
      VALUES($1,$2,$3,$4,$5,eduos_school_today($3)+1,'13:30','Dentist appointment (demo)',$6)
      ON CONFLICT (id) DO UPDATE SET dismissal_date=EXCLUDED.dismissal_date WHERE pickup_early_dismissals.status='requested'`,
    [fid(1401), D, school, STUDENTS.ava.id, fid(1002), USERS.parent.id]);
  // A closed, debriefed lockdown drill from last week (history + debrief screen).
  const d = PAST_DRILL;
  const made = await q(`INSERT INTO safety_incidents(id,district_id,school_id,kind,is_drill,status,initiated_by,initiated_at,confirm_by,confirmed_by,confirmed_at,closed_by,closed_at,debrief)
      VALUES($1,$2,$3,$4,true,'closed',$5,now()-make_interval(days=>$6),now()-make_interval(days=>$6)+interval '2 minutes',$5,
             now()-make_interval(days=>$6)+interval '20 seconds',$5,now()-make_interval(days=>$6)+interval '14 minutes',$7)
      ON CONFLICT (id) DO NOTHING RETURNING id`, [d.id, D, SCHOOLS[d.school].id, d.kind, principal, d.daysAgo, d.debrief]);
  if (made.rowCount) {
    const at = m => `now()-make_interval(days=>${Number(d.daysAgo)})+make_interval(secs=>${Math.round(Number(m) * 60)})`;
    for (const [m, event, detail] of [[0, "initiated", "lockdown drill"], [0.4, "confirmed", "drill"], [3, "rollcall", "present=4 missing=0 extra=0 injured=0"],
        [6, "rollcall", "present=2 missing=0 extra=0 injured=0"], [14, "all_clear", null], [60, "debrief", `${d.debrief.length} characters`]])
      await q(`INSERT INTO safety_events(district_id,school_id,incident_id,event,actor_user_id,actor_role,detail,at) VALUES($1,$2,$3,$4,$5,'principal',$6,${at(m)})`,
        [D, SCHOOLS[d.school].id, d.id, event, principal, detail]);
  }
}

// 32.6.0 learning core + EDAL demo content (idempotent: skipped once course 1601 exists).
async function seed326(q) {
  const D = DISTRICT.id, school = SCHOOLS.elementary.id, P = USERS.principal.id, T = USERS.teacher.id;
  if ((await q(`SELECT 1 FROM courses WHERE id=$1`, [COURSES[0].id])).rowCount) return;
  const client = { query: q };
  const teacher = { districtId: D, userId: T, role: "teacher" };
  for (const st of STANDARDS)
    await q(`INSERT INTO learning_standards(id,district_id,framework,code,subject,grade_level,description,source_url) VALUES($1,$2,'CCSS',$3,$4,$5,$6,$7)`,
      [st.id, D, st.code, st.subject, st.grade, st.description, st.url]);
  for (const ps of PRIMARY_SOURCES)
    await q(`INSERT INTO primary_sources(id,district_id,title,creator,created_date,media_kind,archive,archive_url,rights,excerpt,description,status,curated_by,approved_by,approved_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'approved',$12,$13,now())`,
      [ps.id, D, ps.title, ps.creator, ps.date, ps.kind, ps.archive, ps.url, ps.rights, ps.excerpt, ps.description, T, P]);
  for (const c of COURSES) {
    await q(`INSERT INTO courses(id,district_id,school_id,teacher_user_id,title,subject,grade_level,term,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [c.id, D, school, USERS[c.teacher].id, c.title, c.subject, c.grade, c.term, c.status]);
    for (const st of c.students) await q(`INSERT INTO course_enrollments(course_id,district_id,student_id) VALUES($1,$2,$3)`, [c.id, D, STUDENTS[st].id]);
  }
  for (const u of UNITS) await q(`INSERT INTO course_units(id,district_id,course_id,seq,title,summary) VALUES($1,$2,$3,$4,$5,$6)`, [u.id, D, fid(u.course), u.seq, u.title, u.summary]);
  for (const l of LESSONS) {
    await q(`INSERT INTO lessons(id,district_id,course_id,unit_id,seq,title,objective,content,status,created_by,approved_by,approved_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'published',$9,$10,$11)`,
      [l.id, D, fid(l.course), fid(l.unit), l.seq, l.title, l.objective, l.content, T, l.approved ? P : null, l.approved ? new Date() : null]);
    for (const st of l.standards) await q(`INSERT INTO lesson_standards(lesson_id,standard_id,district_id) VALUES($1,$2,$3)`, [l.id, fid(st), D]);
    let n = 1;
    for (const [src, prompts] of l.sources || []) await q(`INSERT INTO lesson_sources(lesson_id,source_id,district_id,seq,prompts) VALUES($1,$2,$3,$4,$5)`, [l.id, fid(src), D, n++, prompts]);
  }
  for (const [skill, std, lesson] of SKILL_LINKS) await q(`UPDATE christie_skills SET standard_id=$2,lesson_id=$3 WHERE id=$1`, [fid(skill), fid(std), fid(lesson)]);
  const items = new Map();
  COURSE_WORK.forEach((w, wi) => { w.itemRows = (w.items || []).map((it, i) => ({ ...it, id: fid(1700 + wi * 10 + i), points: 1, source_id: it.source ? fid(it.source) : null })); });
  for (const w of COURSE_WORK) {
    const points = w.kind === "quiz" ? w.items.length : w.rubric.reduce((x, r) => x + Math.max(...r.levels.map(l => l.points)), 0);
    await q(`INSERT INTO assignments(id,district_id,school_id,created_by,title,instructions,due_at,status,course_id,lesson_id,kind,points_possible,category,rubric,max_attempts,retake_policy,time_limit_minutes)
        VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(days=>$7),'published',$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [w.id, D, school, T, w.title, w.kind === "quiz" ? "Answer each question. You can use scrap paper." : "Make it, then hand it in or upload a photo description.",
       w.dueDays, fid(w.course), fid(w.lesson), w.kind, points, w.category || "Quizzes", w.rubric ? JSON.stringify(w.rubric) : null, w.maxAttempts || 1, w.retake || "highest", w.minutes || null]);
    for (const st of w.standards) await q(`INSERT INTO assignment_standards(assignment_id,standard_id,district_id) VALUES($1,$2,$3)`, [w.id, fid(st), D]);
    let seq = 1;
    for (const it of w.itemRows) {
      await q(`INSERT INTO quiz_items(id,district_id,assignment_id,seq,kind,prompt,choices,points,standard_id,source_id) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9)`,
        [it.id, D, w.id, seq++, it.kind, it.prompt, it.choices || null, fid(it.std), it.source_id]);
      await q(`INSERT INTO quiz_item_keys(item_id,district_id,answer_key) VALUES($1,$2,$3)`, [it.id, D, JSON.stringify(it.key || {})]);
      items.set(it.id, it);
    }
  }
  for (const [st, pct, ra, notes] of ACCOMMODATIONS)
    await q(`INSERT INTO student_accommodations(student_id,district_id,school_id,extra_time_pct,read_aloud,notes,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [STUDENTS[st].id, D, school, pct, ra, notes, T]);

  const ev = (student, std, source, label, score, daysAgo, ref = null) => q(`INSERT INTO mastery_evidence(district_id,school_id,student_id,standard_id,source,source_ref,label,score,weight,observed_at,recorded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()-make_interval(mins=>$10),$11)`,
    [D, school, STUDENTS[student].id, fid(std), source, ref, label, score, source === "christie" ? 0.5 : 1, Math.round(daysAgo * 1440), T]);
  // A scored quiz attempt (responses auto-scored with the real scorer; teacher points for the rest).
  async function attempt(wi, student, no, responses, { daysAgo, teacher = {}, comment = {}, status = "returned" }) {
    const w = COURSE_WORK[wi], aid = fid(1800 + wi * 10 + Object.keys(STUDENTS).indexOf(student));
    await q(`INSERT INTO quiz_attempts(id,district_id,school_id,assignment_id,student_id,user_id,attempt_no,status,started_at,submitted_at,extra_time_pct,read_aloud)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()-make_interval(mins=>$9),now()-make_interval(mins=>$9-12),0,false)`,
      [aid, D, school, w.id, STUDENTS[student].id, student === "ava" ? USERS.pupil.id : T, no, status === "needs_review" ? "needs_review" : "scored", Math.round(daysAgo * 1440)]);
    let auto = 0, total = 0, pending = 0;
    for (const [i, it] of w.itemRows.entries()) {
      const s = scoreItem(it, it.key || {}, responses[i]);
      const tp = teacher[i] ?? null;
      if (s.correct === null && tp === null) pending++;
      auto += s.points || 0; total += tp ?? s.points ?? 0;
      await q(`INSERT INTO quiz_responses(attempt_id,item_id,district_id,response,auto_correct,auto_points,teacher_points,teacher_comment) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [aid, it.id, D, responses[i] || "", s.correct, s.points, tp, comment[i] || null]);
    }
    await q(`UPDATE quiz_attempts SET auto_points=$2,possible_points=$3,total_points=$4,status=$5,reviewed_by=$6,reviewed_at=$7,returned_at=$8 WHERE id=$1`,
      [aid, auto, w.itemRows.length, pending ? null : total, status, pending ? null : T, pending ? null : new Date(), status === "returned" ? new Date() : null]);
    if (!pending) await ev(student, w.standards[0], "quiz", `${w.title} (attempt ${no})`, total / w.itemRows.length, daysAgo, aid);
  }
  async function rubric(wi, student, levels, feedback, daysAgo) {
    const w = COURSE_WORK[wi];
    const t = rubricTotals(w.rubric, w.rubric.map((r, i) => ({ criterionId: r.id, points: levels[i] })));
    const sub = await q(`INSERT INTO assignment_submissions(district_id,assignment_id,student_id,response_text,submitted_at,score,points_earned,rubric_scores,feedback,graded_by,graded_at,returned_at)
        VALUES($1,$2,$3,$4,now()-make_interval(days=>$5+1),$6,$7,$8,$9,$10,now()-make_interval(days=>$5),now()-make_interval(days=>$5)) RETURNING id`,
      [D, w.id, STUDENTS[student].id, "Poster handed in during class (demo).", daysAgo, t.percent, t.earned, JSON.stringify(t.rows), feedback, T]);
    let k = 0;
    for (const r of t.rows) if (r.standardId) await ev(student, Number(r.standardId.slice(-5)), "rubric", `${w.title}: ${r.title}`, r.points / r.max, daysAgo - (k++) / 1440, sub.rows[0].id);
  }
  // Ava: practice, a returned quiz, a graded poster, and a source quiz waiting for the teacher.
  await ev("ava", 1501, "christie", "Christie: Equivalent fractions", 1, 6);
  await ev("ava", 1501, "christie", "Christie: Equivalent fractions", 0.6, 5);
  await ev("ava", 1502, "christie", "Christie: Comparing fractions", 0.6, 4);
  await attempt(0, "ava", 1, ["1", "6", "4/10", "2", "If you multiply the top and bottom of 1/2 by 4 you get 4/8."], { daysAgo: 3, teacher: { 4: 1 }, comment: { 3: "Check: 6 ÷ 3 = 2, so 9 ÷ 3 = ?", 4: "Nice: same factor on top and bottom." } });
  await rubric(2, "ava", [4, 3, 4], "Great strips! Add one more sentence explaining why the pieces line up.", 2);
  await attempt(3, "ava", 1, ["1", "57", "The photo shows the plane in the air and Wilbur running. The telegram tells how long the flight was."], { daysAgo: 1, status: "needs_review" });
  // Classmates (for the gradebook).
  await attempt(0, "sofia", 1, ["1", "6", "4/10", "3", "Both are half of the whole."], { daysAgo: 3, teacher: { 4: 1 } });
  await attempt(0, "liam", 1, ["0", "6", "4/10", "3", "They look the same size."], { daysAgo: 2, teacher: { 4: 0.5 }, comment: { 4: "Tell me WHY they are the same size." } });
  await rubric(2, "sofia", [4, 4, 4], "Excellent work.", 2);
  await rubric(2, "liam", [3, 2, 3], "Good start. Label each strip.", 2);
  await ev("sofia", 1501, "christie", "Christie: Equivalent fractions", 1, 6);
  for (const st of ["ava", "sofia", "liam"]) for (const std of [1501, 1502])
    if ((await q(`SELECT 1 FROM mastery_evidence WHERE student_id=$1 AND standard_id=$2`, [STUDENTS[st].id, fid(std)])).rowCount)
      await recomputeMastery(client, teacher, { schoolId: school, studentId: STUDENTS[st].id, standardId: fid(std) });
  // Last year's final grade and a course-completion credential for Ava, both on the ledger.
  const priya = { districtId: D, userId: USERS.teacher2.id, role: "teacher" };
  const fgId = fid(1901), credId = fid(1902);
  const fg = await appendEntry(client, priya, { kind: "final_grade", schoolId: school, studentId: STUDENTS.ava.id,
    payload: { recordId: fgId, courseId: COURSES[2].id, course: COURSES[2].title, term: COURSES[2].term, studentId: STUDENTS.ava.id, percent: 88.5, letter: "B", supersedes: null, reason: null } });
  await q(`INSERT INTO course_final_grades(id,district_id,school_id,course_id,student_id,percent,letter,posted_by,posted_at,edal_entry_id) VALUES($1,$2,$3,$4,$5,88.5,'B',$6,now()-interval '140 days',$7)`,
    [fgId, D, school, COURSES[2].id, STUDENTS.ava.id, USERS.teacher2.id, fg.id]);
  const cr = await appendEntry(client, { districtId: D, userId: P, role: "principal" }, { kind: "credential", schoolId: school, studentId: STUDENTS.ava.id,
    payload: { recordId: credId, studentId: STUDENTS.ava.id, credential: "course_completion", title: "Completed Grade 3 Math", description: "Course completed in 2025-26.", courseId: COURSES[2].id, standardId: null, issuedByRole: "principal" } });
  await q(`INSERT INTO credentials(id,district_id,school_id,student_id,kind,title,description,course_id,issued_by,issued_at,edal_entry_id) VALUES($1,$2,$3,$4,'course_completion','Completed Grade 3 Math','Course completed in 2025-26.',$5,$6,now()-interval '139 days',$7)`,
    [credId, D, school, STUDENTS.ava.id, COURSES[2].id, P, cr.id]);
  // A checkpoint, as a superintendent would save after verifying.
  const head = (await q(`SELECT seq,head_hash FROM edal_heads WHERE district_id=$1`, [D])).rows[0];
  await q(`INSERT INTO edal_checkpoints(district_id,seq,head_hash,note,created_by) VALUES($1,$2,$3,'Demo seed checkpoint (copy kept off-system in a real district)',$4)`,
    [D, head.seq, head.head_hash, USERS.superintendent.id]);
}
