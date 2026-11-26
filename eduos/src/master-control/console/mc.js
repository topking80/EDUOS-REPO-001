// FED-03 Master Control console shell. Builds the page from the API; no
// HTML strings, so nothing a user types is ever parsed as markup.
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
};
const main = document.getElementById("main");
let me = null, catalog = null, nodes = [], selected = null, providers = [];

async function api(method, path, body) {
  const res = await fetch(`/mc/api${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(method !== "GET" ? { "x-csrf-token": me?.csrfToken || "" } : {}) },
    body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status, body: json });
  return json.data;
}
const message = err => err.body?.reason ? `${err.message}: ${err.body.reason}` : err.body?.errors ? `${err.message}: ${err.body.errors.join("; ")}` : err.message;

async function boot() {
  try { me = await api("GET", "/me"); }
  catch (e) {
    if (e.status === 401) {
      const providers = (await (await fetch("/mc/auth/providers")).json().catch(() => ({ data: [] }))).data || [];
      const invite = new URLSearchParams(location.search).get("invite");
      main.replaceChildren(h("section", { class: "card" }, h("p", {}, "Sign in with your Master Control account."),
        h("ul", {}, providers.map(p => h("li", {}, h("a", { href: `/mc/auth/login?idp=${encodeURIComponent(p.id)}${invite ? `&invite=${encodeURIComponent(invite)}` : ""}` }, `Sign in with ${p.displayName}`))))));
      return;
    }
    main.replaceChildren(h("p", { class: "bad" }, `Couldn't load: ${e.message}`)); return;
  }
  document.getElementById("who").replaceChildren(`${me.name} · `, h("button", { class: "link", type: "button", onclick: async () => { await fetch("/mc/auth/logout", { method: "POST", headers: { "x-csrf-token": me.csrfToken }, credentials: "same-origin" }).catch(() => {}); location.reload(); } }, "Sign out"));
  catalog = await api("GET", "/catalog");
  providers = await api("GET", "/identity-providers").catch(() => []);
  await refresh();
}
async function refresh() {
  nodes = await api("GET", "/nodes");
  if (!selected || !nodes.some(n => n.id === selected)) selected = nodes.find(n => !nodes.some(p => p.id === n.parent_id))?.id || null;
  render();
}
function tree(parentId) {
  const kids = nodes.filter(n => (n.parent_id || null) === parentId || (parentId === null && n.parent_id && !nodes.some(p => p.id === n.parent_id)));
  if (!kids.length) return null;
  return h("ul", {}, kids.map(n => h("li", {}, h("button", { type: "button", "aria-current": n.id === selected ? "true" : "false", onclick: () => { selected = n.id; render(); } },
    `${n.name}`), h("span", { class: "muted" }, ` ${kindLabel(n.kind)}${n.status !== "active" ? ` · ${n.status}` : ""}`), tree(n.id))));
}
const kindLabel = k => ({ platform: "platform", state_education_authority: "state authority", district: "district", school: "school" })[k] || k;

async function render() {
  const side = h("nav", { "aria-label": "Federation" }, h("h2", {}, "Federation"), tree(null) || h("p", { class: "muted" }, "Nothing you hold a role in yet."),
    h("h2", {}, "Your roles"), h("ul", {}, me.roles.map(r => h("li", {}, `${r.role} at ${r.nodeName}`, r.inForce ? "" : h("span", { class: "muted" }, ` (${r.status})`)))));
  const panel = h("div", {}, await reviewCard(), selected ? await nodePanel(selected) : h("p", {}, "Choose a node."), await delegationPanel());
  main.replaceChildren(side, panel);
}

async function nodePanel(id) {
  const d = await api("GET", `/nodes/${encodeURIComponent(id)}`);
  const can = async cap => (await api("GET", `/check?capability=${encodeURIComponent(cap)}&nodeId=${encodeURIComponent(id)}`)).allowed;
  const n = d.node;
  const out = [h("section", { class: "card", "aria-label": "Node" }, h("h2", {}, n.name),
    h("p", { class: "muted" }, `${kindLabel(n.kind)}${n.jurisdiction_id ? ` · ${n.jurisdiction_id}` : ""}${n.tenant_ref ? ` · tenant ${n.tenant_ref}` : ""} · from ${n.effective_from}${n.effective_to ? ` to ${n.effective_to}` : ""} · `, h("code", {}, n.id)))];
  if (d.assignments) out.push(h("section", { class: "card", "aria-label": "Roles here" }, h("h3", {}, "Roles here"),
    d.assignments.length ? h("table", {}, h("tr", {}, h("th", {}, "Who"), h("th", {}, "Role"), h("th", {}, "Period"), h("th", {}, "")),
      d.assignments.map(a => h("tr", {}, h("td", {}, a.name || a.principal_id), h("td", {}, a.role), h("td", {}, `${a.effective_from}${a.effective_to ? ` – ${a.effective_to}` : ""} ${a.status}`),
        h("td", {}, a.status === "active" ? h("button", { class: "link", type: "button", onclick: () => revokeRole(a) }, "Revoke") : "")))) : h("p", { class: "muted" }, "No roles yet.")));
  const roleCap = n.kind === "district" || n.kind === "school" ? "tenant.roles.assign" : "federation.roles.assign";
  if (await can(roleCap) || (n.kind === "district" && await can("federation.membership.manage"))) out.push(assignForm(n));
  if (n.kind !== "school" && await can("federation.membership.manage")) out.push(childForm(n));
  out.push(await policyCard(n, await can("policy.set")));
  if (await can("audit.view")) out.push(await auditCard(n));
  return out;
}

