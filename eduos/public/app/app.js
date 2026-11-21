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
const first = (name) => String(name || "").split(/\s+/)[0];
const STATUS_TEXT = { boarded: "On board", alighted: "Dropped off", not_riding: "Not riding", expected: "Expected", not_started: "Run not started", present: "Present", absent: "Absent", tardy: "Tardy" };
const chip = (status, text) => h("span", { class: `chip ${status}` }, text || STATUS_TEXT[status] || status);

// ---------------- colour: keep school colours readable on dark ----------------
const hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c || "")); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null; };
const toHex = rgb => "#" + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const lum = rgb => { const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const SURFACE = hex("#141a29"), WHITE = [255, 255, 255], INK = hex("#0b0f19");
function readableOn(bg, color) { let c = color; for (let t = 0; t <= 1.0001 && contrast(c, bg) < 4.5; t += 0.05) c = mix(color, WHITE, t); return c; }
const onFill = rgb => (contrast(rgb, WHITE) >= 4.5 ? "#ffffff" : "#0b0f19");
function applyBranding(b) {
  const root = document.documentElement.style;
  const primary = hex(b?.branding?.primary) || hex("#2f6fbf");
  const accent = hex(b?.branding?.accent) || hex("#f6c445");
  root.setProperty("--school", toHex(primary)); root.setProperty("--on-school", onFill(primary));
  // An accent that is too dark for the dark theme is lightened until AA holds.
  const acc = readableOn(SURFACE, accent);
  root.setProperty("--accent", toHex(acc)); root.setProperty("--on-accent", contrast(acc, INK) >= 4.5 ? "#0b0f19" : "#ffffff");
  root.setProperty("--ink", toHex(readableOn(SURFACE, primary)));
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
  pupil: [["home", "Home", "home"], ["portfolio", "My history", "book"], ["library", "My library", "book"], ["courses", "Courses", "book"], ["christie", "Christie", "spark"], ["path", "My path", "path"], ["activities", "Clubs & Sports", "trophy"], ["news", "News", "news"]],
  teacher: [["classes", "Classes", "grid"], ["staffing", "Staffing", "people"], ["courses", "Courses", "book"], ["contributions", "History items", "book"], ["grading", "Grading", "check"], ["copilot", "Christie", "spark"], ["activities", "Clubs & Sports", "trophy"], ["messages", "Messages", "chat"]],
  parent: [["children", "Children", "child"], ["library", "Library books", "book"], ["arrival", "Arrival", "bus"], ["pickup", "Pick-up", "car"], ["activities", "Clubs & Sports", "trophy"], ["messages", "Messages", "chat"], ["alerts", "Alerts", "bell"]],
  librarian: [["library", "Library desk", "book"], ["messages", "Messages", "chat"]],
  vice_principal: [["operations", "Operations", "grid"], ["history", "Student history", "book"], ["staffing", "Staffing", "people"], ["attendance", "Attendance", "check"], ["safety", "Safety", "shield"], ["messages", "Messages", "chat"]],
  counselor: [["guidance", "Counseling", "heart"], ["staffing", "Staffing", "people"], ["messages", "Messages", "chat"]],
  nurse: [["healthoffice", "Health office", "heart-pulse"], ["staffing", "Staffing", "people"], ["messages", "Messages", "chat"]],
  maintenance: [["facilities", "Facilities", "wrench"], ["staffing", "Staffing", "people"], ["messages", "Messages", "chat"]],
  lunch_staff: [["meals", "Meal service", "utensils"], ["staffing", "Staffing", "people"], ["messages", "Messages", "chat"]],
  principal: [["overview", "School", "grid"], ["history", "Student history", "book"], ["staffing", "Staffing", "people"], ["library", "Library", "book"], ["pickup", "Pick-up", "car"], ["transport", "Transport", "bus"], ["activities", "Clubs & Sports", "trophy"], ["messages", "Messages", "chat"], ["alerts", "Alerts", "bell"]],
  superintendent: [["overview", "District", "grid"], ["history", "Student history", "book"], ["staffing", "Staffing", "people"], ["library", "Library", "book"], ["alerts", "Alerts", "bell"], ["transport", "Transport", "bus"], ["nodes", "Nodes", "server"], ["integrations", "Data links", "link"]],
  driver: [["route", "Route", "bus"], ["messages", "Messages", "chat"], ["alerts", "Alerts", "bell"]],
  sro: [["safety", "Safety", "shield"], ["alerts", "Alerts", "bell"]],
  it_admin: [["nodes", "Nodes", "server"], ["integrations", "Data links", "link"], ["library", "Library", "book"]]
};
const APP_NAME = { pupil: "Student", teacher: "Teacher", parent: "Family", principal: "School leader", superintendent: "District leader", driver: "Driver", sro: "School Resource Officer", librarian: "Librarian", vice_principal: "Vice Principal", counselor: "Guidance Counselor", nurse: "School Nurse", maintenance: "Maintenance", lunch_staff: "Lunch Staff", it_admin: "District IT" };
const state = { me: null, brand: null, tab: null, unread: 0, home: null, safety: [], safetySig: "" };
const STAFF_ROLES = ["teacher", "principal", "vice_principal", "superintendent"];

function renderTop() {
  const b = state.brand, me = state.me;
  const mascotSrc = b?.mascot ? (b.mascot["96"] || Object.values(b.mascot)[0]) : null;
  const top = document.getElementById("top");
  top.replaceChildren(
    mascotSrc ? h("img", { class: "mascot", src: mascotSrc, alt: `${b.branding?.mascotName || "School"} mascot` }) : h("span", { class: "mascot", "aria-hidden": "true" }),
    h("div", { class: "who" },
      h("p", { class: "school" }, `${b?.school?.name || b?.districtName || "EduOS"} · ${APP_NAME[me.role] || me.role}`),
      h("h1", {}, `Hi, ${first(me.displayName)}`)),
    h("button", { class: "iconbtn", type: "button", "aria-label": state.unread ? `Alerts, ${state.unread} unread` : "Alerts", onclick: () => go(tabsFor().some(t => t[0] === "alerts") ? "alerts" : "me") },
      icon("bell"), state.unread ? h("span", { class: "dot", "aria-hidden": "true" }, String(Math.min(state.unread, 99))) : null),
    STAFF_ROLES.includes(me.role) ? h("button", { class: "iconbtn sos", type: "button", "aria-label": "Safety: start or view an emergency alert", onclick: () => go(liveIncidents().length ? "safety" : "sos") }, icon("shield")) : null,
    h("button", { class: "iconbtn", type: "button", "aria-label": "Account", onclick: () => go("me") }, icon("me")));
  for (const n of [...top.childNodes]) if (n.nodeType === Node.TEXT_NODE) n.remove(); // replaceChildren() turns a null slot into "null"
}
const tabsFor = () => ROLE_TABS[state.me?.role] || [];
function renderTabs() {
  const nav = document.getElementById("tabs");
  const cur = parentTab(state.tab);
  nav.replaceChildren(...tabsFor().map(([id, label, ic]) => h("a", { href: `#/${id}`, "aria-current": cur === id ? "page" : false }, icon(ic), h("span", {}, label))));
}

const VIEWS = {};
// 32.6.0: screens opened from a tab keep that tab highlighted.
const SUBVIEWS = ["staffing", "course", "lesson", "quiz", "attempt", "mastery", "gradebook", "progress", "proof", "review", "rubric", "approvals", "edal", "roster", "node", "history", "portfolio"];
function parentTab(tab) {
  if (!SUBVIEWS.includes(tab) || tabsFor().some(t => t[0] === tab)) return tab;
  if (["review", "rubric"].includes(tab)) return "grading";
  if (tab === "history") return "history";
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
  clearInterval(state.quizTimer);
  state.tab = tab;
  if (push && location.hash !== `#/${tab}`) history.pushState(null, "", `#/${tab}`);
  renderTabs();
  const main = $main();
  main.replaceChildren(h("p", { class: "empty" }, "Loading…"));
  try {
    const view = VIEWS[tab] || VIEWS[tabsFor()[0]?.[0]] || VIEWS.me;
    const node = await view();
    main.replaceChildren(...[node].flat(Infinity).filter(Boolean));
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

async function activitiesLiveView() {
  const role = state.me.role, family = ["parent", "pupil"].includes(role);
  const staff = ["teacher", "principal", "vice_principal", "superintendent", "it_admin"].includes(role);
  const [acts, events, roles, slips, commerce] = await Promise.all([
    safe(api.get("/api/activities"), { data: [] }), safe(api.get("/api/events"), { data: [] }),
    staff ? safe(api.get("/api/sports/my-roles"), { data: {} }) : null, family ? safe(api.get("/api/my/permission-slips"), { data: [] }) : null,
    safe(api.get("/api/commerce/status"))]);
  const activities = actList(acts?.data), upcoming = actList(events?.data).filter(e => new Date(e.ends_at || e.starts_at) >= new Date()).slice(0, 10);
  const my = roles?.data && !Array.isArray(roles.data) ? roles.data : {};
  const coachOf = new Set(actList(my.coachOf));
  const canSeeEligibility = a => a.kind === "sport" && (coachOf.has(a.id) || my.athleticDirector);
  const canRunSlips = a => role === "principal" || role === "superintendent" || coachOf.has(a.id) || (my.athleticDirector && a.kind === "sport");
  const detail = h("div", { class: "stack", id: "activity-detail" });
  const open = (a, what) => detail.replaceChildren(what === "eligibility" ? eligibilityPanel(a) : staffSlipsPanel(a));
  const card = a => h("article", { class: "card", "aria-label": a.title },
    h("div", { class: "row" }, h("span", { class: "grow" }, h("span", { class: "small muted" }, a.kind === "sport" ? "SPORT" : "CLUB"), h("h3", {}, a.title)), h("span", { "aria-hidden": "true" }, a.kind === "sport" ? "🏅" : "🎨")),
    a.description ? h("p", { class: "muted small" }, a.description) : null,
    a.meetingDetails ? h("p", {}, "📅 ", a.meetingDetails) : null,
    h("p", { class: "small muted" }, `${a.memberCount ?? 0} members${a.status !== "published" ? ` · ${a.status}` : ""}`),
    role === "pupil" && a.status === "published" ? h("button", { class: "btn block", type: "button", onclick: async () => { try { await api.post(`/api/activities/${a.id}/join`); toast("You've joined. Staff confirm the roster."); } catch (e) { actErr(e, "Could not join."); } } }, "Join") : null,
    canSeeEligibility(a) ? h("button", { class: "btn block", type: "button", onclick: () => open(a, "eligibility") }, "Eligibility") : null,
    staff && canRunSlips(a) ? h("button", { class: "btn block", type: "button", onclick: () => open(a, "slips") }, "Permission slips") : null);
  const adCard = role === "principal" && state.me.schoolId ? await athleticDirectorsCard(state.me.schoolId) : null;
  return [
    h("div", { class: "row" }, h("div", { class: "grow" }, h("h2", {}, "Clubs & Sports"), h("p", { class: "muted small" }, "Clubs, teams and school events."))),
    my.athleticDirector ? h("p", { class: "notice" }, "You're this school's athletic director.") : null,
    family ? familySlipsCard(actList(slips?.data), role === "parent") : null,
    activities.length ? h("div", { class: "grid" }, activities.map(card)) : h("section", { class: "card" }, h("p", { class: "muted" }, "No clubs or teams are published yet.")),
    detail,
    h("section", { class: "card" }, h("h3", {}, "Upcoming events"),
      upcoming.length ? h("ul", { class: "list" }, upcoming.map(e => h("li", { class: "row" }, h("span", { class: "grow" }, h("b", {}, e.title), h("p", { class: "small muted" }, `${new Date(e.starts_at).toLocaleString()}${e.venue ? ` · ${e.venue}` : ""}`))))) : h("p", { class: "muted" }, "No upcoming events."),
      h("p", { class: "notice" }, commerce?.data?.enabled ? `${commerce.data.note || "Paid tickets are on."} Live video is not enabled.`
        : "Paid tickets and live video are not enabled. No payment is collected here."),
      family ? h("button", { class: "btn block", type: "button", onclick: () => go("tickets") }, "Tickets & receipts") : null,
      ["principal", "superintendent"].includes(role) ? h("button", { class: "btn block", type: "button", onclick: () => go("commerce") }, "Ticketing & revenue") : null),
    adCard
  ];
}
VIEWS.activities = activitiesLiveView;

// ---------------- teacher ----------------
VIEWS.classes = async () => {
  const [home, copilot, bus, news] = await Promise.all([safe(api.get("/api/home")), safe(api.get("/api/christie/copilot")), safe(api.get("/api/transport/today")), safe(api.get("/api/comms/announcements"))]);
  const d = home?.data || {};
  const riders = bus?.data?.riders || [];
  return [
    h("section", { class: "card hero", "aria-label": "Today" }, h("p", { class: "muted small" }, d.school_name || ""), h("h2", {}, "Today in class"),
      h("p", { class: "muted" }, copilot?.data?.suggestions?.[0] || "")),
    h("div", { class: "stats" }, stat(d.students, "learners"), stat(d.to_grade, "to grade", true), stat(d.open_assignments, "open assignments"), stat(d.absences_7d, "absences (7 days)", true)),
    h("section", { class: "card", "aria-label": "Bus riders" }, h("h2", {}, "Bus riders on my roster"),
      riders.length ? h("ul", { class: "list" }, riders.map(k => h("li", { class: "row" }, h("span", { class: "grow" }, `${k.display_name} · ${k.bus_label} ${k.direction.toUpperCase()}`), chip(k.status)))) : empty("None of your learners ride today.")),
    h("button", { class: "btn block", type: "button", onclick: () => go("pickup") }, icon("car"), "Pick-up duty: check passes"),
    h("section", { class: "card", "aria-label": "Class announcement" }, h("h2", {}, "Post to my class"), announceForm("class")),
    h("section", { class: "card", "aria-label": "Announcements" }, h("h2", {}, "Announcements"), announcementsCard(news?.data, { limit: 5 }))
  ];
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
      item.body ? h("p", {}, item.body) : null, decisionList(item.decisions), editor);
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
    h("p", { class: "small muted" }, `${fmtDay(item.occurredAt)} · ${PORTFOLIO_KIND[item.kind] || item.kind}${item.authorName ? ` · ${item.authorName}` : ""}`),
    item.body ? h("p", {}, item.body) : null);
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
    cursor ? more : null];
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
      h("label", {}, h("span", {}, "Review note (optional)"), note),
      h("div", { class: "btns" },
        h("button", { class: "btn primary", type: "button", onclick: () => decide("approve") }, "Approve"),
        h("button", { class: "btn danger", type: "button", onclick: () => decide("reject") }, "Reject")));
  }) : [h("p", { class: "small muted" }, "No family memories are waiting for review.")];
  const teacher = await teacherReviewSection();
  return [h("div", { class: "row" }, h("h2", { class: "grow" }, "Student history review"),
    h("button", { class: "btn", type: "button", onclick: () => go("history", { push: false }) }, "Refresh")),
    h("p", { class: "small muted" }, "Family memories and teacher items wait here before they reach a student's history."),
    ...(response ? [h("h3", {}, "Family memories"), ...content] : []),
    ...(teacher || [])];
};
VIEWS.children = async () => {
  const [home, bus] = await Promise.all([api.get("/api/home"), safe(api.get("/api/transport/today"))]);
  const kids = home.data.children || [];
  if (!kids.length) return empty("No children are linked to your account yet.");
  const out = [];
  for (const k of kids) {
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
  const riders = (await api.get("/api/transport/today")).data.riders || [];
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
    h("h2", {}, t.subject), h("p", { class: "small muted" }, `${t.kind === "family" ? `About ${t.student_name} · ` : "Staff · "}with ${others.map(p => p.name).join(", ")}`),
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
const KIND_HELP = { lockdown: "Threat inside or near the building", shelter: "Weather or hazardous air", evacuate: "Leave the building", hold: "Keep halls clear" };
function sosBanner(i) {
  const status = i.status === "reunification" ? "REUNIFICATION" : KIND_TEXT[i.kind];
  return h("section", { class: `sos-banner ${i.status === "reunification" ? "reunify" : i.kind}`, "aria-labelledby": `sos-${i.id}` },
    i.isDrill ? h("p", { class: "drill" }, "DRILL · THIS IS A DRILL") : h("p", { class: "drill real" }, "THIS IS NOT A DRILL"),
    h("div", { class: "row" }, icon("shield"), h("div", { class: "grow" }, h("h2", { id: `sos-${i.id}` }, status), h("p", { class: "small" }, `${i.schoolName} · since ${fmtTime(i.startedAt)}`))),
    h("p", { class: "sos-msg" }, i.message),
    i.instructions ? h("p", { class: "sos-note" }, h("strong", {}, "From the school: "), i.instructions) : null,
    i.status === "reunification" && i.reunificationPoint ? h("p", { class: "sos-note" }, h("strong", {}, "Reunification point: "), i.reunificationPoint) : null);
}
VIEWS.safety = async () => {
  const list = liveIncidents();
  if (!list.length) return [h("h2", {}, "Safety"), empty("No emergency is active. The school will alert you here if one starts.")];
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
      out.push(await rollCallCard(i));
      if (i.status === "reunification") out.push(h("button", { class: "btn school block", type: "button", onclick: () => go("pickup") }, icon("car"), "Pick-up line: release to approved adults"));
    } else if (role === "principal" || role === "superintendent") {
      out.push(await boardCards(i));
      out.push(await sroCoordinationCard(i));
    } else if (role === "sro") {
      out.push(await sroIncidentCard(i));
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
  const out = [h("h2", {}, "Safety")];
  if (caps.canInitiate) {
    let kind = state.sosKind || "lockdown", drill = state.sosDrill ?? true;
    const notes = h("textarea", { id: "sos-notes", maxlength: 500 });
    const schools = state.me.role === "superintendent" ? ((await safe(api.get("/api/schools")))?.data || []).filter(x => x.status !== "inactive") : [];
    const school = schools.length ? h("select", { id: "sos-school" }, schools.map(x => h("option", { value: x.id }, x.name))) : null;
    out.push(h("section", { class: "card", "aria-label": "Start an alert" }, h("h2", {}, "Start an alert"),
      h("div", { class: "kinds", role: "group", "aria-label": "Type of alert" }, Object.keys(KIND_TEXT).map(k => h("button", { type: "button", class: `kind ${k}`, "aria-pressed": String(k === kind), onclick: () => { state.sosKind = k; go("sos", { push: false }); } },
        h("strong", {}, KIND_TEXT[k]), h("span", {}, KIND_HELP[k])))),
      seg([["drill", "Drill"], ["real", "Real emergency"]], drill ? "drill" : "real", v => { state.sosDrill = v === "drill"; go("sos", { push: false }); }),
      school ? [h("label", { for: "sos-school" }, "School"), school] : null,
      h("label", { for: "sos-notes" }, "Short note for staff (optional, not sent to families)"), notes,
      h("button", { class: "btn danger block big", type: "button", onclick: async () => {
        try {
          const started = (await api.post("/api/safety/incidents", { kind, isDrill: drill, ...(notes.value.trim() ? { instructions: notes.value.trim() } : {}), ...(school ? { schoolId: school.value } : {}) })).data;
          const yes = await ask({ title: `Start ${drill ? "a DRILL" : "a REAL"} ${KIND_TEXT[kind]}?`, text: `Everyone at ${started.schoolName}, its bus drivers and families are alerted now${drill ? ", marked as a drill" : ""}. Confirm within 2 minutes.`, confirm: `Yes, start ${drill ? "drill" : KIND_TEXT[kind].toLowerCase()}`, danger: true });
          if (!yes) { await safe(api.post(`/api/safety/incidents/${started.id}/cancel`)); toast("Not started"); return; }
          await api.post(`/api/safety/incidents/${started.id}/confirm`, { kind, isDrill: drill });
          state.sosKind = null; state.sosDrill = null;
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
  for (const k of kids) {
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

VIEWS.course = async () => {
  if (!state.courseId) return VIEWS.courses();
  const c = (await api.get(`/api/learning/courses/${state.courseId}${learnerQuery()}`)).data;
  const out = [back(state.me.role === "parent" ? "progress" : "courses", state.me.role === "parent" ? "Grades & progress" : "Courses"),
    h("section", { class: "card hero", "aria-label": c.title }, h("p", { class: "small muted" }, `${c.subject} · Grade ${c.gradeLevel} · ${c.term} · ${c.teacher}`), h("h2", {}, c.title),
      c.learner ? h("p", { class: "muted" }, `Grade so far: ${gradeText(c.grade)} · ${c.mastery.mastered} of ${c.mastery.total} standards mastered`) : null)];
  if (c.learner) out.push(h("section", { class: "card", "aria-label": "Standards" }, h("h2", {}, "Standards"),
    h("ul", { class: "list" }, c.standards.map(s => h("li", {}, h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, s.code), h("p", { class: "small muted" }, s.description)),
      levelChip(s.level, s.mastery != null ? ` ${s.mastery}%` : "")),
      s.mastery != null ? h("button", { class: "btn", type: "button", "aria-label": `How is this calculated? (${s.code})`, onclick: () => openView("mastery", { masteryStd: s.id }) }, "How is this calculated?") : null)))));
  for (const u of c.units) out.push(h("section", { class: "card", "aria-label": `Unit ${u.seq}: ${u.title}` }, h("h2", {}, `Unit ${u.seq}: ${u.title}`), u.summary ? h("p", { class: "small muted" }, u.summary) : null,
    h("ul", { class: "list" }, u.lessons.map(l => h("li", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, l.title), h("p", { class: "small muted" }, `${l.standards.join(", ")}${l.sources ? ` · ${l.sources} primary source${l.sources > 1 ? "s" : ""}` : ""}`)),
      c.canManage ? chip(l.approved ? "present" : "expected", l.approved ? "Approved" : "Needs approval") : null,
      h("button", { class: "btn", type: "button", "aria-label": `Open lesson: ${l.title}`, onclick: () => openView("lesson", { lessonId: l.id }) }, "Open"))))));
  out.push(h("section", { class: "card", "aria-label": "Assignments and quizzes" }, h("h2", {}, "Assignments & quizzes"),
    c.assignments.length ? h("ul", { class: "list" }, c.assignments.map(a => h("li", {}, h("div", { class: "row" }, h("div", { class: "grow" }, h("h3", {}, a.title),
      h("p", { class: "small muted" }, `${kindText[a.kind]} · ${a.points} pts${a.due_at ? ` · due ${fmtDay(a.due_at)}` : ""}${a.time_limit_minutes ? ` · ${a.time_limit_minutes} min` : ""}`)),
      a.mine ? chip(a.mine.missing ? "absent" : a.mine.status === "graded" ? "present" : "not_started", a.mine.missing ? "Missing" : a.mine.status === "graded" ? `${a.mine.earned}/${a.points}` : statusText[a.mine.status]) : null),
      a.kind === "quiz" || state.me.role !== "teacher" ? h("button", { class: `btn${a.kind === "quiz" && state.me.role === "pupil" ? " primary" : ""}`, type: "button", "aria-label": `${a.kind === "quiz" ? "Open quiz" : "Details"}: ${a.title}`, onclick: () => openView("quiz", { assignmentId: a.id }) }, a.kind === "quiz" ? "Open quiz" : "Details") : null))) : empty("Nothing assigned yet.")));
  if (c.canManage && state.me.role !== "superintendent") {
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
      l.canManage ? h("p", { class: "small muted" }, l.approved ? "Approved: Christie may use this lesson's text for hints." : "Waiting for a school leader to approve it for Christie.") : null),
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
          c.edal_entry_id ? h("button", { class: "btn small-btn", type: "button", "aria-label": `Check record: ${c.title}`, onclick: () => openView("proof", { edalEntry: c.edal_entry_id }) }, "Check record") : null))) : empty("None yet.")),
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
const CONNECTOR_KIND = { oneroster: "OneRoster 1.2", edfi: "Ed-Fi API", powerschool: "PowerSchool SIS" };
const CONNECTOR_STATUS = { pending_approval: ["expected", "Needs approval"], active: ["present", "Active"], disabled: ["not_started", "Off"] };
const REJECT_TEXT = { duplicate_student_number: "same student number twice", enrolled_at_another_eduos_school: "already at another school in EduOS",
  no_school: "no school", missing_name: "no name", missing_sourcedId: "no id", missing_studentUniqueId: "no id", invalid_school_id: "invalid school id", missing_student_id: "no student id", missing_student_number: "no student number", missing_enrollment_status: "enrollment status unavailable" };
VIEWS.integrations = async () => {
  const r = await api.get("/api/integrations/connectors");
  const { enabled, connectors = [], schools = [] } = r.data;
  const reload = () => go(state.tab, { push: false });
  const out = [h("h2", {}, "Data links"),
    h("p", { class: "muted" }, "Bring student rosters in from your SIS or state system (OneRoster 1.2, Ed-Fi or PowerSchool). EduOS only reads from them, never sends student data out, and keeps working without them."),
    staffDistrict() ? h("section", { class: "card", "aria-label": "Payment options" }, h("h2", {}, "Payment options"),
      h("p", { class: "small muted" }, "Connect the district's PayPal, Square or BTCPay Server account for ticket and marketplace payments."),
      h("button", { class: "btn", type: "button", onclick: () => go("payments") }, "Open payment setup")) : null];
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
      h("p", { class: "notice" }, res.mode === "apply"
        ? `Imported ${Object.values(k.imported || {}).reduce((a, b) => a + b, 0)} students.`
        : `Preview: ${k.toImport} students would be added or updated. Nothing has changed yet.`),
      h("ul", { class: "list" }, kv("Students found", String(k.studentsFetched)), kv("At schools not linked yet", String(k.notMapped)),
        Object.entries(reasons).map(([r, n]) => kv(`Skipped: ${REJECT_TEXT[r] || r}`, String(n)))),
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
          c.lastSyncAt ? `last ${c.lastSyncStatus} ${ago(c.lastSyncAt)}` : "never synced"].filter(Boolean).join(" · "))), chip(cls, txt)),
      h("div", { class: "row wrap" },
        c.status !== "active" && c.canApprove ? h("button", { class: "btn small primary", type: "button", onclick: () => act("approve", "Approved", "Couldn't approve.") }, "Approve") : null,
        c.status !== "active" && !c.canApprove ? h("span", { class: "muted small" }, "Waiting for another district lead to approve.") : null,
        c.status === "active" ? [h("button", { class: "btn small", type: "button", onclick: () => sync("preview") }, "Preview"),
          h("button", { class: "btn small primary", type: "button", onclick: () => sync("apply") }, "Import")] : null,
        h("button", { class: "btn small", type: "button", onclick: async () => {
          const secret = await ask({ title: `New client secret for ${c.name}`, text: "It's stored encrypted. The connector then needs approval again.", label: "Client secret", confirm: "Save", maxlength: 2000 });
          if (secret) try { await api.req("PATCH", `/api/integrations/connectors/${c.id}`, { clientSecret: secret }); toast("Saved. It needs approval again."); reload(); } catch { toast("Couldn't save."); } } }, "Change secret"),
        c.status !== "disabled" ? h("button", { class: "btn small", type: "button", onclick: () => act("disable", "Turned off", "Couldn't turn it off.") }, "Turn off") : null),
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
  const hint = h("p", { class: "muted small" });
  const setHint = () => {
    base.el.placeholder = kind.value === "edfi" ? "https://edfi.district.org/api/data" : kind.value === "powerschool" ? "https://district.powerschool.com" : "https://sis.district.org/ims/oneroster/rostering/v1p2";
    token.el.placeholder = kind.value === "edfi" ? "https://edfi.district.org/oauth/token" : kind.value === "powerschool" ? "https://district.powerschool.com/oauth/access_token/" : "https://sis.district.org/oauth/token";
    hint.textContent = kind.value === "edfi" ? "Ed-Fi API v8: base URL ends in /api/data (ODS/API: /api/data/v3). Token URL: /connect/token on the Configuration Service, or /oauth/token on the API." : kind.value === "powerschool" ? "Use the district SIS origin and the OAuth token URL for its installed API plugin. EduOS reads district schools and each school’s students only; verify the plugin’s GET permissions and response contract with the district before enabling." : "Your SIS gives you the OneRoster base URL, token URL and a read-only client ID and secret.";
  };
  kind.addEventListener("change", setHint); setHint();
  out.push(h("section", { class: "card", "aria-label": "Add a data link" }, h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault();
      try { await api.post("/api/integrations/connectors", { kind: kind.value, name: name.el.value, baseUrl: base.el.value, tokenUrl: token.el.value, clientId: cid.el.value, clientSecret: secret.el.value });
        toast("Added. Another district lead needs to approve it."); reload(); }
      catch (e2) { toast(e2.body?.error === "invalid_connector" ? `Check the ${e2.body.field}.` : e2.body?.error === "connector_name_taken" ? "That name is taken." : "Couldn't add it."); } } },
    h("h2", {}, "Add a data link"), h("label", { for: kind.id }, "Type"), kind, hint,
    [name, base, token, cid, secret].map(x => [x.label, x.el]), h("button", { class: "btn", type: "submit" }, "Add"))));
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
    h("section", { class: "card hero" }, h("p", { class: "small muted" }, "SCHOOL OPERATIONS"), h("h2", {}, OPS_ROLE[state.me.role]?.[0] || (domain ? OPS_TEXT[domain] : "Operations")),
      h("p", { class: "muted" }, OPS_ROLE[state.me.role]?.[1] || (domain ? "Your team's work queue." : "Work queues for facilities, meal service, counseling and the health office."))),
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
    const loans = result?.data || [];
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

