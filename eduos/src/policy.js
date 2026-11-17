export const ROLE_PERMISSIONS = Object.freeze({
  superintendent: {
    access_requests: ["read", "create", "review"],
    students: ["read"], schools: ["read", "create", "update"],
    assignments: ["read", "create", "update", "approve", "grade"],
    attendance: ["read", "create", "update", "export"],
    cases: ["read", "create", "update", "approve", "export"],
    audit: ["read", "export"],
    flow_events: ["read"], webhooks: ["read", "manage"],
    apps: ["read", "manage", "report", "decide", "launch"], district: ["read", "manage"],
    branding: ["read", "manage"],
    transport: ["read", "manage"], christie: ["review", "author", "approve"], comms: ["read", "announce", "message", "moderate"],
    safety: ["read", "initiate", "lead"], pickup: ["read", "verify", "manage"],
    learning: ["read", "teach", "grade", "approve", "credential"], edal: ["verify", "checkpoint", "proof"],
    // 32.7.0: only a superintendent authorizes a DECN failover.
    eden: ["read", "manage", "authorize", "node"]
  },
  // 32.2.0: district IT administrator. Runs schools, accounts (not other
  // district roles), SIS imports, integrations, webhooks and the app catalog.
  // Holds no student-record permission: students, assignments, attendance and
  // cases routes all return 403.
  it_admin: {
    access_requests: ["read"],
    schools: ["read", "create", "update"],
    audit: ["read"],
    flow_events: ["read"], webhooks: ["read", "manage"],
    apps: ["read", "manage", "report", "decide", "launch"], district: ["read", "manage"],
    branding: ["read", "manage"],
    edal: ["verify", "checkpoint"],
    eden: ["read", "manage", "node"]
  },
  principal: {
    access_requests: ["read", "create"],
    students: ["read"], schools: ["read"],
    assignments: ["read", "create", "update", "grade"],
    attendance: ["read", "create", "update", "export"],
    cases: ["read", "create", "update", "approve", "export"],
    audit: ["read"],
    flow_events: ["read", "create"],
    apps: ["read", "request", "report", "share", "launch"],
    branding: ["read", "manage"], // own school only (enforced again by RLS)
    transport: ["read", "manage"], christie: ["review", "author", "approve"], comms: ["read", "announce", "message", "moderate"],
    safety: ["read", "initiate", "lead"], pickup: ["read", "verify", "manage"],
    learning: ["read", "teach", "grade", "approve", "credential"], edal: ["verify", "checkpoint", "proof"],
    eden: ["node"]
  },
  teacher: {
    access_requests: ["read", "create"],
    students: ["read"], schools: ["read"],
    assignments: ["read", "create", "update", "grade"],
    attendance: ["read", "create", "update"],
    cases: ["read", "create", "update"],
    flow_events: ["read", "create"],
    apps: ["read", "launch", "request"], branding: ["read"],
    transport: ["read"], christie: ["review", "author"], comms: ["read", "announce", "message"],
    safety: ["read", "initiate", "rollcall"], pickup: ["read", "verify"],
    learning: ["read", "teach", "grade"], edal: ["proof"]
  },
  parent: {
    access_requests: ["read", "create"],
    students: ["read"], assignments: ["read"],
    wallet: ["hold"], // 37.6.0: export and share their own child's credentials (Wallet)
    attendance: ["read", "acknowledge"], cases: ["read"],
    flow_events: ["read"], apps: ["launch"], branding: ["read"],
    transport: ["read"], comms: ["read", "message"],
    safety: ["read"], pickup: ["read", "request"],
    learning: ["read"], edal: ["proof"]
  },
  pupil: {
    access_requests: ["read", "create"],
    students: ["read"], assignments: ["read", "submit"],
    wallet: ["hold"], // 37.6.0: export and share their own credentials (Wallet)
    attendance: ["read"], cases: [],
    flow_events: ["read"], apps: ["launch"], branding: ["read"],
    christie: ["tutor"], comms: ["read"], transport: ["read"], safety: ["read"],
    learning: ["read", "learn"], edal: ["proof"]
  },
  // 32.4.0: school bus driver. Sees only the riders of routes assigned to them
  // (name, grade and stop) and records board/alight check-ins. No student
  // records, grades, attendance or cases; no location tracking of anyone.
  driver: {
    schools: ["read"], branding: ["read"], flow_events: ["read"],
    transport: ["read", "checkin"], comms: ["read", "message"], safety: ["read"]
  },
  // 35.3.0: School Resource Officer. Read-only incident visibility and
  // explicit SRO status updates; no student-record, attendance, pickup,
  // transport, discipline, or reunification-release permissions.
  sro: {
    schools: ["read"], branding: ["read"], safety: ["read", "sro_update"]
  },
  // 36.0.0: dedicated school librarian; library-only access.
  librarian: { schools: ["read"], branding: ["read"], library: ["read", "circulate", "manage"] },
  // 36.4.0 specialized school operations roles.
  // The registry lists only what the routes actually let a role do (2026-11-16
  // audit). Vice principals had cases, pickup, safety:initiate and
  // attendance:update here, and counselors cases, but no route served them:
  // case lists and writes, the pick-up desk and starting an alert are for
  // principals and teachers (and the superintendent), and the counselor works
  // the "counseling" operations queue. Granting any of these later means
  // changing the route and its row policies too, with tests.
  vice_principal: { schools:["read"], students:["read"], attendance:["read","create"], safety:["read"], transport:["read"], branding:["read"] },
  counselor: { schools:["read"] },
  nurse: { schools:["read"], health_office:["read","create","update"] },
  maintenance: { schools:["read"], facilities:["read","create","update"] },
  lunch_staff: { schools:["read"], meal_service:["read","create","update"] }
});

