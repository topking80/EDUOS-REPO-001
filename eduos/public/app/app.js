// EduOS Mobile (32.4.0, SafetyOS + pick-up in 32.5.0, learning core + EDAL in 32.6.0): phone-first role apps for students, teachers,
// families, school leaders and bus drivers. Plain ES module, no inline
// script, no HTML string building with data: every node is created with h()
// and text is set as text. All data comes from the EduOS API with the
// session cookie; nothing is stored on the device beyond the app shell.

// ---------------- tiny DOM + API helpers ----------------
const SVGNS = "http://www.w3.org/2000/svg";
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const kid of kids) el.append(kid);
  return el;
}
const ICONS = {
  apps: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM17 14v6M14 17h6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  play: "M7 4l13 8-13 8z",
  chevron: "M9 6l6 6-6 6",
  home: "M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z",
  chat: "M4 4h16v12H8l-4 4z",
  path: "M5 19c0-6 14-4 14-10a4 4 0 0 0-8 0M5 19h4M12 5h0",
  news: "M4 5h13v14H6a2 2 0 0 1-2-2zM17 9h3v8a2 2 0 0 1-2 2M7 9h7M7 13h7",
  bus: "M5 4h14v12H5zM5 11h14M7 19v-3M17 19v-3M8 14h.01M16 14h.01",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  people: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6M17 14a6 6 0 0 1 4 6",
  check: "M4 12l5 5L20 6",
  spark: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  me: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  send: "M3 11l18-8-8 18-2-8z",
  child: "M12 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 22v-7l-3-3 3-3h8l3 3-3 3v7",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM12 8v5M12 16h.01",
  car: "M5 16l1.5-5h11L19 16M3 16h18v3H3zM7 19v2M17 19v2M7.5 16h.01M16.5 16h.01",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2",
  book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7",
  ledger: "M6 3h12v18H6zM9 7h6M9 11h6M9 15h4",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  link: "M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"
};
const icon = (name) => svg("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" }, svg("path", { d: ICONS[name] || ICONS.grid }));

class ApiError extends Error { constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body; } }
const api = {
  csrf: null,
  async req(method, path, body) {
    const headers = { accept: "application/json" };
    const queueable = typeof OQ !== "undefined" && OQ.queueable(method, path);
    if (method !== "GET") {
      // Offline: a queueable write is kept even if no CSRF token could be fetched (flush gets a fresh one).
      if (!this.csrf) this.csrf = (await this.req("GET", "/api/csrf").catch(e => { if (queueable && !(e instanceof ApiError)) return {}; throw e; })).csrfToken;
      if (this.csrf) headers["x-csrf-token"] = this.csrf;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    if (queueable) { headers["idempotency-key"] = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join(""); headers["x-eduos-queued-at"] = new Date().toISOString(); }
    let res;
    try { res = await fetch(path, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { if (queueable) { await OQ.enqueue(path, body, headers); return { queued: true, data: null }; } throw e; }
    if (queueable && [502, 503, 504].includes(res.status)) { await OQ.enqueue(path, body, headers); return { queued: true, data: null }; }
    const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  },
  get(p) { return this.req("GET", p); },
  post(p, b = {}) { return this.req("POST", p, b); },
  put(p, b = {}) { return this.req("PUT", p, b); }
};
const safe = async (p, fallback = null) => { try { return await p; } catch (e) { if (e.status === 401) throw e; return fallback; } };

const $main = () => document.getElementById("main");
const put = (...nodes) => $main().replaceChildren(...nodes.flat(Infinity).filter(n => n !== null && n !== undefined && n !== false));
function toast(msg) { const t = document.getElementById("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2600); }
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
const fmtDay = (iso) => iso ? new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "";
const ago = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : fmtDay(iso); };
// First name for greetings: skips a leading title ("Dr. Maya Chen" -> "Maya").
const first = (name) => { const w = String(name || "").trim().split(/\s+/); return (w.length > 1 && /^(dr|mr|mrs|ms|mx|miss|prof|rev)\.?$/i.test(w[0]) ? w[1] : w[0]) || ""; };
const STATUS_TEXT = { boarded: "On board", alighted: "Dropped off", not_riding: "Not riding", expected: "Expected", not_started: "Run not started", present: "Present", absent: "Absent", tardy: "Tardy" };
const chip = (status, text) => h("span", { class: `chip ${status}` }, text || STATUS_TEXT[status] || status);

// ---------------- colour: keep school colours readable on dark ----------------
const hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c || "")); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null; };
const toHex = rgb => "#" + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const lum = rgb => { const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const SURFACE = hex("#141a29"), LIGHT_SURFACE = hex("#ffffff"), WHITE = [255, 255, 255], BLACK = [0, 0, 0], INK = hex("#0b0f19");
// Lightens a colour (dark surface) or darkens it (light surface) until it reaches AA as text on bg.
function readableOn(bg, color, toward = WHITE) { let c = color; for (let t = 0; t <= 1.0001 && contrast(c, bg) < 4.5; t += 0.05) c = mix(color, toward, t); return c; }
const onFill = rgb => (contrast(rgb, WHITE) >= 4.5 ? "#ffffff" : "#0b0f19");
function applyBranding(b) {
  const root = document.documentElement.style;
  const primary = hex(b?.branding?.primary) || hex("#2f6fbf");
  const accent = hex(b?.branding?.accent) || hex("#f6c445");
  root.setProperty("--school", toHex(primary)); root.setProperty("--on-school", onFill(primary));
  // UI-02: the school's theme chooses the app's appearance (dark, light, or the device's setting).
  const mode = b?.branding?.appAppearance || "dark";
  const prefersLight = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
  const light = mode === "light" || (mode === "device" && prefersLight);
  document.documentElement.dataset.appearance = light ? "light" : "dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? toHex(primary) : "#0b0f19");
  if (mode === "device" && !applyBranding.watching && typeof matchMedia === "function") {
    applyBranding.watching = true;
    matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => applyBranding(state.brand));
  }
  // An accent or school colour that is too dark (dark theme) or too light (light theme) is adjusted until AA holds.
  const surface = light ? LIGHT_SURFACE : SURFACE, toward = light ? BLACK : WHITE;
  const acc = readableOn(surface, accent, toward);
  root.setProperty("--accent", toHex(acc)); root.setProperty("--on-accent", contrast(acc, INK) >= 4.5 ? "#0b0f19" : "#ffffff");
  root.setProperty("--ink", toHex(readableOn(surface, primary, toward)));
  const fonts = { rounded: `"Nunito", "Varela Round", ui-rounded, system-ui, sans-serif`, slab: `"Roboto Slab", "Rockwell", Georgia, serif`, system: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` };
  root.setProperty("--font", fonts[b?.branding?.font] || fonts.system);
  if (b?.publicKey) {
    const [d, s] = b.publicKey.split(".");
    const base = `/api/public/branding/${d}/${s}`;
    document.getElementById("manifest").href = `${base}/manifest.webmanifest?app=mobile`;
    document.getElementById("favicon").href = `${base}/icon-32.png`;
    document.getElementById("favicon").type = "image/png";
    document.getElementById("touchicon").href = `${base}/icon-180.png`;
  }
}

// ---------------- role apps: tabs ----------------
const ROLE_TABS = {
  pupil: [["home", "Home", "home"], ["portfolio", "My history", "book"], ["capsules", "Time Capsules", "spark"], ["library", "My library", "book"], ["courses", "Courses", "book"], ["christie", "Christie", "spark"], ["path", "My path", "path"], ["activities", "Clubs & Sports", "trophy"], ["news", "News", "news"]],
  teacher: [["dashboard", "Dashboard", "home"], ["classes", "Classes", "grid"], ["schoolday", "School day", "bus"], ["staffing", "Staffing", "people"], ["courses", "Courses", "book"], ["contributions", "History items", "book"], ["grading", "Grading", "check"], ["copilot", "Christie", "spark"], ["activities", "Clubs & Sports", "trophy"], ["messages", "Messages", "chat"], ["network", "Colleagues", "people"]],
  parent: [["children", "Children", "child"], ["capsules", "Time Capsules", "spark"], ["library", "Library books", "book"], ["arrival", "Arrival", "bus"], ["pickup", "Pick-up", "car"], ["activities", "Clubs & Sports", "trophy"], ["messages", "Messages", "chat"], ["alerts", "Alerts", "bell"]],
  librarian: [["library", "Library desk", "book"], ["mediacenter", "Media center", "check"], ["messages", "Messages", "chat"]],
  // A vice principal gets this plus every principal tab (tabsFor).
  vice_principal: [["operations", "Operations", "grid"]],
  counselor: [["guidance", "Counseling", "heart"], ["staffing", "Staffing", "people"], ["messages", "Messages", "chat"]],
  nurse: [["healthoffice", "Health office", "heart-pulse"], ["staffing", "Staffing", "people"], ["messages", "Messages", "chat"]],
  maintenance: [["facilities", "Facilities", "wrench"], ["staffing", "Staffing", "people"], ["messages", "Messages", "chat"]],
  lunch_staff: [["meals", "Meal service", "utensils"], ["staffing", "Staffing", "people"], ["messages", "Messages", "chat"]],
  // TC-13: gift accounts once the superintendent designates them (db/140).
  school_secretary: [["gifts", "Gift accounts", "check"], ["staffing", "Staffing", "people"], ["messages", "Messages", "chat"]],
  principal: [["overview", "School", "grid"], ["apps", "Apps", "apps"], ["capsules", "Time Capsules", "spark"], ["history", "Student history", "book"], ["staffing", "Staffing", "people"], ["library", "Library", "book"], ["pickup", "Pick-up", "car"], ["transport", "Transport", "bus"], ["activities", "Clubs & Sports", "trophy"], ["messages", "Messages", "chat"], ["network", "Colleagues", "people"], ["devices", "Rooms & devices", "server"], ["alerts", "Alerts", "bell"]],
  superintendent: [["overview", "District", "grid"], ["apps", "Apps", "apps"], ["capsules", "Time Capsules", "spark"], ["history", "Student history", "book"], ["staffing", "Staffing", "people"], ["library", "Library", "book"], ["alerts", "Alerts", "bell"], ["transport", "Transport", "bus"], ["nodes", "Nodes", "server"], ["integrations", "Data links", "link"]],
  driver: [["route", "Route", "bus"], ["messages", "Messages", "chat"], ["alerts", "Alerts", "bell"]],
  sro: [["safety", "Safety", "shield"], ["alerts", "Alerts", "bell"]],
  coach: [["teams", "My teams", "trophy"], ["alerts", "Alerts", "bell"]],
  it_admin: [["apps", "Apps", "apps"], ["devices", "Classroom devices", "server"], ["nodes", "Nodes", "server"], ["integrations", "Data links", "link"], ["library", "Library", "book"]]
};
const APP_NAME = { coach: "Coach", pupil: "Student", teacher: "Teacher", parent: "Family", principal: "School leader", superintendent: "District leader", driver: "Driver", sro: "School Resource Officer", librarian: "Librarian", vice_principal: "Vice Principal", counselor: "Guidance Counselor", nurse: "School Nurse", maintenance: "Maintenance", lunch_staff: "Lunch Staff", school_secretary: "School Secretary", it_admin: "District IT" };
const state = { me: null, brand: null, tab: null, unread: 0, home: null, safety: [], safetySig: "" };
const STAFF_ROLES = ["teacher", "principal", "vice_principal", "superintendent"];

function renderTop() {
  const b = state.brand, me = state.me;
  const mascotSrc = b?.mascot ? (b.mascot["96"] || Object.values(b.mascot)[0]) : null;
  const top = document.getElementById("top");
  top.replaceChildren(
    mascotSrc ? h("img", { class: "mascot", src: mascotSrc, alt: `${b.branding?.mascotName || "School"} mascot` })
      : h("span", { class: "mascot initials", "aria-hidden": "true" }, String(b?.school?.name || b?.districtName || "EduOS").replace(/\(.*?\)/g, "").split(/\s+/).filter(w => /^[A-Z]/.test(w)).slice(0, 2).map(w => w[0]).join("") || "E"),
    h("div", { class: "who" },
      (state.profiles || []).length > 1
        ? h("button", { class: "school switch", type: "button", "aria-haspopup": "dialog", "aria-label": `${b?.school?.name || b?.districtName || "EduOS"} · ${roleName()}. Switch profile`, onclick: openProfiles },
            `${b?.school?.name || b?.districtName || "EduOS"} · ${roleName()}`, h("span", { class: "caret", "aria-hidden": "true" }, " ▾"))
        : h("p", { class: "school" }, `${b?.school?.name || b?.districtName || "EduOS"} · ${roleName()}`),
      h("h1", {}, `Hi, ${first(me.displayName)}`)),
    h("button", { class: "iconbtn", type: "button", "aria-label": state.unread ? `Alerts, ${state.unread} unread` : "Alerts", onclick: () => go(tabsFor().some(t => t[0] === "alerts") ? "alerts" : "me") },
      icon("bell"), state.unread ? h("span", { class: "dot", "aria-hidden": "true" }, String(Math.min(state.unread, 99))) : null),
    STAFF_ROLES.includes(me.role) ? h("button", { class: "iconbtn sos", type: "button", "aria-label": "Safety: start or view an emergency alert", onclick: () => go(liveIncidents().length ? "safety" : "sos") }, icon("shield")) : null,
    h("button", { class: "iconbtn", type: "button", "aria-label": "Account", onclick: () => go("me") }, icon("me")));
  for (const n of [...top.childNodes]) if (n.nodeType === Node.TEXT_NODE) n.remove(); // replaceChildren() turns a null slot into "null"
}
// A vice principal acts with the principal's authority (except assigning
// roles): the principal's screens, plus their operations queue.
const isVP = () => state.me?.membershipRole === "vice_principal";
const tabsFor = () => isVP() ? [...ROLE_TABS.vice_principal, ...ROLE_TABS.principal] : ROLE_TABS[state.me?.role] || [];
const roleName = () => APP_NAME[isVP() ? "vice_principal" : state.me?.role] || state.me?.role;
// UI-03: on a phone the bar shows at most five items: the role's four everyday
// tabs, then "More" for the rest. The desktop rail still lists every tab.
const PHONE_TABS = {
  pupil: ["home", "courses", "christie", "library"],
  teacher: ["dashboard", "classes", "grading", "messages"],
  parent: ["children", "pickup", "messages", "alerts"],
  vice_principal: ["operations", "overview", "history", "messages"],
  principal: ["overview", "history", "messages", "alerts"],
  superintendent: ["overview", "apps", "alerts", "integrations"]
};
// Short names where the full one doesn't fit a phone tab (the full name stays the accessible name).
const PHONE_LABEL = { devices: "Devices", history: "History", capsules: "Capsules", activities: "Clubs", contributions: "Items", integrations: "Data", library: "Library" };
function phoneSplit() {
  const all = tabsFor();
  if (all.length <= 5) return { main: all, extra: [] };
  const pick = PHONE_TABS[isVP() ? "vice_principal" : state.me?.role] || all.slice(0, 4).map(t => t[0]);
  return { main: all.filter(t => pick.includes(t[0])), extra: all.filter(t => !pick.includes(t[0])) };
}
function renderTabs() {
  const nav = document.getElementById("tabs");
  const cur = parentTab(state.tab);
  const { extra } = phoneSplit();
  const inMore = cur === "more" || extra.some(t => t[0] === cur);
  nav.replaceChildren(...tabsFor().map(([id, label, ic]) => h("a", { href: `#/${id}`, class: extra.some(t => t[0] === id) ? "phone-extra" : false, "aria-current": cur === id ? "page" : false }, icon(ic),
      PHONE_LABEL[id] ? [h("span", { class: "full" }, label), h("span", { class: "short", "aria-hidden": "true" }, PHONE_LABEL[id])] : h("span", {}, label))),
    extra.length ? h("a", { href: "#/more", class: "phone-more", "aria-current": inMore ? "page" : false }, icon("more"), h("span", {}, "More")) : null);
  for (const n of [...nav.childNodes]) if (n.nodeType === Node.TEXT_NODE) n.remove();
  // When the bar scrolls (many tabs on a narrow screen), keep the current tab in view.
  nav.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

const VIEWS = {};
// UI-04: families with several children, or children at several schools. The bar
// on top of a parent's screens chooses whose things to show; choosing a child at
// another school moves the app to that school (its colours, news, messages and
// alerts) when the family has an account there. Kept in memory only.
const NO_FAMILY_BAR = ["safety", "sos", "me", "more"];
// UI-05: every profile this person can use (role + school + district), for the
// switcher in the header and on Account.
async function loadProfiles() { state.profiles = (await safe(api.get("/api/memberships")))?.data || []; }
async function loadFamily() {
  if (state.me?.role !== "parent") { state.family = null; return; }
  const kids = await safe(api.get("/api/family/children"));
  if (state.family?.userId !== state.me.userId) state.childId = null;
  state.family = { userId: state.me.userId, kids: kids?.data || [], memberships: (state.profiles || []).filter(m => m.role === "parent") };
  if (state.childId && !state.family.kids.some(k => k.id === state.childId)) state.childId = null;
}
const familyMembershipFor = kid => state.family?.memberships.find(m => m.district_id === state.me.districtId && m.school_id === kid.school_id);
function profileLabel(m, all = state.profiles || []) {
  const place = m.school_name || (m.school_id ? "School" : "District office");
  const districts = new Set(all.map(p => p.district_id));
  return `${APP_NAME[m.role] || m.role} · ${place}${districts.size > 1 && m.district_name ? ` · ${m.district_name}` : ""}`;
}
function profileList(onPick) {
  const all = state.profiles || [];
  return h("ul", { class: "list profiles" }, all.map(m => h("li", {}, m.current
    ? h("p", { class: "row profile current", "aria-current": "true" }, icon("check"), h("span", { class: "grow" }, profileLabel(m, all)), chip("present", "Current"))
    : h("button", { class: "row profile", type: "button", onclick: () => onPick(m) }, icon("me"), h("span", { class: "grow" }, profileLabel(m, all)), icon("chevron")))));
}
async function switchProfile(m) {
  try { state.childId = null; await useMembership(m, `Now using ${profileLabel(m)}`); }
  catch { toast("Couldn't switch profile."); }
}
function openProfiles() {
  const dlg = h("dialog", { class: "dialog", "aria-labelledby": "prof-t" });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.append(h("h2", { id: "prof-t" }, "Switch profile"),
    h("p", { class: "small muted" }, "Each profile is one of your roles at a school or district. Saved offline changes stay with the profile they were made in."),
    profileList(m => { close(); switchProfile(m); }),
    h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: close }, "Close")));
  dlg.addEventListener("cancel", e => { e.preventDefault(); close(); });
  document.body.append(dlg); dlg.showModal();
  (dlg.querySelector("button.profile") || dlg.querySelector("button")).focus();
}
async function useMembership(m, message) {
  const r = await api.post("/api/session/membership", { membershipId: m.id });
  api.csrf = r.csrfToken;
  toast(message);
  await boot();
}
async function chooseChild(id) {
  const kid = state.family.kids.find(k => k.id === id) || null;
  state.childId = kid?.id || null;
  if (kid) state.learnerId = kid.id;
  const m = kid && kid.school_id !== state.me.schoolId ? familyMembershipFor(kid) : null;
  if (m) {
    try { return await useMembership(m, `Now showing ${kid.school_name}`); }
    catch { toast(`Couldn't switch to ${kid.school_name}.`); }
  }
  go(state.tab, { push: false });
}
function familyBar() {
  const f = state.family;
  if (!f || NO_FAMILY_BAR.includes(state.tab)) return null;
  const elsewhere = f.memberships.filter(m => m.district_id !== state.me.districtId);
  if (f.kids.length < 2 && !elsewhere.length) return null;
  const schools = new Set(f.kids.map(k => k.school_id));
  const pick = (label, sub, pressed, onclick) => h("button", { class: "famchip", type: "button", "aria-pressed": pressed ? "true" : "false", onclick },
    h("span", { class: "n" }, label), sub ? h("span", { class: "s" }, sub) : null);
  const kid = f.kids.find(k => k.id === state.childId);
  const noAccount = kid && kid.school_id !== state.me.schoolId && !familyMembershipFor(kid);
  return h("nav", { class: "familybar", "aria-label": "Choose a child" },
    h("div", { class: "famchips" },
      f.kids.length > 1 ? pick("Everyone", schools.size > 1 ? `${schools.size} schools` : null, !state.childId, () => chooseChild(null)) : null,
      f.kids.map(k => pick(first(k.display_name), schools.size > 1 || elsewhere.length ? k.school_name : `Grade ${k.grade_level}`, state.childId === k.id, () => chooseChild(k.id))),
      elsewhere.map(m => pick(m.school_name || m.district_name, m.district_name, false, () => {
        state.childId = null;
        useMembership(m, `Now showing ${m.school_name || m.district_name}`).catch(() => toast("Couldn't switch."));
      }))),
    noAccount ? h("p", { class: "small muted" }, `${first(kid.display_name)}'s things are below. News, messages and alerts still come from ${state.brand?.school?.name || "your current school"}; ask ${kid.school_name}'s office to add you there.`) : null);
}
// Lists with one entry per child follow the bar; with no choice (or a child not in the list) everyone shows.
const forChild = (list, key = "id") => state.childId && list.some(x => x[key] === state.childId) ? list.filter(x => x[key] === state.childId) : list;
VIEWS.more = () => {
  const { extra } = phoneSplit(), list = extra.length ? extra : tabsFor();
  return h("section", { class: "card" }, h("h2", {}, "More"),
    h("ul", { class: "morelist" }, [...list, ["me", "Account", "me"]].map(([id, label, ic]) =>
      h("li", {}, h("a", { href: `#/${id}` }, icon(ic), h("span", {}, label), icon("chevron"))))));
};
// 32.6.0: screens opened from a tab keep that tab highlighted.
const SUBVIEWS = ["staffing", "course", "lesson", "quiz", "attempt", "mastery", "gradebook", "progress", "proof", "review", "rubric", "approvals", "edal", "roster", "node", "history", "portfolio", "capsule", "draft", "plan", "present", "teams", "coachplan", "coachlib", "states", "stateinfo", "licenses", "room", "scan", "roll", "mywork", "portfolioreview", "rankings", "historyprivacy", "emergencyrecords", "historyimport"];
function parentTab(tab) {
  if (!SUBVIEWS.includes(tab) || tabsFor().some(t => t[0] === tab)) return tab;
  if (["review", "rubric"].includes(tab)) return "grading";
  if (tab === "history") return "history";
  if (tab === "capsule") return "capsules";
  if (tab === "draft") return "network";
  if (["states", "stateinfo", "licenses", "mywork", "portfolioreview", "rankings", "emergencyrecords"].includes(tab)) return "me";
  if (tab === "historyprivacy" || tab === "historyimport") return "history";
  if (tab === "plan" || tab === "present" || tab === "room") return "classes";
  if (tab === "scan") return tabsFor()[0]?.[0];
  if (tab === "roll") return tabsFor().some(t => t[0] === "classes") ? "classes" : tabsFor().some(t => t[0] === "mediacenter") ? "mediacenter" : "devices";
  if (["teams", "coachplan", "coachlib"].includes(tab)) return tabsFor().some(t => t[0] === "teams") ? "teams" : "activities";
  const role = state.me?.role;
  if (tab === "node") return tabsFor().some(t => t[0] === "nodes") ? "nodes" : "overview";
  if (tab === "staffing") return "staffing";
  return role === "parent" ? "children" : ["principal", "superintendent"].includes(role) ? "overview" : "courses";
}
async function go(tab, { push = true } = {}) {
  // SafetyOS: while an incident is live at my school, the app shows the
  // full-screen safety state. Staff can still open pick-up (reunification)
  // and the start screen; everything else waits for the all-clear.
  // Families may open pick-up only once reunification starts (to show a pass).
  const live = liveIncidents();
  const open = STAFF_ROLES.includes(state.me?.role) ? ["safety", "pickup", "sos", "me"]
    : ["safety", "me", ...(state.me?.role === "parent" && live.some(i => i.status === "reunification") ? ["pickup"] : [])];
  if (live.length && !open.includes(tab)) tab = "safety";
  document.body.classList.toggle("sos-mode", liveIncidents().length > 0);
  clearInterval(state.quizTimer); clearInterval(state.draftTimer); clearInterval(state.roomTimer);
  if (tab !== "present") { clearInterval(state.presentTimer); document.body.classList.remove("presenting"); }
  state.tab = tab;
  if (push && location.hash !== `#/${tab}`) history.pushState(null, "", `#/${tab}`);
  renderTabs();
  const main = $main();
  main.replaceChildren(h("p", { class: "empty" }, "Loading…"));
  try {
    const view = VIEWS[tab] || VIEWS[tabsFor()[0]?.[0]] || VIEWS.me;
    const node = await view();
    main.replaceChildren(...[familyBar(), node].flat(Infinity).filter(Boolean));
  } catch (e) {
    if (e.status === 401) return renderSignIn();
    main.replaceChildren(h("div", { class: "card" }, h("h2", {}, "Something went wrong"), h("p", { class: "muted" }, navigator.onLine ? "Please try again." : "You're offline. EduOS needs a connection to show school data."),
      h("button", { class: "btn", type: "button", onclick: () => go(tab, { push: false }) }, "Retry")));
  }
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  refreshUnread();
}
const liveIncidents = () => (state.safety || []).filter(i => i.status === "active" || i.status === "reunification");
async function checkSafety({ rerender = true } = {}) {
  if (!state.me || !ROLE_TABS[state.me.role]) return;
  const r = await safe(api.get("/api/safety/status"));
  if (!r) return;
  state.safety = r.data.incidents || [];
  state.safetyCaps = { canInitiate: r.data.canInitiate, canLead: r.data.canLead };
  // SAFE-04: National Weather Service warnings waiting for a leader's decision.
  const wx = r.data.weather || [], wsig = wx.map(w => w.id).join("|");
  const firstWx = state.weatherSig === undefined;
  if (firstWx || wsig !== state.weatherSig) {
    const first = firstWx, seen = new Set((state.weather || []).map(w => w.id)), fresh = wx.filter(w => !seen.has(w.id));
    state.weather = wx; state.weatherSig = wsig;
    if (fresh.length && !first) toast(`${fresh[0].event} (National Weather Service) for ${fresh[0].school}. Open Safety to decide.`);
    if (!first && ["sos", "safety"].includes(state.tab) && !document.querySelector("dialog[open]") && !liveIncidents().length) go(state.tab, { push: false });
  }
  const sig = liveIncidents().map(i => `${i.id}:${i.status}`).join("|");
  if (sig !== state.safetySig) {
    const was = state.safetySig;
    state.safetySig = sig;
    renderTop();
    if (rerender && (was !== "" || sig !== "")) go(sig ? "safety" : (tabsFor()[0]?.[0] || "me"), { push: false });
  } else if (rerender && state.tab === "safety" && state.safetyCaps.canLead && !document.querySelector("dialog[open]")) {
    go("safety", { push: false }); // the accountability board refreshes itself
  }
}
async function refreshUnread() {
  // The count only: the badge doesn't need the latest 50 notifications.
  const n = await safe(api.get("/api/notifications?summary=1"));
  const u = n?.data?.unread || 0;
  if (u !== state.unread) { state.unread = u; renderTop(); }
}

// ---------------- shared widgets ----------------
function ring(pct, label) {
  const r = 52, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return h("div", { class: "ring", role: "img", "aria-label": `${label}: ${v} percent mastery` },
    svg("svg", { viewBox: "0 0 128 128", "aria-hidden": "true" },
      svg("circle", { class: "track", cx: 64, cy: 64, r, fill: "none", "stroke-width": 12 }),
      svg("circle", { class: "bar", cx: 64, cy: 64, r, fill: "none", "stroke-width": 12, "stroke-dasharray": c.toFixed(1), "stroke-dashoffset": (c * (1 - v / 100)).toFixed(1) })),
    h("div", { class: "val", "aria-hidden": "true" }, h("div", {}, h("b", {}, `${v}%`), h("span", {}, "mastery"))));
}
function barH(pct, label) { const i = h("i"); i.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`; return h("div", { class: "bar-h", role: "img", "aria-label": label }, i); }
const stat = (n, label, alert = false) => h("div", { class: `stat${alert && n > 0 ? " alert" : ""}` }, h("b", {}, String(n ?? 0)), h("span", {}, label));
const empty = (text) => h("p", { class: "empty" }, text);
function seg(options, current, onpick) {
  return h("div", { class: "seg", role: "group" }, options.map(([id, label]) => h("button", { type: "button", "aria-pressed": String(id === current), onclick: () => onpick(id) }, label)));
}
function announcementsCard(list, { limit = 20 } = {}) {
  if (!list?.length) return empty("No announcements yet.");
  return h("ul", { class: "list" }, list.slice(0, limit).map(a => h("li", {},
    h("div", { class: "row" }, h("h3", { class: "grow" }, a.title), a.read === false ? h("span", { class: "chip current" }, "New") : null),
    h("p", {}, a.body),
    h("p", { class: "small muted" }, `${a.scope === "class" ? `Class · ${a.class_teacher_name || a.author_name}` : "Whole school"} · ${a.author_name} · ${ago(a.created_at)}${a.read_count != null ? ` · read by ${a.read_count}` : ""}`),
    a.read === false ? h("button", { class: "btn", type: "button", onclick: async (e) => { await api.post(`/api/comms/announcements/${a.id}/read`); e.target.remove(); toast("Marked as read"); } }, "Mark read") : null)));
}
function busCard(riders, { heading = "Bus today" } = {}) {
  const card = h("section", { class: "card", "aria-label": heading }, h("h2", {}, heading));
  if (!riders?.length) { card.append(empty("No bus assignments.")); return card; }
  for (const k of riders) {
    const last = k.events?.[k.events.length - 1];
    card.append(h("div", { class: "row" }, icon("bus"),
      h("div", { class: "grow" }, h("h3", {}, `${first(k.display_name)} · ${k.bus_label} ${k.direction === "am" ? "morning" : "afternoon"}`),
        h("p", { class: "small muted" }, last ? `${STATUS_TEXT[last.event]} ${last.is_school ? "at school" : `at ${last.stop_name}`} · ${fmtTime(last.recorded_at)}` : `Stop: ${k.stop_name}${k.stop_time ? ` · ${k.stop_time}` : ""}`)),
      chip(k.status)));
  }
  card.append(h("p", { class: "small muted" }, "Shows check-ins the driver records at stops. EduOS does not track location."));
  return card;
}

// ---------------- student ----------------
VIEWS.home = async () => {
  const [path, bus, news, home, courses] = await Promise.all([safe(api.get("/api/christie/path")), safe(api.get("/api/transport/today")), safe(api.get("/api/comms/announcements")), safe(api.get("/api/home")), safe(api.get("/api/learning/courses"))]);
  const myCourses = courses?.data?.courses || [];
  const young = Boolean(home?.data?.youngLearner);
  document.body.classList.toggle("young", young);
  const skills = path?.data?.skills || [];
  const current = skills.find(s => s.state === "current") || skills[0];
  const mastered = skills.filter(s => s.state === "mastered").length;
  return [
    await scanCard(),
    await remoteLessonsCard(),
    h("section", { class: "card hero", "aria-label": "Today" },
      h("div", { class: "row" }, current ? ring(current.mastery, current.title) : null,
        h("div", { class: "grow" }, h("p", { class: "muted small" }, current ? `${current.subject} · up next` : "Learning path"),
          h("h2", {}, current ? current.title : "No practice assigned yet"),
          h("p", { class: "muted small" }, `${mastered} of ${skills.length} skills mastered`))),
      current ? h("button", { class: "btn primary block big", type: "button", onclick: () => startSkill(current.id) }, icon("spark"), "Practice with Christie") : null),
    myCourses.length ? h("section", { class: "card", "aria-label": "My courses" }, h("h2", {}, "My courses"), h("ul", { class: "list" }, myCourses.map(c => h("li", { class: "row" },
      h("div", { class: "grow" }, h("h3", {}, c.title), h("p", { class: "small muted" }, c.next ? `Next: ${c.next.title}${c.next.due_at ? ` · due ${fmtDay(c.next.due_at)}` : ""}` : "All caught up")),
      h("button", { class: "btn", type: "button", "aria-label": `Open ${c.title}`, onclick: () => openView("course", { courseId: c.id }) }, "Open"))))) : null,
    busCard(bus?.data?.riders, { heading: "My bus" }),
    h("section", { class: "card", "aria-label": "School news" }, h("h2", {}, "School news"), announcementsCard(news?.data, { limit: 2 }))
  ];
};
async function startSkill(skillId) {
  try {
    const r = await api.post("/api/christie/sessions", { skillId });
    state.christieSession = r.data.session.id;
    go("christie");
  } catch (e) { toast(e.body?.error === "skill_has_no_items" ? "This skill has no practice yet." : "Christie couldn't start. Try again."); }
}
VIEWS.christie = async () => {
  const path = await api.get("/api/christie/path");
  const sid = state.christieSession || path.data.activeSessionId;
  if (!sid) {
    const current = path.data.skills.find(s => s.state === "current");
    return [h("section", { class: "card" }, h("h2", {}, "Christie, your practice buddy"),
      h("p", {}, "Christie gives hints and asks questions. You do the solving."),
      current ? h("button", { class: "btn primary block big", type: "button", onclick: () => startSkill(current.id) }, `Start: ${current.title}`) : empty("Your teacher hasn't added practice yet.")), christieNotice()];
  }
  const s = (await api.get(`/api/christie/sessions/${sid}`)).data;
  state.christieSession = s.id;
  const chat = h("div", { class: "chat", "aria-live": "polite", "aria-label": "Conversation with Christie" });
  const addTurn = (t) => chat.append(h("div", { class: `bubble ${t.speaker === "student" ? "me" : "them"}${t.kind === "item" ? " item" : ""}` },
    h("span", { class: "sr" }, t.speaker === "student" ? "You said: " : "Christie: "), t.text,
    t.kind === "hint" && t.hintLevel ? h("span", { class: "meta" }, `Hint ${t.hintLevel}`) : null,
    t.kind === "item" ? h("span", { class: "meta" }, "Practice problem") : null));
  s.turns.forEach(addTurn);
  const masteryEl = h("p", { class: "small muted", id: "mastery-line" }, `Mastery: ${s.mastery}%`);
  const input = h("input", { id: "christie-input", name: "answer", autocomplete: "off", placeholder: "Type an answer or a question", "aria-label": "Your answer or question", maxlength: 500 });
  const send = async (kind) => {
    const text = input.value.trim();
    if (kind !== "skip" && !text) { input.focus(); return; }
    input.value = "";
    if (kind !== "skip") addTurn({ speaker: "student", text });
    try {
      const r = (await api.post(`/api/christie/sessions/${s.id}/turns`, { kind, text })).data;
      r.replies.forEach(addTurn);
      if (r.crisis) chat.append(wbCrisisCard(r.crisis)); // 37.6.0: 988 Lifeline
      if (r.mastery) masteryEl.textContent = `Mastery: ${r.mastery.mastery}%${r.mastery.mastered ? " · Mastered!" : ""}`;
      composer.scrollIntoView({ block: "end" });
    } catch (e) { toast(e.status === 429 ? "Slow down a little and try again." : "Christie didn't get that. Try again."); }
    input.focus();
  };
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); send(/\?\s*$/.test(input.value) ? "question" : "attempt"); } });
  const composer = h("div", { class: "composer" },
    h("div", { class: "row" }, input),
    h("div", { class: "btns", role: "group", "aria-label": "Send" },
      h("button", { class: "btn primary", type: "button", onclick: () => send("attempt") }, icon("check"), "Check answer"),
      h("button", { class: "btn", type: "button", onclick: () => send("question") }, "Ask Christie"),
      h("button", { class: "btn", type: "button", onclick: () => send("skip") }, "Skip")));
  return [
    h("div", { class: "row" }, h("div", { class: "grow" }, h("h2", {}, s.skill.title), masteryEl),
      h("button", { class: "btn", type: "button", onclick: async () => { await api.post(`/api/christie/sessions/${s.id}/end`); state.christieSession = null; go("path"); } }, "Done")),
    chat,
    composer,
    christieNotice()
  ];
};
const christieNotice = () => h("p", { class: "notice" }, "Christie only uses lessons your school approved and gives hints, not answers. Your teacher can read these chats. Don't type your full name, address or phone number.");
VIEWS.path = async () => {
  const path = (await api.get("/api/christie/path")).data;
  if (!path.skills.length) return empty("No skills on your path yet.");
  const bySubject = {};
  for (const s of path.skills) (bySubject[s.subject] ||= []).push(s);
  return [h("h2", {}, "My learning path"), h("p", { class: "muted small" }, `Grade ${path.learner.grade}. Skills linked to a standard show your standard mastery (quizzes, graded work and practice, explained on the Courses tab). Others show a practice estimate, not a grade.`),
    ...Object.entries(bySubject).map(([subject, list]) => h("section", { class: "card", "aria-label": subject }, h("h2", {}, subject),
      h("ol", { class: "path" }, list.map(s => h("li", { class: s.state },
        h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, s.title), s.standard_code ? h("p", { class: "small muted" }, `${s.standard_code} · ${s.mastery_basis === "standard" ? "standard mastery" : "practice estimate"}`) : null, barH(s.mastery, `${s.title}: ${s.mastery}% mastery`)),
          chip(s.state, s.state === "mastered" ? "Mastered" : s.state === "current" ? "Up next" : `${s.mastery}%`)),
        h("button", { class: `btn${s.state === "current" ? " primary" : ""}`, type: "button", "aria-label": `${s.state === "mastered" ? "Practice again" : "Practice"}: ${s.title}`, onclick: () => startSkill(s.id) }, s.state === "mastered" ? "Practice again" : "Practice"))))))];
};
// District staff management: absences, coverage and shifts.
const localIso = (value) => value ? new Date(value).toISOString() : "";
const staffDateTime = (date, time) => localIso(`${date}T${time}:00`);
const staffField = (label, type, attrs = {}) => {
  const input = h(type === "textarea" ? "textarea" : "input", { type: type === "textarea" ? undefined : type, ...attrs });
  return { input, node: h("label", {}, h("span", {}, label), input) };
};
const staffLead = () => ["superintendent", "it_admin", "principal", "vice_principal"].includes(state.me?.role);
// Superintendents and IT admins have no school on their membership: they choose one for each write.
const staffDistrict = () => ["superintendent", "it_admin"].includes(state.me?.role) && !state.me?.schoolId;
const staffSchools = { list: [] };
const staffSchoolPicker = (id) => {
  const sel = h("select", { id, required: true }, h("option", { value: "" }, "Choose a school"), staffSchools.list.map(x => h("option", { value: x.id }, x.name)));
  return { sel, node: h("label", { for: id }, h("span", {}, "School"), sel), body: () => (sel.value ? { schoolId: sel.value } : {}) };
};
VIEWS.staffing = async () => {
  if (staffDistrict()) staffSchools.list = ((await safe(api.get("/api/schools")))?.data || []).filter(x => x.status !== "inactive");
  const schoolName = (id) => staffSchools.list.find(x => x.id === id)?.name;
  const absenceSchool = staffDistrict() ? staffSchoolPicker("absence-school") : null;
  const response = await api.get("/api/staff-management");
  const d = response.data || { absences: [], shifts: [], coverage: [], staffing: [] };
  const pendingAbsences = d.absences.filter(x => x.status === "pending");
  const date = new Date().toISOString().slice(0, 10);
  const start = staffField("First day", "date", { required: true, value: date });
  const end = staffField("Last day", "date", { required: true, value: date });
  const reason = h("select", {}, ...[["personal","Personal"],["professional_development","Professional development"],["other","Other"]].map(([v,l]) => h("option", { value:v }, l)));
  const absenceForm = h("form", { class: "stack", onsubmit: async e => {
    e.preventDefault();
    if (end.input.value < start.input.value) return toast("End date must be on or after the first day.");
    try { await api.post("/api/staff-management/absences", { startsAt: staffDateTime(start.input.value,"00:00"), endsAt: staffDateTime(end.input.value,"23:59"), reasonCategory: reason.value, ...(absenceSchool?.body() || {}) }); toast("Absence request submitted."); go("staffing", {push:false}); }
    catch { toast("Could not submit absence request."); }
  }}, absenceSchool?.node, start.node, end.node, h("label", {}, h("span", {}, "Category"), reason), h("p", { class:"small muted" }, "Do not include medical details or sensitive personal information."), h("button", { class:"btn primary", type:"submit" }, "Submit absence"));
  const absenceItems = d.absences.map(a => {
    const actions = staffLead() && a.status === "pending" ? h("div", {class:"btns"},
      h("button", {class:"btn primary small", type:"button", onclick:()=>reviewAbsence(a.id,"approved")},"Approve"),
      h("button", {class:"btn danger small", type:"button", onclick:()=>reviewAbsence(a.id,"denied")},"Deny")) : null;
    return h("li", {class:"item"}, h("div", {class:"row"}, h("strong", {class:"grow"}, `${fmtDay(a.starts_at)} – ${fmtDay(a.ends_at)}`), chip(a.status)),
      h("p", {class:"small muted"}, [staffLead() ? a.display_name : null, staffDistrict() ? schoolName(a.school_id) : null, a.reason_category.replaceAll("_"," "), `Submitted ${fmtDay(a.created_at)}`].filter(Boolean).join(" · ")), actions);
  });
  const coverageItems = d.coverage.map(c => {
    const actions = staffLead() && ["pending","approved"].includes(c.status) ? h("div",{class:"btns"},
      h("button",{class:"btn primary small",type:"button",onclick:()=>decideCoverage(c.id,"approved")},"Approve"),
      h("button",{class:"btn danger small",type:"button",onclick:()=>decideCoverage(c.id,"declined")},"Decline")) : null;
    return h("li", {class:"item"}, h("div",{class:"row"},h("strong",{class:"grow"},c.role_needed),chip(c.status)),
      h("p",{class:"small muted"},`${staffDistrict() && schoolName(c.school_id) ? `${schoolName(c.school_id)} · ` : ""}${c.department.replaceAll("_"," ")} · ${fmtDay(c.starts_at)} · ${fmtTime(c.starts_at)}–${fmtTime(c.ends_at)}`), actions);
  });
  const shiftItems = d.shifts.map(x => h("li",{class:"item"},h("div",{class:"row"},h("strong",{class:"grow"},x.display_name||"Staff member"),chip(x.status)),
    h("p",{class:"small muted"},`${fmtDay(x.shift_date)} · ${fmtTime(x.starts_at)}–${fmtTime(x.ends_at)} · ${x.department.replaceAll("_"," ")}`),h("p",{},x.assignment)));
  return [
    h("section", { class:"card hero" }, h("p", {class:"small muted"}, "STAFF OPERATIONS"), h("h2", {}, "Staffing workspace"), h("p", {class:"muted"}, "Manage absence requests, substitute coverage and scheduled shifts.")),
    h("div", { class:"stats" }, stat(d.absences.length,"absence requests"), stat(pendingAbsences.length,"awaiting review",true), stat(d.coverage.length,"coverage requests"), stat(d.shifts.length,"upcoming shifts")),
    h("section", { class:"card" }, h("h2", {}, "Request time away"), absenceForm),
    h("section", { class:"card" }, h("h2", {}, staffLead() ? "Absence requests" : "My absence requests"),
      absenceItems.length ? h("ul", {class:"list"}, absenceItems) : empty("No absence requests to display.")),
    ...(staffLead() ? [coverageRequestForm(date)] : []),
    h("section", {class:"card"}, h("h2", {}, "Substitute coverage"),
      coverageItems.length ? h("ul", {class:"list"}, coverageItems) : empty("No coverage requests.")),
    h("section", {class:"card"}, h("h2", {}, "Upcoming shifts"),
      shiftItems.length ? h("ul",{class:"list"},shiftItems) : empty("No shifts scheduled in the next 30 days."))
  ];
};
async function reviewAbsence(id, decision) {
  try { await api.post(`/api/staff-management/absences/${id}/review`, {decision}); toast(`Absence ${decision}.`); go("staffing",{push:false}); }
  catch { toast("Could not update absence request."); }
}
async function decideCoverage(id, decision) {
  try { await api.post(`/api/staff-management/coverage/${id}/decision`, {decision}); toast(`Coverage ${decision}.`); go("staffing",{push:false}); }
  catch { toast("Could not update coverage request."); }
}
function coverageRequestForm(date) {
  const day = staffField("Coverage date","date",{required:true,value:date});
  const from = staffField("Start time","time",{required:true,value:"08:00"});
  const to = staffField("End time","time",{required:true,value:"15:00"});
  const role = staffField("Role needed","text",{required:true,maxlength:100,placeholder:"e.g. Substitute teacher"});
  const dept = h("select",{}, ...["instruction","transport","facilities","health_office","counseling","meal_service","library","administration","other"].map(v=>h("option",{value:v},v.replaceAll("_"," "))));
  const details = staffField("Notes (non-sensitive)","textarea",{maxlength:500,rows:2});
  const school = staffDistrict() ? staffSchoolPicker("coverage-school") : null;
  return h("section",{class:"card"},h("h2",{},"Request substitute coverage"),h("form",{class:"stack",onsubmit:async e=>{
    e.preventDefault();
    if(to.input.value<=from.input.value)return toast("End time must be after start time.");
    try { await api.post("/api/staff-management/coverage",{startsAt:staffDateTime(day.input.value,from.input.value),endsAt:staffDateTime(day.input.value,to.input.value),department:dept.value,roleNeeded:role.input.value,details:details.input.value,...(school?.body()||{})}); toast("Coverage request created."); go("staffing",{push:false}); }
    catch (err) { toast({ school_required: "Choose a school first.", school_not_in_district: "That school isn't in your district." }[err.body?.error] || "Could not create coverage request."); }
  }},school?.node,day.node,from.node,to.node,role.node,h("label",{},h("span",{},"Department"),dept),details.node,h("button",{class:"btn primary",type:"submit"},"Create coverage request")));
}
VIEWS.news = async () => {
  const list = (await api.get("/api/comms/announcements")).data;
  return [h("h2", {}, "News from school"), h("section", { class: "card" }, announcementsCard(list)),
    h("p", { class: "notice" }, "Students can read school and class news here. Messaging is between families and staff.")];
};
 
// 37.6.0 Clubs & Sports on the live API (#47 / db/051-060). Ticket checkout
// and live video stay disabled until district-approved providers exist.
// Eligibility shows only to the team's coach and the school's athletic
// director, as pass/fail by named district rule; there is no score. Guardians
// e-sign permission slips against the exact text they read.
const ACT_ERRORS = {
  activity_not_found: "That activity isn't available.", grade_eligibility_not_met: "This activity is for other grades.",
  active_student_link_required: "Your account isn't linked to a learner at this school.", permission_slip_closed: "This slip is closed.",
  permission_slip_text_changed: "The slip changed. Reload and read it again.", invalid_signature: "Type your full name and tick the box.",
  invalid_permission_slip: "Add a title, the details (10+ characters) and a due date.", due_date_in_past: "The due date has passed.",
  activity_assignment_required: "Only this activity's staff can do that.", athletic_director_must_be_school_staff: "Choose a staff member of this school.",
  already_athletic_director: "Already an athletic director."
};
const actErr = (e, fallback) => toast(ACT_ERRORS[e?.body?.error] || fallback);
const actList = v => Array.isArray(v) ? v : [];
const ELIG_LABEL = { eligible: "Eligible", not_eligible: "Not eligible", not_enough_records: "Not enough records" };
function slipDecision(d) { return { granted: "✅ Permission given", declined: "❌ Declined", pending: "⏳ Waiting for a guardian" }[d] || d; }

function eligibilityPanel(activity) {
  const box = h("div", { class: "stack" }, h("p", { class: "muted small" }, "Loading eligibility…"));
  api.get(`/api/activities/${activity.id}/eligibility`).then(r => {
    const d = r.data || {}; const pol = d.policy || {};
    box.replaceChildren(
      h("p", { class: "small muted" }, `District rules: at least ${pol.minCoursePercent}% in every active course and ${pol.minAttendancePercent}% attendance over the last ${pol.windowDays} days. Computed now, not stored, not a score.`),
      actList(d.students).length ? h("ul", { class: "list" }, actList(d.students).map(s => h("li", {},
        h("div", { class: "row" }, h("span", { class: "grow" }, h("b", {}, s.name), s.jersey != null ? h("span", { class: "small muted" }, ` · #${s.jersey}`) : null),
          h("span", { class: "small" }, ELIG_LABEL[s.status] || s.status)),
        actList(s.reasons).map(x => h("p", { class: "small muted" }, x.text))))) : h("p", { class: "muted" }, "No one is on the active roster yet."));
  }).catch(() => box.replaceChildren(h("p", { class: "muted small" }, "Eligibility is visible to the team's coach and the athletic director only.")));
  return h("section", { class: "card" }, h("h3", {}, `Eligibility · ${activity.title}`), box);
}

// Clubs & sports operations (db/152): attendance at recent meetings, practices
// and games, and physical clearance dates (no medical details) for a team.
const ATT_LABEL = { present: "Present", late: "Late", excused: "Excused", absent: "Absent" };
function attendancePanel(activity) {
  const box = h("div", { class: "stack" }, h("p", { class: "muted small" }, "Loading events…"));
  const openEvent = async ev => {
    try {
      const d = (await api.get(`/api/events/${ev.id}/attendance`)).data || {};
      const picks = new Map();
      const rowsEl = actList(d.students).map(st => {
        const sel = h("select", { "aria-label": `Attendance: ${st.name}` }, h("option", { value: "" }, "Not marked"),
          Object.entries(ATT_LABEL).map(([v, t]) => h("option", { value: v, selected: st.status === v }, t)));
        picks.set(st.studentId, sel);
        return h("li", { class: "row wrap" }, h("span", { class: "grow" }, h("b", {}, st.name), h("span", { class: "small muted" }, ` · grade ${st.grade}`)), sel);
      });
      const save = async () => {
        const marks = [...picks].filter(([, sel]) => sel.value).map(([studentId, sel]) => ({ studentId, status: sel.value }));
        if (!marks.length) return toast("Mark at least one learner.");
        try { await api.put(`/api/events/${ev.id}/attendance`, { marks }); toast("Attendance saved."); openEvent(ev); }
        catch (e) { toast(e?.body?.error === "event_not_started" ? "Attendance opens when the event starts." : "Couldn't save attendance."); }
      };
      box.replaceChildren(h("h4", {}, `${ev.title} · ${new Date(ev.starts_at).toLocaleString()}`),
        h("p", { class: "small muted" }, `${d.unmarked ?? 0} not marked yet`),
        rowsEl.length ? h("ul", { class: "list" }, rowsEl) : h("p", { class: "muted" }, "No one is on this activity yet."),
        h("div", { class: "btns" }, h("button", { class: "btn primary", type: "button", onclick: save }, "Save attendance"), h("button", { class: "btn", type: "button", onclick: load }, "Back")));
    } catch { box.replaceChildren(h("p", { class: "muted small" }, "Attendance is taken by this activity's staff.")); }
  };
  const load = () => api.get("/api/events").then(r => {
    const now = Date.now();
    const evs = actList(r.data).filter(e => e.activity_id === activity.id && e.status !== "cancelled" && new Date(e.starts_at).getTime() <= now + 3600e3 && new Date(e.starts_at).getTime() >= now - 30 * 864e5).reverse();
    box.replaceChildren(evs.length ? h("ul", { class: "list" }, evs.map(ev => h("li", { class: "row" }, h("span", { class: "grow" }, `${ev.title} · ${new Date(ev.starts_at).toLocaleDateString()}`),
      h("button", { class: "btn small", type: "button", "aria-label": `Take attendance: ${ev.title}`, onclick: () => openEvent(ev) }, "Take attendance"))))
      : h("p", { class: "muted small" }, "No events in the last 30 days."));
  }).catch(() => box.replaceChildren(h("p", { class: "muted small" }, "Couldn't load events.")));
  load();
  return h("section", { class: "card" }, h("h3", {}, `Attendance · ${activity.title}`), box);
}
const PHYS_TEXT = { cleared: ["present", "Physical on file"], expiring: ["expected", "Physical expiring"], expired: ["absent", "Physical expired"], missing: ["absent", "No physical on file"] };
function physicalsPanel(activity, canRecord) {
  const box = h("div", { class: "stack" }, h("p", { class: "muted small" }, "Loading physicals…"));
  const load = () => api.get(`/api/activities/${activity.id}/physicals`).then(r => {
    const d = r.data || {}, sm = d.summary || {};
    box.replaceChildren(
      h("p", { class: "small muted" }, `${sm.cleared ?? 0} on file · ${sm.expiring ?? 0} expiring in 30 days · ${sm.expired ?? 0} expired · ${sm.missing ?? 0} missing. Dates only; no medical details are kept.`),
      actList(d.students).length ? h("ul", { class: "list" }, actList(d.students).map(st => {
        const cleared = h("input", { type: "date", "aria-label": `Cleared on: ${st.name}` }), expires = h("input", { type: "date", "aria-label": `Expires on: ${st.name}` });
        const record = async () => {
          try { await api.post(`/api/students/${st.studentId}/physical-clearance`, { clearedOn: cleared.value, expiresOn: expires.value }); toast("Physical dates recorded."); load(); }
          catch { toast("Check the dates: cleared on must be today or earlier and before the expiry."); }
        };
        return h("li", { class: "stack" }, h("div", { class: "row wrap" }, h("span", { class: "grow" }, h("b", {}, st.name), st.expiresOn ? h("span", { class: "small muted" }, ` · expires ${st.expiresOn}`) : null), chip(...PHYS_TEXT[st.status])),
          canRecord ? h("div", { class: "row wrap" }, cleared, expires, h("button", { class: "btn small", type: "button", onclick: record }, "Record")) : null);
      })) : h("p", { class: "muted" }, "No one is on the active roster yet."));
  }).catch(() => box.replaceChildren(h("p", { class: "muted small" }, "Physicals are visible to the coach, the athletic director and school leaders.")));
  load();
  return h("section", { class: "card" }, h("h3", {}, `Physicals · ${activity.title}`), box);
}

function staffSlipsPanel(activity) {
  const box = h("div", { class: "stack" }, h("p", { class: "muted small" }, "Loading permission slips…"));
  const load = () => api.get(`/api/activities/${activity.id}/permission-slips`).then(r => {
    const slips = actList(r.data);
    box.replaceChildren(slips.length ? h("ul", { class: "list" }, slips.map(s => h("li", {},
      h("div", { class: "row" }, h("span", { class: "grow" }, h("b", {}, s.title), h("p", { class: "small muted" }, `Due ${s.dueOn} · ${s.status}`)),
        s.status === "open" ? h("button", { class: "btn", type: "button", onclick: async () => { try { await api.post(`/api/permission-slips/${s.id}/close`); toast("Slip closed."); load(); } catch (e) { actErr(e, "Could not close the slip."); } } }, "Close") : null),
      h("p", { class: "small" }, `${s.summary?.granted || 0} given · ${s.summary?.declined || 0} declined · ${s.summary?.pending || 0} waiting`),
      h("details", {}, h("summary", { class: "small" }, "By learner"), h("ul", { class: "list" }, actList(s.learners).map(l => h("li", { class: "small" }, `${l.name}: ${slipDecision(l.decision)}`))))))) : h("p", { class: "muted" }, "No slips sent yet."));
  }).catch(() => box.replaceChildren(h("p", { class: "muted small" }, "Permission slips are for this activity's staff.")));
  load();
  const title = h("input", { required: true, maxlength: 120, placeholder: "e.g. Away game at Central" });
  const body = h("textarea", { required: true, maxlength: 4000, rows: 3, placeholder: "Where, when, transport and return time" });
  const due = h("input", { type: "date", required: true });
  const form = h("form", { class: "stack", onsubmit: async e => {
    e.preventDefault();
    try { await api.post(`/api/activities/${activity.id}/permission-slips`, { title: title.value, body: body.value, dueOn: due.value }); toast("Slip sent to families."); form.reset(); load(); }
    catch (err) { actErr(err, "Could not send the slip."); }
  } }, h("label", {}, h("span", {}, "Title"), title), h("label", {}, h("span", {}, "Details guardians will sign"), body), h("label", {}, h("span", {}, "Due"), due),
    h("p", { class: "small muted" }, "The text is fixed once sent. Each signature is bound to it."), h("button", { class: "btn primary", type: "submit" }, "Send permission slip"));
  return h("section", { class: "card" }, h("h3", {}, `Permission slips · ${activity.title}`), box, h("details", {}, h("summary", {}, "New slip"), form));
}

function familyClubApprovalsCard(rows, canApprove) {
  if (!rows.length) return null;
  const act = async (id, decision) => {
    try { await api.post(`/api/activity-memberships/${id}/consent`, { decision }); toast(decision === "active" ? "Club sign-up approved." : "Declined."); go("activities", { push: false }); }
    catch { toast("Couldn't save your answer."); }
  };
  return h("section", { class: "card", "aria-label": "Club sign-ups" },
    h("h2", {}, "Club sign-ups"),
    h("p", { class: "small muted" }, "Clubs need a guardian's OK before high school."),
    h("ul", { class: "list" }, rows.map(r => h("li", { class: "row wrap" },
      h("div", { class: "grow" }, h("b", {}, r.activity_title), r.student_name ? h("span", { class: "small muted" }, ` · ${r.student_name}`) : null),
      chip(r.status === "active" ? "present" : r.status === "declined" ? "absent" : "expected", r.status === "pending" ? "Waiting for guardian" : r.status === "active" ? "Approved" : r.status),
      canApprove && r.status === "pending" ? [
        h("button", { class: "btn small primary", type: "button", onclick: () => act(r.id, "active") }, "Approve"),
        h("button", { class: "btn small", type: "button", onclick: () => act(r.id, "declined") }, "Decline")
      ] : null))));
}
function familySlipsCard(slips, canSign) {
  if (!slips.length) return h("section", { class: "card" }, h("h3", {}, "Permission slips"), h("p", { class: "muted" }, "No permission slips right now."));
  return h("section", { class: "card" }, h("h3", {}, "Permission slips"), h("ul", { class: "list" }, slips.map(s => {
    const name = h("input", { maxlength: 120, autocomplete: "name", placeholder: "Your full name" });
    const ok = h("input", { type: "checkbox" });
    const sign = async decision => {
      try { await api.post(`/api/permission-slips/${s.id}/sign`, { studentId: s.studentId, decision, signedName: name.value, consent: ok.checked, bodySha256: s.bodySha256 }); toast(decision === "granted" ? "Permission given." : "Declined."); go("activities", { push: false }); }
      catch (e) { actErr(e, "Could not save your answer."); }
    };
    return h("li", { class: "stack" },
      h("div", { class: "row" }, h("span", { class: "grow" }, h("b", {}, s.title), h("p", { class: "small muted" }, `${s.activityTitle} · ${s.studentName} · due ${s.dueOn}`)), h("span", { class: "small" }, slipDecision(s.decision))),
      h("p", {}, s.body),
      canSign && s.canSign ? h("div", { class: "stack" },
        h("label", {}, h("span", {}, "Type your full name to sign"), name),
        h("label", { class: "row" }, ok, h("span", {}, "I have read this slip and I am this learner's parent or guardian.")),
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", onclick: () => sign("granted") }, "Give permission"), h("button", { class: "btn", type: "button", onclick: () => sign("declined") }, "Decline"))) : null);
  })));
}

async function athleticDirectorsCard(schoolId) {
  const r = await safe(api.get(`/api/schools/${schoolId}/athletic-directors`));
  const d = r?.data; if (!d || !Array.isArray(d.directors)) return null;
  const pick = h("select", {}, h("option", { value: "" }, "Choose a staff member"), actList(d.candidates).filter(c => !d.directors.some(x => x.userId === c.userId)).map(c => h("option", { value: c.userId }, `${c.name} (${c.role.replaceAll("_", " ")})`)));
  return h("section", { class: "card" }, h("h3", {}, "Athletic directors"),
    h("p", { class: "small muted" }, "Athletic directors manage this school's teams and, with each team's coach, are the only people who see eligibility."),
    d.directors.length ? h("ul", { class: "list" }, d.directors.map(x => h("li", { class: "row" }, h("span", { class: "grow" }, x.name),
      h("button", { class: "btn", type: "button", onclick: async () => { try { await api.post(`/api/athletic-directors/${x.id}/revoke`); toast("Removed."); go("activities", { push: false }); } catch (e) { actErr(e, "Could not remove."); } } }, "Remove")))) : h("p", { class: "muted" }, "None named yet."),
    h("div", { class: "row" }, pick, h("button", { class: "btn primary", type: "button", onclick: async () => {
      if (!pick.value) return toast("Choose a staff member first.");
      try { await api.post(`/api/schools/${schoolId}/athletic-directors`, { userId: pick.value }); toast("Athletic director named."); go("activities", { push: false }); } catch (e) { actErr(e, "Could not name them."); }
    } }, "Name athletic director")));
}

// ---- COACH-02: practice plans and playbooks ------------------------------
const COACH_KIND = { practice: "Practice plan", playbook: "Playbook" };
const ITEM_KIND = { drill: "Drill", play: "Play", note: "Note" };
/** Editable list of drills, plays and notes (used by the plan editor and co-written drafts). */
function planItemsEditor(body, prefix, redraw, field) {
  const items = body.items;
  return h("div", { class: "stack" }, h("h3", {}, "Drills, plays and notes"), h("ol", { class: "plan-blocks" }, items.map((it, i) => {
    const kind = h("select", { id: `${prefix}${i}-kind`, "aria-label": `Kind of item ${i + 1}` }, Object.entries(ITEM_KIND).map(([k, v]) => h("option", { value: k, selected: it.kind === k }, v)));
    kind.addEventListener("change", () => { it.kind = kind.value; });
    return h("li", { class: "card plan-block", "aria-label": `Item ${i + 1}` },
      h("div", { class: "row" }, h("b", { class: "grow" }, `${i + 1}.`), kind,
        h("button", { class: "btn small", type: "button", "aria-label": `Move item ${i + 1} up`, disabled: i === 0, onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; redraw(); } }, "↑"),
        h("button", { class: "btn small", type: "button", "aria-label": `Move item ${i + 1} down`, disabled: i === items.length - 1, onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; redraw(); } }, "↓"),
        items.length > 1 ? h("button", { class: "btn small danger", type: "button", "aria-label": `Remove item ${i + 1}`, onclick: () => { items.splice(i, 1); redraw(); } }, "Remove") : null),
      ...field(it, "title", "Title", `${prefix}${i}-title`, false, 120), ...field(it, "minutes", "Minutes", `${prefix}${i}-minutes`, false, 3),
      ...field(it, "description", "How it runs", `${prefix}${i}-description`, true, 4000), ...field(it, "equipment", "Equipment", `${prefix}${i}-equipment`, false, 300));
  })), items.length < 40 ? h("button", { class: "btn", type: "button", onclick: () => { items.push({ kind: "drill", title: "", minutes: null, description: "", equipment: "" }); redraw(); } }, "Add an item") : null);
}
async function copyCoachingPlan(id) {
  try { const r = (await api.post(`/api/coaching/library/${id}/copy`, {})).data; toast("Copied into your plans."); openView("coachplan", { coachPlanId: r.id, coachPlanEdit: null }); }
  catch { toast("Couldn't copy it."); }
}
VIEWS.coachplan = async () => {
  const id = state.coachPlanId;
  const p = id ? (await api.get(`/api/coaching/plans/${id}`)).data : null;
  const teams = (await safe(api.get("/api/coach/teams")))?.data?.teams || [];
  const ed = state.coachPlanEdit?.key === (id || "new") ? state.coachPlanEdit : (state.coachPlanEdit = { key: id || "new", version: p?.version ?? null, kind: p?.kind || "practice", title: p?.title || "", sport: p?.sport || "", level: p?.level || "All",
    teamId: p?.teamId || "", body: structuredClone(p?.body || { summary: "", items: [{ kind: "drill", title: "", minutes: null, description: "", equipment: "" }] }), notice: null });
  const redraw = () => go("coachplan", { push: false });
  const field = (obj, k, label, fid, multi, max) => { const el = h(multi ? "textarea" : "input", { id: fid, maxlength: max, ...(multi ? { rows: 3 } : {}), ...(k === "minutes" ? { type: "number", min: 0, max: 240, inputmode: "numeric" } : {}) });
    el.value = obj[k] ?? ""; el.addEventListener("input", () => { obj[k] = el.value; }); return [h("label", { for: fid }, label), el]; };
  const kindSel = h("select", { id: "cp-kind", disabled: Boolean(id) }, Object.entries(COACH_KIND).map(([k, v]) => h("option", { value: k, selected: ed.kind === k }, v)));
  kindSel.addEventListener("change", () => { ed.kind = kindSel.value; });
  const teamSel = h("select", { id: "cp-team" }, h("option", { value: "" }, "No team"), teams.filter(t => t.kind === "sport").map(t => h("option", { value: t.id, selected: ed.teamId === t.id }, t.title)));
  teamSel.addEventListener("change", () => { ed.teamId = teamSel.value; });
  const save = async () => {
    const payload = { kind: ed.kind, title: ed.title, sport: ed.sport, level: ed.level || "All", teamId: ed.teamId || null,
      body: { summary: ed.body.summary || null, items: ed.body.items.map(it => ({ ...it, minutes: it.minutes === "" || it.minutes == null ? null : Number(it.minutes) })) } };
    try {
      const r = id ? (await api.req("PUT", `/api/coaching/plans/${id}`, { ...payload, baseVersion: ed.version })).data : (await api.post("/api/coaching/plans", payload)).data;
      state.coachPlanEdit = null; toast("Saved."); openView("coachplan", { coachPlanId: r.id }); return;
    } catch (e) {
      ed.notice = e.body?.error === "plan_incomplete" ? "Give the plan a title and a sport, and every item a title." : e.body?.error === "plan_changed" ? "This plan changed on another device. Reload it to continue." : e.body?.error === "not_your_team" ? "You can attach a plan only to a team you coach here." : "Couldn't save.";
    }
    redraw();
  };
  return [h("button", { class: "btn back", type: "button", onclick: () => { state.coachPlanEdit = null; go("teams"); } }, "‹ My teams"),
    h("h2", {}, id ? ed.title || "Plan" : "New plan"),
    ed.notice ? h("p", { class: "notice warn", role: "status" }, ed.notice) : null,
    p?.adaptedFrom ? h("p", { class: "small muted" }, "Adapted from a plan a colleague shared.") : null,
    h("form", { class: "card stack", "aria-label": "Edit the plan", onsubmit: e => { e.preventDefault(); save(); } },
      h("div", { class: "row wrap" }, h("div", { class: "grow" }, h("label", { for: kindSel.id }, "Kind"), kindSel), h("div", { class: "grow" }, h("label", { for: teamSel.id }, "For team"), teamSel)),
      ...field(ed, "title", "Title", "cp-title", false, 120),
      h("div", { class: "row wrap" }, h("div", { class: "grow" }, ...field(ed, "sport", "Sport", "cp-sport", false, 40)), h("div", { class: "grow" }, ...field(ed, "level", "Level (e.g. JV, Var)", "cp-level", false, 4))),
      ...field(ed.body, "summary", "What it's for", "cp-summary", true, 1000),
      planItemsEditor(ed.body, "cp-i", redraw, field),
      h("button", { class: "btn primary block", type: "submit" }, "Save")),
    id ? h("section", { class: "card", "aria-label": "Share" }, h("h3", {}, "With colleagues"), h("div", { class: "btns" },
      h("button", { class: "btn", type: "button", onclick: async () => {
        const post = confirmNotStudents => api.post(`/api/coaching/plans/${id}/share`, { confirmNotStudents });
        try { await post(false); toast("Shared with coaches across the district."); }
        catch (e) {
          if (e.body?.error !== "may_mention_students") return toast("Couldn't share it.");
          if (await ask({ title: "Does this name a player?", text: `These words match students in the district: ${e.body.words.join(", ")}. Plans shouldn't name players. Edit it, or share if these aren't students.`, confirm: "They aren't students: share", cancel: "Edit first" }))
            try { await post(true); toast("Shared with coaches across the district."); } catch { toast("Couldn't share it."); }
        } } }, "Share with coaches"),
      ["teacher", "principal"].includes(state.me.role) ? h("button", { class: "btn", type: "button", onclick: () => startDraft({ from: "plan", sourceId: id }) }, "Co-write with colleagues") : null,
      h("button", { class: "btn", type: "button", onclick: async () => { if (!(await ask({ title: "Put this plan away?", text: "It leaves your list. Copies colleagues made stay theirs.", confirm: "Put away" }))) return;
        try { await api.post(`/api/coaching/plans/${id}/archive`, {}); state.coachPlanEdit = null; go("teams"); } catch { toast("Couldn't change it."); } } }, "Put away"))) : null];
};
VIEWS.coachlib = async () => {
  const list = (await api.get("/api/coaching/library")).data;
  return [h("button", { class: "btn back", type: "button", onclick: () => go("teams") }, "‹ My teams"), h("h2", {}, "Coaching library"),
    h("p", { class: "muted small" }, "Practice plans and playbooks coaches across the district shared. Copy one into your plans and make it yours."),
    h("section", { class: "card", "aria-label": "Coaching library" }, list.length ? h("ul", { class: "list" }, list.map(m => h("li", {},
      h("b", {}, m.title), h("p", { class: "small muted" }, `${COACH_KIND[m.kind]} · ${m.sport} · ${m.level} · ${m.mine ? "You" : m.author}, ${m.school}${m.copies ? ` · copied ${m.copies}×` : ""}`),
      m.summary ? h("p", { class: "small" }, m.summary) : null,
      h("details", {}, h("summary", {}, `${m.body.items.length} item${m.body.items.length === 1 ? "" : "s"}`, h("span", { class: "sr" }, ` in ${m.title}`)),
        h("ol", {}, m.body.items.map(it => h("li", {}, h("b", {}, `${ITEM_KIND[it.kind]}: ${it.title}`), it.minutes ? ` · ${it.minutes} min` : "", it.description ? h("p", { class: "small" }, it.description) : null)))),
      h("div", { class: "btns" }, h("button", { class: "btn small primary", type: "button", "aria-label": `Copy to my plans: ${m.title}`, onclick: () => copyCoachingPlan(m.id) }, "Copy to my plans"),
        ["teacher", "principal"].includes(state.me.role) ? h("button", { class: "btn small", type: "button", "aria-label": `Co-write from: ${m.title}`, onclick: () => startDraft({ from: "material", sourceId: m.id }) }, "Co-write from") : null))))
      : empty("Nothing shared yet. Share one of your plans to start the library."))];
};
// ---- COACH-01: coaches -----------------------------------------------------
async function manageCoaches(a) {
  const word = a.kind === "sport" ? "coach" : "advisor";
  const staff = (await api.get(`/api/activities/${a.id}/staff`)).data;
  await dialogForm(`${a.kind === "sport" ? "Coaches" : "Advisors"}: ${a.title}`, done => ({ fields: [
    h("p", { class: "small muted" }, `A teacher here, or a teacher at another school in the district, can be this ${a.kind === "sport" ? "team's" : "club's"} ${word}. Someone from another school gets a ${word} profile here that reaches only this ${a.kind === "sport" ? "team" : "club"}.`),
    staff.length ? h("ul", { class: "list" }, staff.map(p => h("li", { class: "row" }, h("span", { class: "grow" }, h("b", {}, p.name), h("br"), h("span", { class: "small muted" }, `${p.home_school || ""}${p.visiting ? " · visiting " + word : ""}`)),
      h("button", { class: "btn small", type: "button", "aria-label": `Remove ${p.name}`, onclick: async () => { if (!(await ask({ title: `Remove ${p.name}?`, text: p.visiting ? `Their ${word} profile at this school ends if this was their last team here.` : "They stay a teacher here.", confirm: "Remove" }))) return;
        try { await api.post(`/api/activities/${a.id}/staff/${p.user_id}/end`, {}); toast("Removed."); done(null); manageCoaches(a); } catch { toast("Couldn't remove them."); } }, hidden: isVP() || undefined }, "Remove"))))
      : empty(`No ${word} yet.`),
    isVP() ? h("p", { class: "small muted" }, `Only the principal assigns ${word}s.`) : h("button", { class: "btn primary", type: "button", onclick: async () => {
      const people = await pickColleagues({ title: `Choose a ${word}`, confirm: "Assign", multiple: false, exclude: staff.map(p => p.user_id) }); if (!people) return;
      try { const r = (await api.post(`/api/activities/${a.id}/staff`, { userId: people[0].user_id, staffRole: word })).data;
        toast(r.coachProfile ? `${people[0].name} can now ${word} here from their ${word} profile.` : `${people[0].name} is the ${word}.`); done(null); manageCoaches(a); }
      catch (e) { toast(e.body?.error === "active_school_teacher_required" ? "Choose a teacher." : "Couldn't assign them."); } } }, `Add a ${word}`)], value: () => undefined }), null);
}
const ELIG_TEXT = { eligible: ["present", "Eligible"], not_eligible: ["absent", "Not eligible"], not_enough_records: ["expected", "Not enough records"] };
const SLIP_TEXT = { granted: ["present", "Slip signed"], declined: ["absent", "Slip declined"], pending: ["expected", "Slip waiting"] };
VIEWS.teams = async () => {
  const d = (await api.get("/api/coach/teams")).data;
  const elsewhere = d.elsewhere.map(e => h("button", { class: "btn block", type: "button", onclick: () => useMembership({ id: e.membership_id }, `Now coaching at ${e.school}`).catch(() => toast("Couldn't switch.")) }, icon("trophy"), `Your teams at ${e.school}`));
  const isTab = tabsFor().some(t => t[0] === "teams");
  const plans = (await safe(api.get("/api/coaching/plans")))?.data || [];
  const planCard = h("section", { class: "card", "aria-label": "Practice plans and playbooks" }, h("h2", {}, "Practice plans & playbooks"),
    plans.length ? h("ul", { class: "list" }, plans.map(p => h("li", { class: "row" }, h("span", { class: "grow" }, h("b", {}, p.title), h("br"),
      h("span", { class: "small muted" }, `${COACH_KIND[p.kind]} · ${p.sport} · ${p.items} item${p.items === 1 ? "" : "s"}${p.minutes ? ` · ${p.minutes} min` : ""}`)),
      h("button", { class: "btn small", type: "button", "aria-label": `Open plan: ${p.title}`, onclick: () => openView("coachplan", { coachPlanId: p.id }) }, "Open"))))
      : h("p", { class: "small muted" }, "Plans you write are yours: drills, plays and notes. Share them with coaches across the district, or write one together."),
    h("div", { class: "btns" }, h("button", { class: "btn primary", type: "button", onclick: () => openView("coachplan", { coachPlanId: null, coachPlanEdit: null }) }, "New plan"),
      h("button", { class: "btn", type: "button", onclick: () => go("coachlib") }, "Coaching library")));
  return [isTab ? null : back("activities", "Clubs & Sports"), h("h2", {}, "My teams"), planCard,
    d.teams.length ? null : h("section", { class: "card" }, empty(d.elsewhere.length ? "You don't coach a team at this school." : "You aren't a coach or advisor yet. A principal assigns coaches.")),
    elsewhere.length ? h("div", { class: "stack" }, elsewhere) : null,
    d.teams.map(t => h("section", { class: "card", "aria-label": t.title },
      h("p", { class: "small muted" }, `${t.kind === "sport" ? "Team" : "Club"} · you're the ${t.role}`), h("h2", {}, t.title),
      t.kind === "sport" ? h("button", { class: "btn small", type: "button", "aria-label": `MaxPreps & Hudl: ${t.title}`, onclick: () => sportsShareDialog(t, true) }, "MaxPreps & Hudl") : null,
      t.meetingDetails ? h("p", { class: "small" }, t.meetingDetails) : null,
      h("h3", {}, "Coming up"), t.events.length ? h("ul", { class: "list" }, t.events.map(e => h("li", {}, h("b", {}, e.title), h("p", { class: "small muted" }, `${new Date(e.starts_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}${e.venue ? ` · ${e.venue}` : ""}`))))
        : h("p", { class: "small muted" }, "Nothing scheduled."),
      t.slip ? h("p", { class: "small" }, `Permission slip “${t.slip.title}”: ${t.slip.granted} signed, ${t.slip.pending} waiting${t.slip.declined ? `, ${t.slip.declined} declined` : ""}.`) : null,
      h("h3", {}, `Roster (${t.roster.length})`), t.roster.length ? h("ul", { class: "list" }, t.roster.map(r => h("li", { class: "row wrap" },
        h("span", { class: "grow" }, `${r.jersey != null ? `#${r.jersey} ` : ""}${r.name}`, h("span", { class: "small muted" }, ` · grade ${r.grade}`)),
        r.eligibility ? chip(...ELIG_TEXT[r.eligibility]) : null, r.slip ? chip(...SLIP_TEXT[r.slip]) : null)))
        : h("p", { class: "small muted" }, "No one on the roster yet."),
      t.plans?.length ? [h("h3", {}, "Plans for this team"), h("ul", { class: "list" }, t.plans.map(p => h("li", { class: "row" }, h("span", { class: "grow" }, `${COACH_KIND[p.kind]}: ${p.title}`),
        h("button", { class: "btn small", type: "button", "aria-label": `Open plan: ${p.title}`, onclick: () => openView("coachplan", { coachPlanId: p.id }) }, "Open"))))] : null,
      t.results.length ? [h("h3", {}, "Recent results"), h("ul", { class: "list" }, t.results.map(x => h("li", { class: "small" }, `${x.title}: vs ${x.opponent} ${x.home_score}–${x.away_score}${x.status === "draft" ? " (waiting for approval)" : ""}`)))] : null,
      h("div", { class: "btns" },
        t.kind === "sport" ? h("button", { class: "btn", type: "button", "aria-label": `Eligibility: ${t.title}`, onclick: e => e.target.closest("section").append(eligibilityPanel({ id: t.id, title: t.title, kind: t.kind })) }, "Eligibility") : null,
        h("button", { class: "btn", type: "button", "aria-label": `Permission slips: ${t.title}`, onclick: e => e.target.closest("section").append(staffSlipsPanel({ id: t.id, title: t.title, kind: t.kind })) }, "Permission slips"),
        h("button", { class: "btn", type: "button", "aria-label": `Attendance: ${t.title}`, onclick: e => e.target.closest("section").append(attendancePanel({ id: t.id, title: t.title, kind: t.kind })) }, "Attendance"),
        t.kind === "sport" ? h("button", { class: "btn", type: "button", "aria-label": `Physicals: ${t.title}`, onclick: e => e.target.closest("section").append(physicalsPanel({ id: t.id, title: t.title, kind: t.kind }, false)) }, "Physicals") : null),
      t.kind === "sport" ? h("p", { class: "small muted" }, "Eligibility is worked out now from the district's rules and isn't stored. Only you and the athletic director see it.") : null))];
};
// Game scheduling and officials assigning happen in Arbiter, which many
// state associations and conferences use. Plain links: EduOS sends nothing
// to Arbiter.
const ARBITER_LINKS = [
  ["Arbiter: sign in", "https://www.arbitersports.com/"],
  ["Game and event scheduling", "https://arbiter.io/products/scheduling/"],
  ["Officials assigning", "https://arbiter.io/products/assigning/"]];
function schedulingOfficialsCard() {
  return h("section", { class: "card", "aria-label": "Scheduling and officials" }, h("h3", {}, "Scheduling & officials"),
    h("p", { class: "small muted" }, "Game schedules and officials' assignments are managed in Arbiter (opens in a new tab). EduOS doesn't send your schedules, rosters or student information there."),
    h("ul", { class: "list" }, ARBITER_LINKS.map(([label, url]) => h("li", {}, h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, label)))));
}
async function activitiesLiveView() {
  const role = state.me.role, family = ["parent", "pupil"].includes(role);
  const staff = ["teacher", "principal", "vice_principal", "superintendent", "it_admin"].includes(role);
  const [acts, events, roles, slips, clubApprovals, commerce] = await Promise.all([
    safe(api.get("/api/activities"), { data: [] }), safe(api.get("/api/events"), { data: [] }),
    staff ? safe(api.get("/api/sports/my-roles"), { data: {} }) : null, family ? safe(api.get("/api/my/permission-slips"), { data: [] }) : null, family ? safe(api.get("/api/my/club-approvals"), { data: [] }) : null,
    safe(api.get("/api/commerce/status"))]);
  const activities = actList(acts?.data), upcoming = actList(events?.data).filter(e => new Date(e.ends_at || e.starts_at) >= new Date()).slice(0, 10);
  const my = roles?.data && !Array.isArray(roles.data) ? roles.data : {};
  const coachOf = new Set(actList(my.coachOf));
  const canSeeEligibility = a => a.kind === "sport" && (coachOf.has(a.id) || my.athleticDirector);
  const canRunSlips = a => role === "principal" || role === "superintendent" || coachOf.has(a.id) || (my.athleticDirector && a.kind === "sport");
  const detail = h("div", { class: "stack", id: "activity-detail" });
  const canRecordPhysicals = role === "principal" || role === "superintendent" || Boolean(my.athleticDirector);
  const open = (a, what) => detail.replaceChildren(what === "eligibility" ? eligibilityPanel(a) : what === "attendance" ? attendancePanel(a) : what === "physicals" ? physicalsPanel(a, canRecordPhysicals) : staffSlipsPanel(a));
  const card = a => h("article", { class: "card", "aria-label": a.title },
    h("div", { class: "row" }, h("span", { class: "grow" }, h("span", { class: "small muted" }, a.kind === "sport" ? "SPORT" : "CLUB"), h("h3", {}, a.title)), h("span", { "aria-hidden": "true" }, a.kind === "sport" ? "🏅" : "🎨")),
    a.description ? h("p", { class: "muted small" }, a.description) : null,
    a.meetingDetails ? h("p", {}, "📅 ", a.meetingDetails) : null,
    h("p", { class: "small muted" }, `${a.memberCount ?? 0} members${a.status !== "published" ? ` · ${a.status}` : ""}`),
    role === "pupil" && a.status === "published" ? h("button", { class: "btn block", type: "button", disabled: a.myStatus === "pending", onclick: async () => { try { const r = await api.post(`/api/activities/${a.id}/join`); toast(r?.data?.status === "pending" ? "Waiting for a parent or guardian to approve." : "You've joined. Staff confirm the roster."); go("activities", { push: false }); } catch (e) { actErr(e, "Could not join."); } } }, a.myStatus === "pending" ? "Waiting for guardian" : a.myStatus === "active" ? "Joined" : "Join") : null,
    canSeeEligibility(a) ? h("button", { class: "btn block", type: "button", onclick: () => open(a, "eligibility") }, "Eligibility") : null,
    staff && canRunSlips(a) ? h("button", { class: "btn block", type: "button", onclick: () => open(a, "slips") }, "Permission slips") : null,
    staff && canRunSlips(a) ? h("button", { class: "btn block", type: "button", "aria-label": `Attendance: ${a.title}`, onclick: () => open(a, "attendance") }, "Attendance") : null,
    staff && a.kind === "sport" && (canRunSlips(a) || canRecordPhysicals) ? h("button", { class: "btn block", type: "button", "aria-label": `Physicals: ${a.title}`, onclick: () => open(a, "physicals") }, "Physicals") : null,
    ["principal", "superintendent"].includes(role) ? h("button", { class: "btn block", type: "button", "aria-label": `${a.kind === "sport" ? "Coaches" : "Advisors"}: ${a.title}`, onclick: () => manageCoaches(a) }, a.kind === "sport" ? "Coaches" : "Advisors") : null,
    a.kind === "sport" ? h("button", { class: "btn block", type: "button", "aria-label": `MaxPreps & Hudl: ${a.title}`,
      onclick: () => sportsShareDialog(a, role === "principal" || role === "vice_principal" || coachOf.has(a.id)) }, "MaxPreps & Hudl") : null);
  const adCard = role === "principal" && state.me.schoolId ? await athleticDirectorsCard(state.me.schoolId) : null;
  return [
    h("div", { class: "row" }, h("div", { class: "grow" }, h("h2", {}, "Clubs & Sports"), h("p", { class: "muted small" }, "Clubs, teams and school events."))),
    my.athleticDirector ? h("p", { class: "notice" }, "You're this school's athletic director.") : null,
    role === "teacher" && coachOf.size ? h("button", { class: "btn primary block", type: "button", onclick: () => go("teams") }, icon("trophy"), "My teams") : null,
    family ? familySlipsCard(actList(slips?.data), role === "parent") : null,
    family ? familyClubApprovalsCard(actList(clubApprovals?.data), role === "parent") : null,
    role === "parent" ? await familySharingCard() : null,
    ["principal", "vice_principal"].includes(role) || my.athleticDirector ? await connectorsCard() : null,
    ["principal", "vice_principal", "superintendent"].includes(role) || my.athleticDirector || coachOf.size ? schedulingOfficialsCard() : null,
    activities.length ? h("div", { class: "grid" }, activities.map(card)) : h("section", { class: "card" }, h("p", { class: "muted" }, "No clubs or teams are published yet.")),
    detail,
    h("section", { class: "card" }, h("h3", {}, "Upcoming events"),
      upcoming.length ? h("ul", { class: "list" }, upcoming.map(e => h("li", { class: "row" }, h("span", { class: "grow" }, h("b", {}, e.title), h("p", { class: "small muted" }, `${new Date(e.starts_at).toLocaleString()}${e.venue ? ` · ${e.venue}` : ""}`))))) : h("p", { class: "muted" }, "No upcoming events."),
      h("p", { class: "notice" }, commerce?.data?.enabled ? `${commerce.data.note || "Paid tickets are on."} Live video is not enabled.`
        : "Paid tickets and live video are not enabled. No payment is collected here."),
      family ? h("button", { class: "btn block", type: "button", onclick: () => go("tickets") }, "Tickets & receipts") : null,
      ["principal", "superintendent", "vice_principal", "teacher"].includes(role) || my.athleticDirector ? h("button", { class: "btn block", type: "button", onclick: () => go("commerce") }, "Ticketing & revenue") : null),
    adCard
  ];
}
VIEWS.activities = activitiesLiveView;

// ---------------- teacher ----------------
VIEWS.dashboard = async () => {
  const [dash, classroomCard] = await Promise.all([api.get("/api/teacher/dashboard"), myClassroomCard()]);
  const d = dash.data || {};
  const ov = d.overview || {}, cl = d.classroom || {}, tr = d.transportation || {};
  const wq = d.workQueue || {}, cn = d.connections || {}, al = d.alerts || {};
  const duties = Array.isArray(d.duties) ? d.duties : [];
  const webTarget = (t) => t;
  const act = async (path, ok, fail, body = {}) => {
    try { await api.post(path, body); toast(ok); go("dashboard", { push: false }); }
    catch (e) { toast(e.body?.error === "independent_receipt_required" ? "A different staff member must confirm this handoff." : fail); }
  };
  const safetyLive = (al.safetyIncidents || []).length;
  const weatherAdvisories = al.weatherPassOn ? (al.weatherAdvisories || []) : [];
  const alertCount = safetyLive + (Number(al.unreadNotifications) || 0) + (Number(al.urgentTasksCount) || 0) + (Number(al.pendingArrivalsCount) || 0) + weatherAdvisories.length;

  return [
    h("section", { class: "card hero", "aria-label": "Teacher dashboard" },
      h("p", { class: "muted small" }, `${d.school?.name || "Your school"} · ${d.date || ""}`),
      h("h2", {}, "Teacher command dashboard"),
      h("p", { class: "muted" }, "Daily overview, work queue, alerts, and shortcuts across your classes and school-day duties."),
      h("div", { class: "btns" },
        h("button", { class: "btn", type: "button", onclick: () => go("dashboard", { push: false }) }, "Refresh"),
        h("button", { class: "btn primary", type: "button", onclick: () => go("classes") }, icon("grid"), "Today in class"))),

    h("div", { class: "stats" },
      stat(ov.students ?? 0, "learners"),
      stat(`${ov.attendanceMarkedToday ?? 0}/${ov.students ?? 0}`, "marked today"),
      stat(wq.toGrade ?? 0, "to grade", true),
      stat(tr.pickupWaitingCount ?? 0, "pick-up queue", true)),

    h("section", { class: "card", "aria-label": "Alerts and safety" },
      h("div", { class: "row" },
        h("h2", { class: "grow" }, "Alerts and time-sensitive notices"),
        chip(alertCount ? "absent" : "present", alertCount ? `${alertCount} active` : "Clear")),
      safetyLive ? h("ul", { class: "list" }, al.safetyIncidents.map(i => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, `${i.kind.toUpperCase()}${i.is_drill ? " (drill)" : ""}`), h("p", { class: "small muted" }, i.instructions || `Status: ${i.status}`)),
        chip("absent", i.status)))) : null,
      weatherAdvisories.length ? [h("h3", {}, "Weather advisories"), h("ul", { class: "list" }, weatherAdvisories.map(w => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, w.event), h("p", { class: "small muted" }, [w.headline, w.instruction, w.expires ? `Until ${timeText(w.expires)}` : null].filter(Boolean).join(" · "))),
        chip(w.level === "warning" ? "absent" : "expected", w.level))))] : null,
      (al.notifications || []).length ? h("ul", { class: "list" }, al.notifications.slice(0, 4).map(n => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, n.title), n.body ? h("p", { class: "small muted" }, n.body) : null),
        n.read_at ? chip("present", "Read") : h("button", { class: "btn small", type: "button", onclick: () => act("/api/notifications/read", "Notification marked read.", "Could not mark the notification read.", { ids: [n.id] }) }, "Mark read")))) : empty("No recent notifications."),
      (tr.pendingArrivals || []).length ? [h("h3", {}, "Arrival handoffs"), h("ul", { class: "list" }, tr.pendingArrivals.slice(0, 5).map(row => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, row.displayName), h("p", { class: "small muted" }, [row.gradeLevel, row.method?.replaceAll("_", " "), row.status].filter(Boolean).join(" · "))),
        h("button", { class: "btn primary small", type: "button", onclick: () => act(`/api/arrival/handoffs/${row.id}/receive`, "Student handoff confirmed. Record first attendance in Classes.", "Could not confirm the handoff.") }, "Confirm handoff"))))] : null,
      h("div", { class: "btns" },
        al.unreadNotifications ? h("button", { class: "btn", type: "button", onclick: () => act("/api/notifications/read", "All notifications marked read.", "Could not mark notifications read.") }, "Mark all read") : null,
        h("button", { class: "btn", type: "button", onclick: () => go("alerts") }, icon("bell"), `Open alerts (${al.unreadNotifications ?? 0})`),
        h("button", { class: "btn", type: "button", onclick: () => go("safety") }, icon("shield"), "Safety status"))),

    h("section", { class: "card", "aria-label": "Daily overview" },
      h("h2", {}, "Today\u2019s schedule and classes"),
      ov.myOpenCases ? h("p", { class: "small" }, `${ov.myOpenCases} student support case(s) need follow-up.`) : null,
      ov.absences7d ? h("p", { class: "small muted" }, `${ov.absences7d} absence event(s) on your roster in the last 7 days.`) : null,
      ov.bellSchedule?.periods?.length ? h("p", { class: "small muted" }, `Bell: ${ov.bellSchedule.name} (${ov.bellSchedule.periods.map(p => `${p.label} ${p.starts}`).slice(0, 4).join(" · ")}${ov.bellSchedule.periods.length > 4 ? " …" : ""})`) : null,
      (ov.scheduleToday || []).length ? h("ul", { class: "list" }, ov.scheduleToday.map(s => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, `${s.starts}–${s.ends} · ${s.label}`), h("p", { class: "small muted" }, s.room)),
        chip(s.now ? "current" : "present", s.now ? "In progress" : "Scheduled")))) : empty("No timetabled periods scheduled for today."),
      (ov.courses || []).length ? h("ul", { class: "list" }, ov.courses.map(c => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, c.title), h("p", { class: "small muted" }, `${c.students} learner(s) · ${c.planId ? (c.planStatus === "ready" ? "Lesson ready" : "Draft plan") : "No lesson plan today"}`)),
        h("div", { class: "btns" },
          h("button", { class: "btn small", type: "button", onclick: () => openView("plan", { planCourseId: c.id, planDate: d.date || localDate(), planEdit: null }) }, icon("calendar"), c.planId ? "Edit plan" : "Plan"),
          c.planId && c.planBlocks ? h("button", { class: "btn small primary", type: "button", onclick: () => openView("present", { planCourseId: c.id, planDate: d.date || localDate(), presentAt: 0 }) }, icon("play"), "Present") : null)))) : empty("No active courses."),
      (ov.upcomingEvents || []).length ? [h("h3", {}, "Upcoming school events"), h("ul", { class: "list" }, ov.upcomingEvents.map(e => h("li", { class: "row wrap" },
        h("span", { class: "grow" }, `${e.title}${e.venue ? ` · ${e.venue}` : ""}`),
        h("span", { class: "small muted" }, fmtDay(e.starts_at)))))] : null),

    h("section", { class: "card", "aria-label": "Work queue" },
      h("h2", {}, "Work queue"),
      h("div", { class: "stats" },
        stat(wq.toGrade ?? 0, "to grade", true),
        stat(wq.quizzesToReview ?? 0, "quiz reviews", true),
        stat(wq.tutoringFlagged ?? 0, "tutoring flags", true),
        stat(wq.incompleteChecklists ?? 0, "checklist items", true)),
      (wq.items || []).length ? h("ul", { class: "list" }, wq.items.map(item => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, item.title), h("p", { class: "small muted" }, item.detail)),
        h("button", { class: "btn small", type: "button", onclick: () => go(webTarget(item.target)) }, "Open")))) : empty("No pending work items right now."),
      (wq.checklistItems || []).length ? [h("h3", {}, "Duty checklist items"), h("ul", { class: "list" }, wq.checklistItems.map(item => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, item.label), h("p", { class: "small muted" }, item.title)),
        h("button", { class: "btn small", type: "button", onclick: () => act(`/api/staff-workspace/checklists/${item.itemId}/complete`, "Checklist item completed.", "Could not complete that checklist item.") }, "Complete"))))] : null,
      h("div", { class: "btns" },
        h("button", { class: "btn primary", type: "button", onclick: () => go("grading") }, icon("check"), "Grading"),
        h("button", { class: "btn", type: "button", onclick: () => go("courses") }, icon("book"), "Courses"),
        h("button", { class: "btn", type: "button", onclick: () => go("copilot") }, icon("spark"), "Christie"),
        h("button", { class: "btn", type: "button", onclick: () => go("contributions") }, icon("book"), "History items"))),

    h("section", { class: "card", "aria-label": "Classroom operations" },
      h("h2", {}, "Classroom operations"),
      h("div", { class: "stats" },
        stat(cl.assignedRooms ?? 0, "assigned rooms"),
        stat(cl.connectedRooms ?? 0, "connected rooms"),
        stat(cl.checkinsToday ?? 0, "check-ins today")),
      classroomCard || ((cl.rooms || []).length ? h("ul", { class: "list" }, cl.rooms.map(r => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, r.name), h("p", { class: "small muted" }, `${r.deviceCount} device(s)${r.paired ? ` · Connected as ${r.controller}` : ""}`)),
        chip(r.paired ? "present" : (r.now ? "current" : "expected"), r.paired ? "Connected" : (r.now ? "Now" : "Not paired"))))) : empty("No classrooms assigned to your timetable.")),
      h("div", { class: "btns" },
        h("button", { class: "btn", type: "button", onclick: () => go("classes") }, icon("grid"), "Room controls & register"))),

    (d.activities?.items || []).length ? h("section", { class: "card", "aria-label": "My clubs and teams" },
      h("h2", {}, "My clubs and teams"),
      h("div", { class: "stats" }, stat(d.activities.count ?? 0, "clubs & teams"), stat(d.activities.attendanceDue ?? 0, "attendance due", true)),
      h("ul", { class: "list" }, d.activities.items.map(x => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, x.title), h("p", { class: "small muted" }, `${x.role === "coach" ? "Coach" : "Advisor"}${x.nextEvent ? ` · next: ${x.nextEvent.title}, ${new Date(x.nextEvent.startsAt).toLocaleString()}` : ""}`)),
        chip(x.attendanceDue ? "expected" : "present", x.attendanceDue ? `${x.attendanceDue} to mark` : "Up to date")))),
      h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: () => go("activities") }, icon("trophy"), "Clubs & Sports"))) : null,

    h("section", { class: "card", "aria-label": "Transportation and duties" },
      h("h2", {}, "Transportation and school-day duties"),
      h("div", { class: "stats" },
        stat(tr.busRidersCount ?? 0, "bus riders"),
        stat(tr.arrivalsPending ?? 0, "arrivals pending", true),
        stat(tr.pickupWaitingCount ?? 0, "waiting pick-up", true)),
      duties.length ? h("ul", { class: "list" }, duties.map(duty => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, duty.label), h("p", { class: "small muted" }, `${duty.shiftsToday} shift(s) · ${duty.checklistsCompleted}/${duty.checklistsTotal} checklist · ${duty.openTasks} open task(s)`)),
        chip(duty.openTasks ? "expected" : "present", duty.openTasks ? `${duty.openTasks} open` : "On track")))) : null,
      h("div", { class: "btns" },
        h("button", { class: "btn", type: "button", onclick: () => go("schoolday") }, icon("bus"), "School day"),
        h("button", { class: "btn", type: "button", onclick: () => go("pickup") }, icon("car"), "Pick-up duty"),
        h("button", { class: "btn", type: "button", onclick: () => go("staffing") }, icon("people"), "Staffing & shifts"))),

    h("section", { class: "card", "aria-label": "Staff connections" },
      h("h2", {}, "Staff connections"),
      h("p", { class: "small muted" }, `${cn.unreadMessages ?? 0} unread message(s) · ${cn.pendingHandoffsCount ?? 0} pending staff handoff(s)`),
      (cn.recentHandoffs || []).length ? h("ul", { class: "list" }, cn.recentHandoffs.map(row => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, row.summary), h("p", { class: "small muted" }, [row.domain?.replaceAll("_", " "), row.next_action].filter(Boolean).join(" · "))),
        row.acknowledged_at ? chip("present", "Acknowledged") : h("button", { class: "btn small", type: "button", onclick: () => act(`/api/staff-workspace/handoffs/${row.id}/acknowledge`, "Handoff acknowledged.", "Could not acknowledge the handoff.") }, "Acknowledge")))) : null,
      (cn.staffAnnouncements || []).length ? h("ul", { class: "list" }, cn.staffAnnouncements.map(a => h("li", { class: "item" },
        h("h3", {}, a.title), h("p", { class: "small muted" }, a.body)))) : null,
      h("div", { class: "btns" },
        h("button", { class: "btn", type: "button", onclick: () => go("messages") }, icon("chat"), "Messages"),
        h("button", { class: "btn", type: "button", onclick: () => go("network") }, icon("people"), "Colleagues & groups")))
  ];
};
VIEWS.schoolday = async () => {
  const [workspace, arrivals, pickup, transport, staffing] = await Promise.all([
    safe(api.get("/api/staff-workspace")),
    safe(api.get("/api/arrival/today")),
    safe(api.get("/api/pickup/queue")),
    safe(api.get("/api/transport/today")),
    safe(api.get("/api/staff-management"))
  ]);
  const ws = workspace?.data || {};
  const tasks = Array.isArray(ws.tasks) ? ws.tasks : [];
  const checklists = Array.isArray(ws.checklists) ? ws.checklists : [];
  const handoffs = Array.isArray(ws.handoffs) ? ws.handoffs : [];
  const riders = transport?.data?.riders || [];
  const waiting = pickup?.data?.waiting || [];
  const shifts = staffing?.data?.shifts || [];
  const arrivalRows = Array.isArray(arrivals?.data) ? arrivals.data : [];
  const busArrivals = arrivalRows.filter(x => x.method === "bus");
  const carArrivals = arrivalRows.filter(x => x.method === "car_rider" || x.method === "walk_in");
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const DUTIES = [
    { domain: "library", label: "Library / media center duty" },
    { domain: "meal_service", label: "Lunchroom duty" },
    { domain: "transport", label: "Transport duty" }
  ];
  const forDomain = (domain) => {
    const domainShifts = shifts.filter(x => x.department === domain && String(x.shift_date || "").slice(0, 10) === todayStr && x.status !== "cancelled");
    const domainChecklists = checklists.filter(x => x.domain === domain);
    const domainTasks = tasks.filter(x => x.domain === domain);
    return { domainShifts, domainChecklists, domainTasks, active: domainShifts.length + domainChecklists.length + domainTasks.length > 0 };
  };
  const showAll = Boolean(state.schoolDayAllDuties);
  const visible = DUTIES.map(d => ({ ...d, ...forDomain(d.domain) })).filter(d => showAll || d.active);
  const completeItem = async (item) => {
    try { await api.post(`/api/staff-workspace/checklists/${item.item_id}/complete`, {}); toast("Checklist item completed."); go("schoolday", { push: false }); }
    catch { toast("Could not complete that checklist item."); }
  };
  const ackHandoff = async (row) => {
    try { await api.post(`/api/staff-workspace/handoffs/${row.id}/acknowledge`, {}); toast("Handoff acknowledged."); go("schoolday", { push: false }); }
    catch { toast("Could not acknowledge the handoff."); }
  };
  const confirmArrival = async (row) => {
    try { await api.post(`/api/arrival/handoffs/${row.id}/receive`, {}); toast("Student handoff confirmed. Record first attendance in Classes."); go("schoolday", { push: false }); }
    catch (e) { toast(e.body?.error === "independent_receipt_required" ? "A different staff member must confirm this handoff." : "Could not confirm the handoff."); }
  };
  const arrivalRow = (row) => h("li", { class: "row wrap" },
    h("div", { class: "grow" }, h("h3", {}, row.display_name), h("p", { class: "small muted" }, [row.grade_level, row.method?.replaceAll("_", " "), row.status, row.initiated_at ? fmtTime(row.initiated_at) : null].filter(Boolean).join(" · "))),
    row.status === "pending"
      ? h("button", { class: "btn primary small", type: "button", onclick: () => confirmArrival(row) }, "Confirm handoff")
      : chip(row.status === "received" ? "present" : "expected", row.status));
  const checklistRows = (items) => items.map(item => h("li", { class: "row wrap" },
    h("div", { class: "grow" }, h("h3", {}, item.label), h("p", { class: "small muted" }, item.title)),
    item.completed_at
      ? chip("present", "Done")
      : h("button", { class: "btn small", type: "button", onclick: () => completeItem(item) }, "Complete")));
  const dutyBoard = (duty) => {
    const done = duty.domainChecklists.filter(x => x.completed_at).length;
    return h("section", { class: "card", "aria-label": duty.label },
      h("div", { class: "row" },
        h("h2", { class: "grow" }, duty.label),
        chip(duty.domainTasks.length ? "expected" : "present", `${duty.domainShifts.length} shift(s) · ${done}/${duty.domainChecklists.length} checklist · ${duty.domainTasks.length} task(s)`)),
      duty.domainShifts.length ? h("ul", { class: "list" }, duty.domainShifts.map(shift => h("li", { class: "item" },
        h("h3", {}, shift.assignment || "Duty assignment"),
        h("p", { class: "small muted" }, `${String(shift.shift_date || "").slice(0, 10)} · ${shift.starts_at || ""}–${shift.ends_at || ""}`)))) : null,
      duty.domainChecklists.length ? [h("h3", {}, "Duty checklist"), h("ul", { class: "list" }, ...checklistRows(duty.domainChecklists))] : null,
      duty.domainTasks.length ? [h("h3", {}, "Open work"), h("ul", { class: "list" }, duty.domainTasks.map(task => h("li", { class: "item" },
        h("h3", {}, task.summary), h("p", { class: "small muted" }, `${task.status}${task.priority ? ` · ${task.priority}` : ""}`))))] : null,
      !duty.domainShifts.length && !duty.domainChecklists.length && !duty.domainTasks.length
        ? empty("No assignments, checklists or tasks are assigned here today.") : null);
  };
  const summary = h("textarea", { required: true, maxlength: 500, rows: 3, placeholder: "What should the next staff member know?" });
  const nextAction = h("input", { maxlength: 300, placeholder: "Suggested next action (optional)" });
  const domain = h("select", {}, ...[["library", "Library / media center"], ["meal_service", "Lunchroom"], ["transport", "Transport"], ["general", "General staff"]].map(([v, l]) => h("option", { value: v }, l)));
  const generalItems = checklists.filter(x => x.domain === "general");

  return [
    h("section", { class: "card hero", "aria-label": "School day" },
      h("h2", {}, "School day"),
      h("p", { class: "muted" }, "Duty boards, arrival confirmations, checklists and staff handoffs for today. Classroom teaching stays in Classes."),
      h("div", { class: "btns" },
        h("button", { class: "btn", type: "button", onclick: () => go("schoolday", { push: false }) }, "Refresh"),
        h("button", { class: "btn", type: "button", onclick: () => go("pickup") }, icon("car"), "Pick-up duty"))),
    h("section", { class: "card", "aria-label": "Duty boards" },
      h("div", { class: "row wrap" },
        h("h2", { class: "grow" }, "Duty boards"),
        seg([["mine", "My duties"], ["all", "All duties"]], showAll ? "all" : "mine", id => { state.schoolDayAllDuties = id === "all"; go("schoolday", { push: false }); })),
      h("p", { class: "small muted" }, showAll
        ? "Showing every Library, Lunchroom and Transport board, including those without an assignment today."
        : "Showing only the boards where you have an active shift, task or checklist. Use All duties to see the rest.")),
    ...visible.map(dutyBoard),
    !visible.length ? empty("You have no Library, Lunchroom or Transport assignments today.") : null,

    h("section", { class: "card", "aria-label": "Bus riders and handoffs" },
      h("h2", {}, "Bus riders and handoffs"),
      riders.length ? h("ul", { class: "list" }, riders.map(r => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, r.display_name), h("p", { class: "small muted" }, [r.bus_label, r.route_name, r.stop_name ? `stop ${r.stop_name}` : null].filter(Boolean).join(" · "))),
        chip(r.status === "boarded" || r.status === "arrived" ? "present" : "expected", r.status || "expected")))) : empty("No bus riders are assigned to your roster."),
      h("h3", {}, "Arrival handoffs awaiting your confirmation"),
      busArrivals.length ? h("ul", { class: "list" }, busArrivals.map(arrivalRow)) : empty("No bus handoffs assigned to you today.")),

    h("section", { class: "card", "aria-label": "Car rider arrivals" },
      h("h2", {}, "Car rider arrivals"),
      carArrivals.length ? h("ul", { class: "list" }, carArrivals.map(arrivalRow)) : empty("No car-rider arrivals assigned to you today.")),

    h("section", { class: "card", "aria-label": "Car rider dismissal" },
      h("h2", {}, "Car rider dismissal"),
      h("p", { class: "small muted" }, `${waiting.length} student release(s) waiting at the school pick-up point. Pass verification and release stay in the dedicated pick-up workflow.`),
      waiting.length ? h("ul", { class: "list" }, waiting.slice(0, 12).map(r => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, r.name || r.display_name), h("p", { class: "small muted" }, r.grade || r.grade_level || "Awaiting authorized release")),
        chip("expected", "Waiting")))) : null,
      h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: () => go("pickup") }, icon("car"), "Open pick-up queue"))),

    h("section", { class: "card", "aria-label": "General staff checklist" },
      h("h2", {}, "General staff checklist"),
      generalItems.length ? h("ul", { class: "list" }, ...checklistRows(generalItems)) : empty("No general staff checklist items are assigned.")),

    h("section", { class: "card", "aria-label": "Staff handoffs" },
      h("h2", {}, "Staff handoffs"),
      handoffs.length ? h("ul", { class: "list" }, handoffs.map(row => h("li", { class: "row wrap" },
        h("div", { class: "grow" }, h("h3", {}, row.summary), h("p", { class: "small muted" }, [row.domain?.replaceAll("_", " "), row.next_action].filter(Boolean).join(" · "))),
        row.acknowledged_at ? chip("present", "Acknowledged")
          : h("button", { class: "btn small", type: "button", onclick: () => ackHandoff(row) }, "Acknowledge")))) : empty("No staff handoffs waiting."),
      h("h3", {}, "Leave a handoff"),
      h("form", { class: "stack", onsubmit: async e => {
        e.preventDefault();
        const text = summary.value.trim();
        if (!text) return toast("A handoff summary is required.");
        try { await api.post("/api/staff-workspace/handoffs", { domain: domain.value, summary: text, nextAction: nextAction.value.trim() }); toast("Handoff left for staff."); go("schoolday", { push: false }); }
        catch { toast("Could not leave the handoff."); }
      }}, h("label", {}, h("span", {}, "Duty area"), domain), summary, nextAction, h("button", { class: "btn primary", type: "submit" }, "Leave handoff")))
  ];
};
VIEWS.classes = async () => {
  const [home, copilot, bus, news, tutoring, classroom] = await Promise.all([safe(api.get("/api/home")), safe(api.get("/api/christie/copilot")), safe(api.get("/api/transport/today")), safe(api.get("/api/comms/announcements")), safe(api.get("/api/christie/review")), myClassroomCard()]);
  const d = home?.data || {};
  const riders = bus?.data?.riders || [];
  const flagged = (tutoring?.data || []).filter(x => x.needs_adult && !x.reviewed_at);
  const gradeCount = Number(d.to_grade) || 0;
  const actionCount = gradeCount + flagged.length;
  const actionCenter = h("section", { class: "card action-center", "aria-label": "Teaching action center" },
    h("div", { class: "row" },
      h("div", { class: "grow" },
        h("h2", {}, "Your next actions"),
        h("p", { class: "small muted" }, actionCount ? `${actionCount} items need your attention` : "No priority items are waiting.")),
      chip(actionCount ? "expected" : "present", String(actionCount))),
    h("ul", { class: "list" },
      h("li", { class: "row action-item" },
        h("div", { class: "grow" },
          h("h3", {}, "Submitted work to grade"),
          h("p", { class: "small muted" }, gradeCount ? "Review learner submissions and record feedback." : "No submitted work is waiting to be graded.")),
        chip(gradeCount ? "expected" : "present", String(gradeCount))),
      h("li", { class: "row action-item" },
        h("div", { class: "grow" },
          h("h3", {}, "Tutoring sessions asking for an adult"),
          h("p", { class: "small muted" }, flagged.length ? "Follow up with learners who requested adult support." : "No tutoring sessions are flagged for adult follow-up.")),
        chip(flagged.length ? "absent" : "present", String(flagged.length)))),
    h("div", { class: "btns" },
      h("button", { class: "btn primary", type: "button", onclick: () => go("grading") }, icon("check"), "Open grading"),
      h("button", { class: "btn", type: "button", onclick: () => go("copilot") }, icon("spark"), "Review tutoring")));
  return [
    h("section", { class: "card hero", "aria-label": "Today" }, h("p", { class: "muted small" }, d.school_name || ""), h("h2", {}, "Today in class"),
      h("p", { class: "muted" }, copilot?.data?.suggestions?.[0] || "")),
    h("div", { class: "stats" }, stat(d.students, "learners"), stat(d.to_grade, "to grade", true), stat(d.open_assignments, "open assignments"), stat(d.absences_7d, "absences (7 days)", true)),
    actionCenter,
    classroom,
    await remoteLessonsCard(),
    await scanCard(),
    await todayCard(),
    await bellScheduleCard(false),
    h("section", { class: "card", "aria-label": "Bus riders" }, h("h2", {}, "Bus riders on my roster"),
      riders.length ? h("ul", { class: "list" }, riders.map(k => h("li", { class: "row" }, h("span", { class: "grow" }, `${k.display_name} · ${k.bus_label} ${k.direction.toUpperCase()}`), chip(k.status)))) : empty("None of your learners ride today.")),
    h("button", { class: "btn block", type: "button", onclick: () => go("pickup") }, icon("car"), "Pick-up duty: check passes"),
    h("section", { class: "card", "aria-label": "Class announcement" }, h("h2", {}, "Post to my class"), announceForm("class")),
    h("section", { class: "card", "aria-label": "Announcements" }, h("h2", {}, "Announcements"), announcementsCard(news?.data, { limit: 5 }))
  ];
};
// ---- TEACH-04: today's classroom material ---------------------------------
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const BLOCK_LABEL = { warmup: "Warm-up question", lesson: "Lesson", assignment: "Assignment or quiz", text: "Instructions", timer: "Timer", link: "Link" };
async function todayCard() {
  const day = localDate();
  const list = (await safe(api.get(`/api/class-plans?date=${day}`)))?.data;
  if (!Array.isArray(list) || !list.length) return null;
  return h("section", { class: "card", "aria-label": "Today's classes" }, h("h2", {}, "Today's classes"),
    h("ul", { class: "list" }, list.map(c => h("li", { class: "row wrap" },
      h("div", { class: "grow" }, h("b", {}, c.title), h("p", { class: "small muted" }, c.plan_id ? `${c.status === "ready" ? "Ready" : "Draft"} · ${c.blocks} step${c.blocks === 1 ? "" : "s"}${c.minutes ? ` · ${c.minutes} min` : ""}` : "Not planned yet")),
      h("div", { class: "btns" },
        h("button", { class: "btn small", type: "button", "aria-label": `${c.plan_id ? "Edit plan" : "Plan"}: ${c.title}`, onclick: () => openView("plan", { planCourseId: c.course_id, planDate: day, planEdit: null }) }, icon("calendar"), c.plan_id ? "Edit plan" : "Plan"),
        c.plan_id && c.blocks ? h("button", { class: "btn small primary", type: "button", "aria-label": `Present: ${c.title}`, onclick: () => openView("present", { planCourseId: c.course_id, planDate: day, presentAt: 0 }) }, icon("play"), "Present") : null)))));
}
VIEWS.plan = async () => {
  if (!state.planCourseId) return VIEWS.classes();
  const date = state.planDate || localDate();
  const d = (await api.get(`/api/class-plans/${state.planCourseId}/${date}`)).data;
  const key = `${state.planCourseId}|${date}`;
  const ed = state.planEdit?.key === key ? state.planEdit : (state.planEdit = { key, version: d.plan?.version ?? null, title: d.plan?.title || "", blocks: structuredClone((d.plan?.blocks || []).map(({ lesson, assignment, ...b }) => b)), notice: null });
  const redraw = () => go("plan", { push: false });
  const lessonName = id => d.choices.lessons.find(l => l.id === id)?.title || "(not in this course)";
  const workName = id => d.choices.assignments.find(a => a.id === id)?.title || "(not in this course)";
  const input = (b, k, label, id, attrs = {}, multi = false) => { const el = h(multi ? "textarea" : "input", { id, ...attrs }); el.value = b[k] ?? ""; el.addEventListener("input", () => { b[k] = el.value; }); return [h("label", { for: id }, label), el]; };
  const blockCard = (b, i) => h("li", { class: "card plan-block", "aria-label": `Step ${i + 1}: ${BLOCK_LABEL[b.kind]}` },
    h("div", { class: "row" }, h("b", { class: "grow" }, `${i + 1}. ${BLOCK_LABEL[b.kind]}`),
      h("button", { class: "btn small", type: "button", "aria-label": `Move step ${i + 1} up`, disabled: i === 0, onclick: () => { [ed.blocks[i - 1], ed.blocks[i]] = [ed.blocks[i], ed.blocks[i - 1]]; redraw(); } }, "↑"),
      h("button", { class: "btn small", type: "button", "aria-label": `Move step ${i + 1} down`, disabled: i === ed.blocks.length - 1, onclick: () => { [ed.blocks[i + 1], ed.blocks[i]] = [ed.blocks[i], ed.blocks[i + 1]]; redraw(); } }, "↓"),
      h("button", { class: "btn small danger", type: "button", "aria-label": `Remove step ${i + 1}`, onclick: () => { ed.blocks.splice(i, 1); redraw(); } }, "Remove")),
    b.kind === "lesson" ? (() => { const sel = h("select", { id: `pb-${i}-l`, "aria-label": `Lesson for step ${i + 1}` }, d.choices.lessons.map(l => h("option", { value: l.id, selected: l.id === b.lessonId }, `Unit ${l.unit_seq} · ${l.title}`)));
        sel.addEventListener("change", () => { b.lessonId = sel.value; }); return sel; })()
    : b.kind === "assignment" ? (() => { const sel = h("select", { id: `pb-${i}-a`, "aria-label": `Assignment for step ${i + 1}` }, d.choices.assignments.map(a => h("option", { value: a.id, selected: a.id === b.assignmentId }, `${a.title}${a.kind === "quiz" ? " (quiz)" : ""}`)));
        sel.addEventListener("change", () => { b.assignmentId = sel.value; }); return sel; })()
    : b.kind === "warmup" ? input(b, "prompt", "Question", `pb-${i}-p`, { maxlength: 500 })
    : b.kind === "text" ? [...input(b, "title", "Heading (optional)", `pb-${i}-t`, { maxlength: 120 }), ...input(b, "body", "What the class should do", `pb-${i}-b`, { maxlength: 4000, rows: 3 }, true)]
    : b.kind === "timer" ? input(b, "label", "What it's for", `pb-${i}-tl`, { maxlength: 80 })
    : [...input(b, "label", "Link name", `pb-${i}-ll`, { maxlength: 120 }), ...input(b, "url", "Address (https://…)", `pb-${i}-lu`, { maxlength: 500, type: "url", inputmode: "url" })],
    h("div", { class: "row" }, h("div", {}, ...input(b, "minutes", b.kind === "timer" ? "Minutes (timer length)" : "Minutes (planned)", `pb-${i}-m`, { type: "number", min: 0, max: 240, inputmode: "numeric", class: "minutes" }))),
    h("details", {}, h("summary", {}, b.note ? "Private note" : "Add a private note"), ...input(b, "note", "Only you see this; it isn't shown when presenting", `pb-${i}-n`, { maxlength: 1000, rows: 2 }, true)));
  const kind = h("select", { id: "pb-add", "aria-label": "Kind of step to add" }, Object.entries(BLOCK_LABEL).filter(([k]) => (k !== "lesson" || d.choices.lessons.length) && (k !== "assignment" || d.choices.assignments.length)).map(([k, v]) => h("option", { value: k }, v)));
  const add = () => { const k = kind.value; ed.blocks.push({ kind: k, minutes: k === "timer" ? 5 : null, note: null,
      ...(k === "lesson" ? { lessonId: d.choices.lessons[0]?.id } : k === "assignment" ? { assignmentId: d.choices.assignments[0]?.id } : k === "warmup" ? { prompt: "" } : k === "text" ? { title: "", body: "" } : k === "timer" ? { label: "" } : { label: "", url: "https://" }) }); redraw(); };
  const save = async status => {
    const body = { title: ed.title || null, status, baseVersion: ed.version, blocks: ed.blocks.map(b => ({ ...b, minutes: b.minutes === "" || b.minutes == null ? null : Number(b.minutes), note: b.note || null })) };
    try { const r = (await api.req("PUT", `/api/class-plans/${state.planCourseId}/${date}`, body)).data; ed.version = r.version; ed.notice = { text: `Saved${status === "ready" ? " and ready to present" : ""}.` }; }
    catch (e) {
      const err = e.body?.error;
      ed.notice = { warn: true, text: err === "plan_changed" ? `${e.body.updatedBy} changed this plan. Reload to see it (your changes here will be replaced).` :
        err === "empty_plan" ? "Add at least one step before marking it ready." : err === "invalid_link" ? `Step ${e.body.index + 1}: links must start with https://` :
        err === "timer_needs_minutes" ? `Step ${e.body.index + 1}: give the timer some minutes.` : err ? `Step ${(e.body.index ?? 0) + 1} isn't complete yet.` : "Couldn't save.", reload: err === "plan_changed" };
    }
    redraw();
  };
  const dateIn = h("input", { id: "plan-date", type: "date", value: date });
  dateIn.addEventListener("change", () => { if (dateIn.value) openView("plan", { planDate: dateIn.value, planEdit: null }); });
  const from = h("input", { id: "plan-from", type: "date" });
  const title = h("input", { id: "plan-title", maxlength: 120, value: ed.title, placeholder: "e.g. Fractions with strips" });
  title.addEventListener("input", () => { ed.title = title.value; });
  const minutes = ed.blocks.reduce((n, b) => n + (Number(b.minutes) || 0), 0);
  return [back("classes", "Classes"),
    h("section", { class: "card hero", "aria-label": "Plan" }, h("p", { class: "small muted" }, `${d.course.subject} · Grade ${d.course.grade_level}`), h("h2", {}, `Plan: ${d.course.title}`),
      h("p", { class: "small" }, `${ed.blocks.length} step${ed.blocks.length === 1 ? "" : "s"}${minutes ? ` · ${minutes} min planned` : ""}${d.plan ? ` · last saved by ${d.plan.updatedBy}` : ""}`)),
    h("div", { class: "row wrap" }, h("div", { class: "grow" }, h("label", { for: dateIn.id }, "Day"), dateIn), h("div", { class: "grow" }, h("label", { for: title.id }, "Plan title (optional)"), title)),
    await remotePlanCard(state.planCourseId, date, d.choices.lessons),
    h("div", { "aria-live": "polite" }, ed.notice ? h("p", { class: `notice${ed.notice.warn ? " warn" : ""}` }, ed.notice.text, ed.notice.reload ? [" ", h("button", { class: "btn small", type: "button", onclick: () => openView("plan", { planEdit: null }) }, "Reload")] : null) : null),
    ed.blocks.length ? h("ol", { class: "plan-blocks" }, ed.blocks.map(blockCard)) : h("section", { class: "card" }, empty("No steps yet. Add a warm-up, a lesson, a timer…"),
      h("form", { class: "row wrap", onsubmit: async e => { e.preventDefault(); if (!from.value) return;
        try { await api.post(`/api/class-plans/${state.planCourseId}/${date}/copy-from`, { fromDate: from.value }); toast("Copied. Change what you need."); openView("plan", { planEdit: null }); }
        catch (err) { toast(err.body?.error === "plan_not_found" ? "No plan on that day." : "Couldn't copy it."); } } },
        h("div", { class: "grow" }, h("label", { for: from.id }, "Or start from another day's plan"), from), h("button", { class: "btn", type: "submit" }, "Use that plan"))),
    h("div", { class: "row wrap" }, h("div", { class: "grow" }, kind), h("button", { class: "btn", type: "button", onclick: add }, "Add step")),
    h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: () => save("draft") }, "Save draft"),
      h("button", { class: "btn primary", type: "button", onclick: () => save("ready") }, "Save as ready"),
      ed.version ? h("button", { class: "btn", type: "button", onclick: () => openView("present", { presentAt: 0 }) }, icon("play"), "Present") : null)];
};
VIEWS.present = async () => {
  if (!state.planCourseId) return VIEWS.classes();
  const date = state.planDate || localDate();
  const d = (await api.get(`/api/class-plans/${state.planCourseId}/${date}`)).data;
  const blocks = d.plan?.blocks || [];
  if (!blocks.length) return [back("plan", "Plan"), empty("This plan has no steps yet.")];
  const i = Math.min(Math.max(state.presentAt || 0, 0), blocks.length - 1), b = blocks[i];
  document.body.classList.add("presenting");
  const move = n => { state.presentAt = Math.min(Math.max(i + n, 0), blocks.length - 1); clearInterval(state.presentTimer); go("present", { push: false }); };
  const exit = () => { clearInterval(state.presentTimer); document.body.classList.remove("presenting"); document.removeEventListener("keydown", state.presentKeys); go("plan", { push: false }); };
  document.removeEventListener("keydown", state.presentKeys);
  state.presentKeys = e => { if (state.tab !== "present") return; if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); move(1); } else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); move(-1); } else if (e.key === "Escape") exit(); };
  document.addEventListener("keydown", state.presentKeys);
  let slide;
  if (b.kind === "warmup") slide = [h("p", { class: "kicker" }, "Warm-up"), h("h1", {}, b.prompt)];
  else if (b.kind === "lesson") slide = b.lesson ? [h("p", { class: "kicker" }, "Lesson"), h("h1", {}, b.lesson.title), h("p", { class: "goal" }, b.lesson.objective), h("div", { class: "lesson-text" }, b.lesson.content.split(/\n+/).map(p => h("p", {}, p)))] : [h("h1", {}, "This lesson isn't available")];
  else if (b.kind === "assignment") slide = b.assignment ? [h("p", { class: "kicker" }, b.assignment.kind === "quiz" ? "Quiz" : "Work"), h("h1", {}, b.assignment.title), b.assignment.instructions ? h("div", { class: "lesson-text" }, b.assignment.instructions.split(/\n+/).map(p => h("p", {}, p))) : null] : [h("h1", {}, "This assignment isn't available")];
  else if (b.kind === "text") slide = [b.title ? h("h1", {}, b.title) : null, h("div", { class: "lesson-text big" }, b.body.split(/\n+/).map(p => h("p", {}, p)))];
  else if (b.kind === "link") slide = [h("p", { class: "kicker" }, "Link"), h("h1", {}, b.label), h("a", { class: "btn primary big", href: b.url, target: "_blank", rel: "noopener noreferrer" }, "Open ", new URL(b.url).host)];
  else {
    const out = h("p", { class: "clock", role: "timer", "aria-live": "off" });
    let left = (state.presentLeft?.i === i ? state.presentLeft.s : b.minutes * 60), running = false;
    const show = () => { out.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`; if (!left) { out.classList.add("done"); clearInterval(state.presentTimer); toggle.textContent = "Time's up"; toggle.disabled = true; } };
    const toggle = h("button", { class: "btn primary big", type: "button", onclick: () => { running = !running; toggle.textContent = running ? "Pause" : "Start";
      clearInterval(state.presentTimer); if (running) state.presentTimer = setInterval(() => { left = Math.max(0, left - 1); state.presentLeft = { i, s: left }; show(); }, 1000); } }, "Start");
    show();
    slide = [h("p", { class: "kicker" }, "Timer"), b.label ? h("h1", {}, b.label) : null, out, toggle];
  }
  return h("section", { class: "present", "aria-label": `Step ${i + 1} of ${blocks.length}` },
    h("div", { class: "present-body" }, slide),
    h("div", { class: "present-bar" }, h("button", { class: "btn", type: "button", onclick: exit }, "Exit"),
      h("span", { class: "grow small" }, `${i + 1} / ${blocks.length}${b.minutes && b.kind !== "timer" ? ` · ${b.minutes} min` : ""}`),
      h("button", { class: "btn", type: "button", "aria-label": "Previous step", disabled: i === 0, onclick: () => move(-1) }, "‹ Previous"),
      h("button", { class: "btn primary", type: "button", "aria-label": "Next step", disabled: i === blocks.length - 1, onclick: () => move(1) }, "Next ›")));
};
function announceForm(scope) {
  const title = h("input", { id: `ann-title-${scope}`, maxlength: 120, required: true });
  const body = h("textarea", { id: `ann-body-${scope}`, maxlength: 4000, required: true });
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api.post("/api/comms/announcements", { scope, title: title.value, body: body.value, audience: scope === "class" ? ["parent", "pupil"] : ["teacher", "parent", "pupil", "driver"] });
      toast(`Posted to ${r.data.recipients} people`); go(state.tab, { push: false });
    } catch (err) { toast(err.status === 429 ? "Too many posts, try again shortly." : "Couldn't post. Check the title and message."); }
  } },
    h("label", { for: title.id }, "Title"), title, h("label", { for: body.id }, "Message"), body,
    h("p", { class: "small muted" }, scope === "class" ? "Goes to your roster's families and students, in the app." : "Goes to everyone at your school, in the app."),
    h("button", { class: "btn primary", type: "submit" }, "Post"));
  return form;
}
VIEWS.grading = async () => {
  const list = (await api.get("/api/assignments")).data.filter(a => a.status === "published" && a.submission_count > 0);
  const subs = (await Promise.all(list.map(a => safe(api.get(`/api/assignments/${a.id}/submissions`), { data: [] }).then(r => r.data.map(s => ({ ...s, assignment: a })))))).flat();
  const queue = subs.filter(s => s.score === null);
  const done = subs.filter(s => s.score !== null);
  const review = (await safe(api.get("/api/learning/review")))?.data || { attempts: [] };
  const courses = (await safe(api.get("/api/learning/courses")))?.data?.courses || [];
  const rubricTodo = [];
  for (const c of courses) {
    const g = await safe(api.get(`/api/learning/courses/${c.id}/gradebook`));
    if (!g) continue;
    g.data.assignments.forEach((a, i) => { if (a.has_rubric) for (const s of g.data.students) if (s.cells[i].status !== "graded") rubricTodo.push({ a, s, course: c.title }); });
  }
  const toReview = review.attempts.filter(x => x.status === "needs_review");
  return [h("h2", {}, "Grading queue"), h("p", { class: "muted small" }, `${toReview.length} quiz${toReview.length === 1 ? "" : "zes"} to review · ${rubricTodo.length} rubric task${rubricTodo.length === 1 ? "" : "s"} · ${queue.length} hand-ins to grade · ${done.length} graded`),
    h("section", { class: "card", "aria-label": "Quizzes to review" }, h("h2", {}, "Quizzes to review"), toReview.length ? h("ul", { class: "list" }, toReview.map(x => h("li", { class: "row" },
      h("div", { class: "grow" }, h("h3", {}, `${x.display_name} · ${x.title}`), h("p", { class: "small muted" }, `${x.course} · attempt ${x.attempt_no} · ${ago(x.submitted_at)}${x.late ? " · late" : ""}`)),
      h("button", { class: "btn primary", type: "button", "aria-label": `Review ${x.display_name}: ${x.title}`, onclick: () => openView("review", { attemptId: x.id }) }, "Review")))) : empty("No open answers waiting.")),
    h("section", { class: "card", "aria-label": "Rubric grading" }, h("h2", {}, "Rubric grading"), rubricTodo.length ? h("ul", { class: "list" }, rubricTodo.slice(0, 30).map(({ a, s, course }) => h("li", { class: "row" },
      h("div", { class: "grow" }, h("h3", {}, `${s.name} · ${a.title}`), h("p", { class: "small muted" }, `${course}${a.due_at ? ` · due ${fmtDay(a.due_at)}` : ""}`)),
      h("button", { class: "btn", type: "button", "aria-label": `Grade ${s.name}: ${a.title}`, onclick: () => openView("rubric", { gradeTarget: { assignmentId: a.id, studentId: s.id, name: s.name } }) }, "Grade")))) : empty("No rubric work waiting.")),
    h("h2", {}, "Hand-ins"),
    queue.length ? queue.map(s => {
      const score = h("input", { id: `score-${s.id}`, type: "number", min: 0, max: 100, inputmode: "numeric", required: true });
      const fb = h("textarea", { id: `fb-${s.id}`, maxlength: 4000 });
      return h("form", { class: "card", "aria-label": `${s.display_name}: ${s.assignment.title}`, onsubmit: async (e) => {
        e.preventDefault();
        try { await api.post(`/api/assignments/${s.assignment.id}/submissions/${s.id}/grade`, { score: Number(score.value), feedback: fb.value }); toast(`Graded ${first(s.display_name)}`); go("grading", { push: false }); }
        catch { toast("Couldn't save that grade."); }
      } }, h("h3", {}, s.display_name), h("p", { class: "small muted" }, `${s.assignment.title} · submitted ${ago(s.submitted_at)}`),
        h("p", {}, s.response_text || "(no text)"),
        h("label", { for: score.id }, "Score (0–100)"), score, h("label", { for: fb.id }, "Feedback"), fb,
        h("button", { class: "btn primary", type: "submit" }, "Save grade"));
    }) : h("section", { class: "card" }, empty("All caught up. Nothing to grade."))];
};
VIEWS.roster = async () => {
  const [roster, copilot] = await Promise.all([api.get("/api/rosters"), safe(api.get("/api/christie/review"))]);
  const sessions = copilot?.data || [];
  const students = [...new Map(roster.data.map(r => [r.student_id, r])).values()];
  return [h("h2", {}, `My roster (${students.length})`), h("section", { class: "card" },
    students.length ? h("ul", { class: "list" }, students.map(r => {
      const mine = sessions.filter(x => x.student_id === r.student_id);
      const flagged = mine.some(x => x.needs_adult && !x.reviewed_at);
      return h("li", {}, h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, r.student_name),
        h("p", { class: "small muted" }, mine.length ? `${mine.length} Christie session${mine.length > 1 ? "s" : ""} · latest ${mine[0].skill_title} ${mine[0].mastery}%` : "No Christie sessions yet")),
        flagged ? chip("absent", "Needs you") : null));
    })) : empty("No learners on your roster."))];
};
VIEWS.copilot = async () => {
  const [c, review] = await Promise.all([api.get("/api/christie/copilot"), api.get("/api/christie/review")]);
  const d = c.data;
  return [
    h("section", { class: "card hero", "aria-label": "Christie copilot" }, h("h2", {}, "Christie copilot"),
      h("ul", { class: "list" }, d.suggestions.map(s => h("li", {}, s))), h("p", { class: "small muted" }, d.note)),
    h("section", { class: "card", "aria-label": "Skills" }, h("h2", {}, "Class mastery by skill"),
      d.bySkill.length ? h("ul", { class: "list" }, d.bySkill.map(k => h("li", {}, h("div", { class: "row" }, h("span", { class: "grow" }, k.title), h("span", { class: "small muted" }, `${k.mastered}/${k.learners} mastered`)), barH(k.avg_mastery, `${k.title}: class average ${k.avg_mastery}%`)))) : empty("No practice data yet.")),
    h("section", { class: "card", "aria-label": "Sessions to review" }, h("h2", {}, "Tutoring sessions"),
      review.data.length ? h("ul", { class: "list" }, review.data.map(x => h("li", {}, h("div", { class: "row" },
        h("div", { class: "grow" }, h("h3", {}, `${x.student_name} · ${x.skill_title}`), h("p", { class: "small muted" }, `${x.solved} solved · ${x.hints} hints · ${ago(x.last_activity_at)}`)),
        x.needs_adult && !x.reviewed_at ? chip("absent", "Asked for an adult") : x.reviewed_at ? chip("present", "Reviewed") : null),
        h("button", { class: "btn", type: "button", onclick: () => openSession(x.id) }, "Read conversation")))) : empty("No sessions yet."))
  ];
};
async function openSession(id) {
  const s = (await api.get(`/api/christie/sessions/${id}`)).data;
  put(
    h("button", { class: "btn", type: "button", onclick: () => go("copilot", { push: false }) }, "‹ Back"),
    h("h2", {}, `${s.studentName} · ${s.skill.title}`), h("p", { class: "small muted" }, `Mastery ${s.mastery}% · provider: ${s.provider}`),
    h("div", { class: "chat" }, s.turns.map(t => h("div", { class: `bubble ${t.speaker === "student" ? "me" : "them"}` }, h("span", { class: "sr" }, t.speaker === "student" ? "Student: " : "Christie: "), t.text, h("span", { class: "meta" }, `${t.kind} · ${fmtTime(t.at)}`)))),
    s.reviewedAt ? h("p", { class: "muted" }, `Reviewed ${ago(s.reviewedAt)}`) : h("button", { class: "btn primary block", type: "button", onclick: async () => { await api.post(`/api/christie/sessions/${id}/review`); toast("Marked reviewed"); go("copilot", { push: false }); } }, "Mark reviewed"));
  $main().focus();
}

// ---------------- family ----------------
async function familyContributionsCard(k) {
  const list = h("div", { class: "stack", "aria-live": "polite" });
  const title = h("input", { type: "text", maxlength: 180, required: true, placeholder: "A family memory title" });
  const body = h("textarea", { maxlength: 12000, rows: 3, placeholder: "Share a memory or milestone (optional)" });
  const localDateTime = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const occurredAt = h("input", { type: "datetime-local", required: true, value: localDateTime() });
  const refresh = async () => {
    const result = await safe(api.get(`/api/family/children/${k.id}/history-contributions`), { data: null });
    if (!result?.data) {
      list.replaceChildren(h("p", { class: "small muted" }, "Family memories are temporarily unavailable."));
      return;
    }
    const items = result.data;
    list.replaceChildren(...(items.length ? items.map(item => h("article", { class: "card" },
      h("div", { class: "row" }, h("strong", {}, item.title), chip(item.status)),
      item.body ? h("p", {}, item.body) : null,
      h("p", { class: "small muted" }, `Memory date: ${fmtDay(item.occurred_at)} · Submitted ${fmtTime(item.created_at)}`),
      item.review_note ? h("p", { class: "small muted" }, `School note: ${item.review_note}`) : null,
      photoStrip(item.photos),
      item.status === "submitted" ? photoAdder(item.id, `/api/family/children/${k.id}/history-contributions/${item.id}/photos`, refresh) : null,
      item.status === "submitted" ? h("button", { class: "btn danger small", type: "button", onclick: async () => {
        if (!await ask({ title: "Withdraw this family memory?", text: "This removes the pending submission from the school review queue.", confirm: "Withdraw", danger: true })) return;
        try {
          await api.req("PATCH", `/api/family/children/${k.id}/history-contributions/${item.id}`, { decision: "withdraw" });
          toast("Family memory withdrawn.");
          await refresh();
        } catch (error) { toast(error.message || "Could not withdraw this contribution."); }
      } }, "Withdraw pending memory") : null
    )) : [h("p", { class: "small muted" }, "No family memories submitted yet.")]));
  };
  const form = h("form", { class: "stack", onsubmit: async event => {
    event.preventDefault();
    try {
      await api.post(`/api/family/children/${k.id}/history-contributions`, {
        title: title.value, body: body.value, occurredAt: new Date(occurredAt.value).toISOString()
      });
      toast("Family memory sent to the school for review.");
      form.reset();
      occurredAt.value = localDateTime();
      await refresh();
    } catch (error) { toast(error.message || "Could not submit this family memory."); }
  } },
    h("label", {}, h("span", {}, "Title"), title),
    h("label", {}, h("span", {}, "Memory"), body),
    h("label", {}, h("span", {}, "When did it happen?"), occurredAt),
    h("p", { class: "small muted" }, "Submissions are visible to you and authorized school reviewers. Approved memories appear in the student's family history."),
    h("button", { class: "btn primary", type: "submit" }, "Submit family memory"));
  await refresh();
  return h("section", { class: "card" }, h("details", {}, h("summary", {}, "Family memories"), form, list));
}

// ---------------- TC-03 teacher contributions ----------------
const HISTORY_REASONS = [["needs_edits", "Needs edits"], ["inaccurate", "Not accurate"], ["privacy_concern", "Privacy concern"],
  ["other_students_identifiable", "Other students can be identified"], ["not_appropriate", "Not appropriate"], ["duplicate", "Duplicate"],
  ["not_relevant", "Not relevant"], ["family_preference", "Family preference"], ["other", "Other"]];
const reasonText = code => (HISTORY_REASONS.find(r => r[0] === code) || [code, code])[1];
const reasonSelect = (options = HISTORY_REASONS.filter(r => r[0] !== "family_preference")) =>
  h("select", {}, h("option", { value: "" }, "Choose a reason"), ...options.map(([v, t]) => h("option", { value: v }, t)));
const ITEM_STATUS = { draft: "Changes requested", submitted: "With the school", approved: "With the family", published: "In the student's history", restricted: "Not shared" };
const DECISION_TEXT = { submitted: "Submitted", approved: "Approved by the school", changes_requested: "Changes requested",
  rejected: "Rejected by the school", accepted: "Accepted by the family", declined: "Declined by the family" };
const ENTRY_TYPES = [["project", "Project"], ["achievement", "Achievement"], ["coursework", "Coursework"], ["event", "Event"], ["reflection", "Reflection"]];
const decisionList = decisions => decisions?.length ? h("ul", { class: "small muted" }, decisions.map(d => h("li", {},
  `${DECISION_TEXT[d.decision] || d.decision}${d.reasonCode ? ` · ${reasonText(d.reasonCode)}` : ""}${d.note ? ` · “${d.note}”` : ""} · ${fmtTime(d.at)}`))) : null;
const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// Teacher: submit items for students on my roster; follow and fix them.
VIEWS.contributions = async () => {
  const [roster, mine] = await Promise.all([safe(api.get("/api/rosters?limit=500"), { data: [] }), api.get("/api/teacher/history-items")]);
  const students = [...new Map((roster?.data || []).map(r => [r.student_id, r.student_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const student = h("select", { required: true }, h("option", { value: "" }, "Choose a student"), ...students.map(([id, name]) => h("option", { value: id }, name)));
  const type = h("select", {}, ...ENTRY_TYPES.map(([v, t]) => h("option", { value: v }, t)));
  const title = h("input", { type: "text", maxlength: 180, required: true, placeholder: "What did the student do?" });
  const body = h("textarea", { maxlength: 12000, rows: 3, placeholder: "Describe it for the family (optional)" });
  const when = h("input", { type: "datetime-local", required: true, value: nowLocal() });
  const form = h("form", { class: "stack", onsubmit: async event => {
    event.preventDefault();
    try {
      await api.post(`/api/students/${student.value}/history/teacher-items`, { title: title.value, body: body.value, entryType: type.value, occurredAt: new Date(when.value).toISOString() });
      toast("Sent to the school for review.");
      go("contributions", { push: false });
    } catch (error) { toast(error.message || "Could not submit this item."); }
  } },
    h("label", {}, h("span", {}, "Student"), student), h("label", {}, h("span", {}, "Kind"), type),
    h("label", {}, h("span", {}, "Title"), title), h("label", {}, h("span", {}, "Details"), body),
    h("label", {}, h("span", {}, "When did it happen?"), when),
    h("p", { class: "small muted" }, "The school reviews it first, then the student's family decides whether to keep it in their history. Don't include other students."),
    h("button", { class: "btn primary", type: "submit", disabled: !students.length }, "Submit for review"));
  const items = (mine.data || []).map(item => {
    let editor = null;
    if (item.status === "draft") {
      const t = h("input", { type: "text", maxlength: 180, required: true, value: item.title });
      const b = h("textarea", { maxlength: 12000, rows: 3 }, item.body || "");
      editor = h("form", { class: "stack", onsubmit: async event => {
        event.preventDefault();
        try {
          await api.req("PATCH", `/api/teacher/history-items/${item.id}`, { title: t.value, body: b.value });
          await api.post(`/api/teacher/history-items/${item.id}/submit`);
          toast("Resubmitted to the school.");
          go("contributions", { push: false });
        } catch (error) { toast(error.message || "Could not resubmit this item."); }
      } }, h("label", {}, h("span", {}, "Title"), t), h("label", {}, h("span", {}, "Details"), b),
        h("button", { class: "btn primary", type: "submit" }, "Save and resubmit"));
    }
    return h("article", { class: "card" },
      h("div", { class: "row" }, h("strong", { class: "grow" }, item.title), h("span", { class: "chip" }, ITEM_STATUS[item.status] || item.status)),
      h("p", { class: "small muted" }, `${item.studentName} · ${fmtDay(item.occurredAt)}`),
      item.body ? h("p", {}, item.body) : null, photoStrip(item.photos),
      ["draft", "submitted"].includes(item.status) ? photoAdder(item.id) : null, decisionList(item.decisions), editor);
  });
  return [h("h2", {}, "Student history items"),
    h("section", { class: "card" }, h("details", { open: !(mine.data || []).length }, h("summary", {}, "Add an item"),
      students.length ? form : empty("No students are on your roster yet."))),
    ...(items.length ? items : [empty("You haven't submitted anything yet.")])];
};

// Reviewer: teacher items waiting for the school.
async function teacherReviewSection() {
  const res = await safe(api.get("/api/history-review"), null);
  if (!res) return null;
  const cards = (res.data || []).map(item => {
    const reason = reasonSelect();
    const note = h("textarea", { rows: 2, maxlength: 1000, placeholder: "Optional note for the teacher" });
    const decide = async decision => {
      if (decision !== "approve" && !reason.value) { toast("Choose a reason first."); reason.focus(); return; }
      const titles = { approve: "Approve and send to the family?", request_changes: "Send back to the teacher for changes?", reject: "Reject this item?" };
      if (!await ask({ title: titles[decision], text: "This decision is recorded in the student's history log.", confirm: "Confirm", danger: decision === "reject" })) return;
      try {
        await api.post(`/api/history-review/${item.id}`, { decision, ...(decision === "approve" ? {} : { reasonCode: reason.value }), note: note.value || undefined });
        toast({ approve: "Approved; the family will decide.", request_changes: "Sent back to the teacher.", reject: "Rejected." }[decision]);
        go("history", { push: false });
      } catch (error) { toast(error.message || "Could not record this decision."); }
    };
    return h("article", { class: "card" },
      h("div", { class: "row" }, h("strong", { class: "grow" }, item.title), h("span", { class: "chip" }, ITEM_STATUS.submitted)),
      h("p", { class: "small muted" }, `${item.studentName} · from ${item.authorName || "a teacher"} · ${fmtDay(item.occurredAt)}`),
      item.body ? h("p", {}, item.body) : null, decisionList(item.decisions),
      h("label", {}, h("span", {}, "Reason (to send back or reject)"), reason),
      h("label", {}, h("span", {}, "Note (optional)"), note),
      h("div", { class: "btns" },
        h("button", { class: "btn primary", type: "button", onclick: () => decide("approve") }, "Approve"),
        h("button", { class: "btn", type: "button", onclick: () => decide("request_changes") }, "Ask for changes"),
        h("button", { class: "btn danger", type: "button", onclick: () => decide("reject") }, "Reject")));
  });
  return [h("h3", {}, "Teacher contributions"), ...(cards.length ? cards : [h("p", { class: "small muted" }, "No teacher items are waiting for review.")])];
}

// Family: teacher items the school approved, waiting for our decision.
async function teacherItemsCard(k) {
  const res = await safe(api.get(`/api/family/children/${k.id}/history-items/pending`), null);
  if (!res) return null;
  const items = res.data || [];
  const cards = items.map(item => {
    const note = h("textarea", { rows: 2, maxlength: 1000, placeholder: "Optional note for the school" });
    const decide = async decision => {
      try {
        await api.post(`/api/family/children/${k.id}/history-items/${item.id}`, { decision, note: note.value || undefined });
        toast(decision === "accept" ? `Added to ${k.display_name}'s history.` : "Declined; it won't be shared.");
        go("children", { push: false });
      } catch (error) { toast(error.message || "Could not record your decision."); }
    };
    return h("article", { class: "card" },
      h("div", { class: "row" }, h("strong", {}, item.title)),
      h("p", { class: "small muted" }, `From ${item.authorName || "a teacher"} · ${fmtDay(item.occurredAt)}`),
      item.body ? h("p", {}, item.body) : null,
      h("label", {}, h("span", {}, "Note (optional)"), note),
      h("div", { class: "btns" },
        h("button", { class: "btn primary", type: "button", onclick: () => decide("accept") }, "Keep in history"),
        h("button", { class: "btn", type: "button", onclick: () => decide("decline") }, "Decline")));
  });
  return h("section", { class: "card" }, h("details", { open: items.length > 0 },
    h("summary", {}, items.length ? `From teachers (${items.length} to decide)` : "From teachers"),
    h("p", { class: "small muted" }, "Teachers' items appear here after the school approves them. Nothing is added to the history until you keep it."),
    ...(cards.length ? cards : [h("p", { class: "small muted" }, "Nothing waiting for you.")])));
}

// ---------------- TC-04 portfolio: a student's accepted history ----------------
const PORTFOLIO_KIND = { official_record: "School record", family_memory: "Family memory", student_portfolio: "My work", teacher_artifact: "From a teacher", system_milestone: "Milestone" };
const PORTFOLIO_TYPE = { achievement: "Achievement", project: "Project", coursework: "Coursework", reflection: "Reflection", event: "Event",
  portfolio_artifact: "Portfolio piece", educator_note: "Teacher note", system_milestone: "Milestone" };
VIEWS.portfolio = async () => {
  const role = state.me.role;
  if (state.me.role === "parent" && state.childId) state.learnerId = state.childId;
  if (role === "parent" && !state.learnerId) {
    const kids = (await api.get("/api/home")).data.children || [];
    if (!kids.length) return empty("No children are linked to your account yet.");
    state.learnerId = kids[0].id;
  }
  const filters = state.portfolioFilters ||= {};
  const query = extra => {
    const p = new URLSearchParams();
    if (role !== "pupil") p.set("studentId", state.learnerId);
    for (const [k, v] of Object.entries({ ...filters, ...extra })) if (v) p.set(k, v);
    return `/api/history/portfolio?${p}`;
  };
  const first = (await api.get(query())).data;
  const f = first.facets;
  const pick = (key, label, values, names) => {
    const sel = h("select", { "aria-label": label, onchange: () => { filters[key] = sel.value || undefined; go("portfolio", { push: false }); } },
      h("option", { value: "" }, label), ...values.map(v => h("option", { value: v, ...(filters[key] === v ? { selected: true } : {}) }, names?.[v] || v)));
    return sel;
  };
  const search = h("input", { type: "search", maxlength: 100, placeholder: "Search titles and notes", "aria-label": "Search history", value: filters.q || "" });
  const controls = h("form", { class: "btns", role: "search", onsubmit: event => { event.preventDefault(); filters.q = search.value.trim() || undefined; go("portfolio", { push: false }); } },
    pick("year", "All school years", f.years), pick("kind", "All kinds", f.kinds, PORTFOLIO_KIND), pick("type", "All types", f.types, PORTFOLIO_TYPE),
    search, h("button", { class: "btn", type: "submit" }, "Search"),
    Object.values(filters).some(Boolean) ? h("button", { class: "btn", type: "button", onclick: () => { state.portfolioFilters = {}; go("portfolio", { push: false }); } }, "Clear") : null);

  const list = h("div", { class: "stack" });
  const sections = new Map();
  const card = item => h("li", { class: "card" },
    h("div", { class: "row" }, h("strong", { class: "grow" }, item.title), h("span", { class: "chip" }, PORTFOLIO_TYPE[item.entryType] || item.entryType)),
    h("p", { class: "small muted" }, `${fmtDay(item.occurredAt)} · ${PORTFOLIO_KIND[item.kind] || item.kind}${item.authorName ? ` · ${item.authorName}` : ""}${item.transferredFrom ? ` · from ${item.transferredFrom}` : ""}`),
    item.body ? h("p", {}, item.body) : null, photoStrip(item.photos));
  const add = items => {
    for (const item of items) {
      let ul = sections.get(item.schoolYear);
      if (!ul) {
        const id = `year-${sections.size}`;
        ul = h("ul", { class: "stack", "aria-labelledby": id });
        sections.set(item.schoolYear, ul);
        list.append(h("section", {}, h("h3", { id }, `School year ${item.schoolYear}`), ul));
      }
      ul.append(card(item));
    }
  };
  add(first.items);
  let cursor = first.nextCursor;
  const more = h("button", { class: "btn block", type: "button", onclick: async () => {
    more.disabled = true;
    try {
      const next = (await api.get(query({ cursor }))).data;
      add(next.items); cursor = next.nextCursor;
      if (!cursor) more.remove(); else more.disabled = false;
    } catch (error) { more.disabled = false; toast(error.message || "Could not load more."); }
  } }, "Show more");
  const filtered = Object.values(filters).some(Boolean);
  return [h("h2", {}, role === "pupil" ? "My history" : `${first.student.name}'s history`),
    h("p", { class: "small muted" }, `${f.total} item${f.total === 1 ? "" : "s"} in the history. Only items that were accepted into it appear here.`),
    f.total ? controls : null,
    first.items.length ? list : empty(filtered ? "Nothing matches these filters." : "Nothing in the history yet."),
    cursor ? more : null,
    historyDownloadCard(first.student.id, role),
    ["parent", "pupil"].includes(role) ? await familyTransferCard(first.student.id) : null,
    await familyStorageCard(first.student.id, role),
    await donationCard(role),
    await studentSharingCard(first.student.id)];
};
// ---- TC-11: family storage dashboard ---------------------------------------
async function familyStorageCard(studentId, role) {
  if (!["parent", "pupil"].includes(role)) return null;
  const d = (await safe(api.get(`/api/history/storage?studentId=${encodeURIComponent(studentId)}`)))?.data;
  if (!d?.usage) return null;
  const mb = n => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${(n / 1048576).toFixed(1)} MB`;
  const opens = x => x.opens.on ? `opens ${fmtDay(x.opens.on)}` : `opens at ${MILESTONE_TEXT[x.opens.milestone] || "a milestone"}`;
  const c = d.myContributions;
  return h("section", { class: "card", "aria-label": "Storage and preservation" }, h("h3", {}, `Storage: ${mb(d.usage.usedBytes)} of ${mb(d.limits.maxBytesPerStudent)} used`),
    h("progress", { max: 100, value: d.usage.percent, "aria-label": `${d.usage.percent}% of the district's limit used` }),
    h("p", { class: "small" }, `${d.usage.photos} photo${d.usage.photos === 1 ? "" : "s"}${d.usage.inLongTermStorage ? ` (${d.usage.inLongTermStorage} in long-term storage, still opens normally)` : ""}. `,
      d.limits.photosAllowed ? `Up to ${mb(d.limits.maxPhotoBytes)} per photo and ${d.limits.maxPhotosPerItem} per item.` : "Photos aren't turned on in this district yet.",
      d.usage.roomForAnotherPhoto ? "" : " The limit is reached: no more photos can be added."),
    h("p", { class: "small muted" }, "The district sets the same limit for every student. It can't be raised by payment or donation."),
    h("ul", { class: "list small" }, kv("In the history", String(d.items.inHistory)), kv("Waiting for school review", String(d.items.waitingForReview)), kv("Drafts", String(d.items.drafts)),
      c ? kv("Your memories", `${c.accepted} accepted · ${c.waiting} waiting · ${c.declined} declined`) : null),
    d.capsules.length ? [h("h4", {}, "Your Time Capsules"), h("ul", { class: "list small" }, d.capsules.map(x => h("li", {}, `${x.title} · ${{ draft: "draft", sealed: "sealed", scheduled: "sealed", released: "opened" }[x.status] || x.status}${x.status === "released" ? "" : ` · ${opens(x)}`}`)))] : null,
    h("h4", {}, "How long it's kept"), h("p", { class: "small" }, d.retention.text, d.retention.recordsScheduleRef ? ` District schedule: ${d.retention.recordsScheduleRef}.` : ""),
    h("h4", {}, "Saving space"), h("ul", { class: "list small" }, d.guidance.map(g => h("li", {}, g))),
    h("p", { class: "small muted" }, d.donations.text));
}
// ---- TC-09: voluntary gifts toward preservation (sandbox only) ----------------
async function donationCard(role) {
  if (role !== "parent") return null;
  const st = (await safe(api.get("/api/donations/status")))?.data;
  if (!st?.enabled || !Array.isArray(st.methods)) return null;
  const mine = (await safe(api.get("/api/donations/mine")))?.data || [];
  const fund = (await safe(api.get("/api/preservation-fund")))?.data;
  const amount = h("input", { id: "don-amt", type: "number", min: st.minCents / 100, max: st.maxCents / 100, step: "1", value: (st.suggestedCents[0] || st.minCents) / 100, style: "width:7em" });
  const where = h("select", { id: "don-where" }, h("option", { value: "" }, "The whole district"), (st.schools || []).map(x => h("option", { value: x.id }, x.name)));
  const anon = h("input", { id: "don-anon", type: "checkbox" });
  // TC-13: once, monthly or yearly (sandbox only; the donor can cancel any time).
  const freqs = Array.isArray(st.frequencies) && st.frequencies.length ? st.frequencies : ["one_time"];
  const FREQ = { one_time: "Once", monthly: "Every month", yearly: "Every year" };
  const freq = h("select", { id: "don-freq" }, freqs.map(f => h("option", { value: f }, FREQ[f] || f)));
  const schedules = freqs.length > 1 ? (await safe(api.get("/api/donations/schedules/mine")))?.data || [] : [];
  const cancelSchedule = async x => {
    const yes = await dialogForm(`Stop your ${x.frequencyLabel.toLowerCase()} gift of ${money(x.amountCents)}?`, () => ({
      fields: [h("p", { class: "small" }, "No more charges will be made. Past gifts and their records stay.")], value: () => true }), "Stop gift");
    if (!yes) return;
    try { await api.post(`/api/donations/schedules/${x.id}/cancel`, {}); toast("Stopped. No more charges."); go(state.tab, { push: false }); } catch { toast("Couldn't stop it."); }
  };
  const feeLine = h("span", {});
  const fee = () => { const c = Math.round(Number(amount.value) * 100); feeLine.textContent = c > 0 ? `Estimated fee ${money(Math.round(c * 0.029) + 30)}, so about ${money(Math.max(0, c - Math.round(c * 0.029) - 30))} reaches the fund.` : ""; return feeLine; };
  amount.addEventListener("input", fee);
  const give = async () => {
    const cents = Math.round(Number(amount.value) * 100);
    if (!(cents >= st.minCents && cents <= st.maxCents)) return toast(`Choose between ${money(st.minCents)} and ${money(st.maxCents)}.`);
    try {
      const g = (await api.post("/api/donations", { amountCents: cents, schoolId: where.value || null, anonymous: anon.checked, frequency: freq.value, idempotencyKey: `web-${crypto.randomUUID()}` })).data;
      const r = (await api.post(`/api/donations/${g.id}/confirm`, { testOutcome: "sandbox_success" })).data;
      toast(r.acknowledgement ? `Thank you. Test gift recorded as ${r.acknowledgement.number}.${g.schedule ? ` It repeats ${g.schedule.frequency === "monthly" ? "every month" : "every year"} until you stop it.` : ""}` : "The test gift didn't go through.");
      go(state.tab, { push: false });
    } catch { toast("Couldn't record the gift."); }
  };
  return h("section", { class: "card", "aria-label": "Support preservation" }, h("h3", {}, "Support preservation"),
    h("p", { class: "small" }, st.statement),
    h("p", { class: "small muted" }, "Test mode: gifts go through the sandbox and no money moves. ", st.fees || "", " ", st.help || ""),
    h("p", { class: "small", "aria-live": "polite" }, fee()),
    h("div", { class: "btns" }, st.suggestedCents.map(c => h("button", { class: "btn small", type: "button", onclick: () => { amount.value = c / 100; fee(); } }, money(c)))),
    h("div", { class: "row wrap" }, h("div", {}, h("label", { for: "don-amt" }, "Amount ($)"), amount), h("div", {}, h("label", { for: "don-where" }, "For"), where),
      freqs.length > 1 ? h("div", {}, h("label", { for: "don-freq" }, "How often"), freq) : null,
      h("label", { for: "don-anon", class: "small" }, anon, " Don't show my name in district reports")),
    h("button", { class: "btn primary small", type: "button", onclick: give }, "Give (test)"),
    fund ? fundAbout(fund) : null,
    schedules.length ? [h("h4", {}, "Your recurring gifts"), h("ul", { class: "list small" }, schedules.map(x => h("li", { class: "row wrap" },
      h("span", { class: "grow" }, `${money(x.amountCents)} ${x.frequencyLabel.toLowerCase()} · ${x.designation.name || "District"} · ${scheduleStatus(x)}`),
      x.canCancel ? h("button", { class: "btn small", type: "button", "aria-label": `Stop ${x.frequencyLabel.toLowerCase()} gift of ${money(x.amountCents)}`, onclick: () => cancelSchedule(x) }, "Stop") : null)))] : null,
    mine.length ? [h("h4", {}, "Your gifts"), h("ul", { class: "list small" }, mine.map(g => h("li", {}, `${money(g.amountCents)} · ${g.designation.name || "District"} · ${g.status}${g.installment ? ` · charge ${g.installment}` : ""}${g.acknowledgement ? ` · ${g.acknowledgement.number}` : ""}${g.refundNotice ? ` · refund ${g.refundNotice.number}` : ""}`)))] : null);
}
function scheduleStatus(x) {
  return { pending: "starting", active: `next charge ${x.nextChargeOn}`, failed: "first payment didn't go through", cancelled: "stopped", stopped: "stopped after declined payments" }[x.status] || x.status;
}
async function donationSettingsCard() {
  const s = (await safe(api.get("/api/donations/settings")))?.data;
  if (!s || typeof s.enabled !== "boolean") return null;
  const report = (await safe(api.get("/api/donations")))?.data;
  const on = h("input", { id: "ds-on", type: "checkbox", checked: s.enabled || undefined });
  const min = h("input", { id: "ds-min", type: "number", min: 1, value: s.minCents / 100, style: "width:6em" });
  const max = h("input", { id: "ds-max", type: "number", min: 1, value: s.maxCents / 100, style: "width:7em" });
  const sugg = h("input", { id: "ds-sugg", value: s.suggestedCents.map(c => c / 100).join(", "), style: "width:12em" });
  const ack = h("textarea", { id: "ds-ack", rows: 2, maxlength: 1000 }, s.acknowledgementText);
  const taxOn = h("input", { id: "ds-tax-on", type: "checkbox", checked: s.taxWordingEnabled || undefined });
  const rec = h("input", { id: "ds-rec", type: "checkbox", checked: s.recurringEnabled !== false || undefined });
  const tax = h("textarea", { id: "ds-tax", rows: 2, maxlength: 1000, placeholder: "Only wording your district's advisers approved" }, s.taxWording || "");
  const t = report?.totals;
  return h("section", { class: "card", "aria-label": "Preservation gifts" }, h("h3", {}, "Preservation gifts"),
    h("p", { class: "small muted" }, "Voluntary gifts from families and staff, never from students. Sandbox only for now: no money moves. Gifts never change storage limits."),
    t ? h("p", { class: "small" }, `${t.gifts} gift${t.gifts === 1 ? "" : "s"} · ${money(t.grossCents)} given · ${money(t.feesCents)} processing · ${money(t.netCents)} net`) : null,
    h("label", { for: "ds-on", class: "small" }, on, " Accept gifts"),
    h("label", { for: "ds-rec", class: "small" }, rec, " Let donors give monthly or yearly (sandbox charges; donors can stop any time)"),
    h("div", { class: "row wrap" }, h("div", {}, h("label", { for: "ds-min" }, "Smallest ($)"), min), h("div", {}, h("label", { for: "ds-max" }, "Largest ($)"), max),
      h("div", {}, h("label", { for: "ds-sugg" }, "Suggested ($, commas)"), sugg)),
    h("label", { for: "ds-ack" }, "Acknowledgement text"), ack,
    h("label", { for: "ds-tax-on", class: "small" }, taxOn, " Add tax-receipt wording to acknowledgements"),
    h("label", { for: "ds-tax" }, "Tax-receipt wording"), tax,
    h("p", { class: "small muted" }, "EduOS makes no claim that a gift is tax-deductible. Add wording only after your district's own advice."),
    h("button", { class: "btn small", type: "button", onclick: async () => {
      try {
        await api.put("/api/donations/settings", { enabled: on.checked, minCents: Math.round(Number(min.value) * 100), maxCents: Math.round(Number(max.value) * 100),
          suggestedCents: sugg.value.split(",").map(v => v.trim()).filter(Boolean).map(v => Math.round(Number(v) * 100)),
          acknowledgementText: ack.value, taxWordingEnabled: taxOn.checked, taxWording: tax.value.trim() || null, recurringEnabled: rec.checked });
        toast("Saved."); go(state.tab, { push: false });
      } catch { toast("Couldn't save. Check the amounts and wording."); } } }, "Save"));
}
// ---- TC-10: gift accounts for the superintendent and named finance reviewers ----
async function donationAccountsCard() {
  if (!(await safe(api.get("/api/donations/finance/access")))?.data?.finance) return null;
  const today = new Date().toISOString().slice(0, 10), from = `${today.slice(0, 7)}-01`;
  const [rep, list, recs, people, sch] = await Promise.all([safe(api.get(`/api/donations/reconciliation?from=${from}&to=${today}`)), safe(api.get("/api/donations")),
    safe(api.get("/api/donations/reconciliations")), state.me.role === "superintendent" ? safe(api.get("/api/donations/finance/reviewers")) : null,
    safe(api.get("/api/donations/schedules"))]);
  const r = rep?.data, gifts = list?.data?.gifts || [], done = recs?.data || [], ppl = people?.data;
  const scheds = (sch?.data?.schedules || []).filter(x => x.status === "active" || x.status === "pending");
  const reload = () => go(state.tab, { push: false });
  const refund = async g => {
    const reason = await dialogForm(`Refund ${money(g.amountCents)} from ${g.donor}`, () => ({ fields: [
      h("p", { class: "small" }, `The full ${money(g.amountCents)} goes back to the donor. The processor keeps its ${money(g.processingFeeCents)} fee. Test mode: no money moves.`),
      h("label", { for: "rf-r" }, "Reason"), h("input", { id: "rf-r", required: true, minlength: 5, maxlength: 500 })],
      value: () => document.getElementById("rf-r").value.trim() }), "Refund");
    if (!reason) return;
    try { const x = (await api.post(`/api/donations/${g.id}/refund`, { reason })).data; toast(`Refunded. Notice ${x.number}.`); reload(); }
    catch (e) { toast(e?.body?.error === "own_gift" ? "Someone else has to refund your own gift." : "Couldn't refund it. The reason needs at least 5 characters."); }
  };
  const signOff = async () => {
    try { const x = (await api.post("/api/donations/reconciliations", { from, to: today })).data; toast(x.matched ? "Signed off: the books match." : "Signed off with differences recorded."); reload(); }
    catch (e) { toast(e?.body?.error === "separation_of_duties" ? "You recorded a refund in this period, so someone else signs it off." : "Couldn't sign it off."); }
  };
  const pick = ppl ? h("select", { id: "fr-u" }, h("option", { value: "" }, "Choose a school secretary"), ppl.staff.filter(x => !ppl.reviewers.some(y => y.userId === x.id)).map(x => h("option", { value: x.id }, x.name))) : null;
  const setReviewer = async (userId, on) => {
    if (!userId) return toast("Choose someone first.");
    try { await api.put(`/api/donations/finance/reviewers/${userId}`, { on }); toast(on ? "Named." : "Removed."); reload(); } catch { toast("Couldn't change reviewers."); }
  };
  return h("section", { class: "card", "aria-label": "Gift accounts" }, h("h3", {}, "Gift accounts"),
    h("p", { class: "small muted" }, "Sandbox only: no money moves. Nobody refunds their own gift, and whoever records a refund doesn't sign off that period."),
    r ? [h("h4", {}, `This month (${from} to ${today}, UTC)`),
      h("ul", { class: "list small" }, kv("Gifts", `${r.gifts} · ${money(r.grossCents)}`), kv("Processing fees", money(r.feesCents)), kv("Refunds", `${r.refunds} · ${money(r.refundedCents)}`),
        kv("Net", money(r.netCents)), kv("Ledger", `${r.ledgerLines} lines · ${money(r.ledgerNetCents)}`)),
      h("p", { class: "small", role: "status" }, r.matched ? "The gift records and the ledger match." : `${r.discrepancies.length} difference${r.discrepancies.length === 1 ? "" : "s"} between the gift records and the ledger.`),
      r.canSignOff ? h("button", { class: "btn small", type: "button", onclick: signOff }, "Sign off this month") : h("p", { class: "small muted" }, r.signOffBlocked)] : null,
    done.length ? [h("h4", {}, "Signed off"), h("ul", { class: "list small" }, done.slice(0, 5).map(x => h("li", {}, `${x.periodStart} to ${x.periodEnd} · ${x.matched ? "matched" : "differences recorded"} · ${x.reconciledBy}`)))] : null,
    gifts.length ? [h("h4", {}, "Recent gifts"), h("ul", { class: "list small" }, gifts.slice(0, 20).map(g => h("li", { class: "row wrap" },
      h("span", { class: "grow" }, `${money(g.amountCents)} · ${g.donor} · ${g.status}${g.acknowledgement ? ` · ${g.acknowledgement.number}` : ""}${g.refundNotice ? ` · ${g.refundNotice.number}` : ""}`),
      g.status === "succeeded" ? h("button", { class: "btn small", type: "button", "aria-label": `Refund ${money(g.amountCents)} from ${g.donor}`, onclick: () => refund(g) }, "Refund") : null)))] : null,
    scheds.length ? [h("h4", {}, "Recurring gifts"), h("ul", { class: "list small" }, scheds.slice(0, 20).map(x =>
      h("li", {}, `${money(x.amountCents)} ${x.frequencyLabel.toLowerCase()} · ${x.donor} · ${x.charges} charge${x.charges === 1 ? "" : "s"} · ${scheduleStatus(x)}`)))] : null,
    ppl ? [h("h4", {}, "Finance reviewers"), h("p", { class: "small muted" }, "School secretaries you designate can see the gift accounts, refund gifts and sign off periods, while signed in as school secretary."),
      ppl.reviewers.length ? h("ul", { class: "list small" }, ppl.reviewers.map(x => h("li", { class: "row wrap" }, h("span", { class: "grow" }, x.name),
        h("button", { class: "btn small", type: "button", "aria-label": `Remove ${x.name}`, onclick: () => setReviewer(x.userId, false) }, "Remove")))) : h("p", { class: "small" }, "No reviewers yet."),
      h("div", { class: "row wrap" }, h("label", { for: "fr-u", class: "sr-only" }, "School secretary"), pick, h("button", { class: "btn small", type: "button", onclick: () => setReviewer(pick.value, true) }, "Name reviewer"))] : null);
}
// ---- TC-12: the district preservation fund ----------------
const FUND_STATUS = { pending: "Waiting for approvals", approved: "Approved, not yet paid", rejected: "Rejected", withdrawn: "Withdrawn", cancelled: "Cancelled", paid: "Paid" };
function fundAbout(f) {
  const sm = f.summary || {};
  return [h("h4", {}, `About the ${f.fundName}`), h("p", { class: "small" }, f.purpose), h("p", { class: "small muted" }, f.limits),
    h("ul", { class: "list small" }, kv("Can pay for", f.eligibleCategories.map(c => c.label).join(", ")), f.allocationRules ? kv("How money is allocated", f.allocationRules) : null,
      kv("Who decides", `${f.governanceText ? `${f.governanceText} ` : ""}${f.approvalRule}`), f.refundPolicy ? kv("Refunds", f.refundPolicy) : null,
      sm.shown ? kv("So far", `${money(sm.givenCents)} given · ${money(sm.feesCents)} in fees · ${money(sm.spentCents)} spent`) : null)];
}
async function fundSettingsCard() {
  const s = (await safe(api.get("/api/preservation-fund/settings")))?.data;
  if (!s || typeof s.enabled !== "boolean") return null;
  const chk = (id, on) => h("input", { id, type: "checkbox", checked: on || undefined });
  const on = chk("pf-on", s.enabled), pc = chk("pf-pc", s.collectionPaused), pd = chk("pf-pd", s.disbursementPaused), pub = chk("pf-pub", s.publicReport), foot = chk("pf-foot", s.gradeCardFootnote);
  const reason = h("input", { id: "pf-why", maxlength: 500, value: s.pauseReason || "" });
  const name = h("input", { id: "pf-name", maxlength: 120, value: s.fundName });
  const purpose = h("textarea", { id: "pf-purpose", rows: 2, maxlength: 1000 }, s.purpose);
  const cats = Object.entries(s.categories).map(([k, label]) => ({ k, box: h("input", { id: `pf-c-${k}`, type: "checkbox", checked: s.eligibleCategories.includes(k) || undefined }), label }));
  const alloc = h("textarea", { id: "pf-alloc", rows: 2, maxlength: 2000 }, s.allocationRules || "");
  const gov = h("textarea", { id: "pf-gov", rows: 2, maxlength: 2000 }, s.governanceText || "");
  const refund = h("textarea", { id: "pf-ref", rows: 2, maxlength: 1000 }, s.refundPolicy || "");
  const minD = h("input", { id: "pf-min", type: "number", min: 3, max: 100, value: s.reportMinDonors, style: "width:5em" });
  const save = async () => {
    try {
      await api.put("/api/preservation-fund/settings", { enabled: on.checked, collectionPaused: pc.checked, disbursementPaused: pd.checked, pauseReason: reason.value.trim() || null,
        fundName: name.value.trim(), purpose: purpose.value.trim(), eligibleCategories: cats.filter(c => c.box.checked).map(c => c.k), allocationRules: alloc.value.trim() || null,
        governanceText: gov.value.trim() || null, refundPolicy: refund.value.trim() || null, publicReport: pub.checked, gradeCardFootnote: foot.checked, reportMinDonors: Number(minD.value) });
      toast("Saved."); go(state.tab, { push: false });
    } catch (e) { toast(e?.body?.error === "pause_reason_required" ? "Say why it's paused." : "Couldn't save. Check the fields."); }
  };
  const kind = h("select", { id: "pf-gk" }, ["legal", "finance", "governance"].map(k => h("option", { value: k }, { legal: "Legal", finance: "Finance", governance: "Governance" }[k])));
  const ref = h("input", { id: "pf-gref", maxlength: 300, placeholder: "Board minutes, memo or resolution" });
  const day = h("input", { id: "pf-gday", type: "date" });
  const document_ = async () => {
    try { await api.post("/api/preservation-fund/governance", { kind: kind.value, reference: ref.value.trim(), approvedOn: day.value }); toast("Recorded."); go(state.tab, { push: false }); }
    catch { toast("Couldn't record it. Add a reference and a date that isn't in the future."); }
  };
  const g = s.governance;
  return h("section", { class: "card", "aria-label": "Preservation fund" }, h("h3", {}, "Preservation fund"),
    h("p", { class: "small muted" }, "Gifts pool into this fund. It stays closed to gifts until legal, finance and governance approvals are recorded here and the fund is on. Sandbox only: no money moves."),
    h("p", { class: "small", role: "status" }, g.missing.length ? `Still needed before gifts open: ${g.missing.join(", ")} approval.` : "All three approvals are recorded."),
    g.records.length ? h("ul", { class: "list small" }, g.records.map(r => h("li", {}, `${r.kind}: ${r.reference} · ${r.approvedOn} · ${r.recordedBy}`))) : null,
    h("div", { class: "row wrap" }, h("div", {}, h("label", { for: "pf-gk" }, "Approval"), kind), h("div", { class: "grow" }, h("label", { for: "pf-gref" }, "Reference"), ref),
      h("div", {}, h("label", { for: "pf-gday" }, "Approved on"), day), h("button", { class: "btn small", type: "button", onclick: document_ }, "Record approval")),
    h("label", { for: "pf-on", class: "small" }, on, " Fund is on"),
    h("label", { for: "pf-pc", class: "small" }, pc, " Pause new gifts"), h("label", { for: "pf-pd", class: "small" }, pd, " Pause disbursements"),
    h("label", { for: "pf-why" }, "Why it's paused"), reason,
    h("label", { for: "pf-name" }, "Fund name"), name, h("label", { for: "pf-purpose" }, "Purpose"), purpose,
    h("fieldset", {}, h("legend", { class: "small" }, "What it can pay for"), cats.map(c => h("label", { for: `pf-c-${c.k}`, class: "small" }, c.box, ` ${c.label}`))),
    h("p", { class: "small muted" }, "It can never buy a student more storage or any preferential access."),
    h("label", { for: "pf-alloc" }, "How money is allocated"), alloc, h("label", { for: "pf-gov" }, "Who decides (shown to families)"), gov,
    h("label", { for: "pf-ref" }, "Refund policy"), refund,
    h("p", { class: "small" }, s.approvalRule),
    h("div", { class: "row wrap" }, h("div", {}, h("label", { for: "pf-min" }, "Fewest donors before totals show"), minD)),
    h("label", { for: "pf-pub", class: "small" }, pub, " Show families the fund's totals"),
    h("label", { for: "pf-foot", class: "small" }, foot, " Add the totals as a footnote on student grade cards (totals only, no names)"),
    h("button", { class: "btn small", type: "button", onclick: save }, "Save fund settings"));
}
async function fundDisbursementsCard() {
  const r = (await safe(api.get("/api/preservation-fund/report")))?.data;
  if (!r?.settings?.enabled) return null;
  const reload = () => go(state.tab, { push: false });
  const act = async (path, body, msg) => {
    try { await api.post(path, body); toast(msg); reload(); }
    catch (e) { toast({ requester_cannot_approve: "Someone other than the requester approves.", requester_cannot_pay: "Someone other than the requester records the payment.",
      insufficient_funds: "Not enough in that source.", source_must_match_school: "School gifts can only pay for that school.", school_required: "Choose the school.", disbursement_paused: "Disbursements are paused.", reason_required: "Add a reason (at least 5 characters)." }[e?.body?.error] || "Couldn't do that."); }
  };
  const request = async () => {
    const v = await dialogForm("Request a payment from the fund", () => {
      const cat = h("select", { id: "fd-c" }, r.settings.eligibleCategories.map(k => h("option", { value: k }, r.categories[k])));
      const src = h("select", { id: "fd-s" }, r.balances.map(b => h("option", { value: b.source.schoolId || "" }, `${b.source.name} (${money(b.availableCents)} available)`)));
      const sch = h("select", { id: "fd-sc" }, (r.schools || []).map(x => h("option", { value: x.id }, x.name)));
      return { fields: [h("p", { class: "small" }, "District-wide preservation only. It can't pay for any one student."),
        h("label", { for: "fd-c" }, "For"), cat, h("label", { for: "fd-sc" }, "School (its principal approves)"), sch, h("label", { for: "fd-s" }, "From"), src,
        h("label", { for: "fd-d" }, "What it pays for"), h("textarea", { id: "fd-d", rows: 2, required: true, minlength: 10, maxlength: 1000 }),
        h("label", { for: "fd-p" }, "Payee"), h("input", { id: "fd-p", required: true, maxlength: 200 }),
        h("label", { for: "fd-i" }, "Invoice or quote"), h("input", { id: "fd-i", required: true, maxlength: 120 }),
        h("label", { for: "fd-a" }, "Amount ($)"), h("input", { id: "fd-a", type: "number", min: 1, step: "0.01", required: true })],
        value: () => ({ category: cat.value, schoolId: document.getElementById("fd-sc").value, sourceSchoolId: src.value || null, description: document.getElementById("fd-d").value.trim(), payee: document.getElementById("fd-p").value.trim(),
          invoiceRef: document.getElementById("fd-i").value.trim(), amountCents: Math.round(Number(document.getElementById("fd-a").value) * 100) }) };
    }, "Request");
    if (v) act("/api/preservation-fund/disbursements", v, "Requested. It needs the school's principal and two district administrators to approve.");
  };
  const reasonThen = async (title, path, key, msg) => {
    const why = await dialogForm(title, () => ({ fields: [h("label", { for: "fd-why" }, "Reason"), h("input", { id: "fd-why", required: true, minlength: 5, maxlength: 500 })],
      value: () => document.getElementById("fd-why").value.trim() }), "Confirm");
    if (why) act(path, key === "note" ? { decision: "reject", noConflict: true, note: why } : { [key]: why }, msg);
  };
  const pay = async x => {
    const ref = await dialogForm(`Record payment of ${money(x.amountCents)} to ${x.payee}`, () => ({ fields: [h("p", { class: "small" }, "Test mode: this records the payment; no money moves."),
      h("label", { for: "fd-ref" }, "Payment reference (from your accounts payable)"), h("input", { id: "fd-ref", required: true, maxlength: 120 })],
      value: () => document.getElementById("fd-ref").value.trim() }), "Record payment");
    if (ref) act(`/api/preservation-fund/disbursements/${x.id}/pay`, { paymentRef: ref }, "Payment recorded.");
  };
  const mine = x => x.requestedById === r.me;
  return h("section", { class: "card", "aria-label": "Fund payments" }, h("h3", {}, "Fund payments"),
    h("p", { class: "small muted" }, `${r.settings.approvalRule} Someone other than the requester records the payment. Sandbox only.`),
    r.settings.disbursementPaused ? h("p", { class: "small", role: "status" }, `Paused: ${r.settings.pauseReason}`) : null,
    h("ul", { class: "list small" }, r.balances.map(b => kv(b.source.name, `${money(b.availableCents)} available · ${money(b.paidCents)} paid`))),
    h("button", { class: "btn small", type: "button", onclick: request }, "Request a payment"),
    r.disbursements.length ? h("ul", { class: "list small" }, r.disbursements.slice(0, 30).map(x => h("li", {},
      h("div", {}, `${money(x.amountCents)} · ${x.categoryLabel} · ${x.payee} · ${FUND_STATUS[x.status] || x.status}`),
      h("div", { class: "muted" }, `${x.school.name} · ${x.description} · asked by ${x.requestedBy} · ${panelText(x.panel)}${x.votes.length ? ` · ${x.votes.map(v => `${v.voter} (${v.seatLabel}) ${v.decision === "approve" ? "approved" : "rejected"}`).join(", ")}` : ""}`),
      h("div", { class: "btns" },
        x.status === "pending" && mine(x) ? h("button", { class: "btn small", type: "button", "aria-label": `Withdraw ${money(x.amountCents)} to ${x.payee}`, onclick: () => reasonThen("Withdraw your request", `/api/preservation-fund/disbursements/${x.id}/close`, "reason", "Withdrawn.") }, "Withdraw") : null,
        x.status === "approved" && !mine(x) ? h("button", { class: "btn small", type: "button", "aria-label": `Record payment ${money(x.amountCents)} to ${x.payee}`, onclick: () => pay(x) }, "Record payment") : null,
        x.status === "approved" ? h("button", { class: "btn small", type: "button", "aria-label": `Cancel ${money(x.amountCents)} to ${x.payee}`, onclick: () => reasonThen("Cancel this approved payment", `/api/preservation-fund/disbursements/${x.id}/close`, "reason", "Cancelled.") }, "Cancel") : null)))) : h("p", { class: "small" }, "No payments requested yet."));
}
const panelText = p => `principal ${p.principal}/${p.principalNeeded} · district administrators ${p.districtAdmins}/${p.districtAdminsNeeded}`;
// TC-12: payments waiting on the approval panel (the school's principal plus two district administrators).
async function fundApprovalsCard() {
  const r = (await safe(api.get("/api/preservation-fund/approvals")))?.data;
  const mineToDecide = (r?.waiting || []).filter(x => x.mySeat && x.requestedById !== r.me && !x.votes.some(v => v.voterId === r.me));
  if (!mineToDecide.length) return null;
  const reload = () => go(state.tab, { push: false });
  const send = async (x, body, msg) => {
    try { await api.post(`/api/preservation-fund/disbursements/${x.id}/vote`, body); toast(msg); reload(); }
    catch (e) { toast({ seat_filled: "That approval is already in.", conflict_declared: "Approvals need a no-conflict confirmation.", disbursement_paused: "Disbursements are paused.",
      not_on_approval_panel: "Only the school's principal and district administrators approve.", insufficient_funds: "Not enough in that source.", reason_required: "Add a reason (at least 5 characters)." }[e?.body?.error] || "Couldn't do that."); }
  };
  const approve = async x => {
    const yes = await dialogForm(`Approve ${money(x.amountCents)} to ${x.payee}?`, () => {
      const box = h("input", { id: "fa-nc", type: "checkbox", required: true });
      return { fields: [h("p", { class: "small" }, `${x.school.name}: ${x.description}`), h("label", { for: "fa-nc", class: "small" }, box, " I have no personal or financial interest in this payment")], value: () => box.checked };
    }, "Approve");
    if (yes) send(x, { decision: "approve", noConflict: true }, "Approved.");
  };
  const reject = async x => {
    const why = await dialogForm("Reject this request", () => {
      const box = h("input", { id: "fa-nc2", type: "checkbox", required: true });
      return { fields: [h("label", { for: "fa-why" }, "Reason"), h("input", { id: "fa-why", required: true, minlength: 5, maxlength: 500 }),
        h("label", { for: "fa-nc2", class: "small" }, box, " I have no personal or financial interest in this payment")], value: () => box.checked && document.getElementById("fa-why").value.trim() };
    }, "Reject");
    if (why) send(x, { decision: "reject", noConflict: true, note: why }, "Rejected.");
  };
  return h("section", { class: "card", "aria-label": "Fund payments to approve" }, h("h3", {}, "Fund payments to approve"),
    h("p", { class: "small muted" }, `${r.rule} Sandbox only: no money moves.`),
    h("ul", { class: "list small" }, mineToDecide.map(x => h("li", {},
      h("div", {}, `${money(x.amountCents)} · ${x.categoryLabel} · ${x.payee} · ${x.school.name}`),
      h("div", { class: "muted" }, `${x.description} · asked by ${x.requestedBy} · ${panelText(x.panel)} · you approve as ${x.mySeat === "school_principal" ? "the principal" : "a district administrator"}`),
      h("div", { class: "btns" },
        h("button", { class: "btn small", type: "button", "aria-label": `Approve ${money(x.amountCents)} to ${x.payee}`, onclick: () => approve(x) }, "Approve"),
        h("button", { class: "btn small", type: "button", "aria-label": `Reject ${money(x.amountCents)} to ${x.payee}`, onclick: () => reject(x) }, "Reject"))))));
}
// ---------------- Time Capsules ----------------
const MILESTONE_TEXT = { grade_5_completion: "Finishing grade 5", grade_8_completion: "Finishing grade 8", graduation: "Graduation", age_18: "Turning 18" };
const CAPSULE_STATUS = { draft: "Draft", sealed: "Sealed, waiting for the milestone", scheduled: "Sealed", released: "Released", cancelled: "Cancelled" };
const CONSENT_TEXT = { pending: "Hasn't answered", approved: "Accepted", denied: "Declined", withdrawn: "Withdrew" };
const opensText = c => c.releaseKind === "milestone" ? `Opens at: ${MILESTONE_TEXT[c.milestone] || c.milestone}` : `Opens ${fmtDay(c.releaseAt)}`;
VIEWS.capsules = async () => {
  const role = state.me.role;
  const [mine, invites, milestones, home] = await Promise.all([api.get("/api/history/capsules"), safe(api.get("/api/history/capsule-invitations"), { data: [] }),
    safe(api.get("/api/history/capsule-milestones"), { data: [] }), role === "parent" ? safe(api.get("/api/home"), { data: {} }) : null]);
  const out = [h("h2", {}, "Time Capsules")];
  const answer = async (capsuleId, decision) => {
    try { await api.post(`/api/history/capsule-invitations/${capsuleId}`, { decision }); toast({ approved: "Accepted.", denied: "Declined.", withdrawn: "Withdrawn." }[decision]); go("capsules", { push: false }); }
    catch (error) { toast(error.message || "Could not save your answer."); }
  };
  const pendingInvites = (invites.data || []).filter(i => i.status !== "released" || i.consent !== "approved");
  if (pendingInvites.length) out.push(h("section", { class: "card" }, h("h3", {}, "Capsules for you"),
    h("p", { class: "small muted" }, "Someone has made a Time Capsule you can receive. You'll see what's inside only once it opens, and only if you accept."),
    ...pendingInvites.map(i => h("article", { class: "card" },
      h("div", { class: "row" }, h("strong", { class: "grow" }, `From ${i.from}`), h("span", { class: "chip" }, CONSENT_TEXT[i.consent] || i.consent)),
      h("p", { class: "small muted" }, `For ${i.studentName} · ${opensText(i)}`),
      i.status === "released" ? h("p", { class: "small muted" }, "This capsule has opened; you withdrew, so it's closed to you.")
        : h("div", { class: "btns" },
          i.consent !== "approved" ? h("button", { class: "btn primary", type: "button", onclick: () => answer(i.capsuleId, "approved") }, "Accept") : null,
          i.consent === "pending" ? h("button", { class: "btn", type: "button", onclick: () => answer(i.capsuleId, "denied") }, "Decline") : null,
          i.consent === "approved" ? h("button", { class: "btn", type: "button", onclick: () => answer(i.capsuleId, "withdrawn") }, "Withdraw") : null)))));
  if ((milestones.data || []).length) out.push(h("section", { class: "card" }, h("h3", {}, "Milestones to confirm"),
    h("p", { class: "small muted" }, "These capsules open when the student reaches the milestone. You see only the milestone, never what's inside."),
    ...milestones.data.map(m => h("article", { class: "card" },
      h("div", { class: "row" }, h("strong", { class: "grow" }, `${m.studentName}: ${MILESTONE_TEXT[m.milestone] || m.milestone}`)),
      h("p", { class: "small muted" }, `From ${m.from} · ${m.accepted ? `${m.accepted} recipient${m.accepted === 1 ? "" : "s"} accepted` : "No recipient has accepted yet"}`),
      h("button", { class: "btn primary", type: "button", disabled: !m.accepted, onclick: async () => {
        if (!await ask({ title: `Confirm ${MILESTONE_TEXT[m.milestone] || m.milestone} for ${m.studentName}?`, text: "The capsule opens now for recipients who accepted. This is recorded.", confirm: "Confirm and open" })) return;
        try { await api.post(`/api/history/capsules/${m.capsuleId}/release`); toast("Released."); go("capsules", { push: false }); }
        catch (error) { toast(error.message || "Could not release this capsule."); }
      } }, "Confirm milestone")))));
  const capsules = mine.data || [];
  const card = c => h("article", { class: "card" },
    h("div", { class: "row" }, h("strong", { class: "grow" }, c.title), h("span", { class: "chip" }, CAPSULE_STATUS[c.status] || c.status)),
    h("p", { class: "small muted" }, `For ${c.studentName} · ${opensText(c)}`),
    h("button", { class: "btn", type: "button", onclick: () => openView("capsule", { capsuleId: c.id }) }, c.mine ? "Manage" : "Open"));
  const received = capsules.filter(c => !c.mine);
  if (received.length) out.push(h("section", { class: "card" }, h("h3", {}, "Opened for you"), ...received.map(card)));
  const kids = home?.data?.children || [];
  if (kids.length) {
    const student = h("select", { required: true }, ...kids.map(k => h("option", { value: k.id, ...(state.learnerId === k.id ? { selected: true } : {}) }, k.display_name)));
    const title = h("input", { type: "text", maxlength: 180, required: true, placeholder: "For Alice at 18" });
    const message = h("textarea", { maxlength: 12000, rows: 3, placeholder: "A message for when it opens (optional)" });
    const kind = h("select", {}, h("option", { value: "scheduled" }, "On a date"), h("option", { value: "milestone" }, "At a milestone"));
    const date = h("input", { type: "date", required: true, min: new Date(Date.now() + 86400000).toISOString().slice(0, 10) });
    const milestone = h("select", {}, ...Object.entries(MILESTONE_TEXT).map(([v, t]) => h("option", { value: v }, t)));
    const dateRow = h("label", {}, h("span", {}, "Open on"), date), msRow = h("label", { hidden: true }, h("span", {}, "Milestone"), milestone);
    kind.addEventListener("change", () => { const ms = kind.value === "milestone"; msRow.hidden = !ms; dateRow.hidden = ms; date.required = !ms; });
    const form = h("form", { class: "stack", onsubmit: async event => {
      event.preventDefault();
      const ms = kind.value === "milestone";
      try {
        const r = await api.post("/api/history/capsules", { studentId: student.value, title: title.value, message: message.value, releaseKind: kind.value,
          ...(ms ? { milestone: milestone.value } : { releaseAt: new Date(`${date.value}T09:00:00`).toISOString() }),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        toast("Capsule started. Add memories and recipients, then seal it.");
        openView("capsule", { capsuleId: r.data.id });
      } catch (error) { toast(error.message || "Could not create the capsule."); }
    } },
      h("label", {}, h("span", {}, "For"), student), h("label", {}, h("span", {}, "Title"), title), h("label", {}, h("span", {}, "Message"), message),
      h("label", {}, h("span", {}, "Opens"), kind), dateRow, msRow,
      h("button", { class: "btn primary", type: "submit" }, "Start a capsule"));
    out.push(h("section", { class: "card" }, h("details", {}, h("summary", {}, "Make a Time Capsule"), form)));
  }
  const made = capsules.filter(c => c.mine);
  out.push(h("section", { class: "card" }, h("h3", {}, "Capsules you made"), ...(made.length ? made.map(card) : [h("p", { class: "small muted" }, "None yet.")])));
  return out;
};
VIEWS.capsule = async () => {
  if (!state.capsuleId) return empty("Choose a capsule from Time Capsules.");
  const c = (await api.get(`/api/history/capsules/${state.capsuleId}`)).data;
  const reload = () => go("capsule", { push: false });
  const act = async (path, body, done) => { try { await api.post(path, body); toast(done); reload(); } catch (error) { toast(error.message || "That didn't work."); } };
  const items = c.items.length ? h("ol", { class: "stack" }, c.items.map(i => h("li", { class: "card" },
    i.withheld ? h("p", { class: "small muted" }, "This item was withdrawn from the history and is no longer shown.")
      : [h("strong", {}, i.title), h("p", { class: "small muted" }, fmtDay(i.occurredAt)), i.body ? h("p", {}, i.body) : null, photoStrip(i.photos)])))
    : h("p", { class: "small muted" }, "Nothing in it yet.");
  const out = [h("div", { class: "row" }, h("h2", { class: "grow" }, c.title), h("span", { class: "chip" }, CAPSULE_STATUS[c.status] || c.status)),
    h("p", { class: "small muted" }, `For ${c.studentName} · ${opensText(c)}`), c.message ? h("p", {}, c.message) : null, photoStrip(c.photos),
    c.mine && c.status === "draft" ? photoAdder(c.id, `/api/history/capsules/${c.id}/photos`, reload) : null, h("h3", {}, "Inside"), items];
  if (c.mine && c.status === "draft") {
    const [cands, opts] = await Promise.all([api.get(`/api/history/capsules/${c.id}/candidates`), api.get(`/api/history/capsule-recipient-options?studentId=${c.studentId}`)]);
    const entry = h("select", { "aria-label": "History item to add" }, ...cands.data.map(e => h("option", { value: e.id }, `${e.title} (${fmtDay(e.occurredAt)})`)));
    const named = new Set((c.recipients || []).map(r => r.userId));
    const who = h("select", { "aria-label": "Recipient" }, ...opts.data.filter(o => !named.has(o.userId)).map(o => h("option", { value: `${o.userId}|${o.type}` }, `${o.name} (${o.type})`)));
    out.push(h("section", { class: "card" }, h("h3", {}, "Add a memory"),
      cands.data.length ? h("div", { class: "btns" }, entry, h("button", { class: "btn", type: "button", onclick: () => act(`/api/history/capsules/${c.id}/items`, { entryId: entry.value }, "Added.") }, "Add"))
        : h("p", { class: "small muted" }, "No other history items to add. Items appear here once they're in the student's history.")),
      h("section", { class: "card" }, h("h3", {}, "Who receives it"),
        who.options.length ? h("div", { class: "btns" }, who, h("button", { class: "btn", type: "button", onclick: () => { const [userId, type] = who.value.split("|"); act(`/api/history/capsules/${c.id}/recipients`, { userId, type }, "Recipient added. They'll be asked to accept."); } }, "Add"))
          : null));
  }
  if (c.mine) {
    out.push(h("section", { class: "card" }, h("h3", {}, "Recipients"), (c.recipients || []).length
      ? h("ul", {}, c.recipients.map(r => h("li", {}, `${r.name} (${r.type}): ${CONSENT_TEXT[r.consent] || r.consent}`)))
      : h("p", { class: "small muted" }, "No one yet. Only people who accept will be able to open it.")));
    const btns = [];
    if (c.status === "draft") btns.push(h("button", { class: "btn primary", type: "button", onclick: async () => {
      if (!await ask({ title: "Seal this capsule?", text: "After sealing you can't change its contents, message or recipients.", confirm: "Seal" })) return;
      act(`/api/history/capsules/${c.id}/seal`, undefined, "Sealed.");
    } }, "Seal"));
    if (["draft", "sealed", "scheduled"].includes(c.status)) btns.push(h("button", { class: "btn danger", type: "button", onclick: async () => {
      if (!await ask({ title: "Cancel this capsule?", text: "It will never open. This can't be undone.", confirm: "Cancel capsule", danger: true })) return;
      act(`/api/history/capsules/${c.id}/cancel`, undefined, "Cancelled.");
    } }, "Cancel capsule"));
    if (btns.length) out.push(h("div", { class: "btns" }, btns));
  }
  out.push(h("button", { class: "btn", type: "button", onclick: () => go("capsules") }, "Back to Time Capsules"));
  return out;
};
VIEWS.history = async () => {
  const response = await safe(api.get("/api/history-contributions"), null);
  const items = response?.data || [];
  const content = items.length ? items.map(item => {
    const note = h("textarea", { rows: 2, maxlength: 1000, placeholder: "Optional note for the family" });
    const decide = async decision => {
      const action = decision === "approve" ? "Approve this family memory?" : "Reject this family memory?";
      if (!await ask({ title: action, text: "This decision is recorded in the student history audit trail.", confirm: decision === "approve" ? "Approve" : "Reject", danger: decision === "reject" })) return;
      try {
        await api.req("PATCH", `/api/students/${item.student_id}/history-contributions/${item.id}`, { decision, note: note.value });
        toast(decision === "approve" ? "Family memory approved." : "Family memory rejected.");
        go("history", { push: false });
      } catch (error) { toast(error.message || "Could not review this family memory."); }
    };
    return h("article", { class: "card" },
      h("div", { class: "row" }, h("strong", {}, item.title), chip("submitted")),
      h("p", { class: "small muted" }, `${item.student_name} · from ${item.guardian_name} · ${fmtDay(item.occurred_at)} · submitted ${fmtTime(item.created_at)}`),
      item.body ? h("p", {}, item.body) : h("p", { class: "small muted" }, "No additional memory text."),
      photoStrip(item.photos),
      h("label", {}, h("span", {}, "Review note (optional)"), note),
      h("div", { class: "btns" },
        h("button", { class: "btn primary", type: "button", onclick: () => decide("approve") }, "Approve"),
        h("button", { class: "btn danger", type: "button", onclick: () => decide("reject") }, "Reject")));
  }) : [h("p", { class: "small muted" }, "No family memories are waiting for review.")];
  const teacher = await teacherReviewSection();
  const privacy = ["principal", "vice_principal", "superintendent"].includes(state.me.role) ? [recordsPrivacyCard(), await incomingTransfersCard(), state.me.role === "superintendent" ? [await emergencyReviewCard(), await mediaPolicyCard(), await donationSettingsCard(), await fundSettingsCard()] : null, await preservationCard()] : null;
  const accounts = ["parent", "pupil"].includes(state.me.role) ? null : [await fundApprovalsCard(), await donationAccountsCard(), await fundDisbursementsCard()];
  return [privacy, accounts, h("div", { class: "row" }, h("h2", { class: "grow" }, "Student history review"),
    h("button", { class: "btn", type: "button", onclick: () => go("history", { push: false }) }, "Refresh")),
    h("p", { class: "small muted" }, "Family memories and teacher items wait here before they reach a student's history."),
    ...(response ? [h("h3", {}, "Family memories"), ...content] : []),
    ...(teacher || [])];
};
// TC-13: a school secretary's gift accounts (db/140). They appear once the
// superintendent designates the secretary as a donation finance reviewer.
VIEWS.gifts = async () => {
  const cards = [await donationAccountsCard(), await fundDisbursementsCard()].filter(Boolean);
  return cards.length ? cards : empty("Gift accounts appear here once your superintendent designates you as a finance reviewer.");
};
VIEWS.children = async () => {
  const [home, bus] = await Promise.all([api.get("/api/home"), safe(api.get("/api/transport/today"))]);
  const kids = home.data.children || [];
  if (!kids.length) return empty("No children are linked to your account yet.");
  const out = [];
  for (const k of forChild(kids)) {
    const summary = await safe(api.get(`/api/family/children/${k.id}/summary`));
    const days = (summary?.attendance || []).slice(0, 5);
    const ride = (bus?.data?.riders || []).find(r => r.id === k.id && r.direction === (new Date().getHours() < 12 ? "am" : "pm")) || (bus?.data?.riders || []).find(r => r.id === k.id);
    const familyMemories = await familyContributionsCard(k);
    const fromTeachers = await teacherItemsCard(k);
    out.push(h("section", { class: "card", "aria-label": k.display_name },
      h("div", { class: "row" }, h("div", { class: "grow" }, h("h2", {}, k.display_name), h("p", { class: "small muted" }, `Grade ${k.grade_level} · ${k.school_name}`)),
        ride ? chip(ride.status) : null),
      h("div", { class: "stats" }, stat(k.absences_30d, "absences (30 days)", true), stat(k.due_7d, "due this week"), stat(k.overdue, "overdue", true), stat(k.to_acknowledge, "to acknowledge", true)),
      days.length ? h("div", {}, h("h3", {}, "Recent attendance"), h("div", { class: "btns" }, days.map(a => h("span", { class: `chip ${a.status}` }, `${fmtDay(a.event_date)}: ${STATUS_TEXT[a.status] || a.status}`)))) : null,
      familyMemories,
      fromTeachers,
      h("button", { class: "btn block", type: "button", "aria-label": `History & portfolio: ${k.display_name}`, onclick: () => openView("portfolio", { learnerId: k.id, portfolioFilters: {} }) }, icon("book"), "History & portfolio"),
      h("button", { class: "btn primary block", type: "button", "aria-label": `Grades & progress: ${k.display_name}`, onclick: () => openView("progress", { learnerId: k.id }) }, icon("book"), "Grades & progress"),
      ride ? h("button", { class: "btn block", type: "button", onclick: () => go("arrival") }, icon("bus"), `Bus: ${STATUS_TEXT[ride.status] || ride.status}`) : null));
  }
  return out;
};
VIEWS.arrival = async () => {
  const riders = forChild((await api.get("/api/transport/today")).data.riders || []);
  if (!riders.length) return [h("h2", {}, "Arrival"), empty("No bus assignments for your children.")];
  return [h("h2", {}, "Arrival & bus"),
    ...riders.map(k => h("section", { class: "card", "aria-label": `${k.display_name}, ${k.route_name}` },
      h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, `${k.display_name}`), h("p", { class: "small muted" }, `${k.bus_label} · ${k.route_name} · stop ${k.stop_name}${k.stop_time ? ` (${k.stop_time})` : ""}`)), chip(k.status)),
      k.events.length ? h("ol", { class: "timeline" }, k.events.map(e => h("li", {}, h("time", { datetime: e.recorded_at }, fmtTime(e.recorded_at)), h("span", {}, `${STATUS_TEXT[e.event]} ${e.is_school ? "at school" : `at ${e.stop_name}`}`))))
        : h("p", { class: "muted" }, k.run_id ? "The run has started. No check-in for this child yet." : "This run hasn't started yet."))),
    h("p", { class: "notice" }, "These are check-ins the driver taps at each stop. EduOS never tracks your child's location, and the app never asks for yours.")];
};

// ---------------- school & district leaders ----------------
VIEWS.overview = async () => {
  const [home, bus, review, reports, news, approvals, ledger] = await Promise.all([api.get("/api/home"), safe(api.get("/api/transport/today")), safe(api.get("/api/christie/review")), safe(api.get("/api/comms/reports")), safe(api.get("/api/comms/announcements")),
    safe(api.get("/api/learning/approvals")), safe(api.get("/api/edal/verify"))]);
  const [node, hosted] = state.me.role === "principal" ? await Promise.all([safe(api.get("/api/node/status")).then(r => r?.data), safe(api.get("/api/node/hosting")).then(r => r?.data)]) : [null, null];
  const pending = (approvals?.data?.lessons?.length || 0) + (approvals?.data?.sources?.length || 0);
  const d = home.data, role = state.me.role;
  const routes = bus?.data?.routes || [];
  const onBoard = routes.reduce((n, r) => n + (r.counts?.onBoard || 0), 0), riders = routes.reduce((n, r) => n + (r.counts?.riders || 0), 0);
  const flagged = (review?.data || []).filter(x => x.needs_adult && !x.reviewed_at).length;
  const openReports = (reports?.data || []).filter(r => r.status === "open").length;
  const stats = role === "principal"
    ? [stat(d.students, "students"), stat(d.absent_today, "absent today", true), stat(d.open_cases, "open support cases"), stat(d.overdue_follow_ups, "overdue follow-ups", true)]
    : [stat(d.schools, "schools"), stat(d.students, "students"), stat(d.urgent_cases, "urgent cases", true), stat(d.absences_7d, "absences (7 days)", true)];
  return [
    h("section", { class: "card hero", "aria-label": "Overview" }, h("p", { class: "muted small" }, d.school_name || state.brand?.districtName || ""), h("h2", {}, role === "principal" ? "School overview" : "District overview"),
      h("p", { class: "muted" }, `${routes.length} bus run${routes.length === 1 ? "" : "s"} today · ${onBoard} of ${riders} riders on board now`)),
    hosted?.hosted ? h("section", { class: "card alertcard", "aria-label": "Failover" }, h("h2", {}, "Covering from a partner school"),
      h("p", {}, `Your school's own server is down, so you're signed in on a partner school's node until ${fmtTime(hosted.expiresAt)}. SafetyOS, pick-up, buses and attendance work here; everything you record goes back to your school automatically.`),
      h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: () => go("pickup") }, icon("car"), "Pick-up"), h("button", { class: "btn", type: "button", onclick: () => go("sos") }, icon("shield"), "Safety"), h("button", { class: "btn", type: "button", onclick: () => go("transport") }, icon("bus"), "Buses"))) : null,
    node && !hosted?.hosted ? h("section", { class: `card${node.uplink.state === "offline" ? " alertcard" : ""}`, "aria-label": "School node" }, h("div", { class: "row" }, h("span", { class: "grow" }, h("b", {}, node.uplink.state === "offline" ? "District link is down, working locally" : "School node connected"), h("br"),
      h("span", { class: "muted small" }, `${node.outbox.pending} update${node.outbox.pending === 1 ? "" : "s"} waiting · ${node.hosting.some(x => x.status === "active") ? "covering for a partner school" : "no failover"}`)),
      h("button", { class: "btn small", type: "button", "aria-label": "Node details", onclick: () => go("node") }, "Node details"))) : null,
    h("div", { class: "stats" }, stats),
    hosted?.hosted ? null : h("section", { class: "card", "aria-label": "Needs attention" }, h("h2", {}, "Needs attention"), h("ul", { class: "list" },
      h("li", { class: "row" }, h("span", { class: "grow" }, "Christie chats where a learner asked for an adult"), chip(flagged ? "absent" : "present", String(flagged))),
      h("li", { class: "row" }, h("span", { class: "grow" }, "Reported messages to review"), chip(openReports ? "absent" : "present", String(openReports))),
      role === "principal" ? h("li", { class: "row" }, h("span", { class: "grow" }, "Pending guardian invitations"), chip(d.pending_invitations ? "expected" : "present", String(d.pending_invitations || 0))) : null)),
    hosted?.hosted ? null : h("section", { class: "card", "aria-label": "Learning" }, h("h2", {}, "Learning"), h("ul", { class: "list" },
      h("li", { class: "row" }, h("span", { class: "grow" }, "Lessons and sources waiting for approval"), chip(pending ? "expected" : "present", String(pending))),
      ledger ? h("li", { class: "row" }, h("span", { class: "grow" }, `Records ledger: ${ledger.data.entries} records`), chip(ledger.data.ok ? "present" : "absent", ledger.data.ok ? "Verified" : "Problem")) : null),
      h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: () => go("approvals") }, icon("check"), "Approvals"),
        h("button", { class: "btn", type: "button", onclick: () => go("edal") }, icon("ledger"), "Records ledger"),
        h("button", { class: "btn", type: "button", onclick: () => go("courses") }, icon("book"), "Courses"))),
    ["principal", "vice_principal"].includes(role) && state.me.schoolId ? await bellScheduleCard(true) : null,
        role === "principal" && !hosted?.hosted ? h("section", { class: "card", "aria-label": "School announcement" }, h("h2", {}, "Announce to the school"), announceForm("school")) : null,
    h("section", { class: "card", "aria-label": "Announcements" }, h("h2", {}, "Announcements"), announcementsCard(news?.data, { limit: 3 }))
  ];
};
VIEWS.transport = async () => {
  const routes = (await api.get("/api/transport/today")).data.routes || [];
  return [h("h2", {}, "Transport status"),
    routes.length ? routes.map(r => h("section", { class: "card", "aria-label": r.name },
      h("div", { class: "row" }, icon("bus"), h("div", { class: "grow" }, h("h3", {}, `${r.bus_label} · ${r.name}`), h("p", { class: "small muted" }, `${r.school_name} · driver ${r.driver_name || "unassigned"}`)),
        chip(r.run ? (r.run.status === "completed" ? "alighted" : "boarded") : "not_started", r.run ? (r.run.status === "completed" ? "Completed" : "In progress") : "Not started")),
      h("div", { class: "counter" }, stat(r.counts.onBoard, "on board"), stat(r.counts.expected, "expected"), stat(r.counts.alighted, "dropped off"), stat(r.counts.notRiding, "not riding")),
      h("p", { class: "small muted" }, `${r.stops.length} stops${r.run ? ` · started ${fmtTime(r.run.started_at)}` : ""}`))) : h("section", { class: "card" }, empty("No routes set up.")),
    h("p", { class: "notice" }, "Counts come from driver check-ins at stops. No GPS or location data is collected.")];
};

// ---------------- driver ----------------
VIEWS.route = async () => {
  const routes = (await api.get("/api/transport/today")).data.routes || [];
  if (!routes.length) return [h("h2", {}, "My route"), empty("No routes are assigned to you.")];
  const pick = routes.find(r => r.id === state.routeId) || routes.find(r => r.run?.status === "in_progress") || routes[0];
  state.routeId = pick.id;
  const r = pick;
  const out = [];
  if (routes.length > 1) out.push(seg(routes.map(x => [x.id, x.direction === "am" ? "Morning" : "Afternoon"]), r.id, id => { state.routeId = id; go("route", { push: false }); }));
  out.push(h("section", { class: "card hero", "aria-label": r.name }, h("p", { class: "muted small" }, r.school_name), h("h2", {}, `${r.bus_label} · ${r.name}`),
    h("div", { class: "counter" }, stat(r.counts.onBoard, "ON BOARD"), stat(r.counts.expected, "expected"), stat(r.counts.alighted, "dropped off"))));
  if (!r.run) {
    out.push(h("button", { class: "btn primary block big", type: "button", onclick: async () => { await api.post("/api/transport/runs", { routeId: r.id }); toast("Run started"); go("route", { push: false }); } }, "Start run"));
  } else if (r.run.status === "completed") {
    out.push(h("section", { class: "card" }, h("p", {}, `Run completed at ${fmtTime(r.run.completed_at)}.`)));
  }
  const live = r.run?.status === "in_progress";
  const checkin = async (rider, stop, event) => {
    try {
      const sent = await api.post(`/api/transport/runs/${r.run.id}/checkins`, { studentId: rider.studentId, stopId: stop.id, event });
      if (sent.queued) return toast(`${first(rider.name)}: saved on this phone, sends when back online`);
      toast(`${first(rider.name)}: ${STATUS_TEXT[event]}`); go("route", { push: false });
    } catch (e) { toast(e.status === 429 ? "Too many taps, wait a moment." : "Check-in failed. Try again."); }
  };
  for (const st of r.stops) {
    const riders = st.riders || [];
    out.push(h("section", { class: `card stop${st.is_school ? " school" : ""}`, "aria-label": `Stop ${st.seq}: ${st.name}` },
      h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, `${st.seq}. ${st.name}`), h("p", { class: "small muted" }, `${st.time || ""}${riders.length ? ` · ${riders.length} rider${riders.length > 1 ? "s" : ""}` : ""}`))),
      riders.map(rd => h("div", { class: "rider" }, h("div", { class: "grow" }, h("strong", {}, rd.name), h("span", { class: "small muted" }, ` · gr ${rd.grade}`), h("br"), chip(rd.status)),
        live ? h("div", { class: "btns" },
          rd.status !== "boarded" ? h("button", { class: "btn primary onboard", type: "button", "aria-label": `${rd.name}: on board`, onclick: () => checkin(rd, st, "boarded") }, "ON BOARD") : null,
          rd.status === "expected" ? h("button", { class: "btn", type: "button", "aria-label": `${rd.name}: not riding`, onclick: () => checkin(rd, st, "not_riding") }, "Not riding") : null) : null)),
      live && st.is_school ? onBoardList(r, st, checkin) : null));
  }
  if (live) out.push(h("button", { class: "btn school block big", type: "button", onclick: async () => {
    try { await api.post(`/api/transport/runs/${r.run.id}/complete`, {}); toast("Run completed"); go("route", { push: false }); }
    catch (e) { toast(e.body?.error === "riders_still_on_board" ? `${e.body.onBoard} rider(s) still on board. Check everyone off first.` : "Couldn't finish the run."); }
  } }, "Finish run"));
  out.push(h("p", { class: "notice" }, "Tap ON BOARD when a rider gets on and OFF when they get off. EduOS records only these taps at named stops; it does not use GPS or track anyone's location."));
  return out;
};
function onBoardList(r, stop, checkin) {
  const on = r.stops.flatMap(s => s.riders || []).filter(x => x.status === "boarded");
  if (!on.length) return h("p", { class: "small muted" }, "No riders on board.");
  return h("div", {}, h("p", { class: "small" }, `Drop off at ${stop.name}:`), on.map(rd => h("div", { class: "rider" }, h("span", { class: "grow" }, rd.name),
    h("button", { class: "btn", type: "button", "aria-label": `${rd.name}: off the bus`, onclick: () => checkin(rd, stop, "alighted") }, "OFF"))));
}

// ---------------- messages (families, teachers, leaders, drivers) ----------------
VIEWS.messages = async () => {
  const [threads, news] = await Promise.all([api.get("/api/comms/threads"), safe(api.get("/api/comms/announcements"))]);
  const view = state.msgView || "threads";
  return [seg([["threads", "Conversations"], ["news", "Announcements"]], view, v => { state.msgView = v; go("messages", { push: false }); }),
    view === "news" ? h("section", { class: "card" }, announcementsCard(news?.data)) : [
      h("button", { class: "btn primary block", type: "button", onclick: () => compose() }, icon("send"), "New message"),
      h("section", { class: "card", "aria-label": "Conversations" }, threads.data.length ? h("ul", { class: "list" }, threads.data.map(t => h("li", {},
        h("a", { href: `#/thread/${t.id}`, class: "row", onclick: (e) => { e.preventDefault(); openThread(t.id); } },
          h("div", { class: "grow" }, h("h3", {}, t.subject), h("p", { class: "small muted" }, `${t.with_names || ""}${t.student_name ? ` · about ${first(t.student_name)}` : ""} · ${ago(t.last_message_at)}`),
            h("p", { class: "small" }, t.last_body || "(message hidden by a moderator)")),
          t.unread ? h("span", { class: "chip current" }, `${t.unread} new`) : null, t.status === "locked" ? chip("expected", "Locked") : null)))) : empty("No conversations yet."))]];
};
async function openThread(id) {
  const t = (await api.get(`/api/comms/threads/${id}`)).data;
  const me = state.me.userId;
  const others = t.participants.filter(p => p.user_id !== me);
  const input = h("textarea", { id: "reply", maxlength: 4000, "aria-label": "Reply" });
  put(
    h("button", { class: "btn", type: "button", onclick: () => go("messages", { push: false }) }, "‹ Conversations"),
    h("h2", {}, t.subject), h("p", { class: "small muted" }, t.kind === "network" && t.discoverable ? `Group · ${t.participants.length} member${t.participants.length === 1 ? "" : "s"}${t.description ? ` · ${t.description}` : ""}`
      : `${t.kind === "family" ? `About ${t.student_name} · ` : t.kind === "network" ? "Colleagues · " : "Staff · "}with ${others.map(p => p.name).join(", ")}`),
    t.kind === "network" && t.status === "open" ? h("div", { class: "btns" },
      h("button", { class: "btn", type: "button", onclick: () => addColleagues(id) }, icon("people"), "Add colleagues"),
      h("button", { class: "btn", type: "button", onclick: async () => { if (!(await ask({ title: t.discoverable ? "Leave this group?" : "Leave this conversation?", text: t.discoverable ? "You can join again from Colleagues › Groups." : "A member can add you back.", confirm: "Leave" }))) return;
        try { await api.post(`/api/network/threads/${id}/leave`); toast("You left."); go(t.discoverable ? "network" : "messages", { push: false }); } catch { toast("Couldn't leave."); } } }, "Leave")) : null,
    h("div", { class: "chat" }, t.messages.map(m => h("div", { class: `bubble ${m.author_user_id === me ? "me" : "them"}` },
      h("span", { class: "sr" }, `${m.author_name}: `), m.hidden ? h("em", {}, "Hidden by a moderator") : m.body,
      h("span", { class: "meta" }, `${m.author_user_id === me ? "You" : m.author_name} · ${fmtTime(m.created_at)}${m.author_user_id === me ? (m.read_by.length ? ` · Read by ${m.read_by.map(r => first(r.name)).join(", ")}` : " · Sent") : ""}`),
      m.author_user_id !== me && !m.hidden ? h("button", { class: "btn small", type: "button", "aria-label": `Report message from ${m.author_name}`, onclick: () => report(m.id, id) }, "Report") : null))),
    t.status === "open" ? h("form", { onsubmit: async (e) => { e.preventDefault(); try { await api.post(`/api/comms/threads/${id}/messages`, { body: input.value }); openThread(id); } catch { toast("Couldn't send."); } } },
      h("label", { for: "reply" }, "Reply"), input, h("button", { class: "btn primary", type: "submit" }, icon("send"), "Send"))
      : h("p", { class: "notice" }, `This conversation was locked by the school${t.lock_reason ? `: ${t.lock_reason}` : ""}.`),
    ["principal", "superintendent"].includes(state.me.role) && t.status === "open" ? h("button", { class: "btn danger", type: "button", onclick: async () => { const reason = await ask({ title: "Lock this conversation?", label: "Reason (shown to participants)", confirm: "Lock conversation", danger: true }); if (reason) { await api.post(`/api/comms/threads/${id}/lock`, { reason }); openThread(id); } } }, "Lock conversation") : null);
  $main().focus();
}
// ---- TEACH-01: the district teacher network -----------------------------
// Teachers and principals at every school in the district: find colleagues,
// message them, and keep open groups. Conversations open in Messages.
/** Choose colleagues from the district directory; resolves to their records (or null). */
async function pickColleagues({ title, confirm, multiple = true, exclude = [] }) {
  const d = (await api.get("/api/network/colleagues")).data;
  return new Promise(resolve => {
    const dlg = h("dialog", { class: "dialog", "aria-labelledby": "pick-t" });
    const done = v => { dlg.close(); dlg.remove(); resolve(v); };
    const q = h("input", { id: "pick-q", type: "search", placeholder: "Name or school", autocomplete: "off" });
    const list = h("ul", { class: "list pick" });
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      const people = d.colleagues.filter(c => !exclude.includes(c.user_id) && (!term || c.name.toLowerCase().includes(term) || c.schools.some(x => x.name.toLowerCase().includes(term))));
      list.replaceChildren(...(people.length ? people.slice(0, 60).map(c => h("li", {}, h("label", { class: "row" },
        h("input", { type: multiple ? "checkbox" : "radio", name: "pick", value: c.user_id }),
        h("span", { class: "grow" }, h("b", {}, c.name), h("br"), h("span", { class: "small muted" }, `${c.roles.map(r => APP_NAME[r] || r).join(", ")} · ${c.schools.map(x => x.name).join(", ")}`)))))
        : [h("li", {}, empty("Nobody matches."))]));
    };
    q.addEventListener("input", draw); draw();
    dlg.append(h("form", { method: "dialog", onsubmit: e => { e.preventDefault(); const ids = [...list.querySelectorAll("input:checked")].map(x => x.value); if (ids.length) done(d.colleagues.filter(c => ids.includes(c.user_id))); } },
      h("h2", { id: "pick-t" }, title), h("label", { for: q.id }, "Search colleagues across the district"), q, list,
      h("div", { class: "btns" }, h("button", { class: "btn primary", type: "submit" }, confirm), h("button", { class: "btn", type: "button", onclick: () => done(null) }, "Cancel"))));
    dlg.addEventListener("cancel", e => { e.preventDefault(); done(null); });
    document.body.append(dlg); dlg.showModal(); q.focus();
  });
}
async function addColleagues(threadId) {
  const t = (await api.get(`/api/comms/threads/${threadId}`)).data;
  const people = await pickColleagues({ title: "Add colleagues", confirm: "Add", exclude: t.participants.map(p => p.user_id) });
  if (!people) return;
  try { const r = await api.post(`/api/network/threads/${threadId}/participants`, { userIds: people.map(c => c.user_id) }); toast(`Added ${r.data.added}`); openThread(threadId); }
  catch { toast("Couldn't add them."); }
}
function messageColleague(c) {
  return new Promise(resolve => {
    const dlg = h("dialog", { class: "dialog", "aria-labelledby": "mc-t" });
    const done = v => { dlg.close(); dlg.remove(); resolve(v); };
    const subject = h("input", { id: "mc-s", maxlength: 160, required: true }), body = h("textarea", { id: "mc-b", maxlength: 4000, required: true, rows: 4 });
    dlg.append(h("form", { method: "dialog", onsubmit: async e => { e.preventDefault();
        try { const r = await api.post("/api/network/threads", { participantIds: c.map(x => x.user_id), subject: subject.value, body: body.value }); done(r.data.id); }
        catch { toast("Couldn't send."); } } },
      h("h2", { id: "mc-t" }, `Message ${c.map(x => x.name).join(", ")}`),
      h("label", { for: subject.id }, "Subject"), subject, h("label", { for: body.id }, "Message"), body,
      h("div", { class: "btns" }, h("button", { class: "btn primary", type: "submit" }, icon("send"), "Send"), h("button", { class: "btn", type: "button", onclick: () => done(null) }, "Cancel"))));
    dlg.addEventListener("cancel", e => { e.preventDefault(); done(null); });
    document.body.append(dlg); dlg.showModal(); subject.focus();
  });
}
// ---- TEACH-02: shared materials ---------------------------------------
function dialogForm(title, build, submitText) {
  return new Promise(resolve => {
    const dlg = h("dialog", { class: "dialog", "aria-labelledby": "df-t" });
    const done = v => { dlg.close(); dlg.remove(); resolve(v); };
    const { fields, value } = build(done);
    dlg.append(h("form", { method: "dialog", onsubmit: async e => { e.preventDefault(); const v = await value(); if (v !== undefined) done(v); } },
      h("h2", { id: "df-t" }, title), fields,
      h("div", { class: "btns" }, submitText ? h("button", { class: "btn primary", type: "submit" }, submitText) : null, h("button", { class: "btn", type: "button", onclick: () => done(null) }, submitText ? "Cancel" : "Close"))));
    dlg.addEventListener("cancel", e => { e.preventDefault(); done(null); });
    document.body.append(dlg); dlg.showModal();
    (dlg.querySelector("input, textarea, select") || dlg.querySelector("button")).focus();
  });
}
async function shareMaterial(kind, id, title) {
  const summary = await dialogForm(`Share “${title}” with colleagues`, () => {
    const box = h("textarea", { id: "sm-sum", maxlength: 500, rows: 3, placeholder: "What it's for, what worked" });
    return { fields: [h("p", { class: "small muted" }, `Teachers and principals at every school in the district will see this ${kind === "unit" ? "unit and its lessons" : "lesson"} and can copy it into their own courses. Sharing again later updates it.`),
      h("label", { for: box.id }, "A note for colleagues (optional)"), box], value: () => box.value.trim() };
  }, "Share");
  if (summary === null) return;
  const post = confirmNotStudents => api.post("/api/materials", { kind, sourceId: id, summary: summary || null, confirmNotStudents });
  try { await post(false); toast("Shared with colleagues."); }
  catch (e) {
    if (e.body?.error !== "may_mention_students") return toast("Couldn't share it.");
    const sure = await ask({ title: "Does this mention a student?", text: `These words match students in the district: ${e.body.words.join(", ")}. Shared materials must not name students. Edit the text, or share it if these words aren't students (for example, a place or a historical person).`, confirm: "They aren't students: share", cancel: "Edit first" });
    if (!sure) return;
    try { await post(true); toast("Shared with colleagues."); } catch { toast("Couldn't share it."); }
  }
}
async function previewMaterial(id) {
  const m = (await api.get(`/api/materials/${id}`)).data;
  const lessonBlock = l => [h("h3", {}, l.title), h("p", {}, h("b", {}, "Goal: "), l.objective),
    l.standards?.length ? h("div", { class: "btns" }, l.standards.map(s => h("span", { class: "chip" }, s.code))) : null,
    h("div", { class: "lesson-text" }, l.content.split(/\n+/).map(p => h("p", {}, p))),
    l.sources?.length ? h("p", { class: "small muted" }, `Primary sources: ${l.sources.map(x => x.title).join("; ")}`) : null];
  await dialogForm(m.title, () => ({ fields: [
    h("p", { class: "small muted" }, `${m.kind === "unit" ? "Unit" : "Lesson"} · ${m.subject} · Grade ${m.grade_level} · ${m.author}, ${m.school}${m.version > 1 ? ` · updated (v${m.version})` : ""}`),
    m.summary ? h("p", {}, m.summary) : null,
    h("div", { class: "preview" }, m.kind === "unit" ? [m.body.summary ? h("p", { class: "small" }, m.body.summary) : null, ...m.body.lessons.map(lessonBlock)] : lessonBlock(m.body))], value: () => undefined }), null);
}
async function copyMaterial(m, endpoint = `/api/materials/${m.id}/copy`) {
  const courses = ((await api.get("/api/learning/courses")).data.courses || []);
  if (!courses.length) return toast("Make a course first, then copy into it.");
  const target = await dialogForm(`Copy “${m.title}”`, () => {
    const course = h("select", { id: "cm-course", required: true }, courses.map(c => h("option", { value: c.id }, `${c.title} · Grade ${c.grade_level}`)));
    const unit = h("select", { id: "cm-unit" });
    const unitRow = m.kind === "lesson" ? [h("label", { for: unit.id }, "Into unit"), unit] : null;
    const loadUnits = async () => {
      if (m.kind !== "lesson") return;
      const c = (await api.get(`/api/learning/courses/${course.value}`)).data;
      unit.replaceChildren(...(c.units.length ? c.units.map(u => h("option", { value: u.id }, `Unit ${u.seq}: ${u.title}`)) : [h("option", { value: "" }, "This course has no units yet")]));
    };
    course.addEventListener("change", loadUnits); loadUnits();
    return { fields: [h("p", { class: "small muted" }, `${m.kind === "unit" ? "The unit and its lessons are" : "The lesson is"} added to your course as drafts you can change. A school leader approves lessons before Christie uses them.`),
      h("label", { for: course.id }, "Into course"), course, unitRow],
      value: () => m.kind === "lesson" && !unit.value ? (toast("Choose a unit (or add one to the course first)."), undefined) : { courseId: course.value, unitId: m.kind === "lesson" ? unit.value : null } };
  }, "Copy");
  if (!target) return;
  try {
    const r = (await api.post(endpoint, target)).data;
    toast("Copied into your course as a draft.");
    r.kind === "lesson" ? openView("lesson", { lessonId: r.id }) : openView("course", { courseId: target.courseId });
  } catch (e) { toast(e.body?.error === "draft_incomplete" ? "Fill in every title, goal and lesson text first." : "Couldn't copy it."); }
}
async function materialsSection() {
  const f = state.matFilters ||= { q: "", kind: "" };
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  const list = (await api.get(`/api/materials${qs.size ? `?${qs}` : ""}`)).data;
  const q = h("input", { id: "mat-q", type: "search", value: f.q, placeholder: "Title, subject or note", autocomplete: "off" });
  const kind = h("select", { id: "mat-kind", "aria-label": "Lessons or units" }, [["", "Lessons and units"], ["lesson", "Lessons"], ["unit", "Units"]].map(([v, t]) => h("option", { value: v, selected: f.kind === v }, t)));
  return [h("form", { class: "row wrap", role: "search", onsubmit: e => { e.preventDefault(); state.matFilters = { q: q.value.trim(), kind: kind.value }; go("network", { push: false }); } },
      h("label", { for: q.id, class: "sr" }, "Search shared materials"), h("div", { class: "grow" }, q), kind, h("button", { class: "btn", type: "submit" }, "Search")),
    h("p", { class: "small muted" }, "To share your own, open a lesson or a unit in Courses and choose Share with colleagues."),
    h("section", { class: "card", "aria-label": "Shared materials" }, list.length ? h("ul", { class: "list" }, list.map(m => h("li", {},
      h("div", { class: "row" }, h("div", { class: "grow" }, h("b", {}, m.title),
        h("p", { class: "small muted" }, `${COACH_KIND[m.kind] ? `${COACH_KIND[m.kind]} · ${m.subject} · ${m.grade_level}` : `${m.kind === "unit" ? `Unit · ${m.lessons} lessons` : "Lesson"} · ${m.subject} · Grade ${m.grade_level}`} · ${m.mine ? "You" : m.author}, ${m.school}${m.copies ? ` · copied ${m.copies}×` : ""}`),
        m.summary ? h("p", { class: "small" }, m.summary) : null)),
      h("div", { class: "btns" }, h("button", { class: "btn small", type: "button", "aria-label": `Preview ${m.title}`, onclick: () => previewMaterial(m.id) }, "Preview"),
        ["teacher", "principal"].includes(state.me.role) && COACH_KIND[m.kind] ? h("button", { class: "btn small primary", type: "button", "aria-label": `Copy to my plans: ${m.title}`, onclick: () => copyCoachingPlan(m.id) }, "Copy to my plans") : null,
        ["teacher", "principal"].includes(state.me.role) && !COACH_KIND[m.kind] ? h("button", { class: "btn small primary", type: "button", "aria-label": `Copy to my course: ${m.title}`, onclick: () => copyMaterial(m) }, "Copy to my course") : null,
        ["teacher", "principal"].includes(state.me.role) ? h("button", { class: "btn small", type: "button", "aria-label": `Co-write from: ${m.title}`, onclick: () => startDraft({ from: "material", sourceId: m.id }) }, "Co-write from") : null,
        m.mine ? h("button", { class: "btn small", type: "button", "aria-label": `Stop sharing ${m.title}`, onclick: async () => { if (!(await ask({ title: "Stop sharing?", text: "Colleagues won't see it any more. Copies they already made stay theirs.", confirm: "Stop sharing" }))) return;
          try { await api.post(`/api/materials/${m.id}/withdraw`, {}); toast("No longer shared."); go("network", { push: false }); } catch { toast("Couldn't change it."); } } }, "Stop sharing") : null))))
      : empty(f.q || f.kind ? "Nothing matches." : "Nothing shared yet. Share a lesson from Courses to start the library."))];
}
// ---- TEACH-03: co-writing ------------------------------------------------
async function startDraft(spec) {
  try { const r = (await api.post("/api/drafts", spec)).data; toast("Draft started. Add colleagues to write it together."); openView("draft", { draftId: r.id }); }
  catch { toast("Couldn't start the draft."); }
}
async function draftsSection() {
  const list = (await api.get("/api/drafts")).data;
  const kind = h("select", { id: "dr-kind" }, h("option", { value: "lesson" }, "A lesson"), h("option", { value: "unit" }, "A unit"));
  const title = h("input", { id: "dr-title", maxlength: 120, placeholder: "Working title" });
  const subject = h("input", { id: "dr-subject", maxlength: 40, required: true, placeholder: "e.g. Math" });
  const grade = h("input", { id: "dr-grade", maxlength: 4, required: true, placeholder: "e.g. 4", inputmode: "text" });
  return [h("p", { class: "muted small" }, "Write a lesson or unit together with colleagues at any school. Drafts sit outside your courses, so no students or class lists are shared. When it's ready, copy it into your course or put it in the library."),
    h("section", { class: "card", "aria-label": "Your drafts" }, h("h3", {}, "Your drafts"), list.length ? h("ul", { class: "list" }, list.map(d => h("li", { class: "row" },
      h("div", { class: "grow" }, h("b", {}, d.title), h("p", { class: "small muted" }, `${d.kind === "unit" ? "Unit" : "Lesson"} · ${d.subject} · Grade ${d.grade_level}${d.with_names ? ` · with ${d.with_names}` : " · just you so far"} · saved by ${d.updated_by} ${ago(d.updated_at)}`)),
      h("button", { class: "btn", type: "button", "aria-label": `Open draft: ${d.title}`, onclick: () => openView("draft", { draftId: d.id }) }, "Open"))))
      : empty("No drafts yet. Start one here, or choose Co-write on a lesson or a shared material.")),
    h("section", { class: "card", "aria-label": "Start a draft" }, h("h3", {}, "Start a draft"),
      h("form", { class: "stack", onsubmit: e => { e.preventDefault(); startDraft({ from: "blank", kind: kind.value, title: title.value.trim(), subject: subject.value.trim(), gradeLevel: grade.value.trim() }); } },
        h("label", { for: kind.id }, "What are you writing?"), kind, h("label", { for: title.id }, "Title (optional)"), title,
        h("div", { class: "row" }, h("div", { class: "grow" }, h("label", { for: subject.id }, "Subject"), subject), h("div", { class: "grow" }, h("label", { for: grade.id }, "Grade"), grade)),
        h("button", { class: "btn primary", type: "submit" }, "Start writing")))];
}
const blankLesson = () => ({ title: "", objective: "", content: "", standards: [], sources: [] });
VIEWS.draft = async () => {
  if (!state.draftId) { state.netView = "drafts"; return VIEWS.network(); }
  const d = (await api.get(`/api/drafts/${state.draftId}`)).data;
  const ed = state.draftEdit && state.draftEdit.id === d.id ? state.draftEdit : (state.draftEdit = { id: d.id, version: d.version, body: structuredClone(d.body), dirty: false, notice: null, theirs: null });
  const note = h("div", { "aria-live": "polite" }, ed.notice ? h("p", { class: `notice${ed.notice.warn ? " warn" : ""}` }, ed.notice.text) : null);
  const field = (obj, key, label, id, multi, max) => {
    const el = h(multi ? "textarea" : "input", { id, maxlength: max, ...(multi ? { rows: 6 } : {}) });
    el.value = obj[key] || "";
    el.addEventListener("input", () => { obj[key] = el.value; ed.dirty = true; });
    const mine = ed.theirs?.[id];
    return [h("label", { for: id }, label), el, mine != null ? h("details", { class: "yours", open: true }, h("summary", {}, "Your text (not saved: copy what you need)"), h("p", { class: "small" }, mine || "(empty)")) : null];
  };
  const lessonFields = (l, at, i = null) => [
    ...field(l, "title", "Title", `${at}title`, false, 120), ...field(l, "objective", "Goal (what learners will be able to do)", `${at}objective`, false, 300),
    ...field(l, "content", "Lesson text", `${at}content`, true, 8000),
    l.standards?.length ? h("p", { class: "small muted" }, `Standards: ${l.standards.map(s => s.code).join(", ")}`) : null,
    i !== null && ed.body.lessons.length > 1 ? h("button", { class: "btn small danger", type: "button", "aria-label": `Remove lesson ${i + 1}`, onclick: () => { ed.body.lessons.splice(i, 1); ed.dirty = true; go("draft", { push: false }); } }, "Remove lesson") : null];
  const editor = COACH_KIND[d.kind] ? h("div", { class: "stack" }, ...field(ed.body, "title", "Title", "d-title", false, 120), ...field(ed.body, "sport", "Sport", "d-sport", false, 40),
      ...field(ed.body, "summary", "What it's for", "d-summary", true, 1000), planItemsEditor(ed.body, "d-i", () => { ed.dirty = true; go("draft", { push: false }); }, (obj, k, label, id, multi, max) => field(obj, k, label, id, multi, max)))
    : d.kind === "lesson" ? h("div", { class: "stack" }, ...lessonFields(ed.body, "d-"))
    : h("div", { class: "stack" }, ...field(ed.body, "title", "Unit title", "d-title", false, 120), ...field(ed.body, "summary", "Unit summary", "d-summary", true, 1000),
        ed.body.lessons.map((l, i) => h("fieldset", { class: "card" }, h("legend", {}, `Lesson ${i + 1}`), ...lessonFields(l, `d-l${i}-`, i))),
        ed.body.lessons.length < 30 ? h("button", { class: "btn", type: "button", onclick: () => { ed.body.lessons.push(blankLesson()); ed.dirty = true; go("draft", { push: false }); } }, "Add a lesson") : null);
  const save = async () => {
    try {
      const r = (await api.req("PUT", `/api/drafts/${d.id}`, { baseVersion: ed.version, body: ed.body })).data;
      Object.assign(ed, { version: r.version, body: r.body, dirty: false, theirs: null,
        notice: r.warnings.length ? { warn: true, text: `Saved. These words match students in the district: ${r.warnings.join(", ")}. Shared drafts must not name students.` }
          : { text: r.merged ? "Saved, together with a colleague's changes made at the same time." : "Saved." } });
    } catch (e) {
      if (e.body?.error !== "edit_conflict") { toast("Couldn't save."); return; }
      // Theirs goes in the editor; mine stays visible beside each field that clashed.
      const at = p => p.replace(/^lessons\[(\d+)\]\.(\w+)$/, "d-l$1-$2").replace(/^items\[(\d+)\]\.(\w+)$/, "d-i$1-$2").replace(/^(\w+)$/, "d-$1");
      const get = (b, p) => p.split(/[.[\]]+/).filter(Boolean).reduce((o, k) => o?.[k], b);
      ed.theirs = Object.fromEntries(e.body.conflicts.filter(p => p !== "lessons").map(p => [at(p), String(get(ed.body, p) ?? "")]));
      Object.assign(ed, { version: e.body.current.version, body: structuredClone(e.body.current.body), dirty: true,
        notice: { warn: true, text: `${e.body.current.updatedBy} changed the same ${e.body.conflicts.length > 1 ? "parts" : "part"} while you were writing. Their version is in the editor now; your text is shown below each part. Edit, then save again.` } });
    }
    go("draft", { push: false });
  };
  // Pick up colleagues' saves while you aren't typing; while you are, a save merges.
  state.draftTimer = setInterval(async () => {
    const now = (await safe(api.get(`/api/drafts/${d.id}`)))?.data;
    if (!now || now.version === ed.version || state.tab !== "draft") return;
    if (!ed.dirty) { Object.assign(ed, { version: now.version, body: structuredClone(now.body), notice: { text: `${now.updatedBy} saved a newer version.` } }); go("draft", { push: false }); }
    else if (!ed.notice?.newer) { ed.notice = { newer: true, text: `${now.updatedBy} saved a newer version. Saving will combine your changes with theirs.` }; note.replaceChildren(h("p", { class: "notice" }, ed.notice.text)); }
  }, 20000);
  return [h("button", { class: "btn", type: "button", onclick: () => { state.draftEdit = null; state.netView = "drafts"; go("network"); } }, "‹ Co-write"),
    h("section", { class: "card", "aria-label": "Draft" }, h("p", { class: "small muted" }, `${d.kind === "unit" ? "Unit" : "Lesson"} draft · ${d.subject} · Grade ${d.gradeLevel} · version ${ed.version}`),
      h("h2", {}, d.title), h("p", { class: "small" }, `Writing together: ${d.editors.map(e => `${e.name}${e.school ? ` (${e.school})` : ""}`).join(", ")}`),
      h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: async () => {
          const people = await pickColleagues({ title: "Invite colleagues to co-write", confirm: "Invite", exclude: d.editors.map(e => e.user_id) }); if (!people) return;
          try { const r = await api.post(`/api/drafts/${d.id}/editors`, { userIds: people.map(c => c.user_id) }); toast(`Invited ${r.data.added}`); go("draft", { push: false }); } catch { toast("Couldn't invite them."); } } }, icon("people"), "Invite colleagues"),
        h("button", { class: "btn", type: "button", onclick: async () => { if (!(await ask({ title: "Leave this draft?", text: "You won't see it any more. Another editor can invite you back.", confirm: "Leave" }))) return;
          try { await api.post(`/api/drafts/${d.id}/leave`, {}); state.draftEdit = null; state.netView = "drafts"; go("network"); } catch { toast("Couldn't leave."); } } }, "Leave"))),
    note,
    h("form", { class: "card", "aria-label": "Edit the draft", onsubmit: e => { e.preventDefault(); save(); } }, editor, h("button", { class: "btn primary block", type: "submit" }, "Save")),
    h("section", { class: "card", "aria-label": "When it's ready" }, h("h3", {}, "When it's ready"),
      h("div", { class: "btns" }, COACH_KIND[d.kind]
          ? h("button", { class: "btn", type: "button", onclick: async () => { try { const r = (await api.post(`/api/drafts/${d.id}/copy`, {})).data; toast("Copied into your plans."); openView("coachplan", { coachPlanId: r.id }); } catch (e) { toast(e.body?.error === "draft_incomplete" ? "Give it a title, a sport, and a title for every drill first." : "Couldn't copy it."); } } }, "Copy to my plans")
          : h("button", { class: "btn", type: "button", onclick: () => copyMaterial({ id: d.id, kind: d.kind, title: d.title }, `/api/drafts/${d.id}/copy`) }, "Copy to my course"),
        h("button", { class: "btn", type: "button", onclick: async () => {
          const post = confirmNotStudents => api.post(`/api/drafts/${d.id}/publish`, { confirmNotStudents });
          try { await post(false); toast("In the library for every school."); }
          catch (e) {
            if (e.body?.error === "draft_incomplete") return toast("Fill in every title, goal and lesson text first.");
            if (e.body?.error !== "may_mention_students") return toast(e.body?.error === "not_the_author" ? "Another editor published it; they can update it." : "Couldn't publish it.");
            if (await ask({ title: "Does this mention a student?", text: `These words match students in the district: ${e.body.words.join(", ")}. Edit the draft, or publish if they aren't students.`, confirm: "They aren't students: publish", cancel: "Edit first" }))
              try { await post(true); toast("In the library for every school."); } catch { toast("Couldn't publish it."); }
          } } }, "Put in the library"))),
    h("details", { class: "card" }, h("summary", {}, `History (${d.revisions.length})`), h("ul", { class: "list" }, d.revisions.map(r => h("li", { class: "row" },
      h("span", { class: "grow small" }, `Version ${r.version} · ${r.edited_by} · ${ago(r.edited_at)}${r.merged ? " · combined with a colleague's changes" : ""}`),
      h("button", { class: "btn small", type: "button", "aria-label": `View version ${r.version}`, onclick: async () => {
        const v = (await api.get(`/api/drafts/${d.id}/revisions/${r.version}`)).data;
        const ls = v.body.lessons || [v.body];
        await dialogForm(`Version ${v.version} · ${v.edited_by}`, () => ({ fields: [h("div", { class: "preview" }, v.body.summary ? h("p", {}, v.body.summary) : null,
          ls.map(l => [h("h3", {}, l.title || "(untitled)"), h("p", {}, h("b", {}, "Goal: "), l.objective || "–"), h("div", { class: "lesson-text" }, (l.content || "–").split(/\n+/).map(p => h("p", {}, p)))]))], value: () => undefined }), null);
      } }, "View")))))];
};
VIEWS.network = async () => {
  const view = state.netView || "people";
  const tabs = seg([["people", "Colleagues"], ["groups", "Groups"], ["materials", "Materials"], ["drafts", "Co-write"]], view, v => { state.netView = v; go("network", { push: false }); });
  const intro = h("p", { class: "muted small" }, "Teachers and principals at every school in the district. Conversations here are between colleagues: no student records, and families and students can't join.");
  if (view === "drafts") return [h("h2", {}, "Colleagues"), tabs, ...await draftsSection()];
  if (view === "materials") return [h("h2", {}, "Colleagues"), tabs, h("p", { class: "muted small" }, "Lessons and units shared by teachers across the district. Copy one into your course and make it yours."), ...await materialsSection()];
  if (view === "groups") {
    const groups = (await api.get("/api/network/groups")).data;
    const name = h("input", { id: "g-name", maxlength: 160, required: true, placeholder: "e.g. Grade 4 math" }), desc = h("input", { id: "g-desc", maxlength: 300, placeholder: "What the group is for" });
    const start = h("form", { class: "stack", onsubmit: async e => { e.preventDefault();
        try { const r = await api.post("/api/network/groups", { name: name.value, description: desc.value.trim() || null }); toast("Group started."); openThread(r.data.id); }
        catch { toast("Couldn't start the group."); } } },
      h("label", { for: name.id }, "Group name"), name, h("label", { for: desc.id }, "Description (optional)"), desc,
      h("button", { class: "btn primary", type: "submit" }, "Start a group"));
    return [h("h2", {}, "Colleagues"), tabs, intro,
      h("section", { class: "card", "aria-label": "Groups" }, h("h3", {}, "Groups in the district"),
        groups.length ? h("ul", { class: "list" }, groups.map(g => h("li", { class: "row" },
          h("div", { class: "grow" }, h("b", {}, g.name), g.description ? h("p", { class: "small" }, g.description) : null,
            h("p", { class: "small muted" }, `${g.members} member${g.members === 1 ? "" : "s"} · started at ${g.started_at_school} · active ${ago(g.last_message_at)}`)),
          g.joined ? h("button", { class: "btn", type: "button", "aria-label": `Open ${g.name}`, onclick: () => openThread(g.id) }, "Open")
            : h("button", { class: "btn primary", type: "button", "aria-label": `Join ${g.name}`, onclick: async () => { try { await api.post(`/api/network/groups/${g.id}/join`); toast(`Joined ${g.name}`); openThread(g.id); } catch { toast("Couldn't join."); } } }, "Join"))))
          : empty("No groups yet. Start one for your grade, subject or project.")),
      h("section", { class: "card", "aria-label": "Start a group" }, h("h3", {}, "Start a group"), start)];
  }
  const q = state.netQuery || "";
  const d = (await api.get(`/api/network/colleagues${q ? `?q=${encodeURIComponent(q)}` : ""}`)).data;
  const search = h("input", { id: "net-q", type: "search", value: q, placeholder: "Name or school", autocomplete: "off" });
  return [h("h2", {}, "Colleagues"), tabs, intro,
    h("form", { class: "row", role: "search", onsubmit: e => { e.preventDefault(); state.netQuery = search.value.trim(); go("network", { push: false }); } },
      h("label", { for: search.id, class: "sr" }, "Search colleagues"), h("div", { class: "grow" }, search), h("button", { class: "btn", type: "submit" }, "Search")),
    h("button", { class: "btn block", type: "button", onclick: async () => {
      const people = await pickColleagues({ title: "Message several colleagues", confirm: "Next" }); if (!people) return;
      const id = await messageColleague(people); if (id) openThread(id); } }, icon("people"), "Message several colleagues"),
    h("section", { class: "card", "aria-label": "Colleagues" }, d.colleagues.length ? h("ul", { class: "list" }, d.colleagues.map(c => h("li", { class: "row" },
      h("div", { class: "grow" }, h("b", {}, c.name), h("p", { class: "small muted" }, `${c.roles.map(r => APP_NAME[r] || r).join(", ")} · ${c.schools.map(x => x.name).join(", ")}`)),
      h("button", { class: "btn", type: "button", "aria-label": `Message ${c.name}`, onclick: async () => { const id = await messageColleague([c]); if (id) openThread(id); } }, icon("chat"), "Message"))))
      : empty(q ? "Nobody matches." : "No colleagues found."))];
};
async function report(messageId, threadId) {
  const reason = await ask({ title: "Report this message", text: "A school leader will review it. The sender is not told who reported it.", label: "Why are you reporting it?", confirm: "Report" });
  if (!reason) return;
  try { await api.post(`/api/comms/messages/${messageId}/report`, { reason }); toast("Reported to the school"); openThread(threadId); } catch { toast("Couldn't report."); }
}
async function compose() {
  const contacts = (await api.get("/api/comms/contacts")).data;
  const role = state.me.role;
  const family = role === "parent" || role === "teacher" || role === "principal";
  const opts = contacts.map((c, i) => h("option", { value: String(i) }, `${c.name} (${c.role})${c.student_name ? ` · about ${c.student_name}` : ""}`));
  const who = h("select", { id: "to", required: true }, h("option", { value: "" }, "Choose…"), opts);
  const subject = h("input", { id: "subject", maxlength: 160, required: true });
  const body = h("textarea", { id: "body", maxlength: 4000, required: true });
  put(h("button", { class: "btn", type: "button", onclick: () => go("messages", { push: false }) }, "‹ Back"), h("h2", {}, "New message"),
    contacts.length ? h("form", { class: "card", onsubmit: async (e) => {
      e.preventDefault();
      const c = contacts[Number(who.value)];
      if (!c) return toast("Choose who to message.");
      const kind = c.student_id && family ? "family" : "staff";
      try {
        const r = await api.post("/api/comms/threads", { kind, subject: subject.value, body: body.value, participantIds: [c.user_id], ...(kind === "family" ? { studentId: c.student_id } : {}) });
        openThread(r.data.id);
      } catch (err) { toast(err.body?.error === "participant_not_allowed" ? "You can't message that person here." : "Couldn't send."); }
    } }, h("label", { for: "to" }, "To"), who, h("label", { for: "subject" }, "Subject"), subject, h("label", { for: "body" }, "Message"), body,
      h("p", { class: "small muted" }, "Family conversations are between a learner's guardians and the staff who work with them. School leaders can review reported messages."),
      h("button", { class: "btn primary", type: "submit" }, icon("send"), "Send")) : empty("There's nobody you can message yet."));
  $main().focus();
}

// ---------------- in-app dialogs (replace the browser's prompt/confirm) ----------------
// ask({ title, text, label?, confirm, danger }) -> the typed text, true (no input) or null.
function ask({ title, text = null, label = null, confirm = "OK", cancel = "Cancel", danger = false, maxlength = 500, value = "" }) {
  return new Promise(resolve => {
    const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
    const input = label ? h("textarea", { id: `${id}-in`, maxlength, required: true, rows: 3 }) : null;
    if (input) input.value = value;
    const dlg = h("dialog", { class: `dialog${danger ? " danger" : ""}`, "aria-labelledby": `${id}-t`, "aria-describedby": text ? `${id}-d` : false });
    const done = v => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(h("form", { method: "dialog", onsubmit: (e) => { e.preventDefault(); if (input && !input.value.trim()) { input.focus(); return; } done(input ? input.value.trim() : true); } },
      h("h2", { id: `${id}-t` }, title), text ? h("p", { id: `${id}-d` }, text) : null,
      input ? [h("label", { for: input.id }, label), input] : null,
      h("div", { class: "btns" }, h("button", { class: `btn ${danger ? "danger" : "primary"}`, type: "submit" }, confirm), h("button", { class: "btn", type: "button", onclick: () => done(null) }, cancel))));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(null); });
    document.body.append(dlg);
    dlg.showModal();
    (input || dlg.querySelector("button")).focus();
  });
}

// ---------------- SafetyOS ----------------
const KIND_TEXT = { lockdown: "LOCKDOWN", shelter: "SHELTER IN PLACE", evacuate: "EVACUATE", hold: "HOLD IN ROOMS" };
// SAFE-03: hazards (src/safety-model.js HAZARD_LABEL / HAZARD_KIND).
const HAZARD_TEXT = { tornado: "Tornado warning", severe_thunderstorm: "Severe thunderstorm", lightning: "Lightning", hurricane: "Hurricane", flood: "Flooding",
  winter_storm: "Winter storm", extreme_heat: "Extreme heat", earthquake: "Earthquake", hazmat: "Hazardous materials" };
const HAZARD_KIND = { tornado: "shelter", severe_thunderstorm: "shelter", lightning: "hold", hurricane: "shelter", flood: "shelter", winter_storm: "hold", extreme_heat: "hold", earthquake: "shelter", hazmat: "shelter" };
const KIND_HELP = { lockdown: "Threat inside or near the building", shelter: "Weather or hazardous air", evacuate: "Leave the building", hold: "Keep halls clear" };
function sosBanner(i) {
  const status = i.status === "reunification" ? "REUNIFICATION" : `${KIND_TEXT[i.kind]}${i.hazard ? `: ${HAZARD_TEXT[i.hazard].toUpperCase()}` : ""}`;
  return h("section", { class: `sos-banner ${i.status === "reunification" ? "reunify" : i.kind}`, "aria-labelledby": `sos-${i.id}` },
    i.isDrill ? h("p", { class: "drill" }, "DRILL · THIS IS A DRILL") : h("p", { class: "drill real" }, "THIS IS NOT A DRILL"),
    h("div", { class: "row" }, icon("shield"), h("div", { class: "grow" }, h("h2", { id: `sos-${i.id}` }, status), h("p", { class: "small" }, `${i.schoolName} · since ${fmtTime(i.startedAt)}`))),
    h("p", { class: "sos-msg" }, i.message),
    i.instructions ? h("p", { class: "sos-note" }, h("strong", {}, "From the school: "), i.instructions) : null,
    i.status === "reunification" && i.reunificationPoint ? h("p", { class: "sos-note" }, h("strong", {}, "Reunification point: "), i.reunificationPoint) : null);
}
VIEWS.safety = async () => {
  const list = liveIncidents();
  if (!list.length) return [h("h2", {}, "Safety"), weatherPromptCard(), empty("No emergency is active. The school will alert you here if one starts.")];
  const role = state.me.role, out = [];
  for (const i of list) {
    out.push(sosBanner(i));
    if (role === "parent") {
      out.push(h("section", { class: "card", "aria-label": "Your children" }, h("h2", {}, "Your children at this school"),
        i.children ? h("ul", { class: "list" }, i.children.map(c => h("li", { class: "row" }, h("span", { class: "grow" }, c.name),
          c.released ? chip("present", `Released to ${c.released.adult} · ${fmtTime(c.released.at)}`) : chip("expected", "With staff")))) :
          h("p", {}, "Students are with school staff. We will tell you here when and where to collect your child."),
        i.status === "reunification" ? h("button", { class: "btn primary block", type: "button", onclick: () => go("pickup") }, icon("qr"), "Show my pick-up pass") : null),
        h("p", { class: "notice" }, "Please don't call or come to the school unless asked. EduOS shares only what you need here; it never tracks anyone's location."));
    } else if (role === "teacher") {
      out.push(await roomStatusCard(i));
      out.push(await rollCallCard(i));
      if (i.status === "reunification") out.push(h("button", { class: "btn school block", type: "button", onclick: () => go("pickup") }, icon("car"), "Pick-up line: release to approved adults"));
    } else if (role === "principal" || role === "vice_principal" || role === "superintendent") {
      out.push(await roomBoardCard(i));
      out.push(await boardCards(i));
      out.push(await sroCoordinationCard(i));
      if (role !== "superintendent") out.push(await roomStatusCard(i, true));
    } else if (role === "sro") {
      out.push(await roomBoardCard(i));
      out.push(await roomStatusCard(i));
      out.push(await sroIncidentCard(i));
    } else if (ROOM_REPORTERS.includes(role)) {
      out.push(await roomStatusCard(i));
    } else if (role === "pupil") {
      out.push(h("p", { class: "notice" }, "Stay with your teacher. Your phone does not need to do anything."));
    }
  }
  return out;
};
async function sroIncidentCard(i) {
  const card=h("section",{class:"card","aria-label":"SRO incident workspace"});
  try {
    const m=(await api.get(`/api/safety/incidents/${i.id}/sro-status`)).data;
    const latest=m.updates?.[0];
    const statuses=[["requested","Requested"],["notified","Notified"],["responding","Responding"],["on_scene","On scene"],["cleared","Cleared"],["unavailable","Unavailable"]];
    card.append(h("h2",{},"School Resource Officer (SRO) incident workspace"),
      h("p",{},`${i.schoolName} · ${i.label} · ${i.status}`),
      latest?h("p",{class:"notice"},`Latest SRO status: ${statuses.find(x=>x[0]===latest.status)?.[1]||latest.status} · ${fmtTime(latest.recordedAt)}`):empty("No SRO status update has been recorded."),
      h("p",{class:"small muted"},"This limited workspace shows incident coordination status only. It does not provide student rosters, roll-call details, guardian information, or release authorization."));
    const form=h("form",{class:"stack",onsubmit:async e=>{
      e.preventDefault(); const f=e.currentTarget;
      try { await api.post(`/api/safety/incidents/${i.id}/sro-status`,{status:f.elements.status.value,officerName:f.elements.officerName.value.trim()||null,unit:f.elements.unit.value.trim()||null,note:f.elements.note.value.trim()||null}); toast("SRO status recorded."); go("safety",{push:false}); }
      catch { toast("Unable to record SRO status. Check assignment and permissions."); }
    }},
      h("label",{},"SRO status",h("select",{name:"status"},statuses.map(([v,l])=>h("option",{value:v},l)))),
      h("label",{},"Officer name (optional)",h("input",{name:"officerName",maxlength:100})),
      h("label",{},"Agency / unit (optional)",h("input",{name:"unit",maxlength:100})),
      h("label",{},"Operational note (optional)",h("textarea",{name:"note",maxlength:300,rows:2})),
      h("button",{class:"btn primary",type:"submit"},"Update SRO status"));
    card.append(form);
  } catch { card.append(h("h2",{},"SRO incident workspace"),empty("No active incident is assigned to your school.")); }
  return card;
}
async function sroCoordinationCard(i) {
  const card = h("section", { class: "card", "aria-label": "School Resource Officer coordination" });
  const statuses = [["requested","Requested"],["notified","Notified"],["responding","Responding"],["on_scene","On scene"],["cleared","Cleared"],["unavailable","Unavailable"]];
  const refresh = async () => {
    const m = (await api.get(`/api/safety/incidents/${i.id}/sro-status`)).data;
    const latest = m.updates?.[0];
    card.replaceChildren(h("h2", {}, "School Resource Officer (SRO) coordination"),
      h("p", { class: "small muted" }, "Record the SRO coordination status for this incident. This does not contact or dispatch law enforcement."),
      latest ? h("p", { class: "notice" }, `Latest status: ${statuses.find(x => x[0] === latest.status)?.[1] || latest.status}${latest.officerName ? ` · ${latest.officerName}` : ""}${latest.unit ? ` · ${latest.unit}` : ""} · ${fmtTime(latest.recordedAt)}`) : empty("No SRO status has been recorded for this incident."),
      h("form", { class: "stack", onsubmit: async e => {
        e.preventDefault();
        const form=e.currentTarget;
        const payload={status:form.elements.status.value,officerName:form.elements.officerName.value.trim()||null,unit:form.elements.unit.value.trim()||null,note:form.elements.note.value.trim()||null};
        try { await api.post(`/api/safety/incidents/${i.id}/sro-status`,payload); toast("SRO status recorded."); await refresh(); }
        catch { toast("Unable to record SRO status. Check your connection and permissions."); }
      } },
        h("label", {}, "SRO status", h("select", { name:"status" }, statuses.map(([v,label])=>h("option",{value:v},label)))),
        h("label", {}, "Officer name (optional)", h("input",{name:"officerName",maxlength:100,autocomplete:"off"})),
        h("label", {}, "Agency / unit (optional)", h("input",{name:"unit",maxlength:100,autocomplete:"off"})),
        h("label", {}, "Operational note (optional)", h("textarea",{name:"note",maxlength:300,rows:2})),
        h("button",{class:"btn primary",type:"submit"},"Save SRO status")),
      m.updates?.length ? h("div",{},h("h3",{},"SRO update history"),h("ul",{class:"list"},m.updates.map(x=>h("li",{},`${statuses.find(v=>v[0]===x.status)?.[1]||x.status}${x.officerName?` · ${x.officerName}`:""}${x.unit?` · ${x.unit}`:""} · ${fmtTime(x.recordedAt)}`)))) : null);
  };
  try { await refresh(); } catch { card.replaceChildren(h("h2",{},"School Resource Officer (SRO) coordination"),empty("SRO coordination details are unavailable.")); }
  return card;
}
async function rollCallCard(i) {
  const d = (await api.get(`/api/safety/incidents/${i.id}/rollcall`)).data;
  const marks = new Map([...d.learners, ...d.extras].filter(l => l.status).map(l => [l.studentId, l.status]));
  const extras = [...d.extras];
  const card = h("section", { class: "card", "aria-label": "Roll call" });
  const draw = () => {
    const opts = [["present", "Present"], ["missing", "Missing"], ["injured", "Injured"]];
    card.replaceChildren(h("h2", {}, "Roll call · my class"),
      h("p", { class: "small muted" }, d.submittedAt ? `Last sent ${fmtTime(d.submittedAt)}. You can update it any time.` : "Mark everyone, then send. The office sees it right away."),
      d.learners.length ? h("ul", { class: "list" }, d.learners.map(l => h("li", {}, h("h3", {}, l.name),
        h("div", { class: "seg", role: "group", "aria-label": `${l.name}: status` }, opts.map(([v, t]) => h("button", { type: "button", "aria-pressed": String(marks.get(l.studentId) === v), class: v,
          onclick: () => { marks.set(l.studentId, v); draw(); } }, t)))))) : empty("No learners on your roster."),
      extras.length ? h("div", {}, h("h3", {}, "Also in my room"), h("ul", { class: "list" }, extras.map(x => h("li", { class: "row" }, h("span", { class: "grow" }, x.name), chip("current", "Extra"))))) : null,
      h("form", { class: "row", onsubmit: async (e) => {
        e.preventDefault();
        const q = e.target.querySelector("input").value.trim(); if (q.length < 2) return;
        const found = (await api.get(`/api/safety/incidents/${i.id}/students?q=${encodeURIComponent(q)}`)).data.filter(f => !d.learners.some(l => l.studentId === f.studentId) && !extras.some(x => x.studentId === f.studentId));
        if (!found.length) return toast("No learner found at this school.");
        const f = found[0]; extras.push({ ...f, status: "extra" }); marks.set(f.studentId, "extra"); draw();
      } }, h("label", { for: "extra-q", class: "sr" }, "Add a learner from another class who is with you"),
        h("input", { id: "extra-q", placeholder: "Add a learner who is with you", autocomplete: "off", maxlength: 60 }), h("button", { class: "btn", type: "submit" }, "Add")),
      h("button", { class: "btn primary block big", type: "button", onclick: async () => {
        const entries = [...marks.entries()].map(([studentId, status]) => ({ studentId, status }));
        const unmarked = d.learners.filter(l => !marks.has(l.studentId)).length;
        if (!entries.length) return toast("Mark at least one learner.");
        if (unmarked && !(await ask({ title: "Send roll call?", text: `${unmarked} learner${unmarked > 1 ? "s are" : " is"} not marked yet. You can send now and update later.`, confirm: "Send now" }))) return;
        try { const sent = await api.post(`/api/safety/incidents/${i.id}/rollcall`, { entries }); d.submittedAt = new Date().toISOString();
          if (sent.queued) { toast("Roll call saved on this phone. It sends as soon as you're back online."); return draw(); }
          const r = sent.data; toast(`Roll call sent: ${r.counts.present} present, ${r.counts.missing} missing, ${r.counts.injured} injured`); draw(); }
        catch { toast("Couldn't send. Try again."); }
      } }, icon("check"), "Send roll call"));
  };
  draw();
  return card;
}
// ---- SAFE-01: room status during an emergency -------------------------------
const ROOM_REPORTERS = ["teacher", "principal", "vice_principal", "sro", "librarian", "counselor", "nurse", "coach", "maintenance", "lunch_staff", "school_secretary"];
const ROOM_STATUS_TEXT = { secured: "Secured", not_secured: "Not secured", needs_help: "Needs help", moved: "We moved out" };
const ROOM_NEED_TEXT = { medical: "Medical", threat: "Threat seen or heard", missing_student: "Missing student", other: "Other" };
const ROOM_CHIP = { secured: "present", not_secured: "absent", needs_help: "absent", moved: "expected" };
async function roomStatusCard(i, compact = false) {
  const d = (await safe(api.get(`/api/safety/incidents/${i.id}/my-room`)))?.data;
  const card = h(compact ? "details" : "section", { class: "card", "aria-label": "My room" });
  if (!d) return null;
  let status = d.last?.status || null, need = d.last?.need || "medical";
  const draw = () => {
    const room = h("select", { id: "rs-room" }, d.rooms.map(r => h("option", { value: r.id, selected: r.id === d.suggestedRoomId }, r.building ? `${r.name} (${r.building})` : r.name)),
      h("option", { value: "", selected: !d.suggestedRoomId }, "Somewhere else"));
    const place = h("input", { id: "rs-place", maxlength: 80, placeholder: "e.g. Gym, hallway B, bus loop", value: d.last?.place || "" });
    const placeRow = h("div", { hidden: Boolean(d.suggestedRoomId) || undefined }, h("label", { for: "rs-place" }, "Where are you?"), place);
    const shelterFor = id => (d.rooms.find(r => r.id === id)?.shelter) || (id ? null : d.defaultArea);
    const shelterNote = h("p", { class: "notice", "aria-live": "polite" });
    const showShelter = () => { const a = d.hazard ? shelterFor(room.value) : null;
      shelterNote.hidden = !d.hazard; shelterNote.textContent = d.hazard ? (a ? `${d.hazardLabel}: your shelter area is ${a.area}${a.route ? `. ${a.route}` : ""}.` : `${d.hazardLabel}: no shelter area is set for this room. Follow the school's plan.`) : ""; };
    room.onchange = () => { placeRow.hidden = Boolean(room.value); showShelter(); };
    showShelter();
    const needSel = h("select", { id: "rs-need", onchange: e => { need = e.target.value; } }, Object.entries(ROOM_NEED_TEXT).map(([k, t]) => h("option", { value: k, selected: k === need }, t)));
    const num = (id, label, max) => h("div", {}, h("label", { for: id }, label), h("input", { id, type: "number", inputmode: "numeric", min: 0, max, style: "width:6em" }));
    const body = [h(compact ? "summary" : "h2", {}, "My room"),
      d.last ? h("p", { class: "small" }, chip(ROOM_CHIP[d.last.status], ROOM_STATUS_TEXT[d.last.status]), ` Sent ${fmtTime(d.last.at)}. Send again whenever it changes.`)
        : h("p", { class: "small muted" }, "Tell the office how your room stands. Send again whenever it changes."),
      shelterNote, h("label", { for: "rs-room" }, "Room"), room, placeRow,
      h("div", { class: "seg", role: "group", "aria-label": "Room status" }, Object.entries(ROOM_STATUS_TEXT).map(([k, t]) =>
        h("button", { type: "button", class: k === "secured" ? "present" : k === "moved" ? "" : "missing", "aria-pressed": String(status === k), onclick: () => { status = k; draw(); } }, t))),
      status === "needs_help" ? h("div", {}, h("label", { for: "rs-need" }, "What help?"), needSel) : null,
      h("div", { class: "row wrap" }, num("rs-st", "Students with me", 500), num("rs-ad", "Adults", 50)),
      h("label", { for: "rs-note" }, "Note (optional, no student names)"), h("input", { id: "rs-note", maxlength: 200 }),
      h("button", { class: "btn primary block big", type: "button", onclick: async () => {
        if (!status) return toast("Choose how your room stands.");
        const n = id => { const v = document.getElementById(id).value; return v === "" ? null : Number(v); };
        const body = { status, ...(status === "needs_help" ? { need } : {}), students: n("rs-st"), adults: n("rs-ad"), note: document.getElementById("rs-note").value.trim() || null,
          ...(room.value ? { roomId: room.value } : { place: place.value.trim() }) };
        if (!room.value && !body.place) return toast("Say where you are.");
        try {
          const sent = await api.post(`/api/safety/incidents/${i.id}/room-status`, body);
          if (sent.queued) { toast("Saved on this phone. It sends as soon as you're back online."); return; }
          d.last = { status, need: body.need, at: new Date().toISOString(), place: body.place || null }; d.suggestedRoomId = body.roomId || null;
          toast(status === "needs_help" || status === "not_secured" ? "Sent. The office and the SRO were alerted." : "Sent."); draw();
        } catch { toast("Couldn't send. Try again."); }
      } }, icon("check"), "Send room status")];
    card.replaceChildren(...body.filter(Boolean));
  };
  draw();
  return card;
}
async function roomBoardCard(i) {
  const [b, dv] = await Promise.all([safe(api.get(`/api/safety/incidents/${i.id}/rooms`)).then(r => r?.data), safe(api.get(`/api/safety/incidents/${i.id}/displays`)).then(r => r?.data)]);
  if (!b) return null;
  const late = dv ? dv.devices.filter(d => !d.switched) : [];
  const t = b.totals;
  return h("section", { class: "card", "aria-label": "Rooms" }, h("div", { class: "row" }, h("h2", { class: "grow" }, "Rooms"), h("span", { class: "small muted" }, `${t.reported} of ${t.rooms} rooms reported`)),
    h("div", { class: "stats" }, stat(t.needs_help, "need help", true), stat(t.not_secured, "not secured", true), stat(t.secured, "secured"), stat(t.moved, "moved out"), stat(t.waiting, "not heard from", true)),
    b.rooms.length ? h("ul", { class: "list" }, b.rooms.map(r => h("li", {}, h("div", { class: "row wrap" }, h("strong", { class: "grow" }, r.building ? `${r.name} · ${r.building}` : r.name),
        r.report ? chip(ROOM_CHIP[r.report.status], r.report.status === "needs_help" ? `Needs help: ${ROOM_NEED_TEXT[r.report.need]}` : ROOM_STATUS_TEXT[r.report.status]) : chip("expected", "Not heard from")),
      r.report ? h("p", { class: "small muted" }, [r.report.students !== null ? `${r.report.students} students` : null, r.report.adults !== null ? `${r.report.adults} adults` : null,
        r.report.by, fmtTime(r.report.at)].filter(Boolean).join(" · ") + (r.report.note ? ` · ${r.report.note}` : "")) : null)))
      : empty("No rooms are set up for this school. Staff can still report where they are."),
    dv?.total ? h("p", { class: "small" }, `Classroom screens: ${dv.switched} of ${dv.total} switched${i.kind === "lockdown" && i.status === "active" ? " (dark and silent)" : ""}.`,
      late.length ? ` Not yet: ${late.slice(0, 6).map(d => `${d.name}${d.room ? ` (${d.room})` : ""}${d.lastSeenAt ? `, last heard ${fmtTime(d.lastSeenAt)}` : ", never heard from"}`).join("; ")}${late.length > 6 ? ` and ${late.length - 6} more` : ""}.` : "") : null,
    h("p", { class: "small muted" }, "Rooms report themselves; EduOS doesn't track anyone's location."));
}
// ---- SAFE-03: shelter areas per room and hazard ----------------------------
async function shelterAreasCard() {
  const d = (await api.get("/api/safety/shelter-areas")).data;
  const hz = state.shelterHazard || "tornado";
  const row = (label, roomId, cur, key) => {
    const inp = h("input", { id: `sa-${key}`, maxlength: 120, value: cur?.area || "", placeholder: roomId ? "Use the school default" : "e.g. Interior hallway, ground floor", disabled: !d.canEdit || undefined });
    return h("li", {}, h("label", { for: `sa-${key}` }, label), h("div", { class: "row wrap" }, inp,
      d.canEdit ? h("button", { class: "btn small", type: "button", "aria-label": `Save: ${label}`, onclick: async () => {
        try { await api.put("/api/safety/shelter-areas", { roomId, hazard: hz, area: inp.value.trim() }); toast(inp.value.trim() ? "Saved." : "Cleared."); go("devices", { push: false }); }
        catch { toast("Couldn't save it (2 to 120 characters)."); } } }, "Save") : null),
      cur ? h("p", { class: "small muted" }, `Set by ${cur.setBy} · ${fmtDay(cur.setAt)}`) : null);
  };
  return h("section", { class: "card", "aria-label": "Shelter areas" }, h("h3", {}, "Shelter areas"),
    h("p", { class: "small muted" }, "Where each room goes for each hazard. During a shelter, staff see their room's area and the room's screen shows it. A room without its own area uses the school default."),
    h("label", { for: "sa-hz" }, "Hazard"), h("select", { id: "sa-hz", onchange: e => { state.shelterHazard = e.target.value; go("devices", { push: false }); } },
      d.hazards.map(x => h("option", { value: x.key, selected: x.key === hz }, x.label))),
    h("ul", { class: "list" }, row("School default", null, d.defaults[hz], "default"), d.rooms.map(r => row(r.building ? `${r.name} (${r.building})` : r.name, r.id, r.areas[hz], r.id))));
}
// ---- SAFE-04: National Weather Service prompts -----------------------------
function weatherPromptCard() {
  const list = state.weather || [];
  if (!list.length) return null;
  return h("section", { class: "card", "aria-label": "Weather warnings" }, h("h3", {}, "National Weather Service warnings"),
    h("ul", { class: "list" }, list.map(w => h("li", {}, h("b", {}, `${w.event}: ${w.school}`),
      h("p", { class: "small" }, `${w.headline || ""}${w.expires ? ` Until ${fmtTime(w.expires)}.` : ""}`),
      w.instruction ? h("p", { class: "small muted" }, w.instruction.slice(0, 300)) : null,
      h("div", { class: "btns" },
        h("button", { class: "btn danger small", type: "button", "aria-label": `Start ${w.suggestedKind === "hold" ? "hold" : "shelter"}: ${w.hazardLabel}, ${w.school}`, onclick: () => {
          Object.assign(state, { sosKind: w.suggestedKind, sosHazard: w.hazard, sosWeatherId: w.id, sosDrill: false }); go("sos"); } },
          `Start ${w.suggestedKind === "hold" ? "hold" : "shelter"}: ${w.hazardLabel}`),
        h("button", { class: "btn small", type: "button", "aria-label": `Dismiss: ${w.event}, ${w.school}`, onclick: async () => {
          const note = await ask({ title: `Dismiss the ${w.event}?`, label: "Why (e.g. outside our area, already sheltering)", confirm: "Dismiss" }); if (!note) return;
          try { await api.post(`/api/safety/weather/${w.id}/dismiss`, { note }); state.weather = list.filter(x => x.id !== w.id); toast("Dismissed."); go(state.tab, { push: false }); }
          catch (e) { const gone = e?.status === 409 || e?.status === 410; if (gone) state.weather = list.filter(x => x.id !== w.id);
            toast(e?.status === 409 ? "Another leader already decided this warning." : e?.status === 410 ? "This warning has ended or expired." : "Couldn't dismiss it.");
            if (gone) go(state.tab, { push: false }); } } }, "Dismiss"))))),
    h("p", { class: "small muted" }, "From api.weather.gov. EduOS never starts an alert on its own: you start it (with the usual confirm) or dismiss it."));
}
async function weatherSettingsCard() {
  const d = (await safe(api.get("/api/safety/weather")))?.data;
  if (!d) return null;
  const info = d.alerts.filter(a => !a.prompt);
  return h("section", { class: "card", "aria-label": "Weather alerts" }, h("h3", {}, "Weather alerts"),
    h("p", { class: "small muted" }, "EduOS can check the National Weather Service every two minutes for each school's location and prompt you when a warning (tornado, severe thunderstorm, hurricane, flooding, winter storm, extreme heat, hazardous materials) covers it. Only the school's coordinates are sent."),
    d.canToggle ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: d.enabled, onchange: async e => {
        try { await api.put("/api/safety/weather/settings", { enabled: e.target.checked }); toast(e.target.checked ? "Weather alerts on." : "Weather alerts off."); } catch { toast("Couldn't change it."); } } }), " Check the National Weather Service for this district")
      : h("p", { class: "small" }, d.enabled ? "Weather alerts are on for the district." : "Weather alerts are off. The superintendent can turn them on."),
    !d.running ? h("p", { class: "small muted" }, "The server isn't checking yet: district IT sets WEATHER_ALERTS_USER_AGENT with a contact address (NWS requires one).") : null,
    h("h4", {}, "School locations"),
    h("ul", { class: "list" }, d.schools.map(sc => {
      const lat = h("input", { id: `wx-lat-${sc.id}`, inputmode: "decimal", value: sc.lat ?? "", style: "width:8em" });
      const lon = h("input", { id: `wx-lon-${sc.id}`, inputmode: "decimal", value: sc.lon ?? "", style: "width:8em" });
      return h("li", {}, h("b", {}, sc.name), h("div", { class: "row wrap" },
        h("div", {}, h("label", { for: `wx-lat-${sc.id}` }, "Latitude"), lat), h("div", {}, h("label", { for: `wx-lon-${sc.id}` }, "Longitude"), lon),
        h("button", { class: "btn small", type: "button", "aria-label": `Save location: ${sc.name}`, onclick: async () => {
          try { await api.put("/api/safety/weather/points", { schoolId: sc.id, lat: Number(lat.value), lon: Number(lon.value) }); toast("Saved."); } catch { toast("Enter a latitude and longitude, e.g. 39.7392 and -104.9903."); } } }, "Save")),
        d.canPassOn ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: sc.passOn, onchange: async e => {
          try { await api.put("/api/safety/weather/share", { schoolId: sc.id, passOn: e.target.checked }); toast(e.target.checked ? "Teachers will see active weather advisories." : "Teachers will not see weather advisories."); go(state.tab, { push: false }); }
          catch { toast("Couldn't change it."); } } }), " Pass active weather advisories on to teachers")
        : h("p", { class: "small muted" }, sc.passOn ? "This school passes active weather advisories on to teachers." : "This school does not pass weather advisories on to teachers."));
    })),
    info.length ? [h("h4", {}, "Watches and advisories"), h("ul", { class: "list small" }, info.map(a => h("li", {}, `${a.event}: ${a.school}${a.expires ? ` · until ${fmtTime(a.expires)}` : ""}${a.decision ? ` · ${a.decision} by ${a.decidedBy}` : ""}`)))] : null);
}
// What the alert reached. In-app notices are in each person's app; email,
// SMS and push are only queued until a channel confirms them, and nothing
// here means emergency services were contacted.
function notificationCard(n) {
  const x = n.external, queued = x.pending + x.delivered + x.skipped + x.failed;
  return h("section", { class: "card", "aria-label": "Alert delivery" }, h("h2", {}, "Alert delivery"),
    h("div", { class: "stats" }, stat(n.inApp.available, "in the EduOS app"), stat(n.inApp.read, "opened"),
      queued ? stat(x.delivered, "email/SMS/push confirmed") : null, queued ? stat(x.pending, "email/SMS/push waiting", true) : null,
      x.failed ? stat(x.failed, "email/SMS/push failed", true) : null),
    h("p", { class: "small muted" }, queued ? "Email, SMS and push count as delivered only when the channel confirms it." : "Email, SMS and push are not set up, so alerts go to the EduOS app only."),
    h("p", { class: "small" }, "EduOS does not contact 911 or other emergency services. Call them directly."));
}
async function boardCards(i) {
  const b = (await api.get(`/api/safety/incidents/${i.id}/board`)).data, t = b.totals;
  const names = (list, empty_) => list.length ? h("ul", { class: "list" }, list.map(x => h("li", {}, h("strong", {}, x.name), h("span", { class: "small muted" }, `${x.grade ? ` · gr ${x.grade}` : ""}${x.by ? ` · ${x.by}` : ""}${x.note ? ` · ${x.note}` : ""}`)))) : empty(empty_);
  const done = b.teachers.filter(x => x.submittedAt).length;
  return [
    h("section", { class: "card", "aria-label": "Accountability" }, h("div", { class: "row" }, h("h2", { class: "grow" }, "Accountability"), h("span", { class: "small muted" }, `${t.accounted} of ${t.enrolled} accounted`)),
      barH(t.enrolled ? (t.accounted / t.enrolled) * 100 : 0, `${t.accounted} of ${t.enrolled} accounted for`),
      h("div", { class: "stats", style: "margin-top:12px" }, stat(t.present, "present"), stat(t.missing, "missing", true), stat(t.injured, "injured", true), stat(t.unaccounted, "not reported yet", true), stat(t.extra, "in another room"), stat(t.released, "released to family"))),
    h("section", { class: "card", "aria-label": "Missing and injured" }, h("h2", {}, "Missing"), names(b.missing, "No one reported missing."), h("h2", {}, "Injured"), names(b.injured, "No injuries reported.")),
    h("section", { class: "card", "aria-label": "Roll call by class" }, h("h2", {}, `Roll call by class (${done}/${b.teachers.length})`),
      h("ul", { class: "list" }, b.teachers.map(x => h("li", { class: "row" }, h("span", { class: "grow" }, `${x.name} · ${x.roster} learners`), x.submittedAt ? chip("present", `Sent ${fmtTime(x.submittedAt)}`) : chip("expected", "Waiting"))))),
    b.unaccounted.length ? h("section", { class: "card", "aria-label": "Not reported yet" }, h("h2", {}, "Not reported yet"), names(b.unaccounted.slice(0, 12), ""), b.unaccounted.length > 12 ? h("p", { class: "small muted" }, `and ${b.unaccounted.length - 12} more`) : null) : null,
    h("section", { class: "card", "aria-label": "Actions" }, h("h2", {}, "Actions"), h("div", { class: "btns" },
      h("button", { class: "btn", type: "button", onclick: async () => { const d = await ask({ title: "Log first responders", label: "What happened? (e.g. police on scene)", confirm: "Log it", value: "First responders on scene" }); if (d) { await api.post(`/api/safety/incidents/${i.id}/events`, { event: "responders", detail: d }); toast("Logged"); go("safety", { push: false }); } } }, "First responders"),
      h("button", { class: "btn", type: "button", onclick: async () => { const d = await ask({ title: "Add to the incident log", label: "Note (no student details)", confirm: "Add note" }); if (d) { await api.post(`/api/safety/incidents/${i.id}/events`, { event: "note", detail: d }); go("safety", { push: false }); } } }, "Log a note"),
      i.status === "active" ? h("button", { class: "btn school", type: "button", onclick: async () => {
        const point = await ask({ title: "Start reunification", text: "Families are told where to go and to bring photo ID and their pick-up pass. Students are released only through pick-up verification.", label: "Reunification point", confirm: "Start reunification" });
        if (point) { await api.post(`/api/safety/incidents/${i.id}/reunification`, { point }); await checkSafety(); }
      } }, "Start reunification") : h("button", { class: "btn school", type: "button", onclick: () => go("pickup") }, icon("car"), "Release at pick-up"),
      h("button", { class: "btn primary", type: "button", onclick: async () => {
        if (!(await ask({ title: `All clear: end the ${i.isDrill ? "drill" : KIND_TEXT[i.kind].toLowerCase()}?`, text: "Everyone at the school, its drivers and families are told that normal operations resume.", confirm: "Yes, all clear", danger: true }))) return;
        try { await api.post(`/api/safety/incidents/${i.id}/all-clear`, { kind: i.kind }); toast("All clear sent"); await checkSafety(); } catch { toast("Couldn't send the all clear."); }
      } }, "All clear"))),
    b.notifications ? notificationCard(b.notifications) : null,
    h("section", { class: "card", "aria-label": "Incident log" }, h("h2", {}, "Incident log"), h("ol", { class: "timeline" }, b.events.map(e => h("li", {}, h("time", { datetime: e.at }, fmtTime(e.at)), h("span", {}, `${EVENT_TEXT[e.event] || e.event}${e.detail ? `: ${e.detail}` : ""} · ${e.actor_name}`))))),
    h("p", { class: "notice" }, "Counts come from teachers' roll calls. EduOS does not use cameras, location, facial recognition or threat scores.")
  ];
}
const EVENT_TEXT = { initiated: "Started", confirmed: "Confirmed and alerted", cancelled: "Cancelled", expired: "Expired unconfirmed", rollcall: "Roll call", responders: "First responders", note: "Note", reunification: "Reunification started", released: "Released at pick-up", all_clear: "All clear", debrief: "Debrief written" };

// Start an alert (two steps) and, for leads, recent incidents + debrief.
VIEWS.sos = async () => {
  if (liveIncidents().length) return VIEWS.safety();
  const caps = state.safetyCaps || {};
  const out = [h("h2", {}, "Safety"), weatherPromptCard()];
  if (caps.canInitiate) {
    let kind = state.sosKind || "lockdown", drill = state.sosDrill ?? true, hazard = ["shelter", "hold"].includes(kind) ? state.sosHazard || null : null;
    const hz = h("select", { id: "sos-hazard", onchange: e => { state.sosHazard = e.target.value || null; if (e.target.value) state.sosKind = HAZARD_KIND[e.target.value]; go("sos", { push: false }); } },
      h("option", { value: "" }, "No specific hazard"), Object.entries(HAZARD_TEXT).map(([k, t]) => h("option", { value: k, selected: k === hazard }, t)));
    const notes = h("textarea", { id: "sos-notes", maxlength: 500 });
    const schools = state.me.role === "superintendent" ? ((await safe(api.get("/api/schools")))?.data || []).filter(x => x.status !== "inactive") : [];
    const school = schools.length ? h("select", { id: "sos-school" }, schools.map(x => h("option", { value: x.id }, x.name))) : null;
    out.push(h("section", { class: "card", "aria-label": "Start an alert" }, h("h2", {}, "Start an alert"),
      h("div", { class: "kinds", role: "group", "aria-label": "Type of alert" }, Object.keys(KIND_TEXT).map(k => h("button", { type: "button", class: `kind ${k}`, "aria-pressed": String(k === kind), onclick: () => { state.sosKind = k; go("sos", { push: false }); } },
        h("strong", {}, KIND_TEXT[k]), h("span", {}, KIND_HELP[k])))),
      seg([["drill", "Drill"], ["real", "Real emergency"]], drill ? "drill" : "real", v => { state.sosDrill = v === "drill"; go("sos", { push: false }); }),
      school ? [h("label", { for: "sos-school" }, "School"), school] : null,
      ["shelter", "hold"].includes(kind) ? [h("label", { for: "sos-hazard" }, "Hazard (severe weather and others)"), hz,
        hazard ? h("p", { class: "small muted" }, "Staff, students and classroom screens get this hazard's instructions and each room's shelter area.") : null] : null,
      h("label", { for: "sos-notes" }, "Short note for staff (optional, not sent to families)"), notes,
      h("button", { class: "btn danger block big", type: "button", onclick: async () => {
        try {
          const started = (await api.post("/api/safety/incidents", { kind, isDrill: drill, ...(hazard ? { hazard } : {}), ...(notes.value.trim() ? { instructions: notes.value.trim() } : {}), ...(school ? { schoolId: school.value } : {}) })).data;
          const yes = await ask({ title: `Start ${drill ? "a DRILL" : "a REAL"} ${KIND_TEXT[kind]}${hazard ? ` (${HAZARD_TEXT[hazard]})` : ""}?`, text: `Everyone at ${started.schoolName}, its bus drivers and families are alerted now${drill ? ", marked as a drill" : ""}. Confirm within 2 minutes.`, confirm: `Yes, start ${drill ? "drill" : KIND_TEXT[kind].toLowerCase()}`, danger: true });
          if (!yes) { await safe(api.post(`/api/safety/incidents/${started.id}/cancel`)); toast("Not started"); return; }
          await api.post(`/api/safety/incidents/${started.id}/confirm`, { kind, isDrill: drill, ...(hazard ? { hazard } : {}) });
          if (state.sosWeatherId) await safe(api.post(`/api/safety/weather/${state.sosWeatherId}/started`, { incidentId: started.id }));
          state.sosKind = null; state.sosDrill = null; state.sosHazard = null; state.sosWeatherId = null;
          await checkSafety();
        } catch (e) { toast(e.body?.error === "incident_already_live" ? "An alert is already active." : e.status === 410 ? "Took too long. Start again." : "Couldn't start the alert."); }
      } }, icon("shield"), "Continue"),
      h("p", { class: "small muted" }, "Step 1 of 2. Nothing is sent until you confirm.")));
  } else out.push(h("section", { class: "card" }, h("p", {}, "Your school leaders start safety alerts. Call 911 in an emergency.")));
  if (caps.canLead) {
    const past = (await safe(api.get("/api/safety/incidents")))?.data || [];
    out.push(h("section", { class: "card", "aria-label": "Recent incidents" }, h("h2", {}, "Recent incidents and drills"), past.length ? h("ul", { class: "list" }, past.slice(0, 8).map(x => h("li", {},
      h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, `${x.label}${x.isDrill ? " (drill)" : ""}`), h("p", { class: "small muted" }, `${x.schoolName} · ${fmtDay(x.startedAt)} ${fmtTime(x.startedAt)} · ${x.status}`)),
        x.status === "closed" && !x.debrief ? h("button", { class: "btn small", type: "button", onclick: async () => { const t = await ask({ title: "Debrief", text: "What went well and what to fix. No student names.", label: "Debrief notes", confirm: "Save debrief", maxlength: 4000 }); if (t) { await api.post(`/api/safety/incidents/${x.id}/debrief`, { text: t }); toast("Debrief saved"); go("sos", { push: false }); } } }, "Debrief") : x.debrief ? chip("present", "Debriefed") : null)))) : empty("No incidents yet.")));
  }
  out.push(h("p", { class: "notice" }, "A person starts every alert. EduOS has no cameras, location tracking, facial recognition or threat scoring."));
  if (["principal", "superintendent"].includes(state.me.role) && caps.canLead) out.push(await weatherSettingsCard());
  return out;
};

// ---------------- car pick-up ----------------
function qrSvg(rows, label) {
  const n = rows.length, q = 4;
  let d = "";
  rows.forEach((r, y) => { for (let x = 0; x < n; x++) if (r[x] === "1") d += `M${x + q},${y + q}h1v1h-1z`; });
  return h("div", { class: "qr", role: "img", "aria-label": label }, svg("svg", { viewBox: `0 0 ${n + 2 * q} ${n + 2 * q}`, "aria-hidden": "true", "shape-rendering": "crispEdges" },
    svg("rect", { width: n + 2 * q, height: n + 2 * q, fill: "#fff" }), svg("path", { d, fill: "#000" })));
}
function passCard(p, heading) {
  return h("section", { class: "card pass", "aria-label": heading }, h("h2", {}, heading), qrSvg(p.qr, `QR code for the pick-up pass of ${p.adultName}`),
    h("p", { class: "code" }, p.code), h("p", { class: "small" }, `${p.adultName} · valid until ${fmtDay(p.expiresAt)} ${fmtTime(p.expiresAt)}`),
    h("p", { class: "small muted" }, "Show this at pick-up with a photo ID. It's shown once: EduOS keeps only a fingerprint of the code, so make a new pass if you lose it."));
}
VIEWS.pickup = async () => (state.me.role === "parent" ? familyPickup() : staffPickup());
async function familyPickup() {
  const kids = (await api.get("/api/pickup/family")).data.children;
  if (!kids.length) return [h("h2", {}, "Pick-up"), empty("No children are linked to your account yet.")];
  const out = [liveIncidents().length ? h("button", { class: "btn", type: "button", onclick: () => go("safety") }, "‹ Safety update") : null, h("h2", {}, "Pick-up")];
  if (state.pass) out.push(passCard(state.pass, "Pick-up pass"));
  for (const k of forChild(kids)) {
    const me = k.adults.find(a => a.is_me), approved = k.adults.filter(a => a.status === "approved");
    const name = h("input", { id: `ad-n-${k.id}`, maxlength: 120, required: true, autocomplete: "off" }), rel = h("input", { id: `ad-r-${k.id}`, maxlength: 40, required: true });
    const date = h("input", { id: `ed-d-${k.id}`, type: "date", required: true }), time = h("input", { id: `ed-t-${k.id}`, type: "time", required: true }), why = h("input", { id: `ed-w-${k.id}`, maxlength: 200, required: true });
    const who = h("select", { id: `ed-a-${k.id}`, required: true }, approved.map(a => h("option", { value: a.id }, `${a.full_name} (${a.relationship})`)));
    const pass = async (a) => { try { state.pass = (await api.post("/api/pickup/tags", { adultId: a.id })).data; go("pickup", { push: false }); } catch { toast("Couldn't make a pass."); } };
    out.push(h("section", { class: "card", "aria-label": `${k.display_name} pick-up` },
      h("div", { class: "row" }, h("div", { class: "grow" }, h("h2", {}, k.display_name), h("p", { class: "small muted" }, k.school_name))),
      me ? h("button", { class: "btn primary block big", type: "button", onclick: () => pass(me) }, icon("qr"), me.pass ? `New pass for me (current ends ${fmtDay(me.pass.expiresAt)})` : "Show my pick-up pass") : null,
      h("h3", {}, "Who can pick up"),
      h("ul", { class: "list" }, k.adults.map(a => h("li", { class: "row" }, h("div", { class: "grow" }, h("strong", {}, a.full_name), h("span", { class: "small muted" }, ` · ${a.relationship}${a.is_me ? " (you)" : ""}`),
          a.status === "rejected" && a.decision_note ? h("p", { class: "small muted" }, a.decision_note) : null),
        chip(a.status === "approved" ? "present" : a.status === "pending" ? "expected" : "absent", a.status === "approved" ? "Approved" : a.status === "pending" ? "Waiting for school" : "Not approved"),
        a.status === "approved" && !a.is_me ? h("button", { class: "btn small", type: "button", "aria-label": `One-day pass for ${a.full_name}`, onclick: () => pass(a) }, "Pass") : null,
        a.kind !== "guardian" && a.status !== "rejected" ? h("button", { class: "btn small", type: "button", "aria-label": `Remove ${a.full_name}`, onclick: async () => {
          if (await ask({ title: `Remove ${a.full_name}?`, text: "They can no longer pick up and any pass stops working.", confirm: "Remove", danger: true })) { await api.post(`/api/pickup/adults/${a.id}/revoke`); toast("Removed"); go("pickup", { push: false }); }
        } }, "Remove") : null))),
      h("form", { onsubmit: async (e) => { e.preventDefault(); try { await api.post("/api/pickup/adults", { studentId: k.id, fullName: name.value, relationship: rel.value }); toast("Sent to the school for approval"); go("pickup", { push: false }); } catch (err) { toast(err.body?.error === "adult_already_listed" ? "That person is already listed." : "Couldn't add."); } } },
        h("h3", {}, "Add an adult"), h("label", { for: name.id }, "Full name (as on their photo ID)"), name, h("label", { for: rel.id }, "Relationship"), rel,
        h("button", { class: "btn", type: "submit" }, "Send to school for approval")),
      approved.length ? h("form", { onsubmit: async (e) => { e.preventDefault(); try { await api.post("/api/pickup/early-dismissals", { studentId: k.id, adultId: who.value, date: date.value, time: time.value, reason: why.value }); toast("Early dismissal requested"); go("pickup", { push: false }); } catch { toast("Couldn't request. Check the date (today to 60 days ahead)."); } } },
        h("h3", {}, "Early dismissal"), h("label", { for: who.id }, "Who will collect"), who, h("div", { class: "row" }, h("div", { class: "grow" }, h("label", { for: date.id }, "Date"), date), h("div", { class: "grow" }, h("label", { for: time.id }, "Time"), time)),
        h("label", { for: why.id }, "Reason"), why, h("button", { class: "btn", type: "submit" }, "Request early dismissal"),
        k.earlyDismissals.length ? h("ul", { class: "list" }, k.earlyDismissals.map(e => h("li", { class: "row" }, h("span", { class: "grow" }, `${fmtDay(e.dismissal_date)} ${e.time} · ${e.adult_name} · ${e.reason}`), chip(e.status === "approved" ? "present" : e.status === "requested" ? "expected" : "absent", e.status)))) : null) : null,
      k.log.length ? h("div", {}, h("h3", {}, "Recent pick-ups"), h("ol", { class: "timeline" }, k.log.map(l => h("li", {}, h("time", { datetime: l.at }, `${fmtDay(l.at)} ${fmtTime(l.at)}`), h("span", {}, `${l.adult_name} (${l.relationship})`))))) : null));
  }
  out.push(h("p", { class: "notice" }, "Staff check the pass and a photo ID. EduOS stores no photos, ID numbers or face data."));
  return out;
}
async function staffPickup() {
  const lead = ["principal", "superintendent"].includes(state.me.role);
  const view = lead ? (state.pickupView || "verify") : "verify";
  const out = [liveIncidents().length ? h("button", { class: "btn", type: "button", onclick: () => go("safety") }, "‹ Safety board") : null, h("h2", {}, "Pick-up")];
  if (lead) out.push(seg([["verify", "Pick-up line"], ["admin", "Approvals"]], view, v => { state.pickupView = v; go("pickup", { push: false }); }));
  if (view === "admin") return out.concat(await pickupAdmin());
  if (state.me.role === "superintendent") return out.concat(h("p", { class: "notice" }, "Pick-up is verified by staff at each school."));
  const q = (await api.get("/api/pickup/queue")).data;
  const code = h("input", { id: "pass-code", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", inputmode: "text", maxlength: 16, placeholder: "e.g. 7KQ2M-X9PDA" });
  const result = h("div", { id: "verify-result", "aria-live": "polite" });
  const verify = async (e) => {
    e.preventDefault();
    try { renderVerify(result, (await api.post("/api/pickup/verify", { code: code.value })).data, code.value); }
    catch (err) { result.replaceChildren(h("section", { class: "card verify bad", role: "alert" }, h("h2", {}, err.status === 404 ? "Pass not recognised" : err.status === 429 ? "Too many tries" : "Couldn't check"), h("p", {}, err.status === 404 ? "Do not release. Ask for another pass or call the office." : "Wait a moment and try again."))); }
  };
  if (q.incident) out.push(h("p", { class: `notice sos-inline ${q.incident.status}` }, q.incident.status === "reunification" ? "Reunification in progress: releases are logged to the incident." : `${KIND_TEXT[q.incident.kind]} in effect: releases are paused until reunification or all clear.`));
  out.push(h("form", { class: "card", onsubmit: verify, "aria-label": "Check a pick-up pass" }, h("label", { for: "pass-code" }, "Pass code (type it or use a handheld scanner)"), code,
    h("button", { class: "btn primary block big", type: "submit" }, icon("qr"), "Check pass")), result);
  out.push(h("section", { class: "card", "aria-label": "Pick-up queue" }, h("h2", {}, `Waiting (${q.waiting.length})`),
    q.waiting.length ? h("ul", { class: "list" }, q.waiting.map(w => h("li", { class: "row" }, h("span", { class: "grow" }, `${w.name} · ${w.adult}`), chip("expected", fmtTime(w.at))))) : empty("Nobody waiting."),
    h("h2", {}, `Released today (${q.released.length})`),
    q.released.length ? h("ul", { class: "list" }, q.released.slice(0, 20).map(w => h("li", { class: "row" }, h("span", { class: "grow" }, `${w.name} → ${w.adult} (${w.relationship})`), chip("present", fmtTime(w.at))))) : empty("No releases yet today."),
    q.blocked || q.denied ? h("p", { class: "small muted" }, `${q.blocked} blocked · ${q.denied} refused today`) : null),
    q.earlyDismissals.length ? h("section", { class: "card", "aria-label": "Early dismissals" }, h("h2", {}, "Early dismissals today"), h("ul", { class: "list" }, q.earlyDismissals.map(e => h("li", { class: "row" }, h("span", { class: "grow" }, `${e.time} · ${e.student_name} → ${e.adult_name}`), chip(e.status === "released" ? "present" : "expected", e.status === "released" ? "Released" : "Approved"))))) : null,
    h("p", { class: "notice" }, "Look at the adult's photo ID and compare the name. EduOS stores only that you checked: no photos, ID numbers or face data."));
  return out;
}
function renderVerify(box, v, code) {
  if (v.blocked) {
    box.replaceChildren(h("section", { class: "card verify bad", role: "alert" }, h("h2", {}, "DO NOT RELEASE"), h("p", {}, v.instructions),
      h("p", { class: "small" }, `${v.adult.name} · ${v.adult.relationship}`)));
    return;
  }
  const eligible = v.students.filter(s => s.eligible);
  const idOk = h("input", { id: "id-ok", type: "checkbox", class: "check" });
  const custody = eligible.some(s => s.custodyOrder) ? h("input", { id: "custody-ok", type: "checkbox", class: "check" }) : null;
  const pick = new Map(eligible.map(s => [s.studentId, h("input", { id: `rel-${s.studentId}`, type: "checkbox", class: "check", checked: true })]));
  box.replaceChildren(h("section", { class: `card verify ${eligible.length ? "ok" : "bad"}`, "aria-label": "Pass result" },
    h("p", { class: "small muted" }, v.reunification ? "Reunification release" : v.pass === "valid" ? "Valid pass" : `Pass ${v.pass}`),
    h("h2", {}, v.adult.name), h("p", {}, `${v.adult.relationship}${v.adult.kind === "guardian" ? " · guardian" : " · authorized adult"}`),
    h("ul", { class: "list" }, v.students.map(s => h("li", {}, h("div", { class: "row" }, s.eligible ? pick.get(s.studentId) : null,
      h("label", { class: "grow", for: s.eligible ? `rel-${s.studentId}` : false }, `${s.name} · gr ${s.grade}`),
      s.eligible ? chip("present", s.earlyDismissal ? `Early dismissal ${s.earlyDismissal.time}` : "Can go") : chip("absent", REASON[s.reason] || s.reason)),
      s.custodyOrder ? h("p", { class: "flag" }, h("strong", {}, "Custody order: "), s.flagDetail || "check the documents on file") : null))),
    eligible.length ? [
      custody ? h("div", { class: "row" }, custody, h("label", { for: "custody-ok", class: "grow" }, "I checked the custody order allows this release")) : null,
      h("div", { class: "row" }, idOk, h("label", { for: "id-ok", class: "grow" }, `I checked a photo ID and it matches ${v.adult.name}`)),
      h("div", { class: "btns" },
        h("button", { class: "btn primary big grow", type: "button", onclick: async () => {
          if (!idOk.checked) return toast("Check the photo ID first.");
          if (custody && !custody.checked) return toast("Confirm the custody order first.");
          const studentIds = [...pick.entries()].filter(([, el]) => el.checked).map(([id]) => id);
          if (!studentIds.length) return toast("Choose who is going home.");
          try { const r = (await api.post("/api/pickup/release", { code, studentIds, idChecked: true, custodyAcknowledged: Boolean(custody?.checked) })).data; toast(`Released: ${r.released.map(x => first(x.name)).join(", ")}`); go("pickup", { push: false }); }
          catch (e) { toast(e.body?.error === "release_blocked" ? "Blocked. Do not release." : "Couldn't release."); }
        } }, "Release"),
        h("button", { class: "btn danger", type: "button", onclick: async () => { const reason = await ask({ title: "Refuse this release?", label: "Reason (e.g. ID didn't match)", confirm: "Refuse", danger: true }); if (reason) { await api.post("/api/pickup/deny", { code, reason }); toast("Refused and logged. The office was told."); go("pickup", { push: false }); } } }, "Refuse"))] : h("p", {}, "Nobody can be released with this pass.")));
}
const REASON = { pass_expired: "Pass expired", pass_revoked: "Pass replaced or cancelled", adult_not_approved: "Adult not approved", safety_incident_live: "Paused: safety alert", do_not_release: "Do not release" };
async function pickupAdmin() {
  const d = (await api.get("/api/pickup/admin")).data;
  const students = (await safe(api.get("/api/students?limit=200")))?.data || [];
  const stu = h("select", { id: "r-student", required: true }, students.map(s => h("option", { value: s.id }, `${s.display_name} (${s.grade_level || "-"})`)));
  const kind = h("select", { id: "r-kind" }, h("option", { value: "do_not_release" }, "Do not release to"), h("option", { value: "custody_order" }, "Custody order on file"));
  const person = h("input", { id: "r-person", maxlength: 120 }), detail = h("input", { id: "r-detail", maxlength: 500, required: true }), doc = h("input", { id: "r-doc", type: "checkbox", class: "check" });
  return [
    h("section", { class: "card", "aria-label": "Adults waiting for approval" }, h("h2", {}, `Adults to approve (${d.pendingAdults.length})`),
      d.pendingAdults.length ? h("ul", { class: "list" }, d.pendingAdults.map(a => h("li", {}, h("h3", {}, `${a.full_name} · ${a.relationship}`), h("p", { class: "small muted" }, `For ${a.student_name} · asked by ${a.requested_by_name} · ${ago(a.requested_at)}`),
        h("div", { class: "btns" }, h("button", { class: "btn primary", type: "button", onclick: async () => { await api.post(`/api/pickup/adults/${a.id}/decision`, { decision: "approve" }); toast("Approved"); go("pickup", { push: false }); } }, "Approve"),
          h("button", { class: "btn", type: "button", onclick: async () => { const note = await ask({ title: `Don't approve ${a.full_name}?`, label: "Note for the family", confirm: "Don't approve" }); if (note) { await api.post(`/api/pickup/adults/${a.id}/decision`, { decision: "reject", note }); go("pickup", { push: false }); } } }, "Decline"))))) : empty("Nothing to approve.")),
    h("section", { class: "card", "aria-label": "Early dismissal requests" }, h("h2", {}, `Early dismissal requests (${d.earlyDismissals.length})`),
      d.earlyDismissals.length ? h("ul", { class: "list" }, d.earlyDismissals.map(e => h("li", {}, h("h3", {}, `${e.student_name} · ${fmtDay(e.dismissal_date)} ${e.time}`), h("p", { class: "small muted" }, `${e.adult_name} · ${e.reason}`),
        h("div", { class: "btns" }, h("button", { class: "btn primary", type: "button", onclick: async () => { await api.post(`/api/pickup/early-dismissals/${e.id}/decision`, { decision: "approve" }); go("pickup", { push: false }); } }, "Approve"),
          h("button", { class: "btn", type: "button", onclick: async () => { await api.post(`/api/pickup/early-dismissals/${e.id}/decision`, { decision: "decline" }); go("pickup", { push: false }); } }, "Decline"))))) : empty("No requests.")),
    h("section", { class: "card", "aria-label": "Custody and do-not-release" }, h("h2", {}, "Custody and do-not-release"),
      d.restrictions.length ? h("ul", { class: "list" }, d.restrictions.map(r => h("li", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, `${r.student_name}: ${r.kind === "do_not_release" ? `do not release to ${r.person_name || "named adult"}` : "custody order"}`), h("p", { class: "small muted" }, `${r.detail}${r.document_on_file ? " · document on file" : ""}`)),
        h("button", { class: "btn small", type: "button", "aria-label": `Lift restriction for ${r.student_name}`, onclick: async () => { if (await ask({ title: "Lift this restriction?", confirm: "Lift", danger: true })) { await api.post(`/api/pickup/restrictions/${r.id}/lift`); go("pickup", { push: false }); } } }, "Lift")))) : empty("None on file."),
      h("form", { onsubmit: async (e) => { e.preventDefault(); try { await api.post("/api/pickup/restrictions", { studentId: stu.value, kind: kind.value, personName: person.value.trim() || null, detail: detail.value, documentOnFile: doc.checked }); toast("Saved"); go("pickup", { push: false }); } catch { toast("Couldn't save. A do-not-release needs a name."); } } },
        h("label", { for: stu.id }, "Learner"), stu, h("label", { for: kind.id }, "Type"), kind, h("label", { for: person.id }, "Person's full name (for do-not-release)"), person,
        h("label", { for: detail.id }, "Detail (e.g. court order number)"), detail, h("div", { class: "row" }, doc, h("label", { for: doc.id, class: "grow" }, "Document on file")),
        h("button", { class: "btn", type: "submit" }, "Add restriction")),
      h("p", { class: "small muted" }, "Only school leaders see these. Staff on the pick-up line see a flag, never the file.")),
    h("section", { class: "card", "aria-label": "Release log" }, h("h2", {}, "Release log"), d.log.length ? h("ol", { class: "timeline" }, d.log.slice(0, 15).map(l => h("li", {}, h("time", { datetime: l.at }, fmtTime(l.at)),
      h("span", {}, `${l.event === "released" ? "Released" : l.event === "blocked" ? "BLOCKED" : l.event === "denied" ? "Refused" : "Checked"}: ${l.student_name}${l.adult_name ? ` → ${l.adult_name}` : ""}${l.reason ? ` (${REASON[l.reason] || l.reason})` : ""} · ${l.by_name}`)))) : empty("No pick-ups yet."))
  ];
}

// ---------------- 32.6.0 learning core ----------------
// Courses, lessons with primary sources, quizzes (timer, accommodations,
// on-device read-aloud), results, gradebook, rubric grading, quiz review,
// family "Grades & progress", explainable mastery and the EDAL ledger.
const LEVEL_TEXT = { mastered: "Mastered", developing: "Developing", emerging: "Emerging", not_started: "Not started" };
const LEVEL_CHIP = { mastered: "mastered", developing: "alighted", emerging: "expected", not_started: "none" };
const levelChip = (level, extra = "") => chip(LEVEL_CHIP[level] || "not_started", `${LEVEL_TEXT[level] || level}${extra}`);
const back = (tab, label = "Back") => h("button", { class: "btn back", type: "button", onclick: () => go(tab) }, `‹ ${label}`);
const gradeText = g => (g?.percent == null ? "No graded work yet" : `${g.letter} · ${g.percent}%`);
const kindText = { quiz: "Quiz", work: "Classwork" };
const statusText = { not_started: "Not started", in_progress: "In progress", needs_review: "With your teacher", graded: "Graded", submitted: "Handed in" };
function openView(view, patch) { Object.assign(state, patch); go(view); }
function learnerQuery() { return state.me.role === "parent" && state.learnerId ? `?studentId=${state.learnerId}` : ""; }

// Read-aloud: the browser's own speech engine with an ON-DEVICE voice only;
// question text is never sent anywhere.
function speak(text) {
  const ss = window.speechSynthesis;
  if (!ss || typeof SpeechSynthesisUtterance === "undefined") return toast("Read-aloud isn't available on this device.");
  const voices = ss.getVoices().filter(v => v.localService);
  if (!voices.length) return toast("No on-device voice found, so nothing was read. EduOS never sends questions to an online voice.");
  ss.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voices.find(v => (v.lang || "").startsWith("en")) || voices[0];
  u.rate = 0.95;
  ss.speak(u);
}
const sayBtn = (text, label) => h("button", { class: "btn small-btn", type: "button", "aria-label": `Read aloud: ${label}`, onclick: () => speak(text) }, "🔊 Read aloud");

function sourceCard(s, { prompts = s.prompts } = {}) {
  return h("article", { class: "card source", "aria-label": `Primary source: ${s.title}` },
    h("p", { class: "small muted" }, `Primary source · ${s.kind}${s.date ? ` · ${s.date}` : ""}`),
    h("h3", {}, s.title),
    s.creator ? h("p", { class: "small" }, `By ${s.creator}`) : null,
    s.excerpt ? h("blockquote", {}, s.excerpt) : null,
    h("p", { class: "small" }, s.description),
    prompts?.length ? h("div", {}, h("h4", {}, "Think about it"), h("ol", { class: "prompts" }, prompts.map(p => h("li", {}, p)))) : null,
    h("p", { class: "small muted" }, `Rights: ${s.rights}`),
    h("a", { class: "btn block", href: s.url, target: "_blank", rel: "noopener noreferrer" }, `See it at the ${s.archive}`));
}

VIEWS.courses = async () => {
  const role = state.me.role;
  if (role === "parent") return VIEWS.progress();
  const r = (await api.get("/api/learning/courses")).data;
  if (STAFF_ROLES.includes(role)) {
    return [h("div", { class: "row" }, h("h2", { class: "grow" }, "My courses"), role === "teacher" ? h("button", { class: "btn", type: "button", onclick: () => go("roster") }, icon("people"), "My roster") : null),
      r.courses.length ? r.courses.map(c => h("section", { class: "card", "aria-label": c.title },
        h("h3", {}, c.title), h("p", { class: "small muted" }, `${c.term} · ${c.students} learners · ${c.lessons} lessons${role !== "teacher" ? ` · ${c.teacher_name}` : ""}`),
        h("div", { class: "btns" }, c.to_review ? chip("expected", `${c.to_review} quiz${c.to_review > 1 ? "zes" : ""} to review`) : null, c.to_grade ? chip("expected", `${c.to_grade} to grade`) : null),
        h("div", { class: "btns" }, h("button", { class: "btn primary", type: "button", onclick: () => openView("course", { courseId: c.id }) }, "Open course"),
          h("button", { class: "btn", type: "button", onclick: () => openView("gradebook", { courseId: c.id }) }, "Gradebook")))) : h("section", { class: "card" }, empty("No courses yet."))];
  }
  return [h("h2", {}, "My courses"),
    r.courses.length ? r.courses.map(c => h("section", { class: "card", "aria-label": c.title },
      h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, c.title), h("p", { class: "small muted" }, `${c.teacher_name} · ${c.term}`)),
        h("span", { class: "grade", "aria-label": `Course grade ${gradeText(c.grade)}` }, c.grade?.letter || "–")),
      barH(c.mastery.average, `${c.title}: ${c.mastery.mastered} of ${c.mastery.total} standards mastered`),
      h("p", { class: "small muted" }, `${c.mastery.mastered} of ${c.mastery.total} standards mastered`),
      c.next ? h("p", { class: "small" }, `Next: ${c.next.title}${c.next.due_at ? ` · due ${fmtDay(c.next.due_at)}` : ""}`) : null,
      h("button", { class: "btn primary block", type: "button", onclick: () => openView("course", { courseId: c.id }) }, "Open course"))) : h("section", { class: "card" }, empty("You're not in any courses yet."))];
};

// LTI-02: open an LTI tool in a new tab (opened first, so pop-up blockers allow it).
async function openToolTab(path, body, failText) {
  const tab = window.open("about:blank", "_blank");
  try { const r = await api.post(path, body); if (tab) { tab.opener = null; tab.location.href = r.data.url; } else location.assign(r.data.url); }
  catch (e) { if (tab) tab.close(); toast(failText(e.body?.error)); }
}
const GRADE_ERRORS = { district_grade_passback_off: "The district hasn't turned grade passback on.", school_has_not_approved_tool: "Your principal hasn't approved this tool for grades.",
  tool_not_registered_for_grades: "This tool isn't set up to send grades." };
const SCORE_STATUS = { pending: "waiting for you", recorded: "in the gradebook", dismissed: "dismissed", not_final: "not final yet" };
const TOOL_ERRORS = { no_seats_available: "All seats for this tool are in use.", lti_approval_required: "This tool is waiting for district approval.",
  app_not_available: "This tool isn't available for your account.", content_not_available: "That activity isn't available any more.",
  deep_linking_not_registered: "This tool can't add content to assignments.", assignment_not_manageable: "You can't change this assignment." };
// Classrooms operations (db/153): school bell schedules & course seating charts.
const BELL_DAY_LABEL = { regular: "Regular day", early_release: "Early release", late_start: "Late start", assembly: "Assembly", custom: "Custom" };
const PERIOD_KIND_LABEL = { instruction: "Class", homeroom: "Homeroom", lunch: "Lunch", passing: "Passing", assembly: "Assembly" };
async function bellScheduleCard(canEdit) {
  const res = await safe(api.get("/api/schools/bell-schedules"));
  const d = res?.data || {};
  const list = Array.isArray(d.schedules) ? d.schedules : [];
  const active = d.todaySchedule || list[0] || null;
  const box = h("section", { class: "card", "aria-label": "Bell schedule" }, h("h2", {}, "Bell schedule"));
  const render = () => {
    const kids = [];
    if (active) {
      kids.push(h("p", { class: "small muted" }, `${active.name} · ${BELL_DAY_LABEL[active.dayType] || active.dayType}${active.isDefault ? " (default)" : ""}`));
      kids.push(h("ul", { class: "list" }, (active.periods || []).map(p => h("li", { class: "row wrap" },
        h("span", { class: "grow" }, `${p.starts}–${p.ends} · ${p.label}`),
        h("span", { class: "small muted" }, PERIOD_KIND_LABEL[p.kind] || p.kind)))));
    } else {
      kids.push(empty("No bell schedule set for this school yet."));
    }
    if (canEdit) {
      const nameIn = h("input", { type: "text", placeholder: "Schedule name (e.g. Regular Day)", value: active?.name || "Regular Day", "aria-label": "Bell schedule name" });
      const typeSel = h("select", { "aria-label": "Day type" }, Object.entries(BELL_DAY_LABEL).map(([v, t]) => h("option", { value: v, selected: (active?.dayType || "regular") === v }, t)));
      const defChk = h("input", { type: "checkbox", id: "bell-def", checked: active ? active.isDefault : true });
      const lines = (active?.periods || [{ label: "Period 1", kind: "instruction", starts: "08:00", ends: "08:50" }]).map(p => `${p.starts}-${p.ends} | ${p.label} | ${p.kind}`).join("\n");
      const text = h("textarea", { rows: 4, "aria-label": "Periods (HH:MM-HH:MM | Label | kind)" }); text.value = lines;
      const save = async () => {
        const periods = text.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
          const [times, label, kind = "instruction"] = l.split("|").map(x => x.trim());
          const [starts, ends] = (times || "").split("-").map(x => x.trim());
          return { starts, ends, label, kind };
        });
        try {
          await api.post("/api/schools/bell-schedules", { id: active?.id || undefined, name: nameIn.value, dayType: typeSel.value, isDefault: defChk.checked, periods });
          toast("Bell schedule saved."); go(state.tab, { push: false });
        } catch { toast("Check period times (HH:MM-HH:MM | Label | kind) and make sure periods don't overlap."); }
      };
      kids.push(h("details", {}, h("summary", {}, active ? "Edit bell schedule" : "Set bell schedule"),
        h("div", { class: "stack" }, nameIn, typeSel, h("label", { class: "inline", for: defChk.id }, defChk, " Default schedule"),
          h("p", { class: "small muted" }, "One period per line: 08:00-08:50 | Period 1 | instruction"), text,
          h("button", { class: "btn primary", type: "button", onclick: save }, "Save bell schedule"))));
    }
    box.replaceChildren(h("h2", {}, "Bell schedule"), ...kids);
  };
  render();
  return box;
}
function seatingChartPanel(courseId) {
  const box = h("div", { class: "stack" }, h("p", { class: "small muted" }, "Loading seating chart…"));
  const load = () => api.get(`/api/learning/courses/${courseId}/seating`).then(r => {
    const d = r.data || {}, ch = d.chart || { rowsCount: 5, colsCount: 6 };
    if (!d.canManage) {
      const mine = d.assignments || [];
      box.replaceChildren(mine.length
        ? h("ul", { class: "list" }, mine.map(a => h("li", {}, h("b", {}, a.name), h("p", { class: "small muted" }, `Row ${a.row}, seat ${a.col}${a.label ? ` · ${a.label}` : ""}${ch.roomName ? ` · ${ch.roomName}` : ""}`))))
        : h("p", { class: "small muted" }, "The teacher has shared this chart, but no seat is assigned yet."));
      return;
    }
    const byStudent = new Map((d.assignments || []).map(a => [a.studentId, a]));
    const roomSel = h("select", { "aria-label": "Classroom room" }, h("option", { value: "" }, "No room linked"),
      (d.rooms || []).map(rm => h("option", { value: rm.id, selected: ch.roomId === rm.id }, rm.name)));
    const rowsIn = h("input", { type: "number", min: 1, max: 20, value: String(ch.rowsCount || 5), "aria-label": "Rows" });
    const colsIn = h("input", { type: "number", min: 1, max: 20, value: String(ch.colsCount || 6), "aria-label": "Columns" });
    const shareChk = h("input", { type: "checkbox", id: `seat-share-${courseId}`, checked: Boolean(d.shareWithFamilies || ch.shareWithFamilies) });
    const inputs = new Map();
    const list = (d.students || []).map(st => {
      const cur = byStudent.get(st.studentId);
      const rIn = h("input", { type: "number", min: 1, max: 20, placeholder: "Row", value: cur ? String(cur.row) : "", "aria-label": `Row for ${st.name}` });
      const cIn = h("input", { type: "number", min: 1, max: 20, placeholder: "Seat", value: cur ? String(cur.col) : "", "aria-label": `Seat for ${st.name}` });
      const lIn = h("input", { type: "text", maxlength: 40, placeholder: "Note (e.g. Front)", value: cur?.label || "", "aria-label": `Label for ${st.name}` });
      inputs.set(st.studentId, { rIn, cIn, lIn });
      return h("li", { class: "stack" }, h("span", {}, h("b", {}, st.name), h("span", { class: "small muted" }, ` · grade ${st.grade}`)),
        h("div", { class: "row wrap" }, rIn, cIn, lIn));
    });
    const save = async () => {
      const assignments = [];
      for (const [studentId, { rIn, cIn, lIn }] of inputs) {
        if (!rIn.value && !cIn.value) continue;
        assignments.push({ studentId, row: Number(rIn.value), col: Number(cIn.value), label: lIn.value });
      }
      try {
        await api.req("PUT", `/api/learning/courses/${courseId}/seating`, { roomId: roomSel.value || null, rowsCount: Number(rowsIn.value), colsCount: Number(colsIn.value), shareWithFamilies: shareChk.checked, assignments });
        toast(shareChk.checked ? "Seating chart saved. Families can see their own seat." : "Seating chart saved. Families cannot see seats.");
        load();
      } catch { toast("Check row/seat numbers: each learner needs a unique seat inside the grid."); }
    };
    box.replaceChildren(
      h("p", { class: "small muted" }, `${(d.assignments || []).length} of ${(d.students || []).length} enrolled learners seated.`),
      h("label", { class: "inline", for: shareChk.id }, shareChk, " Let each student and their family see their own seat"),
      h("div", { class: "row wrap" }, roomSel, rowsIn, colsIn),
      list.length ? h("ul", { class: "list" }, list) : h("p", { class: "muted small" }, "No enrolled learners in this course yet."),
      h("button", { class: "btn primary", type: "button", onclick: save }, "Save seating chart"));
  }).catch(() => box.replaceChildren(h("p", { class: "small muted" }, "This seating chart isn't shared with families.")));
  load();
  return h("section", { class: "card", "aria-label": "Seating chart" }, h("h2", {}, "Seating chart"), box);
}

VIEWS.course = async () => {
  if (!state.courseId) return VIEWS.courses();
  const c = (await api.get(`/api/learning/courses/${state.courseId}${learnerQuery()}`)).data;
  const listOf = r => Array.isArray(r?.data) ? r.data : [];
  const toolLinks = listOf(await safe(api.get(`/api/lti/content-links?courseId=${c.id}`)));
  const sharing = (await safe(api.get(`/api/lti/course-sharing?courseId=${c.id}`)))?.data;
  const pickers = c.canManage && ["teacher", "principal"].includes(state.me.role) ? listOf(await safe(api.get("/api/my/apps"))).filter(x => x.deepLinking) : [];
  const toolsFor = a => {
    const mine = toolLinks.filter(l => l.assignmentId === a.id);
    if (!mine.length && !pickers.length) return null;
    const pick = pickers.length > 1 ? h("select", { id: `dl-${a.id}`, "aria-label": `Tool to add content from, for ${a.title}` }, pickers.map(p => h("option", { value: p.id }, p.name))) : null;
    // LTI-04: grade passback switch per activity, and the teacher's review of tool scores.
    const gradeSwitch = l => {
      if (!l.canRemove || !l.gradesCapable) return null;
      const box = h("input", { type: "checkbox", id: `gr-${l.id}`, checked: l.gradesEnabled });
      box.addEventListener("change", async () => {
        try { await api.req("PUT", `/api/lti/content-links/${l.id}/grades`, { enabled: box.checked }); toast(box.checked ? `${l.appName} can send grades for ${l.title}.` : "Grades from this activity are off."); }
        catch (e) { box.checked = !box.checked; toast(GRADE_ERRORS[e.body?.error] || "Couldn't change it."); } });
      return h("label", { for: box.id, class: "row small" }, box, h("span", {}, `Send grades to EduOS (${l.title})`));
    };
    const review = mine.some(l => l.canRemove && l.gradesEnabled) ? (() => {
      const box = h("div", { class: "stack" });
      const load = async () => {
        const rows = listOf(await safe(api.get(`/api/lti/scores?assignmentId=${a.id}`)));
        box.replaceChildren(rows.length ? h("ul", { class: "list" }, rows.map(r => h("li", { class: "row" },
          h("span", { class: "grow small" }, `${r.studentName}: ${r.scoreGiven ?? "–"}/${r.scoreMaximum ?? "–"} from ${r.appName} · ${SCORE_STATUS[r.status] || r.status}${r.gradebookScore != null ? ` · gradebook ${r.gradebookScore}% (${r.gradebookSource === "lti" ? "tool" : "teacher"})` : ""}`),
          r.status === "pending" ? h("button", { class: "btn small", type: "button", "aria-label": `Record ${r.studentName}'s score`, onclick: async () => {
            try { await api.post(`/api/lti/scores/${r.id}/record`, {}); }
            catch (e) {
              if (e.body?.error !== "teacher_grade_exists") return toast("Couldn't record it.");
              if (!await ask({ title: "Replace your grade?", text: `${r.studentName} already has a grade you entered. Replace it with the tool's score?`, confirm: "Replace" })) return;
              try { await api.post(`/api/lti/scores/${r.id}/record`, { overwrite: true }); } catch { return toast("Couldn't record it."); }
            }
            toast("Recorded."); load(); } }, "Record") : null,
          r.status === "pending" ? h("button", { class: "btn small", type: "button", "aria-label": `Dismiss ${r.studentName}'s score`, onclick: async () => {
            try { await api.post(`/api/lti/scores/${r.id}/dismiss`, {}); toast("Dismissed."); load(); } catch { toast("Couldn't dismiss it."); } } }, "Dismiss") : null)))
          : h("p", { class: "small muted" }, "No scores from tools yet."));
      };
      return h("details", { ontoggle: e => { if (e.target.open) load(); } }, h("summary", {}, "Review scores from tools"), box);
    })() : null;
    return h("div", { class: "stack" },
      mine.map(l => [gradeSwitch(l), h("div", { class: "row" }, h("span", { class: "grow small" }, `${l.title} · ${l.appName}`),
        h("button", { class: "btn small", type: "button", "aria-label": `Open ${l.title} in ${l.appName}`, onclick: () => openToolTab(`/api/apps/${l.appId}/launch`, { contentLinkId: l.id }, e => TOOL_ERRORS[e] || "Couldn't open it.") }, "Open"),
        l.canRemove ? h("button", { class: "btn small", type: "button", "aria-label": `Remove ${l.title}`, onclick: async () => {
          if (!await ask({ title: `Remove ${l.title}?`, text: "Students won't see it on this assignment any more.", confirm: "Remove" })) return;
          try { await api.req("DELETE", `/api/lti/content-links/${l.id}`); toast("Removed."); go("course", { push: false }); } catch { toast("Couldn't remove it."); } } }, "Remove") : null)]),
      review,
      pickers.length ? h("div", { class: "row" }, pick, h("button", { class: "btn small", type: "button",
        "aria-label": `${pickers.length === 1 ? `Add from ${pickers[0].name}` : "Add from tool"} to ${a.title}`, onclick: () =>
        openToolTab(`/api/apps/${pick ? pick.value : pickers[0].id}/deep-link`, { assignmentId: a.id }, e => TOOL_ERRORS[e] || "Couldn't open the tool.") },
        pickers.length === 1 ? `Add from ${pickers[0].name}` : "Add from tool")) : null);
  };
  const out = [back(state.me.role === "parent" ? "progress" : "courses", state.me.role === "parent" ? "Grades & progress" : "Courses"),
    h("section", { class: "card hero", "aria-label": c.title }, h("p", { class: "small muted" }, `${c.subject} · Grade ${c.gradeLevel} · ${c.term} · ${c.teacher}`), h("h2", {}, c.title),
      c.learner ? h("p", { class: "muted" }, `Grade so far: ${gradeText(c.grade)} · ${c.mastery.mastered} of ${c.mastery.total} standards mastered`) : null)];
  if (c.learner) out.push(h("section", { class: "card", "aria-label": "Standards" }, h("h2", {}, "Standards"),
    h("ul", { class: "list" }, c.standards.map(s => h("li", {}, h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, s.code), h("p", { class: "small muted" }, s.description)),
      levelChip(s.level, s.mastery != null ? ` ${s.mastery}%` : "")),
      s.mastery != null ? h("button", { class: "btn", type: "button", "aria-label": `How is this calculated? (${s.code})`, onclick: () => openView("mastery", { masteryStd: s.id }) }, "How is this calculated?") : null)))));
  for (const u of c.units) out.push(h("section", { class: "card", "aria-label": `Unit ${u.seq}: ${u.title}` }, h("h2", {}, `Unit ${u.seq}: ${u.title}`), u.summary ? h("p", { class: "small muted" }, u.summary) : null,
    c.canManage && ["teacher", "principal"].includes(state.me.role) && u.lessons.length ? h("button", { class: "btn small", type: "button", "aria-label": `Share with colleagues: unit ${u.seq}, ${u.title}`, onclick: () => shareMaterial("unit", u.id, u.title) }, icon("people"), "Share with colleagues") : null,
    h("ul", { class: "list" }, u.lessons.map(l => h("li", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, l.title), h("p", { class: "small muted" }, `${l.standards.join(", ")}${l.sources ? ` · ${l.sources} primary source${l.sources > 1 ? "s" : ""}` : ""}`)),
      c.canManage ? chip(l.approved ? "present" : "expected", l.approved ? "Approved" : "Needs approval") : null,
      h("button", { class: "btn", type: "button", "aria-label": `Open lesson: ${l.title}`, onclick: () => openView("lesson", { lessonId: l.id }) }, "Open"))))));
  // LTI-03: which tools get this course's class list (teacher chooses; everyone in the course can see).
  if (sharing && (sharing.shared?.length || sharing.candidates?.length)) {
    const on = new Set((sharing.shared || []).map(x => x.appId));
    const tools = [...(sharing.candidates || []), ...(sharing.shared || []).filter(x => !(sharing.candidates || []).some(c2 => c2.appId === x.appId))];
    out.push(h("section", { class: "card", "aria-label": "Class list sharing" }, h("h2", {}, "Class list sharing"),
      h("p", { class: "small muted" }, sharing.canManage
        ? "A tool you turn on here can read this course's class list: the names and emails of you and your students who have EduOS accounts. It can't see grades or anything else."
        : "These tools can read this course's class list (names and emails)."),
      sharing.canManage
        ? h("ul", { class: "list" }, tools.map(t => { const box = h("input", { type: "checkbox", id: `share-${t.appId}`, checked: on.has(t.appId) });
            box.addEventListener("change", async () => {
              try { await api.req("PUT", "/api/lti/course-sharing", { courseId: c.id, appId: t.appId, enabled: box.checked }); toast(box.checked ? `Class list shared with ${t.appName}.` : `${t.appName} can no longer read the class list.`); }
              catch { box.checked = !box.checked; toast("Couldn't change it."); } });
            return h("li", {}, h("label", { for: box.id, class: "row" }, box, h("span", {}, `Share the class list with ${t.appName}`))); }))
        : h("ul", { class: "list" }, (sharing.shared || []).map(t => h("li", {}, t.appName)))));
  }
  out.push(h("section", { class: "card", "aria-label": "Assignments and quizzes" }, h("h2", {}, "Assignments & quizzes"),
    c.assignments.length ? h("ul", { class: "list" }, c.assignments.map(a => h("li", {}, h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, a.title),
      h("p", { class: "small muted" }, `${kindText[a.kind]} · ${a.points} pts${a.due_at ? ` · due ${fmtDay(a.due_at)}` : ""}${a.time_limit_minutes ? ` · ${a.time_limit_minutes} min` : ""}`)),
      a.mine ? chip(a.mine.missing ? "absent" : a.mine.status === "graded" ? "present" : "not_started", a.mine.missing ? "Missing" : a.mine.status === "graded" ? `${a.mine.earned}/${a.points}` : statusText[a.mine.status]) : null),
      a.kind === "quiz" || state.me.role !== "teacher" ? h("button", { class: `btn${a.kind === "quiz" && state.me.role === "pupil" ? " primary" : ""}`, type: "button", "aria-label": `${a.kind === "quiz" ? "Open quiz" : "Details"}: ${a.title}`, onclick: () => openView("quiz", { assignmentId: a.id }) }, a.kind === "quiz" ? "Open quiz" : "Details") : null,
      toolsFor(a)))) : empty("Nothing assigned yet.")));
  if ((c.canManage && state.me.role !== "superintendent") || ["parent", "pupil"].includes(state.me.role)) {
    out.push(seatingChartPanel(c.id));
    const acc = await safe(api.get(`/api/learning/accommodations?courseId=${c.id}`));
    if (acc) out.push(h("section", { class: "card", "aria-label": "Accommodations" }, h("h2", {}, "Accommodations"),
      h("p", { class: "small muted" }, "Extra time stretches quiz timers; read-aloud adds a button that uses the device's own voice."),
      h("ul", { class: "list" }, acc.data.map(a => {
        const pct = h("select", { id: `acc-${a.student_id}`, "aria-label": `Extra time for ${a.display_name}` }, [0, 25, 50, 100].map(v => h("option", { value: v, selected: Number(a.extra_time_pct) === v }, v ? `+${v}% time` : "Standard time")));
        const ra = h("input", { type: "checkbox", id: `ra-${a.student_id}`, checked: a.read_aloud });
        return h("li", {}, h("h3", {}, a.display_name), h("div", { class: "row" }, h("div", { class: "grow" }, pct),
          h("label", { class: "inline", for: ra.id }, ra, " Read-aloud"),
          h("button", { class: "btn", type: "button", "aria-label": `Save accommodations for ${a.display_name}`, onclick: async () => {
            try { await api.req("PUT", `/api/learning/accommodations/${a.student_id}`, { extraTimePct: Number(pct.value), readAloud: ra.checked }); toast(`Saved for ${first(a.display_name)}`); } catch { toast("Couldn't save."); } } }, "Save")));
      }))));
  }
  return out;
};

VIEWS.lesson = async () => {
  if (!state.lessonId) return VIEWS.courses();
  const l = (await api.get(`/api/learning/lessons/${state.lessonId}${learnerQuery()}`)).data;
  return [back("course", l.course),
    h("section", { class: "card", "aria-label": l.title }, h("p", { class: "small muted" }, `${l.unit}`), h("h2", {}, l.title),
      h("p", { class: "objective" }, h("b", {}, "Goal: "), l.objective),
      h("div", { class: "btns" }, l.standards.map(s => h("span", { class: "chip" }, s.code))),
      h("div", { class: "lesson-text" }, l.content.split(/\n+/).map(p => h("p", {}, p))),
      l.canManage ? h("p", { class: "small muted" }, l.approved ? "Approved: Christie may use this lesson's text for hints." : "Waiting for a school leader to approve it for Christie.") : null,
      l.adaptedFrom ? h("p", { class: "small muted" }, l.adaptedFrom.withdrawn ? "Adapted from a colleague's shared lesson (no longer shared)." : `Adapted from “${l.adaptedFrom.title}” by ${l.adaptedFrom.author}, ${l.adaptedFrom.school}.`) : null,
      l.canManage && ["teacher", "principal"].includes(state.me.role) ? h("div", { class: "btns" },
        h("button", { class: "btn", type: "button", onclick: () => shareMaterial("lesson", l.id, l.title) }, icon("people"), "Share with colleagues"),
        h("button", { class: "btn", type: "button", onclick: () => startDraft({ from: "lesson", sourceId: l.id }) }, icon("chat"), "Co-write with colleagues")) : null),
    l.mastery ? h("section", { class: "card", "aria-label": "My mastery" }, h("h2", {}, "My mastery here"), h("ul", { class: "list" }, l.standards.map(s => h("li", { class: "row" },
      h("span", { class: "grow" }, s.code), l.mastery[s.id] ? levelChip(l.mastery[s.id].level, ` ${l.mastery[s.id].mastery}%`) : levelChip("not_started"))))) : null,
    l.sources.length ? [h("h2", {}, "Primary sources"), ...l.sources.map(s => sourceCard(s))] : null,
    state.me.role === "pupil" && l.christieSkills.length ? h("section", { class: "card", "aria-label": "Practice" }, h("h2", {}, "Practice"),
      l.christieSkills.map(k => h("button", { class: "btn primary block", type: "button", onclick: () => startSkill(k.id) }, icon("spark"), `Practice “${k.title}” with Christie`)),
      h("p", { class: "small muted" }, "Christie gives hints from this approved lesson, not answers.")) : null,
    l.assignments.length ? h("section", { class: "card", "aria-label": "Work for this lesson" }, h("h2", {}, "Work for this lesson"), h("ul", { class: "list" }, l.assignments.map(a => h("li", { class: "row" },
      h("span", { class: "grow" }, a.title), h("button", { class: "btn", type: "button", "aria-label": `${a.kind === "quiz" ? "Open quiz" : "Details"}: ${a.title}`, onclick: () => openView("quiz", { assignmentId: a.id }) }, a.kind === "quiz" ? "Open quiz" : "Details"))))) : null];
};

VIEWS.quiz = async () => {
  if (!state.assignmentId) return VIEWS.courses();
  const a = (await api.get(`/api/learning/assignments/${state.assignmentId}${learnerQuery()}`)).data;
  const head = [back("course", "Course"), h("section", { class: "card", "aria-label": a.title }, h("p", { class: "small muted" }, `${kindText[a.kind]} · ${a.points} points · ${a.standards.map(s => s.code).join(", ")}`),
    h("h2", {}, a.title), a.instructions ? h("p", {}, a.instructions) : null,
    a.dueAt ? h("p", { class: "small" }, `Due ${fmtDay(a.dueAt)}`) : null)];
  if (a.kind === "work") {
    const s = a.submission;
    const rubricCard = s?.rubric_scores ? h("section", { class: "card", "aria-label": "Rubric" }, h("h2", {}, `Rubric: ${s.points_earned}/${a.points}`),
      h("ul", { class: "list" }, s.rubric_scores.map(r => h("li", {}, h("div", { class: "row" }, h("h3", { class: "grow" }, r.title), h("span", {}, `${r.points}/${r.max}`)), h("p", { class: "small muted" }, r.label)))),
      s.feedback ? h("p", { class: "feedback" }, h("b", {}, "Teacher: "), s.feedback) : null) : null;
    return [...head, rubricCard || h("section", { class: "card" }, empty(s ? (s.graded ? "Graded: your teacher will return it soon." : "Handed in. Waiting for your teacher.") : "Not handed in yet."))];
  }
  if (a.canManage) return [...head, h("section", { class: "card", "aria-label": "Attempts" }, h("h2", {}, "Attempts"), a.submissions.length ? h("ul", { class: "list" }, a.submissions.map(x => h("li", { class: "row" },
    h("span", { class: "grow" }, `${x.display_name} · attempt ${x.attempt_no}${x.extra_time_pct ? ` · +${x.extra_time_pct}% time` : ""}`),
    chip(x.status === "needs_review" ? "expected" : "present", x.status === "needs_review" ? "Review" : `${x.total}/${x.possible}`),
    x.status === "needs_review" ? h("button", { class: "btn", type: "button", "aria-label": `Review ${x.display_name}`, onclick: () => openView("review", { attemptId: x.id }) }, "Review") : null))) : empty("No attempts yet."))];
  const attempts = a.attempts || [];
  const openAttempt = attempts.find(x => x.status === "in_progress");
  const left = a.maxAttempts - attempts.length;
  const canStart = state.me.role === "pupil" && (openAttempt || left > 0) && a.status === "published";
  return [...head,
    h("section", { class: "card", "aria-label": "Before you start" }, h("h2", {}, "Before you start"), h("ul", { class: "facts" },
      h("li", {}, `${a.itemCount} questions`),
      h("li", {}, a.timeLimitMinutes ? `${a.effectiveMinutes} minutes${a.accommodations.extraTimePct ? ` (includes your +${a.accommodations.extraTimePct}% extra time)` : ""}` : "No time limit"),
      h("li", {}, `${a.maxAttempts} attempt${a.maxAttempts > 1 ? "s" : ""} · ${{ highest: "your best score counts", latest: "your last score counts", average: "your scores are averaged" }[a.retakePolicy]}`),
      a.accommodations.readAloud ? h("li", {}, "Read-aloud is on: tap 🔊 next to a question") : null),
      canStart ? h("button", { class: "btn primary block big", type: "button", onclick: async () => {
        try { const r = await api.post(`/api/learning/quizzes/${a.id}/attempts`); openView("attempt", { attemptId: r.data.attempt.id }); }
        catch (e) { toast({ no_attempts_left: "No attempts left.", quiz_past_due: "This quiz is past due.", not_enrolled: "You're not in this course." }[e.body?.error] || "Couldn't start the quiz."); } } },
        openAttempt ? "Resume quiz" : attempts.length ? `Retake (${left} left)` : "Start quiz") : null),
    attempts.length ? h("section", { class: "card", "aria-label": "My attempts" }, h("h2", {}, "My attempts"), h("ul", { class: "list" }, attempts.map(x => h("li", { class: "row" },
      h("span", { class: "grow" }, `Attempt ${x.attempt_no}${x.late ? " · late" : ""}`),
      chip(x.status === "needs_review" ? "expected" : x.status === "in_progress" ? "current" : "present", x.status === "needs_review" ? "With your teacher" : x.status === "in_progress" ? "In progress" : `${x.total}/${x.possible}`),
      x.status !== "in_progress" ? h("button", { class: "btn", type: "button", "aria-label": `See results of attempt ${x.attempt_no}`, onclick: () => openView("attempt", { attemptId: x.id }) }, "Results") : null)))) : null];
};

function itemInput(it, attemptId, disabled) {
  const id = `q-${it.id}`;
  const save = async (value) => {
    try { await api.req("PUT", `/api/learning/attempts/${attemptId}/responses/${it.id}`, { response: value }); }
    catch (e) { toast(e.body?.error === "time_up" ? "Time is up. Submit your quiz." : "Couldn't save that answer."); }
  };
  if (it.kind === "mc") return h("fieldset", { class: "choices" }, h("legend", { class: "sr" }, `Answer for question ${it.seq}`),
    it.choices.map((c, i) => h("label", { class: "choice", for: `${id}-${i}` }, h("input", { type: "radio", name: id, id: `${id}-${i}`, value: i, checked: it.response === String(i), disabled, onchange: () => save(String(i)) }), h("span", {}, c))));
  const input = it.kind === "numeric" ? h("input", { id, inputmode: "decimal", autocomplete: "off", maxlength: 40, disabled }) : h("textarea", { id, maxlength: 2000, rows: it.kind === "source" ? 4 : 2, disabled });
  input.value = it.response || "";
  input.addEventListener("change", () => save(input.value));
  return [h("label", { for: id }, it.kind === "numeric" ? "Your answer (a number or fraction)" : "Your answer"), input];
}
VIEWS.attempt = async () => {
  if (!state.attemptId) return VIEWS.courses();
  const a = (await api.get(`/api/learning/attempts/${state.attemptId}`)).data;
  const live = a.status === "in_progress";
  const out = [back("quiz", "Quiz"), h("h2", {}, a.title)];
  if (live) {
    const timer = h("p", { class: "timer", role: "timer", "aria-label": "Time left" });
    const warn = h("p", { class: "sr", "aria-live": "assertive" });
    if (a.deadlineAt) {
      const end = new Date(a.deadlineAt).getTime();
      const tick = () => {
        const s = Math.max(0, Math.round((end - Date.now()) / 1000));
        timer.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left${a.extraTimePct ? ` (+${a.extraTimePct}% time)` : ""}`;
        if (s === 300 || s === 60) warn.textContent = `${s / 60} minute${s > 60 ? "s" : ""} left.`;
        if (s === 0) { warn.textContent = "Time is up. Submit your quiz now."; clearInterval(state.quizTimer); }
      };
      tick(); clearInterval(state.quizTimer); state.quizTimer = setInterval(tick, 1000);
    } else timer.textContent = "No time limit";
    out.push(h("div", { class: "card sticky", "aria-label": "Quiz status" }, timer, warn, h("p", { class: "small muted" }, `Attempt ${a.attemptNo} of ${a.maxAttempts} · answers save as you go`)));
  } else {
    out.push(h("section", { class: "card hero", "aria-label": "Result" }, h("p", { class: "small muted" }, `Attempt ${a.attemptNo} of ${a.maxAttempts}${a.late ? " · submitted late" : ""}`),
      h("h2", {}, a.status === "needs_review" ? "Submitted. Some answers are with your teacher." : `Score: ${a.totalPoints} / ${a.possiblePoints}`),
      a.status === "needs_review" ? h("p", { class: "muted" }, `Auto-scored so far: ${a.autoPoints} / ${a.possiblePoints}`) : null,
      h("p", { class: "muted small" }, a.answersShown ? "Correct answers are shown because you have no attempts left." : a.canRetake ? "Correct answers appear after your last attempt." : "")));
  }
  a.items.forEach(it => {
    const result = live ? null : it.needsTeacher ? chip("expected", "Teacher will score") : it.earned == null ? null : chip(it.earned >= it.points ? "present" : it.earned > 0 ? "expected" : "absent", `${it.earned}/${it.points}`);
    const key = it.answerKey ? (it.kind === "mc" ? it.choices[it.answerKey.index] : it.kind === "numeric" ? it.answerKey.value : (it.answerKey.accepted || []).join(" or ")) : null;
    out.push(h("section", { class: "card item", "aria-label": `Question ${it.seq}` },
      h("div", { class: "row" }, h("h3", { class: "grow" }, `${it.seq}. ${it.prompt}`), result),
      a.readAloud && live ? sayBtn(`${it.prompt}${it.choices ? `. Choices: ${it.choices.join(", ")}` : ""}`, `question ${it.seq}`) : null,
      it.source ? h("div", { class: "source-ref" }, it.source.excerpt ? h("blockquote", {}, it.source.excerpt) : null,
        h("a", { href: it.source.url, target: "_blank", rel: "noopener noreferrer" }, `${it.source.title} (${it.source.archive})`)) : null,
      itemInput(it, a.id, !live),
      key ? h("p", { class: "small" }, h("b", {}, "Answer: "), key) : null,
      it.teacherComment ? h("p", { class: "feedback" }, h("b", {}, "Teacher: "), it.teacherComment) : null));
  });
  if (live) out.push(h("button", { class: "btn primary block big", type: "button", onclick: async () => {
    // Save whatever is in the text boxes, then confirm.
    for (const el of $main().querySelectorAll("input[id^=q-]:not([type=radio]), textarea[id^=q-]")) el.dispatchEvent(new Event("change"));
    if (!(await ask({ title: "Submit your quiz?", text: "You can't change answers after you submit.", confirm: "Submit" }))) return;
    try { await api.post(`/api/learning/attempts/${a.id}/submit`); clearInterval(state.quizTimer); toast("Submitted"); go("attempt", { push: false }); }
    catch { toast("Couldn't submit. Try again."); } } }, "Submit quiz"));
  else if (a.canRetake) out.push(h("button", { class: "btn block", type: "button", onclick: () => go("quiz") }, `Retake (${a.maxAttempts - a.attemptsUsed} left)`));
  return out;
};

VIEWS.mastery = async () => {
  if (!state.masteryStd) return VIEWS.courses();
  const m = (await api.get(`/api/learning/mastery/${state.masteryStd}${learnerQuery()}`)).data;
  return [back(state.courseId ? "course" : "progress", "Back"),
    h("section", { class: "card hero", "aria-label": `${m.standard.code} mastery` }, h("p", { class: "small muted" }, `${m.standard.framework} ${m.standard.code} · ${first(m.learner.name)}`),
      h("div", { class: "row" }, ring(m.mastery, m.standard.code), h("div", { class: "grow" }, h("h2", {}, LEVEL_TEXT[m.level]), h("p", { class: "small muted" }, m.standard.description)))),
    h("section", { class: "card", "aria-label": "How it's calculated" }, h("h2", {}, "How it's calculated"), h("p", {}, m.explanation), m.reason ? h("p", { class: "small" }, `Not "Mastered" yet: ${m.reason}.`) : null,
      m.used.length ? h("ul", { class: "list" }, m.used.map(u => h("li", {}, h("div", { class: "row" }, h("span", { class: "grow" }, `${u.label}`), h("span", { class: "small" }, `${u.score}% · counts ${u.share}%`)),
        barH(u.share, `${u.label} counts ${u.share} percent`), h("p", { class: "small muted" }, `${{ quiz: "Quiz", rubric: "Rubric", christie: "Christie practice" }[u.source]} · ${fmtDay(u.at)}`)))) : null),
    h("p", { class: "notice" }, `The rules: the ${m.rules.window} newest pieces of evidence count, each one ${Math.round(m.rules.decay * 100)}% as much as the next newer one. Quizzes and graded work count fully; Christie practice counts half. "Mastered" needs ${m.rules.masteredAt}%+, at least ${m.rules.minEvidence} pieces of evidence and one quiz or graded task. It describes work done, nothing more: no predictions or rankings.`)];
};

VIEWS.progress = async () => {
  if (state.me.role === "parent" && state.childId) state.learnerId = state.childId;
  if (state.me.role === "parent" && !state.learnerId) {
    const kids = (await api.get("/api/learning/progress")).data.children;
    if (!kids.length) return empty("No children are linked to your account yet.");
    state.learnerId = kids[0].id;
  }
  const p = (await api.get(`/api/learning/progress${learnerQuery()}`)).data;
  return [state.me.role === "parent" ? back("children", "Children") : null,
    h("h2", {}, `Grades & progress · ${first(p.learner.name)}`),
    ...p.courses.map(c => h("section", { class: "card", "aria-label": c.title },
      h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, c.title), h("p", { class: "small muted" }, `${c.teacher} · ${c.term}`)),
        h("span", { class: "grade", "aria-label": `Grade ${gradeText(c.grade)}` }, c.grade?.letter || "–")),
      h("p", { class: "small" }, `${gradeText(c.grade)}${c.missing ? ` · ${c.missing} missing` : ""}`),
      c.grade?.categories?.length ? h("p", { class: "small muted" }, c.grade.categories.map(k => `${k.name} ${k.percent == null ? "–" : `${k.percent}%`} (weight ${k.weight}${k.used ? "" : ", not counted yet"})`).join(" · ")) : null,
      h("h4", {}, `Standards: ${c.mastery.mastered} of ${c.mastery.total} mastered`),
      h("ul", { class: "list" }, c.standards.map(s => h("li", { class: "row" }, h("div", { class: "grow" }, h("p", { class: "small" }, h("b", {}, s.code), ` ${s.description.replace(/^Summary: /, "")}`)),
        levelChip(s.level, s.mastery != null ? ` ${s.mastery}%` : ""),
        s.mastery != null ? h("button", { class: "btn small-btn", type: "button", "aria-label": `Why? ${s.code} shows ${s.mastery}%`, onclick: () => openView("mastery", { masteryStd: s.id, courseId: null }) }, "Why?") : null))),
      c.recent.length ? [h("h4", {}, "Recently graded"), h("ul", { class: "list" }, c.recent.map(r => h("li", {}, h("div", { class: "row" }, h("span", { class: "grow" }, r.title), h("span", {}, `${r.earned}/${r.points}`)),
        r.feedback ? h("p", { class: "small feedback" }, `Teacher: ${r.feedback}`) : null)))] : null,
      h("button", { class: "btn block", type: "button", onclick: () => openView("course", { courseId: c.id }) }, "Open course"))),
    h("section", { class: "card", "aria-label": "Final grades and credentials" }, h("h2", {}, "Final grades & credentials"),
      p.finalGrades.length || p.credentials.length ? h("ul", { class: "list" },
        p.finalGrades.map(f => h("li", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, `${f.course}: ${f.letter} (${f.percent}%)`), h("p", { class: "small muted" }, `Posted ${fmtDay(f.posted_at)}${f.supersedes ? " · corrected" : ""}`)),
          f.edal_entry_id ? h("button", { class: "btn small-btn", type: "button", "aria-label": `Check record: ${f.course}`, onclick: () => openView("proof", { edalEntry: f.edal_entry_id }) }, "Check record") : null)),
        p.credentials.map(c => h("li", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, c.title), h("p", { class: "small muted" }, `${c.revoked_at ? "Revoked" : "Issued"} ${fmtDay(c.revoked_at || c.issued_at)}`)),
          c.edal_entry_id ? h("button", { class: "btn small-btn", type: "button", "aria-label": `Check record: ${c.title}`, onclick: () => openView("proof", { edalEntry: c.edal_entry_id }) }, "Check record") : null))) : empty("None yet."),
      p.fundFootnote ? h("p", { class: "small muted fund-footnote", role: "note" }, `* ${p.fundFootnote.fundName}: ${money(p.fundFootnote.givenCents)} given and ${money(p.fundFootnote.spentCents)} spent on district-wide preservation so far. Totals only; no donor names.`) : null),
    p.accommodations ? h("p", { class: "small muted" }, `Accommodations on file: ${p.accommodations.extraTimePct ? `+${p.accommodations.extraTimePct}% quiz time` : "standard time"}${p.accommodations.readAloud ? ", read-aloud" : ""}.`) : null,
    h("p", { class: "notice" }, `Only ${first(p.learner.name)}'s family, ${first(p.learner.name)} and school staff who teach or lead at the school can see this. Every view is logged.`)];
};

VIEWS.proof = async () => {
  if (!state.edalEntry) return VIEWS.progress();
  const r = (await api.get(`/api/edal/records/${state.edalEntry}`)).data;
  const p = r.payload || {};
  return [back(state.me.role === "pupil" || state.me.role === "parent" ? "progress" : "edal", "Back"),
    h("section", { class: `card ${r.ok ? "ok" : "bad"}`, "aria-label": "Record check" }, h("h2", {}, r.ok ? "✓ This record checks out" : "✗ This record does not match the ledger"),
      h("p", { class: "small muted" }, `Ledger entry #${r.entry.seq} · ${r.entry.kind.replace("_", " ")} · ${fmtDay(r.entry.recorded_at)}`),
      p.course ? h("p", {}, `${p.course}${p.term ? ` (${p.term})` : ""}: ${p.letter} · ${p.percent}%`) : p.title ? h("p", {}, p.title) : p.standard ? h("p", {}, `${p.standard} mastered at ${p.mastery}%`) : null,
      r.erased ? h("p", { class: "small" }, "The details were erased under a records-deletion request; the hash stays so the ledger still checks.") : null,
      h("ul", { class: "list" }, r.checks.map(c => h("li", { class: "row" }, h("span", { "aria-hidden": "true" }, c.ok ? "✓" : "✗"), h("span", { class: "grow" }, c.check), chip(c.ok ? "present" : "absent", c.ok ? "OK" : "Fails")))),
      h("p", { class: "small mono" }, `hash ${r.entry.entry_hash.slice(0, 24)}…`)),
    h("p", { class: "notice" }, r.statement)];
};

// ----- 37.6.0 Credentials Wallet (learner and family) -----
// The holder decides: export a signed credential file, or make a share link
// with the name shown as initials, in full or not at all, for 1-90 days, and
// turn any link off. Staff have no view of shares.
SUBVIEWS.push("wallet");
VIEWS.wallet = async () => {
  const w = (await api.get("/api/wallet")).data;
  const nameText = { initials: "Initials only", full: "Full name", none: "No name" };
  const list = w.credentials.map(c => {
    const pick = h("select", { id: `wn-${c.id}`, "aria-label": "How the name shows" }, Object.entries(nameText).map(([v, t]) => h("option", { value: v }, t)));
    const days = h("input", { id: `wd-${c.id}`, type: "number", min: 1, max: 90, value: "30", "aria-label": "Days the link works" });
    const out = h("div", { "aria-live": "polite" });
    return h("li", {},
      h("div", { class: "row" }, h("h3", { class: "grow" }, c.title), c.revoked ? chip("absent", "Revoked") : c.onLedger ? chip("present", "On the ledger") : null),
      h("p", { class: "small muted" }, `${c.learner} · ${c.school} · ${fmtDay(c.issuedAt)}`),
      c.revoked || !w.issuerReady ? null : h("div", { class: "stack" },
        h("label", { for: pick.id }, "Name on the credential"), pick,
        h("label", { for: days.id }, "Share link lasts (days)"), days,
        h("div", { class: "row" },
          h("a", { class: "btn", href: `/api/wallet/credentials/${c.id}/vc?name=${encodeURIComponent(pick.value)}`, download: "", onclick: (e) => { e.currentTarget.href = `/api/wallet/credentials/${c.id}/vc?name=${encodeURIComponent(pick.value)}`; } }, "Download"),
          h("button", { class: "btn primary", type: "button", onclick: async () => {
            try { const r = (await api.post(`/api/wallet/credentials/${c.id}/shares`, { nameDisplay: pick.value, days: Number(days.value) })).data;
              out.replaceChildren(h("p", { class: "small" }, r.note), h("input", { class: "mono", readonly: true, value: r.url, "aria-label": "Share link" }));
              toast("Share link made. Copy it now: it is shown once."); }
            catch { toast("Couldn't make a link."); } } }, "Make share link")), out),
      c.shares.length ? h("ul", { class: "list" }, c.shares.map(s => h("li", { class: "row" },
        h("div", { class: "grow" }, h("p", {}, `${nameText[s.nameDisplay]} · until ${fmtDay(s.expiresAt)}`), h("p", { class: "small muted" }, `Viewed ${s.views} time${s.views === 1 ? "" : "s"}${s.lastViewedAt ? ` · last ${ago(s.lastViewedAt)}` : ""}`)),
        s.state === "active" ? h("button", { class: "btn", type: "button", onclick: async () => {
          if (!await ask({ title: "Turn off this link?", text: "Anyone using it will see that it was turned off.", confirm: "Turn off", danger: true })) return;
          await api.post(`/api/wallet/shares/${s.id}/revoke`); toast("Link turned off"); go("wallet", { push: false }); } }, "Turn off") : chip("absent", s.state === "revoked" ? "Off" : "Expired")))) : null);
  });
  return [back(state.me.role === "parent" ? "children" : "path", "Back"), h("h2", {}, "Wallet"),
    w.issuerReady ? null : h("p", { class: "notice" }, "Your district hasn't turned on credential signing yet, so credentials can't be downloaded or shared."),
    list.length ? h("section", { class: "card", "aria-label": "Credentials" }, h("ul", { class: "list" }, list)) : empty("No credentials yet."),
    h("p", { class: "small muted" }, w.profile)];
};
for (const view of ["path", "children"]) {
  const base = VIEWS[view];
  VIEWS[view] = async () => [...[await base()].flat(), ["pupil", "parent"].includes(state.me.role)
    ? h("section", { class: "card", "aria-label": "Wallet" }, h("h2", {}, "Wallet"), h("p", { class: "small muted" }, "Download or share credentials. You choose who sees them and for how long."),
      h("button", { class: "btn", type: "button", onclick: () => go("wallet") }, "Open wallet")) : null];
}

// ----- staff -----
VIEWS.gradebook = async () => {
  if (!state.courseId) return VIEWS.courses();
  const g = (await api.get(`/api/learning/courses/${state.courseId}/gradebook`)).data;
  const lead = ["principal", "superintendent"].includes(state.me.role);
  const table = h("table", {}, h("caption", { class: "sr" }, `${g.course.title} gradebook`),
    h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Learner"), h("th", { scope: "col" }, "Grade"), g.assignments.map(a => h("th", { scope: "col" }, h("span", { title: a.title }, a.title.replace(/^Quiz: /, "Q: ")))))),
    h("tbody", {}, g.students.map(s => h("tr", {}, h("th", { scope: "row" }, first(s.name)), h("td", {}, s.grade.letter ? `${s.grade.letter} ${s.grade.percent}` : "–"),
      s.cells.map((c, i) => h("td", { class: c.missing ? "missing" : "" }, c.earned != null ? `${c.earned}/${g.assignments[i].points}` : c.missing ? "missing" : c.status === "needs_review" ? "review" : c.status === "submitted" ? "in" : "–"))))));
  return [back("courses", "Courses"), h("h2", {}, `Gradebook · ${g.course.title}`),
    h("p", { class: "small muted" }, `Weights: ${Object.entries(g.course.gradeWeights).map(([k, v]) => `${k} ${v}%`).join(", ")}. Categories with no graded work are left out, so ungraded work never counts as zero; missing work is flagged.`),
    h("div", { class: "tablewrap", role: "region", "aria-label": "Gradebook table", tabindex: 0 }, table),
    h("section", { class: "card", "aria-label": "Final grades" }, h("h2", {}, "Final grades"), h("p", { class: "small muted" }, "Posting writes the grade to the EDAL records ledger. A correction adds a new record with your reason; nothing is overwritten."),
      h("ul", { class: "list" }, g.students.map(s => h("li", {}, h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, s.name),
        h("p", { class: "small muted" }, s.final ? `Posted ${s.final.letter} (${s.final.percent}%) ${fmtDay(s.final.posted_at)}` : `Now: ${s.grade.letter ? `${s.grade.letter} ${s.grade.percent}%` : "no graded work"}${s.missing ? ` · ${s.missing} missing` : ""}`))),
        h("div", { class: "btns" },
          s.grade.percent != null ? h("button", { class: "btn", type: "button", "aria-label": `${s.final ? "Correct" : "Post"} final grade for ${s.name}`, onclick: async () => {
            const reason = s.final ? await ask({ title: `Correct ${first(s.name)}'s final grade`, text: `Posts ${s.grade.letter} (${s.grade.percent}%) as a correction.`, label: "Reason (shown on the record)", confirm: "Post correction" })
              : await ask({ title: `Post ${first(s.name)}'s final grade?`, text: `${s.grade.letter} (${s.grade.percent}%) will be recorded on the ledger.`, confirm: "Post" });
            if (!reason) return;
            try { await api.post(`/api/learning/courses/${g.course.id}/final-grades`, { studentId: s.id, ...(s.final ? { percent: s.grade.percent, reason } : {}) }); toast("Final grade recorded"); go("gradebook", { push: false }); }
            catch (e) { toast(e.body?.error === "invalid_final_grade" ? "A correction needs a reason of 10+ characters." : "Couldn't post."); } } }, s.final ? "Correct" : "Post final grade") : null,
          lead ? h("button", { class: "btn", type: "button", "aria-label": `Issue a credential to ${s.name}`, onclick: async () => {
            const title = await ask({ title: `Credential for ${first(s.name)}`, label: "Title", value: `Completed ${g.course.title}`, confirm: "Issue", maxlength: 160 });
            if (!title) return;
            try { await api.post("/api/learning/credentials", { studentId: s.id, kind: "course_completion", title, courseId: g.course.id }); toast("Credential issued and recorded"); } catch { toast("Couldn't issue."); } } }, "Issue credential") : null)))))];
};

VIEWS.review = async () => {
  if (!state.attemptId) return VIEWS.grading();
  const a = (await api.get(`/api/learning/attempts/${state.attemptId}`)).data;
  const fields = [];
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault();
    const scores = fields.map(f => ({ itemId: f.id, ...(f.points ? { points: Number(f.points.value) } : {}), ...(f.comment.value.trim() ? { comment: f.comment.value.trim() } : {}) })).filter(s => s.points !== undefined || s.comment);
    try { await api.post(`/api/learning/attempts/${a.id}/review`, { scores }); toast("Returned to the learner"); go("grading"); }
    catch (err) { toast(err.body?.error === "items_still_need_points" ? "Give points for every open answer." : "Couldn't save the review."); }
  } }, a.items.map(it => {
    const pts = it.autoCorrect === null
      ? h("input", { id: `pts-${it.id}`, type: "number", min: 0, max: it.points, step: 0.5, required: true, inputmode: "decimal", value: it.earned ?? "" }) : null;
    const comment = h("textarea", { id: `cm-${it.id}`, maxlength: 1000, rows: 2 });
    fields.push({ id: it.id, points: pts, comment });
    const key = it.answerKey ? (it.kind === "mc" ? it.choices[it.answerKey.index] : it.kind === "numeric" ? it.answerKey.value : (it.answerKey.accepted || []).join(" or ") || "(teacher judgement)") : null;
    return h("section", { class: "card item", "aria-label": `Question ${it.seq}` }, h("h3", {}, `${it.seq}. ${it.prompt}`),
      h("p", { class: "answer" }, h("b", {}, "Answer given: "), (it.kind === "mc" ? it.choices[Number(it.response)] : it.response) || "(blank)"),
      key ? h("p", { class: "small muted" }, `Key: ${key}`) : null,
      pts ? [h("label", { for: pts.id }, `Points (0–${it.points})`), pts] : h("p", { class: "small" }, `Auto-scored: ${it.earned}/${it.points}`),
      h("label", { for: comment.id }, "Comment (optional)"), comment);
  }), h("button", { class: "btn primary block big", type: "submit" }, "Return to learner"));
  return [back("grading", "Grading"), h("h2", {}, `Review · ${a.title}`), h("p", { class: "small muted" }, `Attempt ${a.attemptNo}${a.late ? " · late" : ""}${a.extraTimePct ? ` · had +${a.extraTimePct}% time` : ""}`), form];
};

VIEWS.rubric = async () => {
  if (!state.gradeTarget) return VIEWS.grading();
  const { assignmentId, studentId, name } = state.gradeTarget;
  const a = (await api.get(`/api/learning/assignments/${assignmentId}`)).data;
  const sub = a.submissions.find(s => s.student_id === studentId);
  const groups = a.rubric.map(c => h("fieldset", { class: "choices" }, h("legend", {}, c.title),
    c.levels.map(l => h("label", { class: "choice", for: `rb-${c.id}-${l.points}` }, h("input", { type: "radio", name: `rb-${c.id}`, id: `rb-${c.id}-${l.points}`, value: l.points, required: true }), h("span", {}, `${l.points} · ${l.label}`)))));
  const fb = h("textarea", { id: "rb-feedback", maxlength: 4000, rows: 3 });
  return [back("grading", "Grading"), h("h2", {}, `${a.title} · ${name}`),
    sub?.response_text ? h("section", { class: "card" }, h("h3", {}, "Handed in"), h("p", {}, sub.response_text)) : null,
    h("form", { class: "card", onsubmit: async (e) => {
      e.preventDefault();
      const scores = a.rubric.map(c => ({ criterionId: c.id, points: Number($main().querySelector(`input[name="rb-${c.id}"]:checked`)?.value) }));
      try { const r = await api.post(`/api/learning/assignments/${a.id}/grade`, { studentId, scores, feedback: fb.value }); toast(`Returned: ${r.data.earned}/${r.data.possible}`); go("grading"); }
      catch { toast("Pick a level for every row."); } } },
      groups, h("label", { for: fb.id }, "Feedback for the learner and family"), fb, h("button", { class: "btn primary block", type: "submit" }, "Return with rubric"))];
};

VIEWS.approvals = async () => {
  const r = (await api.get("/api/learning/approvals")).data;
  return [back("overview", "School"), h("h2", {}, "Approvals"),
    h("section", { class: "card", "aria-label": "Lessons for Christie" }, h("h2", {}, "Lessons for Christie"), h("p", { class: "small muted" }, "Christie only uses a lesson's text for hints after you approve it."),
      r.lessons.length ? h("ul", { class: "list" }, r.lessons.map(l => h("li", {}, h("h3", {}, l.title), h("p", { class: "small muted" }, `${l.course} · ${l.teacher}`), h("p", { class: "small" }, l.objective),
        h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: () => openView("lesson", { lessonId: l.id }) }, "Read"),
          h("button", { class: "btn primary", type: "button", "aria-label": `Approve ${l.title}`, onclick: async () => { await api.post(`/api/learning/lessons/${l.id}/approve`); toast("Approved"); go("approvals", { push: false }); } }, "Approve"))))) : empty("No lessons waiting.")),
    h("section", { class: "card", "aria-label": "Primary sources" }, h("h2", {}, "Primary sources"), h("p", { class: "small muted" }, "Only public-domain items from the Library of Congress or the National Archives can be added."),
      r.sources.length ? r.sources.map(s => [sourceCard(s), h("button", { class: "btn primary block", type: "button", onclick: async () => { await api.post(`/api/learning/sources/${s.id}/approve`); toast("Approved"); go("approvals", { push: false }); } }, `Approve “${s.title.slice(0, 40)}”`)]) : empty("No sources waiting."))];
};

VIEWS.edal = async () => {
  const v = (await api.get("/api/edal/verify")).data;
  const out = h("pre", { class: "mono", tabindex: 0, "aria-label": "Checkpoint to keep" });
  return [back("overview", state.me.role === "principal" ? "School" : "District"), h("h2", {}, "Academic records ledger (EDAL)"),
    h("section", { class: `card ${v.ok ? "ok" : "bad"}`, "aria-label": "Verification" }, h("h2", {}, v.ok ? "✓ Ledger verified" : "✗ Ledger problem found"),
      h("p", {}, `${v.entries} records · head #${v.headSeq} · checked ${fmtTime(v.verifiedAt)}`),
      h("div", { class: "stats" }, stat(v.byKind.final_grade || 0, "final grades"), stat((v.byKind.credential || 0), "credentials"), stat(v.byKind.mastery_milestone || 0, "mastery milestones"), stat(v.erased, "erased (FERPA)")),
      v.problems.length ? h("ul", { class: "list" }, v.problems.map(p => h("li", {}, `#${p.seq}: ${p.problem}`))) : null,
      h("p", { class: "small mono" }, `head ${v.headHash.slice(0, 32)}…`)),
    h("section", { class: "card", "aria-label": "Checkpoints" }, h("h2", {}, "Checkpoints"),
      h("p", { class: "small muted" }, "A checkpoint is the ledger's current fingerprint. Keep a copy outside EduOS: if anyone rewrote history, the copy would stop matching."),
      v.checkpoints.length ? h("ul", { class: "list" }, v.checkpoints.map(c => h("li", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, `#${c.seq} · ${fmtDay(c.createdAt)}`), h("p", { class: "small muted" }, c.note || "")), chip(c.holds ? "present" : "absent", c.holds ? "Matches" : "Broken")))) : empty("No checkpoints yet."),
      ["superintendent", "it_admin", "principal"].includes(state.me.role) ? h("button", { class: "btn primary block", type: "button", onclick: async () => {
        const note = await ask({ title: "Save a checkpoint", label: "Note", value: "End of grading period", confirm: "Save" });
        if (!note) return;
        try { const r = await api.post("/api/edal/checkpoints", { note }); out.textContent = JSON.stringify(r.data, null, 2); toast("Checkpoint saved. Keep the copy below."); }
        catch { toast("Couldn't save a checkpoint."); } } }, "Save checkpoint") : null, out),
    h("p", { class: "notice" }, v.statement + " Planned: optional anchoring of checkpoints with an RFC 3161 timestamp authority or OpenTimestamps (off by default; would send only the hash).")];
};

// ---------------- alerts & account ----------------
VIEWS.alerts = async () => {
  const [n, reports] = await Promise.all([api.get("/api/notifications"), ["principal", "superintendent"].includes(state.me.role) ? safe(api.get("/api/comms/reports")) : null]);
  const items = n.data.items;
  const out = [h("div", { class: "row" }, h("h2", { class: "grow" }, "Alerts"),
    n.data.unread ? h("button", { class: "btn", type: "button", onclick: async () => { await api.post("/api/notifications/read", {}); state.unread = 0; renderTop(); go("alerts", { push: false }); } }, "Mark all read") : null),
    h("section", { class: "card", "aria-label": "Notifications" }, items.length ? h("ul", { class: "list" }, items.map(i => h("li", { class: "row" },
      h("span", { "aria-hidden": "true" }, icon(i.kind === "transport" ? "bus" : i.kind === "christie" ? "spark" : i.kind === "announcement" ? "news" : i.kind === "safety" ? "shield" : i.kind === "pickup" ? "car" : "chat")),
      h("div", { class: "grow" }, h("h3", {}, i.title), i.body ? h("p", { class: "small" }, i.body) : null, h("p", { class: "small muted" }, ago(i.created_at))),
      i.read_at ? null : h("span", { class: "chip current" }, "New")))) : empty("No alerts."))];
  const open = (reports?.data || []).filter(r => r.status === "open");
  if (reports) out.push(h("section", { class: "card", "aria-label": "Moderation" }, h("h2", {}, "Reported messages"),
    open.length ? h("ul", { class: "list" }, open.map(r => h("li", {}, h("h3", {}, `${r.subject}`), h("p", { class: "small muted" }, `${r.author_name} · reported by ${r.reported_by_name}: ${r.reason}`), h("p", {}, r.body || "(hidden)"),
      h("div", { class: "btns" },
        h("button", { class: "btn danger", type: "button", onclick: async () => { await api.post(`/api/comms/reports/${r.id}/resolve`, { action: "hide", reason: "Hidden after review" }); toast("Message hidden"); go("alerts", { push: false }); } }, "Hide message"),
        h("button", { class: "btn", type: "button", onclick: async () => { await api.post(`/api/comms/reports/${r.id}/resolve`, { action: "dismiss", reason: "No action needed" }); toast("Dismissed"); go("alerts", { push: false }); } }, "Dismiss"))))) : empty("Nothing to review.")));
  return out;
};
// ----- 37.6.0 Marketplace (vendor listings, privacy review, request -> license) -----
SUBVIEWS.push("market");
const MK_PRIV = { not_reviewed: ["expected", "Not reviewed"], in_review: ["expected", "In review"], changes_requested: ["absent", "Changes requested"], approved: ["present", "Privacy approved"], rejected: ["absent", "Rejected"] };
VIEWS.market = async () => {
  const m = (await api.get("/api/marketplace")).data;
  const reload = () => go("market", { push: false });
  const err = e => toast({ checklist_incomplete: "Every privacy item must be checked to approve.", privacy_review_not_approved: "This listing's privacy review isn't approved.",
    request_already_pending: "Your school already asked for this.", dpa_expired: "The data privacy agreement has expired.", note_required: "Add a note." }[e.body?.error] || "Couldn't save.");
  const card = l => {
    const out = [h("div", { class: "row" }, h("h3", { class: "grow" }, l.name), chip(...(MK_PRIV[l.privacy.status] || ["expected", l.privacy.status]))),
      h("p", { class: "small muted" }, `${l.vendor} · ${l.category} · data shared: ${l.dataSharingScope}${l.pricingNote ? ` · ${l.pricingNote}` : ""}`), h("p", {}, l.description)];
    if (m.canRequest && l.requestable) {
      const reason = h("input", { id: `mk-r-${l.id}`, maxlength: 2000, required: true }), seats = h("input", { id: `mk-s-${l.id}`, type: "number", min: 1, max: 100000 });
      const scope = state.me.role === "principal" ? h("select", { id: `mk-sc-${l.id}` }, h("option", { value: "school" }, "My school"), h("option", { value: "district" }, "Whole district")) : null;
      out.push(h("form", { class: "stack", onsubmit: async e => { e.preventDefault(); try { await api.post(`/api/marketplace/listings/${l.id}/request`, { reason: reason.value, seats: seats.value || null, scope: scope?.value || "school" }); toast("Request sent to the district"); reload(); } catch (x) { err(x); } } },
        h("label", { for: reason.id }, "Why do you need it?"), reason, h("label", { for: seats.id }, "Seats (optional)"), seats, scope ? [h("label", { for: scope.id }, "For"), scope] : null, h("button", { class: "btn", type: "submit" }, "Request")));
    }
    if (l.requests.length) out.push(h("ul", { class: "list" }, l.requests.map(r => h("li", { class: "row wrap" }, h("span", { class: "grow" }, `${r.school} · ${r.status}${r.seats ? ` · ${r.seats} seats` : ""}`, h("br"), h("span", { class: "small muted" }, `${r.requestedBy}: ${r.reason}`)),
      m.canDecide && r.status === "pending" ? [h("button", { class: "btn primary small", type: "button", onclick: async () => { try { await api.post(`/api/marketplace/requests/${r.id}/approve`, {}); toast("Approved: license and access added"); reload(); } catch (x) { err(x); } } }, "Approve"),
        h("button", { class: "btn small", type: "button", onclick: async () => { try { await api.req("PATCH", `/api/app-requests/${r.id}`, { decision: "denied" }); toast("Denied"); reload(); } catch (x) { err(x); } } }, "Deny")] : null))));
    if (m.canManage) {
      const boxes = m.checklist.map(c => h("label", { class: "row" }, h("input", { type: "checkbox", value: c.key, checked: l.privacy.checklist?.[c.key] === true }), " ", c.label));
      const st = h("select", { id: `mk-ps-${l.id}` }, ["in_review", "changes_requested", "approved", "rejected"].map(s => h("option", { value: s }, MK_PRIV[s][1])));
      const note = h("input", { id: `mk-pn-${l.id}`, maxlength: 1000 }), dpa = h("input", { id: `mk-pd-${l.id}`, type: "date", value: l.privacy.dpaExpiresOn ? String(l.privacy.dpaExpiresOn).slice(0, 10) : "" });
      out.push(h("details", {}, h("summary", {}, "Privacy review"), h("form", { class: "stack", onsubmit: async e => { e.preventDefault();
        try { await api.post(`/api/marketplace/listings/${l.id}/review`, { status: st.value, note: note.value || null, dpaExpiresOn: dpa.value || null, checklist: Object.fromEntries(boxes.map(b => b.querySelector("input")).map(i => [i.value, i.checked])) }); toast("Review saved"); reload(); } catch (x) { err(x); } } },
        ...boxes, h("label", { for: dpa.id }, "DPA expires"), dpa, h("label", { for: st.id }, "Decision"), st, h("label", { for: note.id }, "Note"), note, h("button", { class: "btn", type: "submit" }, "Save review")),
        l.reviews.length ? h("ul", { class: "list" }, l.reviews.map(r => kv(`${r.from} → ${r.to}${r.note ? ` · ${r.note}` : ""}`, `${r.by} · ${fmtDay(r.at)}`))) : null));
    }
    return h("li", {}, ...out);
  };
  const views = [back(state.me.role === "teacher" ? "classes" : "overview", "Back"), h("h2", {}, "Marketplace"),
    m.listings.length ? h("section", { class: "card", "aria-label": "Listings" }, h("ul", { class: "list" }, m.listings.map(card))) : empty(m.canManage ? "No listings yet. Add a vendor and a listing below." : "No approved apps to request yet.")];
  if (m.canManage) {
    const vn = h("input", { id: "mk-vn", maxlength: 120, required: true }), vw = h("input", { id: "mk-vw", type: "url", placeholder: "https://" });
    views.push(h("section", { class: "card", "aria-label": "Add vendor" }, h("h2", {}, "Add a vendor"), h("form", { class: "stack", onsubmit: async e => { e.preventDefault(); try { await api.post("/api/marketplace/vendors", { name: vn.value, website: vw.value || null }); toast("Vendor added"); reload(); } catch (x) { err(x); } } },
      h("label", { for: "mk-vn" }, "Name"), vn, h("label", { for: "mk-vw" }, "Website"), vw, h("button", { class: "btn", type: "submit" }, "Add vendor"))));
    if (m.vendors.length) {
      const f = { vendorId: h("select", { id: "mk-lv" }, m.vendors.map(v => h("option", { value: v.id }, v.name))), name: h("input", { id: "mk-ln", maxlength: 120, required: true }), category: h("input", { id: "mk-lc", maxlength: 40, required: true }),
        description: h("textarea", { id: "mk-ld", maxlength: 1000, required: true }), launchUrl: h("input", { id: "mk-lu", type: "url", required: true, placeholder: "https://" }),
        dataSharingScope: h("select", { id: "mk-lsc" }, ["none", "identity", "roster_basic", "roster_full"].map(s => h("option", { value: s }, s))), pricingNote: h("input", { id: "mk-lp", maxlength: 300 }) };
      views.push(h("section", { class: "card", "aria-label": "Add listing" }, h("h2", {}, "Add a listing"), h("form", { class: "stack", onsubmit: async e => { e.preventDefault();
          try { await api.post("/api/marketplace/listings", Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value || null]))); toast("Listing added: review its privacy next"); reload(); } catch (x) { err(x); } } },
        ...Object.entries({ vendorId: "Vendor", name: "App name", category: "Category", description: "Description", launchUrl: "Launch URL", dataSharingScope: "Data shared", pricingNote: "Pricing note" }).flatMap(([k, t]) => [h("label", { for: f[k].id }, t), f[k]]),
        h("button", { class: "btn", type: "submit" }, "Add listing"))));
    }
    views.push(h("p", { class: "small muted" }, m.feeAccounting));
  }
  return views;
};
for (const view of ["overview", "classes"]) {
  const base = VIEWS[view];
  VIEWS[view] = async () => [...[await base()].flat(), ["principal", "teacher", "superintendent"].includes(state.me.role)
    ? h("section", { class: "card", "aria-label": "Marketplace" }, h("h2", {}, "Marketplace"), h("p", { class: "small muted" }, "Privacy-reviewed apps your school can request."), h("button", { class: "btn", type: "button", onclick: () => go("market") }, "Open marketplace")) : null];
}
// ---- 32.7.0 EDEN: district hub "Nodes" screen and school node status ------
const NODE_STATE = { online: ["present", "Online"], offline: ["absent", "Offline"], never: ["expected", "Not synced yet"], disabled: ["expected", "Not set up"] };
const FO_STATE = { authorized: ["expected", "Authorized"], active: ["absent", "Partner hosting"], handing_back: ["expected", "Handing back"], returned: ["expected", "Returned"], closed: ["present", "Closed"], cancelled: ["present", "Cancelled"] };
const staffOf = c => (Number(c?.memberships) || 0) + (Number(c?.memberships_reenabled) || 0);
const kv = (label, value) => h("li", { class: "row" }, h("span", { class: "grow" }, label), h("span", { class: "muted" }, value ?? "—"));
async function edenNodesView() {
  const tier = (await safe(api.get("/api/eden/tier")))?.data;
  if (tier?.tier === "school") return VIEWS.node();
  if (tier?.tier !== "district") return [h("h2", {}, "School nodes"), h("section", { class: "card" }, h("p", {}, "This EduOS server is not set up as an EDEN district hub, so there are no school nodes to manage."),
    h("p", { class: "muted small" }, "Set EDUOS_NODE_TIER=district with the district certificate from the authority. See docs/UPGRADING-32.7.0.md."))];
  const o = (await api.get("/api/eden/admin/overview")).data;
  const canAuthorize = state.me.role === "superintendent";
  const byId = Object.fromEntries(o.nodes.map(n => [n.id, n]));
  const online = o.nodes.filter(n => n.online).length;
  const open = o.failovers.filter(f => ["authorized", "active", "handing_back", "returned"].includes(f.status));
  const out = [h("h2", {}, "School nodes"),
    h("section", { class: "card hero", "aria-label": "District hub" }, h("p", { class: "muted small" }, "EDEN district hub"),
      h("h2", {}, `${online} of ${o.nodes.length} school node${o.nodes.length === 1 ? "" : "s"} online`),
      h("p", { class: "muted small" }, `Trust root ${o.hub.rootFingerprint || "not set"} · district certificate until ${o.hub.districtCertExpires ? fmtDay(o.hub.districtCertExpires) : "—"} · record transfers ${o.hub.consentExceptions ? "on" : "off"}`))];
  if (open.length) out.push(h("section", { class: "card alertcard", "aria-label": "Failovers in progress" }, h("h2", {}, "Failover in progress"), h("ul", { class: "list" }, open.map(f => h("li", { class: "row wrap" },
    h("span", { class: "grow" }, h("b", {}, f.school_name), h("br"), h("span", { class: "muted small" }, `${byId[f.partner_node_id]?.school_name || "Partner"} is covering · until ${fmtTime(f.expires_at)} ${fmtDay(f.expires_at)} · by ${f.authorized_by_name}`),
      f.restored_counts ? h("span", { class: "muted small" }, h("br"), `Carried: ${f.restored_counts.students} students, ${staffOf(f.restored_counts)} staff, ${f.restored_counts.pickup_adults ?? 0} pick-up adults`) : null),
    chip(...(FO_STATE[f.status] || ["expected", f.status])),
    ["authorized", "active"].includes(f.status) ? h("button", { class: "btn small", type: "button", "aria-label": `End failover for ${f.school_name}`, onclick: async () => {
      if (await ask({ title: `End the failover for ${f.school_name}?`, text: "The partner hands everything back to the school node, then deletes its copy.", confirm: "End failover" })) { await api.post(`/api/eden/admin/failovers/${f.id}/end`); toast("Handback started"); go("nodes", { push: false }); } } }, "End") : null)))));
  out.push(h("section", { class: "card", "aria-label": "Nodes" }, h("h2", {}, "Nodes"), o.nodes.length ? h("ul", { class: "list" }, o.nodes.map(n => {
    const [cls, txt] = n.status === "revoked" ? ["absent", "Revoked"] : n.online ? NODE_STATE.online : NODE_STATE.offline;
    const hl = n.last_health?.metrics || {};
    return h("li", { class: "row wrap" }, h("span", { class: "grow" }, h("b", {}, n.school_name), h("br"),
      h("span", { class: "muted small" }, `${n.name} · v${n.version || "?"} · seen ${n.last_seen_at ? ago(n.last_seen_at) : "never"}${hl.outbox_pending != null ? ` · ${hl.outbox_pending} waiting` : ""}${hl.rss_mb != null ? ` · ${hl.rss_mb} MB` : ""}`), h("br"),
      h("span", { class: "muted small" }, `Partner: ${byId[n.partner_node_id]?.school_name || "none"} · continuity package ${n.continuity_at ? ago(n.continuity_at) : "not sent"} · ${n.aggregates} aggregate tables`)),
      chip(cls, txt));
  })) : empty("No school nodes yet. Create an enrollment token below.")));
  const past = o.failovers.filter(f => !open.includes(f)).slice(0, 5);
  if (past.length) out.push(h("section", { class: "card", "aria-label": "Failover history" }, h("h2", {}, "Failover history"), h("ul", { class: "list" }, past.map(f => h("li", { class: "row wrap" },
    h("span", { class: "grow" }, h("b", {}, f.school_name), h("br"), h("span", { class: "muted small" }, `${fmtDay(f.authorized_at)} ${fmtTime(f.authorized_at)} · ${f.reason}`), h("br"),
      h("span", { class: "muted small" }, [f.handback_reason === "origin_recovered" ? "handed back when the node returned" : f.handback_reason ? `ended: ${f.handback_reason}` : null,
        f.import_counts ? `${Object.values(f.import_counts).reduce((a, b) => a + (Number(b) || 0), 0)} records merged back` : null,
        f.purge_counts ? `partner copy deleted (${f.purge_counts.remaining_students ?? "?"} learners left)` : null].filter(Boolean).join(" · "))),
    chip(...(FO_STATE[f.status] || ["expected", f.status])))))));
  // Partners and failover authorization.
  if (o.nodes.length > 1) {
    const forNode = h("select", { id: "pn" }, o.nodes.map(n => h("option", { value: n.id }, n.school_name)));
    const partner = h("select", { id: "pp" }, o.nodes.map(n => h("option", { value: n.id }, n.school_name)));
    if (o.nodes[1]) partner.value = o.nodes[1].id;
    out.push(h("section", { class: "card", "aria-label": "Partner schools" }, h("h2", {}, "Partner schools"), h("p", { class: "muted small" }, "A partner keeps a sealed, minimum copy (students, staff, rosters, bus routes, approved pick-up adults and restrictions) and can cover the school if its node fails. The district holds only ciphertext."),
      h("form", { class: "stack", onsubmit: async e => { e.preventDefault(); try { await api.post(`/api/eden/admin/nodes/${forNode.value}/partner`, { partnerNodeId: partner.value }); toast("Partner saved"); go("nodes", { push: false }); } catch (err) { toast(err.body?.error === "partner_self" ? "A school can't partner with itself." : "Couldn't save."); } } },
        h("label", { for: "pn" }, "School"), forNode, h("label", { for: "pp" }, "Covered by"), partner, h("button", { class: "btn", type: "submit" }, "Save partner"))));
  }
  const failed = o.nodes.filter(n => !n.online && n.partner_node_id && n.status !== "revoked" && !open.some(f => f.failed_node_id === n.id));
  if (canAuthorize) {
    const sel = h("select", { id: "fn" }, failed.map(n => h("option", { value: n.id }, `${n.school_name} → ${byId[n.partner_node_id]?.school_name}`)));
    const reason = h("textarea", { id: "fr", rows: 2, maxlength: 500, placeholder: "e.g. Fibre cut at the building, node unreachable" });
    const hours = h("input", { id: "fh", type: "number", min: 1, max: o.hub.failoverMaxHours, value: 8, inputmode: "numeric" });
    out.push(h("section", { class: "card", "aria-label": "Authorize failover" }, h("h2", {}, "Authorize failover"),
      h("p", { class: "muted small" }, `Only for a school whose node is offline (no answer for ${o.hub.offlineAfterSeconds} s) and whose partner is online. Time-limited (at most ${o.hub.failoverMaxHours} h), logged, and handed back automatically as soon as the school's node returns.`),
      failed.length ? h("form", { class: "stack", onsubmit: async e => { e.preventDefault();
        if (!(await ask({ title: "Authorize this failover?", text: "The partner school will open this school's minimum data for staff sign-in until the time limit or the node comes back.", confirm: "Authorize", danger: true }))) return;
        try { await api.post("/api/eden/admin/failovers", { failedNodeId: sel.value, reason: reason.value, hours: Number(hours.value) }); toast("Failover authorized"); go("nodes", { push: false }); }
        catch (err) { toast({ node_online: "That node is online again.", partner_offline: "The partner is offline.", no_continuity_package: "No continuity package from that school yet.", reason_required: "Give a reason (10+ characters)." }[err.body?.error] || "Couldn't authorize."); } } },
        h("label", { for: "fn" }, "School to cover"), sel, h("label", { for: "fr" }, "Reason (kept in the log)"), reason, h("label", { for: "fh" }, "Hours"), hours,
        h("button", { class: "btn danger block", type: "submit" }, "Authorize failover")) : empty("No school node is offline. Nothing to cover.")));
  }
  // Enrollment.
  const school = h("select", { id: "es" }, o.schools.map(s => h("option", { value: s.id }, s.name)));
  const tokenOut = h("div", { "aria-live": "polite" });
  out.push(h("section", { class: "card", "aria-label": "Add a school node" }, h("h2", {}, "Add a school node"),
    h("p", { class: "muted small" }, "Creates a one-time token (24 hours). The node proves it holds its own key, gets a certificate under the district, and trusts only the pinned root."),
    h("form", { class: "stack", onsubmit: async e => { e.preventDefault(); try { const t = (await api.post("/api/eden/admin/enrollment-tokens", { schoolId: school.value, name: "School node" })).data; tokenOut.replaceChildren(h("p", { class: "notice" }, "Shown once: ", h("code", { class: "token" }, t.token))); } catch { toast("Couldn't create a token."); } } },
      h("label", { for: "es" }, "School"), school, h("button", { class: "btn", type: "submit" }, "Create enrollment token")), tokenOut));
  // Signed bundles.
  const latest = {}; for (const b of o.bundles) if (!latest[b.kind]) latest[b.kind] = b;
  out.push(h("section", { class: "card", "aria-label": "Signed updates" }, h("h2", {}, "Signed updates for schools"), h("ul", { class: "list" }, ["catalog", "branding", "lessons", "content"].map(k => h("li", { class: "row" },
    h("span", { class: "grow" }, { catalog: "App catalog and licences", branding: "Branding", lessons: "Approved lessons", content: "Library content" }[k], h("br"), h("span", { class: "muted small" }, latest[k] ? `v${latest[k].version} · ${latest[k].signer_kind}-signed · ${ago(latest[k].published_at)}` : "not published")),
    h("button", { class: "btn small", type: "button", "aria-label": `Publish ${k}`, onclick: async () => { try { const r = (await api.post("/api/eden/admin/bundles/publish", { kind: k })).data; toast(`Published v${r.version}`); go("nodes", { push: false }); } catch (err) { toast(err.body?.error === "unchanged" ? "Nothing changed since the last version." : "Couldn't publish."); } } }, "Publish"))))));
  out.push(h("section", { class: "card", "aria-label": "What schools sent" }, h("h2", {}, "What schools sent"), h("p", { class: "muted small" }, "Only counts that pass the gate (cells under 5 hidden) are accepted. Anything else is refused and logged."),
    o.inbound.length ? h("ul", { class: "list" }, o.inbound.slice(0, 8).map(l => h("li", { class: "row" }, h("span", { class: "grow" }, `${byId[l.node_id]?.school_name || "Unknown node"} · ${l.kind}`, h("br"), h("span", { class: "muted small" }, `${ago(l.received_at)}${l.reason ? ` · ${l.reason}` : ""}`)),
      chip(l.decision === "accepted" ? "present" : l.decision === "rejected" ? "absent" : "expected", l.decision)))) : empty("Nothing yet.")));
  return out;
}

// Edge Phase 2: EduOS edge devices and their health reports (db/038).
const EDGE_ROLES = ["edge", "school-node", "teacher", "student", "admin", "district", "state"];
async function edgeDevicesCard() {
  const r = await safe(api.get("/api/edge/devices"));
  if (!r) return null;
  const list = r.data.devices || [];
  const district = ["superintendent", "it_admin"].includes(state.me.role);
  const schools = district ? ((await safe(api.get("/api/schools")))?.data || []).filter(x => x.status !== "inactive") : [];
  const name = h("input", { id: "edge-name", maxlength: 80, required: true, placeholder: "e.g. Maple edge 01" });
  const role = h("select", { id: "edge-role" }, EDGE_ROLES.map(x => h("option", { value: x }, x)));
  const school = district ? h("select", { id: "edge-school" }, h("option", { value: "" }, "District-level (no school)"), schools.map(x => h("option", { value: x.id }, x.name))) : null;
  const tokenOut = h("div", { "aria-live": "polite" });
  const line = (d) => {
    const rp = d.last_report || {}, m = rp.metrics || {}, o = rp.os || {};
    const bits = [d.school_name || "District", d.device_role, d.update_cohort === "canary" ? "canary (gets approved updates first)" : null, d.last_seen_at ? `seen ${ago(d.last_seen_at)}` : "never reported",
      m.cpu_percent != null ? `CPU ${m.cpu_percent}%` : null, m.root_disk_used_percent != null ? `disk ${m.root_disk_used_percent}%` : null,
      o.booted_version ? `OS ${o.booted_version}` : null, o.updates === "held" ? `updates held${o.hold_reason ? `: ${o.hold_reason}` : ""}` : null,
      o.last_verify === "rolled_back" ? `rolled back${o.rollback_from_version ? ` from ${o.rollback_from_version}` : ""}` : null,
      o.approval === "installing" ? `installing ${o.target_version}` : o.approval === "waiting" && o.target_version ? `${o.target_version} approved, waiting for window` : null,
      o.approval === "unreachable" ? "can't reach EduOS for approvals" : null].filter(Boolean).join(" · ");
    const [cls, txt] = d.revoked_at ? ["not_started", "Revoked"] : d.stale ? ["absent", d.last_seen_at ? "Stale" : "Waiting"] : o.updates === "held" ? ["expected", "Updates held"] : ["present", "Reporting"];
    return h("li", { class: "row wrap" }, h("span", { class: "grow" }, h("b", {}, d.name), h("br"), h("span", { class: "muted small" }, bits)), chip(cls, txt),
      district && !d.revoked_at ? h("button", { class: "btn small", type: "button", "aria-label": `${d.update_cohort === "canary" ? "Remove" : "Make"} ${d.name} ${d.update_cohort === "canary" ? "from canaries" : "a canary"}`, onclick: async () => {
        try { await api.post(`/api/edge/updates/devices/${d.id}/cohort`, { cohort: d.update_cohort === "canary" ? "standard" : "canary" }); toast("Updated"); go(state.tab, { push: false }); } catch { toast("Couldn't change it."); } } },
        d.update_cohort === "canary" ? "Not a canary" : "Make canary") : null,
      d.revoked_at ? null : h("button", { class: "btn small", type: "button", "aria-label": `Revoke ${d.name}`, onclick: async () => {
        if (!(await ask({ title: `Revoke ${d.name}?`, text: "Its token stops working at once. Register it again to get a new token.", confirm: "Revoke", danger: true }))) return;
        try { await api.post(`/api/edge/devices/${d.id}/revoke`, {}); toast("Revoked"); go(state.tab, { push: false }); } catch { toast("Couldn't revoke."); } } }, "Revoke"));
  };
  return h("section", { class: "card", "aria-label": "Edge devices" }, h("h2", {}, "Edge devices"),
    h("p", { class: "muted small" }, `Health reports from EduOS edge devices: metrics, compliance and OS update state only, never student data. A device is stale after ${r.data.staleAfterMinutes} minutes without a report.`),
    list.length ? h("ul", { class: "list" }, list.map(line)) : empty("No edge devices registered yet."),
    h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault();
      try {
        const t = (await api.post("/api/edge/devices", { name: name.value, deviceRole: role.value, ...(school && school.value ? { schoolId: school.value } : {}) })).data;
        tokenOut.replaceChildren(h("p", { class: "notice" }, `Device token for ${t.name}, shown once. Put it in /etc/eduos/health-token on the device (mode 0400): `, h("code", { class: "token" }, t.token)));
        name.value = "";
      } catch { toast("Couldn't register the device."); } } },
      h("h3", {}, "Register a device"), h("label", { for: name.id }, "Name"), name, h("label", { for: role.id }, "Device role"), role,
      school ? [h("label", { for: school.id }, "School"), school] : null, h("button", { class: "btn", type: "submit" }, "Register and show token")),
    tokenOut);
}
// District-approved OS updates (db/039): approve a version for canaries,
// promote it once the canary gate passes, withdraw it.
async function osUpdatesCard() {
  const r = await safe(api.get("/api/edge/updates"));
  if (!r?.data?.policy) return null;
  const { policy, releases = [], fleet = [], canApprove } = r.data;
  const reload = () => go(state.tab, { push: false });
  const STAGE = { canary: ["expected", "Canary"], promoted: ["present", "Promoted"], withdrawn: ["not_started", "Withdrawn"] };
  const act = async (fn, ok, fail) => { try { await fn(); toast(ok); reload(); } catch (e) { toast(e?.body?.gate?.blockers?.length ? `Not yet: ${e.body.gate.blockers.join("; ")}` : fail); } };
  const release = (x) => {
    const g = x.gate;
    const bits = [`approved by ${x.approved_by_name || "—"} ${ago(x.approved_at)}`,
      x.promoted_at ? `promoted by ${x.promoted_by_name || "—"} ${ago(x.promoted_at)}` : null,
      x.withdrawn_at ? `withdrawn ${ago(x.withdrawn_at)}: ${x.withdraw_reason}` : null,
      g ? (g.ready ? `Canary gate passed: ${g.soaked} of ${g.required} canaries healthy for ${g.soakHours} h` : `Waiting: ${g.blockers.join("; ")}`) : null].filter(Boolean).join(" · ");
    const [cls, txt] = STAGE[x.stage] || ["expected", x.stage];
    return h("li", { class: "row wrap" }, h("span", { class: "grow" }, h("b", {}, x.version), h("br"), h("span", { class: "muted small" }, bits)), chip(cls, txt),
      canApprove && x.stage === "canary" ? h("button", { class: "btn small primary", type: "button", disabled: !g?.ready, "aria-label": `Promote ${x.version} to all devices`,
        onclick: () => act(() => api.post(`/api/edge/updates/releases/${x.id}/promote`, {}), "Promoted to all devices", "Couldn't promote.") }, "Promote") : null,
      canApprove && x.stage !== "withdrawn" ? h("button", { class: "btn small", type: "button", "aria-label": `Withdraw ${x.version}`, onclick: async () => {
        const reason = await ask({ title: `Withdraw ${x.version}?`, text: "Devices go back to the newest version still approved for them.", label: "Reason", confirm: "Withdraw", danger: true, maxlength: 300 });
        if (reason) act(() => api.post(`/api/edge/updates/releases/${x.id}/withdraw`, { reason }), "Withdrawn", "Couldn't withdraw.");
      } }, "Withdraw") : null);
  };
  const out = [h("h2", {}, "OS updates"),
    h("p", { class: "muted small" }, policy.require_approval
      ? `Devices with district sign-off install only versions approved here, canaries first. A version reaches every device once ${policy.min_canaries} canar${policy.min_canaries === 1 ? "y has" : "ies have"} run it healthy for ${policy.soak_hours} h and none rolled back from it.`
      : "Approval is off: devices follow Fedora CoreOS updates in their maintenance windows."),
    fleet.length ? h("ul", { class: "list" }, fleet.map(f => kv(`${f.version} (${f.cohort})`, `${f.devices} device${f.devices === 1 ? "" : "s"}`))) : null,
    releases.length ? h("ul", { class: "list" }, releases.map(release)) : empty("No versions approved yet.")];
  if (canApprove) {
    const version = h("input", { id: "osu-version", required: true, maxlength: 40, pattern: "\\d{2,3}\\.\\d{8}\\.\\d+\\.\\d+", placeholder: "e.g. 45.20261110.3.0" });
    out.push(h("form", { class: "stack", onsubmit: (e) => { e.preventDefault();
        act(() => api.post("/api/edge/updates/releases", { version: version.value.trim() }), "Approved for canary devices", "Couldn't approve that version."); } },
      h("h3", {}, "Approve a version for canaries"), h("label", { for: version.id }, "Fedora CoreOS version"), version,
      h("button", { class: "btn", type: "submit" }, "Approve for canaries")));
    const req = h("input", { id: "osu-require", type: "checkbox", class: "check" }); req.checked = policy.require_approval;
    const minC = h("input", { id: "osu-min", type: "number", min: 1, max: 100, required: true, value: String(policy.min_canaries) });
    const soak = h("input", { id: "osu-soak", type: "number", min: 0, max: 720, required: true, value: String(policy.soak_hours) });
    out.push(h("form", { class: "stack", onsubmit: (e) => { e.preventDefault();
        act(() => api.put("/api/edge/updates/policy", { requireApproval: req.checked, minCanaries: Number(minC.value), soakHours: Number(soak.value) }), "Update policy saved", "Couldn't save the policy."); } },
      h("h3", {}, "Policy"), h("div", { class: "row" }, req, h("label", { for: req.id, class: "grow" }, "Require district approval for OS updates")),
      h("label", { for: minC.id }, "Healthy canaries needed to promote"), minC, h("label", { for: soak.id }, "Hours they must run it first"), soak,
      h("button", { class: "btn", type: "submit" }, "Save policy")));
  }
  return h("section", { class: "card", "aria-label": "OS updates" }, out);
}
VIEWS.nodes = async () => [...[await edenNodesView()].flat(), await edgeDevicesCard(), await osUpdatesCard()];
VIEWS.node = async () => {
  const s = (await safe(api.get("/api/node/status")))?.data;
  if (!s) return [h("h2", {}, "School node"), empty("This server isn't a school node.")];
  const eg = (await safe(api.get("/api/node/egress")))?.data || [];
  const up = s.uplink.state;
  const out = [h("h2", {}, "School node"),
    h("section", { class: `card hero${up === "offline" ? " alertcard" : ""}`, "aria-label": "Uplink" }, h("p", { class: "muted small" }, `${s.school?.name || ""} · EduOS ${s.version} · ${s.arch}`),
      h("h2", {}, up === "online" ? "Connected to the district" : up === "offline" ? "District link is down" : NODE_STATE[up]?.[1] || "Not set up"),
      h("p", { class: "muted" }, up === "offline" ? `Working locally. Attendance, bus check-ins, roll call, pick-up and gradebook all keep working here. ${s.outbox.pending} update${s.outbox.pending === 1 ? "" : "s"} for the district waiting.`
        : up === "online" ? `Last synced ${s.uplink.lastOkAt ? ago(s.uplink.lastOkAt) : "—"}.` : s.reason || ""),
      s.enabled ? h("button", { class: "btn", type: "button", onclick: async () => { try { const r = (await api.post("/api/node/sync-now", {})).data; toast(r.uplink === "online" ? "Synced" : "District still unreachable"); } catch { toast("Couldn't sync."); } go("node", { push: false }); } }, icon("check"), "Sync now") : null)];
  out.push(h("section", { class: "card", "aria-label": "Sync status" }, h("h2", {}, "Sync"), h("ul", { class: "list" },
    kv("Waiting to send", String(s.outbox.pending)), kv("Oldest waiting", s.outbox.oldest ? ago(s.outbox.oldest) : "—"), kv("Sent", String(s.outbox.sent)),
    kv("Failed attempts in a row", String(s.uplink.consecutiveFailures)), kv("District hub", s.uplink.hub), kv("Partner school", s.partner?.name || "none"),
    kv("Continuity package", s.continuitySentAt ? `sealed for partner ${ago(s.continuitySentAt)}` : "not sent"),
    ...s.bundles.map(b => kv(`Update: ${b.kind}`, `v${b.version} · verified ${ago(b.verified_at)}`)))));
  if (s.hosting.length) out.push(h("section", { class: "card alertcard", "aria-label": "Covering for another school" }, h("h2", {}, "Covering for another school"), h("ul", { class: "list" }, s.hosting.map(x => h("li", { class: "row wrap" },
    h("span", { class: "grow" }, h("b", {}, x.school_name), h("br"), h("span", { class: "muted small" }, x.status === "active" ? `Until ${fmtTime(x.expires_at)} · ${x.restored_counts?.students ?? 0} students, ${staffOf(x.restored_counts)} staff` : `Handed back and deleted ${x.purged_at ? ago(x.purged_at) : ""}`)),
    chip(x.status === "active" ? "absent" : "present", x.status === "active" ? "Hosting" : "Purged"))))));
  out.push(h("section", { class: "card", "aria-label": "Egress log" }, h("h2", {}, "What left this school"), h("p", { class: "muted small" }, `Last 24 h: ${s.egress24h.sent || 0} sent, ${s.egress24h.blocked || 0} blocked. Only gate-checked counts and sealed continuity packages can leave.`),
    eg.length ? h("ul", { class: "list" }, eg.slice(0, 10).map(e => h("li", { class: "row" }, h("span", { class: "grow" }, `${e.kind} · ${e.destination}`, h("br"), h("span", { class: "muted small" }, `${ago(e.at)}${e.cells != null ? ` · ${e.cells} cells, ${e.cells_suppressed} hidden` : ""}${e.reason ? ` · ${e.reason}` : ""}`)),
      chip(e.decision === "sent" ? "present" : e.decision === "blocked" ? "absent" : "expected", e.decision)))) : empty("Nothing has left this school.")));
  out.push(h("section", { class: "card", "aria-label": "Device" }, h("h2", {}, "This device"), h("ul", { class: "list" }, kv("Memory used by EduOS", `${s.resources.rssMb} MB of ${s.resources.limitMb || s.resources.totalMemMb} MB${s.resources.limitMb ? " (container limit)" : ""}`), kv("Load", String(s.resources.loadAvg1)),
    kv("Record transfers (consent)", s.consentExceptions === "on" ? "on" : "off (default)"))));
  return out;
};
// District data links (src/integrations/): OneRoster 1.2, Ed-Fi and PowerSchool connectors.
// Read-only, off until the server has INTEGRATIONS_KEY, and each connector
// needs a second district lead's approval before it can sync.
const CONNECTOR_KIND = { oneroster: "OneRoster 1.2", edfi: "Ed-Fi API", powerschool: "PowerSchool SIS", canvas: "Canvas LMS API" };
const CONNECTOR_STATUS = { pending_approval: ["expected", "Needs approval"], active: ["present", "Active"], disabled: ["not_started", "Off"] };
const ROSTER_TEACHER_TEXT = { no_matching_eduos_teacher: "No EduOS teacher at that school has this email", ambiguous_email: "More than one EduOS teacher has this email",
  no_email: "Their SIS record has no email", not_in_staff_list: "Not in their staff list", matched_teacher_not_at_school: "The matched teacher doesn't teach at that school" };
const REJECT_TEXT = { no_sis_user_id: "Canvas student without a SIS ID", no_matching_eduos_student: "No EduOS student with that SIS ID", student_not_imported: "a student in a class isn't in EduOS", student_at_another_eduos_school: "a student in a class is at another EduOS school", duplicate_student_number: "same student number twice", enrolled_at_another_eduos_school: "already at another school in EduOS",
  no_school: "no school", missing_name: "no name", missing_sourcedId: "no id", missing_studentUniqueId: "no id", invalid_school_id: "invalid school id", missing_student_id: "no student id", missing_student_number: "no student number", missing_enrollment_status: "enrollment status unavailable" };
// FED-05: signed policy bundles from Master Control, kept as received.
// Shown for information; EduOS applies nothing from them yet.
const PB_ERRORS = { not_a_policy_bundle: "That isn't a policy bundle file.", malformed: "The file is damaged or not in the expected format.",
  altered: "The file was changed after Master Control signed it.", wrong_key: "It wasn't signed with the key this server trusts.",
  bad_signature: "The signature doesn't check out.", not_for_this_district: "That bundle is for another district.",
  older_than_received: "A newer bundle has already been received.", policy_key_not_configured: "This server has no Master Control key (MC_POLICY_PUBLIC_KEY)." };
async function masterControlPoliciesCard() {
  const d = (await safe(api.get("/api/district/policy-bundles")))?.data;
  if (!d || !Array.isArray(d.bundles)) return null;
  const file = h("input", { id: "pb-file", type: "file", accept: ".json,application/json" });
  const latest = d.latest;
  return h("section", { class: "card", "aria-label": "Policies from Master Control" }, h("h2", {}, "Policies from Master Control"),
    h("p", { class: "small muted" }, "Signed policy bundles issued for this district. They're kept as received and shown here; nothing is changed in the district's settings."),
    d.configured ? h("p", { class: "small" }, "Trusted signing key fingerprint ", h("code", {}, d.fingerprint), ". Check it matches the one Master Control shows.")
      : h("p", { class: "notice" }, PB_ERRORS.policy_key_not_configured),
    latest ? h("div", {}, h("h3", {}, `Version ${latest.version}${latest.kind === "rollback" ? " (rollback)" : ""}`),
      h("p", { class: "small muted" }, `From ${latest.issuer || "Master Control"} · issued ${fmtDay(latest.issuedAt)} · in effect from ${fmtDay(latest.effectiveFrom)} · received by ${latest.receivedBy}`),
      latest.policies.length ? h("ul", { class: "list small" }, latest.policies.map(p => h("li", { class: "row" }, h("code", { class: "grow" }, p.id),
        h("span", {}, JSON.stringify(p.value)), p.locked_by ? chip("expected", "Locked") : null))) : h("p", { class: "small muted" }, "No policies in this version.")) : h("p", { class: "muted" }, "No bundles received yet."),
    d.bundles.length > 1 ? h("p", { class: "small muted" }, `Earlier versions received: ${d.bundles.slice(1).map(b => b.version).join(", ")}`) : null,
    d.configured && state.me.role === "superintendent" ? h("form", { class: "row wrap", onsubmit: async e => { e.preventDefault();
        const f = file.files?.[0]; if (!f) return toast("Choose the file first.");
        let pkg; try { pkg = JSON.parse(await f.text()); } catch { return toast(PB_ERRORS.not_a_policy_bundle); }
        try { const r = (await api.post("/api/district/policy-bundles", pkg)).data; toast(r.existing ? "Already received." : r.gap ? "Received. Some earlier versions weren't uploaded here." : "Signature checked and received."); go(state.tab, { push: false }); }
        catch (err) { toast(PB_ERRORS[err.body?.error] || "Couldn't read that file."); } } },
      h("div", { class: "grow" }, h("label", { for: "pb-file" }, "Bundle file from Master Control"), file), h("button", { class: "btn", type: "submit" }, "Check and keep")) : null);
}
VIEWS.integrations = async () => {
  const r = await api.get("/api/integrations/connectors");
  const { enabled, connectors = [], schools = [], teachers = [] } = r.data;
  const reload = () => go(state.tab, { push: false });
  const out = [h("h2", {}, "Data links"),
    h("p", { class: "muted" }, "Connect approved SIS and Canvas services. Canvas LMS launch from the app catalog remains separate; this optional Canvas API connection stores a district administrator grant. Course, enrollment and grade sync are not enabled yet."),
    staffDistrict() ? h("section", { class: "card", "aria-label": "Payment options" }, h("h2", {}, "Payment options"),
      h("p", { class: "small muted" }, "Connect the district's PayPal, Square or BTCPay Server account for ticket and marketplace payments."),
      h("button", { class: "btn", type: "button", onclick: () => go("payments") }, "Open payment setup")) : null,
    ["superintendent", "it_admin"].includes(state.me.role) ? await masterControlPoliciesCard() : null];
  if (!enabled) return [...out, h("p", { class: "notice" }, "Data links are off on this server. District IT turns them on by setting INTEGRATIONS_KEY.")];
  const results = new Map(); // connector id -> last preview/apply result (this page view)
  const resultCard = (c, res) => {
    const k = res.counts, map = new Map((res.externalSchools || []).map(x => [x.externalId, x]));
    const selects = [...map.values()].map(x => {
      const sel = h("select", { id: `map-${c.id}-${x.externalId}`, "data-external": x.externalId },
        h("option", { value: "" }, "Don't import"), schools.map(sc => h("option", { value: sc.id }, sc.name)));
      sel.value = x.schoolId || x.suggestedSchoolId || "";
      return [h("label", { for: sel.id }, `${x.name}${x.unmappedStudents ? ` · ${x.unmappedStudents} waiting` : ""}${!x.schoolId && x.suggestedSchoolId ? " · suggested" : ""}`), sel];
    });
    const reasons = {};
    for (const x of res.rejected || []) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
    return h("div", { class: "stack" },
      // CANVAS-API-02: Canvas runs change rosters only, never students.
      c.kind === "canvas"
        ? h("p", { class: "notice" }, res.mode === "apply" ? "Canvas class rosters updated. No students were created or changed."
          : "Preview of Canvas class rosters. Nothing has changed yet, in EduOS or in Canvas.")
        : h("p", { class: "notice" }, res.mode === "apply"
        ? `Imported ${Object.values(k.imported || {}).reduce((a, b) => a + b, 0)} students.`
        : `Preview: ${k.toImport} students would be added or updated. Nothing has changed yet.`),
      h("ul", { class: "list" }, c.kind === "canvas" ? kv("Canvas students with a SIS ID", String(k.canvasStudents))
          : [kv("Students found", String(k.studentsFetched)), kv("At schools not linked yet", String(k.notMapped))],
        Object.entries(reasons).map(([r, n]) => kv(`Skipped: ${REJECT_TEXT[r] || r}`, String(n)))),
      k.rosters ? h("section", { class: "stack", "aria-label": "Class rosters" }, h("h3", {}, "Class rosters"),
        h("ul", { class: "list" }, kv("Classes found", String(k.rosters.sectionsFetched)), kv("Teacher–student links", String(k.rosters.rosterLinks)),
          kv(res.mode === "apply" ? "Added" : "Would be added", String(k.rosters.toAdd)), kv(res.mode === "apply" ? "Removed" : "Would be removed", String(k.rosters.toRemove)),
          kv("Already on a roster entered by hand (left as is)", String(k.rosters.keptManual)), kv("Teachers not matched", String(k.rosters.teachersUnmatched))),
        (res.unmatchedTeachers || []).length ? h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault();
          const mappings = [...e.target.querySelectorAll("select[data-staff]")].filter(x => x.value).map(x => ({ externalId: x.dataset.staff, userId: x.value }));
          if (!mappings.length) return toast("Choose a teacher for at least one.");
          try { await api.req("PUT", `/api/integrations/connectors/${c.id}/staff-map`, { mappings }); toast("Teacher matches saved. Another district lead needs to approve them before the next sync."); reload(); }
          catch { toast("Couldn't save the teacher matches."); } } },
          h("p", { class: "small muted" }, "These SIS teachers weren't matched, so their classes weren't linked. EduOS never creates accounts from the SIS: add them as teachers first, or match them to an existing teacher."),
          (res.unmatchedTeachers || []).map(t => {
            const sel = h("select", { id: `staff-${c.id}-${t.externalId}`, "data-staff": t.externalId }, h("option", { value: "" }, "Leave unmatched"),
              teachers.map(x => h("option", { value: x.id }, `${x.name}${x.school ? ` (${x.school})` : ""}`)));
            return [h("label", { for: sel.id }, `${t.name || t.externalId}${t.email ? ` · ${t.email}` : ""} · ${ROSTER_TEACHER_TEXT[t.reason] || t.reason}`), sel];
          }), h("button", { class: "btn", type: "submit" }, "Save teacher matches")) : null) : null,
      selects.length ? h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault();
        const mappings = [...e.target.querySelectorAll("select[data-external]")].map(x => ({ externalId: x.dataset.external, schoolId: x.value || null }));
        try { await api.req("PUT", `/api/integrations/connectors/${c.id}/school-map`, { mappings }); toast("School links saved. Another district lead needs to approve them before the next sync."); reload(); }
        catch { toast("Couldn't save the school links."); } } },
        h("h3", {}, "Which EduOS school is each of theirs?"), selects, h("button", { class: "btn", type: "submit" }, "Save school links")) : null);
  };
  const card = (c) => {
    const [cls, txt] = CONNECTOR_STATUS[c.status] || ["expected", c.status];
    const slot = h("div", { "aria-live": "polite" });
    const sync = async (mode) => {
      if (mode === "apply" && !(await ask({ title: `Import from ${c.name}?`, text: "Students at linked schools are added or updated in EduOS. Students already at another school aren't moved.", confirm: "Import" }))) return;
      slot.replaceChildren(h("p", { class: "muted" }, mode === "apply" ? "Importing…" : "Reading their roster…"));
      try { const res = (await api.post(`/api/integrations/connectors/${c.id}/sync`, { mode })).data; results.set(c.id, res); slot.replaceChildren(resultCard(c, res)); }
      catch (e) { slot.replaceChildren(h("p", { class: "notice", role: "alert" }, ({ connector_auth_failed: "They refused the client ID or secret.", connector_unreachable: "Couldn't reach their server.",
        connector_timeout: "Their server took too long.", connector_url_not_allowed: "That address isn't allowed (EduOS only connects to public HTTPS servers).", sync_not_applied: "Nothing was imported: " + (e.body?.detail || ""),
        connector_secret_unreadable: "The saved secret can't be read on this server any more. Enter it again." })[e.body?.error] || "The sync didn't work. Check its history." )); }
    };
    const act = async (path, ok, fail, body = {}) => { try { await api.post(`/api/integrations/connectors/${c.id}/${path}`, body); toast(ok); reload(); } catch (e) { toast(e.body?.error === "approver_must_differ" ? "Someone else has to approve it: you set it up last." : fail); } };
    return h("li", { class: "stack" },
      h("div", { class: "row wrap" }, h("span", { class: "grow" }, h("b", {}, c.name), h("br"),
        h("span", { class: "muted small" }, [CONNECTOR_KIND[c.kind], (() => { try { return new URL(c.baseUrl).host; } catch { return ""; } })(), `set up by ${c.updatedBy}`, c.approvedBy ? `approved by ${c.approvedBy}` : null,
          c.dataScope?.includes("class_rosters") ? "students and class rosters" : "students only",
          c.lastSyncAt ? `last ${c.lastSyncStatus} ${ago(c.lastSyncAt)}` : "never synced"].filter(Boolean).join(" · "))), chip(cls, txt)),
      h("div", { class: "row wrap" },
        c.status !== "active" && c.canApprove ? h("button", { class: "btn small primary", type: "button", onclick: () => act("approve", "Approved", "Couldn't approve.") }, "Approve") : null,
        c.status !== "active" && !c.canApprove ? h("span", { class: "muted small" }, "Waiting for another district lead to approve.") : null,
        c.status === "active" && c.kind !== "canvas" ? [h("button", { class: "btn small", type: "button", onclick: () => sync("preview") }, "Preview"),
          h("button", { class: "btn small primary", type: "button", onclick: () => sync("apply") }, "Import")] : null,
        c.status === "active" && c.kind === "canvas" ? h("button", { class: "btn small primary", type: "button", onclick: async () => {
          try { const r = await api.post(`/api/integrations/connectors/${c.id}/canvas/authorize`, {}); window.location.assign(r.data.authorizationUrl); }
          catch { toast("Couldn't start Canvas authorization."); }
        } }, "Connect Canvas") : null,
        c.kind === "canvas" && c.status === "active" ? h("button", { class: "btn small", type: "button", onclick: async () => {
          try { await api.post(`/api/integrations/connectors/${c.id}/canvas/refresh`, {}); toast("Canvas connection is healthy."); }
          catch (e) { toast(e.body?.error === "canvas_authorization_required" ? "Reconnect Canvas to continue." : "Canvas connection refresh failed."); }
        } }, "Check connection") : null,
        c.kind === "canvas" && c.status === "active" ? h("button", { class: "btn small", type: "button", onclick: async () => {
          try { const s = (await api.get(`/api/integrations/connectors/${c.id}/canvas/status`)).data;
            if (!s.connected) { toast("Canvas isn't connected yet."); return; }
            if (!(await ask({ title: "Disconnect Canvas?", text: "EduOS will revoke the current Canvas token, delete stored tokens, and require a second district lead to approve before reconnecting. Disable the developer key in Canvas for full application revocation.", confirm: "Disconnect" }))) return;
            const result = await api.post(`/api/integrations/connectors/${c.id}/canvas/disconnect`, {}); toast(result.data.canvasTokenRevoked ? "Canvas disconnected. A second district lead must approve before reconnecting." : "Local tokens deleted. Canvas token revocation could not be confirmed; disable the developer key in Canvas."); reload();
          } catch { toast("Couldn't disconnect Canvas."); }
        } }, "Disconnect Canvas") : null,
        h("button", { class: "btn small", type: "button", onclick: async () => {
          const secret = await ask({ title: `New client secret for ${c.name}`, text: "It's stored encrypted. The connector then needs approval again.", label: "Client secret", confirm: "Save", maxlength: 2000 });
          if (secret) try { const result = await api.req("PATCH", `/api/integrations/connectors/${c.id}`, { clientSecret: secret }); toast(c.kind === "canvas" && result.data.canvasTokenRevoked === false ? "Saved; token revocation could not be confirmed. Disable the developer key in Canvas." : "Saved. It needs approval again."); reload(); } catch { toast("Could not save."); } } }, "Change secret"),
        c.kind === "canvas" ? h("button", { class: "btn small", type: "button", onclick: async () => {
          const value = await ask({ title: `Read-only Canvas scopes for ${c.name}`, text: "Use space-separated url:GET|/api/v1/... endpoint scopes. Changes revoke the old token and require approval.", label: "Scopes", confirm: "Save", maxlength: 1000 });
          if (value) try { const result = await api.req("PATCH", `/api/integrations/connectors/${c.id}`, { scope: value });
            toast(result.data.canvasTokenRevoked === false ? "Scopes saved; revoke the developer key in Canvas because token revocation could not be confirmed." : "Scopes saved. A second district lead must approve again."); reload();
          } catch { toast("Could not save Canvas scopes."); }
        } }, "Change scopes") : null,
        h("button", { class: "btn small", type: "button", onclick: async () => {
          const on = c.dataScope?.includes("class_rosters");
          if (!await ask({ title: on ? "Stop importing class rosters?" : "Also import class rosters?", text: on
            ? "Rosters it already created stay until you remove them. It needs approval again."
            : "Teachers, classes and enrollments become teacher rosters, which decide which students each teacher can see. Teachers are matched to existing EduOS teachers by email; no accounts are created. It needs approval again.", confirm: on ? "Stop" : "Turn on" })) return;
          try { await api.req("PATCH", `/api/integrations/connectors/${c.id}`, { classRosters: !on }); toast("Saved. It needs approval again."); reload(); } catch { toast("Couldn't save."); } } },
          c.dataScope?.includes("class_rosters") ? "Stop class rosters" : "Add class rosters"),
        c.status !== "disabled" ? h("button", { class: "btn small", type: "button", onclick: async () => {
          try { const result = await api.post(`/api/integrations/connectors/${c.id}/disable`, {});
            toast(c.kind === "canvas" && result.data.canvasTokenRevoked === false ? "Turned off locally; disable the Canvas developer key to revoke access." : "Turned off.");
            reload();
          } catch { toast("Could not turn it off."); }
        } }, "Turn off") : null),
      slot);
  };
  out.push(h("section", { class: "card", "aria-label": "Connectors" }, h("h2", {}, "Connectors"),
    connectors.length ? h("ul", { class: "list" }, connectors.map(card)) : empty("No data links yet.")));
  const kind = h("select", { id: "dl-kind" }, Object.entries(CONNECTOR_KIND).map(([v, t]) => h("option", { value: v }, t)));
  const field = (id, label, attrs = {}) => ({ label: h("label", { for: id }, label), el: h("input", { id, required: true, ...attrs }) });
  const name = field("dl-name", "Name", { maxlength: 80, placeholder: "e.g. District SIS" });
  const base = field("dl-base", "Base URL", { type: "url", maxlength: 2048 });
  const token = field("dl-token", "Token URL", { type: "url", maxlength: 2048 });
  const cid = field("dl-client", "Client ID", { maxlength: 300, autocomplete: "off" });
  const secret = field("dl-secret", "Client secret", { type: "password", maxlength: 2000, autocomplete: "new-password" });
  const scope = field("dl-scope", "OAuth scopes (space-separated; required for Canvas)", { maxlength: 1000, required: false, placeholder: "url:GET|/api/v1/courses" });
  const hint = h("p", { class: "muted small" });
  const rostersBox = h("input", { id: "dl-rosters", type: "checkbox" });
  const setHint = () => {
    base.el.placeholder = kind.value === "canvas" ? "https://district.instructure.com" : kind.value === "edfi" ? "https://edfi.district.org/api/data" : kind.value === "powerschool" ? "https://district.powerschool.com" : "https://sis.district.org/ims/oneroster/rostering/v1p2";
    token.el.placeholder = kind.value === "canvas" ? "https://district.instructure.com/login/oauth2/token" : kind.value === "edfi" ? "https://edfi.district.org/oauth/token" : kind.value === "powerschool" ? "https://district.powerschool.com/oauth/access_token/" : "https://sis.district.org/oauth/token";
    scope.el.placeholder = kind.value === "canvas" ? "url:GET|/api/v1/accounts url:GET|/api/v1/accounts/:account_id/sub_accounts url:GET|/api/v1/accounts/:account_id/courses url:GET|/api/v1/courses/:course_id/enrollments" : "Optional vendor-specific scope";
    hint.textContent = kind.value === "canvas" ? "Enter the Canvas tenant origin only and its matching /login/oauth2/token URL. Use the institution-issued Canvas developer key ID and secret. Required read-only scopes: url:GET|/api/v1/accounts, url:GET|/api/v1/accounts/:account_id/sub_accounts, url:GET|/api/v1/accounts/:account_id/courses, and url:GET|/api/v1/courses/:course_id/enrollments. Configure the developer key to enforce these scopes. A second district lead must approve the connector before an administrator can authorize it. After approval and OAuth consent, preview the school mapping and roster changes before applying; Canvas never creates or changes students." : kind.value === "edfi" ? "Ed-Fi API v8: base URL ends in /api/data (ODS/API: /api/data/v3). Token URL: /connect/token on the Configuration Service, or /oauth/token on the API." : kind.value === "powerschool" ? "Use the district SIS origin and the OAuth token URL for its installed API plugin. EduOS reads district schools and each school’s students only; verify the plugin’s GET permissions and response contract with the district before enabling." : "Your SIS gives you the OneRoster base URL, token URL and a read-only client ID and secret.";
    rostersText.textContent = kind.value === "canvas"
      ? "Read Canvas courses and enrollments into teacher rosters (read-only; students are matched by SIS ID, teachers by email; nobody is created)."
      : "Also import class rosters (teachers, classes and enrollments). Teachers are matched to existing EduOS teachers; no accounts are created.";
  };
  const rostersText = h("span", {});
  const rostersRow = h("label", { for: rostersBox.id, class: "row" }, rostersBox, rostersText);
  kind.addEventListener("change", setHint); setHint();
  out.push(h("section", { class: "card", "aria-label": "Add a data link" }, h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault();
      try { await api.post("/api/integrations/connectors", { kind: kind.value, name: name.el.value, baseUrl: base.el.value, tokenUrl: token.el.value, clientId: cid.el.value, clientSecret: secret.el.value, scope: scope.el.value || null,
        classRosters: rostersBox.checked });
        toast("Added. Another district lead needs to approve it."); reload(); }
      catch (e2) { toast(e2.body?.error === "invalid_connector" ? `Check the ${e2.body.field}.` : e2.body?.error === "connector_name_taken" ? "That name is taken." : "Couldn't add it."); } } },
    h("h2", {}, "Add a data link"), h("label", { for: kind.id }, "Type"), kind, hint,
    [name, base, token, cid, secret, scope].map(x => [x.label, x.el]), rostersRow,
    h("button", { class: "btn", type: "submit" }, "Add"))));
  return out;
};
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Today at a glance from the server (counts plus who wasn't present), instead
// of the latest 500 marks of every day filtered here.
VIEWS.attendance = async () => {
  const base = `/api/attendance/day?date=${isoDay(new Date())}`;
  const r = await api.get(base);
  const counts = r.data?.counts || {}, exceptions = [...(r.data?.exceptions || [])];
  // The students who weren't present come a page at a time; every page is
  // fetched, and if one fails what arrived is shown with a notice.
  let incomplete = false;
  for (let next = r.data?.page?.nextOffset; Number.isInteger(next) && next > 0 && next >= exceptions.length;) {
    try {
      const more = await api.get(`${base}&offset=${next}`);
      const page = more.data?.exceptions || [];
      exceptions.push(...page);
      next = page.length ? more.data?.page?.nextOffset : null;
    } catch { incomplete = true; break; }
  }
  const absent = exceptions.filter(e => e.status === "absent"), tardy = exceptions.filter(e => e.status === "tardy");
  const row = (e) => h("li", { class: "row" }, h("span", { class: "grow" }, e.display_name), chip(e.status), e.family_acknowledged_at ? h("span", { class: "small muted" }, "Family acknowledged") : null);
  return [h("h2", {}, "Attendance today"),
    h("div", { class: "stats" }, stat(counts.present || 0, "present"), stat(counts.absent || 0, "absent", true), stat(counts.tardy || 0, "tardy", true)),
    incomplete ? h("p", { class: "notice", role: "status" }, `Showing ${exceptions.length} of ${(counts.absent || 0) + (counts.tardy || 0) + (counts.excused || 0)} students who weren't present; the rest didn't load. Reload to try again.`) : null,
    h("section", { class: "card", "aria-label": "Absent today" }, h("h2", {}, "Absent"), absent.length ? h("ul", { class: "list" }, absent.map(row)) : empty("No absences marked today.")),
    h("section", { class: "card", "aria-label": "Tardy today" }, h("h2", {}, "Tardy"), tardy.length ? h("ul", { class: "list" }, tardy.map(row)) : empty("No tardies marked today.")),
    h("p", { class: "notice" }, "Marks come from teachers' class registers. Follow-ups go in the Operations queue.")];
};
// Specialized school operations consoles (vice principal, counselor, nurse,
// facilities, meal service): routing-only work queues on /api/school-operations.
const OPS_TABS = { guidance: "counseling", healthoffice: "health_office", facilities: "facilities", meals: "meal_service" };
const OPS_TEXT = { counseling: "Counseling", health_office: "Health office", facilities: "Facilities", meal_service: "Meal service" };
const OPS_SENSITIVE = ["counseling", "health_office"];
const OPS_KINDS = {
  facilities: ["repair", "cleaning", "safety_hazard", "setup", "other"],
  meal_service: ["supply", "equipment", "menu", "staffing", "other"],
  counseling: ["check_in_request", "referral_follow_up", "schedule_change", "other"],
  health_office: ["supply", "screening_logistics", "room_coverage", "other"],
};
// Role-specific titles and guidance (from the 36.4 console config).
const OPS_ROLE = {
  vice_principal: ["Vice Principal Operations", "Coordinate school-day exceptions, attendance follow-up, safety coordination and facilities escalations."],
  counselor: ["Guidance Counselor Console", "A routing queue for non-confidential follow-ups. Keep counseling narratives and student clinical details in the district-approved case system."],
  nurse: ["School Nurse Console", "Health-office operational tasks only. Do not enter diagnoses, medications, treatment notes or student-identifying health details here."],
  maintenance: ["Maintenance Console", "Submit and track facility work orders, safety repairs and building service requests."],
  lunch_staff: ["Meal Service Console", "Coordinate meal service tasks, stock issues, equipment problems and daily service operations."],
};
const OPS_STATUS_CHIP = { open: "expected", in_progress: "boarded", completed: "present", cancelled: "not_started" };
const opsWords = (v) => String(v || "").replaceAll("_", " ");
async function specializedOpsView() {
  const tab = state.tab, lead = ["principal", "vice_principal", "superintendent", "it_admin"].includes(state.me.role);
  const domain = OPS_TABS[tab] || null; // null: the vice principal's operations view across every domain
  const [center, list] = await Promise.all([api.get("/api/school-operations/command-center"), domain ? api.get(`/api/school-operations/${domain}`) : Promise.resolve(null)]);
  const summary = center.data.summary || [];
  const sum = (k) => summary.filter(r => !domain || r.domain === domain).reduce((n, r) => n + (k === "active" ? (["open", "in_progress"].includes(r.status) ? r.count : 0) : r[k] || 0), 0);
  const items = domain ? list.data : center.data.work;
  const creatable = domain ? [domain] : ["facilities", "meal_service"];
  const refresh = () => go(tab, { push: false });
  const setStatus = async (it, status) => {
    try { await api.post(`/api/school-operations/${it.domain}/${it.id}/status`, { status }); toast(`Marked ${opsWords(status)}.`); refresh(); }
    catch { toast("Couldn't update that work item."); }
  };
  const escalate = async (it) => {
    try { await api.post(`/api/school-operations/${it.domain}/${it.id}/escalate`, {}); toast("Escalated."); refresh(); }
    catch { toast("Couldn't escalate that work item."); }
  };
  const dom = h("select", { id: "ops-domain" }, creatable.map(d => h("option", { value: d }, OPS_TEXT[d])));
  const kind = h("select", { id: "ops-kind" });
  const fillKinds = () => { kind.replaceChildren(...OPS_KINDS[dom.value].map(k => h("option", { value: k }, opsWords(k)))); details.hidden = detailsLabel.hidden = OPS_SENSITIVE.includes(dom.value); };
  const priority = h("select", { id: "ops-priority" }, ["normal", "low", "high", "urgent"].map(p => h("option", { value: p }, p)));
  const summaryIn = h("input", { id: "ops-summary", type: "text", maxlength: 300, required: true });
  const details = h("textarea", { id: "ops-details", maxlength: 500, rows: 2 });
  const detailsLabel = h("label", { for: "ops-details" }, "Details (optional)");
  dom.addEventListener("change", fillKinds);
  fillKinds();
  const form = h("form", { class: "card stack", "aria-label": "New work item", onsubmit: async (e) => {
    e.preventDefault();
    const d = dom.value;
    try {
      await api.post(`/api/school-operations/${d}`, { kind: kind.value, priority: priority.value, summary: summaryIn.value, ...(OPS_SENSITIVE.includes(d) || !details.value.trim() ? {} : { details: details.value }) });
      toast("Work item added."); refresh();
    } catch (err) { toast(err.body?.error === "kind_and_summary_required" ? "Add a short summary." : "Couldn't add that work item."); }
  } }, h("h2", {}, "New work item"),
    creatable.length > 1 ? [h("label", { for: dom.id }, "Area"), dom] : null,
    h("label", { for: kind.id }, "Kind"), kind, h("label", { for: priority.id }, "Priority"), priority,
    h("label", { for: summaryIn.id }, "Summary"), summaryIn, detailsLabel, details,
    OPS_SENSITIVE.includes(creatable[0]) && creatable.length === 1 ? h("p", { class: "small muted" }, "Routing only. Never enter student names, health details or counseling notes here; use the approved student health or counseling system.") : null,
    h("button", { class: "btn primary", type: "submit" }, "Add work item"));
  const canCreate = creatable.some(d => ({ facilities: ["maintenance", "principal", "vice_principal"], health_office: ["nurse"], counseling: ["counselor"], meal_service: ["lunch_staff", "principal", "vice_principal"] })[d].includes(state.me.role));
  return [
    h("section", { class: "card hero" }, h("p", { class: "small muted" }, "SCHOOL OPERATIONS"), h("h2", {}, OPS_ROLE[state.me.membershipRole || state.me.role]?.[0] || (domain ? OPS_TEXT[domain] : "Operations")),
      h("p", { class: "muted" }, OPS_ROLE[state.me.membershipRole || state.me.role]?.[1] || (domain ? "Your team's work queue." : "Work queues for facilities, meal service, counseling and the health office."))),
    h("div", { class: "stats" }, stat(sum("active"), "open"), stat(sum("urgent"), "urgent", true), stat(sum("overdue"), "overdue", true)),
    canCreate ? form : null,
    h("section", { class: "card", "aria-label": "Work items" }, h("h2", {}, domain ? "Work queue" : "Open work"),
      items.length ? h("ul", { class: "list" }, items.map(it => h("li", {},
        h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, it.summary),
          h("p", { class: "small muted" }, `${domain ? "" : `${OPS_TEXT[it.domain]} · `}${opsWords(it.kind)} · ${it.priority}${it.escalation_level ? ` · escalated ×${it.escalation_level}` : ""} · ${ago(it.created_at)}${it.due_at ? ` · due ${fmtDay(it.due_at)}` : ""}`)),
          chip(OPS_STATUS_CHIP[it.status] || "expected", opsWords(it.status))),
        ["open", "in_progress"].includes(it.status) ? h("div", { class: "btns" },
          it.status === "open" ? h("button", { class: "btn small", type: "button", "aria-label": `Start: ${it.summary}`, onclick: () => setStatus(it, "in_progress") }, "Start") : null,
          h("button", { class: "btn primary small", type: "button", "aria-label": `Complete: ${it.summary}`, onclick: () => setStatus(it, "completed") }, "Complete"),
          h("button", { class: "btn small", type: "button", "aria-label": `Cancel: ${it.summary}`, onclick: () => setStatus(it, "cancelled") }, "Cancel"),
          lead ? h("button", { class: "btn danger small", type: "button", "aria-label": `Escalate: ${it.summary}`, onclick: () => escalate(it) }, "Escalate") : null) : null))) : empty("Nothing in the queue.")),
  ];
}
VIEWS.operations = specializedOpsView;
VIEWS.guidance = specializedOpsView;
VIEWS.healthoffice = specializedOpsView;
VIEWS.facilities = specializedOpsView;
VIEWS.meals = specializedOpsView;
// ----- 37.6.0 Well-being check-ins (opt-in) and crisis support -----
// Learners tell a counselor how they are doing; nothing is scored or ranked.
// Crisis words always show the 988 Lifeline (here and in Christie).
SUBVIEWS.push("checkin", "wbconsent", "wbqueue", "wbsettings");
const WB_MOOD = { great: "Great", good: "Good", okay: "Okay", low: "Low", struggling: "Struggling" };
const WB_NEED = { talk_to_someone: "I'd like to talk to someone", friends: "Friends", schoolwork: "Schoolwork", home: "Home", sleep: "Sleep", food: "Food", safety: "I don't feel safe", other: "Something else" };
function wbCrisisCard(c) {
  return h("section", { class: "card hero", role: "alert", "aria-label": "Crisis support" }, h("h2", {}, c.title),
    ...c.lines.map(l => h("p", {}, l)),
    h("div", { class: "row wrap" }, h("a", { class: "btn primary", href: c.tel }, "Call 988"), h("a", { class: "btn", href: c.sms }, "Text 988")));
}
VIEWS.checkin = async () => {
  const s = (await api.get("/api/wellbeing/status")).data;
  const head = [back("home", "Back"), h("h2", {}, "Check in")];
  if (!s.allowed) return [...head, h("section", { class: "card" }, h("p", {}, "Check-ins aren't turned on for you. Your family can opt you in from their EduOS app."),
    h("p", { class: "small muted" }, "You can always talk to a counselor or any adult you trust at school.")), wbCrisisCard(s.crisis)];
  let mood = null;
  const moods = h("div", { class: "row wrap", role: "radiogroup", "aria-label": "How are you feeling?" }, s.moods.map(m => h("button", { class: "btn", type: "button", role: "radio", "aria-checked": "false",
    onclick: e => { mood = m; moods.querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b === e.currentTarget))); } }, WB_MOOD[m] || m)));
  const needs = s.needs.map(n => h("label", { class: "row" }, h("input", { type: "checkbox", value: n }), " ", WB_NEED[n] || n));
  const note = h("textarea", { id: "wb-note", maxlength: 500, rows: 3 });
  const out = h("div", { "aria-live": "polite" });
  return [...head, h("section", { class: "card" }, h("form", { class: "stack", onsubmit: async e => { e.preventDefault();
      if (!mood) return toast("Pick how you're feeling.");
      try { const r = (await api.post("/api/wellbeing/checkins", { mood, needs: needs.map(l => l.querySelector("input")).filter(i => i.checked).map(i => i.value), note: note.value || null })).data;
        out.replaceChildren(...(r.crisis ? [wbCrisisCard(r.response)] : [h("p", { class: "notice" }, r.message)])); note.value = ""; }
      catch { toast("Couldn't send. You can always talk to a counselor in person."); } } },
    h("p", {}, "How are you feeling today?"), moods, h("p", {}, "Anything on your mind?"), ...needs,
    h("label", { for: "wb-note" }, "Anything you want a counselor to know (optional)"), note,
    h("button", { class: "btn primary", type: "submit" }, "Send to a counselor")), out,
    h("p", { class: "small muted" }, s.privacy)),
    s.recent.length ? h("section", { class: "card" }, h("h2", {}, "Recent"), h("ul", { class: "list" }, s.recent.map(c => kv(`${WB_MOOD[c.mood]} · ${fmtDay(c.at)}`, c.seen ? "A counselor saw it" : "Sent")))) : null];
};
VIEWS.wbconsent = async () => {
  const c = (await api.get("/api/wellbeing/consent")).data;
  const decide = (kid, decision) => h("button", { class: decision === "opted_in" ? "btn primary" : "btn", type: "button", onclick: async () => {
    try { await api.post("/api/wellbeing/consent", { studentId: kid.id, decision, noticeVersion: c.noticeVersion }); toast("Saved"); go("wbconsent", { push: false }); }
    catch (e) { toast(e.body?.error === "notice_changed_please_reread" ? "The notice changed. Please read it again." : "Couldn't save."); } } }, decision === "opted_in" ? "Opt in" : "Opt out");
  return [back("children", "Back"), h("h2", {}, "Well-being check-ins"),
    c.enabled ? null : h("p", { class: "notice" }, "Your district hasn't turned check-ins on. Your choice is saved for when it does."),
    h("section", { class: "card", "aria-label": "Notice" }, h("h2", {}, "Notice to families"), h("p", {}, c.notice), h("p", { class: "small muted" }, `Notice ${c.noticeVersion} · kept ${c.retentionDays} days`)),
    h("section", { class: "card", "aria-label": "Your children" }, h("ul", { class: "list" }, c.children.map(k => h("li", {},
      h("div", { class: "row" }, h("span", { class: "grow" }, k.name), chip(k.active ? "present" : "expected", k.active ? "Opted in" : k.needsNewDecision ? "Notice changed" : k.decision === "opted_out" ? "Opted out" : "Not opted in")),
      h("div", { class: "row wrap" }, decide(k, "opted_in"), decide(k, "opted_out"))))))];
};
VIEWS.wbqueue = async () => {
  const q = (await api.get("/api/wellbeing/queue")).data;
  const act = (c, action, label) => h("button", { class: "btn small", type: "button", onclick: async () => { await api.post(`/api/wellbeing/checkins/${c.id}/actions`, { action }); go("wbqueue", { push: false }); } }, label);
  const item = c => h("li", {}, h("div", { class: "row" }, h("b", { class: "grow" }, `${c.student.name} · grade ${c.student.grade}`), c.crisis ? chip("absent", "Crisis words") : null, chip("expected", c.status)),
    h("p", { class: "small" }, `${WB_MOOD[c.mood]}${c.needs.length ? ` · ${c.needs.map(n => WB_NEED[n] || n).join(", ")}` : ""} · ${ago(c.createdAt)}`),
    c.note ? h("p", {}, c.note) : null,
    h("div", { class: "row wrap" }, act(c, "seen", "Seen"), act(c, "assigned", "I'll take it"), act(c, "met_with_student", "Met"), act(c, "contacted_family", "Called family"), c.status === "closed" ? act(c, "reopened", "Reopen") : act(c, "closed", "Close")));
  return [back("guidance", "Back"), h("h2", {}, "Well-being"),
    ...q.alerts.map(a => h("section", { class: "card hero", role: "alert" }, h("h2", {}, `Crisis words: ${a.student.name}`), h("p", {}, `${a.source === "christie" ? "In a Christie chat" : "In a check-in"} · ${ago(a.at)}. Find the student now.`),
      h("button", { class: "btn primary", type: "button", onclick: async () => { await api.post(`/api/wellbeing/alerts/${a.id}/ack`); toast("Acknowledged"); go("wbqueue", { push: false }); } }, "I'm on it"))),
    h("section", { class: "card" }, h("h2", {}, "Needs a person now"), q.now.length ? h("ul", { class: "list" }, q.now.map(item)) : empty("No one right now.")),
    h("section", { class: "card" }, h("h2", {}, "Today"), q.today.length ? h("ul", { class: "list" }, q.today.map(item)) : empty("Nothing waiting.")),
    h("p", { class: "small muted" }, q.rule)];
};
VIEWS.wbsettings = async () => {
  const s = (await api.get("/api/wellbeing/settings")).data;
  const on = h("input", { id: "wb-on", type: "checkbox", checked: s.enabled });
  const notice = h("textarea", { id: "wb-notice", rows: 8, maxlength: 3000 }, s.notice);
  const days = h("input", { id: "wb-days", type: "number", min: 30, max: 2555, value: String(s.retentionDays) });
  return [back("overview", "Back"), h("h2", {}, "Well-being check-ins"), h("section", { class: "card" }, h("form", { class: "stack", onsubmit: async e => { e.preventDefault();
      try { const r = (await api.req("PUT", "/api/wellbeing/settings", { enabled: on.checked, notice: notice.value, retentionDays: Number(days.value) })).data; toast(`Saved (notice ${r.noticeVersion})`); } catch { toast("Couldn't save."); } } },
    h("label", { class: "row" }, on, " Check-ins on for the district (families still opt each child in)"), h("label", { for: "wb-notice" }, "Notice families read before opting in"), notice,
    h("label", { for: "wb-days" }, "Keep check-ins (days)"), days, h("button", { class: "btn primary", type: "submit" }, "Save")),
    h("p", { class: "small muted" }, "Changing the notice asks every family to opt in again. District staff never see check-ins. Crisis words always show the 988 Lifeline and alert the school's counselors."))];
};
for (const [view, roles, title, text, target] of [["home", ["pupil"], "Check in", "Tell a counselor how you're doing.", "checkin"], ["children", ["parent"], "Well-being check-ins", "Read the notice and choose for each child.", "wbconsent"],
  ["overview", ["superintendent"], "Well-being check-ins", "District switch, notice and retention.", "wbsettings"]]) {
  const base = VIEWS[view];
  VIEWS[view] = async () => [...[await base()].flat(), roles.includes(state.me.role)
    ? h("section", { class: "card", "aria-label": title }, h("h2", {}, title), h("p", { class: "small muted" }, text), h("button", { class: "btn", type: "button", onclick: () => go(target) }, "Open")) : null];
}
{
  const base = VIEWS.guidance;
  VIEWS.guidance = async () => [state.me.role === "counselor" ? h("section", { class: "card", "aria-label": "Well-being" }, h("h2", {}, "Well-being check-ins and alerts"),
    h("p", { class: "small muted" }, "Crisis alerts and check-ins for your school. Urgent items also appear in the counseling queue below."), h("button", { class: "btn primary", type: "button", onclick: () => go("wbqueue") }, "Open well-being")) : null,
    ...[await base()].flat()];
}
VIEWS.library = async () => {
  if (state.me.role === "parent" || state.me.role === "pupil") {
    const endpoint = state.me.role === "parent" ? "/api/library/family-loans" : "/api/library/my-loans";
    const result = await safe(api.get(endpoint));
    const loans = state.me.role === "parent" ? forChild(result?.data || [], "student_id") : result?.data || [];
    return [h("h2", {}, state.me.role === "parent" ? "Family library books" : "My library books"),
      h("p", { class: "muted" }, "View current loans, due dates, returns and overdue items. Renewals are subject to school library rules."),
      loans.length ? h("section", { class: "card" }, h("ul", { class: "list" }, loans.map(l => h("li", { class: "row" }, h("span", { class: "grow" }, h("b", {}, l.title), h("br"), h("span", { class: "muted small" }, `${l.student_name ? `${l.student_name} · ` : ""}Due ${fmtDay(l.due_at)}`)), chip(l.overdue ? "absent" : l.returned_at ? "expected" : "present", l.returned_at ? "Returned" : l.overdue ? "Overdue" : "Checked out"))))) : empty("No library loans to display."),
      h("p", { class: "muted small" }, "For renewals, returns or questions, contact your school library.")];
  }
  const canCirculate = ["principal", "superintendent", "it_admin", "librarian"].includes(state.me.role);
  const [inv, loans, summary] = await Promise.all([
    safe(api.get("/api/library/inventory")), safe(api.get("/api/library/loans")), safe(api.get("/api/library/summary"))
  ]);
  const inventory = inv?.data || [], activeLoans = (loans?.data || []).filter(x => !x.returned_at);
  const out = [h("h2", {}, "Librarian console"), h("p", { class: "muted" }, "Fast desk workflows for USB, Bluetooth and wireless barcode scanners that type like a keyboard. Scan into the focused field; most scanners send Enter automatically."),
    h("section", { class: "card" }, h("h3", {}, "Library snapshot"), h("div", { class: "stats" }, stat(summary?.data?.totals?.titles || 0, "Titles"), stat(summary?.data?.totals?.copies || 0, "Copies"), stat(summary?.data?.totals?.available || 0, "Available"), stat(activeLoans.length, "Checked out")))];
  let scanInput, borrowerInput, dueInput, status;
  const feedback = (msg, good=true) => { if(status){status.textContent=msg;status.className=good?"notice":"notice alertcard";} };
  const refresh = () => go("library",{push:false});
  out.push(h("section", { class: "card" }, h("h3", {}, "Check in a book"), h("p", { class: "muted small" }, "Scan the book barcode. The console finds its active loan and processes the return."),
    scanInput = h("input", { class: "field", type: "text", placeholder: "Scan book barcode…", autocomplete: "off", "aria-label": "Book barcode for check-in" }),
    h("div", { class: "row wrap" }, h("button", { class: "btn", type: "button", onclick: async () => { const code=scanInput.value.trim(); if(!code)return feedback("Scan a barcode first.",false); try { const item=inventory.find(x=>x.barcode===code); if(!item)return feedback("No matching book barcode found in this school's inventory.",false); const loan=activeLoans.find(x=>x.item_id===item.id); if(!loan)return feedback("No active loan found for this book.",false); await api.post(`/api/library/loans/${loan.id}/return`,{disposition:"returned"}); feedback(`Returned: ${item.title}`); scanInput.value=""; refresh(); } catch(e){feedback(e.body?.error||"Return could not be completed.",false);} } }, "Check in"), h("button", { class: "btn secondary", type: "button", onclick:()=>{scanInput.value="";scanInput.focus();}}, "Clear")), status=h("p",{class:"notice","aria-live":"polite"},"Ready for scan.")));
  if (canCirculate) {
    let checkoutBarcode, borrower, due;
    out.push(h("section", { class: "card" }, h("h3", {}, "Check out a book"), h("p", { class: "muted small" }, "Scan the book, then enter the borrower's district account ID. Badge-to-account lookup can be connected to the district SIS barcode mapping."),
      checkoutBarcode=h("input",{id:"library-checkout-barcode",class:"field",type:"text",placeholder:"Scan book barcode…",autocomplete:"off","aria-label":"Book barcode for checkout"}),
      borrower=h("input",{class:"field",type:"text",placeholder:"Scan student ID card or enter account UUID","aria-label":"Borrower account ID"}),
      due=h("input",{class:"field",type:"date","aria-label":"Due date"}),
      h("button",{class:"btn",type:"button",onclick:async()=>{try{const code=checkoutBarcode.value.trim(),item=inventory.find(x=>x.barcode===code);if(!item)return feedback("Book barcode not found.",false);let borrowerUserId=borrower.value.trim();if(!/^[0-9a-f-]{36}$/i.test(borrowerUserId)){const found=await api.post("/api/library/borrower-cards/lookup",{barcode:borrowerUserId});borrowerUserId=found.data?.borrowerUserId;if(!borrowerUserId)return feedback("Student card was not recognized.",false);}const dueAt=new Date(`${due.value||new Date(Date.now()+14*86400000).toISOString().slice(0,10)}T23:59:00`).toISOString();await api.post("/api/library/loans/checkout",{itemId:item.id,borrowerUserId,dueAt});feedback(`Checked out: ${item.title}`);checkoutBarcode.value="";borrower.value="";refresh();}catch(e){feedback(e.body?.error||"Checkout could not be completed.",false);}}},"Check out")));
    due.value=new Date(Date.now()+14*86400000).toISOString().slice(0,10);
  }
  out.push(h("section",{class:"card"},h("h3",{},"Active loans"),activeLoans.length?h("ul",{class:"list"},activeLoans.slice(0,100).map(l=>h("li",{class:"row"},h("span",{class:"grow"},h("b",{},l.title),h("br"),h("span",{class:"muted small"},`${l.barcode||l.isbn||"No barcode"} · Due ${fmtDay(l.due_at)}`)),chip(l.overdue?"absent":"expected",l.overdue?"Overdue":"Checked out")))):empty("No active loans.")));
  out.push(h("section",{class:"card"},h("h3",{},"Scanner compatibility"),h("ul",{class:"list"},h("li",{},"USB wired HID keyboard-wedge scanners"),h("li",{},"Bluetooth HID scanners paired as keyboards"),h("li",{},"Wireless 2.4 GHz USB-dongle scanners"),h("li",{},"Scanners configured to append Enter/Return")),h("p",{class:"muted small"},"No vendor-specific driver or SDK is required for keyboard-wedge mode. Configure scanners to send the barcode followed by Enter; focus the scan field before scanning.")));
  setTimeout(()=>scanInput?.focus(),0);
  return out;
};

// ---- Apps in the app (UI-01) -------------------------------------------------
// Everyone's licensed apps, opened through the same governed launch as the full
// site; leaders also get the decisions waiting for them and grade passback.
async function appsCard({ title = "Your apps", limit = 12 } = {}) {
  const r = await safe(api.get("/api/my/apps"));
  const list = Array.isArray(r?.data) ? r.data : [];
  if (!list.length) return null;
  // UI-02: each school's tile design from its theme (same as the full site's launcher).
  const M = window.EduOSBrandModel, brand = state.brand?.branding;
  const tile = (a, i) => {
    const s = M && brand ? M.tileStyle(brand, `app:${a.id}`, i + 3, { name: a.name, category: a.category }) : null;
    if (s?.hidden) return null;
    const ico = h("span", { class: `apptile-ico ${s ? `shape-${s.shape}` : ""}`, "aria-hidden": "true" });
    if (s) {
      // Glyph paths and colours come from the validated theme model, not from user text.
      ico.innerHTML = s.glyphMode === "color"
        ? `<span class="disc" style="background:${s.disc}">${M.glyphSvg(s.glyph, s.glyphFg, 18)}</span>` : M.glyphSvg(s.glyph, s.glyphFg, 24);
      const m = state.brand?.mascot;
      if (s.badge && m) ico.append(h("img", { class: "badge", src: m["48"] || Object.values(m)[0], alt: "" }));
    } else ico.append(icon("apps"));
    return h("button", { class: `apptile${s ? ` branded shape-${s.shape}` : ""}`, type: "button",
      style: s ? `background:${s.bg};color:${s.label};border-color:${s.border ? "#5a6f86" : "transparent"}` : false,
      onclick: () => openToolTab(`/api/apps/${a.id}/launch`, {}, e => TOOL_ERRORS[e] || "Couldn't open it.") },
      ico, h("span", { class: "name" }, s?.labelText || a.name), a.category ? h("span", { class: "small cat" }, a.category) : null);
  };
  return h("section", { class: "card", "aria-label": title }, h("h2", {}, title),
    h("div", { class: "apptiles" }, list.slice(0, limit).map(tile)),
    list.length > limit ? h("p", { class: "small" }, h("a", { href: "/#tab=apps" }, `All ${list.length} apps`)) : null);
}
for (const view of ["home", "classes", "children"]) {
  const inner = VIEWS[view];
  VIEWS[view] = async () => {
    const [out, card] = await Promise.all([inner(), appsCard()]);
    if (!card) return out;
    const arr = (Array.isArray(out) ? [...out] : [out]).filter(Boolean);
    // UI-03: a pupil sees apps right after "up next"; a teacher's class numbers and
    // action centre come first; a family's children come first.
    const after = Math.max(...["stats", "action-center"].map(c => arr.findIndex(n => n?.classList?.contains(c))));
    const at = view === "home" ? 1 : view === "classes" && after >= 0 ? after + 1 : arr.length;
    arr.splice(Math.min(at, arr.length), 0, card);
    return arr;
  };
}
const LTI_APPROVE_ERRORS = { lti_second_approver_required: "A different district administrator from the one who registered this tool must approve it.",
  lti_configuration_invalid: "This registration is incomplete; fix it on the full site." };
VIEWS.apps = async () => {
  const district = ["superintendent", "it_admin"].includes(state.me.role);
  const [catalog, requests, grades, launcher] = await Promise.all([
    district ? safe(api.get("/api/apps?limit=100")) : null,
    safe(api.get("/api/app-requests?status=pending")),
    state.me.role === "it_admin" ? null : safe(api.get("/api/lti/grade-approvals")),
    appsCard({ title: "Apps you can open", limit: 8 })]);
  const out = [h("h2", {}, "Apps")];
  // Decisions waiting for this person.
  const pendingLti = (Array.isArray(catalog?.data) ? catalog.data : []).filter(a => a.integrationType === "lti13" && a.registrationStatus === "pending");
  const pendingReq = Array.isArray(requests?.data) ? requests.data : [];
  out.push(h("section", { class: "card", "aria-label": "Waiting for you" }, h("h2", {}, "Waiting for you"),
    !pendingLti.length && !pendingReq.length ? empty("Nothing is waiting.") : null,
    pendingLti.length ? h("ul", { class: "list" }, pendingLti.map(a => h("li", { class: "row" },
      h("div", { class: "grow" }, h("h3", {}, a.name), h("p", { class: "small muted" }, `${a.vendor} · LTI tool waiting for district approval`)),
      h("button", { class: "btn small", type: "button", "aria-label": `Approve ${a.name}`, onclick: async () => {
        if (!await ask({ title: `Approve ${a.name}?`, text: "People given access can then open it. Any later change to its settings needs approval again.", confirm: "Approve" })) return;
        try { await api.post(`/api/apps/${a.id}/lti/approve`, {}); toast(`${a.name} approved.`); go("apps", { push: false }); }
        catch (e) { toast(LTI_APPROVE_ERRORS[e.body?.error] || "Couldn't approve it."); } } }, "Approve")))) : null,
    pendingReq.length ? h("p", {}, `${pendingReq.length} app request${pendingReq.length === 1 ? "" : "s"} ${district ? "from schools" : "from your school"} waiting. `,
      h("a", { href: "/#tab=app_requests" }, district ? "Decide on the full site" : "See them on the full site")) : null));
  // Grade passback: district guidelines and oversight; principals approve for their school.
  const g = grades?.data;
  if (g && Array.isArray(g.approvals) && g.policy) {
    const active = g.approvals.filter(x => !x.revokedAt);
    const sec = h("section", { class: "card", "aria-label": "Grade passback" }, h("h2", {}, "Grade passback from tools"));
    if (district) {
      const on = h("input", { type: "checkbox", id: "gp-on", checked: g.policy.enabled }), review = h("input", { type: "checkbox", id: "gp-review", checked: g.policy.teacherReviewRequired });
      sec.append(h("p", { class: "small muted" }, "You set the guidelines. Each school's principal approves tools for their school and is accountable for them; you can turn any approval off."),
        h("form", { class: "stack", onsubmit: async e => { e.preventDefault();
          try { await api.req("PUT", "/api/lti/grade-policy", { enabled: on.checked, teacherReviewRequired: review.checked }); toast("Guidelines saved."); go("apps", { push: false }); }
          catch { toast("Couldn't save."); } } },
          h("label", { for: on.id, class: "row" }, on, h("span", {}, "Allow tools to send grades")),
          h("label", { for: review.id, class: "row" }, review, h("span", {}, "Teachers review each score before it counts")),
          h("button", { class: "btn", type: "submit" }, "Save guidelines")));
    } else sec.append(h("p", { class: "small muted" }, g.policy.enabled
      ? `The district allows grade passback${g.policy.teacherReviewRequired ? "; teachers review each score" : "; scores count without review but never replace a teacher's grade"}. You approve tools for your school.`
      : "The district hasn't turned grade passback on."));
    sec.append(active.length ? h("ul", { class: "list" }, active.map(x => h("li", { class: "row" },
      h("div", { class: "grow" }, h("h3", {}, district ? `${x.appName} · ${x.schoolName}` : x.appName),
        h("p", { class: "small muted" }, `Approved by ${x.approvedBy} · ${x.scores30d} score${x.scores30d === 1 ? "" : "s"} in 30 days`)),
      h("button", { class: "btn small danger", type: "button", "aria-label": `Turn off grade passback for ${x.appName}${district ? ` at ${x.schoolName}` : ""}`, onclick: async () => {
        const reason = await ask({ title: `Turn off grades from ${x.appName}?`, text: "Scores stop at once. The school sees your reason.", label: "Reason", confirm: "Turn off", danger: true, maxlength: 500 });
        if (!reason) return;
        try { await api.req("PUT", "/api/lti/grade-approvals", { appId: x.appId, schoolId: x.schoolId, approved: false, reason }); toast("Turned off."); go("apps", { push: false }); }
        catch { toast("Couldn't turn it off."); } } }, "Turn off")))) : h("p", { class: "small" }, "No tools are approved for grades" + (district ? " at any school." : " at your school.")));
    const open = g.canApprove && g.policy.enabled ? (g.candidates || []).filter(c => !active.some(a => a.appId === c.appId)) : [];
    if (open.length) sec.append(h("div", { class: "btns" }, open.map(c => h("button", { class: "btn", type: "button", onclick: async () => {
      if (!await ask({ title: `Let ${c.appName} send grades at your school?`, text: "You're accountable for this approval. Teachers still turn it on per activity.", confirm: "Approve" })) return;
      try { await api.req("PUT", "/api/lti/grade-approvals", { appId: c.appId, approved: true }); toast("Approved for your school."); go("apps", { push: false }); }
      catch { toast("Couldn't approve it."); } } }, `Approve grades from ${c.appName}`))));
    out.push(sec);
  }
  if (launcher) out.push(launcher);
  if (state.me.role === "it_admin") { const fa = await fundApprovalsCard(); if (fa) out.unshift(fa); }
  out.push(h("section", { class: "card", "aria-label": "Catalog" }, h("h2", {}, "Catalog, licenses and access"),
    h("p", { class: "small muted" }, "Adding apps, licenses, who can use them, and LTI tool details are on the full site."),
    h("a", { class: "btn", href: "/#tab=apps" }, "Open the app catalog")));
  return out;
};

VIEWS.me = async () => {
  await loadProfiles();
  const memberships = state.profiles;
  return [h("h2", {}, "Account"), h("section", { class: "card" }, h("h3", {}, state.me.displayName), h("p", { class: "muted" }, `${roleName()} · ${state.brand?.school?.name || state.brand?.districtName || ""}`)),
    memberships.length > 1 ? h("section", { class: "card", "aria-label": "Switch profile" }, h("h3", {}, "Switch profile"), profileList(switchProfile)) : null,
    LICENSED.includes(state.me.role) ? await licenseCard() : null,
    state.me.role === "teacher" ? h("button", { class: "btn block", type: "button", onclick: () => go("mywork") }, icon("spark"), "My work: take it with you") : null,
    ["principal", "superintendent"].includes(state.me.role) ? h("button", { class: "btn block", type: "button", onclick: () => go("portfolioreview") }, icon("check"), "Teachers' work: rights and transfers") : null,
    ["principal", "vice_principal", "superintendent"].includes(state.me.role) ? h("button", { class: "btn block", type: "button", onclick: () => openView("rankings", { rankSchool: null }) }, icon("grid"), "U.S. News indicators") : null,
    ["counselor", "nurse", "sro"].includes(state.me.role) ? h("button", { class: "btn block", type: "button", onclick: () => go("emergencyrecords") }, icon("shield"), "Emergency access to a student's records") : null,
    h("button", { class: "btn block", type: "button", onclick: () => go("states") }, icon("book"), "State index"),
    ["superintendent", "principal"].includes(state.me.role) ? h("button", { class: "btn block", type: "button", onclick: () => go("licenses") }, icon("people"), "Staff licenses") : null,
    h("a", { class: "btn block", href: "/" }, "Open the full EduOS site"),
    h("button", { class: "btn danger block", type: "button", onclick: async () => { if (OQ.count && !(await ask({ title: "Sign out with unsent changes?", text: `${OQ.count} saved change${OQ.count > 1 ? "s have" : " has"} not been sent yet. Signing out deletes them from this phone.`, confirm: "Sign out and delete", danger: true }))) return;
      await safe(api.post("/auth/logout")); await OQ.clear(); api.csrf = null; renderSignIn(); } }, "Sign out"),
    h("p", { class: "notice" }, "EduOS Mobile keeps school data on the server. This phone stores only the app's design files and your school's colours and logo so it opens quickly, plus, while you're offline, up to 200 encrypted roll call, bus check-in or attendance marks for at most 24 hours. Signing out deletes them.")];
};

// ---- DEV-01: rooms and the classroom device registry ----------------------
const DEVICE_KIND = { display: "Display", student_device: "Student devices", equipment: "Room equipment", kiosk: "Check-in kiosk" };
const DEVICE_CAPS = { display: ["show", "blank", "input", "volume", "power"], student_device: ["lock", "unlock", "open_link", "focus"], equipment: ["power", "volume", "input", "lights"], kiosk: ["checkin"] };
const CAP_TEXT = { checkin: "Check students in with their ID card", show: "Show a teacher's screen", blank: "Blank the screen", input: "Switch input", volume: "Volume", power: "Power on/off", lights: "Lights",
  lock: "Lock", unlock: "Unlock", open_link: "Open a link for the class", focus: "Focus mode (one app or site)" };
const DEV_STATUS = { pending: ["expected", "Waiting for district IT"], approved: ["present", "Approved"], rejected: ["absent", "Not approved"], retired: ["absent", "Retired"] };
VIEWS.devices = async () => {
  const it = state.me.role === "it_admin";
  const filter = state.devFilter || (it ? "pending" : "all");
  const [rooms, devices, schools] = await Promise.all([api.get("/api/rooms").then(r => r.data), api.get(`/api/devices${filter === "pending" ? "?status=pending" : ""}`).then(r => r.data),
    it ? safe(api.get("/api/schools").then(r => r.data), []) : null]);
  const seg = (key, label) => h("button", { class: `btn small${filter === key ? " primary" : ""}`, type: "button", "aria-pressed": String(filter === key), onclick: () => openView("devices", { devFilter: key }) }, label);
  const deviceRow = d => h("li", {},
    h("div", { class: "row wrap" }, h("b", { class: "grow" }, d.name), chip(...DEV_STATUS[d.status])),
    h("p", { class: "small muted" }, [DEVICE_KIND[d.kind], [d.maker, d.model].filter(Boolean).join(" "), d.serial ? `SN ${d.serial}` : "", it ? d.school : "", d.room ? `in ${d.room}` : ""].filter(Boolean).join(" · ")),
    h("p", { class: "small" }, `Can: ${d.capabilities.map(c => CAP_TEXT[c]).join(", ")}`),
    it && d.status === "approved" ? h("p", { class: "small muted" }, d.hasKey ? (d.lastSeenAt ? `Key set · last checked in ${new Date(d.lastSeenAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Key set · not connected yet") : "No device key yet") : null,
    d.note ? h("p", { class: "small muted" }, `District IT: ${d.note}`) : null,
    h("div", { class: "btns" },
      it && d.status === "pending" ? [h("button", { class: "btn small primary", type: "button", "aria-label": `Approve: ${d.name}`, onclick: () => decideDevice(d, "approved") }, "Approve"),
        h("button", { class: "btn small", type: "button", "aria-label": `Don't approve: ${d.name}`, onclick: () => decideDevice(d, "rejected") }, "Don't approve")] : null,
      d.status === "approved" ? h("button", { class: "btn small", type: "button", "aria-label": `${d.room ? "Move" : "Put in a room"}: ${d.name}`, onclick: () => placeDevice(d, rooms) }, d.room ? "Move" : "Put in a room") : null,
      it && d.status === "approved" ? h("button", { class: "btn small", type: "button", "aria-label": `${d.hasKey ? "New device key" : "Device key"}: ${d.name}`, onclick: () => issueDeviceKey(d) }, d.hasKey ? "New device key" : "Device key") : null,
      it && d.hasKey ? h("button", { class: "btn small", type: "button", "aria-label": `Revoke key: ${d.name}`, onclick: async () => {
        if (!(await ask({ title: `Revoke ${d.name}'s key?`, text: "The device stops showing pairing codes until it gets a new key.", confirm: "Revoke" }))) return;
        try { await api.post(`/api/devices/${d.id}/key/revoke`, {}); toast("Revoked."); go("devices", { push: false }); } catch { toast("Couldn't revoke it."); } } }, "Revoke key") : null,
      h("button", { class: "btn small", type: "button", "aria-label": `Edit: ${d.name}`, onclick: () => editDevice(d, schools) }, "Edit"),
      h("button", { class: "btn small", type: "button", "aria-label": `History: ${d.name}`, onclick: () => deviceHistory(d) }, "History"),
      h("button", { class: "btn small", type: "button", "aria-label": `Retire: ${d.name}`, onclick: async () => {
        if (!(await ask({ title: `Retire ${d.name}?`, text: "It leaves its room and can't be controlled. Its history is kept.", confirm: "Retire" }))) return;
        try { await api.post(`/api/devices/${d.id}/retire`, {}); toast("Retired."); go("devices", { push: false }); } catch { toast("Couldn't retire it."); } } }, "Retire")));
  return [h("h2", {}, it ? "Classroom devices" : "Rooms & devices"),
    h("p", { class: "small muted" }, it ? "Schools ask for displays, student devices and room equipment. Approve what's on the district's list; the school then puts it in a room. Teachers can control only approved devices in rooms they teach in."
      : "Ask district IT to approve a classroom device, then put it in a room. Changing what a device can do needs approving again. Student devices can be locked or pointed at a link; no one can view their screens."),
    h("div", { class: "btns", role: "group", "aria-label": "Show" }, it ? seg("pending", "Waiting for approval") : null, seg("all", "All devices"), seg("rooms", "Rooms"), seg("paired", "Paired now"),
      it ? seg("storage", "Teachers' storage") : null, it ? seg("sports", "Sports connectors") : null, !it ? seg("shelter", "Shelter areas") : null),
    filter === "shelter" && !it ? await shelterAreasCard() :
    filter === "storage" && it ? [await storageReviewCard(), await offloadLogCard()] :
    filter === "sports" && it ? await connectorsCard() :
    filter === "paired" ? await pairingsCard() :
    filter === "rooms"
      ? h("section", { class: "card", "aria-label": "Rooms" }, rooms.length ? h("ul", { class: "list" }, rooms.map(r => h("li", {},
          h("div", { class: "row wrap" }, h("b", { class: "grow" }, r.name), h("span", { class: "small muted" }, [r.kind === "media_center" ? "Media center" : "", it ? r.school : "", r.building, r.capacity ? `${r.capacity} seats` : ""].filter(Boolean).join(" · "))),
          h("p", { class: "small" }, r.devices.length ? r.devices.map(d => d.name).join(", ") : "No devices yet."),
          h("div", { class: "btns" }, h("button", { class: "btn small", type: "button", "aria-label": `Timetable: ${r.name}`, onclick: () => roomTimetable(r) }, "Timetable"),
            h("button", { class: "btn small", type: "button", "aria-label": `Roll: ${r.name}`, onclick: () => openView("roll", { rollRoomId: r.id }) }, "Roll"),
            h("button", { class: "btn small", type: "button", "aria-label": `${r.doorQr ? "New door QR" : "Door QR"}: ${r.name}`, onclick: () => doorQr(r) }, r.doorQr ? "New door QR" : "Door QR"),
            h("button", { class: "btn small", type: "button", "aria-label": `Edit room: ${r.name}`, onclick: () => editRoom(r, schools) }, "Edit"),
            h("button", { class: "btn small", type: "button", "aria-label": `Archive room: ${r.name}`, onclick: async () => {
              if (!(await ask({ title: `Archive ${r.name}?`, text: r.devices.length ? "Its devices leave the room and stay approved." : "It leaves the list.", confirm: "Archive" }))) return;
              try { await api.post(`/api/rooms/${r.id}/archive`, {}); toast("Archived."); go("devices", { push: false }); } catch { toast("Couldn't archive it."); } } }, "Archive")))))
          : empty("No rooms yet."), h("button", { class: "btn primary", type: "button", onclick: () => editRoom(null, schools) }, "Add a room"))
      : h("section", { class: "card", "aria-label": "Devices" }, devices.length ? h("ul", { class: "list" }, devices.map(deviceRow)) : empty(filter === "pending" ? "Nothing waiting for approval." : "No devices yet."),
          h("button", { class: "btn primary", type: "button", onclick: () => editDevice(null, schools) }, it ? "Register a device" : "Ask for a device"))];
};
const schoolField = (schools, value) => schools ? [h("label", { for: "dv-school" }, "School"),
  h("select", { id: "dv-school", required: true }, h("option", { value: "", disabled: true, selected: !value }, "Choose…"), schools.map(x => h("option", { value: x.id, selected: x.id === value }, x.name)))] : null;
async function editRoom(r, schools) {
  const v = await dialogForm(r ? `Edit ${r.name}` : "Add a room", () => {
    const inp = (id, label, val, attrs = {}) => [h("label", { for: id }, label), h("input", { id, value: val ?? "", ...attrs })];
    const kind = h("select", { id: "rm-k" }, [["classroom", "Classroom"], ["media_center", "Media center"]].map(([v, t]) => h("option", { value: v, selected: (r?.kind || "classroom") === v }, t)));
    return { fields: [!r ? schoolField(schools) : null, inp("rm-n", "Room name or number", r?.name, { required: true, maxlength: 80 }), h("label", { for: "rm-k" }, "Kind of room"), kind,
      inp("rm-b", "Building (optional)", r?.building, { maxlength: 80 }), inp("rm-c", "Seats (optional)", r?.capacity, { type: "number", min: 1, max: 1000 })],
      value: () => { const g = id => document.getElementById(id)?.value.trim(); return { schoolId: g("dv-school") || undefined, name: g("rm-n"), kind: kind.value, building: g("rm-b") || null, capacity: g("rm-c") || null }; } };
  }, r ? "Save" : "Add");
  if (!v) return;
  try { await (r ? api.put(`/api/rooms/${r.id}`, v) : api.post("/api/rooms", v)); toast("Saved."); openView("devices", { devFilter: "rooms" }); }
  catch (e) { toast(e.body?.error === "already_exists" ? "There's already a room with that name." : "Couldn't save the room."); }
}
async function editDevice(d, schools) {
  const v = await dialogForm(d ? `Edit ${d.name}` : state.me.role === "it_admin" ? "Register a device" : "Ask for a device", () => {
    const inp = (id, label, val, attrs = {}) => [h("label", { for: id }, label), h("input", { id, value: val ?? "", ...attrs })];
    const caps = h("fieldset", { class: "caps" });
    const kindSel = h("select", { id: "dv-k", disabled: !!d, onchange: () => drawCaps(kindSel.value) }, Object.entries(DEVICE_KIND).map(([k, t]) => h("option", { value: k, selected: (d?.kind || "display") === k }, t)));
    const drawCaps = kind => caps.replaceChildren(h("legend", {}, "What teachers can do with it"),
      ...DEVICE_CAPS[kind].map(c => h("label", { class: "check" }, h("input", { type: "checkbox", value: c, checked: d ? d.capabilities.includes(c) : true }), ` ${CAP_TEXT[c]}`)));
    drawCaps(d?.kind || "display");
    return { fields: [!d ? schoolField(schools) : null, h("label", { for: "dv-k" }, "Kind"), kindSel, inp("dv-n", "Name", d?.name, { required: true, maxlength: 80, placeholder: "e.g. Front board" }),
      inp("dv-mk", "Maker (optional)", d?.maker, { maxlength: 80 }), inp("dv-md", "Model (optional)", d?.model, { maxlength: 80 }), inp("dv-sn", "Serial number (optional)", d?.serial, { maxlength: 80 }), caps,
      d?.status === "approved" ? h("p", { class: "small muted" }, "Changing anything but the name sends it back to district IT and out of its room.") : null],
      value: () => { const g = id => document.getElementById(id)?.value.trim();
        const capabilities = [...caps.querySelectorAll("input:checked")].map(i => i.value);
        if (!capabilities.length) { toast("Choose at least one thing teachers can do."); return undefined; }
        return { schoolId: g("dv-school") || undefined, kind: kindSel.value, name: g("dv-n"), maker: g("dv-mk") || null, model: g("dv-md") || null, serial: g("dv-sn") || null, capabilities }; } };
  }, d ? "Save" : state.me.role === "it_admin" ? "Register" : "Ask district IT");
  if (!v) return;
  try { const r = (await (d ? api.put(`/api/devices/${d.id}`, v) : api.post("/api/devices", v))).data;
    toast(r.status === "pending" ? "Sent to district IT for approval." : "Saved."); go("devices", { push: false }); }
  catch (e) { toast(e.body?.error === "already_exists" ? "That serial number is already registered." : "Couldn't save the device."); }
}
async function decideDevice(d, decision) {
  const note = await dialogForm(decision === "approved" ? `Approve ${d.name}` : `Don't approve ${d.name}`, () => {
    const box = h("textarea", { id: "dd-note", maxlength: 500, rows: 2, placeholder: decision === "approved" ? "Optional" : "Why, so the school knows" });
    return { fields: [h("p", { class: "small" }, `${d.school} · ${DEVICE_KIND[d.kind]} · can: ${d.capabilities.map(c => CAP_TEXT[c]).join(", ")}`), h("label", { for: box.id }, "Note to the school"), box], value: () => box.value.trim() };
  }, decision === "approved" ? "Approve" : "Don't approve");
  if (note === null) return;
  try { await api.post(`/api/devices/${d.id}/decision`, { decision, note: note || null }); toast("Saved."); go("devices", { push: false }); } catch { toast("Couldn't save it."); }
}
async function placeDevice(d, rooms) {
  const mine = rooms.filter(r => r.schoolId === d.schoolId);
  const roomId = await dialogForm(`Room for ${d.name}`, () => {
    const sel = h("select", { id: "pd-room" }, h("option", { value: "" }, "Not in a room"), mine.map(r => h("option", { value: r.id, selected: r.id === d.roomId }, r.name)));
    return { fields: [mine.length ? null : h("p", { class: "small muted" }, "Add a room first (Rooms)."), h("label", { for: sel.id }, "Room"), sel], value: () => sel.value };
  }, "Save");
  if (roomId === null) return;
  try { await api.post(`/api/devices/${d.id}/place`, { roomId: roomId || null }); toast(roomId ? "Placed." : "Taken out of the room."); go("devices", { push: false }); } catch { toast("Couldn't move it."); }
}
async function deviceHistory(d) {
  const ev = (await api.get(`/api/devices/${d.id}/events`)).data;
  const WORD = { requested: "Asked for", registered: "Registered", approved: "Approved", rejected: "Not approved", changed: "Changed", placed: "Put in", removed: "Taken out of", retired: "Retired" };
  await dialogForm(`History: ${d.name}`, () => ({ fields: [h("ol", { class: "list small" }, ev.map(e => h("li", {}, h("b", {}, `${WORD[e.event]}${e.event === "placed" || e.event === "removed" ? ` ${e.detail || "a room"}` : ""}`),
    ` · ${e.by} · ${new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`, e.detail && !["placed", "removed"].includes(e.event) ? h("p", { class: "muted" }, e.detail) : null)))], value: () => undefined }), null);
}
// ---- DEV-02: room timetable and pairing a teacher's own device -------------
const WEEKDAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]];
const dayText = ds => ds.length === 5 && [1, 2, 3, 4, 5].every(d => ds.includes(d)) ? "Weekdays" : ds.length === 7 ? "Every day" : ds.map(d => WEEKDAYS[d - 1][1]).join(", ");
const timeText = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
async function roomTimetable(r) {
  const [slots, teachers] = await Promise.all([api.get(`/api/rooms/${r.id}/timetable`).then(x => x.data), api.get(`/api/rooms/${r.id}/teachers`).then(x => x.data)]);
  if (isVP()) return dialogForm(`Timetable: ${r.name}`, () => ({ fields: [h("p", { class: "small muted" }, "Only the principal sets room timetables."),
    slots.length ? h("ul", { class: "list" }, slots.map(x => h("li", {}, h("b", {}, x.teacher), h("br"), h("span", { class: "small muted" }, `${dayText(x.weekdays)} · ${x.starts}–${x.ends}${x.course ? ` · ${x.course}` : ""}${x.label ? ` · ${x.label}` : ""}`))))
      : h("p", { class: "small" }, "No one is timetabled here yet.")], value: () => undefined }), null);
  const v = await dialogForm(`Timetable: ${r.name}`, done => {
    const course = h("select", { id: "tt-c" }, h("option", { value: "" }, "No course"));
    const sel = h("select", { id: "tt-t", required: true, onchange: () => course.replaceChildren(h("option", { value: "" }, "No course"),
      ...(teachers.find(t => t.id === sel.value)?.courses || []).map(c => h("option", { value: c.id }, c.title))) },
      h("option", { value: "", disabled: true, selected: true }, "Choose a teacher…"), teachers.map(t => h("option", { value: t.id }, t.name)));
    const days = h("fieldset", { class: "caps" }, h("legend", {}, "Days"), WEEKDAYS.map(([n, t]) => h("label", { class: "check" }, h("input", { type: "checkbox", value: n, checked: n <= 5 }), ` ${t}`)));
    const inp = (id, label, attrs) => [h("label", { for: id }, label), h("input", { id, ...attrs })];
    return { fields: [
      h("p", { class: "small muted" }, "A teacher can pair their own phone or laptop with this room's devices only while they're timetabled here (from ten minutes before)."),
      slots.length ? h("ul", { class: "list" }, slots.map(x => h("li", { class: "row wrap" }, h("span", { class: "grow" }, h("b", {}, x.teacher), h("br"),
        h("span", { class: "small muted" }, `${dayText(x.weekdays)} · ${x.starts}–${x.ends}${x.course ? ` · ${x.course}` : ""}${x.label ? ` · ${x.label}` : ""}`)),
        h("button", { class: "btn small", type: "button", "aria-label": `Remove: ${x.teacher} ${x.starts}`, onclick: async () => {
          try { await api.post(`/api/room-timetable/${x.id}/end`, {}); toast("Removed."); done(null); roomTimetable(r); } catch { toast("Couldn't remove it."); } } }, "Remove"))))
        : h("p", { class: "small" }, "No one is timetabled here yet."),
      h("h3", {}, "Add a time"), teachers.length ? null : h("p", { class: "small muted" }, "No teachers at this school yet."),
      h("label", { for: "tt-t" }, "Teacher"), sel, h("label", { for: "tt-c" }, "Course (its class list is the room's roll)"), course, days, inp("tt-s", "Starts", { type: "time", required: true, value: "08:00" }), inp("tt-e", "Ends", { type: "time", required: true, value: "09:00" }),
      inp("tt-l", "Class or period (optional)", { maxlength: 80, placeholder: "e.g. Period 1 · Math 3" })],
      value: () => { const weekdays = [...days.querySelectorAll("input:checked")].map(i => Number(i.value));
        const g = id => document.getElementById(id).value.trim();
        if (!weekdays.length) { toast("Choose at least one day."); return undefined; }
        if (g("tt-e") <= g("tt-s")) { toast("The end has to be after the start."); return undefined; }
        return { teacherId: sel.value, courseId: course.value || null, weekdays, starts: g("tt-s"), ends: g("tt-e"), label: g("tt-l") || null }; } };
  }, "Add");
  if (!v) return;
  try { await api.post(`/api/rooms/${r.id}/timetable`, v); toast("Added."); roomTimetable(r); } catch { toast("Couldn't add it."); }
}
async function pairingsCard() {
  const list = (await api.get("/api/pairings")).data;
  return h("section", { class: "card", "aria-label": "Paired now" }, list.length ? h("ul", { class: "list" }, list.map(p => h("li", { class: "row wrap" },
    h("span", { class: "grow" }, h("b", {}, `${p.room}: ${p.teacher}`), h("br"), h("span", { class: "small muted" }, `${p.controller} · paired at ${timeText(p.pairedAt)} · until ${timeText(p.until)}`)),
    h("button", { class: "btn small", type: "button", "aria-label": `End pairing: ${p.room}, ${p.teacher}`, onclick: async () => {
      try { await api.post(`/api/pairings/${p.id}/end`, {}); toast("Ended."); go("devices", { push: false }); } catch { toast("Couldn't end it."); } } }, "End pairing"))))
    : empty("No one is paired with a room right now."));
}
async function issueDeviceKey(d) {
  if (d.hasKey && !(await ask({ title: `New key for ${d.name}?`, text: "The old key stops working. You'll need to enter the new one on the device.", confirm: "New key" }))) return;
  let k; try { k = (await api.post(`/api/devices/${d.id}/key`, {})).data; } catch { return toast("Couldn't make a key. Is the device approved?"); }
  await dialogForm(`Device key: ${d.name}`, () => {
    const box = h("input", { id: "dk-key", value: k.key, readonly: true, class: "mono" });
    return { fields: [h("p", { class: "small" }, "Enter this key in the EduOS agent on the device. It's shown only now; if it's lost, make a new one."),
      h("label", { for: box.id }, "Key"), box,
      h("button", { class: "btn small", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(k.key); toast("Copied."); } catch { box.select(); } } }, "Copy key")], value: () => undefined };
  }, null);
  go("devices", { push: false });
}
const thisDeviceName = () => /iPhone|Android.*Mobile/.test(navigator.userAgent) ? "My phone" : /iPad|Android/.test(navigator.userAgent) ? "My tablet" : "My computer";
async function myClassroomCard() {
  const rooms = (await safe(api.get("/api/my/rooms")))?.data || [];
  if (!rooms.length) return null;
  const extras = await Promise.all(rooms.map(r => classroomLiveExtras(r)));
  return h("section", { class: "card", "aria-label": "Your classroom" }, h("h2", {}, "Your classroom"),
    h("ul", { class: "list" }, rooms.map((r, i) => h("li", {},
      h("div", { class: "row wrap" }, h("b", { class: "grow" }, r.name), r.pairing ? chip("present", `Paired until ${timeText(r.pairing.until)}`) : r.now ? chip("expected", "Timetabled now") : null),
      h("p", { class: "small muted" }, r.slots.map(x => `${dayText(x.weekdays)} ${x.starts}–${x.ends}${x.label ? ` (${x.label})` : ""}`).join(" · ")),
      r.devices.length ? h("p", { class: "small" }, `Devices: ${r.devices.map(d => d.name).join(", ")}`) : h("p", { class: "small muted" }, "No approved devices in this room yet."),
      h("div", { class: "btns" },
        r.pairing ? [h("button", { class: "btn small primary", type: "button", "aria-label": `Controls: ${r.name}`, onclick: () => openView("room", { roomId: r.id }) }, "Controls"),
          h("button", { class: "btn small", type: "button", "aria-label": `End pairing: ${r.name}`, onclick: async () => {
            try { await api.post(`/api/pairings/${r.pairing.id}/end`, {}); toast("Unpaired."); go(state.tab, { push: false }); } catch { toast("Couldn't unpair."); } } }, "End pairing")]
        : r.now && r.devices.length ? h("button", { class: "btn small primary", type: "button", "aria-label": `Pair this device: ${r.name}`, onclick: () => pairRoom(r) }, "Pair this device")
        : null,
        h("button", { class: "btn small", type: "button", "aria-label": `Roll: ${r.name}`, onclick: () => openView("roll", { rollRoomId: r.id }) }, "Roll")),
      extras[i]))));
}
async function pairRoom(r) {
  const v = await dialogForm(`Pair with ${r.name}`, () => {
    const code = h("input", { id: "pr-code", inputmode: "numeric", autocomplete: "one-time-code", pattern: "\\d{6}", maxlength: 6, required: true, class: "mono" });
    const name = h("input", { id: "pr-name", maxlength: 60, required: true, value: thisDeviceName() });
    return { fields: [h("p", { class: "small" }, "Type the 6-digit code shown on the room's display. You'll stay paired until your timetabled time here ends."),
      h("label", { for: code.id }, "Code on the display"), code, h("label", { for: name.id }, "Name for this device"), name],
      value: () => ({ code: code.value.trim(), controllerName: name.value.trim() }) };
  }, "Pair");
  if (!v) return;
  try { const p = (await api.post(`/api/rooms/${r.id}/pair`, v)).data; toast(`Paired with ${p.room} until ${timeText(p.until)}.`); go(state.tab, { push: false }); }
  catch (e) { toast({ wrong_code: "That code didn't match. Check the display and try again.", not_timetabled_now: "You can pair only while you're timetabled in this room." }[e.body?.error]
    || (e.status === 429 ? "Too many tries. Wait a few minutes." : "Couldn't pair.")); }
}
// ---- DEV-03: the paired teacher's classroom controls -----------------------
const CMD_STATUS = { queued: ["expected", "Sending"], delivered: ["expected", "Sent"], done: ["present", "Done"], failed: ["absent", "Didn't work"] };
const CMD_TEXT = c => ({ show: "Show my screen", blank: c.args.on ? "Blank screen" : "Unblank screen", power: c.args.on ? "Power on" : "Power off", input: `Input: ${c.args.source}`,
  volume: `Volume ${c.args.level}`, lights: `Lights ${c.args.on ? "on" : "off"}${c.args.level != null ? ` (${c.args.level}%)` : ""}`, lock: "Lock", unlock: "Unlock",
  open_link: `Open ${c.args.url}`, focus: c.args.off ? "End focus" : `Focus on ${c.args.url}` })[c.capability] || c.capability;
async function sendCommand(d, capability, args = {}) {
  try { await api.post(`/api/devices/${d.id}/commands`, { capability, args }); toast(`Sent to ${d.name}.`); refreshRoomLog(); }
  catch (e) { toast({ not_paired: "You're not paired with this room any more.", device_not_ready: "This device isn't connected yet. Ask district IT.", not_approved_for_device: "That isn't approved for this device.",
    invalid_command: "Check what you entered.", paused_for_safety: "Classroom controls are paused during a safety alert." }[e.body?.error] || (e.status === 429 ? "Slow down a little." : "Couldn't send it.")); }
}
async function refreshRoomLog() {
  const box = document.getElementById("room-log"); if (!box || !state.roomId) return;
  const log = (await safe(api.get(`/api/rooms/${state.roomId}/commands?limit=15`)))?.data;
  if (!log || !document.getElementById("room-log")) return;
  box.replaceChildren(...(log.length ? [h("ul", { class: "list" }, log.map(c => h("li", { class: "row wrap" },
    h("span", { class: "grow small" }, h("b", {}, c.device), `: ${CMD_TEXT(c)}`, c.result ? h("span", { class: "muted" }, ` · ${c.result}`) : null), chip(...CMD_STATUS[c.status]))))] : [empty("Nothing sent yet.")]));
}
VIEWS.room = async () => {
  const r = ((await api.get("/api/my/rooms")).data || []).find(x => x.id === state.roomId);
  if (!r) return [back("classes", "Classes"), empty("This room isn't on your timetable.")];
  if (!r.pairing) return [back("classes", "Classes"), h("h2", {}, r.name), h("section", { class: "card" }, h("p", {}, "This device isn't paired with the room. Pair it from Classes while you're timetabled here."))];
  const controls = teacherDeviceControls;
  clearInterval(state.roomTimer);
  state.roomTimer = setInterval(refreshRoomLog, 4000);
  setTimeout(refreshRoomLog, 0);
  return [back("classes", "Classes"), h("h2", {}, r.name),
    h("p", { class: "small muted" }, `Paired: ${r.pairing.controller}, until ${timeText(r.pairing.until)}. Only what district IT approved for each device is here.`),
    r.devices.map(d => h("section", { class: "card", "aria-label": d.name }, h("h3", {}, d.name, h("span", { class: "small muted" }, ` · ${DEVICE_KIND[d.kind]}`)), controls(d))),
    h("section", { class: "card", "aria-label": "Sent" }, h("h3", {}, "Sent"), h("div", { id: "room-log" }, h("p", { class: "small muted" }, "Loading…"))),
    h("button", { class: "btn danger block", type: "button", onclick: async () => {
      try { await api.post(`/api/pairings/${r.pairing.id}/end`, {}); toast("Unpaired."); go("classes"); } catch { toast("Couldn't unpair."); } } }, "End pairing")];
};
// ---- ROOM-01: scanning into a classroom or the media center ----------------
const SCAN_METHOD = { display_qr: "room display", door_qr: "door poster", kiosk_id: "ID card", remote: "joined remotely" };
// A scanned link (#/scan?r=…&c=… or &d=…) is kept for this tab, so it survives signing in.
function takeScanLink() {
  const m = /^#\/scan\?(.*)$/.exec(location.hash);
  if (!m) return false;
  const q = new URLSearchParams(m[1]), r = q.get("r"), c = q.get("c"), d = q.get("d");
  if (/^[0-9a-f-]{36}$/i.test(r || "") && /^[A-Za-z0-9_-]{22,64}$/.test(c || d || "")) {
    try { sessionStorage.setItem("eduos-scan", JSON.stringify({ r, ...(c ? { c } : { d }) })); } catch {}
  }
  history.replaceState(history.state, "", `${location.pathname}${location.search}#/scan`);
  return true;
}
takeScanLink();
const canScan = () => state.me && !["parent", "it_admin", "superintendent", "driver", "sro"].includes(state.me.role);
async function scanCard() {
  if (!canScan()) return null;
  const mine = (await safe(api.get("/api/my/checkins")))?.data || [];
  return h("section", { class: "card", "aria-label": "Scan in" }, h("div", { class: "row wrap" }, h("h2", { class: "grow" }, "Scan in"),
      h("button", { class: "btn small", type: "button", onclick: () => go("scan") }, icon("qr"), "How to scan in")),
    mine.length ? h("p", { class: "small muted" }, `Today: ${mine.slice(0, 3).map(k => `${k.room}${k.class ? ` (${k.class})` : ""} at ${timeText(k.at)}`).join(" · ")}`)
      : h("p", { class: "small muted" }, "Scan the QR on your classroom's screen or the media center door when you arrive."));
}
async function submitScan(link) {
  try {
    const r = (await api.post(`/api/rooms/${link.r}/checkin`, link.c ? { code: link.c } : { door: link.d })).data;
    return h("section", { class: "card", "aria-label": "Checked in" }, h("h2", {}, r.already ? `You're already checked in to ${r.room}` : `Checked in to ${r.room}`),
      h("p", {}, `${r.class ? `${r.class} · ` : ""}${timeText(r.checkedInAt)}`), state.me.role === "pupil" ? h("p", { class: "small muted" }, "Your teacher confirms attendance.") : null);
  } catch (e) {
    return h("section", { class: "card", "aria-label": "Couldn't check in" }, h("h2", {}, "Couldn't check in"),
      h("p", {}, { code_expired: "That QR has changed. Scan the one on the screen now.", room_not_found: "That room isn't at your school.", not_allowed: "Only students and staff check into rooms.",
        not_a_student_here: "Your account isn't linked to a student at this school." }[e.body?.error] || (e.status === 429 ? "Too many scans. Wait a minute." : "Please try again.")));
  }
}
VIEWS.scan = async () => {
  let link = null; try { link = JSON.parse(sessionStorage.getItem("eduos-scan") || "null"); sessionStorage.removeItem("eduos-scan"); } catch {}
  const result = link ? await submitScan(link) : null;
  // EduOS doesn't use the camera (privacy): the QR holds an EduOS link, so the
  // phone's own camera app opens it here.
  return [h("h2", {}, "Scan in"), result,
    h("section", { class: "card", "aria-label": "How to scan in" }, h("ol", { class: "steps" },
      h("li", {}, "Open your phone's camera app."), h("li", {}, "Point it at the QR on the classroom screen or the media center door."), h("li", {}, "Tap the link it shows. EduOS opens and checks you in.")),
      h("p", { class: "small muted" }, "No phone? Ask about the ID-card kiosk, or your teacher can mark you on the roll."))];
};
async function doorQr(r) {
  if (r.doorQr && !(await ask({ title: `New door QR for ${r.name}?`, text: "The old poster stops working. Print the new one.", confirm: "Make a new one" }))) return;
  let d; try { d = (await api.post(`/api/rooms/${r.id}/door-qr`, {})).data; } catch { return toast("Couldn't make it."); }
  await dialogForm(`Door QR: ${r.name}`, () => ({ fields: [
    h("div", { class: "print-qr" }, h("h3", {}, `Scan in: ${r.name}`), qrSvg(d.qr, `QR code to scan into ${r.name}`), h("p", { class: "small" }, "Students and staff scan this with the EduOS app or the phone camera.")),
    h("p", { class: "small muted" }, d.note), h("button", { class: "btn", type: "button", onclick: () => window.print() }, "Print")], value: () => undefined }), null);
  go("devices", { push: false });
}
const ATT_STATUS = { present: ["present", "Present"], absent: ["absent", "Absent"], tardy: ["expected", "Tardy"], excused: ["expected", "Excused"] };
async function confirmAttendance(date, ids, status) {
  let n = 0;
  for (const id of ids) { try { await api.post("/api/attendance", { studentId: id, eventDate: date, status }); n++; } catch {} }
  toast(n === ids.length ? `Saved ${n}.` : `Saved ${n} of ${ids.length}.`);
  go(state.tab, { push: false });
}
function teacherDeviceControls(d) {
  const btn = (label, aria, fn, primary) => h("button", { class: `btn small${primary ? " primary" : ""}`, type: "button", "aria-label": `${label}: ${aria}`, onclick: fn }, label);
  const id = (dev, k) => `rc-${dev.id.slice(0, 8)}-${k}`;
  const field = (dev, k, label, attrs) => [h("label", { for: id(dev, k) }, label), h("input", { id: id(dev, k), ...attrs })];
  const val = (dev, k) => document.getElementById(id(dev, k))?.value.trim() || "";
  const has = c => (d.capabilities || []).includes(c);
  return [
    d.kind === "student_device" ? h("p", { class: "small muted" }, "You can lock these devices or send them to a link. No one can see their screens.") : null,
    h("div", { class: "btns" },
      has("show") ? btn("Show my screen", d.name, () => sendCommand(d, "show"), true) : null,
      has("blank") ? [btn("Blank", d.name, () => sendCommand(d, "blank", { on: true })), btn("Unblank", d.name, () => sendCommand(d, "blank", { on: false }))] : null,
      has("power") ? [btn("On", d.name, () => sendCommand(d, "power", { on: true })), btn("Off", d.name, () => sendCommand(d, "power", { on: false }))] : null,
      has("lights") ? [btn("Lights on", d.name, () => sendCommand(d, "lights", { on: true })), btn("Lights off", d.name, () => sendCommand(d, "lights", { on: false }))] : null,
      has("lock") ? btn("Lock", d.name, () => sendCommand(d, "lock", val(d, "msg") ? { message: val(d, "msg") } : {}), true) : null,
      has("unlock") ? btn("Unlock", d.name, () => sendCommand(d, "unlock")) : null,
      has("focus") ? btn("End focus", d.name, () => sendCommand(d, "focus", { off: true })) : null),
    has("lock") ? field(d, "msg", "Message on locked screens (optional)", { maxlength: 120, placeholder: "e.g. Eyes up front" }) : null,
    has("volume") ? h("div", { class: "row wrap" }, field(d, "vol", "Volume", { type: "range", min: 0, max: 100, step: 5, value: 50 }),
      btn("Set volume", d.name, () => sendCommand(d, "volume", { level: Number(val(d, "vol")) }))) : null,
    has("input") ? h("div", { class: "row wrap" }, field(d, "in", "Input", { maxlength: 40, placeholder: "e.g. HDMI 1" }), btn("Switch input", d.name, () => sendCommand(d, "input", { source: val(d, "in") }))) : null,
    has("open_link") || has("focus") ? h("div", {}, field(d, "url", "Link (https://…)", { type: "url", maxlength: 500 }),
      h("div", { class: "btns" }, has("open_link") ? btn("Open link", d.name, () => sendCommand(d, "open_link", { url: val(d, "url") })) : null,
        has("focus") ? btn("Focus on link", d.name, () => sendCommand(d, "focus", { url: val(d, "url") })) : null)) : null];
}
function teacherRollWho(x, at, method) {
  return [h("span", { class: "grow" }, h("b", {}, x), at ? h("span", { class: "small muted" }, ` · ${timeText(at)}, ${SCAN_METHOD[method]}`) : null)];
}
function teacherRollSections(d) {
  return [
    (d.periods || []).map(p => {
      const roster = p.roster || [], others = p.others || [];
      const waiting = roster.filter(s => s.checkedInAt && !s.attendance);
      return h("section", { class: "card", "aria-label": `${p.class || "Period"} ${p.starts}` },
        h("div", { class: "row wrap" }, h("h3", { class: "grow" }, `${p.starts}–${p.ends} · ${p.class || "No class named"}`), p.now ? chip("present", "Now") : null),
        h("p", { class: "small muted" }, `${p.teacher || ""}${roster.length ? ` · ${roster.filter(s => s.checkedInAt).length} of ${roster.length} checked in` : ""}`),
        roster.length ? h("ul", { class: "list" }, roster.map(s => h("li", { class: "row wrap" }, ...teacherRollWho(s.name, s.checkedInAt, s.method),
          s.attendance ? chip(...ATT_STATUS[s.attendance]) : s.checkedInAt ? chip("expected", "Checked in") : chip("absent", "Not checked in"),
          state.me.role === "teacher" && !s.attendance ? h("div", { class: "btns" },
            h("button", { class: "btn small", type: "button", "aria-label": `Present: ${s.name}`, onclick: () => confirmAttendance(d.date, [s.studentId], "present") }, "Present"),
            h("button", { class: "btn small", type: "button", "aria-label": `Absent: ${s.name}`, onclick: () => confirmAttendance(d.date, [s.studentId], "absent") }, "Absent")) : null)))
          : h("p", { class: "small muted" }, "No course is set for this period, so there's no class list. The school can set one in the room's timetable."),
        others.length ? [h("h4", {}, "Also checked in"), h("ul", { class: "list" }, others.map(o => h("li", { class: "row" }, ...teacherRollWho(o.name, o.at, o.method), o.kind === "staff" ? chip("present", "Staff") : null)))] : null,
        state.me.role === "teacher" && waiting.length ? h("button", { class: "btn primary", type: "button", onclick: () => confirmAttendance(d.date, waiting.map(s => s.studentId), "present") },
          `Mark the ${waiting.length} checked in present`) : null);
    }),
    (d.unscheduled || []).length || d.kind === "media_center" ? h("section", { class: "card", "aria-label": "Checked in outside a period" }, h("h3", {}, d.kind === "media_center" ? "Checked in today" : "Outside a period"),
      (d.unscheduled || []).length ? h("ul", { class: "list" }, d.unscheduled.map(o => h("li", { class: "row" }, ...teacherRollWho(o.name, o.at, o.method), o.kind === "staff" ? chip("present", "Staff") : null))) : empty("No one yet.")) : null];
}
async function classroomLiveExtras(r) {
  const parts = [];
  const devices = (r.devices || []).filter(d => (d.capabilities || []).length);
  if (r.pairing && devices.length) {
    parts.push(h("div", { "aria-label": `Live device controls: ${r.name}` },
      h("h3", {}, "Live device controls"),
      h("p", { class: "small muted" }, "Only what district IT approved for each device is here."),
      devices.map(d => h("div", { "aria-label": d.name },
        h("h4", {}, d.name, h("span", { class: "small muted" }, ` · ${DEVICE_KIND[d.kind] || d.kind}`)),
        teacherDeviceControls(d)))));
  } else if (devices.length) {
    parts.push(h("p", { class: "small muted" }, "Pair this device to use live classroom controls."));
  }
  try {
    const roll = (await api.get(`/api/rooms/${r.id}/roll`)).data;
    parts.push(h("div", { "aria-label": `${r.name} classroom roll` },
      h("h3", {}, `${roll.name}: classroom roll`),
      h("p", { class: "small muted" }, `${roll.date}. A check-in shows who scanned in; you confirm attendance.`),
      teacherRollSections(roll)));
  } catch (e) {
    parts.push(h("p", { class: "small muted" }, e.status === 404 ? "This room is not assigned to your timetable." : "Could not load the classroom roll."));
  }
  return parts;
}
VIEWS.roll = async () => {
  if (!state.rollRoomId) return [empty("Choose a room first.")];
  const d = (await api.get(`/api/rooms/${state.rollRoomId}/roll`)).data;
  const backTo = tabsFor().some(t => t[0] === "classes") ? back("classes", "Classes") : tabsFor().some(t => t[0] === "mediacenter") ? back("mediacenter", "Media center") : back("devices", "Rooms & devices");
  return [backTo, h("h2", {}, `${d.name}: roll`), h("p", { class: "small muted" }, `${d.date}. A check-in shows who scanned in; you confirm attendance.${d.kind === "media_center" ? "" : " A door-poster scan could come from a photo of the poster."}`), teacherRollSections(d)];
};
VIEWS.mediacenter = async () => {
  const rooms = (await api.get("/api/rooms?kind=media_center")).data;
  if (rooms.length === 1) { state.rollRoomId = rooms[0].id; return VIEWS.roll(); }
  return [h("h2", {}, "Media center"), h("section", { class: "card", "aria-label": "Media centers" }, rooms.length ? h("ul", { class: "list" }, rooms.map(r => h("li", { class: "row" }, h("b", { class: "grow" }, r.name),
    h("button", { class: "btn small", type: "button", "aria-label": `Who's checked in: ${r.name}`, onclick: () => openView("roll", { rollRoomId: r.id }) }, "Who's checked in"))))
    : empty("Your school hasn't set up a media center room yet. A principal adds one under Rooms & devices."))];
};
// ---- ROOM-02: remote lessons on the teacher's daily schedule ----------------
const dayName = iso => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
async function remotePlanCard(courseId, date, lessons) {
  const cur = ((await safe(api.get(`/api/courses/${courseId}/remote-lessons?from=${date}&to=${date}`)))?.data || [])[0] || null;
  const f = { starts: h("input", { id: "rl-s", type: "time", required: true, value: cur?.starts || "08:00" }), ends: h("input", { id: "rl-e", type: "time", required: true, value: cur?.ends || "09:00" }),
    url: h("input", { id: "rl-u", type: "url", maxlength: 500, required: true, value: cur?.joinUrl || "", placeholder: "https://meet.google.com/… or Zoom, Teams, Webex" }),
    lesson: h("select", { id: "rl-l" }, h("option", { value: "" }, "No lesson"), lessons.map(l => h("option", { value: l.id, selected: l.id === cur?.lessonId }, l.title))),
    note: h("input", { id: "rl-n", maxlength: 500, value: cur?.note || "", placeholder: "e.g. Have your workbook ready" }) };
  const save = async e => {
    e.preventDefault();
    try { await api.put(`/api/courses/${courseId}/remote-lessons/${date}`, { starts: f.starts.value, ends: f.ends.value, joinUrl: f.url.value.trim(), lessonId: f.lesson.value || null, note: f.note.value.trim() || null });
      toast(cur ? "Remote lesson updated." : "Remote lesson added. Students in this class will see it."); go("plan", { push: false }); }
    catch (err) { toast({ meeting_link_not_allowed: "Use a Google Meet, Zoom, Microsoft Teams or Webex link.", lesson_must_be_published_in_this_course: "Publish that lesson first so remote students can open it.",
      invalid_times: "The end has to be after the start." }[err.body?.error] || "Couldn't save it."); }
  };
  return h("section", { class: "card", "aria-label": "Remote lesson" },
    h("div", { class: "row wrap" }, h("h3", { class: "grow" }, "Remote lesson"), cur ? chip("present", `${cur.provider} · ${cur.starts}–${cur.ends}`) : null),
    h("p", { class: "small muted" }, "Students learning from home join from EduOS, which checks them in as remote on your roll. You still confirm attendance."),
    cur?.joined?.length ? h("p", { class: "small" }, `Joined: ${cur.joined.map(j => `${j.name} (${timeText(j.at)})`).join(", ")}`) : null,
    h("form", { onsubmit: save },
      h("div", { class: "row wrap" }, h("div", {}, h("label", { for: "rl-s" }, "Starts"), f.starts), h("div", {}, h("label", { for: "rl-e" }, "Ends"), f.ends)),
      h("label", { for: "rl-u" }, "Video call link"), f.url, h("label", { for: "rl-l" }, "Lesson for remote students"), f.lesson, h("label", { for: "rl-n" }, "Note (optional)"), f.note,
      h("div", { class: "btns" }, h("button", { class: "btn primary", type: "submit" }, cur ? "Save remote lesson" : "Add remote lesson"),
        cur ? h("button", { class: "btn", type: "button", onclick: async () => {
          if (!(await ask({ title: "Cancel the remote lesson?", text: "It comes off students' schedules.", confirm: "Cancel it", cancel: "Keep it" }))) return;
          try { await api.post(`/api/remote-lessons/${cur.id}/cancel`, {}); toast("Cancelled."); go("plan", { push: false }); } catch { toast("Couldn't cancel it."); } } }, "Cancel remote lesson") : null)));
}
async function remoteLessonsCard() {
  if (!["teacher", "pupil"].includes(state.me?.role)) return null;
  const list = (await safe(api.get("/api/my/remote-lessons")))?.data || [];
  if (!list.length) return null;
  const pupil = state.me.role === "pupil";
  return h("section", { class: "card", "aria-label": "Remote lessons" }, h("h2", {}, "Remote lessons"),
    h("ul", { class: "list" }, list.map(x => h("li", {},
      h("div", { class: "row wrap" }, h("b", { class: "grow" }, x.course), chip(x.open ? "present" : "expected", `${x.today ? "Today" : dayName(x.date)} ${x.starts}–${x.ends}`)),
      h("p", { class: "small muted" }, [x.provider, x.lesson ? `Lesson: ${x.lesson}` : "", x.note || ""].filter(Boolean).join(" · ")),
      h("div", { class: "btns" },
        pupil && x.open ? (state.joined?.[x.id]
          ? h("a", { class: "btn small primary", href: state.joined[x.id], target: "_blank", rel: "noopener noreferrer" }, `Open ${x.provider}`)
          : h("button", { class: "btn small primary", type: "button", "aria-label": `Join: ${x.course}`, onclick: async () => {
              try { const r = (await api.post(`/api/remote-lessons/${x.id}/join`, {})).data; state.joined = { ...(state.joined || {}), [x.id]: r.joinUrl };
                toast("You're checked in as remote."); go(state.tab, { push: false }); }
              catch (e) { toast(e.body?.error === "not_now" ? "It opens ten minutes before the start." : "Couldn't join."); } } }, x.joined ? "Join again" : "Join"))
          : pupil ? h("span", { class: "small muted" }, x.joined ? "You joined." : "Opens ten minutes before the start.") : null,
        pupil && x.lessonId ? h("button", { class: "btn small", type: "button", "aria-label": `Open lesson: ${x.lesson}`, onclick: () => openView("lesson", { lessonId: x.lessonId }) }, "Open lesson") : null,
        !pupil ? h("button", { class: "btn small", type: "button", "aria-label": `Open plan: ${x.course}, ${x.date}`, onclick: () => openView("plan", { planCourseId: x.courseId, planDate: x.date, planEdit: null }) }, "Open plan") : null)))));
}
// ---- TEACH-05: the portable teacher profile --------------------------------
const WORK_KIND = { unit: "Unit", lesson: "Lesson", coaching_plan: "Coaching plan" };
const CLAIM_STATUS = { pending: ["expected", "Waiting for review"], approved: ["present", "Approved"], rejected: ["absent", "Not approved"], withdrawn: ["absent", "Withdrawn"] };
VIEWS.mywork = async () => {
  const [pv, claims, pkgs, imports, library, devices, storage, cloud] = await Promise.all([api.get("/api/portfolio/preview").then(r => r.data), api.get("/api/portfolio/claims").then(r => r.data),
    api.get("/api/portfolio/packages").then(r => r.data), api.get("/api/portfolio/imports").then(r => r.data), api.get("/api/portfolio/library").then(r => r.data),
    api.get("/api/storage/devices").then(r => r.data), api.get("/api/storage/settings").then(r => r.data), api.get("/api/portfolio/cloud").then(r => r.data)]);
  const reload = () => go("mywork", { push: false });
  const openClaim = it => claims.find(c => c.itemId === it.id && ["pending", "approved"].includes(c.status));
  return [back("me", "Account"), h("h2", {}, "My work: take it with you"),
    h("p", { class: "small muted" }, "Your units, lessons and coaching plans are yours to take to another school or district, with your licenses. Packages never include student information. The school keeps its copy unless you hold the copyright or a patent and the school or district approves your claim."),
    h("section", { class: "card", "aria-label": "Your work here" }, h("h3", {}, "Your work here"),
      pv.items.length ? h("ul", { class: "list" }, pv.items.map(it => { const c = openClaim(it);
        return h("li", {}, h("div", { class: "row wrap" }, h("b", { class: "grow" }, `${WORK_KIND[it.kind]}: ${it.title}`),
            it.rights ? chip("present", "Your rights: school won't keep a copy") : c ? chip(...CLAIM_STATUS[c.status]) : chip("expected", "School keeps a copy")),
          it.approval ? h("p", { class: "small muted" }, `Approved by ${it.approval.by}, ${it.approval.at}`) : null,
          !c && !it.rights ? h("button", { class: "btn small", type: "button", "aria-label": `Claim rights: ${it.title}`, onclick: () => claimRights(it) }, "Claim rights")
            : c?.status === "pending" ? h("button", { class: "btn small", type: "button", "aria-label": `Withdraw claim: ${it.title}`, onclick: async () => {
              try { await api.post(`/api/portfolio/claims/${c.id}/withdraw`, {}); toast("Withdrawn."); reload(); } catch { toast("Couldn't withdraw it."); } } }, "Withdraw claim") : null); }))
        : empty("Nothing of yours here yet."),
      pv.excluded.length ? [h("h4", {}, "Left out until you edit them"), h("p", { class: "small muted" }, "These may name a student. Edit them, then make a new package."),
        h("ul", { class: "list small" }, pv.excluded.map(x => h("li", {}, `${WORK_KIND[x.kind]}: ${x.title}`)))] : null,
      h("button", { class: "btn primary", type: "button", onclick: async () => {
        try { const p = (await api.post("/api/portfolio/packages", {})).data;
          toast(`Package ready: ${p.items} item${p.items === 1 ? "" : "s"}, ${p.licenses} license${p.licenses === 1 ? "" : "s"}${p.signed ? ", signed" : ""}.`); reload(); }
        catch (e) { toast(e.body?.error === "nothing_to_package" ? "There's nothing to package yet." : "Couldn't make the package."); } } }, "Make a package")),
    h("section", { class: "card", "aria-label": "Your packages" }, h("h3", {}, "Your packages"),
      pkgs.length ? h("ul", { class: "list" }, pkgs.map(p => h("li", { class: "row wrap" },
        h("span", { class: "grow" }, h("b", {}, `From ${p.district}`), h("br"), h("span", { class: "small muted" }, `${new Date(p.issuedAt).toLocaleDateString()} · ${p.items} items · ${p.signed ? "signed" : "not signed"}${p.withdrawn ? " · withdrawn" : ""}`)),
        !p.withdrawn && !p.fromHere ? h("button", { class: "btn small primary", type: "button", "aria-label": `Bring into this district: package from ${p.district}`, onclick: async () => {
          try { await api.post("/api/portfolio/imports", { packageId: p.id }); toast("Sent for review here."); reload(); }
          catch (e) { toast({ already_exists: "You've already brought this package in.", package_failed_its_check: "This package failed its check and can't be used." }[e.body?.error] || "Couldn't bring it in."); } } }, "Bring into this district") : null,
        !p.withdrawn && p.fromHere ? h("button", { class: "btn small", type: "button", "aria-label": `Save to approved storage: package from ${new Date(p.issuedAt).toLocaleDateString()}`,
          onclick: () => offloadPackage(p, devices.filter(d => d.status === "approved"), storage, cloud) }, "Save to approved storage") : null,
        !p.withdrawn ? h("button", { class: "btn small", type: "button", "aria-label": `Withdraw package from ${p.district}, ${new Date(p.issuedAt).toLocaleDateString()}`, onclick: async () => {
          try { await api.post(`/api/portfolio/packages/${p.id}/withdraw`, {}); toast("Withdrawn."); reload(); } catch { toast("Couldn't withdraw it."); } } }, "Withdraw") : null)))
        : h("p", { class: "small muted" }, "No packages yet. A package you make here follows you to any district on EduOS.")),
    storageCard(devices, storage, cloud),
    imports.length ? h("section", { class: "card", "aria-label": "Brought into this district" }, h("h3", {}, "Brought into this district"),
      h("ul", { class: "list" }, imports.map(i => h("li", {}, h("div", { class: "row wrap" }, h("b", { class: "grow" }, `From ${i.fromDistrict}`), chip(i.status === "pending" ? "expected" : "present", i.status === "pending" ? "Waiting for review" : "Reviewed")),
        i.status === "reviewed" ? h("p", { class: "small muted" }, `${i.items.filter(x => x.decision === "approved").length} of ${i.items.length} approved by ${i.reviewedBy}${i.note ? ` · ${i.note}` : ""}`) : null,
        i.licenses.length ? h("button", { class: "btn small", type: "button", "aria-label": `Add my ${i.licenses.length} license${i.licenses.length === 1 ? "" : "s"} here, from ${i.fromDistrict}`, onclick: async () => {
          try { const r = (await api.post(`/api/portfolio/imports/${i.id}/licenses`, {})).data; toast(r.added ? `Added ${r.added}. This district verifies them.` : "They're already on your profile."); }
          catch { toast("Couldn't add them."); } } }, `Add my ${i.licenses.length} license${i.licenses.length === 1 ? "" : "s"} here`) : null)))) : null,
    h("section", { class: "card", "aria-label": "Your library here" }, h("h3", {}, "Your library here"),
      library.length ? h("ul", { class: "list" }, library.map(l => h("li", {}, h("div", { class: "row wrap" }, h("b", { class: "grow" }, `${WORK_KIND[l.kind]}: ${l.title}`), l.rights ? chip("present", "Your rights") : null),
        h("p", { class: "small muted" }, `From ${l.origin}${l.priorApproval ? ` (approved there by ${l.priorApproval.by})` : ""} · approved here by ${l.approvedBy}`),
        h("button", { class: "btn small primary", type: "button", "aria-label": `Copy into a course: ${l.title}`, onclick: () => copyLibraryItem(l) }, l.kind === "coaching_plan" ? "Add to my plans" : "Copy into a course"))))
        : h("p", { class: "small muted" }, "Work you bring in shows here once this district approves it."))];
};
async function claimRights(it) {
  const v = await dialogForm(`Claim rights: ${it.title}`, () => {
    const type = h("select", { id: "cr-t" }, h("option", { value: "copyright" }, "Copyright"), h("option", { value: "patent" }, "Patent"));
    const inp = (id, label, attrs) => [h("label", { for: id }, label), h("input", { id, ...attrs })];
    const stmt = h("textarea", { id: "cr-s", rows: 3, maxlength: 1000, required: true, placeholder: "How you own it: e.g. written before joining, registered on…" });
    return { fields: [h("p", { class: "small" }, "If the school or district approves, the school won't keep a copy of this work when you leave. You need evidence: a registration or patent number, or a link to the record."),
      h("label", { for: "cr-t" }, "Kind of right"), type, inp("cr-r", "Registration or patent number", { maxlength: 80 }), inp("cr-u", "Link to the record (https://…)", { type: "url", maxlength: 500 }),
      h("label", { for: "cr-s" }, "Statement"), stmt],
      value: () => { const g = id => document.getElementById(id).value.trim();
        if (!g("cr-r") && !g("cr-u")) { toast("Add a registration number or a link."); return undefined; }
        return { itemKind: it.kind, itemId: it.id, claimType: type.value, registration: g("cr-r") || null, evidenceUrl: g("cr-u") || null, statement: stmt.value.trim() }; } };
  }, "Send for review");
  if (!v) return;
  try { await api.post("/api/portfolio/claims", v); toast("Sent to your principal for review."); go("mywork", { push: false }); }
  catch (e) { toast({ invalid_claim: "Check the link and write a short statement (10+ characters).", already_exists: "There's already a claim on this work." }[e.body?.error] || "Couldn't send it."); }
}
async function copyLibraryItem(l) {
  if (l.kind === "coaching_plan") {
    try { await api.post(`/api/portfolio/library/${l.id}/copy`, {}); toast("Added to your coaching plans."); } catch { toast("Couldn't add it."); }
    return;
  }
  const courses = (await api.get("/api/learning/courses")).data.courses || [];
  if (!courses.length) return toast("Make a course first, then copy into it.");
  const v = await dialogForm(`Copy “${l.title}”`, () => {
    const unit = h("select", { id: "cl-u" });
    const fill = async id => { const d = (await safe(api.get(`/api/learning/courses/${id}`)))?.data; unit.replaceChildren(...(d?.units || []).map(u => h("option", { value: u.id }, u.title))); };
    const course = h("select", { id: "cl-c", onchange: () => fill(course.value) }, courses.map(c => h("option", { value: c.id }, c.title)));
    if (l.kind === "lesson") fill(courses[0].id);
    return { fields: [h("label", { for: "cl-c" }, "Course"), course, l.kind === "lesson" ? [h("label", { for: "cl-u" }, "Unit"), unit] : h("p", { class: "small muted" }, "It's added as a new unit at the end, with its lessons as drafts.")],
      value: () => ({ courseId: course.value, ...(l.kind === "lesson" ? { unitId: unit.value } : {}) }) };
  }, "Copy");
  if (!v) return;
  try { await api.post(`/api/portfolio/library/${l.id}/copy`, v); toast("Copied as a draft. Review it before publishing."); } catch { toast("Couldn't copy it."); }
}
VIEWS.portfolioreview = async () => {
  const [claims, imports] = await Promise.all([api.get("/api/portfolio/claims").then(r => r.data), api.get("/api/portfolio/imports").then(r => r.data)]);
  const pending = claims.filter(c => c.status === "pending"), approved = claims.filter(c => c.status === "approved");
  const decide = async (c, decision) => {
    const note = await ask({ title: decision === "approved" ? `Approve ${c.owner}'s ${c.claimType} claim?` : `Don't approve ${c.owner}'s claim?`,
      text: decision === "approved" ? "The school won't keep a copy of this work when they leave." : null, label: decision === "approved" ? "Note (what you checked)" : "Why not", confirm: decision === "approved" ? "Approve" : "Don't approve" });
    if (!note) return;
    try { await api.post(`/api/portfolio/claims/${c.id}/decision`, { decision, note }); toast("Saved."); go("portfolioreview", { push: false }); } catch { toast("Couldn't save it."); }
  };
  return [back("me", "Account"), h("h2", {}, "Teachers' work: rights and transfers"),
    h("section", { class: "card", "aria-label": "Rights claims to review" }, h("h3", {}, "Rights claims to review"),
      pending.length ? h("ul", { class: "list" }, pending.map(c => h("li", {}, h("b", {}, `${c.owner}: ${WORK_KIND[c.itemKind]} “${c.title}”`),
        h("p", { class: "small" }, `${c.claimType === "patent" ? "Patent" : "Copyright"}${c.registration ? ` · ${c.registration}` : ""}`, c.evidenceUrl ? [" · ", h("a", { href: c.evidenceUrl, target: "_blank", rel: "noopener noreferrer" }, "record")] : null),
        h("p", { class: "small muted" }, c.statement),
        h("div", { class: "btns" }, h("button", { class: "btn small primary", type: "button", "aria-label": `Approve claim: ${c.title}`, onclick: () => decide(c, "approved") }, "Approve"),
          h("button", { class: "btn small", type: "button", "aria-label": `Don't approve claim: ${c.title}`, onclick: () => decide(c, "rejected") }, "Don't approve")))))
        : empty("No claims waiting.")),
    approved.length ? h("section", { class: "card", "aria-label": "Works the school doesn't keep" }, h("h3", {}, "Works the school doesn't keep when the teacher leaves"),
      h("p", { class: "small muted" }, "Nothing is removed automatically. When the teacher leaves, retire or replace these."),
      h("ul", { class: "list small" }, approved.map(c => h("li", {}, `${c.owner}: ${WORK_KIND[c.itemKind]} “${c.title}” · approved by ${c.reviewedBy}`)))) : null,
    h("section", { class: "card", "aria-label": "Work brought in from other districts" }, h("h3", {}, "Work brought in from other districts"),
      imports.filter(i => i.status === "pending").length ? imports.filter(i => i.status === "pending").map(i => reviewImportCard(i)) : empty("Nothing waiting.")),
    state.me.role === "superintendent" ? await cloudSettingsCard() : null,
    await offloadLogCard()];
};
function reviewImportCard(i) {
  const pick = {};
  return h("div", { class: "stack" }, h("p", {}, h("b", {}, i.owner), ` from ${i.fromDistrict} · ${i.signed ? "signed package, checked" : "unsigned package, checked"}`),
    h("ul", { class: "list" }, i.items.map(x => h("li", {}, h("b", {}, `${WORK_KIND[x.kind]}: ${x.title}`),
      h("p", { class: "small muted" }, [x.approval ? `Approved at ${x.approval.district} by ${x.approval.by}` : "Not approved before", x.rights ? `Teacher's ${x.rights.type}` : ""].filter(Boolean).join(" · ")),
      h("div", { class: "btns", role: "group", "aria-label": `Decision: ${x.title}` }, ["approved", "rejected"].map(d => h("label", { class: "check" },
        h("input", { type: "radio", name: `imp-${i.id}-${x.index}`, value: d, onchange: () => { pick[x.index] = d; } }), d === "approved" ? " Approve" : " Don't approve")))))),
    h("button", { class: "btn primary", type: "button", onclick: async () => {
      if (Object.keys(pick).length !== i.items.length) return toast("Decide every item.");
      try { await api.post(`/api/portfolio/imports/${i.id}/review`, { decisions: Object.entries(pick).map(([index, decision]) => ({ index: Number(index), decision })) });
        toast("Saved. Approved items are in the teacher's library."); go("portfolioreview", { push: false }); } catch { toast("Couldn't save it."); } } }, `Save decisions for ${i.owner}`));
}
// ---- TEACH-06: approved storage ----------------------------------------------
const STORAGE_KIND = { usb_drive: "USB drive", external_drive: "External drive", laptop: "Laptop", other: "Other" };
const STORAGE_STATUS = { pending: ["expected", "Waiting for district IT"], approved: ["present", "Approved"], rejected: ["absent", "Not approved"], retired: ["absent", "Retired"] };
function storageCard(devices, storage, cloud) {
  const reload = () => go("mywork", { push: false });
  return h("section", { class: "card", "aria-label": "Approved storage" }, h("h3", {}, "Approved storage"),
    h("p", { class: "small muted" }, `Take your work off EduOS only to approved storage: a device district IT approved, or the district cloud${storage.cloudEnabled ? ` (kept ${storage.retentionDays} days)` : " (off in this district)"}. A file saved for a device opens only with that device's unlock code.`),
    devices.length ? h("ul", { class: "list" }, devices.map(d => h("li", { class: "row wrap" },
      h("span", { class: "grow" }, h("b", {}, d.name), h("span", { class: "small muted" }, ` · ${STORAGE_KIND[d.kind]}${d.serial ? ` · ${d.serial}` : ""}`)), chip(...STORAGE_STATUS[d.status]),
      d.status !== "retired" ? h("button", { class: "btn small", type: "button", "aria-label": `Retire: ${d.name}`, onclick: async () => {
        if (!(await ask({ title: `Retire ${d.name}?`, text: "You won't be able to save to it. Files already on it still open with its code.", confirm: "Retire" }))) return;
        try { await api.post(`/api/storage/devices/${d.id}/retire`, {}); toast("Retired."); reload(); } catch { toast("Couldn't retire it."); } } }, "Retire") : null)))
      : null,
    cloud.length ? h("p", { class: "small" }, `In the district cloud: ${cloud.map(c => `${new Date(c.storedAt).toLocaleDateString()} (${c.items} items, kept to ${String(c.keepUntil).slice(0, 10)})`).join(" · ")}`) : null,
    h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: requestStorageDevice }, "Ask to approve a device"),
      h("button", { class: "btn", type: "button", onclick: openPackageFile }, "Open a package file")));
}
async function requestStorageDevice() {
  const v = await dialogForm("Ask to approve a storage device", () => {
    const kind = h("select", { id: "sd-k" }, Object.entries(STORAGE_KIND).map(([k, t]) => h("option", { value: k }, t)));
    return { fields: [h("p", { class: "small muted" }, "District IT checks the device. When it's approved you get an unlock code to keep with it."),
      h("label", { for: "sd-n" }, "Name"), h("input", { id: "sd-n", required: true, maxlength: 80, placeholder: "e.g. Blue USB drive" }), h("label", { for: "sd-k" }, "Kind"), kind,
      h("label", { for: "sd-s" }, "Serial number (optional)"), h("input", { id: "sd-s", maxlength: 80 })],
      value: () => ({ name: document.getElementById("sd-n").value.trim(), kind: kind.value, serial: document.getElementById("sd-s").value.trim() || null }) };
  }, "Send to district IT");
  if (!v) return;
  try { await api.post("/api/storage/devices", v); toast("Sent to district IT."); go("mywork", { push: false }); } catch { toast("Couldn't send it."); }
}
async function offloadPackage(p, approved, storage, cloud) {
  const inCloud = cloud.some(c => c.packageId === p.id);
  const options = [...approved.map(d => [d.id, `${d.name} (${STORAGE_KIND[d.kind]})`]), ...(storage.cloudEnabled && !inCloud ? [["cloud", "The district cloud"]] : [])];
  if (!options.length) return toast(storage.cloudEnabled ? "Ask district IT to approve a device first." : "You have no approved storage yet. Ask district IT to approve a device.");
  const pick = await dialogForm("Save to approved storage", () => {
    const sel = h("select", { id: "of-t" }, options.map(([v, t]) => h("option", { value: v }, t)));
    return { fields: [h("label", { for: "of-t" }, "Where"), sel, h("p", { class: "small muted" }, "For a device, a file downloads: save it to that device. It opens only with the device's unlock code.")], value: () => sel.value };
  }, "Save");
  if (!pick) return;
  try {
    const r = (await api.post(`/api/portfolio/packages/${p.id}/offload`, pick === "cloud" ? { target: "cloud" } : { target: "device", deviceId: pick })).data;
    if (r.target === "cloud") { toast("Saved to the district cloud."); return go("mywork", { push: false }); }
    const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(r.file)], { type: "application/json" })), download: r.filename });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Downloaded for ${r.device}. Save it to that device.`);
  } catch (e) { toast({ storage_not_approved: "That device isn't approved.", district_cloud_off: "The district cloud is off.", already_exists: "It's already in the district cloud." }[e.body?.error] || "Couldn't save it."); }
}
async function openPackageFile() {
  const v = await dialogForm("Open a package file", () => {
    const f = h("input", { id: "pf-f", type: "file", accept: ".json,application/json", required: true });
    const code = h("input", { id: "pf-c", required: true, autocomplete: "off", class: "mono", placeholder: "xxxx-xxxx-…" });
    return { fields: [h("p", { class: "small muted" }, "A package file from approved storage, from this EduOS or another. You'll need the unlock code of the device it was saved for."),
      h("label", { for: "pf-f" }, "File"), f, h("label", { for: "pf-c" }, "Device unlock code"), code],
      value: async () => { const file = f.files?.[0]; if (!file) { toast("Choose the file."); return undefined; }
        if (file.size > 12 * 1024 * 1024) { toast("That file is too large."); return undefined; }
        try { return { file: JSON.parse(await file.text()), code: code.value.trim() }; } catch { toast("That isn't a package file."); return undefined; } } };
  }, "Open");
  if (!v) return;
  try { const r = (await api.post("/api/portfolio/files/open", v)).data;
    toast(`Opened: ${r.items} item${r.items === 1 ? "" : "s"}${r.signed ? ", signature checked" : ", not signed"}. Bring it into this district below.`); go("mywork", { push: false }); }
  catch (e) { toast({ wrong_code_or_damaged_file: "Wrong unlock code, or the file is damaged.", package_failed_its_check: "This package failed its check." }[e.body?.error] || (e.status === 429 ? "Too many tries. Wait a few minutes." : "Couldn't open it.")); }
}
async function storageReviewCard() {
  const list = (await api.get("/api/storage/devices")).data;
  const pending = list.filter(d => d.status === "pending");
  const decide = async (d, decision) => {
    const note = decision === "approved"
      ? await ask({ title: `Approve ${d.owner}'s ${d.name}?`, text: "You'll see the device's unlock code once, to give the teacher with the device.", confirm: "Approve" })
      : await ask({ title: `Don't approve ${d.owner}'s ${d.name}?`, label: "Why not", confirm: "Don't approve" });
    if (!note) return;
    try { const r = (await api.post(`/api/storage/devices/${d.id}/decision`, { decision, note: typeof note === "string" ? note : null })).data;
      if (r.unlockCode) await dialogForm(`Unlock code: ${d.name}`, () => ({ fields: [h("p", { class: "small" }, r.note), h("p", { class: "code mono", style: "font-size:1.2rem" }, r.unlockCode),
        h("button", { class: "btn small", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(r.unlockCode); toast("Copied."); } catch {} } }, "Copy code")], value: () => undefined }), null);
      go("devices", { push: false }); } catch { toast("Couldn't save it."); }
  };
  return h("section", { class: "card", "aria-label": "Teachers' storage devices" }, h("h3", {}, "Teachers' storage devices"),
    h("p", { class: "small muted" }, "Teachers take their work off EduOS only to approved storage. Approving makes the device's unlock code, shown once."),
    pending.length ? h("ul", { class: "list" }, pending.map(d => h("li", {}, h("b", {}, `${d.owner}: ${d.name}`), h("span", { class: "small muted" }, ` · ${STORAGE_KIND[d.kind]}${d.serial ? ` · ${d.serial}` : ""}`),
      h("div", { class: "btns" }, h("button", { class: "btn small primary", type: "button", "aria-label": `Approve storage: ${d.name}`, onclick: () => decide(d, "approved") }, "Approve"),
        h("button", { class: "btn small", type: "button", "aria-label": `Don't approve storage: ${d.name}`, onclick: () => decide(d, "rejected") }, "Don't approve"))))) : empty("No storage devices waiting."),
    list.filter(d => d.status === "approved").length ? h("p", { class: "small" }, `Approved: ${list.filter(d => d.status === "approved").map(d => `${d.owner} (${d.name})`).join(", ")}`) : null);
}
async function offloadLogCard() {
  const log = (await api.get("/api/storage/offloads")).data;
  return h("section", { class: "card", "aria-label": "Work taken off EduOS" }, h("h3", {}, "Work taken off EduOS"),
    log.length ? h("ul", { class: "list small" }, log.slice(0, 50).map(o => h("li", {}, `${o.owner}: ${o.items} items to ${o.target === "cloud" ? "the district cloud" : o.device} · ${new Date(o.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`)))
      : empty("Nothing yet."));
}
async function cloudSettingsCard() {
  const s = (await api.get("/api/storage/settings")).data;
  const on = h("input", { id: "cs-on", type: "checkbox", checked: s.cloudEnabled }), days = h("input", { id: "cs-d", type: "number", min: 30, max: 3650, value: s.retentionDays });
  return h("section", { class: "card", "aria-label": "District cloud" }, h("h3", {}, "District cloud"),
    h("p", { class: "small muted" }, "When on, teachers can keep copies of their packages with the district (never student information)."),
    h("label", { class: "check" }, on, " Teachers may save packages to the district cloud"), h("label", { for: "cs-d" }, "Keep copies for (days)"), days,
    h("button", { class: "btn", type: "button", onclick: async () => {
      try { await api.put("/api/storage/settings", { cloudEnabled: on.checked, retentionDays: Number(days.value) }); toast("Saved."); } catch { toast("Use 30 to 3650 days."); } } }, "Save"));
}
// ---- SPORTS-01: MaxPreps and Hudl, by link and by file, with family opt-in ----
const SPORT_SERVICES = [["maxpreps", "MaxPreps"], ["hudl", "Hudl"]];
async function sportsShareDialog(a, manages) {
  const [links, film] = await Promise.all([api.get(`/api/activities/${a.id}/links`).then(r => r.data), safe(api.get(`/api/activities/${a.id}/film`).then(r => r.data), [])]);
  const sum = manages ? (await safe(api.get(`/api/activities/${a.id}/exports`)))?.data : null;
  const cx = manages ? (await safe(api.get(`/api/activities/${a.id}/connectors`)))?.data : null;
  const download = async (service, kind) => {
    try {
      const r = await fetch(`/api/activities/${a.id}/exports/${service}/${kind}.csv`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob(), name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") || "")?.[1] || `${service}-${kind}.csv`;
      const link = h("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      const w = Number(r.headers.get("x-withheld-count") || 0);
      toast(kind === "roster" && w ? `Downloaded. ${w} athlete${w === 1 ? "" : "s"} left out: no family opt-in.` : "Downloaded. Upload it on the site.");
    } catch { toast("Couldn't download it."); }
  };
  await dialogForm(`MaxPreps & Hudl: ${a.title}`, done => ({ fields: [
    h("h3", {}, "Team pages"),
    links.length ? h("ul", { class: "list" }, links.map(l => h("li", {}, h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, `${a.title} on ${l.name}`)))) : h("p", { class: "small muted" }, "No team pages linked yet."),
    film.length ? [h("h3", {}, "Game film"), h("ul", { class: "list" }, film.map(f => h("li", {}, h("a", { href: f.url, target: "_blank", rel: "noopener noreferrer" }, f.title), f.event ? h("span", { class: "small muted" }, ` · ${f.event}`) : null)))] : null,
    cx?.connectors?.length ? connectorPanel(a, cx, () => { done(null); sportsShareDialog(a, manages); }) : null,
    manages ? [
      ...SPORT_SERVICES.map(([sv, name]) => { const cur = links.find(l => l.service === sv);
        return h("form", { class: "row wrap", onsubmit: async e => { e.preventDefault(); const url = e.target.elements[0].value.trim();
          try { await api.put(`/api/activities/${a.id}/links/${sv}`, { url }); toast("Saved."); done(null); sportsShareDialog(a, manages); }
          catch (err) { toast(err.body?.error === "link_must_be_on_that_service" ? `Use a link on ${name}'s site.` : "Couldn't save it."); } } },
          h("div", { class: "grow" }, h("label", { for: `sl-${sv}` }, `${name} team page`), h("input", { id: `sl-${sv}`, type: "url", maxlength: 500, value: cur?.url || "", placeholder: `https://www.${sv}.com/…` })),
          h("button", { class: "btn small", type: "submit", "aria-label": `Save ${name} link` }, "Save")); }),
      h("h3", {}, "Files to upload"),
      h("p", { class: "small muted" }, "Download a file here and upload it on MaxPreps or Hudl yourself; neither site connects to EduOS. A roster file includes only athletes whose family opted in for that site. If your team uses Hudl, MaxPreps takes its roster and schedule from Hudl."),
      ...SPORT_SERVICES.map(([sv, name]) => h("div", { class: "stack" }, h("p", { class: "small" }, h("b", {}, name), sum ? ` · roster: ${sum.services[sv].included} opted in, ${sum.services[sv].withheld} not` : ""),
        h("div", { class: "btns" }, h("button", { class: "btn small", type: "button", "aria-label": `${name} roster file`, onclick: () => download(sv, "roster") }, `${name} roster file`),
          h("button", { class: "btn small", type: "button", "aria-label": `${name} schedule file`, onclick: () => download(sv, "schedule") }, `${name} schedule file`)))),
      sum?.log?.length ? h("p", { class: "small muted" }, `Last file: ${sum.log[0].by}, ${new Date(sum.log[0].at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`) : null
    ] : null], value: () => undefined }), null);
}
async function familySharingCard() {
  const kids = (await safe(api.get("/api/family/sports-sharing")))?.data || [];
  if (!kids.some(k => k.teams.length)) return null;
  return h("section", { class: "card", "aria-label": "Sharing with MaxPreps and Hudl" }, h("h3", {}, "Sharing with MaxPreps and Hudl"),
    h("p", { class: "small muted" }, "Coaches post rosters on these sports sites. Your child is included only if you say yes: name, jersey number, grade and position. You can change this any time."),
    h("ul", { class: "list" }, kids.filter(k => k.teams.length).map(k => h("li", {}, h("b", {}, k.name), h("span", { class: "small muted" }, ` · ${k.teams.join(", ")}`),
      h("div", { class: "btns" }, SPORT_SERVICES.map(([sv, name]) => h("label", { class: "check" },
        h("input", { type: "checkbox", checked: Boolean(k[sv]), onchange: async e => {
          try { await api.put(`/api/family/sports-sharing/${k.studentId}`, { [sv]: e.target.checked }); toast(e.target.checked ? `${first(k.name)} can be on ${name} rosters.` : `${first(k.name)} won't be on ${name} rosters.`); }
          catch { e.target.checked = !e.target.checked; toast("Couldn't save it."); } } }), ` Share with ${name}`)))))));
}
// ---- SPORTS-02: MaxPreps / Hudl connectors with the school's own account ----
const CONN_STATUS = { pending: ["expected", "Waiting for district IT"], approved: ["present", "On"], rejected: ["absent", "Not approved"], paused: ["expected", "Paused"] };
const CONN_ACTIONS = [["sendRoster", "Send the roster (opted-in athletes only)"], ["sendSchedule", "Send the schedule and scores"], ["pullResults", "Bring results and team stats in (you approve)"], ["pullFilm", "Bring game film links in (Hudl)"]];
const RUN_TEXT = { send_roster: "Roster sent", send_schedule: "Schedule sent", pull_results: "Results brought in", pull_film: "Film links brought in" };
async function connectorsCard() {
  const list = (await safe(api.get("/api/sports/connectors")))?.data || [];
  const it = state.me.role === "it_admin";
  const act = async (k, verb, msg) => { try { await api.post(`/api/sports/connectors/${k.id}/${verb}`, {}); toast(msg); go(state.tab, { push: false }); } catch { toast("Couldn't do that."); } };
  return h("section", { class: "card", "aria-label": "MaxPreps and Hudl connectors" }, h("h3", {}, "MaxPreps and Hudl connectors"),
    h("p", { class: "small muted" }, it ? "Schools connect their own MaxPreps or Hudl account with the key the vendor gave them. Nothing moves until you approve. Keys are encrypted and never shown."
      : "Connect your school's MaxPreps or Hudl account with the key the vendor gave it. District IT approves before anything moves. Only opted-in athletes are sent; results come back for coaches to approve."),
    list.length ? h("ul", { class: "list" }, list.map(k => h("li", {}, h("div", { class: "row wrap" }, h("b", { class: "grow" }, `${k.name}${it ? ` · ${k.school}` : ""}`), chip(...CONN_STATUS[k.status])),
      h("p", { class: "small muted" }, `${CONN_ACTIONS.filter(([f]) => k[f]).map(([, t]) => t.replace(/ \(.*\)$/, "")).join(" · ")} · key ${k.keyHint} · asked by ${k.requestedBy}`),
      k.note ? h("p", { class: "small muted" }, `District IT: ${k.note}`) : null,
      h("div", { class: "btns" },
        it && k.status === "pending" ? [h("button", { class: "btn small primary", type: "button", "aria-label": `Approve ${k.name}${it ? ` for ${k.school}` : ""}`, onclick: async () => {
            const note = await ask({ title: `Approve the ${k.name} connector for ${k.school}?`, text: `It may: ${CONN_ACTIONS.filter(([f]) => k[f]).map(([, t]) => t).join("; ")}. Calls go only to ${k.baseUrl}.`, confirm: "Approve" });
            if (!note) return; try { await api.post(`/api/sports/connectors/${k.id}/decision`, { decision: "approved" }); toast("Approved."); go(state.tab, { push: false }); } catch { toast("Couldn't approve it."); } } }, "Approve"),
          h("button", { class: "btn small", type: "button", "aria-label": `Don't approve ${k.name} for ${k.school}`, onclick: async () => {
            const note = await ask({ title: `Don't approve ${k.name} for ${k.school}?`, label: "Why not", confirm: "Don't approve" });
            if (!note) return; try { await api.post(`/api/sports/connectors/${k.id}/decision`, { decision: "rejected", note }); toast("Saved."); go(state.tab, { push: false }); } catch { toast("Couldn't save it."); } } }, "Don't approve")] : null,
        k.status === "approved" ? h("button", { class: "btn small", type: "button", "aria-label": `Pause ${k.name}`, onclick: () => act(k, "pause", "Paused.") }, "Pause") : null,
        k.status === "paused" ? h("button", { class: "btn small", type: "button", "aria-label": `Resume ${k.name}`, onclick: () => act(k, "resume", "Resumed.") }, "Resume") : null,
        !it ? h("button", { class: "btn small", type: "button", "aria-label": `Change ${k.name} key or settings`, onclick: () => editConnector(k) }, "Change") : null,
        h("button", { class: "btn small", type: "button", "aria-label": `Disconnect ${k.name}`, onclick: async () => {
          if (await ask({ title: `Disconnect ${k.name}?`, text: "The key is no longer used. Teams keep their files and links.", confirm: "Disconnect", danger: true })) act(k, "revoke", "Disconnected."); } }, "Disconnect")))))
      : h("p", { class: "small muted" }, "No accounts connected."),
    !it ? h("button", { class: "btn", type: "button", onclick: () => editConnector(null) }, "Connect an account") : null);
}
async function editConnector(k) {
  const v = await dialogForm(k ? `Change ${k.name}` : "Connect a MaxPreps or Hudl account", () => {
    const svc = h("select", { id: "cn-s", disabled: !!k }, SPORT_SERVICES.map(([sv, name]) => h("option", { value: sv, selected: (k?.service || "maxpreps") === sv }, name)));
    const boxes = CONN_ACTIONS.map(([f, t]) => h("label", { class: "check" }, h("input", { type: "checkbox", value: f, checked: k ? k[f] : f !== "pullFilm" }), ` ${t}`));
    return { fields: [h("label", { for: "cn-s" }, "Site"), svc,
      h("label", { for: "cn-u" }, "Connection address (from the vendor)"), h("input", { id: "cn-u", type: "url", required: true, maxlength: 300, value: k?.baseUrl || "", placeholder: "https://…maxpreps.com/… or https://…hudl.com/…" }),
      h("label", { for: "cn-k" }, k ? "New key (leave blank to keep the current one)" : "Access key or partner token"), h("input", { id: "cn-k", type: "password", autocomplete: "off", maxlength: 4000, required: !k }),
      h("fieldset", { class: "caps" }, h("legend", {}, "What it does"), boxes),
      h("p", { class: "small muted" }, "District IT approves before anything moves. Changing the key or what it does needs approving again.")],
      value: () => { const g = id => document.getElementById(id).value.trim();
        const flags = Object.fromEntries(CONN_ACTIONS.map(([f]) => [f, boxes.find(b => b.querySelector("input").value === f).querySelector("input").checked]));
        return { service: svc.value, baseUrl: g("cn-u"), ...(g("cn-k") ? { key: g("cn-k") } : {}), ...flags }; } };
  }, k ? "Save" : "Send to district IT");
  if (!v) return;
  try { await (k ? api.put(`/api/sports/connectors/${k.id}`, v) : api.post("/api/sports/connectors", v)); toast("Sent to district IT for approval."); go(state.tab, { push: false }); }
  catch (e) { toast({ invalid_connector: "Check the address (on the vendor's site), the key, and choose what it does. Film is Hudl only.", already_exists: "That site is already connected.",
    connectors_need_integrations_key: "Connectors aren't set up on this EduOS yet. Ask district IT.", sports_leads_only: "Only the principal, vice principal or athletic director connects accounts." }[e.body?.error] || "Couldn't save it."); }
}
function connectorPanel(a, cx, reopen) {
  return [h("h3", {}, "Connected accounts"),
    ...cx.connectors.map(k => h("div", { class: "stack" },
      h("div", { class: "row wrap" }, h("b", { class: "grow" }, k.name), chip(...CONN_STATUS[k.status])),
      h("form", { class: "row wrap", onsubmit: async e => { e.preventDefault();
          try { await api.put(`/api/activities/${a.id}/connectors/${k.service}/team`, { externalTeamId: e.target.elements[0].value.trim() }); toast("Saved."); reopen(); } catch { toast("Use the team ID from the site (letters, numbers, - _ . :)."); } } },
        h("div", { class: "grow" }, h("label", { for: `cx-${k.service}` }, `Team ID on ${k.name}`), h("input", { id: `cx-${k.service}`, maxlength: 80, value: k.externalTeamId || "" })),
        h("button", { class: "btn small", type: "submit", "aria-label": `Save ${k.name} team ID` }, "Save")),
      k.status === "approved" && k.externalTeamId ? h("button", { class: "btn small primary", type: "button", "aria-label": `Sync now with ${k.name}`, onclick: async () => {
        try { const r = (await api.post(`/api/activities/${a.id}/connectors/${k.service}/sync`, {})).data;
          toast(r.results.map(x => x.ok ? `${RUN_TEXT[x.action]}: ${x.count}${x.withheld ? ` (${x.withheld} not opted in)` : ""}`
            : x.offered === false ? `${RUN_TEXT[x.action].split(" ")[0]}: not offered by this account` : `${RUN_TEXT[x.action]}: failed`).join(" · ")); reopen(); }
        catch (e) { toast(e.status === 429 ? "Wait a minute before syncing again." : "Couldn't sync."); } } }, "Sync now") : null)),
    cx.waiting.length ? [h("h4", {}, "Results to approve"), h("ul", { class: "list" }, cx.waiting.map(w => h("li", {},
      h("b", {}, `${w.event} (${w.date}): ${w.homeScore}–${w.awayScore} vs ${w.opponent}`), h("span", { class: "small muted" }, ` · from ${SPORT_SERVICES.find(([s]) => s === w.service)?.[1]}`),
      Object.keys(w.teamStats).length ? h("p", { class: "small" }, Object.entries(w.teamStats).map(([k2, v2]) => `${k2} ${v2}`).join(", ")) : null,
      h("div", { class: "btns" }, h("button", { class: "btn small primary", type: "button", "aria-label": `Approve result: ${w.event}`, onclick: async () => {
          try { await api.post(`/api/sports/inbound/${w.id}/decision`, { decision: "approved" }); toast("Saved as a draft result. Publish it as usual."); reopen(); }
          catch (e) { toast(e.body?.error === "result_already_recorded" ? "A result is already recorded for that game." : "Couldn't save it."); } } }, "Approve"),
        h("button", { class: "btn small", type: "button", "aria-label": `Reject result: ${w.event}`, onclick: async () => {
          try { await api.post(`/api/sports/inbound/${w.id}/decision`, { decision: "rejected" }); toast("Rejected."); reopen(); } catch { toast("Couldn't save it."); } } }, "Reject")))))] : null,
    cx.film.filter(f => !f.hidden).length ? [h("h4", {}, "Film links shown on the team page"), h("ul", { class: "list" }, cx.film.filter(f => !f.hidden).map(f => h("li", { class: "row wrap" },
      h("span", { class: "grow" }, f.title), h("button", { class: "btn small", type: "button", "aria-label": `Hide film: ${f.title}`, onclick: async () => {
        try { await api.post(`/api/sports/film/${f.id}/hide`, {}); toast("Hidden."); reopen(); } catch { toast("Couldn't hide it."); } } }, "Hide"))))] : null,
    cx.runs.length ? (() => { const recent = cx.runs.slice(0, 4), failed = recent.find(r => !r.ok && r.message !== "not offered by this account"), missing = recent.filter(r => r.message === "not offered by this account");
      return h("p", { class: "small muted" }, `Last sync: ${cx.runs[0].by}, ${new Date(cx.runs[0].at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
        missing.length ? ` · not offered by this account: ${missing.map(r => RUN_TEXT[r.action].split(" ")[0].toLowerCase()).join(", ")}` : "", failed ? ` · something failed: ${failed.message}` : ""); })() : null];
}
// ---- RANK-01: the U.S. News indicators dashboard ----------------------------
const fmtVal = (k, v) => typeof v === "number" && !/rank/i.test(k) ? `${v}${["Gap"].includes(k) ? " pts" : "%"}` : String(v);
VIEWS.rankings = async () => {
  const defs = (await api.get("/api/rankings/indicators")).data;
  if (state.me.role !== "superintendent" && !state.rankSchool) state.rankSchool = state.me.schoolId;
  if (!state.rankSchool) {
    const d = (await api.get(`/api/rankings/schools${state.rankYear ? `?year=${state.rankYear}` : ""}`)).data;
    return [back("me", "Account"), h("h2", {}, "U.S. News indicators"), h("p", { class: "small muted" }, defs.note),
      d.years.length > 1 ? h("div", { class: "btns", role: "group", "aria-label": "School year" }, d.years.map(y => h("button", { class: `btn small${y === d.year ? " primary" : ""}`, type: "button", "aria-pressed": String(y === d.year), onclick: () => openView("rankings", { rankYear: y }) }, y))) : null,
      h("section", { class: "card", "aria-label": "Schools" }, h("h3", {}, d.year ? `Figures for ${d.year}` : "No figures yet"),
        h("ul", { class: "list" }, d.schools.map(x => h("li", {},
          h("div", { class: "row wrap" }, h("b", { class: "grow" }, x.name), chip(x.entered === 6 ? "present" : "expected", `${x.entered} of 6 · ${x.weightCovered}% of the weight`),
            x.verified ? chip("present", `${x.verified} verified`) : null),
          x.missing.length ? h("p", { class: "small muted" }, `Missing: ${x.missing.map(k => defs.indicators.find(i => i.key === k).name).join(", ")}`) : null,
          h("button", { class: "btn small", type: "button", "aria-label": `Open: ${x.name}`, onclick: () => openView("rankings", { rankSchool: x.id }) }, "Open")))))];
  }
  const d = (await api.get(`/api/rankings/schools/${state.rankSchool}`)).data;
  const latest = d.years[0] || null;
  const canEnter = ["principal", "superintendent"].includes(state.me.role), supt = state.me.role === "superintendent";
  const card = (ind, def) => {
    const cur = ind.byYear[0], prev = ind.byYear[1];
    return h("section", { class: "card", "aria-label": ind.name },
      h("div", { class: "row wrap" }, h("h3", { class: "grow" }, ind.name), ind.weight != null ? chip("expected", `${ind.weight}% of the ranking`) : null),
      h("p", { class: "small muted" }, def.about),
      cur ? [h("div", { class: "stats" }, Object.entries(cur.shown).map(([k, v]) => stat(fmtVal(k, v), k))),
        prev ? h("p", { class: "small muted" }, `${prev.year}: ${Object.entries(prev.shown).map(([k, v]) => `${k} ${fmtVal(k, v)}`).join(" · ")}`) : null,
        h("p", { class: "small" }, `${cur.year} · source: `, cur.sourceUrl ? h("a", { href: cur.sourceUrl, target: "_blank", rel: "noopener noreferrer" }, cur.sourceNote || "link") : cur.sourceNote,
          ` · entered by ${cur.enteredBy}`),
        cur.verifiedBy ? chip("present", `Verified by ${cur.verifiedBy}`) : chip("expected", "Not verified yet"),
        supt && !cur.verifiedBy && cur.enteredBy !== state.me.displayName ? h("button", { class: "btn small", type: "button", "aria-label": `Verify: ${ind.name}`, onclick: async () => {
          try { await api.post(`/api/rankings/entries/${cur.id}/verify`, {}); toast("Verified."); go("rankings", { push: false }); }
          catch (e) { toast(e.body?.error === "someone_else_verifies" ? "Someone else verifies what you entered." : "Couldn't verify it."); } } }, "Verify") : null]
        : h("p", { class: "small muted" }, "No figures yet."),
      canEnter ? h("button", { class: "btn small primary", type: "button", "aria-label": `Enter figures: ${ind.name}`, onclick: () => enterRanking(d, ind, def, latest) }, "Enter figures") : null);
  };
  return [supt ? h("button", { class: "btn back", type: "button", onclick: () => openView("rankings", { rankSchool: null }) }, "‹ All schools") : back("me", "Account"),
    h("h2", {}, `${d.name}: U.S. News indicators`), h("p", { class: "small muted" }, defs.note),
    d.changesKept ? h("p", { class: "small muted" }, `${d.changesKept} earlier figure${d.changesKept === 1 ? " is" : "s are"} kept as history.`) : null,
    ...d.indicators.filter(i => i.key !== "published_rank").map(ind => card(ind, defs.indicators.find(x => x.key === ind.key))),
    card(d.indicators.find(i => i.key === "published_rank"), defs.published)];
};
async function enterRanking(d, ind, def, latest) {
  const thisYear = (() => { const n = new Date(), y = n.getMonth() >= 6 ? n.getFullYear() : n.getFullYear() - 1; return `${y}-${String((y + 1) % 100).padStart(2, "0")}`; })();
  const cur = ind.byYear[0];
  const v = await dialogForm(`${ind.name}: ${d.name}`, () => {
    const year = h("input", { id: "rk-y", required: true, pattern: "\\d{4}-\\d{2}", value: latest || thisYear, placeholder: "2025-26" });
    const inputs = def.fields.map(f => [h("label", { for: `rk-${f.key}` }, f.label), h("input", { id: `rk-${f.key}`, ...(f.key === "note" ? { maxlength: 300 } : { type: "number", step: "any", min: 0 }), value: cur?.values?.[f.key] ?? "" })]);
    return { fields: [h("p", { class: "small muted" }, def.about), h("label", { for: "rk-y" }, "School year (data year)"), year, ...inputs,
      h("label", { for: "rk-su" }, "Source link (https://…)"), h("input", { id: "rk-su", type: "url", maxlength: 500 }),
      h("label", { for: "rk-sn" }, "Or name the source"), h("input", { id: "rk-sn", maxlength: 300, placeholder: "e.g. State report card 2024-25, AP school report" }),
      h("p", { class: "small muted" }, "Every figure needs its source. The superintendent verifies it; a change needs verifying again.")],
      value: () => { const g = id => document.getElementById(id)?.value.trim() ?? "";
        const values = Object.fromEntries(def.fields.map(f => [f.key, f.key === "note" ? g(`rk-${f.key}`) : g(`rk-${f.key}`) === "" ? null : Number(g(`rk-${f.key}`))]));
        if (!g("rk-su") && !g("rk-sn")) { toast("Add the source."); return undefined; }
        return { year: g("rk-y"), body: { values, sourceUrl: g("rk-su") || null, sourceNote: g("rk-sn") || null } }; } };
  }, "Save");
  if (!v) return;
  try { await api.put(`/api/rankings/schools/${d.id}/${v.year}/${ind.key}`, v.body); toast("Saved. It needs verifying."); go("rankings", { push: false }); }
  catch (e) { toast({ check_the_figures: "Check the figures: counts can't be larger than the total, and percentages are 0 to 100.", invalid_entry: "Use a school year like 2025-26.",
    invalid_source: "The source link must start with https://." }[e.body?.error] || "Couldn't save it."); }
}
// ---- MEDIA-01: photos on history items --------------------------------------
// Photos load through EduOS (/api/history/photos/:id), which checks the viewer
// and redirects to a 60-second private link; lazy, with the uploader's description.
function photoStrip(photos) {
  if (!photos?.length) return null;
  return h("div", { class: "photo-strip" }, photos.map(p => h("figure", {},
    h("img", { src: `/api/history/photos/${p.id}`, alt: p.alt, loading: "lazy", decoding: "async", width: p.width || undefined, height: p.height || undefined, style: "max-width:100%;height:auto;border-radius:8px" }),
    p.caption ? h("figcaption", { class: "small muted" }, p.caption) : null)));
}
function photoAdder(entryId, path = `/api/history/entries/${entryId}/photos`, after = () => go(state.tab, { push: false })) {
  const key = `ph-${entryId.slice(0, 8)}`;
  const file = h("input", { id: `${key}-f`, type: "file", accept: "image/jpeg,image/png,image/webp" });
  const alt = h("input", { id: `${key}-a`, maxlength: 300, placeholder: "What's in the photo (for people who can't see it)" });
  const cap = h("input", { id: `${key}-c`, maxlength: 500 });
  return h("details", { class: "card" }, h("summary", {}, "Add a photo"),
    h("p", { class: "small muted" }, "JPEG, PNG or WebP. EduOS checks it for malware and removes the location and camera details before anyone can see it. Don't include other students."),
    h("label", { for: `${key}-f` }, "Photo"), file, h("label", { for: `${key}-a` }, "Description (required)"), alt, h("label", { for: `${key}-c` }, "Caption (optional)"), cap,
    h("button", { class: "btn small", type: "button", onclick: async e => {
      const f = file.files?.[0];
      if (!f) return toast("Choose a photo.");
      if (alt.value.trim().length < 3) return toast("Describe the photo.");
      e.target.disabled = true;
      try {
        if (!api.csrf) await api.get("/api/csrf").then(r => { api.csrf = r.csrfToken; }).catch(() => {});
        const r = await fetch(`${path}?alt=${encodeURIComponent(alt.value.trim())}&caption=${encodeURIComponent(cap.value.trim())}`, {
          method: "POST", credentials: "same-origin", body: f, headers: { "content-type": f.type, "x-csrf-token": api.csrf || "", "idempotency-key": crypto.randomUUID().replace(/-/g, "") } });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) {
          const why = { photos_not_enabled: "Photos aren't turned on for this district.", photo_too_large: "That photo is too large.", too_many_photos: "This item has as many photos as it can.",
            student_storage_full: "This student's history is full.", photo_failed_security_scan: "This file didn't pass the security check.", image_type_mismatch: "That file isn't the kind of image it says it is.",
            not_a_valid_image: "That file isn't a photo EduOS can read.", media_storage_not_configured: "Photo storage isn't set up yet.", unsupported_media_type: "Use a JPEG, PNG or WebP photo." };
          return toast(why[out.error] || "Couldn't add the photo.");
        }
        toast("Photo added."); await after();
      } catch { toast("Couldn't add the photo."); } finally { e.target.disabled = false; }
    } }, "Upload"));
}
async function mediaPolicyCard() {
  const d = (await safe(api.get("/api/history/media-policy")))?.data;
  if (!d?.canEdit) return null;
  const mb = v => Math.round(v / 1048576);
  const on = h("input", { id: "mp-on", type: "checkbox", checked: d.imagesEnabled, disabled: !d.storageReady || undefined });
  const size = h("input", { id: "mp-size", type: "number", min: 1, max: 20, value: mb(d.maxImageBytes), style: "width:6em" });
  const per = h("input", { id: "mp-per", type: "number", min: 1, max: 20, value: d.maxPerEntry, style: "width:6em" });
  const total = h("input", { id: "mp-total", type: "number", min: 1, max: 5120, value: mb(d.maxBytesPerStudent), style: "width:7em" });
  return h("section", { class: "card", "aria-label": "Photos in student history" }, h("h3", {}, "Photos in student history"),
    !d.storageReady ? h("p", { class: "small muted" }, "District IT needs to connect private photo storage (S3-compatible) and the ClamAV malware scanner before photos can be turned on.") : null,
    h("label", { class: "check" }, on, " Allow photos on history items"),
    h("div", { class: "row wrap" }, h("div", {}, h("label", { for: "mp-size" }, "Largest photo (MB)"), size), h("div", {}, h("label", { for: "mp-per" }, "Photos per item"), per),
      h("div", {}, h("label", { for: "mp-total" }, "Per student in total (MB)"), total)),
    h("button", { class: "btn small", type: "button", onclick: async () => {
      try { await api.put("/api/history/media-policy", { imagesEnabled: on.checked, maxImageBytes: Number(size.value) * 1048576, maxPerEntry: Number(per.value), maxBytesPerStudent: Number(total.value) * 1048576 }); toast("Saved."); }
      catch { toast("Couldn't save it. Check the numbers."); } } }, "Save"));
}
// ---- TC-05: download a copy of a student's history -------------------------
function historyDownloadCard(studentId, role) {
  if (!["pupil", "parent", "principal", "superintendent"].includes(role)) return null;
  const get = async format => {
    try {
      const r = await fetch(`/api/history/export?studentId=${encodeURIComponent(studentId)}&format=${format}`, { credentials: "same-origin" });
      if (!r.ok) { const e = await r.json().catch(() => ({})); return toast(r.status === 429 ? "That's the download limit for now. Try again later." : e.error === "export_not_allowed" ? "You can view this history but not download it." : "Couldn't make the copy."); }
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") || "")?.[1] || `history.${format}`;
      const url = URL.createObjectURL(await r.blob());
      const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast("Downloaded. It's logged under Who looked.");
    } catch { toast("Couldn't make the copy."); }
  };
  return h("details", { class: "card" }, h("summary", {}, "Download a copy"),
    h("p", { class: "small muted" }, "A copy of the items you can see here, made now and saved to this device. There's no link to share, and the download shows under Who looked. Media files aren't included."),
    h("div", { class: "btns" }, h("button", { class: "btn small", type: "button", onclick: () => get("html") }, "Web page (to read or print)"),
      h("button", { class: "btn small", type: "button", onclick: () => get("json") }, "Data file (JSON)")));
}
// ---- TC-06: sending a student's history to another district ----------------
const TRANSFER_BASIS = { enrollment_request: "The new district asked (enrollment)", records_request: "A records request", family_request: "The family asked", other: "Other" };
const TRANSFER_STATUS = { awaiting_family: "Waiting for the family", ready: "Ready to send", cancelled: "Cancelled" };
async function downloadFile(url, fallback) {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw Object.assign(new Error(e.error || "failed"), { code: e.error }); }
  const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") || "")?.[1] || fallback;
  const href = URL.createObjectURL(await r.blob());
  const a = h("a", { href, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
async function transferCard(student) {
  const d = (await safe(api.get(`/api/students/${student.id}/history-transfers`)))?.data;
  if (!d) return null;
  const reload = () => go("historyprivacy", { push: false });
  const to = h("input", { id: "tr-to", maxlength: 200, placeholder: "e.g. Lakeside Unified School District" });
  const basis = h("select", { id: "tr-basis" }, Object.entries(TRANSFER_BASIS).map(([k, t]) => h("option", { value: k }, t)));
  const note = h("input", { id: "tr-note", maxlength: 500, placeholder: "e.g. Records request from Lakeside dated Nov 20" });
  const fam = h("input", { id: "tr-fam", type: "checkbox" });
  return h("section", { class: "card", "aria-label": "Transfer to another district" }, h("h3", {}, "Transfer to another district"),
    h("p", { class: "small muted" }, "Makes a signed file of this student's official records and teacher items (and family memories and portfolio, if the family agrees) for you to send through your usual records channel. Private notes and drafts never go. Nothing is sent automatically."),
    !d.signingReady ? h("p", { class: "small" }, "District IT needs to set HISTORY_TRANSFER_SIGNING_SECRET before transfers can be made.")
      : h("p", { class: "small" }, `This district's signing fingerprint: `, h("code", {}, d.keyFingerprint), ". Give it to the receiving district so they can confirm the file came from you."),
    d.transfers.length ? h("ul", { class: "list" }, d.transfers.map(t => h("li", {},
      h("div", { class: "row wrap" }, h("b", { class: "grow" }, t.receivingDistrict), chip(t.status === "ready" ? "present" : t.status === "cancelled" ? "absent" : "expected", TRANSFER_STATUS[t.status])),
      h("p", { class: "small muted" }, `${TRANSFER_BASIS[t.basis]}: ${t.note} · by ${t.requestedBy} · ${fmtDay(t.createdAt)}${t.includeFamily ? ` · family items: ${t.familyDecision === "approved" ? "agreed" : t.familyDecision === "declined" ? "declined (records only)" : "waiting"}` : ""}${t.items !== null ? ` · ${t.items} items` : ""}${t.downloads ? ` · downloaded ${t.downloads}×` : ""}`),
      t.status === "ready" ? h("div", { class: "btns" },
        h("button", { class: "btn small", type: "button", "aria-label": `Download transfer file: ${t.receivingDistrict}`, onclick: async () => {
          try { await downloadFile(`/api/history-transfers/${t.id}/package`, "history-transfer.json"); toast("Downloaded. Send it through your records channel."); reload(); } catch { toast("Couldn't make the file."); } } }, "Download transfer file"),
        h("button", { class: "btn small", type: "button", "aria-label": `Cancel transfer: ${t.receivingDistrict}`, onclick: async () => {
          const n = await ask({ title: "Cancel this transfer?", label: "Why", confirm: "Cancel transfer" }); if (!n) return;
          try { await api.post(`/api/history-transfers/${t.id}/cancel`, { note: n }); toast("Cancelled."); reload(); } catch { toast("Couldn't cancel it."); } } }, "Cancel")) : null))) : null,
    d.signingReady ? h("form", { class: "stack", onsubmit: async e => { e.preventDefault();
        try { await api.post(`/api/students/${student.id}/history-transfers`, { receivingDistrict: to.value.trim(), basis: basis.value, note: note.value.trim(), includeFamilyItems: fam.checked });
          toast(fam.checked ? "Started. The family has been asked about their items." : "Ready to download."); reload(); }
        catch { toast("Fill in the receiving district and the basis (at least 5 characters)."); } } },
      h("label", { for: "tr-to" }, "Receiving district"), to, h("label", { for: "tr-basis" }, "Basis"), basis, h("label", { for: "tr-note" }, "Details of the request"), note,
      h("label", { class: "check" }, fam, " Ask the family to include family memories and the student's portfolio"),
      h("button", { class: "btn", type: "submit" }, "Start transfer")) : null);
}
async function familyTransferCard(studentId) {
  const list = ((await safe(api.get("/api/family/history-transfers")))?.data || []).filter(t => t.studentId === studentId);
  if (!list.length) return null;
  return h("section", { class: "card", "aria-label": "Records transfer" }, h("h3", {}, "A records transfer needs your decision"),
    list.map(t => h("div", {}, h("p", {}, `${t.school} is sending ${t.studentName}'s school records to ${t.receivingDistrict} (${TRANSFER_BASIS[t.basis].toLowerCase()}: ${t.note}). Should family memories and ${first(t.studentName)}'s own portfolio go too? Private notes never go.`),
      h("div", { class: "btns" }, ["approve", "decline"].map(d => h("button", { class: d === "approve" ? "btn primary small" : "btn small", type: "button", onclick: async () => {
        try { await api.post(`/api/family/history-transfers/${t.id}`, { decision: d }); toast(d === "approve" ? "They'll go too." : "Only school records will go."); go(state.tab, { push: false }); } catch { toast("Couldn't save your answer."); } } },
        d === "approve" ? "Include them" : "School records only"))))));
}
// ---- TC-06b: receiving a student's history from another district ----------
const IMPORT_STATUS = { received: ["expected", "Check & choose student"], reviewing: ["expected", "Choosing items"], completed: ["present", "Done"], rejected: ["absent", "Rejected"] };
const IMPORT_ERRORS = { not_a_transfer_package: "That isn't a history transfer file.", malformed: "The file is damaged or not in the expected format.",
  altered: "The file was changed after it was signed. Ask the sending district for a new copy.", bad_signature: "The signature doesn't check out. Ask the sending district for a new copy.",
  received_elsewhere: "Another school in your district has already received this file." };
async function incomingTransfersCard() {
  const list = (await safe(api.get("/api/history-imports")))?.data;
  if (!list) return null;
  const file = h("input", { id: "hi-file", type: "file", accept: ".json,application/json" });
  return h("section", { class: "card", "aria-label": "Records from other districts" }, h("h3", {}, "Records from other districts"),
    h("p", { class: "small muted" }, "Upload a signed history transfer file you received from a student's previous district. Nothing is added until you confirm who sent it, choose the student and accept each item."),
    list.length ? h("ul", { class: "list" }, list.slice(0, 20).map(i => h("li", { class: "row wrap" },
      h("span", { class: "grow" }, h("b", {}, i.student.name), h("span", { class: "small muted" }, ` · from ${i.from.district} · ${fmtDay(i.receivedAt)} · ${i.items} items${i.localStudent ? ` · for ${i.localStudent.name}` : ""}`)),
      chip(...IMPORT_STATUS[i.status]),
      h("button", { class: "btn small", type: "button", "aria-label": `Open transfer: ${i.student.name}`, onclick: () => openView("historyimport", { historyImportId: i.id }) }, "Open")))) : null,
    h("form", { class: "row wrap", onsubmit: async e => { e.preventDefault();
        const f = file.files?.[0]; if (!f) return toast("Choose the file first.");
        if (f.size > 8 * 1024 * 1024) return toast("That file is too large.");
        let pkg; try { pkg = JSON.parse(await f.text()); } catch { return toast(IMPORT_ERRORS.not_a_transfer_package); }
        try { const d = (await api.post("/api/history-imports", pkg)).data; toast(d.existing ? "You've already received this file." : "Signature checked."); openView("historyimport", { historyImportId: d.id }); }
        catch (err) { toast(IMPORT_ERRORS[err.code || err.body?.error] || "Couldn't read that file."); } } },
      h("div", { class: "grow" }, h("label", { for: "hi-file" }, "Transfer file"), file), h("button", { class: "btn", type: "submit" }, "Check file")));
}
VIEWS.historyimport = async () => {
  if (!state.historyImportId) return VIEWS.history();
  const d = (await api.get(`/api/history-imports/${state.historyImportId}`)).data;
  const reload = () => go("historyimport", { push: false });
  const info = h("section", { class: "card", "aria-label": "About this file" }, h("h3", {}, "About this file"),
    h("ul", { class: "list small" },
      h("li", {}, `From ${d.from.district}${d.from.school ? `, ${d.from.school}` : ""}${d.addressedTo ? ` · addressed to ${d.addressedTo}` : ""}`),
      h("li", {}, `Student in the file: ${d.student.name}${d.student.number ? ` (${d.student.number})` : ""}${d.student.grade ? ` · grade ${d.student.grade}` : ""}`),
      h("li", {}, `Why it was sent: ${TRANSFER_BASIS[d.basis] || d.basis}${d.basisNote ? `: ${d.basisNote}` : ""}`),
      h("li", {}, `${d.items.length} items${d.includesFamily ? " (the family agreed to include family memories and the portfolio)" : " (school records only)"} · made ${fmtDay(d.packagedAt)}`),
      h("li", {}, `Received by ${d.receivedBy} · ${fmtDay(d.receivedAt)}${d.confirmedBy ? ` · checked by ${d.confirmedBy}` : ""}`)),
    h("button", { class: "btn small", type: "button", onclick: async () => { try { await downloadFile(`/api/history-imports/${d.id}/file`, "received-history-transfer.json"); } catch { toast("Couldn't download it."); } } }, "Download the file as received"));
  const closeBtn = (label, title) => h("button", { class: "btn small", type: "button", onclick: async () => {
    const note = await ask({ title, label: "Why", confirm: label }); if (!note) return;
    try { await api.post(`/api/history-imports/${d.id}/close`, { note }); toast("Done."); reload(); } catch { toast("Couldn't save it."); } } }, label);
  let step = null;
  if (d.status === "received") {
    const fp = h("input", { id: "hi-fp", maxlength: 100, autocomplete: "off", placeholder: "e.g. 3f9a…" });
    const pickBox = h("div", { class: "stack" });
    let chosen = null;
    const choose = (s, btn) => { chosen = s; pickBox.querySelectorAll("button[aria-pressed]").forEach(b => b.setAttribute("aria-pressed", "false")); btn.setAttribute("aria-pressed", "true"); };
    const option = s => { const b = h("button", { class: "btn small", type: "button", "aria-pressed": "false", "aria-label": `Choose ${s.name}`, onclick: () => choose(s, b) }, "Choose");
      return h("li", { class: "row wrap" }, h("span", { class: "grow" }, h("b", {}, s.name), h("span", { class: "small muted" }, ` · ${s.number || ""}${s.grade ? ` · grade ${s.grade}` : ""}${s.school ? ` · ${s.school}` : ""}${s.sameName ? " · same name" : ""}${s.sameNumber ? " · same student number" : ""}`)), b); };
    const results = h("ul", { class: "list" }, d.candidates.map(option));
    const q = h("input", { id: "hi-q", type: "search", maxlength: 100, placeholder: "Name or student number" });
    pickBox.append(d.candidates.length ? h("p", { class: "small" }, "Possible matches (check them; nothing is matched for you):") : h("p", { class: "small" }, "No student here has the same name or number. Search for the student:"), results,
      h("form", { class: "row wrap", onsubmit: async e => { e.preventDefault();
          const r = (await safe(api.get(`/api/students?q=${encodeURIComponent(q.value.trim())}&limit=10`)))?.data;
          const found = (Array.isArray(r) ? r : r?.students || r?.items || []).map(x => ({ id: x.id, name: x.display_name, number: x.local_student_number, grade: x.grade_level }));
          results.replaceChildren(...found.map(option)); } },
        h("div", { class: "grow" }, h("label", { for: "hi-q" }, "Find a student"), q), h("button", { class: "btn", type: "submit" }, "Search")));
    step = h("section", { class: "card", "aria-label": "Check and choose the student" }, h("h3", {}, "1. Check who sent it"),
      h("p", { class: "small" }, `The file is signed with fingerprint `, h("code", {}, d.fingerprint), `. Get ${d.from.district}'s signing fingerprint from them another way (a phone call to their records office, or their letterhead) and type it here. Don't copy it from the file.`),
      d.knownFingerprints.length ? h("p", { class: "small" }, d.knownFingerprints.some(k => k.fingerprint === d.fingerprint)
        ? `You confirmed this same fingerprint for ${d.from.district} on ${fmtDay(d.knownFingerprints.find(k => k.fingerprint === d.fingerprint).confirmedAt)}.`
        : `Careful: earlier files from ${d.from.district} had a different fingerprint. Check with them before going on.`) : null,
      h("label", { for: "hi-fp" }, "Fingerprint from the sending district"), fp,
      h("h3", {}, "2. Choose the student"), pickBox,
      h("div", { class: "btns" }, h("button", { class: "btn primary", type: "button", onclick: async () => {
          if (!chosen) return toast("Choose the student first.");
          try { await api.post(`/api/history-imports/${d.id}/confirm`, { fingerprint: fp.value.trim(), studentId: chosen.id }); toast(`Checked. Now choose what to add to ${chosen.name}'s history.`); reload(); }
          catch (err) { toast((err.code || err.body?.error) === "fingerprint_mismatch" ? "That fingerprint doesn't match the file. Don't go on until you've checked with the sending district." : "Couldn't save it."); } } }, "Confirm"),
        closeBtn("Reject the whole file", "Reject this whole file?")));
  }
  const KIND = { ...CLASS_TEXT, student_portfolio: "Student's portfolio", system_milestone: "Milestones" };
  const pending = d.items.filter(i => i.decision === "pending");
  const decide = async list => {
    try { const r = (await api.post(`/api/history-imports/${d.id}/decisions`, { decisions: list })).data;
      const dup = r.results.filter(x => x.result === "duplicate").length; toast(dup ? `Saved. ${dup} already came in an earlier transfer, so they weren't added again.` : "Saved."); reload(); }
    catch { toast("Couldn't save it."); } };
  const items = h("section", { class: "card", "aria-label": "Items" }, h("h3", {}, d.status === "reviewing" ? `3. Choose what to add to ${d.localStudent.name}'s history` : "Items"),
    d.status === "reviewing" ? h("p", { class: "small muted" }, "Accepted items are added to the student's history as they were, marked as coming from the other district. Nothing else changes: no grades, enrollment or other records.") : null,
    d.status === "reviewing" && pending.length ? h("div", { class: "btns" },
      h("button", { class: "btn primary small", type: "button", onclick: () => decide(pending.map(i => ({ pos: i.pos, decision: "accept" }))) }, `Accept all ${pending.length} waiting`),
      closeBtn("Finish (reject the rest)", "Reject the items still waiting?")) : null,
    h("ul", { class: "list" }, d.items.map(i => h("li", {},
      h("div", { class: "row wrap" }, h("b", { class: "grow" }, i.title), chip(i.decision === "accepted" ? "present" : i.decision === "rejected" ? "absent" : "expected", i.decision === "accepted" ? "Added" : i.decision === "rejected" ? "Not added" : "Waiting")),
      h("p", { class: "small muted" }, `${fmtDay(i.occurredAt)} · ${KIND[i.kind] || i.kind}${i.author ? ` · ${i.author}` : ""}${i.decidedBy ? ` · ${i.decision === "accepted" ? "added" : "not added"} by ${i.decidedBy}` : ""}${i.note ? ` · ${i.note}` : ""}`),
      i.body ? h("p", { class: "small" }, i.body) : null,
      d.status === "reviewing" && i.decision === "pending" ? h("div", { class: "btns" },
        h("button", { class: "btn small", type: "button", "aria-label": `Accept: ${i.title}`, onclick: () => decide([{ pos: i.pos, decision: "accept" }]) }, "Accept"),
        h("button", { class: "btn small", type: "button", "aria-label": `Don't add: ${i.title}`, onclick: async () => {
          if (!await ask({ title: `Don't add "${i.title}"?`, text: "It stays in the file as received but isn't added to the student's history.", confirm: "Don't add" })) return;
          decide([{ pos: i.pos, decision: "reject" }]); } }, "Don't add")) : null))));
  return [back("history", "Student history"), h("h2", {}, `${d.student.name}: history from ${d.from.district}`),
    h("p", {}, chip(...IMPORT_STATUS[d.status]), d.status === "completed" ? ` ${d.accepted} added to ${d.localStudent?.name}'s history, ${d.rejected} not added.` : d.status === "rejected" ? ` ${d.closeNote || ""}` : ""),
    step, info, d.status === "received" ? null : items];
};
// ---- TC-05: history privacy controls --------------------------------------
const CLASS_TEXT = { family_memory: "Family memories", student_portfolio: "My portfolio", teacher_artifact: "Teachers' items", official_record: "Official records" };
const ACCESS_TEXT = { guardian: "guardian", student: "student", teacher: "teacher", school_lead: "school leader", district: "district office", grant: "shared by the student", emergency: "emergency access" };
const BASIS_TEXT = { age_18: "turned 18", postsecondary: "attends college", emancipated: "emancipated", other: "other" };
function recordsPrivacyCard() {
  const box = h("div", {});
  const q = h("input", { id: "rp-q", type: "search", maxlength: 100, placeholder: "Name or student number" });
  return h("section", { class: "card", "aria-label": "Records and privacy" }, h("h3", {}, "Records & privacy"),
    h("p", { class: "small muted" }, "Custody restrictions, a student taking over their own record rights, what they share, emergency access, and who looked."),
    h("form", { class: "row wrap", onsubmit: async e => { e.preventDefault();
        const r = (await safe(api.get(`/api/students?q=${encodeURIComponent(q.value.trim())}&limit=10`)))?.data;
        const list = Array.isArray(r) ? r : r?.students || r?.items || [];
        box.replaceChildren(list.length ? h("ul", { class: "list" }, list.map(x => h("li", { class: "row" }, h("span", { class: "grow" }, x.display_name, h("span", { class: "small muted" }, ` · ${x.local_student_number || ""}`)),
          h("button", { class: "btn small", type: "button", "aria-label": `Privacy: ${x.display_name}`, onclick: () => openView("historyprivacy", { privacyStudentId: x.id }) }, "Open")))) : empty("No students found.")); } },
      h("div", { class: "grow" }, h("label", { for: "rp-q" }, "Find a student"), q), h("button", { class: "btn", type: "submit" }, "Search")), box);
}
VIEWS.historyprivacy = async () => {
  if (!state.privacyStudentId) return VIEWS.history();
  const d = (await api.get(`/api/students/${state.privacyStudentId}/history-privacy`)).data;
  const log = (await safe(api.get(`/api/students/${d.student.id}/history-access-log`)))?.data || [];
  const reload = () => go("historyprivacy", { push: false });
  const restrict = async g => {
    const v = await dialogForm(`Restrict ${g.name}'s access`, () => {
      const kind = h("select", { id: "cr-k" }, h("option", { value: "court_order" }, "Court order"), h("option", { value: "disputed" }, "Disputed guardianship (until resolved)"));
      return { fields: [h("p", { class: "small" }, `${g.name} won't see ${d.student.name}'s history or Time Capsules, anywhere, until this is lifted. Nothing is deleted.`),
        h("label", { for: "cr-k" }, "Why"), kind, h("label", { for: "cr-b" }, "Basis (order number, what was received)"), h("input", { id: "cr-b", required: true, maxlength: 300 }),
        h("label", { for: "cr-d" }, "Where the document is kept (optional)"), h("input", { id: "cr-d", maxlength: 200 }), h("label", { for: "cr-e" }, "Ends on (optional)"), h("input", { id: "cr-e", type: "date" })],
        value: () => ({ userId: g.id, kind: kind.value, basis: document.getElementById("cr-b").value.trim(), documentRef: document.getElementById("cr-d").value.trim() || null, endsOn: document.getElementById("cr-e").value || null }) };
    }, "Restrict");
    if (!v) return;
    try { await api.post(`/api/students/${d.student.id}/custody-restrictions`, v); toast("Restricted."); reload(); } catch { toast("Couldn't save it. The basis needs at least 5 characters."); }
  };
  return [back("history", "Student history"), h("h2", {}, `${d.student.name}: records & privacy`),
    h("section", { class: "card", "aria-label": "Guardians" }, h("h3", {}, "Guardians"),
      d.guardians.length ? h("ul", { class: "list" }, d.guardians.map(g => h("li", { class: "row wrap" }, h("span", { class: "grow" }, g.name), g.restricted ? chip("absent", "Restricted")
        : h("button", { class: "btn small", type: "button", "aria-label": `Restrict access: ${g.name}`, onclick: () => restrict(g) }, "Restrict access")))) : empty("No guardians linked."),
      d.restrictions.length ? [h("h4", {}, "Restrictions"), h("ul", { class: "list" }, d.restrictions.map(r => h("li", {}, h("b", {}, `${r.person}: ${r.kind === "court_order" ? "court order" : "disputed"}`),
        h("p", { class: "small muted" }, `${r.basis}${r.documentRef ? ` · ${r.documentRef}` : ""} · set by ${r.setBy}${r.endsOn ? ` · ends ${r.endsOn}` : ""}${r.liftedAt ? ` · lifted: ${r.liftNote}` : ""}`),
        !r.liftedAt ? h("button", { class: "btn small", type: "button", "aria-label": `Lift restriction: ${r.person}`, onclick: async () => {
          const note = await ask({ title: `Lift the restriction on ${r.person}?`, label: "Why (e.g. order vacated)", confirm: "Lift" }); if (!note) return;
          try { await api.post(`/api/custody-restrictions/${r.id}/lift`, { note }); toast("Lifted."); reload(); } catch { toast("Couldn't lift it."); } } }, "Lift") : null)))] : null),
    h("section", { class: "card", "aria-label": "Record rights" }, h("h3", {}, "Record rights"),
      d.transition ? [h("p", {}, `${d.student.name} holds their own record rights (${BASIS_TEXT[d.transition.basis]}, from ${d.transition.effectiveOn}, recorded by ${d.transition.recordedBy}). Guardians see only what they wrote and what ${first(d.student.name)} shares.`),
        h("button", { class: "btn small", type: "button", onclick: async () => {
          const note = await ask({ title: "Undo this? (recorded in error)", label: "Why", confirm: "Undo" }); if (!note) return;
          try { await api.post(`/api/students/${d.student.id}/rights-transition/reverse`, { note }); toast("Undone."); reload(); } catch { toast("Couldn't undo it."); } } }, "Recorded in error")]
      : [h("p", { class: "small muted" }, "When the student turns 18 or otherwise takes over their own record rights, record it here. Guardians then see only what the student shares with them."),
        h("form", { class: "row wrap", onsubmit: async e => { e.preventDefault(); const f = e.target.elements;
            try { await api.post(`/api/students/${d.student.id}/rights-transition`, { basis: f[0].value, effectiveOn: f[1].value }); toast("Recorded."); reload(); } catch { toast("Choose a date."); } } },
          h("div", {}, h("label", { for: "rt-b" }, "Because"), h("select", { id: "rt-b" }, Object.entries(BASIS_TEXT).map(([k, t]) => h("option", { value: k }, t)))),
          h("div", {}, h("label", { for: "rt-d" }, "From"), h("input", { id: "rt-d", type: "date", required: true })), h("button", { class: "btn", type: "submit" }, "Record"))],
      d.grants.length ? h("p", { class: "small" }, `Shared: ${d.grants.filter(g => !g.revoked).map(g => `${g.grantee} (${g.classifications.map(c => CLASS_TEXT[c]).join(", ")})`).join("; ") || "nothing now"}`) : null),
    d.emergency.length ? h("section", { class: "card", "aria-label": "Emergency access" }, h("h3", {}, "Emergency access"),
      h("ul", { class: "list small" }, d.emergency.map(a => h("li", {}, `${a.person} (${a.role}) · ${new Date(a.openedAt).toLocaleString()} · ${a.reason}${a.reviewed ? " · reviewed" : " · not reviewed yet"}`)))) : null,
    await transferCard(d.student), await legalHoldCard(d.student), accessLogCard(log)];
};
// ---- TC-08: preservation (capacity, integrity, legal holds) ----------------
const fmtBytes = n => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
async function preservationCard() {
  const d = (await safe(api.get("/api/history/preservation")))?.data;
  if (!d?.policy) return null;
  const holds = d.canEdit ? (await safe(api.get("/api/history/legal-holds")))?.data || [] : [];
  const p = d.policy;
  const verify = h("input", { id: "pp-verify", type: "number", min: 7, max: 365, value: p.verifyEveryDays, style: "width:6em" });
  const archive = h("input", { id: "pp-archive", type: "number", min: 30, max: 3650, value: p.archiveAfterDays ?? "", placeholder: "never", style: "width:7em", disabled: !d.archiveStorageClass || undefined });
  const alertPct = h("input", { id: "pp-alert", type: "number", min: 50, max: 99, value: p.capacityAlertPercent, style: "width:5em" });
  const schedule = h("input", { id: "pp-sched", maxlength: 300, value: p.recordsScheduleRef, placeholder: "e.g. Board policy 8310, state schedule GS-7" });
  return h("section", { class: "card", "aria-label": "Preservation" }, h("h3", {}, "Preservation"),
    h("p", { class: "small muted" }, `Photos are checked against their checksums every ${p.verifyEveryDays} days${d.lastCheckedAt ? ` (last check ${fmtDay(d.lastCheckedAt)})` : ""}. Limits are the district's; donations never change them.`),
    !d.storageReady ? h("p", { class: "small muted" }, "Private photo storage isn't connected yet, so there's nothing to check.") : null,
    d.problems.length ? h("ul", { class: "list small" }, d.problems.map(x => h("li", {}, chip("absent", x.kind === "archive_failed" ? "Archive" : "Check"), ` ${x.text} · ${fmtDay(x.at)}`))) : null,
    h("table", { class: "table small" }, h("thead", {}, h("tr", {}, ["School", "Students with photos", "Used", "In archive", `Over ${p.capacityAlertPercent}%`, "Full", "Checked OK", "Problems", "Holds"].map(t => h("th", {}, t)))),
      h("tbody", {}, d.schools.map(x => h("tr", {}, h("td", {}, x.school), h("td", {}, String(x.studentsWithMedia)), h("td", {}, fmtBytes(x.usedBytes)), h("td", {}, fmtBytes(x.archiveBytes)),
        h("td", {}, String(x.nearLimit)), h("td", {}, String(x.atLimit)), h("td", {}, String(x.integrity.ok)), h("td", {}, String(x.integrity.mismatch + x.integrity.missing)), h("td", {}, String(x.activeHolds)))))),
    d.canEdit ? h("details", {}, h("summary", {}, "Preservation settings"),
      h("div", { class: "row wrap" }, h("div", {}, h("label", { for: "pp-verify" }, "Check every (days)"), verify),
        h("div", {}, h("label", { for: "pp-archive" }, "Move to archive storage after (days)"), archive),
        h("div", {}, h("label", { for: "pp-alert" }, "Flag students over (%)"), alertPct)),
      !d.archiveStorageClass ? h("p", { class: "small muted" }, "District IT sets HISTORY_ARCHIVE_STORAGE_CLASS before photos can move to cheaper storage.") : null,
      h("label", { for: "pp-sched" }, "Records retention schedule (reference)"), schedule,
      h("button", { class: "btn small", type: "button", onclick: async () => {
        try { await api.put("/api/history/preservation-policy", { verifyEveryDays: Number(verify.value), archiveAfterDays: archive.value ? Number(archive.value) : null, capacityAlertPercent: Number(alertPct.value), recordsScheduleRef: schedule.value.trim() }); toast("Saved."); }
        catch { toast("Couldn't save it. Check the numbers."); } } }, "Save")) : null,
    d.canEdit && holds.length ? [h("h4", {}, `Legal holds (${holds.length})`), h("ul", { class: "list small" }, holds.map(x => h("li", { class: "row wrap" },
      h("span", { class: "grow" }, `${x.student.name} · ${x.school} · ${x.reason}${x.matterRef ? ` (${x.matterRef})` : ""} · since ${fmtDay(x.placedAt)}`),
      h("button", { class: "btn small", type: "button", "aria-label": `Open privacy for ${x.student.name}`, onclick: () => openView("historyprivacy", { privacyStudentId: x.student.id }) }, "Open"))))] : null);
}
async function legalHoldCard(student) {
  const d = (await safe(api.get(`/api/students/${student.id}/legal-holds`)))?.data;
  if (!Array.isArray(d?.holds)) return null;
  const reload = () => go("historyprivacy", { push: false });
  return h("section", { class: "card", "aria-label": "Legal hold" }, h("h3", {}, "Legal hold"),
    h("p", { class: "small muted" }, d.onHold ? `${student.name}'s history is on hold: nothing can be deleted and no Time Capsule opens until the superintendent lifts it.`
      : "Put a hold on this student's history when it may be needed for a legal matter or records request. Nothing can be deleted while it's on."),
    d.holds.length ? h("ul", { class: "list small" }, d.holds.map(x => h("li", {}, h("b", {}, x.releasedAt ? "Lifted" : "On hold"), ` · ${x.reason}${x.matterRef ? ` (${x.matterRef})` : ""} · placed by ${x.placedBy} ${fmtDay(x.placedAt)}`,
      x.releasedAt ? ` · lifted by ${x.releasedBy}: ${x.releaseNote}` : null,
      !x.releasedAt && d.canRelease ? h("button", { class: "btn small", type: "button", "aria-label": "Lift the legal hold", onclick: async () => {
        const note = await ask({ title: "Lift this legal hold?", label: "Why (e.g. matter closed)", confirm: "Lift" }); if (!note) return;
        try { await api.post(`/api/legal-holds/${x.id}/release`, { note }); toast("Lifted."); reload(); } catch { toast("Couldn't lift it. The note needs at least 5 characters."); } } }, "Lift") : null))) : null,
    h("button", { class: "btn small", type: "button", onclick: async () => {
      const v = await dialogForm(`Put ${student.name}'s history on hold`, () => ({
        fields: [h("label", { for: "lh-r" }, "Why"), h("input", { id: "lh-r", required: true, maxlength: 500 }), h("label", { for: "lh-m" }, "Matter or case number (optional)"), h("input", { id: "lh-m", maxlength: 120 })],
        value: () => ({ reason: document.getElementById("lh-r").value.trim(), matterRef: document.getElementById("lh-m").value.trim() || null }) }), "Place hold");
      if (!v) return;
      try { await api.post(`/api/students/${student.id}/legal-holds`, v); toast("On hold."); reload(); } catch { toast("Couldn't place it. The reason needs at least 5 characters."); } } }, "Place a legal hold"));
}
function accessLogCard(log) {
  return h("section", { class: "card", "aria-label": "Who looked" }, h("h3", {}, "Who looked"),
    log.length ? h("ul", { class: "list small" }, log.slice(0, 40).map(l => h("li", {}, `${l.who} (${ACCESS_TEXT[l.access] || l.access})${l.action === "export_history" ? " downloaded a copy" : ""} · ${new Date(l.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`)))
      : empty("No one has opened this history yet."));
}
async function emergencyReviewCard() {
  const list = (await safe(api.get("/api/history/emergency-access?review=pending")))?.data || [];
  if (!list.length) return null;
  return h("section", { class: "card", "aria-label": "Emergency access to review" }, h("h3", {}, "Emergency access to review"),
    h("ul", { class: "list" }, list.map(a => h("li", {}, h("b", {}, `${a.person} (${a.role}) opened ${a.student}'s records`), h("p", { class: "small muted" }, `${a.school} · ${new Date(a.openedAt).toLocaleString()} · ${a.reason}`),
      h("button", { class: "btn small", type: "button", "aria-label": `Review: ${a.person}, ${a.student}`, onclick: async () => {
        const note = await ask({ title: "Review this emergency access", label: "Your note (was it appropriate?)", confirm: "Save review" }); if (!note) return;
        try { await api.post(`/api/emergency-access/${a.id}/review`, { note }); toast("Reviewed."); go("history", { push: false }); } catch { toast("Couldn't save it."); } } }, "Review")))));
}
async function studentSharingCard(studentId) {
  const me = state.me.role;
  if (me === "parent") {
    const log = (await safe(api.get(`/api/students/${studentId}/history-access-log`)))?.data || [];
    const sh = (await safe(api.get("/api/history/sharing")))?.data;
    const adult = sh?.holdsOwnRights?.some(a => a.studentId === studentId);
    return [adult ? h("p", { class: "notice" }, "Your child now holds their own record rights. You see what you wrote and what they choose to share with you.") : null,
      h("details", { class: "card" }, h("summary", {}, "Who looked at this history"), accessLogCard(log))];
  }
  if (me !== "pupil") return null;
  const d = (await safe(api.get("/api/history/sharing")))?.data;
  const log = (await safe(api.get(`/api/students/${studentId}/history-access-log`)))?.data || [];
  const reload = () => go(state.tab, { push: false });
  return [d?.holdsOwnRights ? h("section", { class: "card", "aria-label": "Sharing" }, h("h3", {}, "Sharing your history"),
      h("p", { class: "small muted" }, "Your record rights are yours now. Your guardians see only what they wrote and what you share with them here. You can stop sharing any time."),
      d.grants.filter(g => g.active).length ? h("ul", { class: "list" }, d.grants.filter(g => g.active).map(g => h("li", { class: "row wrap" },
        h("span", { class: "grow" }, h("b", {}, g.grantee), h("span", { class: "small muted" }, ` · ${g.classifications.map(c => CLASS_TEXT[c]).join(", ")} · until ${new Date(g.expiresAt).toLocaleDateString()}`)),
        h("button", { class: "btn small", type: "button", "aria-label": `Stop sharing with ${g.grantee}`, onclick: async () => {
          try { await api.post(`/api/history/sharing/${g.id}/revoke`, {}); toast("Stopped."); reload(); } catch { toast("Couldn't stop it."); } } }, "Stop sharing")))) : h("p", { class: "small" }, "You aren't sharing anything."),
      d.guardians.length ? h("button", { class: "btn", type: "button", onclick: async () => {
        const v = await dialogForm("Share with a guardian", () => {
          const who = h("select", { id: "sg-w" }, d.guardians.map(g => h("option", { value: g.id }, g.name)));
          const boxes = Object.entries(CLASS_TEXT).map(([k, t]) => h("label", { class: "check" }, h("input", { type: "checkbox", value: k, checked: k === "official_record" }), ` ${t}`));
          return { fields: [h("label", { for: "sg-w" }, "With"), who, h("fieldset", { class: "caps" }, h("legend", {}, "What"), boxes),
            h("label", { for: "sg-d" }, "For how many days"), h("input", { id: "sg-d", type: "number", min: 1, max: 365, value: 90 })],
            value: () => { const classifications = boxes.map(b => b.querySelector("input")).filter(i => i.checked).map(i => i.value);
              if (!classifications.length) { toast("Choose what to share."); return undefined; }
              return { granteeUserId: who.value, classifications, days: Number(document.getElementById("sg-d").value) }; } };
        }, "Share");
        if (!v) return;
        try { await api.post("/api/history/sharing", v); toast("Shared."); reload(); } catch { toast("Couldn't share it."); } } }, "Share with a guardian") : null) : null,
    h("details", { class: "card" }, h("summary", {}, "Who looked at your history"), accessLogCard(log))];
}
VIEWS.emergencyrecords = async () => {
  const cur = state.emergency;
  const records = cur ? (await safe(api.get(`/api/history/portfolio?studentId=${cur.studentId}`)))?.data : null;
  return [back("me", "Account"), h("h2", {}, "Emergency access to a student's records"),
    h("p", { class: "small muted" }, "For an emergency only: you see the student's official records (not family or private items) for up to four hours. Your reason is recorded, the student and family can see that you looked, and the superintendent reviews every use."),
    cur && records ? h("section", { class: "card", "aria-label": `${cur.student}'s official records` }, h("div", { class: "row wrap" }, h("h3", { class: "grow" }, cur.student), chip("expected", `Until ${timeText(cur.expiresAt)}`)),
        records.items.length ? h("ul", { class: "list" }, records.items.map(i => h("li", {}, h("b", {}, i.title), h("p", { class: "small muted" }, `${fmtDay(i.occurredAt)}${i.authorName ? ` · ${i.authorName}` : ""}`), i.body ? h("p", { class: "small" }, i.body) : null))) : empty("No official records."),
        h("button", { class: "btn", type: "button", onclick: async () => { try { await api.post(`/api/emergency-access/${cur.id}/close`, {}); } catch {} state.emergency = null; go("emergencyrecords", { push: false }); } }, "Close access"))
      : h("form", { class: "card", onsubmit: async e => { e.preventDefault(); const f = e.target.elements;
          try { state.emergency = (await api.post("/api/history/emergency-access", { studentNumber: f[0].value.trim(), reason: f[1].value.trim() })).data; go("emergencyrecords", { push: false }); }
          catch (err) { toast(err.body?.error === "student_not_found" ? "No student with that number at your school." : "Write the reason (at least 20 characters)."); } } },
        h("label", { for: "em-n" }, "Student ID number"), h("input", { id: "em-n", required: true, maxlength: 40, autocomplete: "off" }),
        h("label", { for: "em-r" }, "Reason"), h("textarea", { id: "em-r", required: true, minlength: 20, maxlength: 500, rows: 3 }),
        h("button", { class: "btn danger", type: "submit" }, "Open records for four hours"))];
};
// ---- STATE-01: the state index and educators' licenses ----------------------
const LICENSED = ["teacher", "principal", "vice_principal", "superintendent", "coach", "librarian", "counselor"];
const LIC_STATUS = { self_reported: ["expected", "Not verified yet"], verified: ["present", "Verified by the district"], not_verified: ["absent", "Couldn't be verified"] };
const expiryText = l => l.expiresOn == null ? "No expiry date" : l.daysLeft < 0 ? `Expired ${-l.daysLeft} day${l.daysLeft === -1 ? "" : "s"} ago` : l.daysLeft <= 90 ? `Expires in ${l.daysLeft} day${l.daysLeft === 1 ? "" : "s"} (${l.expiresOn})` : `Expires ${l.expiresOn}`;
async function licenseCard() {
  const list = (await safe(api.get("/api/licenses/mine")))?.data || [];
  return h("section", { class: "card", "aria-label": "My licenses" }, h("h3", {}, "My licenses"),
    list.length ? h("ul", { class: "list" }, list.map(l => h("li", {},
      h("div", { class: "row wrap" }, h("b", { class: "grow" }, `${l.state}: ${l.type}`), chip(...LIC_STATUS[l.status])),
      h("p", { class: "small muted" }, `No. ${l.number}${l.endorsements ? ` · ${l.endorsements}` : ""}`),
      h("p", { class: `small${l.daysLeft != null && l.daysLeft <= 90 ? " warn" : ""}` }, expiryText(l)),
      l.note ? h("p", { class: "small muted" }, `District note: ${l.note}`) : null,
      h("div", { class: "btns" }, h("button", { class: "btn small", type: "button", "aria-label": `Edit license: ${l.state} ${l.type}`, onclick: () => editLicense(l) }, "Edit"),
        h("button", { class: "btn small", type: "button", "aria-label": `Remove license: ${l.state} ${l.type}`, onclick: async () => {
          if (!(await ask({ title: "Remove this license?", text: "It leaves your profile. The district keeps its record.", confirm: "Remove" }))) return;
          try { await api.post(`/api/licenses/${l.id}/retire`, {}); toast("Removed."); go("me", { push: false }); } catch { toast("Couldn't remove it."); } } }, "Remove")))))
      : h("p", { class: "small muted" }, "Add your teaching or administrator licenses. You'll see a reminder 90 days before one expires, and the district checks each against the state's lookup."),
    h("button", { class: "btn primary", type: "button", onclick: () => editLicense(null) }, "Add a license"));
}
async function editLicense(l) {
  const states = (await api.get("/api/states")).data;
  const v = await dialogForm(l ? "Edit license" : "Add a license", () => {
    const sel = h("select", { id: "lic-st" }, states.states.map(x => h("option", { value: x.code, selected: (l?.stateCode || states.districtState) === x.code }, x.name)));
    const inp = (id, label, val, attrs = {}) => [h("label", { for: id }, label), h("input", { id, value: val ?? "", ...attrs })];
    return { fields: [h("label", { for: "lic-st" }, "State"), sel,
      inp("lic-type", "License or certificate type", l?.type, { required: true, maxlength: 120, placeholder: "e.g. Standard teaching certificate" }),
      inp("lic-no", "License number", l?.number, { required: true, maxlength: 40, autocomplete: "off" }),
      inp("lic-end", "Endorsements or subjects (optional)", l?.endorsements, { maxlength: 300 }),
      inp("lic-iss", "Issued (optional)", l?.issuedOn, { type: "date" }), inp("lic-exp", "Expires (optional)", l?.expiresOn, { type: "date" }),
      l?.status === "verified" ? h("p", { class: "small muted" }, "Changing it means the district verifies it again.") : null],
      value: () => { const g = id => document.getElementById(id).value.trim(); return { stateCode: g("lic-st"), type: g("lic-type"), number: g("lic-no"), endorsements: g("lic-end") || null, issuedOn: g("lic-iss") || null, expiresOn: g("lic-exp") || null }; } };
  }, l ? "Save" : "Add");
  if (!v) return;
  try { await (l ? api.put(`/api/licenses/${l.id}`, v) : api.post("/api/licenses", v)); toast(l ? "Saved. The district will verify it again." : "Added."); go("me", { push: false }); }
  catch { toast("Check the dates and fields, then try again."); }
}
VIEWS.states = async () => {
  const d = (await api.get("/api/states")).data;
  const tile = x => h("li", {}, h("button", { class: "row linkrow", type: "button", onclick: () => openView("stateinfo", { stateCode: x.code }) },
    h("span", { class: "grow" }, h("b", {}, x.name), x.code === d.districtState ? h("span", { class: "small muted" }, " · your district") : null),
    h("span", { class: "small muted" }, `${Object.values(x.counts).reduce((a, b) => a + b, 0)} links`), icon("chevron")));
  const mine = d.states.find(x => x.code === d.districtState);
  return [back("me", "Account"), h("h2", {}, "State index"),
    h("p", { class: "small muted" }, "Each state's educator licensing, athletics association, education agency data and student records rules. Every link shows where it was confirmed and when."),
    state.me.role === "superintendent" ? h("section", { class: "card", "aria-label": "District's state" }, h("label", { for: "dist-st" }, "Your district's state"),
      h("select", { id: "dist-st", onchange: async e => { try { await api.put("/api/district/state", { stateCode: e.target.value }); toast("Saved."); go("states", { push: false }); } catch { toast("Couldn't save it."); } } },
        h("option", { value: "", disabled: true, selected: !d.districtState }, "Choose…"), d.states.map(x => h("option", { value: x.code, selected: x.code === d.districtState }, x.name)))) : null,
    mine ? h("section", { class: "card", "aria-label": "Your district" }, h("ul", { class: "list" }, tile(mine))) : null,
    h("section", { class: "card", "aria-label": "All states" }, h("ul", { class: "list" }, d.states.map(tile)))];
};
VIEWS.stateinfo = async () => {
  if (!state.stateCode) return VIEWS.states();
  const d = (await api.get(`/api/states/${state.stateCode}`)).data;
  const supt = state.me.role === "superintendent";
  return [back("states", "State index"), h("h2", {}, d.name),
    d.sections.map(sec => h("section", { class: "card", "aria-label": sec.label }, h("h3", {}, sec.label),
      sec.entries.length ? h("ul", { class: "list" }, sec.entries.map(e => h("li", {},
        h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer" }, e.title), e.description ? h("p", { class: "small" }, e.description) : null,
        h("p", { class: "small muted" }, `${e.from === "district" ? `Added by ${e.addedBy}` : e.from === "national" ? "National" : "EduOS"} · checked ${e.checked}${e.source && e.source !== e.url ? " · " : ""}`,
          e.source && e.source !== e.url ? h("a", { href: e.source, target: "_blank", rel: "noopener noreferrer" }, "source") : null),
        supt && e.from === "district" ? h("button", { class: "btn small", type: "button", "aria-label": `Remove link: ${e.title}`, onclick: async () => {
          try { await api.post(`/api/state-entries/${e.id}/retire`, {}); toast("Removed."); go("stateinfo", { push: false }); } catch { toast("Couldn't remove it."); } } }, "Remove") : null)))
        : h("p", { class: "small muted" }, supt ? "No confirmed link yet. Add the official page and where you confirmed it." : "No confirmed link yet. Your district can add one."),
      supt ? h("button", { class: "btn small", type: "button", "aria-label": `Add a link: ${sec.label}`, onclick: () => addStateEntry(d, sec) }, "Add a link") : null))];
};
async function addStateEntry(d, sec) {
  const v = await dialogForm(`${d.name}: ${sec.label}`, () => {
    const inp = (id, label, attrs = {}) => [h("label", { for: id }, label), h("input", { id, ...attrs })];
    return { fields: [h("p", { class: "small muted" }, "Use the official page (the state, its agency or its association). Everyone in the district sees it."),
      inp("se-t", "Title", { required: true, maxlength: 160 }), inp("se-u", "Link (https://…)", { required: true, type: "url", maxlength: 500 }),
      inp("se-d", "What it's for (optional)", { maxlength: 1000 }), inp("se-s", "Where you confirmed it (optional link)", { type: "url", maxlength: 500 }),
      inp("se-c", "Checked on", { type: "date", required: true, value: new Date().toISOString().slice(0, 10), max: new Date().toISOString().slice(0, 10) })],
      value: () => { const g = id => document.getElementById(id).value.trim(); return { category: sec.key, title: g("se-t"), url: g("se-u"), description: g("se-d") || null, sourceUrl: g("se-s") || null, verifiedOn: g("se-c") }; } };
  }, "Add");
  if (!v) return;
  try { await api.post(`/api/states/${d.code}/entries`, v); toast("Added."); go("stateinfo", { push: false }); } catch { toast("Use an https link and a date that isn't in the future."); }
}
VIEWS.licenses = async () => {
  const filter = state.licFilter || "soon";
  const q = filter === "soon" ? "?expiringWithin=90" : filter === "unverified" ? "?status=self_reported" : "";
  const list = (await api.get(`/api/licenses${q}`)).data;
  const supt = state.me.role === "superintendent";
  const seg = (key, label) => h("button", { class: `btn small${filter === key ? " primary" : ""}`, type: "button", "aria-pressed": String(filter === key), onclick: () => openView("licenses", { licFilter: key }) }, label);
  return [back("me", "Account"), h("h2", {}, "Staff licenses"),
    h("p", { class: "small muted" }, supt ? "Licenses staff recorded on their profiles. Check each against the state's lookup (see the State index), then mark it." : "Licenses recorded by people who work at your school. The district verifies them."),
    h("div", { class: "btns", role: "group", "aria-label": "Show" }, seg("soon", "Expiring in 90 days"), seg("unverified", "Not verified yet"), seg("all", "All")),
    h("section", { class: "card", "aria-label": "Licenses" }, list.length ? h("ul", { class: "list" }, list.map(l => h("li", {},
      h("div", { class: "row wrap" }, h("b", { class: "grow" }, l.name), chip(...LIC_STATUS[l.status])),
      h("p", { class: "small" }, `${l.state}: ${l.type} · No. ${l.number}${l.endorsements ? ` · ${l.endorsements}` : ""}`),
      h("p", { class: `small${l.daysLeft != null && l.daysLeft <= 90 ? " warn" : " muted"}` }, expiryText(l)),
      supt ? h("div", { class: "btns" },
        h("button", { class: "btn small primary", type: "button", "aria-label": `Verified: ${l.name}, ${l.state}`, onclick: () => verifyLicense(l, "verified") }, "Verified"),
        h("button", { class: "btn small", type: "button", "aria-label": `Couldn't verify: ${l.name}, ${l.state}`, onclick: () => verifyLicense(l, "not_verified") }, "Couldn't verify")) : null)))
      : empty(filter === "soon" ? "No licenses expire in the next 90 days." : "No licenses here."))];
};
async function verifyLicense(l, decision) {
  const note = await dialogForm(decision === "verified" ? `Verify ${l.name}'s license` : `Couldn't verify ${l.name}'s license`, () => {
    const box = h("textarea", { id: "lv-note", maxlength: 500, rows: 2, placeholder: decision === "verified" ? "e.g. Checked on the state lookup" : "What didn't match" });
    return { fields: [h("p", { class: "small" }, `${l.state}: ${l.type} · No. ${l.number}`), h("label", { for: box.id }, "Note (optional)"), box], value: () => box.value.trim() };
  }, "Save");
  if (note === null) return;
  try { await api.post(`/api/licenses/${l.id}/verify`, { decision, note: note || null }); toast("Saved."); go("licenses", { push: false }); } catch { toast("Couldn't save it."); }
}

// ---- 32.7.0 offline write queue -------------------------------------------
// When the phone (or the school's uplink) drops, a SMALL allowlist of writes
// is kept on the device and sent later: safety roll call, bus check-ins and
// attendance marks. Each queued write is AES-GCM encrypted with a key that is
// generated in the browser as NON-EXTRACTABLE (it cannot be exported or read
// by script, only used), kept for at most 24 hours, capped at 200 entries and
// wiped on sign-out or when another account signs in. Nothing is read from
// the queue for display: names, rosters and records are never cached. Pick-up
// release is deliberately online-only (identity must be checked live).
const OQ = {
  db: null, key: null, MAX: 200, TTL: 24 * 3600 * 1000, count: 0, flushing: false,
  PATHS: [/^\/api\/safety\/incidents\/[0-9a-f-]{36}\/rollcall$/, /^\/api\/safety\/incidents\/[0-9a-f-]{36}\/room-status$/, /^\/api\/transport\/runs\/[0-9a-f-]{36}\/checkins$/, /^\/api\/attendance$/],
  queueable(method, path) { return method === "POST" && this.PATHS.some(r => r.test(path)); },
  held: 0,
  async open() {
    if (this.db) return this.db;
    if (!("indexedDB" in self) || !crypto?.subtle) return null;
    this.db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("eduos-offline-queue", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("meta"); r.result.createObjectStore("queue", { keyPath: "id" }); };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    return this.db;
  },
  async tx(store, mode, fn) {
    const db = await this.open(); if (!db) return null;
    return new Promise((resolve, reject) => { const t = db.transaction(store, mode); const req = fn(t.objectStore(store)); t.oncomplete = () => resolve(req?.result); t.onerror = () => reject(t.error); });
  },
  async cryptoKey() {
    if (this.key) return this.key;
    const owner = await this.tx("meta", "readonly", s => s.get("owner"));
    if (owner && owner !== state.me?.userId) await this.clear(); // a different account: never hand it someone else's queue
    let k = await this.tx("meta", "readonly", s => s.get("key"));
    if (!k) {
      k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await this.tx("meta", "readwrite", s => { s.put(k, "key"); return s.put(state.me?.userId || "", "owner"); });
    }
    return (this.key = k);
  },
  async enqueue(path, body, headers) {
    if ((await this.refresh()) >= this.MAX) throw new ApiError(507, { error: "offline_queue_full" });
    const key = await this.cryptoKey(), iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify({ path, body, profile: profileKey() })));
    await this.tx("queue", "readwrite", s => s.put({ id: headers["idempotency-key"], at: Date.now(), queuedAt: headers["x-eduos-queued-at"], iv, data }));
    await this.refresh();
  },
  async all() { return (await this.tx("queue", "readonly", s => s.getAll())) || []; },
  async refresh() { this.count = (await this.all().catch(() => [])).length; renderNetBar(); return this.count; },
  async clear() { this.key = null; this.count = 0; if (this.db) { this.db.close(); this.db = null; } await new Promise(r => { const q = indexedDB.deleteDatabase("eduos-offline-queue"); q.onsuccess = q.onerror = q.onblocked = () => r(); }); renderNetBar(); },
  async flush() {
    if (this.flushing || !state.me) return; this.flushing = true;
    let sent = 0, dropped = 0, held = 0;
    try {
      const items = (await this.all()).sort((a, b) => a.at - b.at);
      if (!items.length) return;
      const key = await this.cryptoKey();
      for (const it of items) {
        const del = () => this.tx("queue", "readwrite", s => s.delete(it.id));
        if (Date.now() - it.at > this.TTL) { await del(); dropped++; continue; }
        const { path, body, profile } = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: it.iv }, key, it.data)));
        // UI-05: made in another profile (e.g. as a teacher, now using the family profile): keep it for that profile.
        if (profile && profile !== profileKey()) { held++; continue; }
        if (!api.csrf) api.csrf = (await api.get("/api/csrf")).csrfToken;
        let res;
        try { res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": api.csrf, "idempotency-key": it.id, "x-eduos-queued-at": it.queuedAt }, body: JSON.stringify(body) }); }
        catch { break; } // still offline
        if (res.ok) { await del(); sent++; continue; }
        if ([401, 408, 429].includes(res.status) || res.status >= 500) break; // try again later
        await del(); dropped++; // refused for good (e.g. incident closed long ago): never retried forever
      }
    } finally { this.flushing = false; this.held = held; await this.refresh(); }
    if (sent) toast(`Sent ${sent} saved change${sent > 1 ? "s" : ""}`);
    if (dropped) toast(`${dropped} saved change${dropped > 1 ? "s were" : " was"} too old or refused and not sent`);
  }
};
const profileKey = () => state.me ? `${state.me.districtId}|${state.me.schoolId || ""}|${state.me.role}` : "";
function renderNetBar() {
  let bar = document.getElementById("netbar");
  if (!bar) { bar = h("div", { id: "netbar", class: "netbar", role: "status", "aria-live": "polite" }); document.getElementById("top")?.after(bar); }
  const off = !navigator.onLine;
  bar.hidden = !off && !OQ.count;
  bar.textContent = off ? `You're offline.${OQ.count ? ` ${OQ.count} change${OQ.count > 1 ? "s" : ""} saved on this phone, waiting to send.` : " Roll call, bus check-ins and attendance are saved and sent later."}`
    : OQ.count && OQ.held === OQ.count ? `${OQ.count} saved change${OQ.count > 1 ? "s were" : " was"} made in another of your profiles. Switch back to it to send ${OQ.count > 1 ? "them" : "it"}.`
    : OQ.count ? `${OQ.count} saved change${OQ.count > 1 ? "s" : ""} waiting to send.` : "";
}
window.addEventListener("online", () => { renderNetBar(); OQ.flush(); });
window.addEventListener("offline", renderNetBar);

function renderSignIn() {
  document.getElementById("top").replaceChildren();
  document.getElementById("tabs").replaceChildren();
  put(h("section", { class: "signin" }, h("div", {}, h("div", { class: "logo", "aria-hidden": "true" }), h("h1", {}, "EduOS Mobile"),
    h("p", { class: "muted" }, "Student, teacher, family, school leader and driver apps."),
    h("a", { class: "btn primary big block", href: "/auth/login?next=/app/" }, "Sign in with your school account"))));
}
// Staff AI assistant (src/ai/): only the use cases the district enabled for
// this role. Nothing about students is sent unless the person types it, and
// the operations brief uses only counts EduOS computes from their own scope.
// ---- 37.6.0 Leo (lesson drafts) and Edison (gate-released trends) ----------
async function leoCard() {
  if (!["teacher", "principal", "superintendent"].includes(state.me.role) || !state.courseId) return null;
  const o = (await safe(api.get(`/api/leo/options?courseId=${state.courseId}`)))?.data;
  if (!Array.isArray(o?.units)) return null;
  const body = [h("h2", {}, "Leo: draft a lesson"),
    h("p", { class: "muted small" }, `Leo builds a draft from this course's standards, approved lessons and approved primary sources only, never from student data. The draft is saved here and a school leader approves it before it can be published. ${o.provider === "external" ? "Uses the district's external AI service; names are removed first." : "Runs on EduOS itself."}`)];
  if (!o.enabled) return h("section", { class: "card", "aria-label": "Leo" }, ...body, empty("Your district hasn't turned on Leo lesson drafts."));
  if (!o.units.length || !o.standards.length) return h("section", { class: "card", "aria-label": "Leo" }, ...body, empty("Add a unit and standards to this course first."));
  const unit = h("select", { id: "leo-unit" }, o.units.map(u => h("option", { value: u.id }, `Unit ${u.seq}: ${u.title}`)));
  const minutes = h("select", { id: "leo-minutes" }, o.minutes.map(m => h("option", { value: m, selected: m === 45 }, `${m} minutes`)));
  const focus = h("input", { id: "leo-focus", maxlength: 100, placeholder: "Optional focus, e.g. Comparing fractions" });
  const box = (name, list, label) => h("fieldset", {}, h("legend", {}, label), list.map(x => h("label", { class: "inline" }, h("input", { type: "checkbox", name, value: x.id }), ` ${x.code ? `${x.code}: ${x.description.slice(0, 80)}` : x.title}`)));
  const fs = [box("leo-std", o.standards, "Standards (1 to 4)"), o.lessons.length ? box("leo-lesson", o.lessons, "Build on approved lessons (up to 3)") : null,
    o.sources.length ? box("leo-src", o.sources, "Approved primary sources (up to 2)") : null];
  const picked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(x => x.value);
  return h("section", { class: "card", "aria-label": "Leo" }, ...body,
    h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault();
      try {
        const r = (await api.post("/api/leo/drafts", { courseId: state.courseId, unitId: unit.value, minutes: Number(minutes.value), focus: focus.value.trim() || undefined,
          standardIds: picked("leo-std"), lessonIds: picked("leo-lesson"), sourceIds: picked("leo-src") })).data;
        toast("Draft saved. A school leader approves it before it's published.");
        openView("lesson", { lessonId: r.lesson.id });
      } catch { toast("Leo couldn't draft that. Pick 1 to 4 standards and try again."); } } },
      h("label", { for: unit.id }, "Unit"), unit, h("label", { for: minutes.id }, "Length"), minutes, h("label", { for: focus.id }, "Focus"), focus, ...fs,
      h("button", { class: "btn primary", type: "submit" }, "Draft with Leo")));
}
async function edisonCard() {
  if (!["principal", "vice_principal", "superintendent"].includes(state.me.role)) return null;
  const t = (await safe(api.get("/api/edison/trends?days=10")))?.data;
  if (!Array.isArray(t?.schools)) return null;
  const pct = (d) => { const nr = d.suppressed.includes("not_recorded") ? null : (d.counts.not_recorded ?? 0);
    const rec = d.total != null && nr != null ? d.total - nr : 0;
    return rec && d.counts.present != null && !d.suppressed.includes("tardy") ? `${Math.round(100 * (d.counts.present + (d.counts.tardy || 0)) / rec)}%` : "—"; };
  const out = h("div", { "aria-live": "polite" });
  return h("section", { class: "card", "aria-label": "Edison trends" }, h("h2", {}, "Edison: trends"),
    h("p", { class: "muted small" }, `Group counts only, released by the privacy gate: counts under ${t.k} are withheld and never estimated. No student is scored or predicted.`),
    t.schools.map(s => h("div", {}, h("h3", {}, s.name),
      h("ul", { class: "list" }, kv("Enrolled", s.enrolled ?? "withheld"),
        kv("In school, last school days", s.attendance.map(pct).join(" · ") || "—"),
        s.transport ? kv("Bus check-ins today", s.transport.riders == null ? "withheld" : `${s.transport.riders - (s.transport.counts.no_checkin ?? 0)} of ${s.transport.riders}`) : null))),
    t.briefEnabled ? h("button", { class: "btn", type: "button", onclick: async () => {
      out.replaceChildren(h("p", { class: "muted" }, "Writing…"));
      try { const r = (await api.post("/api/edison/brief", { days: 10 })).data;
        let text = r.text; for (const m of r.schools) text = text.split(m.label).join(m.name);
        out.replaceChildren(h("div", { class: "lesson-text" }, text.split(/\n+/).map(p => h("p", {}, p)))); }
      catch { out.replaceChildren(empty("Edison couldn't write a brief right now.")); } } }, "Write a brief") : null, out);
}
for (const [view, extra] of [["course", [leoCard]], ["overview", [edisonCard]], ["operations", [edisonCard]]]) {
  const base = VIEWS[view];
  VIEWS[view] = async () => [...[await base()].flat(), ...(await Promise.all(extra.map(f => f())))];
}
async function aiAssistantCard() {
  if (["pupil", "parent", "driver", "sro"].includes(state.me.role)) return null;
  const st = (await safe(api.get("/api/ai/status")))?.data;
  if (!st?.usecases?.length) return null;
  const on = st.usecases.filter(u => u.enabled);
  const out = h("div", { "aria-live": "polite" });
  const left = (b) => Math.max(0, b.cap - b.used);
  const body = [h("h2", {}, "Assistant"),
    h("p", { class: "muted small" }, `${st.provider === "external" ? "Uses the district's external AI service; names and contact details are removed first." : "Runs on EduOS itself; nothing leaves the server."} ${left(st.budget.you).toLocaleString()} of your ${st.budget.you.cap.toLocaleString()} tokens left today.`)];
  if (!on.length) return h("section", { class: "card", "aria-label": "Assistant" }, ...body, empty("Your district hasn't turned on any assistant tools yet."));
  const pick = h("select", { id: "ai-usecase" }, on.map(u => h("option", { value: u.id }, u.label)));
  const text = h("textarea", { id: "ai-text", rows: 5, maxlength: 12000 });
  const label = h("label", { for: text.id });
  const hints = { lesson_draft: ["Topic", "e.g. Fractions on a number line"], resource_summary: ["Resource text", "Paste an article, policy or handout"],
    writing_feedback: ["Student writing", "Paste the writing (leave out the student's name)"] };
  const sync = () => { const u = on.find(x => x.id === pick.value); const hint = hints[pick.value];
    label.textContent = hint?.[0] || ""; text.placeholder = hint?.[1] || ""; label.hidden = text.hidden = !u.input; text.required = !!u.input; };
  pick.addEventListener("change", sync); sync();
  const errors = { ai_usecase_not_enabled: "Your district hasn't turned this on.", ai_your_budget_reached: "You've used today's assistant budget.",
    ai_district_budget_reached: "The district's assistant budget for today is used up.", ai_input_length: "That's too short or too long.",
    ai_request_exceeds_budget: "That's more text than a day's assistant budget allows. Try a shorter piece." };
  return h("section", { class: "card", "aria-label": "Assistant" }, ...body,
    h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault();
      out.replaceChildren(h("p", { class: "muted" }, "Working…"));
      try { const r = (await api.post("/api/ai/run", { usecase: pick.value, ...(text.hidden ? {} : { text: text.value }) })).data;
        out.replaceChildren(h("pre", { class: "ai-out" }, r.text), h("p", { class: "muted small" }, `${r.source === "external" ? "External AI" : "EduOS"} · ${r.tokens} tokens · check before you use it`)); }
      catch (err) { out.replaceChildren(h("p", { class: "notice", role: "alert" }, errors[err.body?.error] || "The assistant couldn't answer.")); } } },
      h("label", { for: pick.id }, "Tool"), pick, label, text, h("button", { class: "btn primary", type: "submit" }, "Ask")), out);
}
// Superintendent: which assistant tools the district allows, and its budgets.
async function aiPolicyCard() {
  const r = (await safe(api.get("/api/ai/policy")))?.data;
  if (!r?.policy) return null;
  const boxes = r.usecases.map(u => { const b = h("input", { id: `aip-${u.id}`, type: "checkbox", class: "check", value: u.id }); b.checked = r.policy.enabled_usecases.includes(u.id); b.disabled = !r.canEdit;
    return h("div", { class: "row" }, b, h("label", { for: b.id, class: "grow" }, `${u.label} · ${u.roles.join(", ").replace(/_/g, " ")}`)); });
  const cap = h("input", { id: "aip-cap", type: "number", min: 0, value: String(r.policy.daily_token_cap), disabled: !r.canEdit });
  const ucap = h("input", { id: "aip-ucap", type: "number", min: 0, value: String(r.policy.user_daily_token_cap), disabled: !r.canEdit });
  const externalOptIn = h("input", { id: "aip-external", type: "checkbox", class: "check", disabled: !r.canEdit || r.provider !== "external" }); externalOptIn.checked = Boolean(r.policy.external_provider_enabled);
  const privacyAck = h("input", { id: "aip-privacy-ack", type: "checkbox", class: "check", disabled: !r.canEdit || r.provider !== "external" }); privacyAck.checked = Boolean(r.policy.external_provider_enabled && r.policy.external_provider_acknowledged_at);
  return h("section", { class: "card", "aria-label": "Assistant settings" }, h("h2", {}, "Assistant settings"),
    h("p", { class: "muted small" }, `Off until you turn a tool on. Prompts and answers aren't stored; only usage is. AI service: ${r.provider === "external" ? "external (names and contact details removed first)" : "EduOS only, no network"}.`),
    r.usage30d.length ? h("ul", { class: "list" }, r.usage30d.map(u => kv(r.usecases.find(x => x.id === u.usecase)?.label || u.usecase, `${u.calls} uses · ${u.tokens.toLocaleString()} tokens (30 days)`))) : null,
    h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault();
      try { await api.req("PUT", "/api/ai/policy", { enabledUsecases: boxes.map(x => x.querySelector("input")).filter(x => x.checked).map(x => x.value), dailyTokenCap: Number(cap.value), userDailyTokenCap: Number(ucap.value), externalProviderEnabled: externalOptIn.checked, privacyAcknowledged: privacyAck.checked }); toast("Saved"); }
      catch { toast("Couldn't save."); } } },
      boxes, h("div", { class: "row" }, externalOptIn, h("label", { for: externalOptIn.id, class: "grow" }, "Allow staff prompts to be processed by the configured external AI provider")), h("div", { class: "row" }, privacyAck, h("label", { for: privacyAck.id, class: "grow" }, "I acknowledge that automated redaction is best-effort, not guaranteed de-identification; district privacy review and vendor approval are required")), h("label", { for: cap.id }, "District tokens per day"), cap, h("label", { for: ucap.id }, "Tokens per person per day"), ucap,
      r.canEdit ? h("button", { class: "btn", type: "submit" }, "Save") : null));
}
for (const [view, extra] of [["copilot", [aiAssistantCard]], ["operations", [aiAssistantCard]], ["guidance", [aiAssistantCard]], ["library", [aiAssistantCard]],
  ["overview", [aiAssistantCard, () => state.me.role === "superintendent" ? aiPolicyCard() : null]]]) {
  const base = VIEWS[view];
  VIEWS[view] = async () => [...[await base()].flat(), ...(await Promise.all(extra.map(f => f())))];
}
// ----- 37.6.0 Enrollment: family applications and the school leaders' board -----
// Families apply for a seat and follow each step; principals (own school) and
// superintendents (all schools) move applications through review, offer,
// waitlist and enrollment within the seats they set.
SUBVIEWS.push("enroll", "enrollboard", "enrollapp");
const ENR_GRADE = g => g === "K" ? "Kindergarten" : g === "PK" ? "Pre-K" : `Grade ${g}`;
const ENR_ACTION = { applied: "Submit application", documents: "Ask for documents", review: "Send to review", offered: "Offer a seat", waitlisted: "Waitlist",
  accepted: "Accept the offer", declined: "Decline", withdrawn: "Withdraw" };
async function enrollUpload(appId, kind, file) {
  if (!api.csrf) api.csrf = (await api.req("GET", "/api/csrf")).csrfToken;
  const r = await fetch(`/api/enrollment/applications/${appId}/documents?kind=${encodeURIComponent(kind)}&filename=${encodeURIComponent(file.name)}`,
    { method: "POST", credentials: "same-origin", headers: { "content-type": file.type || "application/octet-stream", "x-csrf-token": api.csrf }, body: file });
  if (!r.ok) throw Object.assign(new Error("upload"), { body: await r.json().catch(() => ({})) });
}
const enrollMove = (id, to, view) => h("button", { class: to === "withdrawn" || to === "declined" ? "btn" : "btn primary", type: "button", onclick: async () => {
  if (["withdrawn", "declined"].includes(to) && !await ask({ title: `${ENR_ACTION[to]}?`, text: "This can't be undone.", confirm: ENR_ACTION[to], danger: true })) return;
  try { await api.post(`/api/enrollment/applications/${id}/status`, { to }); toast("Updated"); go(view, { push: false }); }
  catch (e) { toast({ no_seats_left_use_waitlist: "No seats left. Use the waitlist.", upload_a_document_first: "Upload a document first." }[e.body?.error] || "Couldn't update."); } } }, ENR_ACTION[to] || to);
VIEWS.enroll = async () => {
  const [mine, opt] = await Promise.all([api.get("/api/enrollment/mine"), api.get("/api/enrollment/options")]);
  const { applications, stages } = mine.data, o = opt.data;
  const school = h("select", { id: "en-s" }, o.schools.map(s => h("option", { value: s.id }, s.name)));
  const year = h("select", { id: "en-y" }, o.schoolYears.map(y => h("option", { value: y }, y)));
  const grade = h("select", { id: "en-g" }, o.grades.map(g => h("option", { value: g }, ENR_GRADE(g))));
  const first = h("input", { id: "en-f", required: true, maxlength: 80, autocomplete: "off" }), last = h("input", { id: "en-l", required: true, maxlength: 80, autocomplete: "off" });
  const born = h("input", { id: "en-b", type: "date" });
  const list = applications.map(a => {
    const at = stages.findIndex(s => s.id === a.status);
    const kind = h("select", { id: `en-k-${a.id}`, "aria-label": "Document type" }, o.documentKinds.map(k => h("option", { value: k.id }, k.label)));
    const file = h("input", { id: `en-file-${a.id}`, type: "file", accept: "application/pdf,image/png,image/jpeg", "aria-label": "Document file" });
    return h("li", {},
      h("div", { class: "row" }, h("h3", { class: "grow" }, `${a.child.firstName} ${a.child.lastName}`), chip(a.status === "enrolled" ? "present" : ["declined", "withdrawn"].includes(a.status) ? "absent" : "expected", a.statusLabel)),
      h("p", { class: "small muted" }, `${a.schoolName} · ${ENR_GRADE(a.grade)} · ${a.schoolYear}`),
      at >= 0 ? h("p", { class: "small" }, stages.map((s, i) => `${i <= at ? "●" : "○"} ${s.label}`).join("  ")) : null,
      a.waitlistPosition ? h("p", { class: "notice" }, `Waitlist position ${a.waitlistPosition}`) : null,
      a.offerExpiresOn && a.status === "offered" ? h("p", { class: "notice" }, `Please answer by ${fmtDay(a.offerExpiresOn)}.`) : null,
      a.files.length ? h("ul", { class: "list" }, a.files.map(f => kv(`${f.filename}`, f.status))) : null,
      ["inquiry", "applied", "documents", "review"].includes(a.status) ? h("form", { class: "stack", onsubmit: async e => { e.preventDefault();
        if (!file.files[0]) return toast("Choose a file.");
        try { await enrollUpload(a.id, kind.value, file.files[0]); toast("Uploaded"); go("enroll", { push: false }); }
        catch (err) { toast({ file_too_large: "Files must be 2 MB or less.", unsupported_document_type: "Use a PDF, PNG or JPEG." }[err.body?.error] || "Couldn't upload."); } } },
        h("label", { for: kind.id }, "Add a document"), kind, file, h("button", { class: "btn", type: "submit" }, "Upload")) : null,
      a.nextActions.length ? h("div", { class: "row wrap" }, a.nextActions.map(to => enrollMove(a.id, to, "enroll"))) : null);
  });
  return [back("children", "Back"), h("h2", {}, "Enrollment"),
    list.length ? h("section", { class: "card", "aria-label": "Your applications" }, h("ul", { class: "list" }, list)) : empty("No applications yet."),
    h("section", { class: "card", "aria-label": "Apply for a seat" }, h("h2", {}, "Apply for a seat"),
      h("form", { class: "stack", onsubmit: async e => { e.preventDefault();
        try { await api.post("/api/enrollment/applications", { schoolId: school.value, schoolYear: year.value, gradeLevel: grade.value, childFirstName: first.value, childLastName: last.value, childBirthDate: born.value || null });
          toast("Application sent"); go("enroll", { push: false }); } catch { toast("Couldn't send the application."); } } },
        h("label", { for: "en-f" }, "Child's first name"), first, h("label", { for: "en-l" }, "Child's last name"), last, h("label", { for: "en-b" }, "Date of birth (optional)"), born,
        h("label", { for: "en-s" }, "School"), school, h("label", { for: "en-y" }, "School year"), year, h("label", { for: "en-g" }, "Grade"), grade,
        h("button", { class: "btn primary", type: "submit" }, "Send application")),
      h("p", { class: "small muted" }, "Only you and the school's leaders see this application. Documents are deleted after the decision on the district's schedule."))];
};
VIEWS.enrollboard = async () => {
  const b = (await api.get(`/api/enrollment/board${state.enrollYear ? `?year=${encodeURIComponent(state.enrollYear)}` : ""}`)).data;
  const yearSel = h("select", { id: "eb-y", "aria-label": "School year", onchange: e => { state.enrollYear = e.target.value; go("enrollboard", { push: false }); } }, (b.years.length ? b.years : [b.year].filter(Boolean)).map(y => h("option", { value: y, selected: y === b.year }, y)));
  const cy = h("input", { id: "eb-cy", value: b.year || "", placeholder: "2027-28", pattern: "\\d{4}-\\d{2}" }), cg = h("input", { id: "eb-cg", value: "K", maxlength: 2 }), cs = h("input", { id: "eb-cs", type: "number", min: 0, max: 5000, value: "20" });
  const capForm = state.me.role === "principal" ? h("form", { class: "stack", onsubmit: async e => { e.preventDefault();
    try { await api.req("PUT", "/api/enrollment/capacity", { schoolYear: cy.value, gradeLevel: cg.value, seats: Number(cs.value) }); state.enrollYear = cy.value; toast("Seats saved"); go("enrollboard", { push: false }); } catch { toast("Couldn't save seats."); } } },
    h("label", { for: "eb-cy" }, "School year"), cy, h("label", { for: "eb-cg" }, "Grade (PK, K, 1-12)"), cg, h("label", { for: "eb-cs" }, "New-student seats"), cs, h("button", { class: "btn", type: "submit" }, "Save seats")) : null;
  return [back("overview", "Back"), h("h2", {}, "Enrollment"), b.years.length ? yearSel : null,
    b.capacity.length ? h("section", { class: "card", "aria-label": "Seats" }, h("h2", {}, "Seats"), h("ul", { class: "list" }, b.capacity.map(c =>
      kv(`${c.schoolName} · ${ENR_GRADE(c.grade)}`, `${c.committed} of ${c.seats} committed${c.waitlisted ? ` · ${c.waitlisted} waitlisted` : ""}${c.full ? " · full" : ""}`)))) : null,
    ...b.columns.filter(c => c.items.length).map(c => h("section", { class: "card", "aria-label": c.label }, h("h2", {}, `${c.label} (${c.items.length})`),
      h("ul", { class: "list" }, c.items.map(a => h("li", { class: "row" }, h("span", { class: "grow" }, `${a.child.firstName} ${a.child.lastName}`, h("br"), h("span", { class: "small muted" }, `${ENR_GRADE(a.grade)} · ${a.schoolName}${a.waitlistPosition ? ` · #${a.waitlistPosition}` : ""}`)),
        h("button", { class: "btn", type: "button", onclick: () => { state.enrollApp = a.id; go("enrollapp"); } }, "Open")))))),
    b.columns.some(c => c.items.length) ? null : empty("No applications for this year."),
    capForm ? h("section", { class: "card", "aria-label": "Set seats" }, h("h2", {}, "Set seats"), capForm) : null];
};
VIEWS.enrollapp = async () => {
  if (!state.enrollApp) return VIEWS.enrollboard();
  const a = (await api.get(`/api/enrollment/applications/${state.enrollApp}`)).data;
  return [back("enrollboard", "Enrollment"), h("h2", {}, `${a.child.firstName} ${a.child.lastName}`),
    h("section", { class: "card" }, h("ul", { class: "list" }, kv("Status", a.statusLabel), kv("School", a.schoolName), kv("Grade", ENR_GRADE(a.grade)), kv("Year", a.schoolYear),
      kv("Guardian", a.guardian.name), kv("Seats", a.seats?.seats == null ? "No limit set" : `${a.seats.committed} of ${a.seats.seats} committed`))),
    h("section", { class: "card", "aria-label": "Documents" }, h("h2", {}, "Documents"), a.files.length ? h("ul", { class: "list" }, a.files.map(f => h("li", { class: "row wrap" },
      h("a", { class: "grow", href: `/api/enrollment/documents/${f.id}` }, f.filename), chip(f.status === "verified" ? "present" : f.status === "rejected" ? "absent" : "expected", f.status),
      f.status === "pending" ? ["verified", "rejected"].map(st => h("button", { class: "btn", type: "button", onclick: async () => {
        try { await api.post(`/api/enrollment/documents/${f.id}/review`, { status: st }); go("enrollapp", { push: false }); } catch { toast("Couldn't save."); } } }, st === "verified" ? "Verify" : "Reject")) : null))) : empty("No documents yet.")),
    a.nextActions.length || a.status === "accepted" ? h("section", { class: "card", "aria-label": "Next step" }, h("div", { class: "row wrap" },
      a.nextActions.filter(t => t !== "enrolled").map(to => enrollMove(a.id, to, "enrollapp")),
      a.status === "accepted" ? h("button", { class: "btn primary", type: "button", onclick: async () => {
        try { const r = (await api.post(`/api/enrollment/applications/${a.id}/enroll`, {})).data; toast(`Enrolled as ${r.studentNumber}`); go("enrollapp", { push: false }); } catch { toast("Couldn't enroll."); } } }, "Enroll") : null)) : null,
    h("section", { class: "card", "aria-label": "History" }, h("h2", {}, "History"), h("ul", { class: "list" }, a.events.map(e => kv(`${e.to_status}${e.note ? ` · ${e.note}` : ""}`, `${fmtDay(e.at)} · ${e.actor_role}`))))];
};
for (const view of ["children", "overview"]) {
  const base = VIEWS[view];
  VIEWS[view] = async () => [...[await base()].flat(), state.me.role === "parent"
    ? h("section", { class: "card", "aria-label": "Enrollment" }, h("h2", {}, "Enrollment"), h("p", { class: "small muted" }, "Apply for a seat for a new child and follow each step."), h("button", { class: "btn", type: "button", onclick: () => go("enroll") }, "Open enrollment"))
    : ["principal", "superintendent"].includes(state.me.role) ? h("section", { class: "card", "aria-label": "Enrollment" }, h("h2", {}, "Enrollment"), h("p", { class: "small muted" }, "Applications, seats and the waitlist."), h("button", { class: "btn", type: "button", onclick: () => go("enrollboard") }, "Open enrollment board")) : null];
}

// ----- 37.7.0 Commerce: tickets, receipts, revenue, refunds, marketplace -----
// 37.7.1: each district picks its own payment options (VIEWS.payments). The
// sandbox confirms pretend payments; PayPal, Square and BTCPay send the payer
// to the processor's own page and back here (?commerce_return=<payment id>).
SUBVIEWS.push("tickets", "receipt", "commerce", "payments");
const money = (c, cur = "USD") => `${c < 0 ? "-" : ""}${cur === "USD" ? "$" : cur + " "}${(Math.abs(Number(c)) / 100).toFixed(2)}`;
const CM_LINE = { gross: "Paid", processing_fee: "Payment processing", sales_tax: "Sales tax", network_fee: "EduOS network fee", school_share: "School",
  district_share: "District", state_share: "State fund", marketplace_fee: "Marketplace fee", vendor_payable: "Vendor" };
const CM_ERR = { paid_ticketing_not_configured: "Paid tickets aren't turned on for your district.", guardian_payment_required: "A parent or guardian has to pay for tickets.",
  ticket_capacity_exceeded: "Not enough tickets left.", guardian_school_link_required: "Tickets are for families of this school.", price_below_fees: "The price is lower than the fees.",
  ticket_already_used: "A ticket on this order was already scanned at the gate.", payment_not_refundable: "This payment can't be refunded.",
  split_must_total_100_percent: "The split must add up to 100%.", invalid_rate: "Check the rates.", listing_not_priced: "Set a price for this listing first.",
  already_purchased: "This license is already paid for.", invalid_quantity: "Say how many seats to pay for.", ticket_not_found: "That code isn't a ticket for this event.",
  ticket_not_checkin_eligible: "That ticket was already used or refunded.", invalid_ticket_type: "Check the name, price and capacity.", commerce_not_enabled: "Commerce is off.",
  payment_method_not_available: "That payment option isn't offered. Pick another.", card_processor_not_chosen: "The district hasn't chosen who processes cards.",
  payment_adapter_not_available: "That payment option isn't available in EduOS yet.", live_payments_disabled: "Live payments are switched off on this server.",
  commerce_secrets_key_missing: "District IT must set COMMERCE_SECRETS_KEY on the server first.", provider_credentials_missing: "This payment account is missing credentials.",
  provider_credentials_unreadable: "Saved credentials can't be read. Enter them again.", provider_incomplete: "Fill in the required fields before turning this on.",
  live_requires_credentials: "Live mode needs every required credential.", invalid_field: "Check the highlighted field's format.", btcpay_host_not_allowed: "Ask district IT to allow your BTCPay Server's host.",
  default_method_not_enabled: "The default has to be one of the options you offer.", invalid_payment_methods: "Check the payment options.", invalid_card_processor: "Pick Square or PayPal for cards.",
  provider_auth_failed: "The processor rejected these credentials.", provider_unreachable: "Couldn't reach the processor. Try again.", provider_http_error: "The processor returned an error.",
  provider_host_not_allowed: "That processor address isn't allowed.", provider_amount_mismatch: "The processor's amount didn't match. Nothing was issued; contact the district.",
  provider_bad_response: "The processor sent an unexpected reply.", provider_refund_failed: "The processor didn't accept the refund.", currency_not_supported: "Only US dollars are supported.",
  order_not_awaiting_payment: "This order isn't waiting for payment any more.", purchase_not_awaiting_payment: "This purchase isn't waiting for payment any more." };
const cmErr = (e, fallback = "Couldn't do that.") => toast(CM_ERR[e?.body?.error] || fallback);
const cmKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
const pct = bps => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
const PROC_LABEL = { sandbox: "Sandbox", paypal: "PayPal", square: "Square", btcpay: "BTCPay Server" };
function cmBanner(st) {
  return h("p", { class: "notice" }, st?.enabled ? (st.note || (st.live ? "Payments are live: real money moves." : "Test payments: no real money moves."))
    : !st || !(st.methods || []).length ? "Paid tickets are off: the district hasn't connected a payment option yet. No payment is collected here."
    : "Paid tickets are off until the district turns them on.");
}
// "Pay with" picker, shown only when the district offers more than one ready option.
function methodPick(st, id) {
  const ms = st?.methods || [];
  if (ms.length < 2) return null;
  const sel = h("select", { id, "aria-label": "Pay with" }, ms.map(m => h("option", { value: m.method, selected: m.method === st.defaultMethod },
    `${m.label}${m.processor !== "sandbox" && m.mode === "test" ? " (test)" : ""}`)));
  return h("div", { class: "row wrap" }, h("label", { for: id }, "Pay with"), sel);
}
const pickedMethod = (wrap, st) => wrap?.querySelector("select")?.value || (st?.methods?.length === 1 ? st.methods[0].method : undefined);
// Show a confirm result in `out`; returns true when nothing is left to do.
function cmShowResult(out, r, pay, onDone, retry) {
  const sandbox = (r.payment?.provider || pay?.provider) === "sandbox";
  if (r.status === "succeeded") {
    toast(sandbox ? "Paid (sandbox)" : "Paid");
    out.replaceChildren(r.tickets ? issuedTickets(r.tickets) : h("p", {}, "Paid."),
      r.receipt ? h("button", { class: "btn", type: "button", onclick: () => { state.receiptId = r.receipt.id; go("receipt"); } }, `Receipt ${r.receipt.number}`) : null);
  } else if (r.status === "declined") { toast("Payment declined. Your seats were released."); out.replaceChildren(h("p", { class: "muted" }, sandbox ? "Declined (sandbox). Nothing was charged." : "Declined. Nothing was charged.")); }
  else if (r.status === "pending") {
    out.replaceChildren(h("p", { class: "muted", role: "status" }, "The payment isn't finished yet. If you completed it, give it a moment and check again."),
      retry ? h("button", { class: "btn", type: "button", onclick: retry }, "Check again") : null);
    return false;
  } else {
    toast("The hold ran out. Start again.");
    out.replaceChildren(h("p", { class: "muted" }, r.reason || "The hold expired."), r.paidAfterHold ? h("p", { class: "notice" }, "Your payment arrived after the hold ended. The district will refund it.") : null);
  }
  onDone?.(r);
  return true;
}
// Back from a processor's page (?commerce_return=<id>): confirm once on arrival.
function cmResume(onDone) {
  const ret = state.cmReturn;
  if (!ret) return null;
  state.cmReturn = null;
  const out = h("div", { class: "stack", role: "status" }, h("p", { class: "muted" }, ret.cancelled ? "" : "Checking your payment…"));
  const check = async () => {
    try { cmShowResult(out, (await api.post(`/api/commerce/payments/${ret.id}/confirm`, {})).data, null, onDone, check); }
    catch (e) { out.replaceChildren(h("p", { class: "muted" }, CM_ERR[e?.body?.error] || "Couldn't check the payment.")); }
  };
  if (ret.cancelled) out.replaceChildren(h("p", { class: "muted" }, "You left the payment page. Nothing was charged; held seats are released when the hold ends."),
    h("button", { class: "btn", type: "button", onclick: check }, "I did pay: check again"));
  else check();
  return h("section", { class: "card", "aria-label": "Payment result" }, h("h3", {}, "Your payment"), out);
}
function issuedTickets(tickets, title) {
  return h("section", { class: "card pass", "aria-label": "Your tickets" }, h("h2", {}, title || "Your tickets"),
    tickets.map((t, i) => h("div", { class: "stack" }, t.qr ? qrSvg(t.qr, `QR code for ticket ${i + 1}`) : null, h("p", { class: "code" }, t.code))),
    h("p", { class: "small muted" }, "Show these at the gate. They're shown once: EduOS keeps only a fingerprint of each code, so save or screenshot them now."));
}
function payPanel(pay, { onDone } = {}) {
  const out = h("div", { class: "stack" });
  const confirmPay = async outcome => {
    try { cmShowResult(out, (await api.post(`/api/commerce/payments/${pay.id}/confirm`, outcome ? { testOutcome: outcome } : {})).data, pay, onDone, () => confirmPay()); }
    catch (e) { cmErr(e, "Couldn't confirm the payment."); }
  };
  const head = [h("h3", {}, `Pay ${money(pay.amountCents, pay.currency)}`),
    pay.holdExpiresAt ? h("p", { class: "small muted" }, `Seats are held until ${fmtTime(pay.holdExpiresAt)}.`) : null];
  if (pay.provider === "sandbox") {
    return h("section", { class: "card", "aria-label": "Pay" }, head,
      h("p", { class: "notice" }, "Sandbox: pick an outcome. No card, no real money."),
      h("div", { class: "row wrap" },
        h("button", { class: "btn primary", type: "button", onclick: () => confirmPay("sandbox_success") }, "Pay (sandbox)"),
        h("button", { class: "btn", type: "button", onclick: () => confirmPay("sandbox_decline") }, "Simulate a decline")), out);
  }
  const where = PROC_LABEL[pay.provider] || "the payment page";
  return h("section", { class: "card", "aria-label": "Pay" }, head,
    h("p", { class: "notice" }, pay.test ? `Test mode: ${where}'s test system. No real money moves.` : `You'll pay on ${where}'s secure page. EduOS never sees your card or login.`),
    pay.provider === "btcpay" ? h("p", { class: "small muted" }, "Bitcoin refunds are paid back in dollars at the price you paid.") : null,
    h("div", { class: "row wrap" },
      pay.redirectUrl ? h("a", { class: "btn primary", href: pay.redirectUrl, rel: "noopener noreferrer" }, `Continue to ${where}`) : null,
      h("button", { class: "btn", type: "button", onclick: () => confirmPay() }, "I've paid: check status")), out);
}

// Families: tickets on sale, checkout, my tickets and receipts.
VIEWS.tickets = async () => {
  const role = state.me.role, parent = role === "parent";
  const [st, shop, mine, my] = await Promise.all([safe(api.get("/api/commerce/status")), safe(api.get("/api/commerce/shop"), { data: { events: [] } }),
    parent ? safe(api.get("/api/commerce/my"), { data: { payments: [] } }) : null, safe(api.get("/api/my/tickets"), { data: [] })]);
  const s = st?.data, area = h("div", { class: "stack", id: "ticket-checkout" }), pick = parent && s?.enabled ? methodPick(s, "tk-method") : null;
  const resumed = cmResume(() => setTimeout(() => go("tickets", { push: false }), 2500));
  if (resumed) area.append(resumed);
  const buy = async (ev, t, qty) => {
    try {
      const r = (await api.post(`/api/events/${ev.id}/tickets`, { ticketTypeId: t.id, quantity: qty, idempotencyKey: cmKey(),
        paymentMethod: t.priceCents > 0 ? pickedMethod(pick, s) : undefined })).data;
      area.replaceChildren(r.payment ? payPanel(r.payment) : issuedTickets(r.tickets, "Your free tickets"));
      area.scrollIntoView?.({ behavior: "smooth" });
    } catch (e) { cmErr(e, "Couldn't get tickets."); }
  };
  const KIND_LBL = { sport: "Sports", play: "Play", concert: "Concert", recital: "Recital", assembly: "Assembly", ceremony: "Ceremony", club_showcase: "Club showcase", other: "Live event" };
  const PASS_LBL = { admission: "Admission", stream_pass: "Livestream pass", season_stream_pass: "Season stream pass" };
  const watchStream = async ev => {
    try {
      const r = (await api.post(`/api/events/${ev.id}/stream/access`, {})).data;
      area.replaceChildren(h("section", { class: "card", "aria-label": "Livestream access" },
        h("h3", {}, `${ev.title} — Livestream`),
        h("p", { class: "small" }, r.mediaPolicy?.unconsentedExcludedOrBlurred ? "Media consent enforced: students without consent are excluded or blurred." : "Access verified."),
        h("p", { class: "code small" }, `Token expires ${fmtTime(r.expiresAt)}`)));
    } catch (e) {
      const msg = { stream_live_kill_switch_off: "Livestream is turned off right now.", stream_pass_required: "A paid stream pass or season pass is required.", media_consent_masking_required: "Stream paused until unconsented students are masked." }[e?.body?.error];
      toast(msg || "Stream unavailable.");
    }
  };
  const typeRow = (ev, t) => {
    const paid = t.priceCents > 0, max = Math.min(10, t.available);
    const qty = h("select", { "aria-label": `How many ${t.name} tickets` }, Array.from({ length: Math.max(max, 1) }, (_, i) => h("option", { value: i + 1 }, String(i + 1))));
    const blocked = t.available < 1 ? "Sold out" : paid && !parent ? "Ask a parent or guardian to buy this." : paid && !s?.enabled ? "Paid tickets are off" : null;
    const passTag = PASS_LBL[t.passKind] || "Admission";
    return h("li", { class: "row wrap" }, h("span", { class: "grow" }, h("b", {}, t.name), " · ", paid ? money(t.priceCents, t.currency) : "Free",
      h("span", { class: "small muted" }, ` · ${passTag}${t.streamSeasonTitle ? ` (${t.streamSeasonTitle})` : ""} · ${t.available} left`)),
      blocked ? h("span", { class: "small muted" }, blocked) : [qty, h("button", { class: "btn primary", type: "button", onclick: () => buy(ev, t, Number(qty.value)) }, paid ? "Buy" : "Get")]);
  };
  const events = shop?.data?.events || [];
  return [back("activities", "Clubs & Sports"), h("h2", {}, "Tickets"), cmBanner(s),
    !parent ? h("p", { class: "small muted" }, "Students can get free tickets. A parent or guardian buys paid ones.") : null,
    pick,
    events.length ? events.map(ev => h("section", { class: "card", "aria-label": ev.title },
      h("div", { class: "row wrap" }, h("h3", { class: "grow" }, ev.title), chip("expected", KIND_LBL[ev.eventKind] || "Live event"),
        ev.hasStream ? h("button", { class: "btn small", type: "button", onclick: () => watchStream(ev) }, ev.streamAccessMode === "paid_pass" ? "Watch paid stream" : "Watch stream") : null),
      h("p", { class: "small muted" }, `${fmtDay(ev.startsAt)} ${fmtTime(ev.startsAt)}${ev.venue ? ` · ${ev.venue}` : ""} · ${ev.school}`),
      h("ul", { class: "list" }, ev.ticketTypes.map(t => typeRow(ev, t))))) : h("section", { class: "card" }, empty("No tickets on sale right now.")),
    area,
    h("section", { class: "card", "aria-label": "My tickets" }, h("h2", {}, "My tickets"),
      (my?.data || []).length ? h("ul", { class: "list" }, my.data.map(t => h("li", { class: "row" }, h("span", { class: "grow" }, t.event_title, h("span", { class: "small muted" }, ` · ${fmtDay(t.starts_at)}`)),
        chip(t.status === "issued" ? "present" : t.status === "checked_in" ? "present" : "absent", t.status.replace("_", " "))))) : empty("No tickets yet.")),
    parent ? h("section", { class: "card", "aria-label": "Payments and receipts" }, h("h2", {}, "Payments & receipts"),
      (mine?.data?.payments || []).length ? h("ul", { class: "list" }, mine.data.payments.map(p => h("li", { class: "row wrap" },
        h("span", { class: "grow" }, `${p.title || "Purchase"} · ${money(p.amountCents, p.currency)}`, h("span", { class: "small muted" }, ` · ${fmtDay(p.createdAt)}`)),
        chip(p.status === "succeeded" ? "present" : p.status === "refunded" ? "expected" : "absent", p.status.replace("_", " ")),
        p.receipts.map(r => h("button", { class: "btn", type: "button", onclick: () => { state.receiptId = r.id; go("receipt"); } }, r.kind === "refund" ? "Refund receipt" : "Receipt"))))) : empty("No payments.")) : null];
};

VIEWS.receipt = async () => {
  if (!state.receiptId) return VIEWS.tickets();
  const r = (await api.get(`/api/commerce/receipts/${state.receiptId}`)).data;
  const label = l => l.line === "state_share" ? r.stateFundLabel : CM_LINE[l.line] || l.line;
  const backTo = ["principal", "superintendent"].includes(state.me.role) ? back("commerce", "Ticketing & revenue") : back("tickets", "Tickets");
  return [backTo, h("section", { class: "card", "aria-label": "Receipt" },
    h("h2", {}, r.kind === "refund" ? "Refund receipt" : "Receipt"), h("p", { class: "code" }, r.number),
    h("ul", { class: "list" }, kv("Item", r.description), r.school ? kv("School", r.school) : null, kv("Date", `${fmtDay(r.issuedAt)} ${fmtTime(r.issuedAt)}`),
      kv(r.kind === "refund" ? "Refunded" : "Total", money(Math.abs(r.amountCents), r.currency))),
    h("h3", {}, "Where the money goes"),
    h("ul", { class: "list" }, r.lines.filter(l => l.line !== "gross").map(l => kv(label(l), money(l.amount, r.currency)))),
    r.edal ? h("p", { class: "small muted" }, `Recorded in the district ledger (EDAL #${r.edal.seq}, ${r.edal.entryHash.slice(0, 12)}…).`) : null,
    h("p", { class: "notice" }, r.note),
    h("button", { class: "btn", type: "button", onclick: () => window.print() }, "Print"))];
};

// Leaders: settings (superintendent), revenue, refunds, gate check-in, ticket types, marketplace.
VIEWS.commerce = async () => {
  const supt = state.me.role === "superintendent";
  const [st, rep, evs, seasons, mkt] = await Promise.all([api.get("/api/commerce/status"), safe(api.get("/api/commerce/report")), safe(api.get("/api/events"), { data: [] }),
    safe(api.get("/api/stream-seasons"), { data: [] }), supt ? safe(api.get("/api/commerce/marketplace")) : null]);
  const seasonList = seasons?.data || [];
  const s = st.data, set = s.settings, report = rep?.data, reload = () => go("commerce", { push: false });
  const upcoming = (evs?.data || []).filter(e => new Date(e.ends_at || e.starts_at) >= new Date());
  const evPick = id => h("select", { id, "aria-label": "Event" }, upcoming.map(e => h("option", { value: e.id }, `${e.title} · ${fmtDay(e.starts_at)}`)));
  const out = [back("activities", "Clubs & Sports"), h("h2", {}, "Ticketing & revenue"), cmBanner(s)];
  const resumed = cmResume(() => setTimeout(reload, 2500));
  if (resumed) out.push(resumed);
  if (s.canManageProviders) out.push(h("section", { class: "card", "aria-label": "Payment options" }, h("h2", {}, "Payment options"),
    h("p", { class: "small muted" }, (s.methods || []).length ? `Families can pay with: ${s.methods.map(m => m.label).join(", ")}.` : "No payment option is set up yet."),
    h("button", { class: "btn", type: "button", onclick: () => go("payments") }, "Set up PayPal, cards, Square, Bitcoin, Venmo or Cash App")));

  if (supt) {
    const num = (id, v, step = "0.01") => h("input", { id, type: "number", step, min: 0, value: v });
    const en = h("input", { id: "cm-en", type: "checkbox", class: "check", checked: set.enabled }), nf = num("cm-nf", set.networkFeeBps / 100), tx = num("cm-tx", set.salesTaxBps / 100),
      sc = num("cm-sc", set.split.schoolBps / 100), di = num("cm-di", set.split.districtBps / 100), stt = num("cm-st", set.split.stateBps / 100),
      lbl = h("input", { id: "cm-lbl", maxlength: 120, value: set.stateFundLabel }), mf = num("cm-mf", set.marketplaceFeeBps / 100), hold = num("cm-hold", set.holdMinutes, "1");
    const bps = el => Math.round(Number(el.value) * 100);
    out.push(h("section", { class: "card", "aria-label": "Commerce settings" }, h("h2", {}, "District settings"),
      h("p", { class: "small muted" }, "Defaults follow the EduOS plan: 3% network fee; net revenue 85% school, 10% district, 5% state fund; 5% marketplace fee. Check sales tax with your finance office."),
      h("form", { class: "stack", onsubmit: async e => {
        e.preventDefault();
        try { await api.put("/api/commerce/settings", { enabled: en.checked, networkFeeBps: bps(nf), salesTaxBps: bps(tx), split: { schoolBps: bps(sc), districtBps: bps(di), stateBps: bps(stt) },
          stateFundLabel: lbl.value, marketplaceFeeBps: bps(mf), holdMinutes: Number(hold.value) }); toast("Saved"); reload(); } catch (err) { cmErr(err, "Couldn't save."); }
      } },
        h("label", { class: "row" }, en, h("span", {}, (s.methods || []).length ? "Turn on paid tickets" : "Turn on paid tickets (set up a payment option first)")),
        h("label", { for: "cm-nf" }, "Network fee (%)"), nf, h("label", { for: "cm-tx" }, "Sales tax (%)"), tx,
        h("label", { for: "cm-sc" }, "School share of net (%)"), sc, h("label", { for: "cm-di" }, "District share of net (%)"), di, h("label", { for: "cm-st" }, "State fund share of net (%)"), stt,
        h("label", { for: "cm-lbl" }, "State fund name"), lbl, h("label", { for: "cm-mf" }, "Marketplace fee (%)"), mf, h("label", { for: "cm-hold" }, "Hold seats at checkout (minutes)"), hold,
        h("button", { class: "btn primary", type: "submit" }, "Save settings"))));
  } else {
    out.push(h("section", { class: "card" }, h("ul", { class: "list" }, kv("Paid tickets", s.enabled ? (s.live ? "On (live)" : s.sandbox ? "On (sandbox)" : "On (test)") : "Off"), kv("Network fee", pct(set.networkFeeBps)),
      kv("School share of net", pct(set.split.schoolBps)), kv("District share of net", pct(set.split.districtBps)), kv(`${set.stateFundLabel} share of net`, pct(set.split.stateBps)))));
  }

  if (report) {
    const t = report.totals || {}, row = k => t[k] ? kv(k === "state_share" ? set.stateFundLabel : CM_LINE[k], money(t[k])) : null;
    out.push(h("section", { class: "card", "aria-label": "Revenue" }, h("h2", {}, report.scope === "school" ? "School revenue" : "District revenue"),
      Object.keys(t).length ? h("ul", { class: "list" }, ["gross", "processing_fee", "sales_tax", "network_fee", "school_share", "district_share", "state_share", "marketplace_fee", "vendor_payable"].map(row))
        : empty("No sales yet."),
      report.bySchool?.length > 1 ? h("ul", { class: "list" }, report.bySchool.map(b => kv(b.name, `${money(b.totals.gross || 0)} sold · ${money(b.totals.school_share || 0)} to the school`))) : null,
      h("p", { class: "small muted" }, "Refunds appear as negative lines, so totals are net of refunds.")));
    out.push(h("section", { class: "card", "aria-label": "Payments" }, h("h2", {}, "Payments"),
      report.payments.length ? h("ul", { class: "list" }, report.payments.map(p => h("li", { class: "row wrap" },
        h("span", { class: "grow" }, `${p.title || "Purchase"}${p.quantity ? ` × ${p.quantity}` : ""} · ${money(p.amountCents, p.currency)}`, h("span", { class: "small muted" }, ` · ${p.payer} · ${fmtDay(p.createdAt)}`)),
        chip(p.status === "succeeded" ? "present" : "expected", p.status),
        p.refundable ? h("button", { class: "btn", type: "button", onclick: async () => {
          if (!(await ask({ title: "Refund this payment?", text: `Refund ${money(p.amountCents, p.currency)} to ${p.payer}? Their tickets stop working.`, confirm: "Refund", danger: true }))) return;
          try { const rr = (await api.post(`/api/commerce/payments/${p.id}/refund`, {})).data;
            if (rr?.manual) await ask({ title: "Send the refund yourself", text: rr.note || "Bitcoin refunds are paid in dollars outside EduOS. The refund is recorded.", confirm: "OK" });
            else toast(p.provider === "sandbox" || s.sandbox ? "Refunded (sandbox)" : "Refunded"); reload(); } catch (e) { cmErr(e, "Couldn't refund."); }
        } }, "Refund") : null))) : empty("No payments yet.")));
  }

  if (upcoming.length) {
    const ev = evPick("cm-gate-ev"), code = h("input", { id: "cm-code", autocomplete: "off", required: true, minlength: 20, maxlength: 128 }), res = h("p", { class: "small", role: "status" });
    out.push(h("section", { class: "card", "aria-label": "Gate check-in" }, h("h2", {}, "Gate check-in"),
      h("form", { class: "stack", onsubmit: async e => {
        e.preventDefault();
        try { await api.post(`/api/events/${ev.value}/check-in`, { ticketCode: code.value.trim() }); res.textContent = "✓ Admitted."; code.value = ""; }
        catch (err) { res.textContent = CM_ERR[err?.body?.error] || "Not admitted."; }
        code.focus();
      } }, h("label", { for: "cm-gate-ev" }, "Event"), ev, h("label", { for: "cm-code" }, "Ticket code (scan or type)"), code,
        h("button", { class: "btn primary", type: "submit" }, "Check in"), res)));
    const ev2 = evPick("cm-tt-ev"), name = h("input", { id: "cm-tt-name", required: true, maxlength: 80, value: "General admission" }),
      pk = h("select", { id: "cm-tt-pk" },
        h("option", { value: "admission" }, "Admission ticket"),
        h("option", { value: "stream_pass" }, "Per-event livestream pass"),
        h("option", { value: "season_stream_pass" }, "Season livestream pass")),
      ssPick = h("select", { id: "cm-tt-ss" }, h("option", { value: "" }, "No season"), seasonList.map(x => h("option", { value: x.id }, `${x.title} (${x.school_year})`))),
      price = h("input", { id: "cm-tt-price", type: "number", min: 0, step: "0.01", value: "0" }), cap = h("input", { id: "cm-tt-cap", type: "number", min: 1, step: "1", value: "100" }),
      open = h("input", { id: "cm-tt-open", type: "checkbox", class: "check", checked: true });
    out.push(h("section", { class: "card", "aria-label": "Add tickets" }, h("h2", {}, "Add tickets or stream passes"),
      h("form", { class: "stack", onsubmit: async e => {
        e.preventDefault();
        try { await api.post(`/api/events/${ev2.value}/ticket-types`, { name: name.value, passKind: pk.value,
          streamSeasonId: pk.value === "season_stream_pass" ? (ssPick.value || undefined) : undefined,
          priceCents: Math.round(Number(price.value) * 100), capacity: Number(cap.value), salesOpen: open.checked });
          toast("Tickets added"); reload(); } catch (err) { cmErr(err, "Couldn't add tickets."); }
      } }, h("label", { for: "cm-tt-ev" }, "Event"), ev2, h("label", { for: "cm-tt-name" }, "Ticket or pass name"), name,
        h("label", { for: "cm-tt-pk" }, "Pass type"), pk, h("label", { for: "cm-tt-ss" }, "Stream season (for season passes)"), ssPick,
        h("label", { for: "cm-tt-price" }, "Price ($, 0 for free)"), price,
        h("label", { for: "cm-tt-cap" }, "How many"), cap, h("label", { class: "row" }, open, h("span", {}, "On sale now")),
        h("p", { class: "small muted" }, s.enabled ? `Families pay with ${(s.methods || []).map(m => m.label).join(", ")}. Students can only get free tickets.` : "Paid tickets can't be sold until commerce is on; free tickets work now."),
        h("button", { class: "btn primary", type: "submit" }, "Add tickets"))));

    const ev3 = evPick("cm-st-ev"), stAud = h("select", { id: "cm-st-aud" },
      h("option", { value: "ticket_holders" }, "Ticket / pass holders"), h("option", { value: "school" }, "School"), h("option", { value: "district" }, "District")),
      stMode = h("select", { id: "cm-st-mode" }, h("option", { value: "paid_pass" }, "Paid pass required"), h("option", { value: "free" }, "Free")),
      stSs = h("select", { id: "cm-st-ss" }, h("option", { value: "" }, "No season pass"), seasonList.map(x => h("option", { value: x.id }, `${x.title} (${x.school_year})`))),
      stLive = h("input", { id: "cm-st-live", type: "checkbox", class: "check", checked: false }),
      stMask = h("input", { id: "cm-st-mask", type: "checkbox", class: "check", checked: false }),
      stSec = h("input", { id: "cm-st-sec", type: "password", autocomplete: "new-password", placeholder: "Optional write-only stream key" });
    out.push(h("section", { class: "card", "aria-label": "Livestream paywall" }, h("h2", {}, "Livestream paywall & consent"),
      h("form", { class: "stack", onsubmit: async e => {
        e.preventDefault();
        try { await api.put(`/api/events/${ev3.value}/stream`, { audience: stAud.value, accessMode: stMode.value,
          streamSeasonId: stSs.value || null, liveEnabled: stLive.checked, mediaConsentRequired: true,
          unconsentedMinorsMasked: stMask.checked, streamSecret: stSec.value || undefined });
          toast("Livestream settings saved"); reload(); } catch (err) { cmErr(err, "Couldn't save stream settings."); }
      } }, h("label", { for: "cm-st-ev" }, "Event"), ev3, h("label", { for: "cm-st-mode" }, "Access"), stMode,
        h("label", { for: "cm-st-aud" }, "Audience"), stAud, h("label", { for: "cm-st-ss" }, "Season pass link"), stSs,
        h("label", { class: "row" }, stLive, h("span", {}, "Live stream enabled (kill switch, off by default)")),
        h("label", { class: "row" }, stMask, h("span", {}, "Unconsented minors excluded or blurred on stream")),
        h("label", { for: "cm-st-sec" }, "Stream secret (write-only)"), stSec,
        h("button", { class: "btn primary", type: "submit" }, "Save livestream"))));
  }

  if (supt || state.me.role === "it_admin") {
    const sp = (await safe(api.get("/api/stream-provider"), { data: { provider: "none", hasCredentials: false } })).data || {};
    const prov = h("select", { id: "cm-sp-prov" },
      [["none", "None"], ["mux", "Mux"], ["cloudflare_stream", "Cloudflare Stream"], ["vimeo", "Vimeo"], ["other", "Other"]]
        .map(([v, lbl]) => h("option", { value: v, selected: sp.provider === v }, lbl)));
    const cred = h("input", { id: "cm-sp-cred", type: "password", autocomplete: "new-password", placeholder: sp.hasCredentials ? "Credentials on file (write-only)" : "Optional API token (write-only)" });
    out.push(h("section", { class: "card", "aria-label": "Livestream provider" }, h("h2", {}, "Livestream provider"),
      h("p", { class: "small muted" }, "The district chooses the service. Credentials are stored encrypted and never shown again. This does not turn on a live connection."),
      h("form", { class: "stack", onsubmit: async e => {
        e.preventDefault();
        try {
          const body = { provider: prov.value };
          if (cred.value.trim()) body.credentials = { apiToken: cred.value.trim() };
          if (prov.value === "none") body.clearCredentials = true;
          await api.put("/api/stream-provider", body);
          toast("Livestream provider saved"); reload();
        } catch (err) { cmErr(err, "Couldn't save the livestream provider."); }
      } }, h("label", { for: "cm-sp-prov" }, "Provider"), prov, h("label", { for: "cm-sp-cred" }, "API token (write-only)"), cred,
        h("p", { class: "small muted" }, sp.hasCredentials ? "Credentials are on file." : "No credentials stored."),
        h("button", { class: "btn primary", type: "submit" }, "Save provider"))));
  }

  // Create standalone live event (play, concert, assembly, ceremony, etc.) + stream season.
  const evKind = h("select", { id: "cm-ev-kind" },
    [["play", "Play"], ["concert", "Concert"], ["recital", "Recital"], ["assembly", "Assembly"], ["ceremony", "Ceremony"], ["club_showcase", "Club showcase"], ["sport", "Sport"], ["other", "Other"]]
      .map(([v, lbl]) => h("option", { value: v }, lbl))),
    evTitle = h("input", { id: "cm-ev-title", required: true, maxlength: 180, placeholder: "Spring Musical" }),
    evVenue = h("input", { id: "cm-ev-venue", maxlength: 300, placeholder: "Main Auditorium" }),
    evStart = h("input", { id: "cm-ev-start", type: "datetime-local", required: true }),
    evEnd = h("input", { id: "cm-ev-end", type: "datetime-local", required: true });
  out.push(h("section", { class: "card", "aria-label": "Create live event" }, h("h2", {}, "Create live event"),
    h("form", { class: "stack", onsubmit: async e => {
      e.preventDefault();
      try { await api.post("/api/events", { eventKind: evKind.value, title: evTitle.value, venue: evVenue.value,
        startsAt: new Date(evStart.value).toISOString(), endsAt: new Date(evEnd.value).toISOString(), publish: true });
        toast("Live event published"); reload(); } catch (err) { cmErr(err, "Couldn't create event."); }
    } }, h("label", { for: "cm-ev-kind" }, "Event type"), evKind, h("label", { for: "cm-ev-title" }, "Title"), evTitle,
      h("label", { for: "cm-ev-venue" }, "Venue"), evVenue, h("label", { for: "cm-ev-start" }, "Starts"), evStart,
      h("label", { for: "cm-ev-end" }, "Ends"), evEnd,
      h("button", { class: "btn primary", type: "submit" }, "Publish event"))));

  if (supt && mkt?.data) {
    const area = h("div", { class: "stack" }), mpick = s.enabled ? methodPick(s, "mk-method") : null;
    out.push(h("section", { class: "card", "aria-label": "Marketplace purchases" }, h("h2", {}, "Marketplace purchases"),
      h("p", { class: "small muted" }, `Approved marketplace licenses. The vendor is paid the price less processing and the ${pct(mkt.data.marketplaceFeeBps)} marketplace fee.`),
      mkt.data.licenses.length ? h("ul", { class: "list" }, mkt.data.licenses.map(l => {
        const pr = h("input", { type: "number", min: 0.01, step: "0.01", "aria-label": `Price for ${l.name}`, value: l.unitPriceCents ? (l.unitPriceCents / 100).toFixed(2) : "" });
        const unit = h("select", { "aria-label": "Priced per" }, h("option", { value: "seat", selected: l.priceUnit === "seat" }, "per seat"), h("option", { value: "flat", selected: l.priceUnit === "flat" }, "flat"));
        const seats = l.seatLimit ? null : h("input", { type: "number", min: 1, step: "1", "aria-label": "Seats to pay for", placeholder: "Seats" });
        return h("li", { class: "stack" }, h("div", { class: "row wrap" }, h("span", { class: "grow" }, h("b", {}, l.name), ` · ${l.vendor}${l.seatLimit ? ` · ${l.seatLimit} seats` : ""}`),
            l.purchase ? chip(l.purchase.status === "paid" ? "present" : "expected", `${l.purchase.status.replace("_", " ")} · ${money(l.purchase.total_cents)}`) : null),
          l.purchase?.status === "paid" ? null : h("div", { class: "row wrap" }, pr, unit,
            h("button", { class: "btn", type: "button", onclick: async () => { try { await api.post(`/api/commerce/marketplace/listings/${l.listingId}/price`, { unitPriceCents: Math.round(Number(pr.value) * 100), priceUnit: unit.value }); toast("Price saved"); reload(); } catch (e) { cmErr(e, "Couldn't save the price."); } } }, "Save price"),
            seats, l.unitPriceCents && s.enabled ? h("button", { class: "btn primary", type: "button", onclick: async () => {
              try { const r = (await api.post(`/api/commerce/marketplace/fee-events/${l.feeEventId}/checkout`, { idempotencyKey: cmKey(), quantity: seats ? Number(seats.value) : undefined, paymentMethod: pickedMethod(mpick, s) })).data;
                area.replaceChildren(payPanel(r.payment, { onDone: () => setTimeout(reload, 1500) })); } catch (e) { cmErr(e, "Couldn't start the purchase."); }
            } }, s.sandbox ? "Buy (sandbox)" : "Buy") : null));
      })) : empty("No approved marketplace licenses yet."), mpick, area));
  }
  return out;
};

// 37.7.1 District payment setup (superintendent and district IT): quick-setup
// cards for PayPal, Visa/Mastercard, Square, Bitcoin, Venmo and Cash App.
// Credentials are write-only: saved secrets are never sent back, only whether
// each one is set. Live mode also needs the server's live switch.
const CM_STATUS = { not_set_up: ["absent", "Not set up"], test: ["expected", "Test"], live: ["present", "Live"], live_blocked: ["absent", "Live, switched off on server"] };
VIEWS.payments = async () => {
  const r = (await api.get("/api/commerce/providers")).data;
  const reload = () => go("payments", { push: false });
  const acct = p => r.processors[p];
  const stat = p => { const a = acct(p), [k, t] = CM_STATUS[a.status] || CM_STATUS.not_set_up; return chip(a.status === "not_set_up" ? k : a.enabled ? k : "absent", a.status !== "not_set_up" && !a.enabled ? `${t} · off` : t); };
  const linkList = m => {
    const ls = [m.signup, m.developer, ...m.docs, ...m.otherLinks].filter(Boolean);
    return ls.length ? h("ul", { class: "list small" }, ls.map(l => h("li", {}, h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.label)))) : null;
  };
  const procForm = p => {
    const a = acct(p), fid = k => `pv-${p}-${k}`;
    const inputs = a.fields.map(fd => ({ fd, inp: h("input", { id: fid(fd.key), type: fd.secret ? "password" : "text", autocomplete: fd.secret ? "new-password" : "off", spellcheck: "false", maxlength: fd.max,
      placeholder: fd.secret ? (a.secretsSet[fd.key] ? "Saved. Leave blank to keep it." : "Not saved") : fd.placeholder || "", value: fd.secret ? "" : a.config[fd.key] || "" }) }));
    const en = h("input", { id: fid("en"), type: "checkbox", class: "check", checked: a.enabled });
    const mode = h("select", { id: fid("mode") }, h("option", { value: "test", selected: a.mode === "test" }, "Test (the processor's sandbox, no real money)"),
      h("option", { value: "live", selected: a.mode === "live" }, "Live (real money)"));
    const fee = h("input", { id: fid("fee"), type: "number", min: 0, max: 15, step: "0.01", value: a.fee.bps / 100 }),
      fix = h("input", { id: fid("fix"), type: "number", min: 0, max: 10, step: "0.01", value: (a.fee.fixedCents / 100).toFixed(2) });
    const res = h("p", { class: "small", role: "status" }, a.lastTest ? `Last test ${fmtDay(a.lastTest.at)} ${fmtTime(a.lastTest.at)}: ${a.lastTest.ok ? "connected" : `failed (${String(a.lastTest.detail || "error").replace(/_/g, " ")})`}` : "Not tested yet.");
    const save = async e => {
      e.preventDefault();
      if (mode.value === "live" && a.mode !== "live" && !(await ask({ title: `Switch ${a.label} to live?`, text: "Families will be charged real money once paid tickets are on. Make sure these are your live credentials.", confirm: "Go live", danger: true }))) return;
      try {
        await api.put(`/api/commerce/providers/${p}`, { enabled: en.checked, mode: mode.value, feeBps: Math.round(Number(fee.value) * 100), feeFixedCents: Math.round(Number(fix.value) * 100),
          config: Object.fromEntries(inputs.filter(x => !x.fd.secret).map(x => [x.fd.key, x.inp.value.trim()])),
          secrets: Object.fromEntries(inputs.filter(x => x.fd.secret && x.inp.value.trim()).map(x => [x.fd.key, x.inp.value.trim()])) });
        inputs.forEach(x => { if (x.fd.secret) x.inp.value = ""; });
        toast(`${a.label} saved`); reload();
      } catch (err) { inputs.forEach(x => { if (x.fd.secret) x.inp.value = ""; }); cmErr(err, "Couldn't save."); }
    };
    return h("form", { class: "stack", "aria-label": `${a.label} account`, onsubmit: save },
      h("h3", {}, `${a.label} account`), h("p", { class: "small muted" }, a.description),
      inputs.map(({ fd, inp }) => [h("label", { for: inp.id }, fd.label, fd.secret ? h("span", { class: "small muted" }, " · write-only") : null), inp]),
      p === "btcpay" ? h("p", { class: "small muted" }, r.btcpayAllowedHosts.length ? `Allowed BTCPay hosts on this server: ${r.btcpayAllowedHosts.join(", ")}.` : "District IT must add your BTCPay Server's host to COMMERCE_ALLOWED_HOSTS first.") : null,
      h("label", { for: fid("mode") }, "Mode"), mode,
      h("label", { for: fid("fee") }, "Processing fee estimate (%)"), fee, h("label", { for: fid("fix") }, "Plus per payment ($)"), fix,
      h("p", { class: "small muted" }, "The fee is your estimate from the processor's pricing; it shows on receipts. Check your actual rate in your processor account."),
      h("label", { class: "row" }, en, h("span", {}, "Use this account")),
      h("div", { class: "row wrap" }, h("button", { class: "btn primary", type: "submit" }, "Save"),
        h("button", { class: "btn", type: "button", onclick: async () => {
          res.textContent = "Testing…";
          try { const t = (await api.post(`/api/commerce/providers/${p}/test`, {})).data; res.textContent = t.ok ? `Connected (${t.mode} mode).` : `Didn't connect: ${String(t.detail || "error").replace(/_/g, " ")}.`; }
          catch (err) { res.textContent = CM_ERR[err?.body?.error] || "Couldn't run the test."; }
        } }, "Test connection"),
        Object.values(a.secretsSet).some(Boolean) ? h("button", { class: "btn", type: "button", onclick: async () => {
          if (!(await ask({ title: `Remove saved ${a.label} credentials?`, text: "Checkout through this account stops until new credentials are saved.", confirm: "Remove", danger: true }))) return;
          try { await api.put(`/api/commerce/providers/${p}`, { clearSecrets: true, enabled: false }); toast("Removed"); reload(); } catch (err) { cmErr(err, "Couldn't remove."); }
        } }, "Remove credentials") : null),
      res);
  };
  const tile = m => {
    const via = m.processors.filter(p => p !== "sandbox" && acct(p));
    const coming = m.adapter === "coming" || (m.id === "card" && r.setup.cardProcessor === "paypal") ? m.comingReason : null;
    return h("section", { class: "card", id: `pay-${m.id}`, "aria-label": `${m.label} setup` },
      h("div", { class: "row wrap" }, h("h2", { class: "grow" }, m.label),
        m.setupProcessor ? stat(m.setupProcessor) : m.id === "sandbox" ? chip("expected", "Test only") : null,
        coming ? chip("absent", "Adapter coming") : null,
        m.checkout && r.setup.enabledMethods.includes(m.id) ? chip("present", "Offered") : null),
      h("p", {}, m.description),
      !m.setupProcessor && via.length ? h("p", { class: "small" }, "Runs through: ", via.map((p, i) => [i ? ", " : "", h("a", { href: `#pay-${p === "btcpay" ? "bitcoin" : p}`, onclick: e => { e.preventDefault(); document.getElementById(`pay-${p === "btcpay" ? "bitcoin" : p}`)?.scrollIntoView({ behavior: "smooth" }); } }, PROC_LABEL[p]), ` (${(CM_STATUS[acct(p).status] || CM_STATUS.not_set_up)[1].toLowerCase()})`])) : null,
      coming ? h("p", { class: "notice" }, coming) : null,
      m.notes.length ? h("ul", { class: "small" }, m.notes.map(n => h("li", {}, n))) : null,
      linkList(m),
      m.setupProcessor ? procForm(m.setupProcessor) : null);
  };
  const offered = r.methods.filter(m => m.checkout);
  const boxes = offered.map(m => ({ m, box: h("input", { id: `pm-${m.id}`, type: "checkbox", class: "check", value: m.id, checked: r.setup.enabledMethods.includes(m.id) }) }));
  const def = h("select", { id: "pm-default" }, h("option", { value: "" }, "No default"), offered.map(m => h("option", { value: m.id, selected: r.setup.defaultMethod === m.id }, m.label)));
  const cardSel = h("select", { id: "pm-card" }, h("option", { value: "" }, "Not chosen"),
    ["square", "paypal"].map(p => h("option", { value: p, selected: r.setup.cardProcessor === p }, `${PROC_LABEL[p]}${p === "paypal" ? " (adapter coming)" : ""}`)));
  return [state.me.role === "superintendent" ? back("commerce", "Ticketing & revenue") : back("integrations", "Data links"),
    h("h2", {}, "Payment options"),
    h("p", { class: "muted" }, "Your district chooses how families pay. Connect an account below, test it, then pick which options families see. Nothing is charged until an account is in live mode and paid tickets are on."),
    h("p", { class: "notice" }, r.liveSwitch ? "Live payments are allowed on this server." : "Live payments are switched off on this server (COMMERCE_LIVE_PAYMENTS_ENABLED). Test mode and the sandbox work."),
    r.secretsKeyConfigured ? null : h("p", { class: "notice" }, "Credentials can't be saved until district IT sets COMMERCE_SECRETS_KEY on the server."),
    h("section", { class: "card", "aria-label": "What families can use" }, h("h2", {}, "What families can use"),
      h("form", { class: "stack", onsubmit: async e => {
        e.preventDefault();
        try { await api.put("/api/commerce/payment-methods", { enabledMethods: boxes.filter(b => b.box.checked).map(b => b.m.id), defaultMethod: def.value || null, cardProcessor: cardSel.value || null });
          toast("Payment options saved"); reload(); } catch (err) { cmErr(err, "Couldn't save."); }
      } },
        boxes.map(({ m, box }) => h("label", { class: "row" }, box, h("span", {}, m.label))),
        h("label", { for: "pm-card" }, "Who processes Visa / Mastercard"), cardSel,
        h("label", { for: "pm-default" }, "Shown first at checkout"), def,
        h("button", { class: "btn primary", type: "submit" }, "Save options"))),
    r.methods.map(tile), await webhookOperations()];
};

// 37.8.0: district webhook operations. The endpoint URL is a bearer credential:
// retain it only in this view, reveal it once, and never persist it locally.
async function webhookOperations() {
  const [refundLoad, deadLoad] = await Promise.allSettled([
    api.get("/api/commerce/providers/webhook-refund-cases"),
    api.get("/api/commerce/providers/webhook-dead-letters")
  ]);
  const refundCases = refundLoad.status === "fulfilled" && Array.isArray(refundLoad.value?.data?.refundCases)
    ? refundLoad.value.data.refundCases : null;
  const deadLetters = deadLoad.status === "fulfilled" && Array.isArray(deadLoad.value?.data?.deadLetters)
    ? deadLoad.value.data.deadLetters : null;
  const out = h("section", { class: "card", "aria-label": "Webhook operations" },
    h("h2", {}, "Payment webhook operations"),
    h("p", { class: "small muted" }, "Manage provider callback URLs and review payment events that need an administrator. Endpoint URLs contain a secret: copy them into the provider dashboard immediately. EduOS shows a newly issued URL only once."),
    h("div", { class: "stack" }, ["paypal", "square", "btcpay"].map(processor => {
      const label = PROC_LABEL[processor];
      const status = h("p", { class: "small muted", role: "status" }, "Endpoint status is not exposed; issuing or rotating replaces the previous URL.");
      const reveal = h("div", { class: "stack", hidden: true });
      const issue = async () => {
        if (!(await ask({ title: `Issue or rotate ${label} webhook URL?`, text: "The previous URL will stop working immediately. You must update the provider dashboard with the new URL.", confirm: "Issue URL", danger: true }))) return;
        try {
          const result = (await api.post(`/api/commerce/providers/${processor}/webhook-endpoint/rotate`, {})).data;
          const field = h("input", { type: "text", readonly: true, value: result.webhookUrl, "aria-label": `${label} one-time webhook URL`, autocomplete: "off" });
          const copy = h("button", { class: "btn", type: "button", onclick: async () => {
            try {
              if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(result.webhookUrl);
              else { field.focus(); field.select(); document.execCommand("copy"); }
              toast("Webhook URL copied");
            } catch { field.focus(); field.select(); toast("Select and copy the URL"); }
          } }, "Copy URL");
          reveal.hidden = false;
          reveal.replaceChildren(h("p", { class: "notice" }, result.notice || "Copy this URL now. It will not be shown again."), field, copy);
          status.textContent = "New URL issued. Update the matching provider dashboard now.";
        } catch (err) { cmErr(err, `Couldn't issue the ${label} URL.`); }
      };
      const revoke = async () => {
        if (!(await ask({ title: `Revoke ${label} webhook URL?`, text: "The provider will no longer be able to deliver callbacks to this district endpoint until a new URL is issued.", confirm: "Revoke", danger: true }))) return;
        try {
          await api.req("DELETE", `/api/commerce/providers/${processor}/webhook-endpoint`);
          reveal.hidden = true; reveal.replaceChildren(); status.textContent = "Active webhook URLs revoked.";
          toast(`${label} endpoint revoked`);
        } catch (err) { cmErr(err, `Couldn't revoke the ${label} URL.`); }
      };
      return h("div", { class: "stack" }, h("div", { class: "row wrap" },
        h("h3", { class: "grow" }, label), h("button", { class: "btn", type: "button", onclick: issue }, "Issue / rotate URL"),
        h("button", { class: "btn", type: "button", onclick: revoke }, "Revoke URL")), status, reveal);
    })),
    h("h3", {}, "Late payment captures needing a refund"),
    h("p", { class: "small muted" }, "These payments arrived after the ticket hold expired. Tickets were not issued. Refund the payer in the provider dashboard first, then record the resolution here."),
    refundCases === null ? h("p", { class: "notice", role: "alert" }, "Refund cases couldn't be loaded. Check your connection and reload this page before taking action.")
      : refundCases.length ? h("ul", { class: "list" }, refundCases.map(item => {
      const note = h("textarea", { rows: 2, minlength: 10, maxlength: 1000, placeholder: "Record when and how the refund was sent (10–1000 characters).", "aria-label": `Refund resolution for ${item.processor} capture ${item.captureRef}` });
      const meta = h("p", { class: "small muted" }, `${PROC_LABEL[item.processor] || item.processor} · ${item.captureRef} · ${money(item.amountCents, item.currency)} · ${String(item.reasonCode || "late_capture").replace(/_/g, " ")} · opened ${fmtDay(item.openedAt)}`);
      return h("li", { class: "stack" }, meta, note, h("button", { class: "btn", type: "button", onclick: async () => {
        if (note.value.trim().length < 10) { toast("Add a refund note of at least 10 characters"); note.focus(); return; }
        try {
          await api.post(`/api/commerce/providers/webhook-refund-cases/${item.id}/resolve`, { resolutionNote: note.value.trim() });
          toast("Refund resolution recorded"); go("payments", { push: false });
        } catch (err) { cmErr(err, "Couldn't record the refund resolution."); }
      } }, "Record refund resolution"));
    })) : empty("No late-capture refund cases are open."),
    h("h3", {}, "Webhook events requiring investigation"),
    deadLetters === null ? h("p", { class: "notice", role: "alert" }, "Dead-letter events couldn't be loaded. Check your connection and reload this page before concluding there are no failed events.")
      : deadLetters.length ? h("ul", { class: "list" }, deadLetters.map(item =>
      h("li", {}, h("p", {}, `${PROC_LABEL[item.processor] || item.processor} · ${item.eventType}`),
        h("p", { class: "small muted" }, `Event ${item.providerEventId} · ${item.attempts} attempts · ${item.errorCode || "unknown error"} · received ${fmtDay(item.receivedAt)}`)))) : empty("No webhook events are in the dead-letter queue."),
    h("p", { class: "small muted" }, "Dead-letter payloads and payer details are intentionally not displayed. Investigate the provider event using its ID and your provider's dashboard."));
  return out;
}

async function boot() {
  try {
    state.me = await api.get("/api/me");
  } catch (e) { if (e.status === 401) { await OQ.clear().catch(() => {}); return renderSignIn(); } put(empty(navigator.onLine ? "EduOS is unavailable right now." : "You're offline.")); return; }
  const [brand] = await Promise.all([safe(api.get("/api/branding/current")), loadProfiles().then(loadFamily)]);
  state.brand = brand?.data || null;
  applyBranding(state.brand);
  renderTop();
  if (!ROLE_TABS[state.me.role]) {
    renderTabs();
    put(h("section", { class: "card" }, h("h2", {}, "Use the full site"), h("p", {}, "District IT tools are on the full EduOS site."), h("a", { class: "btn primary", href: "/" }, "Open EduOS")));
    return;
  }
  await OQ.refresh().catch(() => {}); OQ.flush().catch(() => {});
  clearInterval(state.queueTimer); state.queueTimer = setInterval(() => { if (OQ.count && navigator.onLine) OQ.flush().catch(() => {}); }, 30000);
  await checkSafety({ rerender: false });
  state.safetySig = liveIncidents().map(i => `${i.id}:${i.status}`).join("|");
  renderTop();
  clearInterval(state.safetyTimer);
  state.safetyTimer = setInterval(() => { if (document.visibilityState === "visible") checkSafety(); }, 15000);
  const want = location.hash.replace(/^#\//, "");
  // Back from a processor's checkout page: remember the payment, tidy the URL.
  const qs = new URLSearchParams(location.search), ret = qs.get("commerce_return");
  if (ret && /^[0-9a-f-]{36}$/i.test(ret)) state.cmReturn = { id: ret, cancelled: qs.get("commerce_cancel") === "1" };
  if (ret) history.replaceState(history.state, "", location.pathname + location.hash);
  if (liveIncidents().length) return go("safety", { push: false }); // opening the app during an alert always shows it first
  go(tabsFor().some(t => t[0] === want) || ["me", "more", "sos", "safety", "pickup", ...SUBVIEWS].includes(want) ? want : tabsFor()[0][0], { push: false });
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkSafety(); });
window.addEventListener("popstate", () => { const t = location.hash.replace(/^#\//, ""); if (state.me && t) go(t, { push: false }); });
window.addEventListener("hashchange", () => { if (takeScanLink() && state.me) return go("scan", { push: false }); const t = location.hash.replace(/^#\//, ""); if (state.me && t && t !== state.tab) go(t, { push: false }); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {});
boot();
