# Hostile content and AI features (SEC-04)

Anything an AI model reads is untrusted, and so is anything it says back. An approved lesson, a hint, a learner's question and, once LRH-08 lands, a retrieved catalog passage can each carry instructions aimed at the model: "ignore your rules", "state the answer", "show this image", "visit this link". The model may obey. EduOS treats all of that text as data.

## The rules

1. **Fixed instructions, data in a JSON string.** The system prompt is a constant. Everything else goes in one user message as a JSON object, so hostile text can't add a message, change a role or open a new field. No tools, functions or tool choice are offered, so there is nothing to call.
2. **Invisible characters removed before sending.** Zero-width, bidirectional control, other control and Unicode tag characters are stripped (`stripInvisible`, `src/ai/reply-screen.js`). They can hide an instruction from the teacher reviewing the session. This runs inside `redact()` and `redactContent()`, together with secret, name and number removal.
3. **Only plain prose reaches a learner.** A model's reply that contains a link, a bare domain, markdown (an image, a link or a reference), HTML or entities, an email address or an invisible character is not edited. It is replaced with the local, approved-content reply (`unsafeReply`). So is a reply that gives away the answer (`leaksAnswer`, as before). The log records only the reason ("link", "markdown"...), never the text.
4. **Shown as text, everywhere.** The web app builds Christie's bubbles from text nodes (`h()` in `public/app/app.js`, with one reviewed `innerHTML` for theme glyphs). The Flutter chat uses `Text`, and the app has no markdown, HTML, linkify or web-view package. A screen that slipped would still not render or fetch anything.
5. **Hints and answers stay local.** Refusals, hints and feedback come from approved content and local rules (`src/christie/tutor.js`). The model is only asked for help text, and its help goes through rules 3 and 4.

## Tests

- `test/fixtures/hostile-content.js` holds the shared fixtures: 13 hostile inputs (instruction override, spoofed system text, role and JSON breakout, a fake tool call, image exfiltration, link bait, HTML and script, hidden bidi text, zero-width and Unicode tag smuggling, a prompt-leak request, a persona) and 14 hostile replies. Prose a tutor should be allowed to say is in `SAFE_REPLIES`.
- `test/ai-hostile-content.test.js` sends every input through every Christie field (question, lesson, problem, hint) and checks rules 1 and 2. It checks every reply is refused and replaced with the local reply, and that plain prose still gets through. It also checks the local tutor won't quote a hostile lesson's worked answer, and covers rule 4 on web and mobile.
- `test/integration/ai-external-privacy.test.js` (SEC-04 case) runs end to end: a hostile approved lesson and an obeying fake model, through the real route. The learner never sees, and the session never stores, the model's link or image.

## LRH-08 and any new assistant

Before an assistant that reads retrieved or user-supplied text ships, it must:
- build its request the same way (rule 1);
- run `stripInvisible` on what it sends and `unsafeReply` on what it shows to a learner;
- add its own case to `test/ai-hostile-content.test.js` using the shared fixtures;
- take no action on the strength of retrieved text. Any action stays draft-and-approve (audit §4.2).

The staff assistant, Leo and Edison draft for staff, who review before anything is used, and their output is shown as text. They don't apply rule 3, because a lesson draft may rightly name a website.
