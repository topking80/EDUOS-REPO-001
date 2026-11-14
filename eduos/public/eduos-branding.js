// EduOS 32.3.0: school branding in the browser.
//  * apply(): puts the selected school's PUBLISHED theme on the header, home
//    dashboards, launcher tiles, the K-2 view and the guardian portal, plus the
//    favicon and PWA manifest. Honors the per-user high-contrast override,
//    prefers-contrast, forced-colors and reduced motion.
//  * The "School branding" designer for principals (own school) and district
//    roles (any school + district default): identity, mascot upload, colors,
//    font, presets, per-tile editing, live WCAG AA checks with suggested
//    shades, previews per audience, draft/publish/restore/reset.
//  * landing(): the sign-in page shows a school's public branding when the
//    school is known (?school=<districtId>.<schoolId> or the last school used).
// Every value rendered into HTML is escaped; colors are validated hex.
(() => {
  "use strict";
  const M = window.EduOSBrandModel, C = window.EduOSContrast;
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hex = v => (typeof v === "string" && M.HEX.test(v) ? v : "#000000");
  const KEY_RE = /^[0-9a-f-]{36}\.[0-9a-f-]{36}$/i;
  const STORE_KEY = "eduos.school";
  const ROLE_TILE_LABEL = { work: { teacher: "Assignments", parent: "Schoolwork", principal: "Assignments", superintendent: "Assignments" } };
  const TILE_TAB = { work: "assignments", attendance: "attendance", apps: "apps" };
  const PREVIEWS = [["teacher", "Teacher"], ["pupil", "Student"], ["young", "Young student (K-2)"], ["parent", "Parent"]];
  const COLOR_OPTIONS = [["primary", "Primary"], ["secondary", "Secondary"], ["accent", "Accent"], ["surface", "White"], ["ink", "Dark ink"]];
  const st = { current: null, API: null, scopes: [], scope: null, view: null, work: null, dirty: false, tileKey: "", previewRole: "teacher", blocked: null };

  // ---------- styles ----------
  function hcRules(p) {
    return `${p} #eduos-api-bridge{background:#000!important;color:#fff!important}
${p} .eb-brand-chip{background:#000!important;color:#fff!important;border:1px solid #fff}
${p} .eb-live.eb-banner{background:#fff!important;color:#000!important;border:2px solid #000!important}
${p} #eduos-api-data .eb-live.api-tile,${p} #eduos-api-data .eb-live.api-big{background:#fff!important;color:#000!important;border:2px solid #000!important}
${p} .eb-live .eb-icon,${p} .eb-live .eb-disc{background:#000!important;box-shadow:none!important}
${p} .eb-live .eb-icon path{fill:#fff!important}
${p} #eduos-api-data .api-tabs button[aria-pressed=true]{background:#000!important;color:#fff!important;border-color:#000!important}`;
  }
  function injectCss() {
    if (document.getElementById("eduos-branding-css")) return;
    const s = document.createElement("style"); s.id = "eduos-branding-css";
    s.textContent = `
#eduos-api-bridge{background:var(--eb-primary,#0f2338);color:var(--eb-on-primary,#eaf1f9);font-family:var(--eb-font,system-ui,sans-serif)}
#eduos-api-data{font-family:var(--eb-font,system-ui,sans-serif)}
#eduos-api-data .api-tabs button[aria-pressed=true]{background:var(--eb-accent,#113155);color:var(--eb-on-accent,#fff);border-color:var(--eb-accent,#113155)}
.eb-brand-chip{display:inline-flex;align-items:center;gap:8px;padding:3px 10px 3px 3px;border-radius:30px;background:#ffffff1f;font-weight:800;font-size:13px}
.eb-brand-chip img{width:28px;height:28px;border-radius:50%;background:#fff;object-fit:cover}
.eb-brand-chip small{font-weight:600;opacity:1}
.eb-banner{display:flex;align-items:center;gap:14px;padding:14px 18px;border-radius:14px;margin:0 0 14px;background:var(--eb-secondary,#2f6f73);color:var(--eb-on-secondary,#fff)}
.eb-banner img{width:64px;height:64px;border-radius:16px;background:#fff;flex:0 0 auto}
.eb-banner h2{margin:0;font-size:20px;color:inherit}.eb-banner p{margin:2px 0 0;font-weight:600;color:inherit}
.eb-banner.young{justify-content:center;text-align:center;flex-direction:column}.eb-banner.young img{width:112px;height:112px;border-radius:28px}.eb-banner.young h2{font-size:28px}
.eb-icon{position:relative;display:inline-grid;place-items:center;flex:0 0 auto}
.eb-icon.eb-rounded{border-radius:24%}.eb-icon.eb-circle{border-radius:50%}.eb-icon.eb-square{border-radius:4px}
.eb-disc{display:grid;place-items:center;width:78%;height:78%;border-radius:50%}
.eb-badge{position:absolute;right:-6px;bottom:-6px;width:45%;height:45%;border-radius:50%;background:#fff;box-shadow:0 0 0 2px #fff}
#eduos-api-data .api-tile.eb-branded,#eduos-api-data .api-big.eb-branded,.eb-pv .eb-ptile{background:var(--eb-bg)!important;color:var(--eb-fg)!important;border:1px solid var(--eb-edge,transparent)!important}
#eduos-api-data .api-tile.eb-branded .api-tile-meta{color:inherit!important;font-weight:700}
#eduos-api-data .api-tile.eb-branded.eb-rounded,.eb-pv .eb-ptile.eb-rounded{border-radius:16px!important}
#eduos-api-data .api-tile.eb-branded.eb-circle,.eb-pv .eb-ptile.eb-circle{border-radius:40px!important}
#eduos-api-data .api-tile.eb-branded.eb-square,.eb-pv .eb-ptile.eb-square{border-radius:4px!important}
#eduos-api-data .api-big.eb-branded{display:inline-flex;align-items:center;gap:14px;font-size:24px;padding:18px 26px}
.eb-shortcuts{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 14px;padding:0;list-style:none}
#eduos-api-data .eb-shortcuts .api-tile{min-height:0;flex-direction:row;align-items:center;gap:10px;padding:10px 16px;width:auto}
.eb-designer{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,1fr);gap:14px;align-items:start}
.eb-designer fieldset{border:1px solid #c7d4e2;border-radius:12px;padding:10px 14px 14px;margin:0 0 12px;background:#fff}
.eb-designer legend{font-weight:800;padding:0 6px}
.eb-designer label{display:block;font-weight:700;margin:8px 0 3px;font-size:12px}
.eb-designer input[type=text],.eb-designer select{width:100%;max-width:340px;padding:7px 9px;border:1px solid #8a9bb0;border-radius:7px;font:inherit;background:#fff;color:#15263a}
.eb-color{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#eduos-api-data .eb-color input[type=color]{width:52px!important;min-width:0;height:36px;padding:2px;border:1px solid #8a9bb0;border-radius:7px;background:#fff;flex:0 0 auto}
#eduos-api-data .eb-color input[type=text]{width:110px!important;flex:0 0 auto}
#eduos-api-data .eb-color label,#eduos-api-data .eb-check{display:inline-flex!important;align-items:center;gap:6px;width:auto!important;margin:0!important;font-weight:600}
#eduos-api-data .eb-color input[type=checkbox],#eduos-api-data .eb-check input{width:auto!important;margin:0}
#eduos-api-data .api-big.eb-branded .api-tile-name{font-size:22px}
#eduos-api-contrast[aria-pressed=true]{background:#fff!important;color:#000!important;border-color:#fff!important;box-shadow:0 0 0 2px #000 inset}
.eb-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.eb-presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
#eduos-api-data .eb-preset{background:#fff!important;color:#15263a!important;border:2px solid #c7d4e2!important;display:flex;flex-direction:column;gap:6px;align-items:center;padding:10px!important}
#eduos-api-data .eb-preset[aria-pressed=true]{border-color:#113155!important;box-shadow:0 0 0 2px #11315533}
.eb-mini{display:flex;gap:4px}
.eb-mascot-now{display:flex;align-items:center;gap:10px;margin-top:6px}.eb-mascot-now img{width:64px;height:64px;border-radius:12px;border:1px solid #c7d4e2;background:#fff}
.eb-contrast{border-radius:12px;padding:10px 14px;background:#fff;border:1px solid #c7d4e2;margin-bottom:12px}
.eb-contrast.fail{border:2px solid #b3261e}.eb-contrast h3{margin:0 0 6px;font-size:15px}
.eb-contrast ul{margin:6px 0 0;padding-left:0;list-style:none;display:grid;gap:6px}
.eb-contrast li{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 8px;border-radius:8px;background:#f4f7fb}
.eb-contrast li.error{background:#fdecea;color:#7a1c14}.eb-contrast li.warning{background:#fff6e0;color:#5c3d00}
.eb-sw{display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:24px;border-radius:5px;border:1px solid #8a9bb0;font-weight:800;font-size:12px;padding:0 5px}
.eb-pv-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.eb-pv{border:1px solid #8a9bb0;border-radius:14px;overflow:hidden;background:#eef4fa}
.eb-pv-head{display:flex;align-items:center;gap:8px;padding:8px 12px;font-weight:800}
.eb-pv-head img{width:26px;height:26px;border-radius:50%;background:#fff}
.eb-pv-body{padding:12px}
.eb-pv .eb-banner{padding:10px 12px}.eb-pv .eb-banner img{width:44px;height:44px}.eb-pv .eb-banner h2{font-size:16px}
.eb-pv-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;list-style:none;margin:0;padding:0}
.eb-pv .eb-ptile{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:10px;min-height:78px;font-weight:800;font-size:12px}
.eb-pv.young .eb-pv-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.eb-pv.young .eb-ptile{align-items:center;justify-content:center;text-align:center;min-height:120px;font-size:17px}
.eb-history{margin:0;padding-left:18px}
.eb-landing{display:flex;align-items:center;gap:14px;padding:14px;border-radius:12px;margin-bottom:10px;background:var(--eb-primary);color:var(--eb-on-primary)}
.eb-landing img{width:72px;height:72px;border-radius:18px;background:#fff}.eb-landing h2{margin:0;font-size:20px;color:inherit}.eb-landing p{margin:0;color:inherit;font-weight:600}
#eduos-api-data .eb-banner .api-hello{margin:0}
#eduos-api-data .eb-banner h2,#eduos-api-data .eb-banner p,#eduos-api-data .eb-landing h2,#eduos-api-data .eb-landing p,#eduos-api-data .eb-pv-head span{color:inherit!important}
@media(max-width:900px){.eb-designer{grid-template-columns:1fr}}
html[data-eduos-reduce-motion] *{transition:none!important;animation:none!important;scroll-behavior:auto!important}
${hcRules('html[data-eduos-theme="high_contrast"]')}
@media (prefers-contrast: more){${hcRules("html")}}
@media (forced-colors: active){.eb-live.api-tile,.eb-live.api-big,.eb-live.eb-banner,.eb-icon{forced-color-adjust:auto;border:2px solid CanvasText!important}.eb-icon path{fill:CanvasText!important}}`;
    document.head.appendChild(s);
  }

  // ---------- shared renderers (live UI and previews use the same code) ----------
  function iconHtml(b, s, size, mascot) {
    const g = s.glyphMode === "color"
      ? `<span class="eb-disc" style="background:${hex(s.disc)}">${M.glyphSvg(s.glyph, hex(s.glyphFg), Math.round(size * 0.46))}</span>`
      : M.glyphSvg(s.glyph, hex(s.glyphFg), Math.round(size * 0.58));
    const badge = s.badge && mascot ? `<img class="eb-badge" src="${esc(mascot[48])}" alt="">` : "";
    const bg = s.glyphMode === "color" ? "transparent" : "#ffffff00";
    return `<span class="eb-icon eb-${esc(s.shape)}" aria-hidden="true" style="width:${size}px;height:${size}px;background:${bg}">${g}${badge}</span>`;
  }
  const tileVars = s => `--eb-bg:${hex(s.bg)};--eb-fg:${hex(s.label)};${s.border ? "--eb-edge:#5a6f86;" : ""}`;
  function tileFor(b, key, index, meta) { return M.tileStyle(b, key, index, meta); }
  function banner(b, ctx, { young = false, live = true, mascot, schoolName, firstName } = {}) {
    const title = young ? `Hi${firstName ? `, ${esc(firstName)}` : ""}!` : `Welcome to ${esc(schoolName || "your school")}`;
    const sub = [b.mascotName ? `Home of the ${esc(b.mascotName)}` : "", b.motto ? esc(b.motto) : ""].filter(Boolean).join(" · ");
    return `<div class="eb-banner${young ? " young" : ""}${live ? " eb-live" : ""}" style="background:${hex(b.secondary)};color:${C.autoText(b.secondary)}">
      ${mascot ? `<img src="${esc(mascot[young ? 192 : 96])}" alt="${esc(b.mascotName ? `${b.mascotName} mascot` : "School mascot")}">` : ""}
      <div><h2 class="api-hello">${title}</h2>${sub ? `<p>${sub}</p>` : ""}</div></div>`;
  }
  const builtinLabel = (key, role) => (ROLE_TILE_LABEL[key] && ROLE_TILE_LABEL[key][role]) || M.BUILTIN_TILES[key].label;

  // ---------- live UI hooks used by eduos-mesh.js ----------
  const eff = () => (st.current && st.current.branding) || M.effective();
  const mascotNow = () => st.current && st.current.mascot;
  /** Launcher tile for an app (index = position, for the "cycle" background). */
  function appTile(a, index, { young = false } = {}) {
    const b = eff(), s = tileFor(b, `app:${a.id}`, index + 3, { name: a.name, category: a.category });
    if (s.hidden) return "";
    return `<li><button type="button" class="api-tile eb-branded eb-live eb-${esc(s.shape)}" style="${tileVars(s)}" data-action="app-launch" data-id="${esc(a.id)}" data-name="${esc(a.name)}">
      <span class="sr-only">Open </span>${iconHtml(b, s, young ? 64 : 38, mascotNow())}<span class="api-tile-name">${esc(s.labelText)}</span>${young ? "" : `<span class="api-tile-meta">${esc(a.category || a.vendor || "")}</span>`}</button></li>`;
  }
  /** Shortcut tiles for built-ins that have a tab for this role. */
  function shortcuts(role, tabs, { young = false } = {}) {
    const b = eff(), have = new Set(tabs.map(t => t[0]));
    const out = Object.keys(M.BUILTIN_TILES).map((key, i) => {
      if (!have.has(TILE_TAB[key])) return "";
      const s = tileFor(b, key, i, { name: builtinLabel(key, young ? "pupil" : role) });
      if (s.hidden) return "";
      const cls = young ? "api-big" : "api-tile";
      return `<li><button type="button" class="${cls} eb-branded eb-live eb-${esc(s.shape)}" style="${tileVars(s)}" data-tab="${TILE_TAB[key]}">${iconHtml(b, s, young ? 56 : 30, mascotNow())}<span class="api-tile-name">${esc(s.labelText)}</span></button></li>`;
    }).join("");
    return out ? `<ul class="eb-shortcuts${young ? " api-big-row" : ""}" aria-label="Shortcuts">${out}</ul>` : "";
  }
  function homeBanner(ctx, { young = false, firstName } = {}) {
    if (!st.current) return "";
    return banner(eff(), ctx, { young, firstName, mascot: mascotNow(), schoolName: st.current.school?.name || st.current.districtName });
  }

  // ---------- applying the published theme ----------
  function setLink(rel, href, extra = {}) {
    let l = document.head.querySelector(`link[rel="${rel}"][data-eduos-brand]`);
    if (!l) { l = document.createElement("link"); l.rel = rel; l.dataset.eduosBrand = ""; document.head.appendChild(l); }
    l.href = href; for (const [k, v] of Object.entries(extra)) l.setAttribute(k, v);
  }
  function setVars(b) {
    const r = document.documentElement.style;
    for (const k of ["primary", "secondary", "accent"]) { r.setProperty(`--eb-${k}`, hex(b[k])); r.setProperty(`--eb-on-${k}`, C.autoText(hex(b[k]))); }
    r.setProperty("--eb-font", M.FONTS[b.font] || M.FONTS.system);
    let meta = document.head.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement("meta"); meta.name = "theme-color"; document.head.appendChild(meta); }
    meta.content = hex(b.primary);
  }
  function setIcons(key, version = "") {
    if (!key || !KEY_RE.test(key)) return;
    const [districtId, schoolId] = key.split("."), base = `/api/public/branding/${districtId}/${schoolId}`, v = version ? `?v=${encodeURIComponent(version)}` : "";
    setLink("icon", `${base}/icon-32.png${v}`, { type: "image/png", sizes: "32x32" });
    setLink("apple-touch-icon", `${base}/icon-180.png${v}`);
    setLink("manifest", `${base}/manifest.webmanifest${v}`);
  }
  function applyPrefs(p) {
    const html = document.documentElement;
    html.dataset.eduosTheme = p.theme === "high_contrast" ? "high_contrast" : "school";
    html.toggleAttribute("data-eduos-reduce-motion", Boolean(p.reduceMotion));
    const t = document.getElementById("eduos-api-contrast");
    if (t) { t.hidden = false; t.setAttribute("aria-pressed", String(p.theme === "high_contrast")); }
  }
  function apply(cur) {
    st.current = cur; injectCss();
    const b = cur.branding; setVars(b); applyPrefs(cur.preferences || {});
    const bar = document.getElementById("eduos-api-bridge");
    if (bar) {
      let chip = document.getElementById("eduos-brand-chip");
      if (!chip) { chip = document.createElement("span"); chip.id = "eduos-brand-chip"; chip.className = "eb-brand-chip"; bar.querySelector(".api-left")?.prepend(chip); }
      const name = cur.school?.name || cur.districtName || "EduOS";
      chip.innerHTML = `${cur.mascot ? `<img src="${esc(cur.mascot[48])}" alt="">` : M.glyphSvg("star", C.autoText(b.primary), 22)}<span>${esc(name)}${b.mascotName ? ` <small>· ${esc(b.mascotName)}</small>` : ""}</span>`;
    }
    const logo = document.querySelector(".brand .logo");
    if (logo && cur.mascot) { logo.innerHTML = `<img src="${esc(cur.mascot[96])}" alt="" style="width:100%;height:100%;border-radius:inherit">`; logo.style.background = "#fff"; }
    if (cur.publicKey) { setIcons(cur.publicKey, `${cur.versions?.district || 0}.${cur.versions?.school || 0}`); try { localStorage.setItem(STORE_KEY, cur.publicKey); } catch {} }
  }
  async function init(API) {
    st.API = API; injectCss();
    const bar = document.getElementById("eduos-api-bridge");
    if (bar && !document.getElementById("eduos-api-contrast")) {
      const t = document.createElement("button"); t.type = "button"; t.id = "eduos-api-contrast"; t.hidden = true; t.setAttribute("aria-pressed", "false");
      t.textContent = "High contrast"; t.title = "Switch to the high-contrast theme (saved for your account)";
      t.onclick = async () => {
        const next = t.getAttribute("aria-pressed") === "true" ? "school" : "high_contrast";
        applyPrefs({ ...(st.current?.preferences || {}), theme: next });
        try { const r = await API.request("/api/me/preferences", { method: "PUT", body: JSON.stringify({ theme: next }) }); if (st.current) st.current.preferences = r.data; }
        catch (e) { applyPrefs(st.current?.preferences || {}); }
      };
      const logout = document.getElementById("eduos-api-logout"); logout ? logout.before(t) : bar.appendChild(t);
    }
    try { apply((await API.request("/api/branding/current")).data); } catch { /* unbranded is fine */ }
  }
  /** Sign-in landing: public, published-only branding for a known school. */
  async function landing(container) {
    injectCss();
    let key = new URLSearchParams(location.search).get("school");
    if (!key) { try { key = localStorage.getItem(STORE_KEY); } catch {} }
    if (!key || !KEY_RE.test(key)) return false;
    try {
      const [districtId, schoolId] = key.split(".");
      const res = await fetch(`/api/public/branding/${districtId}/${schoolId}`, { credentials: "omit" });
      if (!res.ok) return false;
      const b = (await res.json()).data;
      setVars(b); setIcons(key, b.version);
      try { localStorage.setItem(STORE_KEY, key); } catch {}
      const card = container.querySelector(".api-welcome") || container;
      const head = document.createElement("div"); head.className = "eb-landing"; head.id = "eduos-brand-landing";
      head.innerHTML = `<img src="${esc(b.icons[192])}" alt="${esc(b.mascotName ? `${b.mascotName} mascot` : `${b.schoolName} icon`)}"><div><h2>${esc(b.schoolName)}</h2><p>${esc([b.mascotName ? `Home of the ${b.mascotName}` : "", b.motto || "", b.districtName || ""].filter(Boolean).join(" · "))}</p></div>`;
      document.getElementById("eduos-brand-landing")?.remove();
      card.prepend(head);
      return true;
    } catch { return false; }
  }

  // ---------- designer ----------
  const isSchool = () => st.scope && st.scope !== "district";
  const working = v => { const w = v.draft || v.published || {}; return { mascotName: w.mascotName ?? null, motto: w.motto ?? null, primary: w.primary ?? null, secondary: w.secondary ?? null, accent: w.accent ?? null, font: w.font ?? null, tiles: w.tiles ? JSON.parse(JSON.stringify(w.tiles)) : null, mascotUploadId: w.mascotUploadId ?? null }; };
  const effWork = () => M.effective(st.work, st.view.inherited);
  const draftBody = () => { const { mascotUploadId, ...rest } = st.work; return rest; };
  async function load(ctx) {
    const API = ctx.API;
    st.scopes = (await API.request("/api/branding/scopes")).data || [];
    if (!st.scope || !st.scopes.some(s => s.scope === st.scope)) st.scope = (st.scopes.find(s => s.scope !== "district") || st.scopes[0])?.scope || null;
    if (st.scope) await loadView(ctx);
  }
  async function loadView(ctx) {
    st.view = (await ctx.API.request(`/api/branding/${encodeURIComponent(st.scope)}`)).data;
    st.work = working(st.view); st.dirty = false; st.blocked = null;
    if (st.tileKey && !st.view.tiles.some(t => t.key === st.tileKey)) st.tileKey = "";
  }
  function colorField(k, label) {
    const w = st.work[k], e = effWork()[k], inherit = isSchool() && w === null;
    return `<label for="eb-${k}-hex">${label}</label><div class="eb-color"><input type="color" id="eb-${k}-pick" data-eb-color="${k}" value="${esc(e)}" aria-label="${label} color picker"${inherit ? " disabled" : ""}>
      <input type="text" id="eb-${k}-hex" data-eb-hex="${k}" value="${esc(e)}" inputmode="text" maxlength="7" pattern="#[0-9a-fA-F]{6}" aria-describedby="eb-${k}-note"${inherit ? " disabled" : ""}>
      ${isSchool() ? `<label class="eb-check"><input type="checkbox" data-eb-inherit="${k}"${inherit ? " checked" : ""}> Use the district color</label>` : ""}
      <span id="eb-${k}-note" class="api-muted">${inherit ? `District: ${esc(st.view.inherited[k])}` : ""}</span></div>`;
  }
  function tileEditor() {
    const tiles = st.view.tiles, key = st.tileKey, t = st.work.tiles || M.effective(st.work, st.view.inherited).tiles;
    const base = { ...M.SYSTEM_DEFAULT.tiles.base, ...(t.base || {}) }, ov = (key && t.overrides && t.overrides[key]) || {}, s = { ...base, ...ov };
    const opt = (list, v) => list.map(([val, name]) => `<option value="${esc(val)}"${String(v) === val ? " selected" : ""}>${esc(name)}</option>`).join("");
    const colorSel = (field, v, extra = []) => {
      const custom = M.HEX.test(String(v));
      return `<select data-eb-tile="${field}">${opt([...extra, ...COLOR_OPTIONS, ["custom", "Custom…"]], custom ? "custom" : v)}</select>${custom ? ` <input type="text" data-eb-tile-hex="${field}" value="${esc(v)}" maxlength="7" aria-label="Custom ${field} hex">` : ""}`;
    };
    return `<label for="eb-tile-pick">Which tiles</label><select id="eb-tile-pick" data-eb-tilepick>${opt([["", "All tiles"], ...tiles.map(x => [x.key, x.name])], key)}</select>
      <div class="api-form-grid">
      <label>Shape<select data-eb-tile="shape">${opt(M.SHAPES.map(x => [x, x[0].toUpperCase() + x.slice(1)]), s.shape)}</select></label>
      <label>Background${colorSel("bg", s.bg, key ? [] : [["cycle", "Rotate school colors"]])}</label>
      <label>Icon style<select data-eb-tile="glyphMode">${opt([["mono", "One color"], ["color", "Full color"]], s.glyphMode)}</select></label>
      <label>Icon color${colorSel("glyphColor", s.glyphColor, [["auto", "Automatic"]])}</label>
      <label>Label color${colorSel("labelColor", s.labelColor, [["auto", "Automatic (always readable)"]])}</label>
      ${key ? `<label>Icon<select data-eb-tile="glyph">${opt(M.GLYPH_NAMES.map(g => [g, g]), s.glyph || tileFor(effWork(), key, 0, tiles.find(x => x.key === key)).glyph)}</select></label>
      <label>Label<input type="text" data-eb-tile="label" maxlength="40" value="${esc(ov.label || "")}" placeholder="${esc(tiles.find(x => x.key === key)?.name || "")}"></label>
      <label class="eb-check"><input type="checkbox" data-eb-tile="hidden"${ov.hidden ? " checked" : ""}> Hide this tile</label>` : ""}
      <label class="eb-check"><input type="checkbox" data-eb-tile="badge"${s.badge ? " checked" : ""}> Mascot badge</label>
      </div>${key && Object.keys(ov).length ? `<button type="button" data-action="brand-tile-clear">Undo changes to this tile</button>` : ""}`;
  }
  function contrastPanel() {
    const b = effWork(), r = M.contrastPairs(b, st.view.tiles), sum = M.summarize(r), issues = r.filter(x => x.level !== "ok");
    const sw = (fg, bg) => `<span class="eb-sw" style="background:${hex(bg)}" aria-hidden="true">${M.glyphSvg("star", hex(fg), 16)}</span>`;
    return `<div class="eb-contrast${sum.ok ? "" : " fail"}" id="eb-contrast" role="region" aria-label="Accessibility check" aria-live="polite">
      <h3>${sum.ok ? (sum.warnings ? `Readable text · ${sum.warnings} icon warning${sum.warnings === 1 ? "" : "s"}` : "All colors pass WCAG AA") : `${sum.errors} text color${sum.errors === 1 ? "" : "s"} too hard to read. Publishing is blocked.`}</h3>
      <p class="api-muted">Checked ${r.length} color pairs. Text needs a contrast ratio of 4.5:1; icons and tile edges need 3:1.</p>
      ${issues.length ? `<ul>${group(issues).map(x => `<li class="${x.level}">${sw(x.fg, x.bg)}<span><b>${x.level === "error" ? "Fails" : "Warning"}:</b> ${esc(x.label)}${x.count > 1 ? ` and ${x.count - 1} more` : ""}: ${x.ratio}:1 (needs ${x.required}:1)</span>${fixButton(x, b)}</li>`).join("")}</ul>` : ""}
      ${st.blocked ? `<p role="alert" class="api-notice"><strong>Not published.</strong> The server found ${st.blocked} text color${st.blocked === 1 ? "" : "s"} below WCAG AA. Fix them, then publish again.</p>` : ""}</div>`;
  }
  // Identical problems on several tiles (same colors, same field) are shown once.
  function group(issues) {
    const out = new Map();
    for (const x of issues) {
      const k = x.tile ? `${x.level}|${x.fg}|${x.bg}|${x.field}|${x.kind}` : x.id;
      const g = out.get(k);
      if (g) { g.count++; g.tiles.push(x.tile); } else out.set(k, { ...x, count: 1, tiles: x.tile ? [x.tile] : [] });
    }
    return [...out.values()];
  }
  function fixButton(x, b) {
    if (x.tile && ["labelColor", "glyphColor"].includes(x.field) && x.suggestion)
      return `<button type="button" data-action="brand-fix" data-tile="${esc(x.tiles.join(","))}" data-field="${x.field}" data-value="${esc(x.suggestion)}">Use suggested shade ${esc(x.suggestion)}${x.count > 1 ? ` on all ${x.count}` : ""} ${sw2(x.suggestion, x.bg)}</button>`;
    const area = { "header:text": "primary", "banner:text": "secondary", "accent:text": "accent" }[x.id];
    if (area) { const s = C.suggest(b[area], C.autoText(b[area]), 4.5); if (s) return `<button type="button" data-action="brand-fix" data-field="${area}" data-value="${esc(s)}">Use ${esc(s)} for the ${area} color</button>`; }
    return "";
  }
  const sw2 = (fg, bg) => `<span class="eb-sw" style="background:${hex(bg)}" aria-hidden="true">${M.glyphSvg("star", hex(fg), 16)}</span>`;
  function previewHtml(kind) {
    const b = effWork(), young = kind === "young", role = young ? "pupil" : kind, mascot = st.view.mascot, tiles = st.view.tiles;
    const name = st.view.scope === "district" ? "Your school" : st.view.name;
    const shown = tiles.slice(0, young ? 4 : 6);
    const list = (shown.length > 3 ? shown : [...shown, ...M.SAMPLE_TILES.slice(3)]).map((t, i) => {
      const meta = t.key in M.BUILTIN_TILES ? { name: builtinLabel(t.key, role) } : t;
      const s = tileFor(b, t.key, i, meta); if (s.hidden) return "";
      return `<li><span class="eb-ptile eb-${esc(s.shape)}" style="${tileVars(s)}">${iconHtml(b, s, young ? 52 : 30, mascot)}<span>${esc(s.labelText)}</span></span></li>`;
    }).join("");
    return `<div class="eb-pv${young ? " young" : ""}" style="font-family:${esc(M.FONTS[b.font] || M.FONTS.system)}" aria-label="${esc(PREVIEWS.find(p => p[0] === kind)[1])} preview">
      <div class="eb-pv-head" style="background:${hex(b.primary)};color:${C.autoText(b.primary)}">${mascot ? `<img src="${esc(mascot[48])}" alt="">` : M.glyphSvg("star", C.autoText(b.primary), 20)}<span>${esc(name)}</span><span style="margin-left:auto;font-weight:600">${esc(PREVIEWS.find(p => p[0] === kind)[1])}</span></div>
      <div class="eb-pv-body">${banner(b, null, { young, live: false, mascot, schoolName: name, firstName: young ? "Maya" : "" })}
      ${kind === "parent" ? `<p style="margin:0 0 8px;font-weight:700">Maya Lopez · Grade 2 · 1 due this week</p>` : ""}
      <ul class="eb-pv-tiles">${list}</ul></div></div>`;
  }
  function previewPanel() {
    return `<div id="eb-preview"><div class="eb-pv-tabs" role="group" aria-label="Preview as">${PREVIEWS.map(([k, n]) => `<button type="button" data-action="brand-preview" data-role="${k}" aria-pressed="${st.previewRole === k}">${n}</button>`).join("")}</div>${previewHtml(st.previewRole)}</div>`;
  }
  function presetPicker() {
    const cur = (st.work.tiles && st.work.tiles.preset) || (isSchool() ? null : "minimal");
    return `<div class="eb-presets">${Object.entries(M.PRESETS).map(([k, p]) => {
      const b = M.effective({ ...st.work, tiles: M.presetTiles(k) }, st.view.inherited);
      const mini = M.SAMPLE_TILES.slice(0, 3).map((t, i) => { const s = tileFor(b, t.key, i, t); return `<span class="eb-ptile eb-${s.shape}" style="${tileVars(s)};display:inline-grid;place-items:center;width:34px;height:34px;padding:0;border-radius:${s.shape === "circle" ? "50%" : s.shape === "square" ? "3px" : "9px"};background:${hex(s.bg)};border:1px solid ${s.border ? "#5a6f86" : "transparent"}">${M.glyphSvg(s.glyph, hex(s.glyphMode === "color" ? s.disc : s.glyphFg), 18)}</span>`; }).join("");
      return `<button type="button" class="eb-preset" data-action="brand-preset" data-preset="${k}" aria-pressed="${cur === k}"><span class="eb-mini" aria-hidden="true">${mini}</span>${esc(p.name)}</button>`;
    }).join("")}</div>${st.work.tiles?.preset === "custom" ? `<p class="api-muted">Custom design (based on a preset, with your changes).</p>` : isSchool() && !st.work.tiles ? `<p class="api-muted">Using the district's tile design.</p>` : ""}`;
  }
  function render(ctx) {
    if (!st.scopes.length) return `<div class="api-card"><p class="api-empty">There are no schools to brand yet.</p></div>`;
    const v = st.view, w = st.work, cfgMax = st.current?.uploadMaxKb || 2048;
    const scopeSel = `<label for="eb-scope">Branding for</label><select id="eb-scope" data-eb-scope>${st.scopes.map(s => `<option value="${esc(s.scope)}"${s.scope === st.scope ? " selected" : ""}>${esc(s.name)}${s.publishedVersion ? ` · v${s.publishedVersion} live` : " · not published"}${s.hasDraft ? " · draft" : ""}</option>`).join("")}</select>`;
    const status = v.draft ? `Draft${v.draft.basedOnVersion ? ` (from version ${v.draft.basedOnVersion})` : ""}${st.dirty ? " · unsaved changes" : " · saved"}` : v.published ? `Version ${v.published.version} is live${st.dirty ? " · unsaved changes" : ""}` : (st.dirty ? "Unsaved changes" : "Nothing published yet; the district or EduOS default is shown");
    return `<div class="api-card"><h2 style="margin-top:0">School branding</h2>
      <p class="api-lede">Design the colors, mascot and app tiles that teachers, students and families see. Changes stay in a draft until you publish.</p>
      <div class="api-form-grid">${scopeSel}</div><p class="api-muted" id="eb-status" role="status">${esc(status)}</p></div>
      <div class="eb-designer" data-brand-designer>
      <div><div class="eb-fields">
        <fieldset><legend>Identity</legend>
          <label for="eb-mascotName">Mascot name</label><input type="text" id="eb-mascotName" data-eb-field="mascotName" maxlength="60" value="${esc(w.mascotName || "")}" placeholder="${esc(isSchool() ? (v.inherited.mascotName || "e.g. Otters") : "e.g. Otters")}">
          <label for="eb-motto">Motto (optional)</label><input type="text" id="eb-motto" data-eb-field="motto" maxlength="120" value="${esc(w.motto || "")}">
          <label for="eb-font">Font</label><select id="eb-font" data-eb-field="font">${isSchool() ? `<option value="">Use the district font</option>` : ""}${Object.entries(M.FONT_NAMES).map(([k, n]) => `<option value="${k}"${(w.font || (isSchool() ? "" : "system")) === k ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>
        </fieldset>
        <fieldset><legend>Mascot image</legend>
          <div class="eb-mascot-now">${v.mascot ? `<img src="${esc(v.mascot[96])}" alt="Current mascot">` : `<span class="api-muted">No mascot yet${isSchool() ? " (the district's is used if it has one)" : ""}.</span>`}</div>
          <label for="eb-upload">Upload a mascot (PNG, JPG, WebP or SVG, up to ${Math.round(cfgMax / 1024 * 10) / 10} MB)</label>
          <input type="file" id="eb-upload" data-eb-upload accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg">
          <p class="api-muted">Photos are re-encoded, cropped square and stripped of location and camera data. SVGs are cleaned: scripts, links, embedded content and event handlers are removed.</p>
          ${w.mascotUploadId ? `<button type="button" data-action="brand-mascot-remove">Remove mascot</button>` : ""}
        </fieldset>
        <fieldset><legend>School colors</legend>${colorField("primary", "Primary (header)")}${colorField("secondary", "Secondary (home banner)")}${colorField("accent", "Accent (highlights)")}</fieldset>
        <fieldset><legend>Tile design</legend>${presetPicker()}<div id="eb-tile-editor">${tileEditor()}</div></fieldset>
      </div>
      <div class="api-row eb-row">
        <button type="button" data-action="brand-save">Save draft</button>
        <button type="button" class="primary" data-action="brand-publish">Publish</button>
        ${v.draft ? `<button type="button" data-action="brand-discard">Discard draft</button>` : ""}
        <button type="button" data-action="brand-reset">${isSchool() ? "Reset to district default" : "Reset to EduOS default"}</button>
      </div>
      ${v.history.length ? `<fieldset style="margin-top:12px"><legend>Published versions</legend><ol class="eb-history" reversed>${v.history.map(h => `<li>Version ${h.version} · ${h.status === "published" ? "<b>live</b>" : "archived"}${h.publishedAt ? ` · ${esc(ctx.fmtDate(h.publishedAt))}` : ""}${h.publishedByName ? ` by ${esc(h.publishedByName)}` : ""} ${h.status !== "published" ? `<button type="button" data-action="brand-restore" data-version="${h.version}">Restore into draft</button>` : ""}</li>`).join("")}</ol></fieldset>` : ""}
      </div>
      <div><div id="eb-contrast-wrap">${contrastPanel()}</div>${previewPanel()}</div></div>`;
  }
  function refreshLive(full = false) {
    const root = document.querySelector("[data-brand-designer]"); if (!root) return;
    if (full) { st.ctx.render("branding"); return; }
    document.getElementById("eb-contrast-wrap").innerHTML = contrastPanel();
    document.getElementById("eb-preview").outerHTML = previewPanel();
    const s = document.getElementById("eb-status"); if (s && st.dirty && !/unsaved/.test(s.textContent)) s.textContent += " · unsaved changes";
  }
  function ensureTiles() {
    if (!st.work.tiles) st.work.tiles = JSON.parse(JSON.stringify(M.effective(st.work, st.view.inherited).tiles));
    st.work.tiles.base = st.work.tiles.base || {}; st.work.tiles.overrides = st.work.tiles.overrides || {};
    return st.work.tiles;
  }
  function setTileField(field, value) {
    const t = ensureTiles(); t.preset = "custom";
    const target = st.tileKey ? (t.overrides[st.tileKey] = t.overrides[st.tileKey] || {}) : t.base;
    if (value === "" || value === null || value === false) { if (st.tileKey) delete target[field]; else if (field === "badge") target[field] = false; else delete target[field]; }
    else target[field] = value;
    if (st.tileKey && !Object.keys(target).length) delete t.overrides[st.tileKey];
    st.dirty = true;
  }
  function onInput(e) {
    const el = e.target; if (!el.closest || !el.closest("[data-brand-designer]")) return;
    const d = el.dataset;
    if (d.ebField) { const v = el.value.trim(); st.work[d.ebField] = v === "" ? null : v; st.dirty = true; refreshLive(); return; }
    if (d.ebColor || d.ebHex) {
      const k = d.ebColor || d.ebHex, v = el.value.trim().toLowerCase();
      if (!M.HEX.test(v)) { el.setAttribute("aria-invalid", "true"); return; }
      el.removeAttribute("aria-invalid"); st.work[k] = v; st.dirty = true;
      const other = document.getElementById(d.ebColor ? `eb-${k}-hex` : `eb-${k}-pick`); if (other) other.value = v;
      refreshLive(); return;
    }
    if (e.type !== "change" && el.tagName === "SELECT") return;
    if (d.ebInherit) { st.work[d.ebInherit] = el.checked ? null : effWork()[d.ebInherit]; st.dirty = true; refreshLive(true); return; }
    if (d.ebTilepick !== undefined) { st.tileKey = el.value; document.getElementById("eb-tile-editor").innerHTML = tileEditor(); return; }
    if (d.ebTile) {
      let v = el.type === "checkbox" ? el.checked : el.value;
      if (d.ebTile === "label") v = String(v).trim().slice(0, 40).replace(/[<>]/g, "");
      if (v === "custom") v = d.ebTile === "bg" ? "#ffffff" : "#0f1d2e";
      setTileField(d.ebTile, v);
      if (e.type === "change" && el.tagName === "SELECT") document.getElementById("eb-tile-editor").innerHTML = tileEditor();
      refreshLive(); return;
    }
    if (d.ebTileHex) { const v = el.value.trim().toLowerCase(); if (!M.HEX.test(v)) { el.setAttribute("aria-invalid", "true"); return; } el.removeAttribute("aria-invalid"); setTileField(d.ebTileHex, v); refreshLive(); return; }
  }
  async function onChange(e) {
    const el = e.target; if (!el.closest || !el.closest("[data-brand-designer]") && !el.dataset.ebScope) return;
    if (el.dataset.ebScope !== undefined) {
      if (st.dirty && !confirm("Leave without saving your changes?")) { el.value = st.scope; return; }
      st.scope = el.value; await loadView(st.ctx); st.ctx.render("branding"); return;
    }
    if (el.dataset.ebUpload !== undefined && el.files && el.files[0]) { await upload(el.files[0]); return; }
    onInput(e);
  }
  async function saveDraft(ctx) {
    const r = await ctx.API.request(`/api/branding/${encodeURIComponent(st.scope)}/draft`, { method: "PUT", body: JSON.stringify(draftBody()) });
    st.view = r.data; st.work = working(st.view); st.dirty = false;
  }
  async function upload(file) {
    const ctx = st.ctx;
    try {
      if (st.dirty) await saveDraft(ctx);
      const r = await ctx.API.request(`/api/branding/${encodeURIComponent(st.scope)}/mascot`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      await loadView(ctx); ctx.render("branding");
      ctx.notify(r.data.removed?.length ? `Mascot uploaded. Removed for safety: ${r.data.removed.slice(0, 4).join(", ")}.` : "Mascot uploaded and resized.");
    } catch (e) {
      const why = { unsupported_type: "Use a PNG, JPG, WebP or SVG file.", too_small: "The image is too small; use at least 64×64 pixels.", too_many_pixels: "The image is too large; use at most 4096×4096 pixels.", too_large: "The file is too large.", undecodable: "That file couldn't be read as an image.", doctype_entity_or_cdata: "That SVG uses features that aren't allowed (DOCTYPE or entities)." }[e.payload?.reason];
      ctx.notify(why || e.message); ctx.render("branding");
    }
  }
  async function action(b, ctx) {
    const a = b.dataset.action || ""; if (!a.startsWith("brand-")) return false;
    st.ctx = ctx;
    const scope = encodeURIComponent(st.scope), go = (path, body) => ctx.API.request(path, { method: "POST", body: JSON.stringify(body || {}) });
    if (a === "brand-preview") { st.previewRole = b.dataset.role; document.getElementById("eb-preview").outerHTML = previewPanel(); document.querySelector(`#eb-preview [data-role="${b.dataset.role}"]`)?.focus(); return true; }
    if (a === "brand-preset") { const t = M.presetTiles(b.dataset.preset, st.work.tiles); st.work.tiles = t; st.dirty = true; ctx.render("branding"); return true; }
    if (a === "brand-tile-clear") { const t = ensureTiles(); delete t.overrides[st.tileKey]; t.preset = "custom"; st.dirty = true; ctx.render("branding"); return true; }
    if (a === "brand-fix") {
      if (b.dataset.tile) { const keep = st.tileKey; for (const k of b.dataset.tile.split(",")) { st.tileKey = k; setTileField(b.dataset.field, b.dataset.value); } st.tileKey = keep; }
      else { st.work[b.dataset.field] = b.dataset.value; st.dirty = true; }
      st.blocked = null; ctx.render("branding"); ctx.notify(`Changed to ${b.dataset.value}.`); document.getElementById("eb-contrast")?.focus?.(); return true;
    }
    if (a === "brand-save") { await saveDraft(ctx); ctx.render("branding"); ctx.notify("Draft saved. Only editors can see it until you publish."); return true; }
    if (a === "brand-publish") {
      try {
        if (st.dirty || !st.view.draft) await saveDraft(ctx);
        const r = await go(`/api/branding/${scope}/publish`);
        st.view = r.data.view; st.work = working(st.view); st.dirty = false; st.blocked = null;
        st.scopes = (await ctx.API.request("/api/branding/scopes")).data || st.scopes;
        if (st.scope === "district" || st.scope === st.current?.school?.id) { try { apply((await ctx.API.request("/api/branding/current")).data); } catch {} }
        ctx.render("branding"); ctx.notify(`Published version ${r.data.version}. Everyone at ${st.view.name === "District default" ? "the district" : st.view.name} now sees it.`);
      } catch (e) {
        if (e.code !== "contrast_failed") throw e;
        st.blocked = e.payload?.contrast?.summary?.errors || 1; ctx.render("branding");
        ctx.notify("Not published: some text colors don't meet WCAG AA. See the accessibility check.");
        document.getElementById("eb-contrast")?.scrollIntoView({ block: "nearest" });
      }
      return true;
    }
    if (a === "brand-discard") { if (!confirm("Discard the draft? The live version stays as it is.")) return true; await ctx.API.request(`/api/branding/${scope}/draft`, { method: "DELETE" }); await loadView(ctx); ctx.render("branding"); ctx.notify("Draft discarded."); return true; }
    if (a === "brand-reset") { if (!confirm(isSchool() ? "Start a draft that uses the district default for everything?" : "Start a draft that uses the EduOS default?")) return true; const r = await go(`/api/branding/${scope}/reset`); st.view = r.data; st.work = working(st.view); st.dirty = false; ctx.render("branding"); ctx.notify("Draft reset. Publish it to apply."); return true; }
    if (a === "brand-restore") { const r = await go(`/api/branding/${scope}/restore`, { version: Number(b.dataset.version) }); st.view = r.data; st.work = working(st.view); st.dirty = false; ctx.render("branding"); ctx.notify(`Version ${b.dataset.version} copied into the draft. Publish it to make it live.`); return true; }
    if (a === "brand-mascot-remove") { await ctx.API.request(`/api/branding/${scope}/mascot`, { method: "DELETE" }); await loadView(ctx); ctx.render("branding"); ctx.notify("Mascot removed from the draft."); return true; }
    return false;
  }
  async function loadTab(ctx) { st.ctx = ctx; await load(ctx); }
  function renderTab(ctx) { st.ctx = ctx; return render(ctx); }
  document.addEventListener("input", onInput);
  document.addEventListener("change", e => { onChange(e).catch(err => st.ctx?.notify(err.message)); });

  window.EduOSBranding = Object.freeze({ init, apply, landing, load: loadTab, render: renderTab, action, appTile, shortcuts, homeBanner, current: () => st.current, state: () => st });
})();