VIEWS.me = async () => {
  const memberships = (await safe(api.get("/api/memberships")))?.data || [];
  return [h("h2", {}, "Account"), h("section", { class: "card" }, h("h3", {}, state.me.displayName), h("p", { class: "muted" }, `${APP_NAME[state.me.role] || state.me.role} · ${state.brand?.school?.name || state.brand?.districtName || ""}`)),
    memberships.length > 1 ? h("section", { class: "card", "aria-label": "Switch role" }, h("h3", {}, "Switch role"), h("ul", { class: "list" }, memberships.map(m => h("li", { class: "row" },
      h("span", { class: "grow" }, `${APP_NAME[m.role] || m.role} · ${m.school_name || "District"}`),
      m.role === state.me.role && (m.school_id || null) === (state.me.schoolId || null) ? chip("present", "Current") : h("button", { class: "btn", type: "button", onclick: async () => { const r = await api.post("/api/session/membership", { membershipId: m.id }); api.csrf = r.csrfToken; boot(); } }, "Use"))))) : null,
    h("a", { class: "btn block", href: "/" }, "Open the full EduOS site"),
    h("button", { class: "btn danger block", type: "button", onclick: async () => { if (OQ.count && !(await ask({ title: "Sign out with unsent changes?", text: `${OQ.count} saved change${OQ.count > 1 ? "s have" : " has"} not been sent yet. Signing out deletes them from this phone.`, confirm: "Sign out and delete", danger: true }))) return;
      await safe(api.post("/auth/logout")); await OQ.clear(); api.csrf = null; renderSignIn(); } }, "Sign out"),
    h("p", { class: "notice" }, "EduOS Mobile keeps school data on the server. This phone stores only the app's design files and your school's colours and logo so it opens quickly, plus, while you're offline, up to 200 encrypted roll call, bus check-in or attendance marks for at most 24 hours. Signing out deletes them.")];
};

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
  PATHS: [/^\/api\/safety\/incidents\/[0-9a-f-]{36}\/rollcall$/, /^\/api\/transport\/runs\/[0-9a-f-]{36}\/checkins$/, /^\/api\/attendance$/],
  queueable(method, path) { return method === "POST" && this.PATHS.some(r => r.test(path)); },
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
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify({ path, body })));
    await this.tx("queue", "readwrite", s => s.put({ id: headers["idempotency-key"], at: Date.now(), queuedAt: headers["x-eduos-queued-at"], iv, data }));
    await this.refresh();
  },
  async all() { return (await this.tx("queue", "readonly", s => s.getAll())) || []; },
  async refresh() { this.count = (await this.all().catch(() => [])).length; renderNetBar(); return this.count; },
  async clear() { this.key = null; this.count = 0; if (this.db) { this.db.close(); this.db = null; } await new Promise(r => { const q = indexedDB.deleteDatabase("eduos-offline-queue"); q.onsuccess = q.onerror = q.onblocked = () => r(); }); renderNetBar(); },
  async flush() {
    if (this.flushing || !state.me) return; this.flushing = true;
    let sent = 0, dropped = 0;
    try {
      const items = (await this.all()).sort((a, b) => a.at - b.at);
      if (!items.length) return;
      const key = await this.cryptoKey();
      for (const it of items) {
        const del = () => this.tx("queue", "readwrite", s => s.delete(it.id));
        if (Date.now() - it.at > this.TTL) { await del(); dropped++; continue; }
        const { path, body } = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: it.iv }, key, it.data)));
        if (!api.csrf) api.csrf = (await api.get("/api/csrf")).csrfToken;
        let res;
        try { res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": api.csrf, "idempotency-key": it.id, "x-eduos-queued-at": it.queuedAt }, body: JSON.stringify(body) }); }
        catch { break; } // still offline
        if (res.ok) { await del(); sent++; continue; }
        if ([401, 408, 429].includes(res.status) || res.status >= 500) break; // try again later
        await del(); dropped++; // refused for good (e.g. incident closed long ago): never retried forever
      }
    } finally { this.flushing = false; await this.refresh(); }
    if (sent) toast(`Sent ${sent} saved change${sent > 1 ? "s" : ""}`);
    if (dropped) toast(`${dropped} saved change${dropped > 1 ? "s were" : " was"} too old or refused and not sent`);
  }
};
function renderNetBar() {
  let bar = document.getElementById("netbar");
  if (!bar) { bar = h("div", { id: "netbar", class: "netbar", role: "status", "aria-live": "polite" }); document.getElementById("top")?.after(bar); }
  const off = !navigator.onLine;
  bar.hidden = !off && !OQ.count;
  bar.textContent = off ? `You're offline.${OQ.count ? ` ${OQ.count} change${OQ.count > 1 ? "s" : ""} saved on this phone, waiting to send.` : " Roll call, bus check-ins and attendance are saved and sent later."}`
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
  const typeRow = (ev, t) => {
    const paid = t.priceCents > 0, max = Math.min(10, t.available);
    const qty = h("select", { "aria-label": `How many ${t.name} tickets` }, Array.from({ length: Math.max(max, 1) }, (_, i) => h("option", { value: i + 1 }, String(i + 1))));
    const blocked = t.available < 1 ? "Sold out" : paid && !parent ? "Ask a parent or guardian to buy this." : paid && !s?.enabled ? "Paid tickets are off" : null;
    return h("li", { class: "row wrap" }, h("span", { class: "grow" }, h("b", {}, t.name), " · ", paid ? money(t.priceCents, t.currency) : "Free",
      h("span", { class: "small muted" }, ` · ${t.available} left`)),
      blocked ? h("span", { class: "small muted" }, blocked) : [qty, h("button", { class: "btn primary", type: "button", onclick: () => buy(ev, t, Number(qty.value)) }, paid ? "Buy" : "Get")]);
  };
  const events = shop?.data?.events || [];
  return [back("activities", "Clubs & Sports"), h("h2", {}, "Tickets"), cmBanner(s),
    !parent ? h("p", { class: "small muted" }, "Students can get free tickets. A parent or guardian buys paid ones.") : null,
    pick,
    events.length ? events.map(ev => h("section", { class: "card", "aria-label": ev.title }, h("h3", {}, ev.title),
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
  const [st, rep, evs, mkt] = await Promise.all([api.get("/api/commerce/status"), safe(api.get("/api/commerce/report")), safe(api.get("/api/events"), { data: [] }),
    supt ? safe(api.get("/api/commerce/marketplace")) : null]);
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
      price = h("input", { id: "cm-tt-price", type: "number", min: 0, step: "0.01", value: "0" }), cap = h("input", { id: "cm-tt-cap", type: "number", min: 1, step: "1", value: "100" }),
      open = h("input", { id: "cm-tt-open", type: "checkbox", class: "check", checked: true });
    out.push(h("section", { class: "card", "aria-label": "Add tickets" }, h("h2", {}, "Add tickets to an event"),
      h("form", { class: "stack", onsubmit: async e => {
        e.preventDefault();
        try { await api.post(`/api/events/${ev2.value}/ticket-types`, { name: name.value, priceCents: Math.round(Number(price.value) * 100), capacity: Number(cap.value), salesOpen: open.checked });
          toast("Tickets added"); reload(); } catch (err) { cmErr(err, "Couldn't add tickets."); }
      } }, h("label", { for: "cm-tt-ev" }, "Event"), ev2, h("label", { for: "cm-tt-name" }, "Ticket name"), name, h("label", { for: "cm-tt-price" }, "Price ($, 0 for free)"), price,
        h("label", { for: "cm-tt-cap" }, "How many"), cap, h("label", { class: "row" }, open, h("span", {}, "On sale now")),
        h("p", { class: "small muted" }, s.enabled ? `Families pay with ${(s.methods || []).map(m => m.label).join(", ")}. Students can only get free tickets.` : "Paid tickets can't be sold until commerce is on; free tickets work now."),
        h("button", { class: "btn primary", type: "submit" }, "Add tickets"))));
  }

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
  state.brand = (await safe(api.get("/api/branding/current")))?.data || null;
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
  go(tabsFor().some(t => t[0] === want) || ["me", "sos", "safety", "pickup", ...SUBVIEWS].includes(want) ? want : tabsFor()[0][0], { push: false });
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkSafety(); });
window.addEventListener("popstate", () => { const t = location.hash.replace(/^#\//, ""); if (state.me && t) go(t, { push: false }); });
window.addEventListener("hashchange", () => { const t = location.hash.replace(/^#\//, ""); if (state.me && t && t !== state.tab) go(t, { push: false }); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {});
boot();
