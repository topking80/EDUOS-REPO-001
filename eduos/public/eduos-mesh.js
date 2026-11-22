// EduOS 32.3.0 (school branding hooks via eduos-branding.js) / 32.2.0: role home dashboards, the app launcher, the district app
// catalog (licenses, assignments, sharing, usage), app requests and district
// settings. api-bridge.js loads this module and calls it; every request goes
// through the bridge's API.request (same-origin, CSRF, session expiry) and
// every rendered value is escaped.
(() => {
  "use strict";
  const DISTRICT = ["superintendent", "it_admin"];
  const ROLE_NAME = { superintendent: "Superintendent", it_admin: "IT administrator", principal: "Principal", teacher: "Teacher", parent: "Parent or guardian", pupil: "Student" };
  const SCOPE_TEXT = { none: "No student data", identity: "Name and email", roster_basic: "Name, email and school", roster_full: "Full roster", grades: "Grades", attendance: "Attendance" };
  const DPA_TEXT = { none: "No agreement", pending: "Agreement pending", signed: "Agreement signed", sdpc_signed: "SDPC agreement signed" };
  const TYPE_TEXT = { link: "Web link", oidc_sso: "Single sign-on", lti13: "LTI 1.3", api: "API integration" };
  const GRADES = ["PK", "TK", "K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
  const ASSIGN_ROLES = [["principal", "Principals"], ["teacher", "Teachers"], ["parent", "Families"], ["pupil", "Students"], ["superintendent", "Superintendents"], ["it_admin", "IT admins"]];
  const st = { schools: [], home: null, myApps: [], learner: null, catalog: [], catalogPage: null, usage: [], usageScope: null, appUsage: null, requests: [], settings: null, open: null, q: "" };

  // Tab lists per role, Home first. Labels use plain words for each audience.
  function tabsFor(role, can) {
    const t = {
      superintendent: [["home", "Home"], ["students", "Students"], ["assignments", "Assignments"], ["attendance", "Attendance"], ["cases", "Support cases"], ["apps", "Apps"], ["app_requests", "App requests"], ["admin", "Administration"], ["rosters", "Rosters"], ["guardians", "Guardian invitations"], ["access_requests", "Access requests"], ["audit", "Audit"], ["sis", "SIS import"], ["webhooks", "Webhooks"], ["branding", "School branding"], ["district", "District settings"]],
      it_admin: [["home", "Home"], ["apps", "Apps"], ["app_requests", "App requests"], ["admin", "Administration"], ["sis", "SIS import"], ["webhooks", "Webhooks"], ["audit", "Audit"], ["branding", "School branding"], ["district", "District settings"]],
      principal: [["home", "Home"], ["students", "Students"], ["assignments", "Assignments"], ["attendance", "Attendance"], ["cases", "Support cases"], ["apps", "Apps"], ["app_requests", "App requests"], ["admin", "People"], ["rosters", "Rosters"], ["guardians", "Guardian invitations"], ["access_requests", "Access requests"], ["audit", "Audit"], ["branding", "School branding"]],
      teacher: [["home", "Home"], ["apps", "My apps"], ["students", "My students"], ["assignments", "Assignments"], ["attendance", "Attendance"], ["cases", "Support cases"], ["app_requests", "App requests"], ["access_requests", "Access requests"]],
      parent: [["home", "Home"], ["apps", "Apps"], ["assignments", "Schoolwork"], ["attendance", "Attendance"], ["cases", "Support plans"], ["guardians", "Link a child"]],
      pupil: [["home", "Home"], ["apps", "My apps"], ["assignments", "My work"], ["attendance", "Attendance"]]
    }[role] || [["home", "Home"]];
    const list = t.slice();
    if (role === "principal" && can.sisGrant) list.splice(list.length - 1, 0, ["sis", "SIS import"]);
    if (role === "teacher" && can.sisGrant) list.push(["sis", "SIS import"]);
    return list;
  }
  const TABS = ["home", "apps", "app_requests", "district", "branding"];
  const B = () => window.EduOSBranding;

  async function load(tab, ctx) {
    const { API } = ctx, role = API.actor?.role;
    const safe = async (key, fn) => { try { await fn(); delete ctx.data.errors[key]; } catch (e) { ctx.data.errors[key] = e.message; } };
    if (tab === "home") {
      await safe("home", async () => { st.home = (await API.request("/api/home")).data; });
      if (role !== "it_admin") await safe("myApps", async () => { const r = await API.request("/api/my/apps"); st.myApps = r.data || []; st.learner = r.learner; });
    }
    if (tab === "apps") {
      await safe("myApps", async () => { const r = await API.request("/api/my/apps"); st.myApps = r.data || []; st.learner = r.learner; });
      if ([...DISTRICT, "principal", "teacher"].includes(role)) await loadCatalog(ctx, 0);
      if (role === "principal") await safe("schools", async () => { st.schools = (await API.request("/api/schools/directory")).data || []; });
      if ([...DISTRICT, "principal"].includes(role)) await safe("usage", async () => { const r = await API.request("/api/apps-usage"); st.usage = r.data || []; st.usageScope = r.scope; });
    }
    if (tab === "app_requests") {
      await safe("requests", async () => { st.requests = (await API.request("/api/app-requests")).data || []; });
      if (!st.catalog.length) await loadCatalog(ctx, 0);
    }
    if (tab === "district") await safe("settings", async () => { st.settings = (await API.request("/api/district/settings")).data; });
    if (tab === "branding" && B()) await safe("branding", () => B().load(ctx));
  }
  async function loadCatalog(ctx, offset) {
    try {
      const r = await ctx.API.request(`/api/apps?limit=100&offset=${offset}${st.q ? `&q=${encodeURIComponent(st.q)}` : ""}`);
      st.catalog = offset ? st.catalog.concat(r.data || []) : (r.data || []); st.catalogPage = r.page; delete ctx.data.errors.catalog;
    } catch (e) { ctx.data.errors.catalog = e.message; }
  }

  const card = (n, label, tab, tone = "") => `<div class="api-card api-stat ${tone}"><b>${Number(n ?? 0).toLocaleString()}</b><div>${label}</div>${tab ? `<button type="button" class="api-link" data-tab="${tab}">Open</button>` : ""}</div>`;
  const plural = (n, one, many) => `${Number(n || 0).toLocaleString()} ${Number(n) === 1 ? one : many}`;
  function nextSteps(items) {
    const list = items.filter(Boolean);
    return list.length ? `<div class="api-card api-next"><h3>What needs attention</h3><ul>${list.map(([text, tab]) => `<li>${text}${tab ? ` <button type="button" class="api-link" data-tab="${tab}">Go</button>` : ""}</li>`).join("")}</ul></div>`
      : `<div class="api-card api-next"><h3>What needs attention</h3><p class="api-empty">You're all caught up.</p></div>`;
  }
  function launcher(ctx, { young = false, limit = 0 } = {}) {
    const { esc } = ctx;
    const apps = limit ? st.myApps.slice(0, limit) : st.myApps;
    if (!apps.length) return `<p class="api-empty">${young ? "No apps yet. Ask your teacher." : "No apps have been made available to you yet. Your school or district adds them here."}</p>`;
    if (B()) return `<ul class="api-launcher${young ? " young" : ""}" aria-label="Apps you can open">${apps.map((a, i) => B().appTile(a, i, { young })).join("")}</ul>`;
    return `<ul class="api-launcher${young ? " young" : ""}" aria-label="Apps you can open">${apps.map(a => `<li><button type="button" class="api-tile" data-action="app-launch" data-id="${esc(a.id)}" data-name="${esc(a.name)}">
      <span class="sr-only">Open </span><span class="api-tile-icon" aria-hidden="true">${esc((a.name || "?").trim().charAt(0).toUpperCase())}</span><span class="api-tile-name">${esc(a.name)}</span>${young ? "" : `<span class="api-tile-meta">${esc(a.category || a.vendor || "")}</span>`}</button></li>`).join("")}</ul>`;
  }

  function renderHome(ctx) {
    const { API, esc } = ctx, role = API.actor?.role, h = st.home;
    const young = role === "pupil" && h?.youngLearner;
    const brandTop = B() && !young ? B().homeBanner(ctx) + (["principal", "teacher", "parent", "pupil"].includes(role) ? B().shortcuts(role, tabsFor(role, {})) : "") : "";
    const who = brandTop + `<p class="api-lede">Signed in as <b>${esc(API.actor?.displayName || "")}</b> · ${esc(ROLE_NAME[role] || role)}${h?.school_name ? ` at ${esc(h.school_name)}` : ""}.</p>`;
    if (!h) return who + `<p class="api-empty">Your home summary could not be loaded. <button type="button" data-action="retry-load">Try again</button></p>`;
    if (role === "superintendent") return who + `<div class="api-grid">${card(h.schools, "Schools", "admin")}${card(h.students, "Students", "students")}${card(h.people, "People", "admin")}${card(h.apps, "Apps in the district catalog", "apps")}${card(h.launches_30d, "App launches in the last 30 days", "apps")}${card(h.absences_7d, "Absences in the last 7 days", "attendance")}</div>`
      + nextSteps([h.pending_access_requests && [`${plural(h.pending_access_requests, "access request", "access requests")} waiting for review.`, "access_requests"],
        h.pending_app_requests && [`${plural(h.pending_app_requests, "app request", "app requests")} from schools.`, "app_requests"],
        h.urgent_cases && [`${plural(h.urgent_cases, "support case is", "support cases are")} marked high or urgent.`, "cases"]]);
    if (role === "it_admin") return who + `<div class="api-grid">${card(h.schools, "Schools", "admin")}${card(h.people, "Accounts", "admin")}${card(h.apps, "Active apps", "apps")}${card(h.active_webhooks, "Active webhooks", "webhooks")}${card(h.sis_runs_7d, "SIS imports this week", "sis")}</div>`
      + `<div class="api-card"><h3>Integrations</h3><ul class="api-health"><li class="${h.integrations?.webhooksEnabled ? "ok" : "warn"}">Webhooks: ${h.integrations?.webhooksEnabled ? "enabled" : "turned off (no signing key is set)"}</li><li class="${h.integrations?.ltiEnabled ? "ok" : "warn"}">LTI 1.3 launches: ${h.integrations?.ltiEnabled ? "enabled" : "turned off (no platform key is set)"}</li><li class="${h.sis_failures_7d ? "warn" : "ok"}">SIS imports: ${h.sis_failures_7d ? `${plural(h.sis_failures_7d, "failed run", "failed runs")} this week` : "no failures this week"}</li></ul></div>`
      + nextSteps([h.pending_app_requests && [`${plural(h.pending_app_requests, "app request", "app requests")} waiting for a decision.`, "app_requests"],
        h.licenses_expiring_60d && [`${plural(h.licenses_expiring_60d, "license ends", "licenses end")} in the next 60 days.`, "apps"],
        h.apps_missing_dpa && [`${plural(h.apps_missing_dpa, "app shares", "apps share")} student data without a current data privacy agreement. Students can't open these.`, "apps"],
        h.disabled_webhooks && [`${plural(h.disabled_webhooks, "webhook was", "webhooks were")} turned off after repeated failures.`, "webhooks"]]);
    if (role === "principal") return who + `<div class="api-grid">${card(h.students, "Students", "students")}${card(h.teachers, "Teachers", "admin")}${card(h.absent_today, "Absent today", "attendance", h.absent_today ? "warn" : "")}${card(h.open_cases, "Open support cases", "cases")}${card(h.apps_available, "Apps available to your school", "apps")}</div>`
      + nextSteps([h.overdue_follow_ups && [`${plural(h.overdue_follow_ups, "support case follow-up is", "support case follow-ups are")} overdue.`, "cases"],
        h.pending_invitations && [`${plural(h.pending_invitations, "guardian invitation hasn't", "guardian invitations haven't")} been accepted yet.`, "guardians"],
        h.pending_app_requests && [`${plural(h.pending_app_requests, "app request is", "app requests are")} waiting for the district.`, "app_requests"]])
      + `<div class="api-card"><h3>Your apps</h3>${launcher(ctx, { limit: 8 })}</div>`;
    if (role === "teacher") return who + `<div class="api-grid">${card(h.students, "Students on your roster", "students")}${card(h.open_assignments, "Published assignments", "assignments")}${card(h.to_grade, "Submissions to grade", "assignments", h.to_grade ? "warn" : "")}${card(h.absences_7d, "Absences this week", "attendance")}</div>`
      + nextSteps([h.to_grade && [`${plural(h.to_grade, "submission is", "submissions are")} waiting for a grade.`, "assignments"],
        h.draft_assignments && [`${plural(h.draft_assignments, "draft assignment hasn't", "draft assignments haven't")} been published.`, "assignments"],
        h.my_open_cases && [`You have ${plural(h.my_open_cases, "open support case", "open support cases")}.`, "cases"]])
      + `<div class="api-card"><h3>Your apps</h3>${launcher(ctx, { limit: 8 })}</div>`;
    if (role === "parent") {
      const kids = h.children || [];
      return who + (kids.length ? `<div class="api-family">${kids.map(k => `<article class="api-card api-child" aria-labelledby="child-${esc(k.id)}"><h3 id="child-${esc(k.id)}">${esc(k.display_name)}</h3><p class="api-muted">Grade ${esc(k.grade_level || "not set")} · ${esc(k.school_name)}</p>
        <ul class="api-child-facts"><li><b>${k.due_7d}</b> due this week</li><li class="${k.overdue ? "warn" : ""}"><b>${k.overdue}</b> past due</li><li><b>${k.recently_graded}</b> recently graded</li><li class="${k.absences_30d ? "warn" : ""}"><b>${k.absences_30d}</b> absences (30 days)</li></ul>
        ${k.to_acknowledge ? `<p class="api-notice">${plural(k.to_acknowledge, "attendance note needs", "attendance notes need")} your acknowledgment. <button type="button" class="api-link" data-tab="attendance">Review</button></p>` : ""}
        ${k.shared_plans ? `<p class="api-notice info">The school has shared ${plural(k.shared_plans, "support plan", "support plans")} with you. <button type="button" class="api-link" data-tab="cases">View</button></p>` : ""}
        <div class="api-row"><button type="button" data-tab="assignments">Schoolwork</button><button type="button" data-tab="attendance">Attendance</button></div></article>`).join("")}</div>`
        : `<div class="api-card"><h3>Link your child</h3><p>Your account isn't linked to a student yet. Your school sends a one-time invitation link. Open it while signed in, or paste the code.</p><button type="button" class="primary" data-tab="guardians">Link a child</button></div>`)
        + `<div class="api-card"><h3>Apps</h3>${launcher(ctx, { limit: 8 })}</div>`;
    }
    if (role === "pupil") {
      const me = (h.children || [])[0];
      const first = me ? String(me.display_name).split(" ")[0] : "";
      if (h.youngLearner && B()) return `<div class="api-young">${B().homeBanner(ctx, { young: true, firstName: first })}
        ${B().shortcuts(role, [["assignments"], ["attendance"]], { young: true })}${me?.due_7d ? `<p class="api-notice info">You have <b>${me.due_7d}</b> thing${me.due_7d === 1 ? "" : "s"} to do this week.</p>` : ""}
        <h3>My apps</h3>${launcher(ctx, { young: true })}</div>`;
      if (h.youngLearner) return `<div class="api-young"><h2 class="api-hello">Hi${first ? `, ${esc(first)}` : ""}!</h2>
        <div class="api-big-row"><button type="button" class="api-big" data-tab="assignments"><span aria-hidden="true">✏️</span>My work${me?.due_7d ? ` <span class="api-badge">${me.due_7d}</span>` : ""}</button></div>
        <h3>My apps</h3>${launcher(ctx, { young: true })}</div>`;
      return who + `<div class="api-grid">${card(me?.due_7d, "Due in the next 7 days", "assignments")}${card(me?.overdue, "Past due", "assignments", me?.overdue ? "warn" : "")}${card(me?.recently_graded, "Recently graded", "assignments")}</div>`
        + `<div class="api-card"><h3>My apps</h3>${launcher(ctx)}</div>`;
    }
    return who;
  }

  function badges(a, esc) {
    const out = [`<span class="api-badge ${a.dataSharingScope === "none" ? "ok" : ""}">${esc(SCOPE_TEXT[a.dataSharingScope] || a.dataSharingScope)}</span>`];
    if (a.dataSharingScope !== "none") out.push(`<span class="api-badge ${["signed", "sdpc_signed"].includes(a.dpaStatus) ? "ok" : "warn"}">${esc(DPA_TEXT[a.dpaStatus] || a.dpaStatus)}${a.dpaExpiresOn ? ` until ${esc(a.dpaExpiresOn)}` : ""}</span>`);
    out.push(`<span class="api-badge ${a.coppaCompliant ? "ok" : "warn"}">${a.coppaCompliant ? "COPPA: OK for under 13" : "COPPA: not for under 13"}</span>`);
    if (a.ferpaSchoolOfficial) out.push(`<span class="api-badge ok">FERPA school official</span>`);
    return out.join(" ");
  }
  function licenseText(a) {
    const live = (a.licenses || []).filter(l => l.status === "active");
    if (!live.length) return "Not licensed";
    return live.map(l => `${l.seatLimit === null ? "Unlimited seats" : `${Number(l.seatLimit).toLocaleString()} seats`}${l.endsOn ? ` · ends ${l.endsOn}` : ""}${l.purchasedBySchoolId ? " · school purchase" : ""}`).join("; ");
  }
  function assignedText(a) {
    if (!a.assignments?.length) return "Not assigned";
    return a.assignments.map(x => `${x.scope === "district" ? "Whole district" : (x.schoolName || "A school")}${x.gradeLevels ? ` (grades ${x.gradeLevels.join(", ")})` : ""}${x.sharedBySchoolId ? " · shared" : ""}`).join("; ");
  }
  function appForm(ctx, isDistrict) {
    const { data } = ctx;
    const schools = data.schools.map(s => `<option value="${ctx.esc(s.id)}">${ctx.esc(s.name)}</option>`).join("");
    return `<details class="api-card"><summary><b>${isDistrict ? "Add an app to the district catalog" : "Add an app your school bought"}</b></summary>
      <form data-form="app-create" class="api-form-grid">
        <label>App name<input name="name" required maxlength="160"></label>
        <label>Vendor<input name="vendor" required maxlength="160"></label>
        <label class="wide">Launch address (URL)<input name="launchUrl" type="url" required placeholder="https://"></label>
        <label>Category<input name="category" maxlength="60" placeholder="Reading, Math…"></label>
        <label>How it connects<select name="integrationType"><option value="link">Web link</option><option value="oidc_sso">Single sign-on (the app signs in with the district identity provider)</option><option value="lti13">LTI 1.3</option><option value="api">API integration</option></select></label>
        <label>Student data the app receives<select name="dataSharingScope">${Object.entries(SCOPE_TEXT).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label>Data privacy agreement<select name="dpaStatus">${Object.entries(DPA_TEXT).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label>Agreement ends<input name="dpaExpiresOn" type="date"></label>
        ${isDistrict ? `<label>Owner<select name="ownerSchoolId"><option value="">District</option>${schools}</select></label>` : ""}
        <fieldset class="wide"><legend>Compliance</legend><label class="api-check"><input type="checkbox" name="coppaCompliant"> COPPA: suitable for students under 13</label><label class="api-check"><input type="checkbox" name="ferpaSchoolOfficial"> FERPA: the vendor acts as a school official</label></fieldset>
        <fieldset class="wide api-lti"><legend>LTI 1.3 tool registration (only for LTI 1.3)</legend>
          <label>Client ID<input name="ltiClientId" maxlength="200"></label><label>Deployment ID<input name="ltiDeploymentId" maxlength="200"></label>
          <label class="wide">Tool login URL<input name="ltiLoginUrl" type="url"></label><label class="wide">Redirect URL<input name="ltiRedirectUri" type="url"></label>
          <label class="wide">Target link URL (where the tool opens; blank means the launch address)<input name="ltiTargetLinkUri" type="url"></label>
          <p class="wide">A new LTI tool stays off until a different district administrator approves it. Changing its settings or student data needs approval again.</p></fieldset>
        <label class="wide">Description<textarea name="description" maxlength="2000" rows="2"></textarea></label>
        <div class="wide"><button class="primary" type="submit">Add app</button></div>
      </form></details>`;
  }
  const LTI_STATUS = { pending: ["warn", "Waiting for district approval"], approved: ["ok", "Approved"], revoked: ["warn", "Turned off"] };
  function ltiSection(ctx, a, isDistrict) {
    const { esc } = ctx, [cls, label] = LTI_STATUS[a.registrationStatus] || ["warn", a.registrationStatus];
    return `<section><h4>LTI registration</h4><p><span class="api-badge ${cls}">${esc(label)}</span></p>
      ${a.registrationStatus === "approved" ? "<p>People given access can open this tool.</p>" : "<p>Nobody can open this tool until it is approved. Approval must come from a different district administrator than the person who registered it.</p>"}
      ${isDistrict ? `<p>${a.registrationStatus !== "approved" ? `<button type="button" data-action="lti-approve" data-id="${esc(a.id)}">Approve this registration</button> ` : ""}${a.registrationStatus !== "revoked" ? `<button type="button" class="danger" data-action="lti-revoke" data-id="${esc(a.id)}">Turn off now</button>` : ""}</p>` : ""}</section>`;
  }
  function manager(ctx, a) {
    const { esc, data } = ctx, role = ctx.API.actor?.role, isDistrict = DISTRICT.includes(role);
    const schools = isDistrict ? data.schools.filter(s => s.status !== "inactive") : st.schools;
    const u = st.appUsage && st.appUsage.appId === a.id ? st.appUsage : null;
    return `<tr class="api-manage"><td colspan="5"><div class="api-manage-grid">
      <section><h4>Licenses</h4><ul>${(a.licenses || []).map(l => `<li>${l.seatLimit === null ? "Unlimited seats" : `${l.seatLimit} seats`} · ${esc(l.startsOn)} to ${esc(l.endsOn || "no end date")} · ${esc(l.status)} ${l.status === "active" ? `<button type="button" class="api-link" data-action="license-cancel" data-app="${esc(a.id)}" data-id="${esc(l.id)}">Cancel</button>` : ""}</li>`).join("") || "<li>None yet</li>"}</ul>
        <form data-form="license-add" data-app="${esc(a.id)}" class="api-inline-form"><label>Seats (blank for unlimited)<input name="seatLimit" type="number" min="1"></label><label>Starts<input name="startsOn" type="date"></label><label>Ends<input name="endsOn" type="date"></label><button type="submit">Add license</button></form></section>
      <section><h4>Who can use it</h4><ul>${(a.assignments || []).map(x => `<li>${x.scope === "district" ? "Whole district" : esc(x.schoolName || x.schoolId)}${x.gradeLevels ? ` · grades ${esc(x.gradeLevels.join(", "))}` : ""} · ${esc(x.roles.map(r => (ASSIGN_ROLES.find(y => y[0] === r) || [r, r])[1]).join(", "))} <button type="button" class="api-link" data-action="assignment-revoke" data-app="${esc(a.id)}" data-id="${esc(x.id)}">Remove</button></li>`).join("") || "<li>Nobody yet</li>"}</ul>
        <form data-form="assign-add" data-app="${esc(a.id)}">
          <label>Give access to<select name="target">${isDistrict ? `<option value="district">The whole district</option>` : ""}${schools.map(s => `<option value="${esc(s.id)}">${esc(s.name)}${!isDistrict && s.id !== ctx.API.actor.schoolId ? " (share)" : ""}</option>`).join("")}</select></label>
          <fieldset><legend>Roles</legend>${ASSIGN_ROLES.slice(0, 4).map(([k, v]) => `<label class="api-check"><input type="checkbox" name="roles" value="${k}" checked> ${v}</label>`).join("")}</fieldset>
          <fieldset><legend>Grades (none checked means all grades)</legend><div class="api-grades">${GRADES.map(g => `<label class="api-check"><input type="checkbox" name="grades" value="${g}"> ${g}</label>`).join("")}</div></fieldset>
          <button type="submit">Give access</button></form></section>
      ${a.integrationType === "lti13" ? ltiSection(ctx, a, isDistrict) : ""}
      <section><h4>Usage</h4>${u ? `<p>${u.unlimited ? "Unlimited seats" : `${u.seatsUsed} of ${u.seatsLicensed} seats used`} · ${plural(u.launches, "launch", "launches")}${u.scope === "my_school" ? " (your school only)" : ""}</p><table class="api-table"><caption class="sr-only">Usage by school</caption><thead><tr><th scope="col">School</th><th scope="col">Seats</th><th scope="col">Launches (30 days)</th></tr></thead><tbody>${u.bySchool.map(x => `<tr><td>${esc(x.schoolName || "District staff")}</td><td>${x.seatsUsed}</td><td>${x.launches30d}</td></tr>`).join("")}</tbody></table>` : `<button type="button" data-action="app-usage" data-id="${esc(a.id)}">Show usage</button>`}
        <p><button type="button" class="danger" data-action="app-retire" data-id="${esc(a.id)}">Retire this app</button></p></section>
    </div></td></tr>`;
  }
  function renderApps(ctx) {
    const { API, esc } = ctx, role = API.actor?.role, isDistrict = DISTRICT.includes(role);
    const young = role === "pupil" && st.learner?.youngLearner;
    // District staff usually manage apps rather than use them: skip an empty launcher.
    let html = isDistrict && !st.myApps.length ? "" : `<div class="api-card"><h3>${role === "pupil" ? "My apps" : "Apps you can open"}</h3>${young ? "" : `<p class="api-muted">Opening an app is recorded. Each app only receives the information listed in its data-sharing setting.</p>`}${launcher(ctx, { young })}</div>`;
    if (!["superintendent", "it_admin", "principal", "teacher"].includes(role)) return html;
    if (isDistrict || role === "principal") html += appForm(ctx, isDistrict);
    const rows = st.catalog.map(a => `<tr><th scope="row">${esc(a.name)}<br><small>${esc(a.vendor)} · ${esc(TYPE_TEXT[a.integrationType] || a.integrationType)} · ${a.ownerSchoolId ? `owned by ${esc(a.ownerSchoolName || "a school")}` : "district"}</small></th>
      <td>${badges(a, esc)}</td><td>${esc(licenseText(a))}</td><td>${esc(assignedText(a))}${a.availableToMySchool === false ? ` <span class="api-badge">Not at your school</span>` : ""}</td>
      <td>${a.canManage ? `<button type="button" data-action="app-manage" data-id="${esc(a.id)}" aria-expanded="${st.open === a.id}">${st.open === a.id ? "Close" : "Manage"}</button>` : (a.availableToMySchool === false ? `<button type="button" data-action="app-request" data-id="${esc(a.id)}" data-name="${esc(a.name)}">Request</button>` : "")}</td></tr>${st.open === a.id && a.canManage ? manager(ctx, a) : ""}`).join("");
    html += `<div class="api-card"><h3>District app catalog</h3><form data-form="app-search" class="api-search" role="search"><label>Search apps<input name="q" type="search" value="${esc(st.q)}" placeholder="Name, vendor or category"></label><button type="submit">Search</button></form>
      <div class="api-scroll"><table class="api-table"><caption class="sr-only">District app catalog</caption><thead><tr><th scope="col">App</th><th scope="col">Privacy</th><th scope="col">License</th><th scope="col">Available to</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${st.catalogPage?.nextOffset ? `<button type="button" data-action="apps-more">Show more apps</button>` : ""}</div>`;
    if (st.usage.length && (isDistrict || role === "principal")) html += `<div class="api-card"><h3>License usage${st.usageScope === "my_school" ? " at your school" : ""}</h3><div class="api-scroll"><table class="api-table"><caption class="sr-only">License usage</caption><thead><tr><th scope="col">App</th><th scope="col">Seats used</th><th scope="col">Seats licensed</th><th scope="col">Launches (30 days)</th><th scope="col">Next renewal</th></tr></thead><tbody>${st.usage.map(u => `<tr><th scope="row">${esc(u.name)}</th><td>${u.seatsUsed.toLocaleString()}</td><td>${u.licensed ? (u.seatsLicensed === null ? "Unlimited" : u.seatsLicensed.toLocaleString()) : "Not licensed"}</td><td>${u.launches30d.toLocaleString()}</td><td>${esc(u.nextRenewal || "—")}</td></tr>`).join("")}</tbody></table></div></div>`;
    return html;
  }
  function renderRequests(ctx) {
    const { API, esc } = ctx, role = API.actor?.role, decide = DISTRICT.includes(role);
    const STATUS = { pending: "Waiting for the district", approved: "Approved", denied: "Not approved", withdrawn: "Withdrawn" };
    const form = ["principal", "teacher"].includes(role) ? `<div class="api-card"><h3>Request an app</h3><p class="api-muted">Requests go to the district for approval. You'll see the decision here.</p>
      <form data-form="app-request" class="api-form-grid"><label>App already in the catalog<select name="appId"><option value="">A new app (describe it below)</option>${st.catalog.filter(a => a.availableToMySchool !== true).map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</select></label>
      <label>New app name<input name="name" maxlength="160"></label><label>Vendor<input name="vendor" maxlength="160"></label><label>Website<input name="url" type="url" placeholder="https://"></label>
      <label class="wide">Why do you need it?<textarea name="reason" required maxlength="2000" rows="2"></textarea></label><div class="wide"><button class="primary" type="submit">Send request</button></div></form></div>` : "";
    return form + `<div class="api-card"><h3>${decide ? "Requests from schools" : "Your school's requests"}</h3><div class="api-scroll"><table class="api-table"><caption class="sr-only">App requests</caption><thead><tr><th scope="col">App</th><th scope="col">School</th><th scope="col">Reason</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${st.requests.map(r => `<tr><th scope="row">${esc(r.app_name || r.requested_name)}${r.requested_vendor ? `<br><small>${esc(r.requested_vendor)}</small>` : ""}</th><td>${esc(r.school_name)}<br><small>${esc(r.requested_by_name)}</small></td><td>${esc(r.reason)}</td><td><span class="api-status ${esc(r.status)}">${esc(STATUS[r.status] || r.status)}</span>${r.decision_note ? `<br><small>${esc(r.decision_note)}</small>` : ""}</td>
      <td>${r.status === "pending" ? (decide ? `<button type="button" class="primary" data-action="request-decide" data-decision="approved" data-id="${esc(r.id)}">Approve</button> <button type="button" data-action="request-decide" data-decision="denied" data-id="${esc(r.id)}">Decline</button>` : (r.mine ? `<button type="button" data-action="request-withdraw" data-id="${esc(r.id)}">Withdraw</button>` : "")) : ""}</td></tr>`).join("")}</tbody></table></div></div>`;
  }
  function renderDistrict(ctx) {
    const { esc } = ctx, s = st.settings;
    if (!s) return `<p class="api-empty">District settings could not be loaded.</p>`;
    const rows = [["maxSchools", "Schools", "schools"], ["maxStudents", "Students", "students"], ["maxUsers", "People (accounts)", "users"], ["maxActiveWebhooks", "Active webhooks", "activeWebhooks"], ["maxApps", "Active apps", "apps"]];
    return `<div class="api-card"><h3>District limits</h3><p>EduOS has no built-in limits. Leave a box empty for <b>no limit</b> (the default), or enter a number to set a cap for your district.</p>
      <form data-form="district-settings" class="api-form-grid">${rows.map(([k, label, used]) => `<label>${label} <small>(now ${Number(s.usage[used] ?? 0).toLocaleString()})</small><input name="${k}" type="number" min="1" inputmode="numeric" value="${s.limits[k] ?? ""}" placeholder="No limit"></label>`).join("")}
      <div class="wide"><button class="primary" type="submit">Save limits</button></div></form>${s.updatedAt ? `<p class="api-muted">Last changed ${esc(ctx.fmtDate(s.updatedAt))}.</p>` : ""}</div>`;
  }
  function render(tab, ctx) {
    if (tab === "home") return renderHome(ctx);
    if (tab === "apps") return renderApps(ctx);
    if (tab === "app_requests") return renderRequests(ctx);
    if (tab === "district") return renderDistrict(ctx);
    if (tab === "branding") return B() ? (ctx.data.errors.branding ? `<p role="alert">${ctx.esc(ctx.data.errors.branding)}</p>` : B().render(ctx)) : "";
    return "";
  }

  const post = (ctx, path, body, method = "POST") => ctx.API.request(path, { method, body: JSON.stringify(body) });
  async function submit(form, v, ctx) {
    const kind = form.dataset.form;
    if (kind === "app-search") { st.q = String(v.q || "").trim(); await loadCatalog(ctx, 0); ctx.render("apps"); return true; }
    if (kind === "app-create") {
      const body = { name: v.name, vendor: v.vendor, launchUrl: v.launchUrl, integrationType: v.integrationType, dataSharingScope: v.dataSharingScope, dpaStatus: v.dpaStatus,
        coppaCompliant: form.elements.coppaCompliant.checked, ferpaSchoolOfficial: form.elements.ferpaSchoolOfficial.checked };
      if (v.category) body.category = v.category; if (v.description) body.description = v.description; if (v.dpaExpiresOn) body.dpaExpiresOn = v.dpaExpiresOn;
      if (form.elements.ownerSchoolId) body.ownerSchoolId = v.ownerSchoolId || null;
      if (v.integrationType === "lti13") body.integrationConfig = { clientId: v.ltiClientId, deploymentId: v.ltiDeploymentId, loginUrl: v.ltiLoginUrl, redirectUris: [v.ltiRedirectUri], targetLinkUri: v.ltiTargetLinkUri || v.launchUrl };
      const r = await post(ctx, "/api/apps", body); st.open = r.data.id;
      ctx.notify(`${r.data.name} was added. Next: add a license and choose who can use it.`); await ctx.openTab("apps"); return true;
    }
    if (kind === "license-add") {
      const body = { seatLimit: v.seatLimit ? Number(v.seatLimit) : null }; if (v.startsOn) body.startsOn = v.startsOn; if (v.endsOn) body.endsOn = v.endsOn;
      await post(ctx, `/api/apps/${form.dataset.app}/licenses`, body); ctx.notify("License added."); await ctx.openTab("apps"); return true;
    }
    if (kind === "assign-add") {
      const roles = [...form.querySelectorAll('input[name="roles"]:checked')].map(x => x.value), grades = [...form.querySelectorAll('input[name="grades"]:checked')].map(x => x.value);
      if (!roles.length) throw new Error("Choose at least one role.");
      const body = v.target === "district" ? { scope: "district", roles } : { scope: "school", schoolId: v.target, roles };
      if (grades.length) body.gradeLevels = grades;
      await post(ctx, `/api/apps/${form.dataset.app}/assignments`, body); ctx.notify("Access given. People can open the app from their Apps page."); await ctx.openTab("apps"); return true;
    }
    if (kind === "app-request") {
      const body = { reason: v.reason }; if (v.appId) body.appId = v.appId; else { body.name = v.name; if (v.vendor) body.vendor = v.vendor; if (v.url) body.url = v.url; }
      if (!v.appId && !String(v.name || "").trim()) throw new Error("Choose an app from the catalog or enter the name of a new app.");
      await post(ctx, "/api/app-requests", body); ctx.notify("Request sent to the district."); await ctx.openTab("app_requests"); return true;
    }
    if (kind === "district-settings") {
      const body = {}; for (const k of ["maxSchools", "maxStudents", "maxUsers", "maxActiveWebhooks", "maxApps"]) body[k] = v[k] === "" ? null : Number(v[k]);
      await post(ctx, "/api/district/settings", body, "PATCH"); ctx.notify("District limits saved."); await ctx.openTab("district"); return true;
    }
    return false;
  }
  async function action(b, ctx) {
    const a = b.dataset.action, id = b.dataset.id;
    if (B() && await B().action(b, ctx)) return true;
    if (a === "app-launch") {
      const pending = window.open("about:blank", "_blank");
      try {
        const r = await post(ctx, `/api/apps/${id}/launch`, {});
        if (pending) { pending.opener = null; pending.location.href = r.data.url; } else location.assign(r.data.url);
      } catch (e) { if (pending) pending.close(); throw e; }
      return true;
    }
    if (a === "app-manage") { st.open = st.open === id ? null : id; st.appUsage = null; ctx.render("apps"); return true; }
    if (a === "apps-more") { await loadCatalog(ctx, st.catalogPage?.nextOffset || 0); ctx.render("apps"); return true; }
    if (a === "lti-approve") { await post(ctx, `/api/apps/${id}/lti/approve`, {}); ctx.notify("LTI registration approved."); await ctx.openTab("apps"); return true; }
    if (a === "lti-revoke") { if (!confirm("Turn off this LTI tool? Launches in progress stop immediately.")) return true; await post(ctx, `/api/apps/${id}/lti/revoke`, {}); ctx.notify("LTI tool turned off."); await ctx.openTab("apps"); return true; }
    if (a === "app-usage") { st.appUsage = (await ctx.API.request(`/api/apps/${id}/usage`)).data; ctx.render("apps"); return true; }
    if (a === "app-retire") { if (!confirm("Retire this app? Nobody will be able to open it.")) return true; await post(ctx, `/api/apps/${id}`, { status: "retired" }, "PATCH"); st.open = null; ctx.notify("App retired."); await ctx.openTab("apps"); return true; }
    if (a === "license-cancel") { if (!confirm("Cancel this license?")) return true; await post(ctx, `/api/apps/${b.dataset.app}/licenses/${id}`, { status: "cancelled" }, "PATCH"); ctx.notify("License cancelled."); await ctx.openTab("apps"); return true; }
    if (a === "assignment-revoke") { await ctx.API.request(`/api/apps/${b.dataset.app}/assignments/${id}`, { method: "DELETE" }); ctx.notify("Access removed."); await ctx.openTab("apps"); return true; }
    if (a === "app-request") { const reason = prompt(`Why does your school need ${b.dataset.name}?`); if (!reason || !reason.trim()) return true; await post(ctx, "/api/app-requests", { appId: id, reason }); ctx.notify("Request sent to the district."); await ctx.openTab("app_requests"); return true; }
    if (a === "request-decide") { const note = prompt(b.dataset.decision === "approved" ? "Optional note for the school:" : "Tell the school why (optional):"); if (note === null) return true; await post(ctx, `/api/app-requests/${id}`, { decision: b.dataset.decision, note: note || null }, "PATCH"); ctx.notify(b.dataset.decision === "approved" ? "Approved. Catalog apps are now available to that school." : "Request declined."); await ctx.openTab("app_requests"); return true; }
    if (a === "request-withdraw") { await post(ctx, `/api/app-requests/${id}`, { withdraw: true }, "PATCH"); ctx.notify("Request withdrawn."); await ctx.openTab("app_requests"); return true; }
    return false;
  }
  const roleName = role => ROLE_NAME[role] || role;
  window.EduOSMesh = Object.freeze({ TABS, tabsFor, load, render, submit, action, roleName, state: () => st });
})();
