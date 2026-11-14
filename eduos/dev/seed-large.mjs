// Large-district load check for a running LOCAL dev stack (32.2.0).
//   node dev/seed-large.mjs            (after `make up`; adds data to the demo district)
// Env: EDUOS_BASE (default https://localhost:8443), LARGE_SCHOOLS (50),
//      LARGE_STUDENTS_PER_SCHOOL (1000), LARGE_OUT (write a JSON timing report here),
//      LARGE_SINGLE_BATCH (0; e.g. 50000 = also import that many students in ONE
//      CSV batch into one school, to show there is no per-import row cap)
// Grows the synthetic demo district to LARGE_SCHOOLS schools and
// LARGE_SCHOOLS*LARGE_STUDENTS_PER_SCHOOL students through the real API (OIDC
// sign-in, CSRF, SIS CSV import), then times the list, search, paging, home,
// audit-export and app-launch paths. Idempotent: re-running re-imports (updates)
// the same student numbers under new batch ids. Development data only.
import fs from "node:fs";
import { USERS, APPS } from "./demo-fixture.js";

if (process.env.NODE_ENV === "production") { console.error("seed-large is a development tool"); process.exit(2); }
const BASE = (process.env.EDUOS_BASE || "https://localhost:8443").replace(/\/$/, "");
const SCHOOLS = Number(process.env.LARGE_SCHOOLS || 50), PER = Number(process.env.LARGE_STUDENTS_PER_SCHOOL || 1000);
const RUN = Date.now().toString(36);
if (BASE.startsWith("https://localhost") || BASE.startsWith("https://127.0.0.1")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // local Caddy CA only

class Session {
  constructor() { this.jar = new Map(); }
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  store(res) { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); } }
  async raw(method, path, body) {
    const h = { cookie: this.cookie() };
    if (body !== undefined) h["content-type"] = "application/json";
    if (this.csrf && method !== "GET") h["x-csrf-token"] = this.csrf;
    const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    this.store(res); return res;
  }
  async json(method, path, body) {
    const res = await this.raw(method, path, body); const text = await res.text();
    if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  async signIn(sub) {
    let res = await this.raw("GET", "/auth/login");
    const authorize = new URL(res.headers.get("location"));
    const form = new URLSearchParams(authorize.searchParams); form.set("sub", sub);
    res = await fetch(new URL("/authorize/approve", authorize), { method: "POST", body: form, redirect: "manual" });
    const cb = new URL(res.headers.get("location"));
    res = await this.raw("GET", cb.pathname + cb.search);
    if (res.status !== 303) throw new Error(`sign-in ${sub}: ${res.status}`);
    this.csrf = (await this.json("GET", "/api/csrf")).csrfToken;
    return this;
  }
}
const timings = [];
async function timed(name, fn, extra = {}) {
  const t0 = performance.now(); const r = await fn(); const ms = Math.round(performance.now() - t0);
  timings.push({ name, ms, ...extra, ...(typeof r === "object" && r?.__meta ? r.__meta : {}) }); console.log(`  ${String(ms).padStart(7)} ms  ${name}`); return r;
}

