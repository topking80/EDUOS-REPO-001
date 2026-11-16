// Staff AI gateway rules and providers (src/ai/), no database or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { USECASES, denial } from "../src/ai/gateway.js";
import { localProvider, externalRequestBody, openAiCompatibleProvider } from "../src/ai/providers.js";

test("a use case runs only for its roles and only once the district enables it", () => {
  const all = Object.keys(USECASES);
  assert.equal(denial({ usecase: "lesson_draft", role: "teacher", enabled: [] }), "ai_usecase_not_enabled");
  assert.equal(denial({ usecase: "lesson_draft", role: "teacher", enabled: all }), null);
  for (const role of ["pupil", "parent", "driver", "sro"]) for (const u of all) assert.equal(denial({ usecase: u, role, enabled: all }), "ai_usecase_not_for_your_role", `${role} ${u}`);
  assert.equal(denial({ usecase: "ops_brief", role: "teacher", enabled: all }), "ai_usecase_not_for_your_role");
  assert.equal(denial({ usecase: "student_records_dump", role: "superintendent", enabled: all }), "unknown_ai_usecase");
});

test("local answers need no network", async () => {
  assert.match(await localProvider.generate("lesson_draft", { text: "Fractions on a number line" }), /Lesson plan: Fractions on a number line/);
  assert.match(await localProvider.generate("writing_feedback", { text: "Dogs are great. They are loyal and they help people every single day of the week." }), /2 sentences/);
  const s = await localProvider.generate("resource_summary", { text: "Photosynthesis turns light into chemical energy. Plants use chlorophyll. Chlorophyll absorbs light. Energy is stored in sugar. Animals eat plants for energy. The sky is blue." });
  assert.match(s, /^Summary:/);
  const brief = await localProvider.generate("ops_brief", { context: { scope: "school", day: "2026-11-15", schools: 1, attendance: { marked: 10, present: 8, tardy: 1, absent: 1 }, activeSafetyIncidents: 0, openServiceWork: 2, coverageNeeded: 1 } });
  assert.match(brief, /90% in school/); assert.match(brief, /fill open substitute coverage/);
});

test("what goes to an external model: redacted text, or counts only", () => {
  const body = externalRequestBody({ model: "m", usecase: "writing_feedback", identifiers: { names: ["Alice Anders"], numbers: ["S1-0042"] },
    input: { text: "Alice wrote this. Email alice@x.org or call 555-123-4567, student S1-0042." } });
  const sent = body.messages[1].content;
  for (const leak of ["Alice", "alice@x.org", "555-123-4567", "S1-0042"]) assert.ok(!sent.includes(leak), leak);
  const brief = externalRequestBody({ model: "m", usecase: "ops_brief", input: { context: { scope: "school", attendance: { marked: 3 } } } });
  assert.deepEqual(JSON.parse(brief.messages[1].content), { scope: "school", attendance: { marked: 3 } });
});

test("an external failure falls back to the local answer", async () => {
  const p = openAiCompatibleProvider({ url: "https://ai.example", model: "m", timeoutMs: 1000, log: () => {}, fetchImpl: async () => ({ ok: false, status: 503 }) });
  const r = await p.generate("lesson_draft", { text: "Volcanoes" });
  assert.equal(r.fallback, true); assert.match(r.text, /Lesson plan: Volcanoes/);
  const ok = openAiCompatibleProvider({ url: "https://ai.example", model: "m", timeoutMs: 1000, fetchImpl: async (url, init) => {
    assert.equal(url, "https://ai.example/chat/completions"); assert.equal(JSON.parse(init.body).model, "m");
    return { ok: true, json: async () => ({ choices: [{ message: { content: "A plan" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }) };
  } });
  assert.deepEqual(await ok.generate("lesson_draft", { text: "x" }), { text: "A plan", usage: { prompt_tokens: 10, completion_tokens: 3 } });
});
