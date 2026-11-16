// Student-name removal before text may leave the server (src/redact-names.js),
// across scripts, initials and punctuation; and the conservative budget
// bounds of the staff assistant (src/ai/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { removeNames, removeIdentifiers } from "../src/redact-names.js";
import { redact, redactContent, outboundHelpFields, externalRequestBody as christieBody } from "../src/christie/providers.js";
import { externalRequestBody, maxTokensFor, localProvider, capLocalOutput, localUnits, validUsage, OUTPUT_MAX_TOKENS, LOCAL_OUTPUT_MAX_BYTES } from "../src/ai/providers.js";

const CASES = [
  ["Cyrillic", "Мария Иванова", "Отчёт: Мария Иванова отсутствовала. Мария пришла позже, Иванова тоже.", ["Мария", "Иванова"]],
  ["Arabic", "محمد علي", "تأخر محمد علي اليوم، ثم وصل محمد.", ["محمد", "علي"]],
  ["Chinese, no spaces", "李小龍", "李小龍今天缺席。", ["李小龍"]],
  ["Japanese, space in the name only", "山田 花子", "山田花子さんと花子ちゃんが来た。", ["山田", "花子"]],
  ["Korean with a particle", "김민준", "김민준이 결석했다.", ["김민준"]],
  ["Hindi", "आरव शर्मा", "आज आरव शर्मा अनुपस्थित था।", ["आरव", "शर्मा"]],
  ["accented Latin, decomposed in the text", "José Núñez", "José Núñez llegó; José tarde.", ["José", "José", "Núñez"]],
  ["curly apostrophe", "Siobhán O'Brien", "Siobhán O’Brien and O'Brien.", ["Siobhán", "Brien"]],
  ["hyphenated, parts alone", "Marisol Okonkwo-Reyes", "Okonkwo and Reyes; Okonkwo-Reyes.", ["Okonkwo", "Reyes"]],
  ["one-letter parts", "A B", "Note about A B today, and A. B. again.", ["A B", "A. B."]],
  ["initial surname", "Alice A", "Alice A was absent.", ["Alice A"]],
  ["mixed script", "Lena 李", "Lena 李 and Lena.", ["Lena 李", "Lena"]],
];

for (const [label, name, text, gone] of CASES) {
  test(`removes a name: ${label}`, () => {
    const out = removeNames(text, [name]);
    for (const g of gone) assert.ok(!out.normalize("NFC").includes(g.normalize("NFC")), `${g} survived: ${out}`);
    assert.match(out, /\[name\]/);
    // The tutor's redact() (used for Christie) does the same.
    const viaRedact = redact(text, { names: [name], max: 12000 });
    for (const g of gone) assert.ok(!viaRedact.normalize("NFC").includes(g.normalize("NFC")), `redact(): ${g} survived`);
  });
}

test("ordinary words that merely contain a name part are left alone", () => {
  assert.equal(removeNames("Analyse the data, Ana.", ["Ana Lee"]), "Analyse the data, [name].");
  assert.equal(removeNames("A is a letter; Alice A left.", ["Alice A"]), "A is a letter; [name] left.");
});

test("names stored with punctuation: each part is removed on its own", () => {
  assert.equal(removeNames("Doe was late; Jane too. Jane Doe.", ["Doe, Jane"]), "[name] was late; [name] too. [name] [name].");
  assert.equal(removeNames("Okonkwo-Reyes needs follow-up.", ["Marisol Okonkwo-Reyes"]), "[name] needs follow-up.");
  assert.equal(removeNames("Brien and O'Brien.", ["Siobhán O\u2019Brien"]), "[name] and [name].");
});

test("one-character parts go only with the whole name (documented policy)", () => {
  assert.equal(removeNames("Q left; Q Z and Q. Z. stayed.", ["Q Z"]), "Q left; [name] and [name]. stayed.");
  assert.equal(removeNames("李明今天缺席，明天见。", ["李 明"]), "[name]今天缺席，明天见。");
});

test("student numbers are removed as phrases, however they are punctuated", () => {
  const ids = { numbers: ["SIS 2026 55417", "A/2026/001", "S1-0042", "77"] };
  const out = removeIdentifiers("IDs: SIS 2026 55417, SIS-2026-55417, SIS202655417; A/2026/001 and A 2026 001; S1-0042; room 77. Year 2026 stays, 770 stays.", ids);
  assert.equal(out, "IDs: [removed], [removed], [removed]; [removed] and [removed]; [removed]; room [removed]. Year 2026 stays, 770 stays.");
});

