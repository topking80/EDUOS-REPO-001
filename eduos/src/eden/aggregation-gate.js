// EduOS 32.7.0 aggregation gate. PURE: no I/O, no database, no network.
//
// Everything a school node sends up the EDEN tree (district, state, root)
// passes through release() here and is re-checked by verifyReleased() at the
// moment it leaves the node (src/eden/egress.js). Student-level personal data
// never passes: the only shapes that can be released are
//   * fixed count tables (allow-listed kinds, dimensions and values), with
//     primary suppression of counts 1..4 (minimum cell size K_MIN = 5),
//     suppression of whole rows/columns whose total is below K_MIN, and
//     complementary suppression verified by linear algebra so that no
//     suppressed cell can be recovered exactly by subtraction from the
//     published cells and margins;
//   * node health metrics (numbers about the machine, none about people);
//   * a consent-gated record transfer, which is OFF by default and needs an
//     explicit, approved, single-use exception record (checked again in SQL).
// Counts are the only measure: no means, rates or percentages are released
// (a district computes rates from published counts, so a rate can never be
// published for a suppressed cell).
export const K_MIN = 5;
export const GATE_VERSION = 1;

export class GateError extends Error {
  constructor(code, detail) { super(`aggregation gate: ${code}${detail ? ` (${detail})` : ""}`); this.code = code; this.detail = detail; }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GRADE = /^(PK|K|[0-9]{1,2})$/;
const CODE = /^[A-Za-z0-9._-]{1,60}$/;
const LABEL = /^[A-Za-z0-9 #.&()-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const oneOf = list => v => list.includes(v);
const re = rx => v => typeof v === "string" && rx.test(v);

/** Allow-listed aggregate kinds. Anything else is refused. */
export const KINDS = Object.freeze({
  enrollment_by_grade: { row: "grade", col: null, slice: null, dims: { grade: re(GRADE) } },
  attendance_daily: { slice: "date", row: "grade", col: "status",
    dims: { date: re(DATE), grade: re(GRADE), status: oneOf(["present", "absent", "tardy", "excused", "not_recorded"]) } },
  mastery_by_standard: { slice: null, row: "standard", col: "level",
    dims: { standard: re(CODE), level: oneOf(["emerging", "developing", "mastered"]) } },
  transport_checkins_daily: { slice: "date", row: "route", col: "event",
    dims: { date: re(DATE), route: re(LABEL), event: oneOf(["boarded", "alighted", "not_riding", "no_checkin"]) } },
  gradebook_distribution: { slice: null, row: "course", col: "letter",
    dims: { course: re(LABEL), letter: oneOf(["A", "B", "C", "D", "F"]) } },
  safety_summary: { slice: "incident", row: null, col: "status",
    dims: { incident: re(UUID), status: oneOf(["present", "missing", "injured", "extra", "not_reported"]) },
    meta: { kind: oneOf(["lockdown", "shelter", "evacuate", "hold"]),
      drill: v => typeof v === "boolean", status: oneOf(["pending", "active", "reunification", "closed", "cancelled"]),
      startedAt: re(ISO), endedAt: v => v === null || re(ISO)(v) } }
});
export const HEALTH_METRICS = Object.freeze({
  uptimeSeconds: [0, 1e9], rssMb: [0, 1e5], heapMb: [0, 1e5], loadAvg1: [0, 1e3], outboxPending: [0, 1e7],
  outboxOldestSeconds: [0, 1e9], lastUplinkSeconds: [0, 1e9], bundles: [0, 1e4], offlineReplays24h: [0, 1e7], dbOk: [0, 1]
});
const HEALTH_TEXT = { version: /^\d{1,3}\.\d{1,3}\.\d{1,3}$/, arch: /^[a-z0-9_]{1,20}$/, tier: /^(school|district)$/ };

const ALL = "ALL";
const isCount = n => Number.isInteger(n) && n >= 0 && n <= 1e7;

// ---------------------------------------------------------------------------
// Identifier scan: a released payload must not contain any known student
// identifier (uuid, local number), student or family name, anywhere.
// ---------------------------------------------------------------------------
export function buildIdentifierIndex({ ids = [], numbers = [], names = [] } = {}) {
  const exact = new Set([...ids, ...numbers].map(x => String(x).trim().toLowerCase()).filter(x => x.length >= 3));
  const nameRx = [];
  for (const n of names) {
    const full = String(n || "").trim();
    if (full.length < 2) continue;
    const esc = full.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    nameRx.push(new RegExp(`(^|[^\\p{L}])${esc}($|[^\\p{L}])`, "iu"));
    // Family (last) names alone are identifying too.
    const parts = full.split(/\s+/);
    if (parts.length > 1 && parts.at(-1).length >= 3) nameRx.push(new RegExp(`(^|[^\\p{L}])${parts.at(-1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "iu"));
  }
  return { exact, nameRx, size: exact.size + nameRx.length };
}
function* strings(value, path = "$") {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${path}[${i}]`);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { yield [`${path}.<key>`, k]; yield* strings(v, `${path}.${k}`); }
}
export function scanForIdentifiers(payload, index, { allowIds = [] } = {}) {
  if (!index) return null;
  const allow = new Set(allowIds.map(x => String(x).toLowerCase()));
  for (const [path, s] of strings(payload)) {
    const low = s.toLowerCase();
    if (allow.has(low)) continue;
    for (const id of index.exact) if (low.includes(id)) return path;
    for (const rx of index.nameRx) if (rx.test(s)) return path;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Count tables with margins and suppression.
// ---------------------------------------------------------------------------
function validateCells(kind, spec, cells) {
  if (!Array.isArray(cells)) throw new GateError("cells_required");
  if (cells.length > 20000) throw new GateError("too_many_cells");
  const dimNames = [spec.slice, spec.row, spec.col].filter(Boolean);
  const seen = new Set();
  return cells.map((c, i) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new GateError("cell_not_object", String(i));
    for (const k of Object.keys(c)) if (k !== "count" && !dimNames.includes(k)) throw new GateError("unknown_field", `${kind}.${k}`);
    for (const d of dimNames) if (!spec.dims[d](c[d])) throw new GateError("value_not_allowed", `${kind}.${d}`);
    if (!isCount(c.count)) throw new GateError("count_not_integer", String(i));
    const key = dimNames.map(d => c[d]).join("\u0001");
    if (seen.has(key)) throw new GateError("duplicate_cell", String(i));
    seen.add(key);
    return Object.fromEntries([...dimNames.map(d => [d, c[d]]), ["count", c.count]]);
  });
}

/**
 * Build the full table for one slice: detail cells + row/column margins +
 * grand total, each with an `equations` membership, then suppress.
 */
function suppressSlice(spec, detail, k) {
  const rows = [...new Set(detail.map(c => c[spec.row] ?? ALL))].sort();
  const cols = spec.col ? [...new Set(detail.map(c => c[spec.col]))].sort() : [ALL];
  const cell = new Map(); // "r|c" -> {r,c,count,supp}
  const key = (r, c) => `${r}\u0001${c}`;
  const get = (r, c) => cell.get(key(r, c));
  for (const r of rows) for (const c of cols) cell.set(key(r, c), { r, c, count: 0, supp: null });
  for (const d of detail) get(d[spec.row] ?? ALL, spec.col ? d[spec.col] : ALL).count += d.count;
  const twoD = Boolean(spec.row) && Boolean(spec.col);
  const oneDRow = Boolean(spec.row) && !spec.col; // 1-D by row; total is (ALL, ALL)
  const equations = [];
  if (twoD) {
    for (const r of rows) cell.set(key(r, ALL), { r, c: ALL, count: cols.reduce((s, c) => s + get(r, c).count, 0), supp: null, margin: true });
    for (const c of cols) cell.set(key(ALL, c), { r: ALL, c, count: rows.reduce((s, r) => s + get(r, c).count, 0), supp: null, margin: true });
    cell.set(key(ALL, ALL), { r: ALL, c: ALL, count: rows.reduce((s, r) => s + get(r, ALL).count, 0), supp: null, margin: true });
    for (const r of rows) equations.push({ total: key(r, ALL), parts: cols.map(c => key(r, c)) });
    for (const c of cols) equations.push({ total: key(ALL, c), parts: rows.map(r => key(r, c)) });
    equations.push({ total: key(ALL, ALL), parts: rows.map(r => key(r, ALL)) });
    equations.push({ total: key(ALL, ALL), parts: cols.map(c => key(ALL, c)) });
  } else {
    const parts = oneDRow ? rows.map(r => key(r, ALL)) : cols.map(c => key(ALL, c));
    const total = parts.reduce((s, p) => s + (cell.get(p)?.count ?? 0), 0);
    cell.set(key(ALL, ALL), { r: ALL, c: ALL, count: total, supp: null, margin: true });
    equations.push({ total: key(ALL, ALL), parts });
  }
  const grand = cell.get(key(ALL, ALL));
  // 1. Whole table below K: nothing but "suppressed" is released.
  if (grand.count < k) for (const v of cell.values()) v.supp = "small_table";
  else {
    // 2. Primary: counts 1..k-1.
    for (const v of cell.values()) if (v.count > 0 && v.count < k) v.supp = "primary";
    // 3. A row or column whose total is below K is suppressed whole (zeros too:
    //    "0 absent" in a group of 3 would otherwise reveal each member).
    for (const eq of equations) {
      const t = cell.get(eq.total);
      if (t.count < k && t !== grand) for (const p of [eq.total, ...eq.parts]) if (!cell.get(p).supp) cell.get(p).supp = "small_group";
    }
    complementary(cell, equations);
  }
  return [...cell.values()];
}

/** Rank of a set of 0/1/-1 vectors (Gaussian elimination; small tables). */
function rank(vectors, n) {
  const m = vectors.map(v => v.slice());
  let r = 0;
  for (let col = 0; col < n && r < m.length; col++) {
    let piv = -1;
    for (let i = r; i < m.length; i++) if (Math.abs(m[i][col]) > 1e-9) { piv = i; break; }
    if (piv < 0) continue;
    [m[r], m[piv]] = [m[piv], m[r]];
    for (let i = 0; i < m.length; i++) if (i !== r && Math.abs(m[i][col]) > 1e-9) {
      const f = m[i][col] / m[r][col];
      for (let j = col; j < n; j++) m[i][j] -= f * m[r][j];
    }
    r++;
  }
  return r;
}
/** Suppressed cells that can be solved exactly from the published ones. */
export function recoverableCells(cells, equations) {
  const unknown = [...cells.entries()].filter(([, v]) => v.supp).map(([k]) => k);
  if (!unknown.length) return [];
  const idx = new Map(unknown.map((k, i) => [k, i]));
  const A = [];
  for (const eq of equations) {
    const vec = new Array(unknown.length).fill(0);
    let touched = false;
    if (idx.has(eq.total)) { vec[idx.get(eq.total)] -= 1; touched = true; }
    for (const p of eq.parts) if (idx.has(p)) { vec[idx.get(p)] += 1; touched = true; }
    if (touched) A.push(vec);
  }
  const base = rank(A, unknown.length);
  return unknown.filter(u => {
    const e = new Array(unknown.length).fill(0); e[idx.get(u)] = 1;
    return rank([...A, e], unknown.length) === base;
  });
}
function complementary(cell, equations) {
  for (let guard = 0; guard < 10000; guard++) {
    const exposed = recoverableCells(cell, equations);
    if (!exposed.length) return;
    // Pick an equation containing an exposed cell, hide its smallest published member.
    const target = exposed[0];
    let best = null;
    for (const eq of equations) {
      const members = [eq.total, ...eq.parts];
      if (!members.includes(target)) continue;
      for (const m of members) {
        const v = cell.get(m);
        if (v.supp) continue;
        // Prefer non-zero detail cells, then the smallest, then margins last.
        const score = [v.margin ? 1 : 0, v.count === 0 ? 1 : 0, v.count];
        if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) best = { m, score };
      }
    }
    if (!best) { for (const v of cell.values()) if (!v.supp) v.supp = "complementary"; return; }
    cell.get(best.m).supp = "complementary";
  }
  throw new GateError("suppression_did_not_converge");
}

function tableOut(spec, sliceValue, cells) {
  return cells.map(v => {
    const o = {};
    if (spec.slice) o[spec.slice] = sliceValue;
    if (spec.row) o[spec.row] = v.r;
    if (spec.col) o[spec.col] = v.c;
    if (v.supp) { o.count = null; o.suppressed = v.supp === "primary" || v.supp === "small_table" || v.supp === "small_group" ? "small_cell" : "complementary"; }
    else o.count = v.count;
    return o;
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/**
 * Release an aggregate. `input` = { kind, schoolId, period, cells | metrics, meta }.
 * `identifiers` = buildIdentifierIndex(...) of everyone at the school.
 * Returns the ONLY object shape egress will accept.
 */
export function release(input, { identifiers, k = K_MIN } = {}) {
  if (k < K_MIN) throw new GateError("k_below_minimum");
  if (!input || typeof input !== "object") throw new GateError("input_required");
  const { kind } = input;
  if (!UUID.test(String(input.schoolId || ""))) throw new GateError("school_required");
  const period = String(input.period || "");
  if (!/^[0-9A-Za-z:._-]{1,40}$/.test(period)) throw new GateError("period_invalid");
  let out;
  if (kind === "node_health") {
    const metrics = {};
    for (const [k2, v] of Object.entries(input.metrics || {})) {
      if (HEALTH_TEXT[k2]) { if (typeof v !== "string" || !HEALTH_TEXT[k2].test(v)) throw new GateError("value_not_allowed", `node_health.${k2}`); metrics[k2] = v; continue; }
      const range = HEALTH_METRICS[k2];
      if (!range) throw new GateError("unknown_field", `node_health.${k2}`);
      if (typeof v !== "number" || !Number.isFinite(v) || v < range[0] || v > range[1]) throw new GateError("value_not_allowed", `node_health.${k2}`);
      metrics[k2] = Math.round(v * 100) / 100;
    }
    out = { gate: GATE_VERSION, kind, k, schoolId: input.schoolId, period, metrics };
  } else {
    const spec = KINDS[kind];
    if (!spec) throw new GateError("kind_not_allowed", String(kind));
    const detail = validateCells(kind, spec, input.cells);
    const slices = spec.slice ? [...new Set(detail.map(c => c[spec.slice]))].sort() : [null];
    if (slices.length > 400) throw new GateError("too_many_slices");
    const cells = [];
    let meta;
    // An empty table is released as no cells at all ("nothing to report"): a
    // lone suppressed total over zero parts would be trivially recoverable.
    for (const s of slices) { const part = detail.filter(c => !spec.slice || c[spec.slice] === s); if (part.length) cells.push(...tableOut(spec, s, suppressSlice(spec, part, k))); }
    if (spec.meta) {
      meta = {};
      for (const s of slices) {
        const m = input.meta?.[s];
        if (!m || typeof m !== "object") throw new GateError("meta_required", s);
        const clean = {};
        for (const [mk, mv] of Object.entries(m)) {
          if (mk === "allAccounted") continue; // computed below, never trusted
          if (!spec.meta[mk]) throw new GateError("unknown_field", `${kind}.meta.${mk}`);
          if (!spec.meta[mk](mv)) throw new GateError("value_not_allowed", `${kind}.meta.${mk}`);
          clean[mk] = mv;
        }
        const raw = detail.filter(c => c[spec.slice] === s);
        const n = st => raw.filter(c => c.status === st).reduce((a, c) => a + c.count, 0);
        // A yes/no about the group (needed for safety), never a count below K.
        clean.allAccounted = n("missing") === 0 && n("not_reported") === 0;
        meta[s] = clean;
      }
    }
    out = { gate: GATE_VERSION, kind, k, schoolId: input.schoolId, period, cells, ...(meta ? { meta } : {}) };
  }
  const hit = scanForIdentifiers(out, identifiers, { allowIds: [input.schoolId] });
  if (hit) throw new GateError("identifier_detected", hit);
  verifyReleased(out, { identifiers, schoolId: input.schoolId });
  return Object.freeze(out);
}

/**
 * Re-check a payload at the egress point (it may have sat in the outbox, or
 * been built by code that bypassed release()). Throws GateError if it is not
 * something release() could have produced.
 */
export function verifyReleased(p, { identifiers, schoolId } = {}) {
  if (!p || typeof p !== "object" || p.gate !== GATE_VERSION) throw new GateError("not_gate_output");
  if (!Number.isInteger(p.k) || p.k < K_MIN) throw new GateError("k_below_minimum");
  if (schoolId && p.schoolId !== schoolId) throw new GateError("school_mismatch");
  if (p.kind === "consented_record_transfer") return verifyConsented(p);
  const allowedTop = p.kind === "node_health" ? ["gate", "kind", "k", "schoolId", "period", "metrics"] : ["gate", "kind", "k", "schoolId", "period", "cells", "meta"];
  for (const key of Object.keys(p)) if (!allowedTop.includes(key)) throw new GateError("unknown_field", key);
  if (p.kind === "node_health") {
    for (const [k2, v] of Object.entries(p.metrics || {})) {
      if (HEALTH_TEXT[k2]) { if (!HEALTH_TEXT[k2].test(String(v))) throw new GateError("value_not_allowed", k2); continue; }
      if (!HEALTH_METRICS[k2] || typeof v !== "number") throw new GateError("unknown_field", `node_health.${k2}`);
    }
  } else {
    const spec = KINDS[p.kind];
    if (!spec) throw new GateError("kind_not_allowed", String(p.kind));
    if (!Array.isArray(p.cells)) throw new GateError("cells_required");
    const dimNames = [spec.slice, spec.row, spec.col].filter(Boolean);
    const bySlice = new Map();
    for (const c of p.cells) {
      for (const key of Object.keys(c)) if (key !== "count" && key !== "suppressed" && !dimNames.includes(key)) throw new GateError("unknown_field", key);
      for (const d of dimNames) if (c[d] !== ALL && !spec.dims[d](c[d])) throw new GateError("value_not_allowed", d);
      if (c.count === null) { if (!["small_cell", "complementary"].includes(c.suppressed)) throw new GateError("suppression_marker_invalid"); }
      else {
        if (!isCount(c.count)) throw new GateError("count_not_integer");
        if (c.count > 0 && c.count < p.k) throw new GateError("small_cell_published", `${c.count}`);
        if (c.suppressed !== undefined) throw new GateError("suppression_marker_invalid");
      }
      const s = spec.slice ? c[spec.slice] : null;
      if (!bySlice.has(s)) bySlice.set(s, []);
      bySlice.get(s).push(c);
    }
    // No suppressed cell may be solvable from what is published.
    for (const list of bySlice.values()) {
      const cell = new Map(), key = (r, c) => `${r}\u0001${c}`;
      for (const c of list) cell.set(key(spec.row ? c[spec.row] : ALL, spec.col ? c[spec.col] : ALL), { supp: c.count === null, count: c.count, r: spec.row ? c[spec.row] : ALL, c: spec.col ? c[spec.col] : ALL });
      const rows = [...new Set([...cell.values()].map(v => v.r).filter(r => r !== ALL))];
      const cols = [...new Set([...cell.values()].map(v => v.c).filter(c => c !== ALL))];
      const eqs = [];
      if (spec.row && spec.col) {
        for (const r of rows) eqs.push({ total: key(r, ALL), parts: cols.map(c => key(r, c)) });
        for (const c of cols) eqs.push({ total: key(ALL, c), parts: rows.map(r => key(r, c)) });
        eqs.push({ total: key(ALL, ALL), parts: rows.map(r => key(r, ALL)) });
        eqs.push({ total: key(ALL, ALL), parts: cols.map(c => key(ALL, c)) });
      } else eqs.push({ total: key(ALL, ALL), parts: spec.row ? rows.map(r => key(r, ALL)) : cols.map(c => key(ALL, c)) });
      for (const eq of eqs) for (const m of [eq.total, ...eq.parts]) if (!cell.has(m)) throw new GateError("table_incomplete");
      // Published equations must add up (a doctored table cannot hide a leak).
      for (const eq of eqs) {
        const members = [eq.total, ...eq.parts].map(m => cell.get(m));
        if (members.every(v => !v.supp) && eq.parts.reduce((s, m) => s + cell.get(m).count, 0) !== cell.get(eq.total).count) throw new GateError("margins_inconsistent");
      }
      const solved = recoverableCells(new Map([...cell.entries()].map(([k2, v]) => [k2, { supp: v.supp ? "x" : null }])), eqs);
      if (solved.length) throw new GateError("suppressed_cell_recoverable", String(solved.length));
    }
    if (spec.meta) {
      for (const [s, m] of Object.entries(p.meta || {})) {
        for (const [mk, mv] of Object.entries(m)) {
          if (mk === "allAccounted") { if (typeof mv !== "boolean") throw new GateError("value_not_allowed", "allAccounted"); continue; }
          if (!spec.meta[mk] || !spec.meta[mk](mv)) throw new GateError("value_not_allowed", `meta.${mk}`);
        }
        if (!bySlice.has(s)) throw new GateError("meta_without_table");
      }
    } else if (p.meta !== undefined) throw new GateError("unknown_field", "meta");
  }
  const hit = scanForIdentifiers(p, identifiers, { allowIds: [p.schoolId] });
  if (hit) throw new GateError("identifier_detected", hit);
  return true;
}

// ---------------------------------------------------------------------------
// Consent-gated exception: a single learner's records sent up for an
// explicit, recorded purpose. OFF unless EDEN_CONSENT_EXCEPTIONS=on AND an
// approved, unexpired, unused exception names this learner and purpose.
// ---------------------------------------------------------------------------
export const CONSENT_PURPOSES = Object.freeze(["records_transfer"]);
export function releaseConsented({ exception, record }, { enabled = false, now = Date.now() } = {}) {
  if (!enabled) throw new GateError("consent_exceptions_disabled");
  if (!exception || exception.status !== "approved") throw new GateError("consent_exception_not_approved");
  if (!CONSENT_PURPOSES.includes(exception.purpose)) throw new GateError("consent_purpose_not_allowed");
  if (exception.usedAt) throw new GateError("consent_exception_used");
  if (!exception.expiresAt || Date.parse(exception.expiresAt) < now) throw new GateError("consent_exception_expired");
  if (!record || record.studentId !== exception.studentId) throw new GateError("consent_subject_mismatch");
  const finalGrades = (record.finalGrades || []).slice(0, 200).map(g => ({ course: String(g.course).slice(0, 120), grade: String(g.grade).slice(0, 4), term: String(g.term || "").slice(0, 40) }));
  const out = { gate: GATE_VERSION, kind: "consented_record_transfer", k: K_MIN, schoolId: exception.schoolId, period: new Date(now).toISOString().slice(0, 10),
    exceptionId: exception.id, purpose: exception.purpose, consentReference: String(exception.consentReference).slice(0, 120),
    record: { studentId: record.studentId, displayName: String(record.displayName).slice(0, 120), gradeLevel: String(record.gradeLevel).slice(0, 4), finalGrades } };
  verifyConsented(out);
  return Object.freeze(out);
}
function verifyConsented(p) {
  const top = ["gate", "kind", "k", "schoolId", "period", "exceptionId", "purpose", "consentReference", "record"];
  for (const key of Object.keys(p)) if (!top.includes(key)) throw new GateError("unknown_field", key);
  if (!UUID.test(String(p.exceptionId || ""))) throw new GateError("consent_exception_required");
  if (!CONSENT_PURPOSES.includes(p.purpose)) throw new GateError("consent_purpose_not_allowed");
  const rec = ["studentId", "displayName", "gradeLevel", "finalGrades"];
  for (const key of Object.keys(p.record || {})) if (!rec.includes(key)) throw new GateError("unknown_field", `record.${key}`);
  return true;
}
