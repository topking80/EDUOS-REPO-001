// TC-05 (export): the downloadable page escapes everything (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHistoryExport, escapeHtml } from "../src/history-export.js";

test("the export page escapes every field and carries a no-script policy", () => {
  const evil = `"><img src=x onerror=alert(1)><script>x</script>`;
  const html = renderHistoryExport({ format: "eduos-history-export-1", exportedAt: "2026-11-23T12:00:00Z", exportedBy: { name: evil, as: "guardian" }, student: { name: evil },
    note: "note", sha256: "abc", items: [{ type: "event", kind: "official_record", title: evil, body: `${evil}\nline 2`, occurredAt: "2026-10-01T00:00:00Z", schoolYear: evil, author: evil }] });
  assert.doesNotMatch(html, /<script>|<img|onerror=alert\(1\)>/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;<br>line 2/);
  assert.equal(escapeHtml(`a&b<'"`), "a&amp;b&lt;&#39;&quot;");
  assert.match(renderHistoryExport({ exportedAt: "2026-11-23T12:00:00Z", exportedBy: { name: "A", as: "student" }, student: { name: "S" }, note: "", sha256: "", items: [] }), /Nothing in the history yet/);
});
