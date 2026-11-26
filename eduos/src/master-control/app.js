// FED-03: Master Control API and console shell.
//
// Federation administration only: the education federation's nodes, who
// holds which role where, delegations, and policy settings. Every change is
// decided by the FED-02 engine (deny by default), checked against the whole
// model before it is saved, and written to a hash-chained audit log, as are
// denials and rejected changes. There is no student, guardian or staff data
// here, and the database login can't reach any.
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadModel, catalog, today, authorize, validateAuthorityModel, resolvePolicy, visibleNodes, inForce, withinNode } from "./model.js";
import { appendAudit, verifyAudit } from "./audit.js";
import { randomSecret, sha256 } from "./oidc.js";
import { PRIMARY, claimProblem, readProviderSecret } from "./identity.js";

const COOKIE = "eduos_mc";
const STATE_COOKIE = "eduos_mc_state";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const id = prefix => `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
const csrfFor = raw => sha256(`mc-csrf:${raw}`);
const text = (v, max, min = 1) => typeof v === "string" && v.trim().length >= min && v.length <= max ? v.trim() : null;
const date = v => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
const dayBefore = v => new Date(Date.parse(`${v}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
class HttpError extends Error { constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; } }
const roleById = new Map(catalog.role_definitions.map(r => [r.id, r]));
const policyById = new Map(catalog.policy_definitions.map(p => [p.id, p]));
const capIds = new Set(catalog.capabilities.map(c => c.id));

const dateOf = v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const decideAt = (model, principal, capability, nodeId) => authorize(model, { principal_id: principal, capability_id: capability, node_id: nodeId, at: today() });
/** Validation errors the change adds (problems already in the model don't block unrelated changes). */
function newErrors(model, next, extra = []) {
  const before = new Set(validateAuthorityModel(model).errors);
  return [...extra, ...validateAuthorityModel(next).errors.filter(e => !before.has(e))];
}
/**
 * May this principal give this role at this node? Platform/state nodes:
 * federation.roles.assign. District/school: tenant.roles.assign, or for a
 * new district's first superintendent, whoever enrolled it.
 */
function assignDecision(model, principal, node, role) {
  if (!role) return { allowed: false, reason: "unknown_role" };
  const tenantLevel = node.kind === "district" || node.kind === "school";
  const capability = tenantLevel ? "tenant.roles.assign" : "federation.roles.assign";
  const dcs = decideAt(model, principal, capability, node.id);
  if (dcs.allowed) return { ...dcs, capability };
  if (node.kind === "district" && role.id === "district-superintendent") {
    const hasAdmin = model.role_assignments.some(a => a.node_id === node.id && inForce(a, today()) && roleById.get(a.role_id)?.capabilities.includes("tenant.roles.assign"));
    const enrol = decideAt(model, principal, "federation.membership.manage", node.id);
    if (!hasAdmin && enrol.allowed) return { ...enrol, capability: "federation.membership.manage", basis: { ...enrol.basis, bootstrap: "first_district_superintendent" } };
  }
  return { ...dcs, capability };
}
/**
 * Who manages a provider (and the accounts it vouches for): platform/state
 * scope needs federation.identity.manage there; a district or school scope
 * belongs to the district (tenant.roles.assign).
 */
