// FED-02: delegated authority, scoped roles, district autonomy, and policy
// inheritance for the education federation (platform → state education
// authority → district → school).
//
// A pure rule engine over the data contract in
// docs/architecture/federation/authority-model.schema.json. No I/O, no
// database; the running app doesn't call it yet (FED-03 wires it into Master
// Control). Every answer is deny-by-default and says why.
//
// Hard rules enforced here regardless of what a model's catalog says:
//  * Identifiable student data (capabilities marked "identifiable", and any
//    capability whose id starts with "student.records.") can only be held at
//    a district or school, only reaches inside that district's tenant, and
//    can only be delegated to someone whose home is in the same district.
//    No platform or state role ever reaches student records.
//  * District autonomy: tenant-administration capabilities ("tenant" reach)
//    stop at the district boundary. A state authority gets them only if the
//    district delegates them, for a stated purpose and period.
//  * District-reserved policies (e.g. the per-pupil storage quota) are set
//    only by the district; nobody above can set or lock them.
//  * A delegation never enlarges the delegator's authority; suspending or
//    revoking a link stops everything delegated through it from that date
//    without rewriting earlier dates.
//  * Athletics associations are a separate graph (registry-seed.*.json) and
//    are never nodes here.

export const LEVELS = ["platform", "state_education_authority", "district", "school"];
const PARENT_KIND = { platform: null, state_education_authority: "platform", district: "state_education_authority", school: "district" };
const STUDENT_DATA = ["none", "aggregate", "identifiable"];
const REACH = ["node", "descendants", "tenant"];
const LINK_STATUS = ["proposed", "active", "suspended", "revoked", "expired"];
const MAX_DELEGATION_DEPTH = 3;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isDate = v => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v));
// In force on a date: inside its inclusive effective period, and before any
// suspension or revocation date. A suspended, revoked or expired record still
// counts for dates before that happened, so asking about the past gives the
// answer that was true then; "proposed" never counts.
export function activeOn(rec, at) {
  if (!rec || !["active", "suspended", "revoked", "expired"].includes(rec.status)) return false;
  if (rec.effective_from && at < rec.effective_from) return false;
  if (rec.effective_to && at > rec.effective_to) return false;
  if (rec.revoked_on && at >= rec.revoked_on) return false;
  if (rec.suspended_on && at >= rec.suspended_on) return false;
  if (rec.status === "suspended" && !rec.suspended_on) return false;
  if (rec.status === "revoked" && !rec.revoked_on) return false;
  if (rec.status === "expired" && !rec.effective_to) return false;
  return true;
}
const isIdentifiable = cap => cap.student_data === "identifiable" || /^student\.records\./.test(cap.id);

function index(model) {
  const nodes = new Map((model.nodes || []).map(n => [n.id, n]));
  const caps = new Map((model.capabilities || []).map(c => [c.id, c]));
  const roles = new Map((model.role_definitions || []).map(r => [r.id, r]));
  const assignments = new Map((model.role_assignments || []).map(a => [a.id, a]));
  const delegations = new Map((model.delegations || []).map(d => [d.id, d]));
  const policies = new Map((model.policy_definitions || []).map(p => [p.id, p]));
  return { nodes, caps, roles, assignments, delegations, policies };
}

// Root-first chain of ancestors including the node itself; null if broken.
function lineage(ix, id) {
  const out = [], seen = new Set();
  for (let n = ix.nodes.get(id); n; n = n.parent_id ? ix.nodes.get(n.parent_id) : null) {
    if (seen.has(n.id)) return null;
    seen.add(n.id); out.unshift(n);
    if (n.parent_id && !ix.nodes.has(n.parent_id)) return null;
  }
  return out.length ? out : null;
}
const districtOf = (ix, id) => lineage(ix, id)?.find(n => n.kind === "district") || null;
const isWithin = (ix, ancestorId, id) => !!lineage(ix, id)?.some(n => n.id === ancestorId);

function inReach(ix, fromId, targetId, reach) {
  if (reach === "node") return fromId === targetId;
  if (!isWithin(ix, fromId, targetId)) return false;
  if (reach === "descendants") return true;
  // tenant: only from a district or school, and never outside that district.
  const d = districtOf(ix, fromId);
  return !!d && districtOf(ix, targetId)?.id === d.id;
}