test("Christie: every outbound field is sanitized; maths digits survive", () => {
  const ids = { names: ["Marisol Okonkwo-Reyes", "Doe, Jane"], numbers: ["SIS 2026 55417"] };
  const out = outboundHelpFields({ question: "Did Jane get this? my id is SIS 2026 55417", skillTitle: "Fractions with Marisol",
    explanation: "Okonkwo-Reyes shared 123456 + 654321 apples. Write to teacher@school.example.", prompt: "Doe has 1/2 of 1000000.", unlockedHints: ["Ask Marisol.", "Halve it."] }, ids, ["Ava Morgan"]);
  const sent = JSON.stringify(christieBody({ model: "m", ...out }));
  for (const leak of ["Jane", "Doe", "Marisol", "Okonkwo", "Reyes", "55417", "school.example"]) assert.ok(!sent.includes(leak), `${leak} in ${sent}`);
  assert.match(sent, /123456 \+ 654321/, "lesson arithmetic is untouched");
  assert.match(sent, /1\/2 of 1000000/);
  assert.equal(redactContent("No names here: 3 + 4 = 7.", ids), "No names here: 3 + 4 = 7.");
});

test("the reservation is a hard bound for any tokenizer: at least one byte per token", () => {
  const chinese = "教".repeat(8000);
  const body = externalRequestBody({ model: "m", usecase: "resource_summary", input: { text: chinese } });
  const reserve = maxTokensFor(body);
  assert.ok(reserve >= Buffer.byteLength(chinese) + Buffer.byteLength(body.messages[0].content) + OUTPUT_MAX_TOKENS, `${reserve}`);
  assert.ok(reserve >= 24000 + 900, "8,000 CJK characters are 24,000 bytes");
  assert.equal(body.max_tokens, OUTPUT_MAX_TOKENS, "the model is told the output cap");
});

test("local answers are cut to the output cap", async () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence ${i} ${"word ".repeat(400)}.`).join(" ");
  const raw = await localProvider.generate("resource_summary", { text: long });
  assert.ok(Buffer.byteLength(raw) > LOCAL_OUTPUT_MAX_BYTES, "this input does produce a long answer");
  const capped = capLocalOutput(raw);
  assert.ok(Buffer.byteLength(capped) <= LOCAL_OUTPUT_MAX_BYTES);
  assert.ok(localUnits(capped) <= OUTPUT_MAX_TOKENS);
});

test("CJK-heavy local output is cut by bytes, on a character boundary, within the cap", async () => {
  const cjk = Array.from({ length: 30 }, (_, i) => `第${i}句：${"教育資源內容".repeat(60)}。`).join("");
  const raw = await localProvider.generate("resource_summary", { text: cjk });
  const capped = capLocalOutput(raw);
  assert.ok(raw.length > 1200 && Buffer.byteLength(capped) <= LOCAL_OUTPUT_MAX_BYTES, `${raw.length} chars`);
  assert.ok(localUnits(capped) <= OUTPUT_MAX_TOKENS);
  assert.ok(!capped.includes("\uFFFD"), "no broken character");
  // And what it's metered at never exceeds what was reserved for it.
  const reserve = maxTokensFor(externalRequestBody({ model: "", usecase: "resource_summary", input: { text: cjk } }));
  assert.ok(localUnits(cjk.slice(0, 8000)) + localUnits(capped) <= reserve);
});

test("a usage report counts only if it is two non-negative integers", () => {
  assert.deepEqual(validUsage({ prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 }), { prompt_tokens: 5, completion_tokens: 0 });
  for (const bad of [undefined, null, {}, { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: "5", completion_tokens: 1 }, { prompt_tokens: 1.5, completion_tokens: 1 }, { prompt_tokens: 1 }])
    assert.equal(validUsage(bad), null);
});

test("Christie lesson content also loses phone numbers, web and street addresses and labelled birth dates", () => {
  const out = redactContent("Call (555) 123-4567 or 555-123-4567 or +1 555.123.4567. See https://example.org/x and www.example.org. " +
    "Sam lives at 42 Maple Tree Avenue, Apt 3B. DOB: 03/14/2015; born on March 14, 2015; date of birth 14 March 2015.");
  for (const leak of ["555", "4567", "example.org", "42 Maple", "Avenue", "03/14/2015", "March 14, 2015", "14 March 2015"]) assert.ok(!out.includes(leak), `${leak} in ${out}`);
});

test("...while maths and history are left exactly as written", () => {
  for (const keep of ["123456 - 654321 = ?", "1/2 + 3/4 = 5/4", "10 - 3 - 2 = 5", "3.14159 × 2", "The treaty was signed on 28 June 1919.", "On 07/04/1776 the declaration was adopted.",
    "Add 4 three times: 4 + 4 + 4.", "A rectangle is 12 cm by 5 cm.", "Lincoln was born in 1809.", "Drive 3 laps of the 400 m track."])
    assert.equal(redactContent(keep), keep);
});