function identityDecision(model, principal, scopeNodeId) {
  const node = model.nodes.find(n => n.id === scopeNodeId);
  if (!node) return { allowed: false, reason: "unknown_node", capability: "federation.identity.manage" };
  const capability = node.kind === "district" || node.kind === "school" ? "tenant.roles.assign" : "federation.identity.manage";
  return { ...decideAt(model, principal, capability, node.id), capability };
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map(p => { const i = p.indexOf("="); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]; }));
}
function setCookie(res, cfg, name, value, maxAgeSec) {
  res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/mc; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${cfg.secureCookies ? "; Secure" : ""}`);
}

export function createApp({ cfg, db, providers }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: {
    "default-src": ["'self'"], "script-src": ["'self'"], "style-src": ["'self'"], "img-src": ["'self'"], "connect-src": ["'self'"],
    "frame-ancestors": ["'none'"], "base-uri": ["'none'"], "form-action": ["'self'"], "object-src": ["'none'"] } } }));
  app.use("/mc", rateLimit({ windowMs: 60_000, limit: cfg.rateLimitPerMinute, standardHeaders: true, legacyHeaders: false }));
  app.use("/mc/api", express.json({ limit: "64kb" }));
  app.get("/mc/healthz", (req, res) => res.json({ ok: true }));

  // ---- sign-in -----------------------------------------------------------
  // ---- sign-in (FED-04: any active trusted provider; ?idp=<id>, default primary;
  // ?invite=<code> provisions the account on first sign-in) -------------------
  const deny = (c, actor, reason, detail) => appendAudit(c, { actor, action: "sign_in", target_type: "session", decision: "denied", reason, detail });
  app.get("/mc/auth/login", async (req, res, next) => {
    try {
      const idp = typeof req.query.idp === "string" && /^[a-z0-9][a-z0-9-]{1,39}$/.test(req.query.idp) ? req.query.idp : PRIMARY;
      const invite = typeof req.query.invite === "string" && req.query.invite.length >= 20 && req.query.invite.length <= 100 ? req.query.invite : null;
      const { rows: [prov] } = await db.query("SELECT * FROM identity_providers WHERE id=$1 AND status='active'", [idp]);
      if (!prov) return res.status(404).send("That sign-in option isn't available.");
      let client;
      try { client = providers.client(prov); } catch { return res.status(503).send("That sign-in option isn't configured on this server."); }
      const state = randomSecret(24), nonce = randomSecret(24), verifier = randomSecret(48);
      await db.query("DELETE FROM pending_logins WHERE expires_at <= now()");
      await db.query("INSERT INTO pending_logins(state_hash, nonce, code_verifier, expires_at, idp_id, invitation_hash) VALUES ($1,$2,$3, now() + interval '5 minutes', $4, $5)",
        [sha256(state), nonce, verifier, prov.id, invite ? sha256(invite) : null]);
      setCookie(res, cfg, STATE_COOKIE, state, 300);
      res.redirect(302, await client.authorizationUrl({ state, nonce, verifier }));
    } catch (e) { next(e); }
  });
  app.get("/mc/auth/callback", async (req, res, next) => {
    try {
      const { code, state } = req.query;
      if (typeof code !== "string" || typeof state !== "string" || state.length > 128) return res.status(400).send("Invalid sign-in response");
      const { rows: [p] } = await db.query("DELETE FROM pending_logins WHERE state_hash=$1 RETURNING nonce, code_verifier, expires_at, idp_id, invitation_hash", [sha256(state)]);
      const bound = cookies(req)[STATE_COOKIE];
      setCookie(res, cfg, STATE_COOKIE, "", 0);
      if (!p || new Date(p.expires_at) < new Date() || !bound || bound.length !== state.length || !crypto.timingSafeEqual(Buffer.from(bound), Buffer.from(state)))
        return res.status(400).send("Sign-in expired or was started in another browser");
      const { rows: [prov] } = await db.query("SELECT * FROM identity_providers WHERE id=$1 AND status='active'", [p.idp_id]);
      if (!prov) return res.status(403).send("That sign-in option is no longer available.");
      let who;
      try { who = await providers.client(prov).exchange(code, p.code_verifier, p.nonce); } catch { return res.status(401).send("The identity provider didn't confirm this sign-in"); }
      const anon = `unknown:${sha256(`${who.issuer}|${who.subject}`).slice(0, 16)}`;
      const problem = claimProblem(prov, who.claims);
      if (problem) {
        await db.tx(c => deny(c, anon, problem, { idp: prov.id }));
        return res.status(403).send(problem === "mfa_required" ? "This sign-in needs a second factor. Sign in again with multi-factor authentication." : "This account's email domain isn't allowed here.");
      }
      // First sign-in with an invitation: create the account and attach the role.
      if (p.invitation_hash) {
        const out = await db.tx(c => acceptInvitation(c, prov, who, p.invitation_hash, anon));
        if (out.error) return res.status(out.status).send(out.message);
      }
      const { rows: [op] } = await db.query("SELECT principal_id, status, idp_id FROM operators WHERE oidc_issuer=$1 AND oidc_subject=$2", [who.issuer, who.subject]);
      if (!op || op.status !== "active" || op.idp_id !== prov.id) {
        await db.tx(c => deny(c, op?.principal_id || anon, !op ? "not_an_operator" : op.status !== "active" ? "account_disabled" : "wrong_identity_provider", { idp: prov.id }));
        return res.status(403).send("This account can't sign in to Master Control.");
      }
      const raw = randomSecret(32);
      await db.query("INSERT INTO sessions(token_hash, principal_id, expires_at) VALUES ($1,$2, now() + make_interval(hours => $3))", [sha256(raw), op.principal_id, cfg.sessionHours]);
      await db.query("UPDATE operators SET last_sign_in_at=now() WHERE principal_id=$1", [op.principal_id]);
      await db.tx(c => appendAudit(c, { actor: op.principal_id, action: "sign_in", target_type: "session", decision: "allowed", detail: { idp: prov.id } }));
      setCookie(res, cfg, COOKIE, raw, cfg.sessionHours * 3600);
      res.redirect(303, "/mc/");
    } catch (e) { next(e); }
  });

  /**
   * Accept an invitation inside one serialized transaction. The inviter's
   * authority is checked again now (they may have lost it since), and the
   * whole model is validated with the new assignment.
   */
  async function acceptInvitation(c, prov, who, codeHash, anon) {
    const fail = async (reason, status, message) => { await appendAudit(c, { actor: anon, action: "accept_invitation", target_type: "invitation", decision: "denied", reason }); return { error: reason, status, message }; };
    const { rows: [inv] } = await c.query("SELECT * FROM invitations WHERE code_hash=$1 FOR UPDATE", [codeHash]);
    if (!inv || inv.accepted_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) return fail("invitation_not_valid", 403, "That invitation isn't valid any more. Ask for a new one.");
    if (inv.idp_id !== prov.id) return fail("wrong_identity_provider", 403, "Use the sign-in option named in your invitation.");
    let { rows: [op] } = await c.query("SELECT * FROM operators WHERE oidc_issuer=$1 AND oidc_subject=$2", [who.issuer, who.subject]);
    if (op && (op.status !== "active" || op.idp_id !== prov.id)) return fail("account_disabled", 403, "This account can't sign in to Master Control.");
    const model = await loadModel(c);
    const principal = op?.principal_id || `op-${crypto.randomUUID()}`;
    if (principal === inv.created_by) return fail("cannot_assign_yourself", 403, "You can't accept your own invitation.");
    const node = model.nodes.find(n => n.id === inv.node_id);
    const decision = node ? assignDecision(model, inv.created_by, node, roleById.get(inv.role_id)) : { allowed: false, reason: "unknown_node" };
    if (!decision.allowed) return fail(`inviter_${decision.reason}`, 403, "The person who invited you can no longer give this role. Ask them again.");
    const aid = id("ra");
    const row = { id: aid, principal_id: principal, role_id: inv.role_id, node_id: inv.node_id, status: "active", effective_from: today(),
      ...(inv.effective_to && { effective_to: dateOf(inv.effective_to) }), approval_reference: inv.approval_reference };
    const next = structuredClone(model); next.role_assignments.push(row);
    const errs = newErrors(model, next);
    if (errs.length) { await appendAudit(c, { actor: anon, action: "accept_invitation", target_type: "invitation", target_id: inv.id, node_id: inv.node_id, decision: "rejected", reason: "invalid_change", detail: { errors: errs.slice(0, 20) } }); return { error: "invalid", status: 422, message: "This invitation can't be used: the role no longer fits." }; }
    if (!op) await c.query("INSERT INTO operators(principal_id, oidc_issuer, oidc_subject, display_name, idp_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)",
      [principal, who.issuer, who.subject, inv.display_name, prov.id, `invitation:${inv.id}`]);
    await c.query(`INSERT INTO role_assignments(id, principal_id, role_id, node_id, status, effective_from, effective_to, approval_reference, created_by)
      VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8)`, [aid, principal, inv.role_id, inv.node_id, row.effective_from, row.effective_to ?? null, inv.approval_reference, inv.created_by]);
    await c.query("UPDATE invitations SET accepted_by=$2, accepted_at=now(), assignment_id=$3 WHERE id=$1", [inv.id, principal, aid]);
    await appendAudit(c, { actor: principal, action: "accept_invitation", target_type: "role_assignment", target_id: aid, node_id: inv.node_id, capability: decision.capability,
      decision: "allowed", basis: { ...decision.basis, invitation: inv.id, invited_by: inv.created_by }, detail: { role: inv.role_id, idp: prov.id, newOperator: !op } });
    return { ok: true };
  }

  async function requireOperator(req, res, next) {
    try {
      const raw = cookies(req)[COOKIE];
      if (!raw) return res.status(401).json({ error: "sign_in_required" });
      const { rows: [s] } = await db.query(`SELECT s.principal_id, o.display_name FROM sessions s JOIN operators o ON o.principal_id = s.principal_id
        JOIN identity_providers p ON p.id = o.idp_id
        WHERE s.token_hash=$1 AND s.expires_at > now() AND o.status='active' AND p.status='active'`, [sha256(raw)]);
      if (!s) return res.status(401).json({ error: "sign_in_required" });
      if (req.method !== "GET" && req.method !== "HEAD") {
        const t = req.get("x-csrf-token") || "", want = csrfFor(raw);
        if (t.length !== want.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(want))) return res.status(403).json({ error: "csrf_failed" });
      }
      req.raw = raw; req.principal = s.principal_id; req.operatorName = s.display_name;
      next();
    } catch (e) { next(e); }
  }
  app.post("/mc/auth/logout", requireOperator, async (req, res, next) => {
    try { await db.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(req.raw)]); setCookie(res, cfg, COOKIE, "", 0); res.json({ ok: true }); } catch (e) { next(e); }
  });

  const read = fn => [requireOperator, async (req, res, next) => {
    try { const data = await fn(req, await loadModel(db)); res.setHeader("Cache-Control", "no-store"); res.json({ data }); }
    catch (e) { e instanceof HttpError ? res.status(e.status).json({ error: e.code, ...e.extra }) : next(e); }
  }];

  /**
   * One administrative change: decide (FED-02 engine), check the whole model
   * with the change applied, save, and audit, serialized with every other
   * change. Denials and rejected changes are audited too.
   */
  const change = (action, targetType, plan) => [requireOperator, async (req, res, next) => {
    try {
      const out = await db.tx(async c => {
        const model = await loadModel(c);
        const p = await plan(req, model, c);
        const base = { actor: req.principal, action, target_type: targetType, target_id: p.targetId, node_id: p.nodeId, capability: p.capability };
        if (!p.decision.allowed) {
          await appendAudit(c, { ...base, decision: "denied", reason: p.decision.reason });
          return { status: 403, body: { error: "not_authorized", reason: p.decision.reason } };
        }
        const next = p.next(structuredClone(model));
        const errs = newErrors(model, next, p.extraErrors);
        if (errs.length) {
          await appendAudit(c, { ...base, decision: "rejected", reason: "invalid_change", detail: { errors: errs.slice(0, 20) } });
          return { status: 422, body: { error: "invalid_change", errors: errs } };
        }
        await p.apply(c);
        const { seq } = await appendAudit(c, { ...base, decision: "allowed", basis: p.decision.basis, detail: p.detail });
        return { status: p.created ? 201 : 200, body: { data: { ...p.result, auditSeq: seq } } };
      });
      res.status(out.status).json(out.body);
    } catch (e) { e instanceof HttpError ? res.status(e.status).json({ error: e.code, ...e.extra }) : next(e); }
  }];
  const decide = (model, principal, capability, nodeId) => authorize(model, { principal_id: principal, capability_id: capability, node_id: nodeId, at: today() });

  // ---- reads ---------------------------------------------------------------
  app.get("/mc/api/me", ...read(async (req, m) => {
    const at = today();
    const nodeName = id => m.nodes.find(n => n.id === id)?.name || id;
    const { rows: [op] } = await db.query("SELECT idp_id, last_sign_in_at FROM operators WHERE principal_id=$1", [req.principal]);
    return { principalId: req.principal, name: req.operatorName, csrfToken: csrfFor(req.raw), today: at, idp: op?.idp_id, lastSignInAt: op?.last_sign_in_at,
      roles: m.role_assignments.filter(a => a.principal_id === req.principal).map(a => ({ ...a, role: roleById.get(a.role_id)?.name, nodeName: nodeName(a.node_id), inForce: inForce(a, at) })),
      delegationsReceived: m.delegations.filter(x => x.delegate_principal_id === req.principal).map(x => ({ ...x, nodeName: nodeName(x.node_id), inForce: inForce(x, at) })),
      delegationsGiven: m.delegations.filter(x => ownerOf(m, x) === req.principal).map(x => ({ ...x, nodeName: nodeName(x.node_id), inForce: inForce(x, at) })) };
  }));
  app.get("/mc/api/catalog", ...read(async () => ({ version: catalog.model_version, capabilities: catalog.capabilities, roles: catalog.role_definitions, policies: catalog.policy_definitions })));
  app.get("/mc/api/nodes", ...read(async (req, m) => {
    const vis = visibleNodes(m, req.principal);
    return m.nodes.filter(n => vis.has(n.id));
  }));
  app.get("/mc/api/nodes/:id", ...read(async (req, m) => {
    const n = m.nodes.find(x => x.id === req.params.id);
    if (!n || !visibleNodes(m, req.principal).has(n.id)) throw new HttpError(404, "node_not_found");
    const canSee = ["audit.view", "federation.roles.assign", "tenant.roles.assign"].some(cap => decide(m, req.principal, cap, n.id).allowed);
    const names = canSee ? new Map((await db.query("SELECT principal_id, display_name FROM operators")).rows.map(r => [r.principal_id, r.display_name])) : null;
    return { node: n, children: m.nodes.filter(x => x.parent_id === n.id).map(x => x.id),
      assignments: canSee ? m.role_assignments.filter(a => a.node_id === n.id).map(a => ({ ...a, name: names.get(a.principal_id), role: roleById.get(a.role_id)?.name })) : null,
      delegations: canSee ? m.delegations.filter(x => x.node_id === n.id).map(x => ({ ...x, delegateName: names.get(x.delegate_principal_id) })) : null };
  }));
  app.get("/mc/api/check", ...read(async (req, m) => {
    const cap = text(req.query.capability, 100), node = text(req.query.nodeId, 80);
    if (!cap || !node) throw new HttpError(400, "capability_and_node_required");
    return decide(m, req.principal, cap, node);
  }));
  app.get("/mc/api/policies/:id/resolve", ...read(async (req, m) => {
    const node = text(req.query.nodeId, 80);
    if (!policyById.has(req.params.id)) throw new HttpError(404, "policy_not_found");
    if (!node || !visibleNodes(m, req.principal).has(node)) throw new HttpError(404, "node_not_found");
    const at = date(req.query.at) || today();
    return { policy: policyById.get(req.params.id), nodeId: node, at, ...resolvePolicy(m, req.params.id, node, at) };
  }));
  app.get("/mc/api/audit", ...read(async (req, m) => {
    const node = text(req.query.nodeId, 80);
    if (!node) throw new HttpError(400, "node_required");
    const dcs = decide(m, req.principal, "audit.view", node);
    if (!dcs.allowed) throw new HttpError(403, "not_authorized", { reason: dcs.reason });
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const { rows } = await db.query("SELECT seq, at, actor, action, target_type, target_id, node_id, capability, decision, reason, basis, detail, hash FROM audit_log WHERE node_id=$1 ORDER BY seq DESC LIMIT $2", [node, limit]);
    return rows.map(r => ({ ...r, seq: Number(r.seq) }));
  }));
  app.get("/mc/api/audit/verify", ...read(async (req, m) => {
    const root = m.nodes.find(n => n.kind === "platform");
    if (!root || !decide(m, req.principal, "platform.config.manage", root.id).allowed) throw new HttpError(403, "not_authorized");
    return verifyAudit(db);
  }));

  // ---- changes -------------------------------------------------------------
  app.post("/mc/api/nodes", ...change("create_node", "node", async (req, m) => {
    const b = req.body || {};
    const parent = text(b.parentId, 80), kind = text(b.kind, 40), name = text(b.name, 200), appr = text(b.approvalReference, 300);
    const from = date(b.effectiveFrom) || today();
    if (!parent || !kind || !name || !appr || kind === "platform") throw new HttpError(400, "parent_kind_name_and_approval_required");
    const nodeId = id(kind === "state_education_authority" ? "sea" : kind === "district" ? "dist" : "sch");
    const row = { id: nodeId, kind, parent_id: parent, jurisdiction_id: text(b.jurisdictionId, 5) || undefined, tenant_ref: text(b.tenantRef, 200) || undefined,
      name, status: "active", effective_from: from };
    if (kind === "school") row.tenant_ref = m.nodes.find(n => n.id === parent)?.tenant_ref;
    return { capability: "federation.membership.manage", nodeId: parent, targetId: nodeId, created: true,
      decision: decide(m, req.principal, "federation.membership.manage", parent),
      next: mm => { mm.nodes.push(Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined))); return mm; },
      apply: c => c.query(`INSERT INTO nodes(id, kind, parent_id, jurisdiction_id, tenant_ref, name, status, effective_from, approval_reference, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9)`, [nodeId, kind, parent, row.jurisdiction_id ?? null, row.tenant_ref ?? null, name, from, appr, req.principal]),
      detail: { kind, name, parent, approvalReference: appr }, result: row };
  }));

  app.post("/mc/api/nodes/:id/close", ...change("close_node", "node", async (req, m) => {
    const n = m.nodes.find(x => x.id === req.params.id);
    const on = date(req.body?.effectiveTo), reason = text(req.body?.reason, 300, 3);
    if (!n) throw new HttpError(404, "node_not_found");
    if (!on || !reason || n.kind === "platform") throw new HttpError(400, "end_date_and_reason_required");
    return { capability: "federation.membership.manage", nodeId: n.id, targetId: n.id,
      decision: decide(m, req.principal, "federation.membership.manage", n.id),
      next: mm => { Object.assign(mm.nodes.find(x => x.id === n.id), { status: "expired", effective_to: on }); return mm; },
      apply: c => c.query("UPDATE nodes SET status='expired', effective_to=$2 WHERE id=$1", [n.id, on]),
      detail: { effectiveTo: on, reason }, result: { id: n.id, status: "expired", effectiveTo: on } };
  }));

  // Roles at platform and state nodes: federation.roles.assign. Roles at a
  // district or school: tenant.roles.assign, which only the district holds;
  // the one exception is a new district's first superintendent, set up by
  // whoever enrolled the district (federation.membership.manage).
  app.post("/mc/api/assignments", ...change("assign_role", "role_assignment", async (req, m, c) => {
    const b = req.body || {};
    const node = m.nodes.find(n => n.id === b.nodeId), role = roleById.get(b.roleId), appr = text(b.approvalReference, 300);
    const from = date(b.effectiveFrom) || today(), to = b.effectiveTo === undefined ? null : date(b.effectiveTo);
    if (!node || !role || !appr || (b.effectiveTo !== undefined && !to)) throw new HttpError(400, "node_role_and_approval_required");
    let principal = text(b.principalId, 80), newOperator = null, idpId;
    if (!principal) {
      const subject = text(b.subject, 255), displayName = text(b.displayName, 200);
      idpId = text(b.idpId, 40) || PRIMARY;
      if (!subject || !displayName) throw new HttpError(400, "principal_or_subject_required");
      const { rows: [prov] } = await c.query("SELECT issuer, status FROM identity_providers WHERE id=$1", [idpId]);
      if (!prov || prov.status !== "active") throw new HttpError(404, "identity_provider_not_found");
      const { rows: [o] } = await c.query("SELECT principal_id, idp_id FROM operators WHERE oidc_issuer=$1 AND oidc_subject=$2", [prov.issuer, subject]);
      principal = o?.principal_id || `op-${crypto.randomUUID()}`;
      if (!o) newOperator = { principal, subject, displayName, issuer: prov.issuer, idpId };
    } else {
      const { rows: [o] } = await c.query("SELECT idp_id FROM operators WHERE principal_id=$1", [principal]);
      if (!o) throw new HttpError(404, "operator_not_found");
      idpId = o.idp_id;
    }
    if (principal === req.principal) throw new HttpError(403, "cannot_assign_yourself");
    const { rows: [scope] } = await c.query("SELECT scope_node_id FROM identity_providers WHERE id=$1", [idpId]);
    const outside = !scope || !withinNode(m.nodes, scope.scope_node_id, node.id);
    const decision = assignDecision(m, req.principal, node, role), capability = decision.capability;
    const aid = id("ra");
    const row = { id: aid, principal_id: principal, role_id: role.id, node_id: node.id, status: "active", effective_from: from, ...(to && { effective_to: to }), approval_reference: appr };
    return { capability, nodeId: node.id, targetId: aid, created: true, decision,
      extraErrors: outside ? [`role_assignments.${aid}: ${node.id} is outside what this person's identity provider may vouch for`] : [],
      next: mm => { mm.role_assignments.push(row); return mm; },
      apply: async cc => {
        if (newOperator) await cc.query("INSERT INTO operators(principal_id, oidc_issuer, oidc_subject, display_name, idp_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)",
          [newOperator.principal, newOperator.issuer, newOperator.subject, newOperator.displayName, newOperator.idpId, req.principal]);
        await cc.query(`INSERT INTO role_assignments(id, principal_id, role_id, node_id, status, effective_from, effective_to, approval_reference, notes, created_by)
          VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9)`, [aid, principal, role.id, node.id, from, to, appr, text(b.notes, 1000) || null, req.principal]);
      },
      detail: { principal, role: role.id, idp: idpId, approvalReference: appr, newOperator: !!newOperator }, result: row };
  }));

  app.post("/mc/api/assignments/:id/revoke", ...change("revoke_role", "role_assignment", async (req, m) => {
    const a = m.role_assignments.find(x => x.id === req.params.id), reason = text(req.body?.reason, 300, 3);
    if (!a) throw new HttpError(404, "assignment_not_found");
    if (!reason) throw new HttpError(400, "reason_required");
    const on = date(req.body?.revokedOn) || today();
    if (on < today()) throw new HttpError(400, "cannot_revoke_in_the_past");
    const node = m.nodes.find(n => n.id === a.node_id);
    const capability = node.kind === "district" || node.kind === "school" ? "tenant.roles.assign" : "federation.roles.assign";
    const decision = a.principal_id === req.principal ? { allowed: true, basis: { type: "self", id: a.id } } : decide(m, req.principal, capability, node.id);
    return { capability, nodeId: node.id, targetId: a.id, decision,
      next: mm => { Object.assign(mm.role_assignments.find(x => x.id === a.id), { status: "revoked", revoked_on: on }); return mm; },
      apply: c => c.query("UPDATE role_assignments SET status='revoked', revoked_on=$2 WHERE id=$1", [a.id, on]),
      detail: { revokedOn: on, reason }, result: { id: a.id, status: "revoked", revokedOn: on } };
  }));

  app.post("/mc/api/delegations", ...change("delegate", "delegation", async (req, m) => {
    const b = req.body || {};
    const caps = Array.isArray(b.capabilities) ? [...new Set(b.capabilities)] : [];
    const purpose = text(b.purpose, 300, 3), appr = text(b.approvalReference, 300);
    const from = date(b.effectiveFrom) || today(), to = date(b.effectiveTo);
    if (!caps.length || caps.length > 20 || !caps.every(x => capIds.has(x)) || !purpose || !appr || !to || !text(b.nodeId, 80) || !text(b.delegatePrincipalId, 80) || !text(b.delegateHomeNodeId, 80))
      throw new HttpError(400, "invalid_delegation");
    if (!!b.fromAssignmentId === !!b.fromDelegationId) throw new HttpError(400, "one_source_required");
    const src = b.fromAssignmentId ? m.role_assignments.find(a => a.id === b.fromAssignmentId) : m.delegations.find(x => x.id === b.fromDelegationId);
    if (!src) throw new HttpError(404, "source_not_found");
    const srcOwner = b.fromAssignmentId ? src.principal_id : src.delegate_principal_id;
    if (b.delegatePrincipalId === req.principal) throw new HttpError(403, "cannot_delegate_to_yourself");
    const did = id("dl");
    const row = { id: did, ...(b.fromAssignmentId ? { from_assignment_id: src.id } : { from_delegation_id: src.id }), delegate_principal_id: b.delegatePrincipalId,
      delegate_home_node_id: b.delegateHomeNodeId, node_id: b.nodeId, capabilities: caps, purpose, may_redelegate: b.mayRedelegate === true, status: "active",
      effective_from: from, effective_to: to, approval_reference: appr };
    return { capability: caps.join(","), nodeId: b.nodeId, targetId: did, created: true,
      decision: srcOwner === req.principal ? { allowed: true, basis: { type: "own_source", id: src.id } } : { allowed: false, reason: "not_your_authority" },
      next: mm => { mm.delegations.push(row); return mm; },
      apply: c => c.query(`INSERT INTO delegations(id, from_assignment_id, from_delegation_id, delegate_principal_id, delegate_home_node_id, node_id, capabilities, purpose,
          may_redelegate, status, effective_from, effective_to, approval_reference, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$12,$13)`,
        [did, row.from_assignment_id ?? null, row.from_delegation_id ?? null, row.delegate_principal_id, row.delegate_home_node_id, row.node_id, caps, purpose,
          row.may_redelegate, from, to, appr, req.principal]),
      detail: { delegate: row.delegate_principal_id, capabilities: caps, purpose, effectiveTo: to, approvalReference: appr }, result: row };
  }));

  app.post("/mc/api/delegations/:id/revoke", ...change("revoke_delegation", "delegation", async (req, m) => {
    const dl = m.delegations.find(x => x.id === req.params.id), reason = text(req.body?.reason, 300, 3);
    if (!dl) throw new HttpError(404, "delegation_not_found");
    if (!reason) throw new HttpError(400, "reason_required");
    const on = today();
    // The delegator, anyone above them in the chain, or the delegate (giving it up).
    const owners = new Set([dl.delegate_principal_id]);
    for (let x = dl; x; x = x.from_delegation_id ? m.delegations.find(y => y.id === x.from_delegation_id) : null) owners.add(ownerOf(m, x));
    return { capability: dl.capabilities.join(","), nodeId: dl.node_id, targetId: dl.id,
      decision: owners.has(req.principal) ? { allowed: true, basis: { type: "delegation_party", id: dl.id } } : { allowed: false, reason: "not_a_party" },
      next: mm => { Object.assign(mm.delegations.find(x => x.id === dl.id), { status: "revoked", revoked_on: on }); return mm; },
      apply: c => c.query("UPDATE delegations SET status='revoked', revoked_on=$2 WHERE id=$1", [dl.id, on]),
      detail: { reason }, result: { id: dl.id, status: "revoked", revokedOn: on } };
  }));

  app.post("/mc/api/policy-settings", ...change("set_policy", "policy_setting", async (req, m) => {
    const b = req.body || {};
    const pd = policyById.get(b.policyId), node = m.nodes.find(n => n.id === b.nodeId), reason = text(b.reason, 300, 3);
    const from = date(b.effectiveFrom) || today();
    if (!pd || !node || !reason || !Object.hasOwn(b, "value")) throw new HttpError(400, "policy_node_value_and_reason_required");
    if (from < today()) throw new HttpError(400, "cannot_set_policy_in_the_past");
    const decision = decide(m, req.principal, "policy.set", node.id);
    const viaAssignment = decision.basis?.type === "assignment" ? decision.basis.id
      : decision.basis?.type === "delegation" ? decision.basis.from_assignment_id : null;
    const prior = m.policy_settings.filter(s => s.policy_id === pd.id && s.node_id === node.id);
    const version = prior.reduce((v, s) => Math.max(v, s.version), 0) + 1;
    const current = prior.filter(s => s.status === "active" && (!s.effective_to || s.effective_to >= from));
    const sid = id("ps");
    const row = { id: sid, policy_id: pd.id, node_id: node.id, value: b.value, lock_descendants: b.lockDescendants === true, version, status: "active",
      effective_from: from, set_by_assignment_id: viaAssignment, reason };
    // Earlier versions end the day before; one that hadn't started yet is superseded.
    const ends = current.map(s => s.effective_from < from ? { id: s.id, effective_to: dayBefore(from) } : { id: s.id, status: "superseded" });
    return { capability: "policy.set", nodeId: node.id, targetId: sid, created: true, decision,
      next: mm => { for (const e of ends) Object.assign(mm.policy_settings.find(s => s.id === e.id), e); mm.policy_settings.push(row); return mm; },
      apply: async c => {
        for (const e of ends) await c.query("UPDATE policy_settings SET effective_to=coalesce($2, effective_to), status=coalesce($3, status) WHERE id=$1", [e.id, e.effective_to ?? null, e.status ?? null]);
        await c.query(`INSERT INTO policy_settings(id, policy_id, node_id, value, lock_descendants, version, status, effective_from, set_by_assignment_id, reason, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10)`, [sid, pd.id, node.id, JSON.stringify(b.value), row.lock_descendants, version, from, viaAssignment, reason, req.principal]);
      },
      detail: { policy: pd.id, value: b.value, lockDescendants: row.lock_descendants, version, reason }, result: row };
  }));

  // ---- FED-04: trusted identity providers ----------------------------------
  const providerView = r => ({ id: r.id, issuer: r.issuer, displayName: r.display_name, clientId: r.client_id, clientSecretEnv: r.client_secret_env,
    secretConfigured: !!readProviderSecret(r.client_secret_env), scopes: r.scopes, scopeNodeId: r.scope_node_id, requireMfa: r.require_mfa,
    allowedEmailDomains: r.allowed_email_domains, status: r.status, statusChangedAt: r.status_changed_at, statusReason: r.status_reason });
  app.get("/mc/api/identity-providers", ...read(async (req, m) => {
    const vis = visibleNodes(m, req.principal);
    return (await db.query("SELECT * FROM identity_providers ORDER BY id")).rows.filter(r => vis.has(r.scope_node_id) || m.nodes.some(n => vis.has(n.id) && withinNode(m.nodes, r.scope_node_id, n.id))).map(providerView);
  }));
  // Sign-in options anyone may see on the sign-in page: names only.
  app.get("/mc/auth/providers", async (req, res, next) => {
    try { res.json({ data: (await db.query("SELECT id, display_name FROM identity_providers WHERE status='active' ORDER BY id='primary' DESC, display_name")).rows.map(r => ({ id: r.id, displayName: r.display_name })) }); }
    catch (e) { next(e); }
  });

  app.post("/mc/api/identity-providers", ...change("register_identity_provider", "identity_provider", async (req, m, c) => {
    const b = req.body || {};
    const pid = typeof b.id === "string" && /^[a-z0-9][a-z0-9-]{1,39}$/.test(b.id) ? b.id : null;
    const issuer = text(b.issuer, 500), name = text(b.displayName, 200), clientId = text(b.clientId, 300), scopeNode = text(b.scopeNodeId, 80);
    const secretEnv = typeof b.clientSecretEnv === "string" && /^MC_[A-Z0-9_]{3,60}$/.test(b.clientSecretEnv) ? b.clientSecretEnv : null;
    const domains = Array.isArray(b.allowedEmailDomains) ? [...new Set(b.allowedEmailDomains.map(x => String(x).trim().toLowerCase()))] : [];
    const scopes = Array.isArray(b.scopes) && b.scopes.length ? [...new Set(b.scopes.map(String))] : ["openid", "profile", "email"];
    if (!pid || pid === PRIMARY || !issuer || !name || !clientId || !secretEnv || !scopeNode) throw new HttpError(400, "id_issuer_name_client_secret_env_and_scope_required");
    let url; try { url = new URL(issuer); } catch { throw new HttpError(400, "issuer_must_be_a_url"); }
    if (url.protocol !== "https:" && !(cfg.nodeEnv !== "production" && url.protocol === "http:")) throw new HttpError(400, "issuer_must_be_https");
    if (!scopes.includes("openid") || scopes.some(x => !/^[A-Za-z0-9_.:/-]{1,80}$/.test(x)) || domains.some(x => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(x))) throw new HttpError(400, "invalid_scopes_or_domains");
    if ((await c.query("SELECT 1 FROM identity_providers WHERE id=$1 OR issuer=$2", [pid, issuer.replace(/\/$/, "")])).rowCount) throw new HttpError(409, "identity_provider_exists");
    const decision = identityDecision(m, req.principal, scopeNode);
    const row = { id: pid, issuer: issuer.replace(/\/$/, ""), display_name: name, client_id: clientId, client_secret_env: secretEnv, scopes, scope_node_id: scopeNode,
      require_mfa: b.requireMfa === true, allowed_email_domains: domains };
    // Check the issuer really is an OIDC provider before trusting it.
    const extraErrors = [];
    if (decision.allowed) {
      try {
        const r = await fetch(`${row.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(cfg.oidcHttpTimeoutMs), headers: { accept: "application/json" } });
        const meta = r.ok ? await r.json() : null;
        if (String(meta?.issuer || "").replace(/\/$/, "") !== row.issuer) extraErrors.push(`identity_providers.${pid}: discovery didn't confirm the issuer`);
      } catch { extraErrors.push(`identity_providers.${pid}: discovery failed`); }
    }
    return { capability: decision.capability, nodeId: scopeNode, targetId: pid, created: true, decision, extraErrors, next: mm => mm,
      apply: cc => cc.query(`INSERT INTO identity_providers(id, issuer, display_name, client_id, client_secret_env, scopes, scope_node_id, require_mfa, allowed_email_domains, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [pid, row.issuer, name, clientId, secretEnv, scopes, scopeNode, row.require_mfa, domains, req.principal]),
      detail: { issuer: row.issuer, scopeNodeId: scopeNode, requireMfa: row.require_mfa, allowedEmailDomains: domains, clientSecretEnv: secretEnv },
      result: providerView({ ...row, status: "active" }) };
  }));

  app.post("/mc/api/identity-providers/:id/status", ...change("set_identity_provider_status", "identity_provider", async (req, m, c) => {
    const { rows: [prov] } = await c.query("SELECT * FROM identity_providers WHERE id=$1", [req.params.id]);
    const status = req.body?.status, reason = text(req.body?.reason, 300, 3);
    if (!prov) throw new HttpError(404, "identity_provider_not_found");
    if (!["active", "suspended", "retired"].includes(status) || !reason) throw new HttpError(400, "status_and_reason_required");
    if (prov.status === "retired") throw new HttpError(409, "retired_is_final");
    if (prov.id === PRIMARY && status !== "active") throw new HttpError(409, "primary_provider_stays_active");
    const decision = identityDecision(m, req.principal, prov.scope_node_id);
    return { capability: decision.capability, nodeId: prov.scope_node_id, targetId: prov.id, decision, next: mm => mm,
      apply: async cc => {
        await cc.query("UPDATE identity_providers SET status=$2, status_reason=$3, status_changed_at=now() WHERE id=$1", [prov.id, status, reason]);
        // Stopping a provider ends every session it vouched for.
        if (status !== "active") await cc.query("DELETE FROM sessions WHERE principal_id IN (SELECT principal_id FROM operators WHERE idp_id=$1)", [prov.id]);
      },
      detail: { from: prov.status, to: status, reason }, result: { id: prov.id, status } };
  }));

  // ---- FED-04: invitations (provisioning) -----------------------------------
  app.post("/mc/api/invitations", ...change("invite", "invitation", async (req, m, c) => {
    const b = req.body || {};
    const node = m.nodes.find(n => n.id === b.nodeId), role = roleById.get(b.roleId), name = text(b.displayName, 200), appr = text(b.approvalReference, 300);
    const idpId = text(b.idpId, 40) || PRIMARY, to = b.effectiveTo === undefined ? null : date(b.effectiveTo);
    const days = Math.min(Math.max(Number(b.expiresInDays) || 7, 1), 30);
    if (!node || !role || !name || !appr || (b.effectiveTo !== undefined && !to)) throw new HttpError(400, "node_role_name_and_approval_required");
    const { rows: [prov] } = await c.query("SELECT * FROM identity_providers WHERE id=$1 AND status='active'", [idpId]);
    if (!prov) throw new HttpError(404, "identity_provider_not_found");
    const decision = assignDecision(m, req.principal, node, role);
    const iid = id("inv"), code = randomSecret(24);
    const extraErrors = withinNode(m.nodes, prov.scope_node_id, node.id) ? [] : [`invitations.${iid}: ${node.id} is outside what ${prov.id} may vouch for`];
    if (role.level !== node.kind) extraErrors.push(`invitations.${iid}: a ${role.level} role is given at a ${role.level}, not a ${node.kind}`);
    return { capability: decision.capability, nodeId: node.id, targetId: iid, created: true, decision, extraErrors, next: mm => mm,
      apply: cc => cc.query(`INSERT INTO invitations(id, code_hash, idp_id, node_id, role_id, display_name, effective_to, approval_reference, expires_at, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(days => $9), $10)`, [iid, sha256(code), prov.id, node.id, role.id, name, to, appr, days, req.principal]),
      detail: { role: role.id, idp: prov.id, displayName: name, approvalReference: appr, expiresInDays: days },
      // The code is shown once; only its hash is kept.
      result: { id: iid, code, signInUrl: `${cfg.publicOrigin}/mc/auth/login?idp=${encodeURIComponent(prov.id)}&invite=${encodeURIComponent(code)}`, expiresInDays: days } };
  }));
  app.get("/mc/api/invitations", ...read(async (req, m) => {
    const node = m.nodes.find(n => n.id === req.query.nodeId);
    if (!node) throw new HttpError(404, "node_not_found");
    if (!assignDecision(m, req.principal, node, roleById.get(catalog.role_definitions.find(r => r.level === node.kind)?.id)).allowed && !decideAt(m, req.principal, "audit.view", node.id).allowed) throw new HttpError(403, "not_authorized");
    const { rows } = await db.query(`SELECT id, idp_id, role_id, display_name, effective_to, approval_reference, expires_at, created_by, created_at, accepted_by, accepted_at, revoked_at
      FROM invitations WHERE node_id=$1 ORDER BY created_at DESC LIMIT 200`, [node.id]);
    return rows.map(r => ({ ...r, state: r.accepted_at ? "accepted" : r.revoked_at ? "revoked" : new Date(r.expires_at) < new Date() ? "expired" : "pending" }));
  }));
  app.post("/mc/api/invitations/:id/revoke", ...change("revoke_invitation", "invitation", async (req, m, c) => {
    const { rows: [inv] } = await c.query("SELECT * FROM invitations WHERE id=$1", [req.params.id]);
    const reason = text(req.body?.reason, 300, 3);
    if (!inv) throw new HttpError(404, "invitation_not_found");
    if (!reason) throw new HttpError(400, "reason_required");
    if (inv.accepted_at || inv.revoked_at) throw new HttpError(409, "invitation_closed");
    const node = m.nodes.find(n => n.id === inv.node_id);
    const decision = inv.created_by === req.principal ? { allowed: true, basis: { type: "inviter" } } : assignDecision(m, req.principal, node, roleById.get(inv.role_id));
    return { capability: decision.capability, nodeId: inv.node_id, targetId: inv.id, decision, next: mm => mm,
      apply: cc => cc.query("UPDATE invitations SET revoked_at=now(), revoked_reason=$2 WHERE id=$1", [inv.id, reason]),
      detail: { reason }, result: { id: inv.id, state: "revoked" } };
  }));

  // ---- FED-04: account lifecycle --------------------------------------------
  /**
   * May the actor manage this operator's account? Whoever manages identity for
   * the operator's provider scope, or whoever can give every role the operator
   * holds today. Anyone may disable their own account.
   */
  async function accountDecision(c, m, actor, op) {
    const { rows: [prov] } = await c.query("SELECT scope_node_id FROM identity_providers WHERE id=$1", [op.idp_id]);
    const viaIdentity = prov ? identityDecision(m, actor, prov.scope_node_id) : { allowed: false, reason: "unknown_provider" };
    if (viaIdentity.allowed) return viaIdentity;
    const held = m.role_assignments.filter(a => a.principal_id === op.principal_id && inForce(a, today()));
    const each = held.map(a => assignDecision(m, actor, m.nodes.find(n => n.id === a.node_id), roleById.get(a.role_id)));
    if (held.length && each.every(x => x.allowed)) return { allowed: true, capability: each[0].capability, basis: { type: "assigner_of_every_role", via: each.map(x => x.basis) } };
    return viaIdentity;
  }
  const lifecycle = (action, apply) => change(action, "operator", async (req, m, c) => {
    const { rows: [op] } = await c.query("SELECT o.*, p.scope_node_id FROM operators o LEFT JOIN identity_providers p ON p.id = o.idp_id WHERE o.principal_id=$1", [req.params.id]);
    const reason = text(req.body?.reason, 300, 3);
    if (!op) throw new HttpError(404, "operator_not_found");
    if (!reason) throw new HttpError(400, "reason_required");
    const self = op.principal_id === req.principal;
    if (self && action === "enable_operator") throw new HttpError(403, "cannot_enable_yourself");
    const decision = self && action !== "enable_operator" ? { allowed: true, capability: null, basis: { type: "self" } } : await accountDecision(c, m, req.principal, op);
    return { capability: decision.capability, nodeId: op.scope_node_id, targetId: op.principal_id, decision, next: mm => mm, apply: cc => apply(cc, op, reason), detail: { reason }, result: { principalId: op.principal_id, action } };
  });
  app.post("/mc/api/operators/:id/disable", ...lifecycle("disable_operator", async (c, op, reason) => {
    await c.query("UPDATE operators SET status='disabled', disabled_at=now(), disabled_reason=$2 WHERE principal_id=$1 AND status='active'", [op.principal_id, reason]);
    await c.query("DELETE FROM sessions WHERE principal_id=$1", [op.principal_id]);
  }));
  app.post("/mc/api/operators/:id/enable", ...lifecycle("enable_operator", (c, op) => c.query("UPDATE operators SET status='active', disabled_at=NULL, disabled_reason=NULL WHERE principal_id=$1", [op.principal_id])));
  app.post("/mc/api/operators/:id/sign-out", ...lifecycle("sign_out_everywhere", (c, op) => c.query("DELETE FROM sessions WHERE principal_id=$1", [op.principal_id])));

  // Accounts to review: those the actor manages, with roles in force and no
  // sign-in for `days` (default 90) or never.
  app.get("/mc/api/operators/review", ...read(async (req, m) => {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 3650);
    const { rows } = await db.query("SELECT principal_id, display_name, idp_id, status, last_sign_in_at, created_at FROM operators ORDER BY display_name");
    const out = [];
    for (const op of rows) {
      if (op.status !== "active") continue;
      const held = m.role_assignments.filter(a => a.principal_id === op.principal_id && inForce(a, today()));
      if (!held.length) continue;
      const last = op.last_sign_in_at ? new Date(op.last_sign_in_at) : null;
      if (last && Date.now() - last.getTime() < days * 86400000) continue;
      if (!(await accountDecision(db, m, req.principal, op)).allowed) continue;
      out.push({ principalId: op.principal_id, name: op.display_name, idp: op.idp_id, lastSignInAt: op.last_sign_in_at, createdAt: op.created_at,
        roles: held.map(a => ({ id: a.id, role: a.role_id, nodeId: a.node_id })) });
    }
    return { days, accounts: out };
  }));

  // ---- console -------------------------------------------------------------
  app.use("/mc", express.static(fileURLToPath(new URL("./console/", import.meta.url)), { index: "index.html", maxAge: 0 }));
  app.use((req, res) => res.status(404).json({ error: "not_found" }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { console.error("master control error:", err.message); res.status(err.status === 400 ? 400 : 500).json({ error: err.status === 400 ? "bad_request" : "server_error" }); });
  return app;
}

function ownerOf(m, d) {
  if (d.from_assignment_id) return m.role_assignments.find(a => a.id === d.from_assignment_id)?.principal_id;
  return m.delegations.find(x => x.id === d.from_delegation_id)?.delegate_principal_id;
}