/** Check a model's structure and invariants. Returns {ok, errors}. */
export function validateAuthorityModel(model) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  const ix = index(model);
  const uniq = (list, name) => {
    const seen = new Set();
    for (const r of list || []) { if (seen.has(r.id)) err(`${name}.${r.id}`, "duplicate id"); seen.add(r.id); }
  };
  ["nodes", "capabilities", "role_definitions", "role_assignments", "delegations", "policy_definitions", "policy_settings"].forEach(k => uniq(model[k], k));
  const dates = (path, r) => {
    if (r.effective_from !== undefined && !isDate(r.effective_from)) err(path, "effective_from must be an ISO date");
    if (r.effective_to !== undefined && !isDate(r.effective_to)) err(path, "effective_to must be an ISO date");
    if (r.revoked_on !== undefined && !isDate(r.revoked_on)) err(path, "revoked_on must be an ISO date");
    if (isDate(r.effective_from) && isDate(r.effective_to) && r.effective_to < r.effective_from) err(path, "effective_to is before effective_from");
    if (r.suspended_on !== undefined && !isDate(r.suspended_on)) err(path, "suspended_on must be an ISO date");
    if (r.status === "revoked" && !isDate(r.revoked_on)) err(path, "a revoked record needs revoked_on");
    if (r.status === "suspended" && !isDate(r.suspended_on)) err(path, "a suspended record needs suspended_on");
    if (r.status === "expired" && !isDate(r.effective_to)) err(path, "an expired record needs effective_to");
  };

  // Capabilities: the catalog can't loosen the hard rules.
  for (const c of model.capabilities || []) {
    const p = `capabilities.${c.id}`;
    if (!STUDENT_DATA.includes(c.student_data)) err(p, "student_data must be none, aggregate or identifiable");
    if (!REACH.includes(c.reach)) err(p, "reach must be node, descendants or tenant");
    if (!Array.isArray(c.assignable_levels) || !c.assignable_levels.length || c.assignable_levels.some(l => !LEVELS.includes(l))) err(p, "assignable_levels must list known levels");
    if (/^student\.records\./.test(c.id) && c.student_data !== "identifiable") err(p, "student.records.* capabilities are identifiable student data");
    if (isIdentifiable(c)) {
      if ((c.assignable_levels || []).some(l => l === "platform" || l === "state_education_authority")) err(p, "identifiable student data can't be held above a district");
      if (c.reach === "descendants") err(p, "identifiable student data can't reach beyond the district tenant");
    }
    if (c.district_reserved && JSON.stringify(c.assignable_levels) !== JSON.stringify(["district"])) err(p, "a district-reserved capability is held only at the district");
  }

  // Nodes: platform → state education authority → district → school.
  const roots = (model.nodes || []).filter(n => n.kind === "platform");
  if (model.nodes?.length && roots.length !== 1) err("nodes", "exactly one platform node is required");
  for (const n of model.nodes || []) {
    const p = `nodes.${n.id}`;
    if (!LEVELS.includes(n.kind)) { err(p, `kind must be one of ${LEVELS.join(", ")} (athletics associations are a separate graph)`); continue; }
    dates(p, n);
    const parent = n.parent_id ? ix.nodes.get(n.parent_id) : null;
    if (PARENT_KIND[n.kind] === null) { if (n.parent_id) err(p, "the platform has no parent"); }
    else if (!parent) err(p, "parent not found");
    else if (parent.kind !== PARENT_KIND[n.kind]) err(p, `a ${n.kind} sits under a ${PARENT_KIND[n.kind]}`);
    if (!lineage(ix, n.id)) err(p, "hierarchy has a cycle or a missing ancestor");
    if (n.kind !== "platform" && !/^US-[A-Z]{2}$/.test(n.jurisdiction_id || "")) err(p, "jurisdiction_id is required");
    if (parent && parent.kind !== "platform" && parent.jurisdiction_id !== n.jurisdiction_id) err(p, "must share its parent's jurisdiction");
    if ((n.kind === "district" || n.kind === "school") && !n.tenant_ref) err(p, "tenant_ref is required");
    if (n.kind === "school" && parent && n.tenant_ref !== parent.tenant_ref) err(p, "a school belongs to its district's tenant");
  }

  for (const r of model.role_definitions || []) {
    const p = `role_definitions.${r.id}`;
    if (!LEVELS.includes(r.level)) err(p, "level is unknown");
    if (!Array.isArray(r.capabilities) || !r.capabilities.length) err(p, "a role lists at least one capability");
    for (const cid of r.capabilities || []) {
      const c = ix.caps.get(cid);
      if (!c) err(p, `unknown capability ${cid}`);
      else if (!c.assignable_levels.includes(r.level)) err(p, `${cid} can't be held at ${r.level}`);
    }
  }

  for (const a of model.role_assignments || []) {
    const p = `role_assignments.${a.id}`;
    if (!LINK_STATUS.includes(a.status)) err(p, "status is unknown");
    dates(p, a);
    if (!a.principal_id) err(p, "principal_id is required");
    if (!a.approval_reference) err(p, "approval_reference is required");
    const r = ix.roles.get(a.role_id), n = ix.nodes.get(a.node_id);
    if (!r) err(p, "role not found");
    if (!n) err(p, "node not found");
    if (r && n && r.level !== n.kind) err(p, `a ${r.level} role is assigned at a ${r.level}, not a ${n.kind}`);
  }

  for (const d of model.delegations || []) {
    const p = `delegations.${d.id}`;
    if (!LINK_STATUS.includes(d.status)) err(p, "status is unknown");
    dates(p, d);
    if (!isDate(d.effective_to)) err(p, "a delegation needs an end date");
    if (!d.purpose) err(p, "purpose is required");
    if (!d.approval_reference) err(p, "approval_reference is required");
    if (!!d.from_assignment_id === !!d.from_delegation_id) err(p, "exactly one of from_assignment_id or from_delegation_id");
    if (d.from_assignment_id && !ix.assignments.has(d.from_assignment_id)) err(p, "source assignment not found");
    if (d.from_delegation_id && !ix.delegations.has(d.from_delegation_id)) err(p, "source delegation not found");
    if (!ix.nodes.has(d.node_id)) err(p, "node not found");
    if (!ix.nodes.has(d.delegate_home_node_id)) err(p, "delegate_home_node_id not found");
    if (!Array.isArray(d.capabilities) || !d.capabilities.length) err(p, "a delegation lists at least one capability");
    let depth = 0;
    for (let x = d, seen = new Set(); x?.from_delegation_id; x = ix.delegations.get(x.from_delegation_id)) {
      if (seen.has(x.id) || ++depth > MAX_DELEGATION_DEPTH) { err(p, `delegation chain is cyclic or deeper than ${MAX_DELEGATION_DEPTH}`); break; }
      seen.add(x.id);
    }
    for (const cid of d.capabilities || []) {
      const c = ix.caps.get(cid);
      if (!c) { err(p, `unknown capability ${cid}`); continue; }
      if (!c.delegable) err(p, `${cid} can't be delegated`);
      if (isIdentifiable(c) && ix.nodes.has(d.node_id) && districtOf(ix, d.delegate_home_node_id)?.id !== districtOf(ix, d.node_id)?.id)
        err(p, `${cid} is student data; it can only be delegated within the same district`);
      // No enlargement, judged on the day the delegation starts.
      if (ix.nodes.has(d.node_id) && isDate(d.effective_from) && !sourceCovers(ix, d, c, d.node_id, d.effective_from, 0))
        err(p, `the delegator doesn't hold ${cid} over ${d.node_id}`);
    }
  }

  for (const pd of model.policy_definitions || []) {
    const p = `policy_definitions.${pd.id}`;
    if (!["boolean", "integer", "enum", "string"].includes(pd.value_type)) err(p, "value_type is unknown");
    if (!["free", "restrict_only", "district_reserved"].includes(pd.mode)) err(p, "mode must be free, restrict_only or district_reserved");
    if (pd.mode === "restrict_only" && !["true", "false", "higher", "lower", "narrower"].includes(pd.stricter)) err(p, "restrict_only needs stricter: true, false, higher, lower or narrower");
    if (pd.mode === "restrict_only" && (pd.stricter === "higher" || pd.stricter === "lower") && pd.value_type !== "integer") err(p, "higher/lower is for integers");
    if (pd.mode === "restrict_only" && (pd.stricter === "true" || pd.stricter === "false") && pd.value_type !== "boolean") err(p, "true/false is for booleans");
    // FED-07: an enum whose allowed_values run from loosest to strictest.
    if (pd.mode === "restrict_only" && pd.stricter === "narrower" && pd.value_type !== "enum") err(p, "narrower is for enums (allowed_values from loosest to strictest)");
    if (pd.mode === "district_reserved" && (JSON.stringify(pd.settable_levels) !== JSON.stringify(["district"]) || (pd.lockable_levels || []).length))
      err(p, "a district-reserved policy is set only by the district and can't be locked");
    if (!Array.isArray(pd.settable_levels) || !pd.settable_levels.length || pd.settable_levels.some(l => !LEVELS.includes(l))) err(p, "settable_levels must list known levels");
    if ((pd.lockable_levels || []).some(l => !(pd.settable_levels || []).includes(l))) err(p, "lockable_levels must be settable levels");
    if (!valueOk(pd, pd.default)) err(p, "default doesn't fit the value type");
  }

  for (const s of model.policy_settings || []) {
    const p = `policy_settings.${s.id}`;
    const pd = ix.policies.get(s.policy_id), n = ix.nodes.get(s.node_id);
    if (!["active", "superseded", "withdrawn"].includes(s.status)) err(p, "status must be active, superseded or withdrawn");
    dates(p, s);
    if (!Number.isInteger(s.version) || s.version < 1) err(p, "version is a positive integer");
    if (!s.reason) err(p, "reason is required");
    if (!pd) { err(p, "policy not found"); continue; }
    if (!n) { err(p, "node not found"); continue; }
    if (!pd.settable_levels.includes(n.kind)) err(p, `${pd.id} can't be set at a ${n.kind}`);
    if (s.lock_descendants && !(pd.lockable_levels || []).includes(n.kind)) err(p, `${pd.id} can't be locked at a ${n.kind}`);
    if (!valueOk(pd, s.value)) err(p, "value doesn't fit the policy");
    const a = ix.assignments.get(s.set_by_assignment_id);
    if (!a) err(p, "set_by_assignment_id not found");
    else if (isDate(s.effective_from) && !authorizeIx(ix, { principal_id: a.principal_id, capability_id: "policy.set", node_id: s.node_id, at: s.effective_from }).allowed)
      err(p, "whoever set it couldn't set policy at that node");
  }
  return { ok: errors.length === 0, errors };
}

