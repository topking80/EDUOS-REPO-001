// Minimal RFC 4180 CSV parsing for SIS imports (32.1.0). No dependencies.
// Quoted fields may contain commas, quotes ("") and newlines. A UTF-8 BOM and
// CRLF line endings are accepted. Blank lines are ignored.
// 32.2.0: the CSV text bound is passed in from SIS_IMPORT_MAX_MB (default 50 MB;
// it was a fixed 2 MB). It protects memory; there is no row-count cap.
export const MAX_CSV_BYTES = 50 * 1024 * 1024;

export function parseCsv(text, maxBytes = MAX_CSV_BYTES) {
  if (typeof text !== "string") throw new CsvError("csv_text_required");
  if (text.length > maxBytes) throw new CsvError("csv_too_large");
  const src = text.replace(/^\uFEFF/, "");
  // `line` is the physical line being read; `rowLine` is where the current record
  // started (a quoted field may span lines), which is what errors should cite.
  const rows = []; let row = [], field = "", i = 0, quoted = false, line = 1, rowLine = 1, fieldStarted = false;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      if (c === "\n") line++;
      field += c; i++; continue;
    }
    if (c === '"' && !fieldStarted) { quoted = true; fieldStarted = true; i++; continue; }
    if (c === '"') throw new CsvError("csv_stray_quote", line);
    if (c === ",") { row.push(field); field = ""; fieldStarted = false; i++; continue; }
    if (c === "\r" && src[i + 1] === "\n") i++;
    if (c === "\n" || c === "\r") {
      row.push(field); if (row.some(v => v !== "")) rows.push({ line: rowLine, values: row });
      row = []; field = ""; fieldStarted = false; line++; rowLine = line; i++; continue;
    }
    field += c; fieldStarted = true; i++;
  }
  if (quoted) throw new CsvError("csv_unterminated_quote", line);
  row.push(field); if (row.some(v => v !== "")) rows.push({ line: rowLine, values: row });
  return rows;
}

// Date.parse rolls impossible dates over (2026-02-31 -> 2026-03-03); require a
// round trip so they are rejected with the CSV line instead.
export function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(value + "T00:00:00Z");
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export class CsvError extends Error {
  constructor(code, line = null, detail = null) { super(code); this.code = code; this.line = line; this.detail = detail; }
}

function records(text, required, optional = []) {
  if (text === undefined || text === null || text === "") return [];
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].values.map(h => h.trim().toLowerCase());
  const missing = required.filter(h => !header.includes(h));
  if (missing.length) throw new CsvError("csv_missing_columns", rows[0].line, missing.join(","));
  const unknown = header.filter(h => ![...required, ...optional].includes(h));
  if (unknown.length) throw new CsvError("csv_unknown_columns", rows[0].line, unknown.join(","));
  return rows.slice(1).map(({ line, values }) => {
    if (values.length !== header.length) throw new CsvError("csv_column_count", line);
    return { line, ...Object.fromEntries(header.map((h, k) => [h, values[k].trim()])) };
  });
}

/**
 * students.csv:   local_student_number,display_name[,grade_level]
 * attendance.csv: source_event_id,local_student_number,event_date,status
 * Returns the JSON batch shape accepted by POST /api/integrations/sis/import.
 */
export function parseSisCsv({ studentsCsv, attendanceCsv }) {
  const students = records(studentsCsv, ["local_student_number", "display_name"], ["grade_level"])
    .map(r => ({ localStudentNumber: r.local_student_number, displayName: r.display_name, gradeLevel: r.grade_level || null, line: r.line }));
  const attendance = records(attendanceCsv, ["source_event_id", "local_student_number", "event_date", "status"])
    .map(r => ({ sourceEventId: r.source_event_id, localStudentNumber: r.local_student_number, eventDate: r.event_date, status: r.status.toLowerCase(), line: r.line }));
  const seen = new Set();
  for (const s of students) {
    if (!s.localStudentNumber || !s.displayName) throw new CsvError("csv_student_fields_required", s.line);
    if (seen.has(s.localStudentNumber)) throw new CsvError("csv_duplicate_student", s.line, s.localStudentNumber);
    seen.add(s.localStudentNumber);
  }
  for (const a of attendance) {
    if (!a.sourceEventId || !a.localStudentNumber) throw new CsvError("csv_attendance_fields_required", a.line);
    if (!isCalendarDate(a.eventDate)) throw new CsvError("csv_invalid_date", a.line, a.eventDate);
    if (!["present", "absent", "tardy", "excused"].includes(a.status)) throw new CsvError("csv_invalid_status", a.line, a.status);
  }
  const strip = ({ line, ...rest }) => rest;
  return { students: students.map(strip), attendance: attendance.map(strip) };
}