const sup = await new Session().signIn(USERS.superintendent.sub);
console.log(`Large-district check against ${BASE}: ${SCHOOLS} schools x ${PER} students`);
let schools = (await sup.json("GET", "/api/schools")).data;
const perf = schools.filter(s => /^Perf School \d+$/.test(s.name));
await timed(`create ${Math.max(0, SCHOOLS - perf.length)} schools`, async () => {
  for (let i = perf.length + 1; i <= SCHOOLS; i++) await sup.json("POST", "/api/schools", { name: `Perf School ${String(i).padStart(2, "0")}`, schoolLevel: i % 3 ? "elementary" : "middle" });
});
schools = (await sup.json("GET", "/api/schools")).data.filter(s => /^Perf School \d+$/.test(s.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, SCHOOLS);
const today = new Date().toISOString().slice(0, 10);
const csvFor = (n) => {
  let st = "local_student_number,display_name,grade_level\r\n", at = "source_event_id,local_student_number,event_date,status\r\n";
  for (let j = 1; j <= PER; j++) {
    const num = `PRF-${String(n).padStart(2, "0")}-${String(j).padStart(5, "0")}`;
    st += `${num},"Learner ${n}-${j}, Perf",${["K", "1", "2", "3", "4", "5", "6", "7", "8"][j % 9]}\r\n`;
    at += `perf-${RUN}-${num},${num},${today},${j % 17 ? "present" : "absent"}\r\n`;
  }
  return { st, at };
};
const importTimes = [];
await timed(`SIS import ${SCHOOLS * PER} students + ${SCHOOLS * PER} attendance events (${SCHOOLS} batches)`, async () => {
  for (let i = 0; i < schools.length; i++) {
    const { st, at } = csvFor(i + 1); const t0 = performance.now();
    const r = await sup.json("POST", "/api/integrations/sis/import-csv", { schoolId: schools[i].id, sourceSystem: "perf", sourceBatchId: `perf-${RUN}-${i}`, studentsCsv: st, attendanceCsv: at });
    importTimes.push(Math.round(performance.now() - t0));
    if (r.data.studentsUpserted !== PER) throw new Error(`school ${i}: upserted ${r.data.studentsUpserted}`);
  }
  importTimes.sort((a, b) => a - b);
  return { __meta: { perBatchMedianMs: importTimes[importTimes.length >> 1], perBatchMaxMs: importTimes.at(-1), bytesPerBatch: csvFor(1).st.length + csvFor(1).at.length } };
});
const first = await timed("GET /api/students?limit=1000 (first page, with total)", async () => { const r = await sup.json("GET", "/api/students?limit=1000"); return { ...r, __meta: { rows: r.data.length, total: r.page.total } }; });
await timed("GET /api/students?limit=1000 deep page (offset total-1000)", async () => { const r = await sup.json("GET", `/api/students?limit=1000&offset=${Math.max(0, first.page.total - 1000)}`); return { __meta: { rows: r.data.length } }; });
await timed("walk every student page (limit=1000)", async () => {
  let offset = 0, rows = 0, pages = 0;
  for (;;) { const r = await sup.json("GET", `/api/students?limit=1000&offset=${offset}`); rows += r.data.length; pages++; if (r.page.nextOffset == null) break; offset = r.page.nextOffset; }
  return { __meta: { rows, pages } };
});
await timed("GET /api/students?q=Learner 37-512 (name search)", async () => { const r = await sup.json("GET", `/api/students?q=${encodeURIComponent("Learner 37-512")}`); return { __meta: { rows: r.data.length } }; });
await timed("GET /api/students?q=PRF-25-00042 (student-number prefix)", async () => { const r = await sup.json("GET", "/api/students?q=PRF-25-00042"); return { __meta: { rows: r.data.length } }; });
await timed("GET /api/home (superintendent dashboard)", () => sup.json("GET", "/api/home"));
await timed("GET /api/users (first page)", () => sup.json("GET", "/api/users"));
await timed("GET /api/attendance (first page)", async () => { const r = await sup.json("GET", "/api/attendance"); return { __meta: { rows: r.data.length } }; });
await timed("POST /api/audit/export (streamed CSV)", async () => {
  const res = await sup.raw("POST", "/api/audit/export"); const text = await res.text();
  return { __meta: { status: res.status, lines: text.split("\r\n").length - 1, bytes: text.length } };
});
const mq = APPS.find(a => a.name === "MathQuest");
await timed("GET /api/apps-usage (district)", () => sup.json("GET", "/api/apps-usage"));
const teacher = await new Session().signIn(USERS.teacher.sub);
await timed("GET /api/my/apps (teacher launcher)", () => teacher.json("GET", "/api/my/apps"));
const lt = [];
await timed("20 app launches (teacher, MathQuest)", async () => { for (let i = 0; i < 20; i++) { const t0 = performance.now(); await teacher.json("POST", `/api/apps/${mq.id}/launch`); lt.push(performance.now() - t0); } lt.sort((a, b) => a - b); return { __meta: { p50Ms: Math.round(lt[10]), maxMs: Math.round(lt.at(-1)) } }; });
await timed(`re-import one school (${PER} updates, new batch)`, async () => { const { st } = csvFor(1); await sup.json("POST", "/api/integrations/sis/import-csv", { schoolId: schools[0].id, sourceSystem: "perf", sourceBatchId: `perf-${RUN}-re`, studentsCsv: st }); });
const SINGLE = Number(process.env.LARGE_SINGLE_BATCH || 0);
if (SINGLE > 0) {
  const name = "Perf Single-Batch School";
  let s = (await sup.json("GET", "/api/schools")).data.find(x => x.name === name);
  if (!s) s = (await sup.json("POST", "/api/schools", { name, schoolLevel: "high" })).data;
  let csv = "local_student_number,display_name,grade_level\r\n";
  for (let j = 1; j <= SINGLE; j++) csv += `PRB-${String(j).padStart(6, "0")},"Batch Learner ${j}",${9 + (j % 4)}\r\n`;
  await timed(`single SIS batch of ${SINGLE} students (${(csv.length / 1048576).toFixed(1)} MB CSV)`, async () => {
    const r = await sup.json("POST", "/api/integrations/sis/import-csv", { schoolId: s.id, sourceSystem: "perf", sourceBatchId: `perf-${RUN}-single`, studentsCsv: csv });
    if (r.data.studentsUpserted !== SINGLE) throw new Error(`upserted ${r.data.studentsUpserted}`);
  });
}
const report = { at: new Date().toISOString(), base: BASE, schools: SCHOOLS, studentsPerSchool: PER, totalStudentsInDistrict: first.page.total, timings };
if (process.env.LARGE_OUT) fs.writeFileSync(process.env.LARGE_OUT, JSON.stringify(report, null, 2));
console.log(`done; district now has ${first.page.total} students`);