function valueOk(pd, v) {
  if (pd.value_type === "boolean") return typeof v === "boolean";
  if (pd.value_type === "integer") return Number.isInteger(v) && (pd.min === undefined || v >= pd.min) && (pd.max === undefined || v <= pd.max);
  if (pd.value_type === "enum") return Array.isArray(pd.allowed_values) && pd.allowed_values.includes(v);
  return typeof v === "string" && v.length <= 500;
}

// Does the delegator behind d hold capability c over nodeId on date at?
function sourceCovers(ix, d, c, nodeId, at, depth) {
  if (depth > MAX_DELEGATION_DEPTH) return false;
  if (d.from_assignment_id) {
    const a = ix.assignments.get(d.from_assignment_id);
    return !!a && assignmentGrants(ix, a, c, nodeId, at);
  }
  const parent = ix.delegations.get(d.from_delegation_id);
  return !!parent && parent.may_redelegate === true && delegationGrants(ix, parent, c, nodeId, at, depth + 1);
}

function assignmentGrants(ix, a, c, targetId, at) {
  const r = ix.roles.get(a.role_id), n = ix.nodes.get(a.node_id);
  if (!activeOn(a, at) || !r || r.status === "retired" || !n || !activeOn(n, at)) return false;
  if (r.level !== n.kind || !r.capabilities.includes(c.id) || !c.assignable_levels.includes(n.kind)) return false;
  if (isIdentifiable(c) && (n.kind === "platform" || n.kind === "state_education_authority")) return false;
  return inReach(ix, a.node_id, targetId, isIdentifiable(c) && c.reach === "descendants" ? "tenant" : c.reach);
}

