// SEC-04: hostile content stays data. For each hostile input in a learner's
// question, an approved lesson or a hint, Christie's request keeps its fixed
// system prompt, carries the text only as JSON data, offers the model no tools
// and loses invisible characters; whatever a model that obeyed it says back
// is refused for the local reply; and the apps show AI text as text.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOSTILE_INPUTS, HOSTILE_REPLIES, SAFE_REPLIES } from "./fixtures/hostile-content.js";
import { unsafeReply, stripInvisible } from "../src/ai/reply-screen.js";
import { externalRequestBody, outboundHelpFields, openAiCompatibleProvider, localProvider } from "../src/christie/providers.js";

const FIELDS = { question: "How do I start?", skillTitle: "Halves", explanation: "Half means two equal parts.", prompt: "What is half of 10?", unlockedHints: ["Split 10 into two equal groups."] };
const SYSTEM = externalRequestBody({ model: "m", ...outboundHelpFields(FIELDS) }).messages[0].content;
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;

test("hostile text in any field stays data: same system prompt, JSON-only user message, no tools, no invisible characters", () => {
  for (const [kind, hostile] of Object.entries(HOSTILE_INPUTS)) {
    for (const field of ["question", "explanation", "prompt", "hint"]) {
      const f = field === "hint" ? { ...FIELDS, unlockedHints: [hostile] } : { ...FIELDS, [field]: hostile };
      const body = externalRequestBody({ model: "m", ...outboundHelpFields(f) });
      assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "temperature"], `${kind}/${field}: no tools, functions or tool_choice`);
      assert.equal(body.messages.length, 2, `${kind}/${field}: exactly a system and a user message`);
      assert.deepEqual(body.messages.map(m => m.role), ["system", "user"]);
      assert.equal(body.messages[0].content, SYSTEM, `${kind}/${field}: the system prompt never changes`);
      const data = JSON.parse(body.messages[1].content); // the user message is one JSON object; nothing broke out of it
      assert.deepEqual(Object.keys(data).sort(), ["approved_lesson", "hints_already_shown", "learner_question", "lesson_title", "problem"]);
      assert.ok(!INVISIBLE.test(body.messages[1].content), `${kind}/${field}: invisible characters removed`);
      // The wire form is exactly what JSON.stringify gives: the only place hostile text can be is inside a string value.
      assert.equal(JSON.stringify(JSON.parse(JSON.stringify(body))), JSON.stringify(body));
    }
  }
});

test("the screen refuses every hostile reply and allows ordinary tutoring prose", () => {
  for (const [kind, reply] of Object.entries(HOSTILE_REPLIES)) assert.ok(unsafeReply(reply), `${kind} is refused`);
  for (const reply of SAFE_REPLIES) assert.equal(unsafeReply(reply), null, reply);
  assert.equal(stripInvisible(HOSTILE_INPUTS.hidden_bidi).includes("\u202E"), false);
  assert.equal(stripInvisible(HOSTILE_INPUTS.unicode_tag), "Help me with halves.");
});

test("a model that obeys the injection is replaced by the local reply", async () => {
  const outbound = outboundHelpFields({ ...FIELDS, question: HOSTILE_INPUTS.image_exfil });
  const input = { ...FIELDS, question: HOSTILE_INPUTS.image_exfil, firstHint: FIELDS.unlockedHints[0], answer: "5", outbound };
  const local = await localProvider.help(input);
  for (const [kind, reply] of Object.entries({ ...HOSTILE_REPLIES, answer: "The answer is 5." })) {
    const logs = [];
    const provider = openAiCompatibleProvider({ url: "https://model.example/v1", model: "m", timeoutMs: 1000, log: m => logs.push(m),
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: reply } }] }) }) });
    const out = await provider.help(input);
    assert.equal(out.fallback, true, `${kind}: fell back`);
    assert.equal(out.text, local.text, `${kind}: the learner sees the approved-content reply`);
    assert.ok(!out.text.includes("attacker.example"));
    if (kind !== "answer") assert.ok(logs.some(l => /reply refused/.test(l)), `${kind}: logged without the reply's text`);
    assert.ok(logs.every(l => !l.includes("attacker")), "the log names the reason, not the content");
  }
  const ok = openAiCompatibleProvider({ url: "https://model.example/v1", model: "m", timeoutMs: 1000, log: () => {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: SAFE_REPLIES[0] } }] }) }) });
  assert.deepEqual(await ok.help(input), { text: SAFE_REPLIES[0], source: "external_provider" }, "plain prose still gets through");
});

test("the local tutor never quotes a hostile lesson's worked answer", async () => {
  const lesson = `${HOSTILE_INPUTS.override} Worked example: half of 10 is 5.`;
  const out = await localProvider.help({ ...FIELDS, explanation: lesson, question: "half of 10", firstHint: "Split 10 into two equal groups.", answer: "5" });
  assert.ok(!/\b5\b/.test(out.text), out.text);
});

test("the web app shows Christie's words as text, never as markup", () => {
  const app = readFileSync("public/app/app.js", "utf8");
  // One reviewed innerHTML: tile glyphs built from the validated theme model, not from user or AI text.
  const html = [...app.matchAll(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|new Function\(|\beval\(/g)];
  assert.equal(html.length, 1, html.map(m => m[0]).join(", "));
  assert.match(app.slice(html[0].index - 200, html[0].index), /validated theme model/);
  // The chat bubbles append t.text as a child, which h() turns into a text node.
  const chat = app.slice(app.indexOf("const addTurn = (t) =>"), app.indexOf("s.turns.forEach(addTurn);"));
  assert.match(chat, /"Christie: "\), t\.text,/);
  assert.match(app, /document\.createTextNode\(String\(kid\)\)/);
});

test("the mobile app shows Christie's words as plain Text, with no markdown, HTML or link handling", () => {
  const dart = readFileSync("mobile/flutter/lib/ui/screens/learner_screens.dart", "utf8");
  const start = dart.indexOf("class ChristieChatScreen");
  // The screen and its private State class, up to the next public class.
  const end = dart.slice(start + 1).search(/\nclass (?!_)/);
  const screen = end === -1 ? dart.slice(start) : dart.slice(start, start + 1 + end);
  assert.match(screen, /class _ChristieChatScreenState/);
  assert.ok(screen.length > 200, "found the chat screen");
  for (const banned of ["Markdown", "Html(", "Linkify", "launchUrl", "WebView", "RichText"]) assert.ok(!screen.includes(banned), banned);
  const pubspec = readFileSync("mobile/flutter/pubspec.yaml", "utf8");
  for (const pkg of ["flutter_markdown", "flutter_html", "linkify", "webview_flutter"]) assert.ok(!pubspec.includes(pkg), pkg);
});
