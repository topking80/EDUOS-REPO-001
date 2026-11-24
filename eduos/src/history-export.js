// TC-05 (export): the downloadable copy of a student's history (pure).
// Everything from the database is escaped: the file is opened on someone's
// own computer, and nothing in it may run.
export const EXPORT_FORMAT = "eduos-history-export-1";
const KIND = { official_record: "Official record", family_memory: "Family memory", student_portfolio: "Student portfolio", teacher_artifact: "From a teacher", system_milestone: "Milestone" };
const AS = { student: "the student", guardian: "a guardian", grant: "shared by the student", school_lead: "school leader", district: "district office" };

export const escapeHtml = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function renderHistoryExport(doc) {
  const years = new Map();
  for (const i of doc.items) (years.get(i.schoolYear) || years.set(i.schoolYear, []).get(i.schoolYear)).push(i);
  const day = v => new Date(v).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const sections = [...years.entries()].reverse().map(([y, list]) => `<section><h2>School year ${escapeHtml(y)}</h2>${list.map(i => `
  <article><h3>${escapeHtml(i.title)}</h3><p class="meta">${escapeHtml(day(i.occurredAt))} · ${escapeHtml(KIND[i.kind] || i.kind)}${i.author ? ` · ${escapeHtml(i.author)}` : ""}</p>${i.body ? `<p>${escapeHtml(i.body).replace(/\n/g, "<br>")}</p>` : ""}${i.photos?.length ? `<ul class="meta">${i.photos.map(p => `<li>Photo: ${escapeHtml(p.description)}${p.caption ? ` (${escapeHtml(p.caption)})` : ""}</li>`).join("")}</ul>` : ""}</article>`).join("")}</section>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(doc.student.name)}: history</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}h1{margin-bottom:.25rem}.meta{color:#555;font-size:.9rem;margin:.1rem 0 .4rem}article{border-top:1px solid #ddd;padding:.6rem 0}footer{margin-top:2rem;color:#555;font-size:.85rem}@media print{body{margin:0}}</style>
</head><body>
<header><h1>${escapeHtml(doc.student.name)}: history</h1>
<p class="meta">Copy made ${escapeHtml(day(doc.exportedAt))} by ${escapeHtml(doc.exportedBy.name)} (${escapeHtml(AS[doc.exportedBy.as] || doc.exportedBy.as)}) · ${doc.items.length} item${doc.items.length === 1 ? "" : "s"}</p></header>
<main>${sections || "<p>Nothing in the history yet.</p>"}</main>
<footer><p>${escapeHtml(doc.note)}</p><p>Checksum (SHA-256 of the items): ${escapeHtml(doc.sha256)}</p></footer>
</body></html>`;
}