// District-level roles hold memberships without a school (school_id NULL).
export const DISTRICT_ROLES = Object.freeze(["superintendent", "it_admin"]);
export const isDistrictRole = role => DISTRICT_ROLES.includes(role);

export function canPerform(actor, resource, action) {
  if (!actor || !actor.role || !actor.districtId || !actor.userId) return false;
  return ROLE_PERMISSIONS[actor.role]?.[resource]?.includes(action) === true;
}

// Only permissions that an API route actually enforces may be requested or
// granted. (cases:approve/export, attendance:export, assignments:approve and
// schools:create had no routes and were removed in 32.0.53.)
export const GRANTABLE_PERMISSIONS = Object.freeze({
  "schools:update": true
});

export function isGrantable(resource, action) {
  return GRANTABLE_PERMISSIONS[`${resource}:${action}`] === true;
}

export function requirePermission(resource, action) {
  return async (req, res, next) => {
    if (!req.actor) return res.status(401).json({ error: "authentication_required" });
    if (canPerform(req.actor, resource, action)) { req.permissionSource = { via: "role" }; return next(); }
    try {
      const { withTenantTransaction } = await import("./db.js");
      const result = await withTenantTransaction(req.actor, client => client.query(
        `SELECT school_id FROM permission_grants
          WHERE district_id=$1 AND user_id=$2 AND resource=$3 AND action=$4
            AND starts_at<=now() AND expires_at>now() AND revoked_at IS NULL
            AND (school_id IS NULL OR school_id=$5)
          ORDER BY school_id NULLS FIRST LIMIT 1`,
        [req.actor.districtId, req.actor.userId, resource, action, req.actor.schoolId]
      ));
      if (result.rowCount) {
        // Routes must keep grant-based writes inside the grant's school.
        req.permissionSource = { via: "grant", schoolId: result.rows[0].school_id || null };
        return next();
      }
      return res.status(403).json({ error: "forbidden", resource, action });
    } catch (error) { next(error); }
  };
}

export function requireSchoolScope(req, res, next) {
  const requested = req.params.schoolId || req.query.schoolId;
  if (!requested) return next();
  if (isDistrictRole(req.actor.role)) return next();
  if (req.actor.schoolId && req.actor.schoolId === requested) return next();
  return res.status(403).json({ error: "school_scope_denied" });
}
