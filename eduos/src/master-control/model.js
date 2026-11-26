// Builds the FED-02 authority model from Master Control's tables plus the
// shipped catalog, and answers questions with the FED-02 engine.
import { readFileSync } from "node:fs";
import { authorize, validateAuthorityModel, resolvePolicy } from "../federation/authority.js";

export const catalog = JSON.parse(readFileSync(new URL("../federation/authority-catalog.json", import.meta.url), "utf8"));
export const today = () => new Date().toISOString().slice(0, 10);
const d = v => v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : undefined;
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

export async function loadModel(c) {
  const [nodes, assignments, delegations, settings] = await Promise.all([
    c.query("SELECT * FROM nodes ORDER BY id"), c.query("SELECT * FROM role_assignments ORDER BY id"),
    c.query("SELECT * FROM delegations ORDER BY id"), c.query("SELECT * FROM policy_settings ORDER BY id")]);
  return {
    model_version: catalog.model_version, as_of: today(),
    capabilities: catalog.capabilities, role_definitions: catalog.role_definitions, policy_definitions: catalog.policy_definitions,
    nodes: nodes.rows.map(n => clean({ id: n.id, kind: n.kind, parent_id: n.parent_id, jurisdiction_id: n.jurisdiction_id, tenant_ref: n.tenant_ref,
      name: n.name, status: n.status, effective_from: d(n.effective_from), effective_to: d(n.effective_to), revoked_on: d(n.revoked_on), suspended_on: d(n.suspended_on) })),
    role_assignments: assignments.rows.map(a => clean({ id: a.id, principal_id: a.principal_id, role_id: a.role_id, node_id: a.node_id, status: a.status,
      effective_from: d(a.effective_from), effective_to: d(a.effective_to), revoked_on: d(a.revoked_on), suspended_on: d(a.suspended_on), approval_reference: a.approval_reference })),
    delegations: delegations.rows.map(x => clean({ id: x.id, from_assignment_id: x.from_assignment_id, from_delegation_id: x.from_delegation_id,
      delegate_principal_id: x.delegate_principal_id, delegate_home_node_id: x.delegate_home_node_id, node_id: x.node_id, capabilities: x.capabilities,
      purpose: x.purpose, may_redelegate: x.may_redelegate, status: x.status, effective_from: d(x.effective_from), effective_to: d(x.effective_to),
      revoked_on: d(x.revoked_on), suspended_on: d(x.suspended_on), approval_reference: x.approval_reference })),
    policy_settings: settings.rows.map(s => clean({ id: s.id, policy_id: s.policy_id, node_id: s.node_id, value: s.value, lock_descendants: s.lock_descendants,
      version: s.version, status: s.status, effective_from: d(s.effective_from), effective_to: d(s.effective_to), set_by_assignment_id: s.set_by_assignment_id, reason: s.reason })),
  };
}

export { authorize, validateAuthorityModel, resolvePolicy };

/** Node ids related (self, ancestor or descendant) to where the principal holds a role or a delegation today. */
export function visibleNodes(model, principal, at = today()) {
  const byId = new Map(model.nodes.map(n => [n.id, n]));
  const up = id => { const out = []; for (let n = byId.get(id); n; n = n.parent_id ? byId.get(n.parent_id) : null) out.push(n.id); return out; };
  const anchors = [
    ...model.role_assignments.filter(a => a.principal_id === principal && inForce(a, at)).map(a => a.node_id),
    ...model.delegations.filter(x => x.delegate_principal_id === principal && inForce(x, at)).map(x => x.node_id)];
  const seen = new Set();
  for (const a of anchors) {
    for (const id of up(a)) seen.add(id);
    for (const n of model.nodes) if (up(n.id).includes(a)) seen.add(n.id);
  }
  return seen;
}
export const inForce = (r, at) => r.status === "active" && (!r.effective_from || r.effective_from <= at) && (!r.effective_to || r.effective_to >= at)
  && (!r.revoked_on || r.revoked_on > at) && (!r.suspended_on || r.suspended_on > at);