function delegationGrants(ix, d, c, targetId, at, depth) {
  if (!activeOn(d, at) || !c.delegable || !d.capabilities.includes(c.id)) return false;
  const scopeNode = ix.nodes.get(d.node_id);
  if (!scopeNode || !activeOn(scopeNode, at)) return false;
  // Delegated reach never goes past what the capability allows from the
  // delegation's node, and student data never leaves the district.
  const reach = isIdentifiable(c) && c.reach === "descendants" ? "tenant" : c.reach;
  if (!inReach(ix, d.node_id, targetId, reach)) return false;
  if (isIdentifiable(c) && districtOf(ix, d.delegate_home_node_id)?.id !== districtOf(ix, targetId)?.id) return false;
  return sourceCovers(ix, d, c, d.node_id, at, depth);
}

function authorizeIx(ix, { principal_id, capability_id, node_id, at, purpose }) {
  const deny = reason => ({ allowed: false, reason });
  if (!principal_id) return deny("no_principal");
  if (!isDate(at)) return deny("invalid_date");
  const c = ix.caps.get(capability_id);
  if (!c) return deny("unknown_capability");
  const target = ix.nodes.get(node_id);
  if (!target || !lineage(ix, node_id)) return deny("unknown_node");
  if (!activeOn(target, at)) return deny("node_inactive");
  for (const a of ix.assignments.values()) {
    if (a.principal_id === principal_id && assignmentGrants(ix, a, c, node_id, at))
      return { allowed: true, basis: { type: "assignment", id: a.id, role_id: a.role_id, node_id: a.node_id }, studentData: c.student_data };
  }
  let purposeMismatch = false;
  for (const d of ix.delegations.values()) {
    if (d.delegate_principal_id !== principal_id || !delegationGrants(ix, d, c, node_id, at, 0)) continue;
    if (purpose !== undefined && purpose !== d.purpose) { purposeMismatch = true; continue; }
    const chain = [];
    for (let x = d; x; x = x.from_delegation_id ? ix.delegations.get(x.from_delegation_id) : null) chain.push(x.id);
    const root = ix.delegations.get(chain[chain.length - 1]);
    return { allowed: true, basis: { type: "delegation", id: d.id, chain, from_assignment_id: root.from_assignment_id, purpose: d.purpose }, studentData: c.student_data };
  }
  if (purposeMismatch) return deny("purpose_mismatch");
  if (isIdentifiable(c)) return deny("student_data_outside_tenant_or_role");
  return deny("no_grant");
}

