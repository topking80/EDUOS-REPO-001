// Public verification page. The share token lives in the URL fragment so it is
// never sent to servers in a Referer header or logged by proxies.
const $ = id => document.getElementById(id);
const LABEL = {
  valid: ["Valid", "valid", "The school's signature checks out and the credential has not been revoked."],
  revoked: ["Revoked", "revoked", "The school has revoked this credential."],
  invalid: ["Not valid", "invalid", "The signature does not match. The credential may have been changed."],
  signature_only: ["Signature OK", "other", "The signature is correct, but this server could not confirm the credential's current status."],
  share_revoked: ["Link turned off", "other", "The learner turned this link off."],
  share_expired: ["Link expired", "other", "This share link has expired. Ask the learner for a new one."],
  not_found: ["Not found", "invalid", "We could not find this link."]
};
function show(data) {
  const box = $("result");
  const [title, cls, text] = LABEL[data.result] || LABEL.not_found;
  box.replaceChildren();
  const b = document.createElement("span"); b.className = `badge ${cls}`; b.textContent = title;
  const h = document.createElement("h2"); h.textContent = data.view?.achievement || "Credential check";
  const p = document.createElement("p"); p.textContent = text;
  box.append(b, h, p);
  if (data.view) {
    const dl = document.createElement("dl");
    const rows = [["Type", data.view.achievementType], ["Issued by", data.school || data.view.issuer], ["Issued", data.view.issued ? new Date(data.view.issued).toLocaleDateString() : null],
      ["Learner", data.view.holder || "Not shown (learner's choice)"], ["Link expires", data.shareExpires ? new Date(data.shareExpires).toLocaleDateString() : null]];
    for (const [k, v] of rows) if (v) { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; dl.append(dt, dd); }
    box.append(dl);
  }
  if (data.profile) $("profile").textContent = `Format: ${data.profile}`;
  box.hidden = false;
  box.focus?.();
}
async function fromLink() {
  const m = /^#([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,64})$/i.exec(location.hash);
  if (!m) return;
  try {
    const r = await fetch(`/api/public/wallet/${m[1]}/${m[2]}`, { credentials: "omit", headers: { accept: "application/json" } });
    const j = await r.json().catch(() => ({}));
    show(r.ok ? j.data : { result: "not_found" });
  } catch { show({ result: "not_found" }); }
}
$("check").addEventListener("click", async () => {
  let vc;
  try { vc = JSON.parse($("vc").value); } catch { return show({ result: "invalid", view: null }); }
  const r = await fetch("/api/public/wallet/verify", { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: vc }) });
  const j = await r.json().catch(() => ({}));
  show(r.ok ? j.data : { result: "invalid" });
});
$("result").tabIndex = -1;
fromLink();
