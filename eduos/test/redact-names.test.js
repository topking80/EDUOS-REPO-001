// Student-name removal before text may leave the server (src/redact-names.js),
// across scripts, initials and punctuation; and the conservative budget
// bounds of the staff assistant (src/ai/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { removeNames } from "../src/redact-names.js";
import { redact } from "../src/christie/providers.js";
import { candidateTokens, RESERVATION_TTL_MINUTES, MAX_REQUEST_MS } from "../src/ai/gateway.js";
import { externalRequestBody, maxTokensFor, localProvider, capLocalOutput, OUTPUT_MAX_TOKENS, LOCAL_OUTPUT_MAX_CHARS } from "../src/ai/providers.js";

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

test("words of any script are candidates, one character or more", () => {
  assert.deepEqual(candidateTokens("Мария, 李小龍 and A B (2026-55417)"), ["Мария", "李小龍", "and", "A", "B", "2026-55417"]);
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
  assert.ok(raw.length > LOCAL_OUTPUT_MAX_CHARS, "this input does produce a long answer");
  const capped = capLocalOutput(raw);
  assert.ok(capped.length <= LOCAL_OUTPUT_MAX_CHARS);
  assert.ok(Math.ceil(capped.length / 4) <= OUTPUT_MAX_TOKENS);
});

test("a reservation outlives any request", () => {
  assert.ok(RESERVATION_TTL_MINUTES * 60_000 > MAX_REQUEST_MS * 5);
});