function field(label, input) { return h("label", {}, label, input); }
function assignForm(n) {
  const roles = catalog.roles.filter(r => r.level === n.kind && r.status === "active");
  const role = h("select", {}, roles.map(r => h("option", { value: r.id }, r.name)));
  const idp = h("select", {}, providers.filter(p => p.status === "active").map(p => h("option", { value: p.id }, p.displayName)));
  const name = h("input", { required: true }), appr = h("input", { required: true });
  const out = h("div", { "aria-live": "polite" });
  return h("section", { class: "card", "aria-label": "Invite someone" }, h("h3", {}, "Invite someone to a role here"),
    h("p", { class: "muted" }, "They sign in once with the chosen provider using the link, and the role is attached. The link is shown only now."),
    h("form", { onsubmit: async e => { e.preventDefault();
      try { const r = await api("POST", "/invitations", { nodeId: n.id, roleId: role.value, idpId: idp.value, displayName: name.value, approvalReference: appr.value });
        out.replaceChildren(h("p", {}, `Send this link to ${name.value} privately (expires in ${r.expiresInDays} days):`), h("code", {}, r.signInUrl)); }
      catch (err) { alertCard(message(err)); } } },
      field("Role", role), field("Sign-in provider", idp), field("Name", name), field("Approval reference", appr), h("button", { class: "btn", type: "submit" }, "Create invitation")), out);
}
async function reviewCard() {
  const r = await api("GET", "/operators/review?days=90").catch(() => null);
  if (!r || !r.accounts.length) return null;
  return h("section", { class: "card", "aria-label": "Accounts to review" }, h("h2", {}, "Accounts to review"),
    h("p", { class: "muted" }, `People you manage who hold roles but haven't signed in for ${r.days} days (or ever).`),
    h("table", {}, h("tr", {}, h("th", {}, "Who"), h("th", {}, "Last sign-in"), h("th", {}, "Roles"), h("th", {}, "")),
      r.accounts.map(a => h("tr", {}, h("td", {}, a.name), h("td", {}, a.lastSignInAt ? new Date(a.lastSignInAt).toLocaleDateString() : "never"), h("td", {}, a.roles.map(x => x.role).join(", ")),
        h("td", {}, h("button", { class: "link", type: "button", onclick: async () => { const reason = prompt(`Disable ${a.name}'s account? Reason:`); if (!reason) return;
          try { await api("POST", `/operators/${encodeURIComponent(a.principalId)}/disable`, { reason }); await refresh(); } catch (err) { alertCard(message(err)); } } }, "Disable"))))));
}
function childForm(n) {
  const kind = { platform: "state_education_authority", state_education_authority: "district", district: "school" }[n.kind];
  const name = h("input", { required: true }), juris = h("input", { placeholder: "US-TX", value: n.jurisdiction_id || "" }), tenant = h("input", {}), appr = h("input", { required: true });
  return h("section", { class: "card", "aria-label": `Add a ${kindLabel(kind)}` }, h("h3", {}, `Add a ${kindLabel(kind)}`),
    h("form", { onsubmit: async e => { e.preventDefault();
      try { await api("POST", "/nodes", { parentId: n.id, kind, name: name.value, jurisdictionId: juris.value || undefined, tenantRef: tenant.value || undefined, approvalReference: appr.value }); await refresh(); }
      catch (err) { alertCard(message(err)); } } },
      field("Name", name), field("Jurisdiction", juris), kind === "district" ? field("Tenant reference", tenant) : null, field("Approval reference", appr), h("button", { class: "btn", type: "submit" }, "Add")));
}
async function policyCard(n, canSet) {
  const rows = [];
  for (const p of catalog.policies) {
    const r = await api("GET", `/policies/${encodeURIComponent(p.id)}/resolve?nodeId=${encodeURIComponent(n.id)}`);
    rows.push(h("tr", {}, h("td", {}, h("code", {}, p.id)), h("td", {}, JSON.stringify(r.value)), h("td", { class: "muted" }, r.source === "default" ? "default" : `set (${r.chain.length})${r.lockedBy ? " · locked" : ""}`),
      h("td", {}, r.conflicts.length ? h("span", { class: "bad" }, r.conflicts.map(c => c.reason).join(", ")) : "")));
  }
  const pol = h("select", {}, catalog.policies.filter(p => p.settable_levels.includes(n.kind)).map(p => h("option", { value: p.id }, p.id)));
  const val = h("input", { required: true, placeholder: "true, 5, \"en-US\"" }), lock = h("input", { type: "checkbox" }), why = h("input", { required: true });
  return h("section", { class: "card", "aria-label": "Policies" }, h("h3", {}, "Policies in effect here"), h("table", {}, h("tr", {}, h("th", {}, "Policy"), h("th", {}, "Value"), h("th", {}, "Source"), h("th", {}, "Ignored settings")), rows),
    canSet ? h("form", { onsubmit: async e => { e.preventDefault();
      let value; try { value = JSON.parse(val.value); } catch { return alertCard("Value must be JSON: true, 5 or \"en-US\"."); }
      try { await api("POST", "/policy-settings", { policyId: pol.value, nodeId: n.id, value, lockDescendants: lock.checked, reason: why.value }); await refresh(); }
      catch (err) { alertCard(message(err)); } } },
      h("h3", {}, "Set a policy here"), field("Policy", pol), field("Value", val), h("label", {}, h("span", {}, lock, " Lock for everything below (where allowed)")), field("Reason", why), h("button", { class: "btn", type: "submit" }, "Set")) : null);
}
async function auditCard(n) {
  const rows = await api("GET", `/audit?nodeId=${encodeURIComponent(n.id)}&limit=50`);
  return h("section", { class: "card", "aria-label": "Audit" }, h("h3", {}, "Audit (this node)"),
    rows.length ? h("table", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "When"), h("th", {}, "Who"), h("th", {}, "Action"), h("th", {}, "Decision")),
      rows.map(r => h("tr", {}, h("td", {}, String(r.seq)), h("td", {}, new Date(r.at).toLocaleString()), h("td", {}, h("code", {}, r.actor)), h("td", {}, r.action),
        h("td", { class: r.decision === "allowed" ? "ok" : "bad" }, `${r.decision}${r.reason ? `: ${r.reason}` : ""}`)))) : h("p", { class: "muted" }, "Nothing yet."));
}
async function delegationPanel() {
  const row = (x, given) => h("tr", {}, h("td", {}, x.nodeName), h("td", {}, x.capabilities.join(", ")), h("td", {}, x.purpose), h("td", {}, `${x.effective_from} – ${x.effective_to} ${x.status}`),
    h("td", {}, x.status === "active" ? h("button", { class: "link", type: "button", onclick: () => revokeDelegation(x) }, given ? "Revoke" : "Give up") : ""));
  const head = h("tr", {}, h("th", {}, "Where"), h("th", {}, "Capabilities"), h("th", {}, "Purpose"), h("th", {}, "Period"), h("th", {}, ""));
  return h("section", { class: "card", "aria-label": "Delegations" }, h("h2", {}, "Delegations"),
    h("h3", {}, "Given by you"), me.delegationsGiven.length ? h("table", {}, head.cloneNode(true), me.delegationsGiven.map(x => row(x, true))) : h("p", { class: "muted" }, "None."),
    h("h3", {}, "Given to you"), me.delegationsReceived.length ? h("table", {}, head.cloneNode(true), me.delegationsReceived.map(x => row(x, false))) : h("p", { class: "muted" }, "None."));
}
async function revokeRole(a) {
  const reason = prompt(`Reason for revoking ${a.role} from ${a.name || a.principal_id}?`); if (!reason) return;
  try { await api("POST", `/assignments/${encodeURIComponent(a.id)}/revoke`, { reason }); me = await api("GET", "/me"); await refresh(); } catch (err) { alertCard(message(err)); }
}
async function revokeDelegation(x) {
  const reason = prompt("Reason?"); if (!reason) return;
  try { await api("POST", `/delegations/${encodeURIComponent(x.id)}/revoke`, { reason }); me = await api("GET", "/me"); await refresh(); } catch (err) { alertCard(message(err)); }
}
function alertCard(text) { const el = h("p", { class: "bad", role: "alert" }, text); main.prepend(el); setTimeout(() => el.remove(), 8000); }
boot();
