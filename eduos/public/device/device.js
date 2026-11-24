// Approve a device sign-in (RFC 8628) from a browser that is already signed in
// to EduOS. The code can arrive in the URL fragment (#BCDF-GHJK, from the QR
// code on the TV); fragments are never sent to the server or in a Referer.
const $ = id => document.getElementById(id);
const KIND = { android_tv: "Android TV / Google TV", fire_tv: "Fire TV", roku: "Roku", windows: "Windows PC" };
const SAVED = "eduos.deviceCode";
let csrf = null;
let code = null;

const show = (...ids) => { for (const id of ["signin", "entry", "confirm", "result"]) $(id).hidden = !ids.includes(id); };
function result(title, text, ok) {
  const box = $("result");
  const h = document.createElement("h2"); h.textContent = title;
  const p = document.createElement("p"); p.textContent = text;
  box.className = `card ${ok ? "ok" : "bad"}`;
  box.replaceChildren(h, p);
  show("result", ...(ok ? [] : ["entry"]));
  box.focus();
}
async function post(path, body) {
  const r = await fetch(path, { method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const errorText = s => s === 404 ? "That code isn't valid or has expired. Check the screen and try again."
  : s === 429 ? "Too many tries. Wait a few minutes and try again."
  : s === 403 ? "This account can't approve screens from here." : "Something went wrong. Try again.";

async function check() {
  code = $("code").value.trim().toUpperCase();
  if (!/^[A-Z]{4}-?[A-Z]{4}$/.test(code)) return result("Check the code", "The code is 8 letters, like BCDF-GHJK.", false);
  const r = await post("/api/device-sign-in/check", { userCode: code });
  if (r.status !== 200) return result("Code not accepted", errorText(r.status), false);
  const d = r.body.data;
  $("what").textContent = `${KIND[d.clientKind] || "A screen"}${d.deviceLabel ? ` named “${d.deviceLabel}”` : ""} wants to sign in to your EduOS account.`;
  $("readonly").hidden = !d.readOnly;
  show("confirm");
  $("approve").focus();
}
async function decide(path, okTitle, okText) {
  const r = await post(path, { userCode: code });
  sessionStorage.removeItem(SAVED);
  if (r.status !== 200) return result("Code not accepted", errorText(r.status), false);
  result(okTitle, okText, true);
}

async function start() {
  const fromLink = decodeURIComponent(location.hash.slice(1));
  if (fromLink) { sessionStorage.setItem(SAVED, fromLink); history.replaceState(null, "", location.pathname); }
  $("code").value = fromLink || sessionStorage.getItem(SAVED) || "";
  const r = await fetch("/api/csrf", { credentials: "same-origin" }).catch(() => null);
  if (!r || r.status === 401) { $("signinLink").href = "/auth/login?next=/device/"; return show("signin"); }
  csrf = (await r.json().catch(() => ({}))).csrfToken;
  show("entry");
  $("code").focus();
  if ($("code").value) check();
}
$("next").addEventListener("click", check);
$("code").addEventListener("keydown", e => { if (e.key === "Enter") check(); });
$("approve").addEventListener("click", () => decide("/api/device-sign-in/approve", "Screen signed in", "The screen will open your EduOS account in a few seconds. You can close this page."));
$("deny").addEventListener("click", () => decide("/api/device-sign-in/deny", "Code refused", "That screen was not signed in. If you didn't start this, you can ignore it."));
start();