/**
 * May this principal use this capability at this node on this date?
 * Returns {allowed, basis?, reason?}. Deny by default.
 */
export function authorize(model, request) { return authorizeIx(index(model), request || {}); }

/**
 * The effective value of a policy at a node on a date, walking down from the
 * platform. Returns {value, source, chain, conflicts}: chain lists each
 * setting applied; conflicts lists settings ignored and why.
 */
export function resolvePolicy(model, policyId, nodeId, at) {
  const ix = index(model);
  const pd = ix.policies.get(policyId);
  if (!pd) return { error: "unknown_policy" };
  const nodes = lineage(ix, nodeId);
  if (!nodes) return { error: "unknown_node" };
  if (!isDate(at)) return { error: "invalid_date" };
  let value = pd.default, source = "default", lockedBy = null, fromSetting = false;
  const chain = [], conflicts = [];
  for (const n of nodes) {
    if (!activeOn(n, at)) continue;
    const s = (model.policy_settings || [])
      .filter(x => x.policy_id === pd.id && x.node_id === n.id && activeOn(x, at))
      .sort((x, y) => y.version - x.version)[0];
    if (!s) continue;
    const reject = reason => conflicts.push({ setting_id: s.id, node_id: n.id, reason });
    if (!pd.settable_levels.includes(n.kind) || (pd.mode === "district_reserved" && n.kind !== "district")) { reject("not_settable_here"); continue; }
    if (!valueOk(pd, s.value)) { reject("invalid_value"); continue; }
    if (lockedBy) { reject(`locked_by:${lockedBy}`); continue; }
    if (pd.mode === "restrict_only" && fromSetting && !atLeastAsStrict(pd, s.value, value)) { reject("looser_than_inherited"); continue; }
    value = s.value; source = s.id; fromSetting = true;
    chain.push({ setting_id: s.id, node_id: n.id, value: s.value, version: s.version });
    if (s.lock_descendants && (pd.lockable_levels || []).includes(n.kind)) lockedBy = s.id;
  }
  return { value, source, chain, conflicts, lockedBy };
}

function atLeastAsStrict(pd, next, current) {
  switch (pd.stricter) {
    case "true": return next === true || current === false;
    case "false": return next === false || current === true;
    case "higher": return next >= current;
    case "lower": return next <= current;
    case "narrower": return pd.allowed_values.indexOf(next) >= pd.allowed_values.indexOf(current);
    default: return false;
  }
}
