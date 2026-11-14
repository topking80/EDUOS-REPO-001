(() => {
  "use strict";
  const API={csrf:null,actor:null,async request(path,options={}){
    const method=(options.method||"GET").toUpperCase(),headers=new Headers(options.headers||{});
    if(options.body&&!headers.has("Content-Type"))headers.set("Content-Type","application/json");
    if(this.csrf&&!["GET","HEAD"].includes(method))headers.set("X-CSRF-Token",this.csrf);
    let response;
    try{response=await fetch(path,{...options,headers,credentials:"same-origin"});}
    catch{throw Object.assign(new Error("EduOS can't be reached. Check your connection and try again."),{code:"network_error"});}
    const type=response.headers.get("content-type")||"",payload=type.includes("application/json")?await response.json().catch(()=>null):null;
    if(response.status===401){this.actor=null;this.csrf=null;throw new Error("Session expired. Sign in again.");}
    if(!response.ok){const code=payload?.error||(response.status===429?"rate_limited":`http_${response.status}`);throw Object.assign(new Error(friendly(code,response.status)),{code,status:response.status,payload});}
    return payload;
  },async loadSession(){this.actor=await this.request("/api/me");this.csrf=(await this.request("/api/csrf")).csrfToken;return this.actor;},
  async logout(){await this.request("/auth/logout",{method:"POST"});this.actor=null;this.csrf=null;}};
  // 32.2.0: plain-language messages for API error codes (the code stays on error.code).
  const FRIENDLY={forbidden:"You don't have permission to do that.",school_scope_denied:"That record belongs to another school.",csrf_validation_failed:"Your session needs refreshing. Reload the page and try again.",
    rate_limited:"Too many requests in a short time. Wait a minute and try again.",payload_too_large:"That upload is too large.",invalid_json:"The request couldn't be read. Reload the page and try again.",
    no_seats_available:"All licensed seats for this app are in use. Ask your school office or district to add seats.",app_not_available:"This app isn't available for your account.",license_inactive:"This app's license isn't active.",
    lti_not_configured:"This app can't open yet: the district hasn't finished setting up LTI.",district_limit_reached:"Your district has reached a limit set in District settings.",
    app_name_exists:"An app with that name is already in the catalog.",request_already_pending:"Your school already has a request waiting for this app.",cannot_manage_app:"Only the district or the school that owns this app can change it.",
    cannot_assign_app:"Only the district or the school that owns this app can give access to it.",assignment_exists:"That group already has access.",district_administrator_required:"A district administrator needs to do this.",
    administrator_required:"An administrator needs to do this.",cannot_manage_role_or_school:"You can't manage that role or school.",cannot_grant_self:"You can't add a role to your own account.",webhook_limit_reached:"Your district's webhook limit is reached (see District settings).",
    contrast_failed:"Some text colors don't meet WCAG AA, so this can't be published yet.",image_rejected:"That image can't be used.",no_draft:"There is no draft to publish.",version_not_found:"That version wasn't found.",
    internal_server_error:"Something went wrong on our side. Try again; if it keeps happening, contact your district IT team."};
  function friendly(code,status){return FRIENDLY[code]||(status>=500?FRIENDLY.internal_server_error:String(code).replace(/_/g," ").replace(/^./,c=>c.toUpperCase())+".")}
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const el=id=>document.getElementById(id);let data={schools:[],students:[],assignments:[],attendance:[],cases:[],audit:[],accessRequests:[],errors:{}};
  let activeTab="home",loadingRecords=false,studentPage=null,studentQuery="",operationalStream=null,streamRefreshPending=false,operationalStreamState="disconnected";
  // 32.1.0: guardian invitation links (/#guardianInvite=<token>) are kept in
  // sessionStorage (never sent to the server until the signed-in parent accepts)
  // and removed from the address bar so they are not shared by accident.
  function captureInvite(){
    const m=/(?:^#|&)guardianInvite=([^&]+)/.exec(location.hash||"");
    if(m){try{sessionStorage.setItem("eduos.guardianInvite",decodeURIComponent(m[1]));}catch{}history.replaceState(null,"",location.pathname+location.search);}
  }
  function pendingInvite(){try{return sessionStorage.getItem("eduos.guardianInvite")||""}catch{return ""}}
  function mount(){
    if(el("eduos-api-bridge"))return;
    captureInvite();
    const css=document.createElement("style");css.textContent=`
#eduos-api-bridge{position:sticky;top:0;z-index:9999;background:#0f2338;color:#eaf1f9;border-bottom:1px solid #27425f;padding:10px 18px;display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 6px 18px #00000030}
#eduos-api-bridge .api-left{display:flex;align-items:center;gap:11px;flex-wrap:wrap}
#eduos-api-bridge #eduos-api-actor{color:#aec4db;font-size:12px}
#eduos-api-bridge .api-pill{display:inline-flex;align-items:center;gap:6px;border-radius:20px;padding:4px 11px;background:#24405c;color:#d4e4f5;font-size:11px;font-weight:700;letter-spacing:.02em}
#eduos-api-bridge .api-pill::before{content:"";width:7px;height:7px;border-radius:50%;background:#7e97b2}
#eduos-api-bridge .api-pill.live{background:#13513f;color:#c6ffe6}
#eduos-api-bridge .api-pill.live::before{background:#35d69b;box-shadow:0 0 0 3px #35d69b33}
#eduos-api-bridge button,#eduos-api-data button{border:1px solid #3f6185;border-radius:8px;padding:7px 12px;background:#24445f;color:#fff;font-weight:700;font-size:12px;cursor:pointer;transition:filter .15s,transform .05s}
#eduos-api-bridge button:hover,#eduos-api-data button:hover{filter:brightness(1.1)}
#eduos-api-bridge button:active,#eduos-api-data button:active{transform:translateY(1px)}
#eduos-api-bridge button:disabled{opacity:.5;cursor:not-allowed}
#eduos-api-bridge button.primary,#eduos-api-data button.primary{background:#f0a044;color:#1a2a3c;border-color:#e0923a}
#eduos-api-bridge button:focus-visible,#eduos-api-data button:focus-visible{outline:2px solid #8fc0ee;outline-offset:2px}
#eduos-api-data{display:none;padding:18px clamp(14px,4vw,28px);background:#eef4fa;border-bottom:1px solid #d3deea;color:#15263a;font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#eduos-api-data.show{display:block}
#eduos-api-data>b:first-child{display:block;font-size:15px;letter-spacing:-.01em;margin-bottom:12px;color:#12314f}
#eduos-api-data .api-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
#eduos-api-data .api-card{background:#fff;border:1px solid #e0e8f1;border-radius:12px;padding:14px 16px;min-width:0;box-shadow:0 1px 2px #1b3a5a0f}
#eduos-api-data .api-card>b{color:#17324f}
#eduos-api-data .api-grid .api-card>b:first-child{font-size:26px;font-weight:850;letter-spacing:-.03em;display:block;line-height:1.1;color:#16304d}
#eduos-api-data .api-grid .api-card>div{color:#5a6f86;font-size:12px;margin-top:3px}
#eduos-api-data h4{margin:14px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#36608c}
#eduos-api-data input,#eduos-api-data select,#eduos-api-data textarea{width:100%;padding:9px 10px;border:1px solid #c7d4e2;border-radius:8px;margin:4px 0 10px;background:#fff;color:#15263a;font:inherit}
#eduos-api-data input:focus,#eduos-api-data select:focus,#eduos-api-data textarea:focus{outline:none;border-color:#3f86c8;box-shadow:0 0 0 3px #3f86c833}
#eduos-api-data label{font-size:12px;font-weight:700;display:block;color:#2f4a67;margin-top:2px}
#eduos-api-data .api-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0 14px;border-bottom:1px solid #dbe5f0;padding-bottom:12px}
#eduos-api-data .api-tabs button{background:#fff;color:#2e4d6e;border:1px solid #ccd9e6}
#eduos-api-data .api-tabs button[aria-pressed=true]{background:#113155;color:#fff;border-color:#113155;box-shadow:0 2px 8px #11315533}
#eduos-api-data .api-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px;background:#fff;border:1px solid #e3eaf2;border-radius:10px;overflow:hidden;margin-top:6px}
#eduos-api-data .api-table th{position:sticky;top:0;background:#f3f7fb;color:#51708f;text-transform:uppercase;letter-spacing:.05em;font-size:10px;padding:10px;border-bottom:1px solid #e3eaf2;text-align:left}
#eduos-api-data .api-table td{padding:10px;border-bottom:1px solid #eef2f7;text-align:left;vertical-align:top;color:#213c58}
#eduos-api-data .api-table tbody tr:nth-child(even){background:#f8fbfe}
#eduos-api-data .api-table tbody tr:hover{background:#eef5fc}
#eduos-api-data .api-table tr:last-child td{border-bottom:0}
#eduos-api-data .api-muted{font-size:11px;color:#5f7185;margin-top:8px}
html:not([data-eduos-mode="demo"]) .eduos-demo-only{display:none}
#eduos-api-data .api-status{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;background:#e7eef6}
#eduos-api-data .api-status.draft{background:#fff4dc;color:#7a4b00}
#eduos-api-data .api-status.published{background:#e3f6ea;color:#14532d}
#eduos-api-data .api-status.closed{background:#eceff3;color:#4b5563}
#eduos-api-data fieldset{border:1px solid #d6e0ea;border-radius:8px;margin:8px 0;padding:6px 10px}
#eduos-api-data .api-check{display:inline-flex;align-items:center;gap:6px;margin-right:12px;font-weight:400;white-space:nowrap;width:auto}
#eduos-api-data .api-check input{width:auto;min-width:18px;height:18px;margin:0}
#eduos-api-data .api-grades{display:flex;flex-wrap:wrap;gap:6px 4px}
#eduos-api-data .api-table td:last-child>button,#eduos-api-data .api-table td:last-child .api-row button{white-space:nowrap}
#eduos-api-data .api-welcome p{max-width:760px}
#eduos-api-data .api-notices{display:grid;gap:8px;margin:12px 0}
#eduos-api-data .api-notices>b{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#4a5d72}
#eduos-api-data .api-notice{background:#fff8ec;border:1px solid #efd9ac;border-left:3px solid #e0a44a;border-radius:8px;padding:10px 12px;font-size:12px;color:#5a4620}
#eduos-api-data .api-notice strong{display:block;margin-bottom:2px;color:#704e16}
#eduos-api-data .api-notice.info{background:#eef5fc;border-color:#cfe0f0;border-left-color:#5a92c8;color:#2a4660}
#eduos-api-data #api-profile .api-card,#eduos-api-data #api-submissions .api-card{border-left:3px solid #3f86c8}
#eduos-api-data #api-profile ol,#eduos-api-data #api-profile ul{padding-left:18px;margin:4px 0}
#eduos-api-data hr{border:0;border-top:1px solid #e9eef4;margin:12px 0}
#eduos-api-data .api-grid .api-card{transition:box-shadow .15s,transform .15s}
#eduos-api-data .api-grid .api-card:hover{box-shadow:0 6px 18px #1b3a5a1a;transform:translateY(-1px)}
#eduos-api-data .api-table td{word-break:break-word}
#eduos-api-data .api-table td small{color:#4a5d72;font-size:11px}
#eduos-api-data #eduos-api-content{max-width:1220px}
#eduos-api-bridge #eduos-api-actor{font-variant-numeric:tabular-nums}
@media(max-width:700px){#eduos-api-data .api-table{display:block;overflow:auto}#eduos-api-bridge{padding:9px 12px}}
/* 32.2.0: role homes, launcher, catalog, responsive layout and accessibility */
#eduos-api-data h1.api-title{font-size:16px;margin:0 0 12px;color:#12314f;letter-spacing:-.01em}
#eduos-api-data h2,#eduos-api-data h3{margin:0 0 8px;color:#12314f}
#eduos-api-data h3{font-size:14px}
#eduos-api-data .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
#eduos-api-data .api-lede{margin:0 0 12px;color:#2f4a67}
#eduos-api-data .api-card+.api-card,#eduos-api-data .api-grid+.api-card,#eduos-api-data details.api-card{margin-top:12px}
#eduos-api-data .api-grid>.api-card,#eduos-api-data .api-family>.api-card{margin-top:0}
#eduos-api-data .api-stat{display:flex;flex-direction:column;gap:2px}
#eduos-api-data .api-stat.warn{border-left:3px solid #b45309}
#eduos-api-data .api-link{background:none!important;border:0!important;color:#1d4f86!important;padding:2px 0!important;text-decoration:underline;font-weight:700;align-self:flex-start}
#eduos-api-data .api-next ul{margin:0;padding-left:18px}#eduos-api-data .api-next li{margin:4px 0}
#eduos-api-data .api-empty{color:#4b5f75;font-style:italic;text-align:left}
#eduos-api-data .api-scroll{overflow-x:auto;max-width:100%}
#eduos-api-data .api-scroll:focus-visible{outline:2px solid #3f86c8;outline-offset:2px}
#eduos-api-data .api-launcher{list-style:none;margin:8px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
#eduos-api-data .api-tile{width:100%;min-height:96px;display:flex;flex-direction:column;align-items:flex-start;gap:4px;background:#fff!important;color:#15263a!important;border:1px solid #c7d4e2!important;border-radius:12px!important;padding:12px!important;text-align:left}
#eduos-api-data .api-tile:hover{border-color:#3f86c8!important;box-shadow:0 4px 14px #1b3a5a1f}
#eduos-api-data .api-tile-icon{width:34px;height:34px;border-radius:9px;background:#113155;color:#fff;display:grid;place-items:center;font-weight:800;font-size:16px}
#eduos-api-data .api-tile-name{font-size:13px;font-weight:800}
#eduos-api-data .api-tile-meta{font-size:11px;color:#4b5f75;font-weight:600}
#eduos-api-data .api-launcher.young{grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}
#eduos-api-data .api-launcher.young .api-tile{min-height:150px;align-items:center;justify-content:center;text-align:center}
#eduos-api-data .api-launcher.young .api-tile-icon{width:64px;height:64px;font-size:30px;border-radius:18px;background:#f0a044;color:#1a2a3c}
#eduos-api-data .api-launcher.young .api-tile-name{font-size:20px}
#eduos-api-data .api-young{font-size:18px}
#eduos-api-data .api-young h3{font-size:20px;margin-top:18px}
#eduos-api-data .api-hello{font-size:30px;margin:4px 0 14px}
#eduos-api-data .api-big-row{display:flex;gap:16px;flex-wrap:wrap}
#eduos-api-data .api-big{font-size:22px!important;padding:22px 28px!important;border-radius:16px!important;background:#113155!important;min-width:220px;display:inline-flex;gap:12px;align-items:center}
#eduos-api-data .api-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;background:#e7eef6;color:#22405f;font-weight:700;margin:1px 0}
#eduos-api-data .api-badge.ok{background:#dcf3e6;color:#14532d}
#eduos-api-data .api-badge.warn{background:#fdecc8;color:#6b3d00}
#eduos-api-data .api-big .api-badge{font-size:16px;background:#f0a044;color:#1a2a3c}
#eduos-api-data .api-health{list-style:none;padding:0;margin:0}#eduos-api-data .api-health li{padding:4px 0 4px 18px;position:relative}
#eduos-api-data .api-health li::before{content:"";position:absolute;left:0;top:10px;width:9px;height:9px;border-radius:50%;background:#16a34a}
#eduos-api-data .api-health li.warn::before{background:#d97706}
#eduos-api-data .api-family{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
#eduos-api-data .api-child-facts{list-style:none;padding:0;margin:8px 0;display:grid;grid-template-columns:1fr 1fr;gap:6px}
#eduos-api-data .api-child-facts li{background:#f3f7fb;border-radius:8px;padding:6px 8px;font-size:12px}
#eduos-api-data .api-child-facts li.warn{background:#fdecc8}
#eduos-api-data .api-child-facts b{font-size:18px;display:block}
#eduos-api-data .api-row{display:flex;gap:8px;flex-wrap:wrap}
#eduos-api-data .api-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 14px;margin-top:10px}
#eduos-api-data .api-form-grid .wide{grid-column:1/-1}
#eduos-api-data .api-form-grid label input,#eduos-api-data .api-form-grid label select,#eduos-api-data .api-form-grid label textarea,#eduos-api-data .api-search input,#eduos-api-data .api-inline-form input{display:block;font-weight:400}
#eduos-api-data .api-search{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin:8px 0}
#eduos-api-data .api-search label{flex:1 1 240px}
#eduos-api-data .api-search button{margin-bottom:10px}
#eduos-api-data .api-inline-form{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}
#eduos-api-data .api-inline-form label{flex:1 1 120px}
#eduos-api-data .api-inline-form button{margin-bottom:10px}
#eduos-api-data .api-manage td{background:#f6f9fc!important}
#eduos-api-data .api-manage-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
#eduos-api-data .api-grades{display:flex;flex-wrap:wrap;gap:2px 4px}
#eduos-api-data details>summary{cursor:pointer;list-style-position:inside}
#eduos-api-data button.danger{background:#9b1c1c;border-color:#7f1d1d}
#eduos-api-data .api-status.pending{background:#fff4dc;color:#6b3d00}
#eduos-api-data .api-status.approved{background:#dcf3e6;color:#14532d}
#eduos-api-data .api-status.denied,#eduos-api-data .api-status.withdrawn{background:#eceff3;color:#374151}
#eduos-api-data .api-muted{color:#4b5f75}
#eduos-api-data [aria-busy=true]{opacity:.65;transition:opacity .2s}
#eduos-api-data .api-tabs button:focus-visible{outline:3px solid #f0a044;outline-offset:2px}
@media(max-width:760px){
  #eduos-api-data .api-tabs{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:thin}
  #eduos-api-data .api-tabs button{flex:0 0 auto}
  #eduos-api-bridge{flex-wrap:wrap;gap:8px}
  #eduos-api-bridge .api-left{gap:6px}
  #eduos-api-data .api-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  #eduos-api-data .api-child-facts{grid-template-columns:1fr 1fr}
  #eduos-api-data .api-launcher.young{grid-template-columns:1fr 1fr}
  #eduos-api-data .api-big{min-width:0;width:100%}
}
@media(prefers-reduced-motion:reduce){#eduos-api-data *{transition:none!important}}`;
    document.head.appendChild(css);
    const bar=document.createElement("div");bar.id="eduos-api-bridge";bar.innerHTML=`
<div class="api-left"><b>EduOS Connected Services</b><span id="eduos-api-state" class="api-pill">Checking session…</span><span id="eduos-api-actor">Local demonstration workspace</span></div>
<div class="api-left"><button id="eduos-api-connect" class="primary">District sign-in</button><button id="eduos-api-refresh" disabled>Refresh records</button><button id="eduos-api-logout" hidden>Sign out</button><select id="eduos-api-membership" hidden aria-label="Switch role or school"></select><button id="eduos-api-toggle">Server workspace</button></div>`;
    document.body.prepend(bar);
    const panel=document.createElement("section");panel.id="eduos-api-data";panel.innerHTML=`<h1 class="api-title">EduOS workspace</h1><div id="eduos-api-content" aria-live="polite">Sign in to load authorized records.</div><div class="api-muted">Server permissions come from the authenticated account.<span class="eduos-demo-only"> The legacy persona selector below is a synthetic demo and does not grant server access.</span></div>`;
    bar.insertAdjacentElement("afterend",panel);
    el("eduos-api-connect").onclick=()=>location.assign("/auth/login");
    el("eduos-api-refresh").onclick=loadAll;
    el("eduos-api-logout").onclick=async()=>{try{await API.logout();location.reload()}catch(e){notify(e.message)}};
    el("eduos-api-toggle").onclick=()=>panel.classList.toggle("show");
    el("eduos-api-membership").onchange=async event=>{
      try{await API.request("/api/session/membership",{method:"POST",body:JSON.stringify({membershipId:event.target.value})});location.reload()}
      catch(e){notify(e.message)}};
    panel.addEventListener("click",handleAction);panel.addEventListener("submit",submitForm);
    panel.addEventListener("change",event=>{
      if(!event.target.matches("[data-arrival-run-select]"))return;
      const form=event.target.closest('form[data-form="arrival-create"]');
      const riders=form?.querySelector("[data-arrival-rider-select]");
      if(!riders)return;
      const runId=event.target.value;
      let visible=0;
      for(const option of riders.options){
        const allowed=option.value!==""&&option.dataset.routeRun===runId;
        option.hidden=!allowed;option.disabled=!allowed;
        if(allowed)visible++;
      }
      const selected=riders.selectedOptions[0];
      if(!selected||selected.disabled)riders.value="";
      riders.disabled=visible===0;
      if(visible===0)notify("No assigned riders are available for this route run.");
    });
    bootstrap();
  }
  function state(s,live=false){el("eduos-api-state").textContent=s;el("eduos-api-state").classList.toggle("live",live)}
  function notify(message){document.querySelectorAll("[data-eduos-toast]").forEach(x=>x.remove());const n=document.createElement("div");n.dataset.eduosToast="";n.setAttribute("role","status");n.textContent=message;n.style.cssText="position:fixed;right:16px;bottom:16px;z-index:10001;background:#10243a;color:white;padding:12px 16px;border-radius:8px;max-width:90vw";document.body.appendChild(n);setTimeout(()=>n.remove(),3500)}
  async function bootstrap(){try{const a=await API.loadSession();el("eduos-api-actor").textContent=`${a.displayName} · ${window.EduOSMesh.roleName(a.role)}`;el("eduos-api-actor").title=`District ${a.districtId}`;el("eduos-api-connect").hidden=true;el("eduos-api-logout").hidden=false;el("eduos-api-refresh").disabled=false;state("Authenticated",true);loadMemberships();
    // 32.3.0: the selected school's published branding (header, homes, tiles, favicon).
    if(window.EduOSBranding)await window.EduOSBranding.init(API);
    await loadAll();
    // Align the visible workspace with the server-verified account role after login.
    // Only the (demo-mode) legacy workspace has personas; outside demo mode it is
    // hidden and switching it would only flash its hand-off toast (32.1.0).
    if(document.documentElement.getAttribute("data-eduos-mode")==="demo"&&["superintendent","principal","teacher","parent","pupil"].includes(a.role)&&typeof window.setPersona==="function"){
      window.setPersona(a.role);
      const landing={superintendent:"overview",principal:"home",teacher:"home",parent:"parentportal",pupil:"learning"}[a.role];
      if(typeof window.go==="function")window.go(landing);
    }
    if(a.role==="parent"&&pendingInvite())await openTab("guardians");
    }catch(e){el("eduos-api-actor").textContent=document.documentElement.getAttribute("data-eduos-mode")==="demo"?"Local demonstration workspace":"";el("eduos-api-connect").hidden=false;el("eduos-api-logout").hidden=true;el("eduos-api-refresh").disabled=true;state(document.documentElement.getAttribute("data-eduos-mode")==="demo"?"Demo mode · not signed in":"Not signed in");el("eduos-api-content").innerHTML=`<div class="api-card api-welcome"><b>Welcome to EduOS</b><p>No authenticated server session. Sign in through your district identity provider to load server-backed records.</p><p>Everything you see after signing in comes from the district database and is limited to your role: district leadership, principals, teachers, families and students each get their own workspace.</p>${pendingInvite()?`<p class="api-notice info"><strong>Guardian invitation detected</strong>Sign in with the parent or guardian account your school created for you; the invitation is then offered for acceptance.</p>`:""}<button class="primary" type="button" data-action="sign-in">District sign-in</button></div>`;if(window.EduOSBranding)window.EduOSBranding.landing(el("eduos-api-content"));}}
  // 32.0.53: accounts may hold several roles/schools (e.g. a teacher who is also a parent).
  async function loadMemberships(){try{
    const rows=(await API.request("/api/memberships")).data||[],select=el("eduos-api-membership");
    if(rows.length<2){select.hidden=true;return}
    select.innerHTML=rows.map(m=>`<option value="${esc(m.id)}"${m.current?" selected":""}>${esc(m.role)}${m.school_name?" · "+esc(m.school_name):""}</option>`).join("");
    select.hidden=false;
  }catch{}}
  async function loadAll(){
    if(loadingRecords)return;loadingRecords=true;state("Loading records…",true);
    const role=API.actor?.role||"",tasks={};
    el("eduos-api-content").setAttribute("aria-busy","true");
    if(!["parent","pupil"].includes(role))tasks.schools="/api/schools";
    // 32.2.0: IT administrators have no student-record access; don't ask for it.
    if(role!=="it_admin"){
      tasks.students=`/api/students?limit=100${studentQuery?`&q=${encodeURIComponent(studentQuery)}`:""}`;tasks.assignments="/api/assignments";tasks.attendance="/api/attendance";
      if(role!=="pupil")tasks.cases="/api/cases";
    }
    if(["superintendent","it_admin","principal"].includes(role))tasks.audit="/api/audit?limit=250";
    if(!["parent","pupil"].includes(role))tasks.accessRequests="/api/access-requests";
    try{
      const entries=Object.entries(tasks),results=await Promise.allSettled(entries.map(([,url])=>API.request(url)));
      data.errors={};let successes=0;
      results.forEach((result,index)=>{const key=entries[index][0];if(result.status==="fulfilled"){data[key]=result.value?.data||[];if(key==="students")studentPage=result.value?.page||null;successes++;}else{data.errors[key]=result.reason?.message||"Unable to load this section.";}});
      if(successes===0&&entries.length){showError("No server records could be loaded. Check your session and connection, then retry.");return;}
      if(window.EduOSMesh.TABS.includes(activeTab))await window.EduOSMesh.load(activeTab,meshCtx());
      render(activeTab);state(Object.keys(data.errors).length?"Some records unavailable":"Server records loaded",true);
    }catch(e){showError(e.message)}finally{loadingRecords=false;el("eduos-api-content").removeAttribute("aria-busy");}
  }
  function showError(m){el("eduos-api-content").innerHTML=`<p role="alert">${esc(m)}</p><button type="button" data-action="retry-load">Retry loading records</button>`;state("API error")}
  function hasGrant(resource,action){return data.accessRequests.some(a=>a.status==="approved"&&a.resource===resource&&a.action===action&&(!a.expires_at||Date.parse(a.expires_at)>Date.now()))}
  // 32.2.0: per-role navigation (Home first), from eduos-mesh.js.
  function tabs(active){const role=API.actor?.role;const list=window.EduOSMesh.tabsFor(role,{sisGrant:hasGrant("schools","update")});
    if(["superintendent","principal","teacher","driver"].includes(role))list.push(["arrival","Arrival register"]);
    if(["superintendent","principal","driver"].includes(role))list.push(["arrival-reconciliation","Arrival reconciliation"]);
    if(["superintendent","principal"].includes(role))list.push(["command","Command center"]);
    if(["superintendent","principal"].includes(role))list.push(["arrival-exceptions","Arrival exceptions"]);
    list.push(["notifications","Notifications"]);
    return `<nav class="api-tabs" aria-label="Workspace sections">${list.map(([k,n])=>`<button type="button" data-tab="${k}" aria-pressed="${active===k}"${active===k?' aria-current="page"':""}>${n}</button>`).join("")}</nav>`}
  function operationalNotices(role){
    if(!["superintendent","principal","teacher"].includes(role))return "";
    const notices=[];
    const overdue=data.cases.filter(c=>c.status!=="closed"&&c.follow_up_at&&Date.parse(c.follow_up_at)<Date.now()).length;
    const urgent=data.cases.filter(c=>c.status!=="closed"&&["urgent","high"].includes(String(c.priority).toLowerCase())).length;
    if(role==="superintendent"){
      const pending=data.accessRequests.filter(x=>x.status==="pending").length;
      if(pending)notices.push(["Access requests awaiting review",`${pending} request${pending===1?"":"s"} require leadership review.`]);
      const denied=data.audit.filter(x=>x.outcome==="denied").length;
      if(denied)notices.push(["Denied actions recorded",`${denied} denied action${denied===1?"":"s"} appear in the loaded audit window.`]);
    }
    if(overdue)notices.push(["Overdue intervention follow-ups",`${overdue} visible open case${overdue===1?" has":"s have"} a follow-up date in the past.`]);
    if(urgent)notices.push(["High-priority intervention cases",`${urgent} visible open case${urgent===1?" is":"s are"} marked high or urgent.`]);
    if(!notices.length){
      const unavailable=Object.keys(data.errors||{}).filter(k=>["cases","accessRequests","audit"].includes(k));
      return unavailable.length?`<div class="api-notices" aria-live="polite"><div class="api-notice info"><strong>Operational review is incomplete</strong>Unable to check ${esc(unavailable.join(", "))}. Retry the affected server feeds before treating this as a clear status.</div></div>`:`<div class="api-notices" aria-live="polite"><div class="api-notice info"><strong>No current operational notices</strong>Based on the records available to this signed-in account.</div></div>`;
    }
    return `<div class="api-notices" aria-live="polite"><b>Operational notices</b>${notices.map(([title,detail])=>`<div class="api-notice" role="status"><strong>${esc(title)}</strong>${esc(detail)}</div>`).join("")}</div>`;
  }
  function meshCtx(){return {API,esc,notify,data,ext,render,openTab,loadAll,fmtDate};}
  // 32.2.0 accessibility pass after every render: tie each label to its control,
  // give empty tables a plain-language empty state, and mark tables scrollable.
  let fieldSeq=0;
  function enhance(root){
    root.querySelectorAll("label").forEach(label=>{
      if(label.htmlFor||label.querySelector("input,select,textarea"))return;
      let next=label.nextElementSibling;
      if(next&&/^(INPUT|SELECT|TEXTAREA)$/.test(next.tagName)){if(!next.id)next.id=`api-f-${++fieldSeq}`;label.htmlFor=next.id;}
    });
    root.querySelectorAll("input:not([type=hidden]),select,textarea").forEach(c=>{
      if(c.labels&&c.labels.length||c.getAttribute("aria-label")||c.getAttribute("aria-labelledby"))return;
      const name=c.getAttribute("placeholder")||c.name;if(name)c.setAttribute("aria-label",name.replace(/([a-z])([A-Z])/g,"$1 $2"));
    });
    root.querySelectorAll("table.api-table").forEach(t=>{
      const body=t.tBodies[0];if(body&&!body.rows.length){const cols=t.tHead?.rows[0]?.cells.length||1;body.innerHTML=`<tr><td colspan="${cols}" class="api-empty">Nothing here yet.</td></tr>`;}
      t.querySelectorAll("thead th:not([scope])").forEach(th=>th.setAttribute("scope","col"));
      if(!t.parentElement.classList.contains("api-scroll")){const wrap=document.createElement("div");wrap.className="api-scroll";t.replaceWith(wrap);wrap.appendChild(t);}
    });
    root.querySelectorAll(".api-scroll").forEach(s=>{if(!s.hasAttribute("tabindex")){s.tabIndex=0;s.setAttribute("role","region");s.setAttribute("aria-label",s.querySelector("caption")?.textContent||"Scrollable table");}});
    root.querySelectorAll("button:not([type])").forEach(b=>{if(!b.closest("form"))b.type="button";});
  }
  function syncOperationalStream(tab){
    const permitted=["superintendent","principal","it_admin"].includes(API.actor?.role);
    if(tab!=="audit"||!permitted){
      if(operationalStream){operationalStream.close();operationalStream=null;}
      operationalStreamState=permitted?"disconnected":"unavailable";
      return;
    }
    if(operationalStream)return;
    if(typeof EventSource==="undefined"){
      operationalStreamState="unavailable";
      const status=el("operations-stream-status");if(status)status.textContent="Live streaming is unavailable in this browser. Use Refresh to reload the audit view.";
      return;
    }
    operationalStreamState="connecting";
    operationalStream=new EventSource("/api/operations/stream",{withCredentials:true});
    operationalStream.addEventListener("open",()=>{operationalStreamState="connected";const status=el("operations-stream-status");if(status)status.textContent="Connected · server-confirmed operational events update automatically.";});
    operationalStream.addEventListener("operational",event=>{
      if(activeTab!=="audit")return;
      try{
        const payload=JSON.parse(event.data||"{}");
        const status=el("operations-stream-status");
        if(status&&typeof payload.label==="string"){
          const when=payload.occurredAt?new Date(payload.occurredAt).toLocaleTimeString():"just now";
          status.textContent=`Connected · ${payload.label} (${when}).`;
        }
      }catch{}
      if(streamRefreshPending)return;
      streamRefreshPending=true;
      API.request("/api/audit?limit=250").then(result=>{
        if(activeTab!=="audit")return;
        data.audit=result.data||[];render("audit");
      }).catch(()=>{
        const status=el("operations-stream-status");if(status)status.textContent="Live connection is active, but the latest audit view could not refresh.";
      }).finally(()=>{streamRefreshPending=false;});
    });
    operationalStream.addEventListener("error",()=>{operationalStreamState="reconnecting";const status=el("operations-stream-status");if(status)status.textContent="Reconnecting to the server event stream…";});
  }
  function render(tab){
    activeTab=tab;
    const role=API.actor?.role||"",schoolOptions=data.schools.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(""),studentOptions=data.students.map(s=>`<option value="${esc(s.id)}">${esc(s.display_name)} · ${esc(s.grade_level||"Grade not set")}</option>`).join("");
    let body="";
    if(tab==="students"){
      const total=studentPage?.total??data.students.length;
      body=`<div class="api-grid"><div class="api-card"><b>${Number(total).toLocaleString()}</b><div>${studentQuery?"Matching students":"Students you can see"}</div></div><div class="api-card"><b>${data.schools.length}</b><div>Visible schools</div></div></div>
      <div class="api-card" style="margin-top:10px"><b>Student directory</b><form data-form="student-search" class="api-search" role="search"><label>Find a student<input name="q" type="search" value="${esc(studentQuery)}" placeholder="Name or student number" maxlength="100"></label><button type="submit">Search</button>${studentQuery?'<button type="button" data-action="student-search-clear">Clear</button>':""}</form>
      <div class="api-scroll"><table class="api-table"><caption class="sr-only">Student directory</caption><thead><tr><th scope="col">Student</th><th scope="col">Grade</th><th scope="col">School</th><th scope="col">Profile</th></tr></thead><tbody>${data.students.map(s=>`<tr><td>${esc(s.display_name)}</td><td>${esc(s.grade_level||"—")}</td><td>${esc(s.school_name||"—")}</td><td><button type="button" data-action="profile" data-id="${esc(s.id)}" aria-label="Open profile for ${esc(s.display_name)}">Open profile</button></td></tr>`).join("")||`<tr><td colspan="4" class="api-empty">${studentQuery?"No students match that search.":"No students to show yet. Students appear here after an SIS import."}</td></tr>`}</tbody></table></div>
      ${studentPage?.nextOffset?`<p class="api-muted">Showing ${data.students.length.toLocaleString()} of ${Number(total).toLocaleString()}.</p><button type="button" data-action="students-more">Show more students</button>`:""}<div id="api-profile"></div></div>`;
    }else if(tab==="assignments"){
      const canCreate=["superintendent","principal","teacher"].includes(role),canGrade=["superintendent","principal","teacher"].includes(role),canSubmit=role==="pupil";
      body=`<div class="api-grid"><div class="api-card"><b>${data.assignments.length}</b><div>Visible assignments</div></div><div class="api-card"><b>${data.assignments.reduce((n,a)=>n+Number(a.submission_count||0),0)}</b><div>Submitted work</div></div></div>
      ${canCreate?`<div class="api-card" style="margin-top:10px"><b>Create assignment</b><form data-form="assignment"><label>Title</label><input name="title" maxlength="180" required><label>Instructions</label><textarea name="instructions" maxlength="10000"></textarea>${role==="superintendent"?`<label>School</label><select name="schoolId" required>${schoolOptions}</select>`:""}<label>Due date</label><input name="dueAt" type="datetime-local"><label>Visibility</label><select name="status"><option value="published">Publish now (students and families can see it)</option><option value="draft">Save as draft (staff only)</option></select><button class="primary">Publish assignment</button></form></div>`:""}
      <div class="api-card" style="margin-top:10px"><b>Assignments</b><table class="api-table"><thead><tr><th>Title</th><th>Status</th><th>Due</th><th>Submissions</th><th>Workflow</th></tr></thead><tbody>${data.assignments.map(a=>`<tr><td>${esc(a.title)}${a.instructions?`<br><small>${esc(a.instructions)}</small>`:""}</td><td><span class="api-status ${esc(a.status)}">${esc(a.status)}</span></td><td>${esc(fmtDate(a.due_at))}</td><td>${esc(a.submission_count)}</td><td>${canSubmit?`<button data-action="submit" data-id="${esc(a.id)}">Submit work</button>`:canGrade?`<button data-action="submissions" data-id="${esc(a.id)}">Review / grade</button>${a.status==="draft"?` <button data-action="assignment-status" data-status="published" data-id="${esc(a.id)}">Publish</button>`:a.status==="published"?` <button data-action="assignment-status" data-status="closed" data-id="${esc(a.id)}">Close</button>`:` <button data-action="assignment-status" data-status="published" data-id="${esc(a.id)}">Reopen</button>`}`:"View"}</td></tr>`).join("")||'<tr><td colspan="5">No assignments available.</td></tr>'}</tbody></table><div id="api-submissions"></div></div>`;
    }else if(tab==="cases"){
      const canCreate=["superintendent","principal","teacher"].includes(role);
      body=`<div class="api-grid"><div class="api-card"><b>${data.cases.length}</b><div>Visible intervention cases</div></div><div class="api-card"><b>${data.cases.filter(c=>c.status!=="closed").length}</b><div>Open / active cases</div></div><div class="api-card"><b>${data.cases.filter(c=>c.priority==="urgent"||c.priority==="high").length}</b><div>High-priority cases</div></div></div>
      ${canCreate?`<div class="api-card" style="margin-top:10px"><b>Open intervention case</b><form data-form="case"><label>Student</label><select name="studentId" required>${studentOptions}</select><label>Category</label><select name="category"><option value="academic">Academic</option><option value="attendance">Attendance</option><option value="behavior">Behavior</option><option value="wellbeing">Wellbeing</option><option value="family_support">Family support</option><option value="other">Other</option></select><label>Priority</label><select name="priority"><option>normal</option><option>low</option><option>high</option><option>urgent</option></select><label>Title</label><input name="title" maxlength="180" required><label>Summary</label><textarea name="summary" maxlength="4000" required></textarea><label>Support plan</label><textarea name="supportPlan" maxlength="8000"></textarea><label>Follow-up date</label><input name="followUpAt" type="datetime-local"><label><input style="width:auto" name="familyVisible" type="checkbox" value="true"> Share case summary with linked family account</label><button class="primary">Create case</button></form><div class="api-muted">Use minimum necessary information. Family visibility is explicit; internal notes remain staff-only unless separately marked.</div></div>`:""}
      <div class="api-card" style="margin-top:10px"><b>Intervention register</b><table class="api-table"><thead><tr><th>Student</th><th>Case</th><th>Priority / status</th><th>Follow-up</th><th>Action</th></tr></thead><tbody>${data.cases.map(c=>`<tr><td>${esc(c.display_name)}</td><td>${esc(c.title)}<br><small>${esc(c.category)} · ${c.family_visible?"Family-visible":"Staff-only"}</small></td><td>${esc(c.priority)} / ${esc(c.status)}</td><td>${esc(c.follow_up_at||"—")}</td><td><button data-action="case-open" data-id="${esc(c.id)}">Open Student 360</button>${canCreate?` <button data-action="case-note" data-id="${esc(c.id)}">Add note</button> <button data-action="case-progress" data-id="${esc(c.id)}">Move to in progress</button>`:""}</td></tr>`).join("")||'<tr><td colspan="5">No intervention cases visible to this account.</td></tr>'}</tbody></table></div>`;
    }else if(tab==="access_requests"){
      const canReview=role==="superintendent";
      const schoolField=role==="superintendent"?`<label>Scope (optional school; blank means district-wide)</label><select name="schoolId"><option value="">District-wide</option>${schoolOptions}</select>`:"";
      body=`<div class="api-grid"><div class="api-card"><b>${data.accessRequests.filter(x=>x.status==="pending").length}</b><div>Pending requests</div></div><div class="api-card"><b>${data.accessRequests.filter(x=>x.status==="approved").length}</b><div>Approved grants</div></div><div class="api-card"><b>${data.accessRequests.filter(x=>x.status==="revoked").length}</b><div>Revoked grants</div></div></div>
      ${["superintendent","principal","teacher"].includes(role)?`<div class="api-card" style="margin-top:10px"><b>Request additional access</b><form data-form="access-request"><label>Permission</label><select name="permission" required><option value="schools:update">Update school records (SIS import)</option></select>${schoolField}<label>Business reason (20–1,000 characters)</label><textarea name="reason" minlength="20" maxlength="1000" required></textarea><label>Expires on</label><input name="expiresAt" type="date" required><button class="primary">Submit access request</button></form><div class="api-muted">Requests are reviewed by a different district superintendent. Approved access expires automatically and remains subject to school scope.</div></div>`:""}
      <div class="api-card" style="margin-top:10px"><b>${canReview?"District access requests":"Your access requests"}</b><table class="api-table"><thead><tr><th>Requester</th><th>Permission</th><th>Scope</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody>${data.accessRequests.map(a=>`<tr><td>${esc(a.requester_name||"You")} · ${esc(a.requester_role||role)}</td><td>${esc(a.resource)}:${esc(a.action)}<br>${esc(a.reason)}</td><td>${esc(a.school_id||"District")}</td><td>${esc(a.requested_expires_at)}</td><td>${esc(a.status)}</td><td>${canReview&&a.status==="pending"?`<button data-action="approve-access" data-id="${esc(a.id)}">Approve</button> <button data-action="deny-access" data-id="${esc(a.id)}">Deny</button>`:""}${canReview&&a.status==="approved"?`<button data-action="revoke-access" data-id="${esc(a.id)}">Revoke</button>`:""}${esc(a.reviewer_name||"")}</td></tr>`).join("")||'<tr><td colspan="6">No access requests yet.</td></tr>'}</tbody></table></div>`;
    }else if(tab==="audit"){
      const agentEvents=data.audit.filter(a=>a.resource_type==="agent_orchestration");
      body=`<div class="api-card"><b>Operations event stream</b><p class="api-muted" id="operations-stream-status" role="status">${operationalStreamState==="connected"?"Connected · server-confirmed operational events update automatically.":operationalStreamState==="reconnecting"?"Reconnecting to the server event stream…":operationalStreamState==="unavailable"?"Live streaming is unavailable in this browser.":"Connecting to authenticated district event stream…"}</p></div><div class="api-card"><b>Server-recorded agent orchestration</b><p class="api-muted">These entries record the authenticated actor, run identifier, approved topic category, and bounded handoff route. Original questions and generated output are not stored.</p><table class="api-table"><thead><tr><th>Time</th><th>Actor</th><th>Run</th><th>Trace metadata</th></tr></thead><tbody>${agentEvents.map(a=>`<tr><td>${esc(a.occurred_at)}</td><td>${esc(a.actor_role)}</td><td>${esc(a.resource_id||"")}</td><td>${esc(a.detail||"")}</td></tr>`).join("")||'<tr><td colspan="4">No server-recorded agent runs in the current audit window.</td></tr>'}</tbody></table></div><div class="api-card" style="margin-top:10px"><b>Server audit events</b>${role==="superintendent"?`<p><button data-action="export-audit">Download server audit CSV</button></p>`:""}<table class="api-table"><thead><tr><th>Time</th><th>Actor role</th><th>Action</th><th>Record</th><th>Outcome</th></tr></thead><tbody>${data.audit.map(a=>`<tr><td>${esc(a.occurred_at)}</td><td>${esc(a.actor_role)}</td><td>${esc(a.action)}</td><td>${esc(a.resource_type)} ${esc(a.resource_id||"")}</td><td>${esc(a.outcome)}</td></tr>`).join("")||'<tr><td colspan="5">No server audit events available.</td></tr>'}</tbody></table></div>`;
    }else if(window.EduOSMesh.TABS.includes(tab)){
      body=window.EduOSMesh.render(tab,meshCtx());
    }else if(EXT_TABS.includes(tab)){
      body=renderExt(tab,role,schoolOptions,studentOptions);
    }else{
      const canCreate=["superintendent","principal","teacher"].includes(role);
      body=`<div class="api-grid"><div class="api-card"><b>${data.attendance.length}</b><div>Attendance events</div></div><div class="api-card"><b>${data.attendance.filter(a=>a.status==="absent").length}</b><div>Absences in returned records</div></div></div>
      ${canCreate?`<div class="api-card" style="margin-top:10px"><b>Record attendance</b><form data-form="attendance"><label>Student</label><select name="studentId" required>${studentOptions}</select><label>Date</label><input name="eventDate" type="date" required><label>Status</label><select name="status"><option value="present">Present</option><option value="absent">Absent</option><option value="tardy">Tardy</option><option value="excused">Excused</option></select><button class="primary">Save attendance</button></form></div>`:""}
      <div class="api-card" style="margin-top:10px"><b>Attendance register</b><table class="api-table"><thead><tr><th>Date</th><th>Student</th><th>Status</th><th>Family acknowledgment</th></tr></thead><tbody>${data.attendance.map(a=>`<tr><td>${esc(a.event_date)}</td><td>${esc(a.display_name)}</td><td>${esc(a.status)}</td><td>${esc(a.family_acknowledged_at||"—")}</td><td>${role==="parent"&&!a.family_acknowledged_at?`<button data-action="acknowledge" data-id="${esc(a.id)}">Acknowledge</button>`:""}</td></tr>`).join("")||'<tr><td colspan="5">No attendance events available.</td></tr>'}</tbody></table></div>`;
    }
    const warning=Object.entries(data.errors||{}).map(([key,message])=>`<li><b>${esc(key)}</b>: ${esc(message)}</li>`).join("");
    el("eduos-api-content").innerHTML=tabs(tab)+operationalNotices(role)+(warning?`<div class="api-card" role="status" style="margin:8px 0;border-color:#d69b42"><b>Some sections could not be refreshed</b><ul>${warning}</ul><button type="button" data-action="retry-load">Retry</button></div>`:"")+body;
    enhance(el("eduos-api-content"));
    syncOperationalStream(tab);
    el("eduos-api-content").querySelectorAll("[data-tab]").forEach(b=>b.onclick=async()=>{
      const content=el("eduos-api-content");content.setAttribute("aria-busy","true");
      try{
        if(b.dataset.tab==="audit"){
          try{const audit=await API.request("/api/audit?limit=250");data.audit=audit.data||[];render("audit");}
          catch(error){notify(error.message);render("audit");}
        }else if(EXT_TABS.includes(b.dataset.tab)||window.EduOSMesh.TABS.includes(b.dataset.tab)){await openTab(b.dataset.tab);}
        else render(b.dataset.tab);
      }finally{content.removeAttribute("aria-busy");}
      const heading=content.querySelector(`[data-tab="${b.dataset.tab}"]`);if(heading)heading.focus({preventScroll:true});
    });
  }
  async function submitForm(event){
    const form=event.target.closest("form[data-form]");if(!form)return;event.preventDefault();const v=Object.fromEntries(new FormData(form).entries());
    const submitter=form.querySelector('[type="submit"]');if(submitter)submitter.disabled=true;form.setAttribute("aria-busy","true");
    try{
      if(form.dataset.form==="student-search"){studentQuery=String(v.q||"").trim();await loadAll();render("students");return;}
      if(await window.EduOSMesh.submit(form,v,meshCtx()))return;
      if(await submitExt(form,v))return;
      if(form.dataset.form==="access-request"){
        const [resource,action]=String(v.permission||"").split(":");
        const body={resource,action,reason:v.reason,expiresAt:new Date(v.expiresAt+"T23:59:59").toISOString()};
        if(v.schoolId)body.schoolId=v.schoolId;
        await API.request("/api/access-requests",{method:"POST",body:JSON.stringify(body)});
        notify("Access request submitted for leadership review.");
        await loadAll();render("access_requests");return;
      }
      if(form.dataset.form==="case"){v.familyVisible=form.elements.familyVisible.checked;v.followUpAt=v.followUpAt?new Date(v.followUpAt).toISOString():null;await API.request("/api/cases",{method:"POST",body:JSON.stringify(v)});notify("Intervention case created on server.");await loadAll();render("cases");return;}
      if(form.dataset.form==="assignment"){v.dueAt=v.dueAt?new Date(v.dueAt).toISOString():null;await API.request("/api/assignments",{method:"POST",body:JSON.stringify(v)});notify(v.status==="draft"?"Draft saved; only staff can see it.":"Assignment published on server.");}
      if(form.dataset.form==="attendance"){await API.request("/api/attendance",{method:"POST",body:JSON.stringify(v)});notify("Attendance saved on server.");}
      if(form.dataset.form==="grade"){const id=form.dataset.submission;await API.request(`/api/assignments/${form.dataset.assignment}/submissions/${id}/grade`,{method:"POST",body:JSON.stringify({score:Number(v.score),feedback:v.feedback||""})});notify("Grade saved on server.");}
      await loadAll();render(form.dataset.form==="attendance"?"attendance":"assignments");
    }catch(e){notify(e.message)}
    finally{if(submitter)submitter.disabled=false;form.removeAttribute("aria-busy");}
  }
  async function handleAction(event){
    const b=event.target.closest("[data-action]");if(!b)return;const id=b.dataset.id;
    try{
      if(b.dataset.action==="retry-load"){await loadAll();return;}
      if(b.dataset.action==="sign-in"){location.assign("/auth/login");return;}
      if(b.dataset.action==="students-more"){const r=await API.request(`/api/students?limit=100&offset=${studentPage?.nextOffset||0}${studentQuery?`&q=${encodeURIComponent(studentQuery)}`:""}`);data.students=data.students.concat(r.data||[]);studentPage=r.page;render("students");return;}
      if(b.dataset.action==="student-search-clear"){studentQuery="";await loadAll();render("students");return;}
      if(await window.EduOSMesh.action(b,meshCtx()))return;
      if(await actionExt(b))return;
      if(b.dataset.action==="approve-access"||b.dataset.action==="deny-access"){
        const decision=b.dataset.action==="approve-access"?"approved":"denied";
        const note=prompt("Optional decision note:")||"";
        await API.request(`/api/access-requests/${id}/decision`,{method:"POST",body:JSON.stringify({decision,note})});
        notify(`Access request ${decision}.`);await loadAll();render("access_requests");
      }
      if(b.dataset.action==="revoke-access"){
        const note=prompt("Reason for revoking this grant:")||"";
        await API.request(`/api/access-requests/${id}/revoke`,{method:"POST",body:JSON.stringify({note})});
        notify("Permission grant revoked.");await loadAll();render("access_requests");
      }
      if(b.dataset.action==="profile"||b.dataset.action==="case-open"){
        const studentId=b.dataset.action==="profile"?id:data.cases.find(c=>c.id===id)?.student_id;
        if(!studentId)throw new Error("Student record is no longer in the current list. Refresh and try again.");
        const r=await API.request(`/api/student-360/${studentId}`),d=r.data;
        let target=el("api-profile");
        if(!target){target=document.createElement("div");target.id="api-profile";target.setAttribute("aria-live","polite");const nav=el("eduos-api-content").querySelector(".api-tabs");if(nav)nav.insertAdjacentElement("afterend",target);else el("eduos-api-content").prepend(target);}
        target.innerHTML=`<div class="api-card" style="margin:8px 0"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><b>${esc(d.student.display_name)} · Student 360</b><span>${["principal","superintendent"].includes(API.actor?.role)?`<button type="button" data-action="records-export" data-id="${esc(d.student.id)}">Export education record (FERPA)</button> `:""}${API.actor?.role==="superintendent"?`<button type="button" data-action="records-delete" data-id="${esc(d.student.id)}" data-number="${esc(d.student.local_student_number)}">Delete record…</button> `:""}<button type="button" data-action="close-profile">Close profile</button></span></div><p>Student number: ${esc(d.student.local_student_number)} · Grade: ${esc(d.student.grade_level||"—")} · ${esc(d.student.school_name)}</p><h4>Attendance (${d.attendance.length})</h4><p>${d.attendance.slice(0,8).map(x=>`${esc(x.event_date)}: ${esc(x.status)}`).join(" · ")||"No attendance events"}</p><h4>Academics (${d.academics.length})</h4><p>${d.academics.slice(0,8).map(x=>`${esc(x.title)}: ${x.score===null?"Not graded":esc(x.score)}`).join(" · ")||"No assignments"}</p><h4>Intervention cases (${d.cases.length})</h4><ul>${d.cases.map(c=>`<li>${esc(c.title)} · ${esc(c.priority)} / ${esc(c.status)}</li>`).join("")||"<li>No visible cases</li>"}</ul><h4>Student record history (${d.timeline.length})</h4><ol aria-label="Chronological student record history">${d.timeline.slice(0,30).map(t=>`<li style="margin:8px 0"><b>${esc(t.label)}</b><div>${esc(new Date(t.occurred_at).toLocaleString())} · ${esc(t.kind.replaceAll("_"," "))}${t.actor_name?" · "+esc(t.actor_name):""}</div>${t.detail?`<div>${esc(t.detail)}</div>`:""}</li>`).join("")||"<li>No timeline events</li>"}</ol><p class="api-muted">History combines attendance, assignments, submissions, grades, acknowledgments, and authorized intervention notes. Family-visible notes are shown only when both the case and note are marked family-visible.</p></div>`;
      }
      if((b.dataset.action==="profile"||b.dataset.action==="case-open")&&el("api-profile"))el("api-profile").scrollIntoView({block:"start"});
      if(b.dataset.action==="close-profile"){const profile=el("api-profile");if(profile)profile.remove();}
      if(b.dataset.action==="case-note"){const note=prompt("Add a staff case note:");if(note===null||!note.trim())return;await API.request(`/api/cases/${id}/notes`,{method:"POST",body:JSON.stringify({note,familyVisible:false})});notify("Append-only case note saved.");await loadAll();render("cases");}
      if(b.dataset.action==="case-progress"){await API.request(`/api/cases/${id}`,{method:"PATCH",body:JSON.stringify({status:"in_progress"})});notify("Case status updated.");await loadAll();render("cases");}
      if(b.dataset.action==="export-audit"){
        const response=await fetch("/api/audit/export",{method:"POST",credentials:"same-origin",headers:{"X-CSRF-Token":API.csrf}});
        if(!response.ok){const detail=await response.json().catch(()=>({}));throw new Error(detail.error||"Audit export failed");}
        const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement("a");
        a.href=url;a.download="eduos-server-audit.csv";a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
        notify("Server audit CSV exported.");
      }
      if(b.dataset.action==="acknowledge"){await API.request(`/api/attendance/${id}/acknowledge`,{method:"POST",body:JSON.stringify({})});notify("Attendance acknowledged.");await loadAll();render("attendance");}
      if(b.dataset.action==="submit"){if(!data.students.length)throw new Error("No linked learner record available.");const studentId=data.students.length===1?data.students[0].id:prompt("Enter one of your linked student IDs:\n"+data.students.map(s=>`${s.display_name}: ${s.id}`).join("\n"));if(!studentId)return;if(!data.students.some(s=>s.id===studentId))throw new Error("Select a learner linked to your account.");const responseText=prompt("Enter assignment response:");if(responseText===null)return;await API.request(`/api/assignments/${id}/submit`,{method:"POST",body:JSON.stringify({studentId,responseText})});notify("Submission saved on server.");await loadAll();render("assignments");}
      if(b.dataset.action==="submissions"){const r=await API.request(`/api/assignments/${id}/submissions`);const box=el("api-submissions");box.innerHTML=`<div class="api-card" style="margin-top:10px"><b>Submissions</b>${r.data.map(s=>`<form data-form="grade" data-assignment="${esc(id)}" data-submission="${esc(s.id)}"><p><b>${esc(s.display_name)}</b> · ${esc(s.submitted_at)}</p><p>${esc(s.response_text)}</p><label>Score (0–100)</label><input name="score" type="number" min="0" max="100" step="0.01" value="${esc(s.score??"")}" required><label>Feedback</label><textarea name="feedback">${esc(s.feedback||"")}</textarea><button class="primary">Save grade</button></form><hr>`).join("")||"<p>No submissions yet.</p>"}</div>`;}
    }catch(e){notify(e.message)}
  }
  async function logAgentRun(run){
    if(!API.actor||!["superintendent","principal"].includes(API.actor.role))return {recorded:false,reason:"leadership_session_required"};
    const result=await API.request("/api/agent-events",{method:"POST",body:JSON.stringify({runId:run.id,category:run.category,route:run.route})});
    if(activeTab==="audit"){const audit=await API.request("/api/audit");data.audit=audit.data||[];render("audit");}
    return result;
  }
  // ---------------------------------------------------------------------------
  // 32.1.0: operator workspaces for flows whose API existed without a screen:
  // administration (schools, people, roles), rosters, guardian invitations,
  // SIS CSV import and webhooks. Everything goes through API.request (CSRF,
  // session expiry) and every value rendered is escaped.
  // ---------------------------------------------------------------------------
  const EXT_TABS=["admin","rosters","guardians","sis","webhooks","arrival","command"];
  const ext={users:[],roles:[],rosters:[],invitations:[],lastInviteUrl:"",sisRuns:[],sisResult:null,webhooks:{enabled:false,eventTypes:[],data:[]},webhookSecret:null,deliveries:null,arrival:{handoffs:[],students:[],teachers:[],transport:null},command:{handoffs:[],transport:null,teachers:[]}};
  function fmtDate(v){if(!v)return "—";const d=new Date(v);return Number.isNaN(d.getTime())?String(v):d.toLocaleString([], {dateStyle:"medium",timeStyle:/T00:00:00/.test(String(v))?undefined:"short"})}
  async function openTab(tab){
    const role=API.actor?.role,load=async(key,url,pick=r=>r?.data||[])=>{try{ext[key]=pick(await API.request(url));delete data.errors[key];}catch(e){data.errors[key]=e.message;}};
    if(!data.errors)data.errors={};
    if(window.EduOSMesh.TABS.includes(tab)){await window.EduOSMesh.load(tab,meshCtx());render(tab);return;}
    if(tab==="admin")await load("users","/api/users",r=>{ext.roles=r?.roles||[];return r?.data||[]});
    if(tab==="rosters"){await load("rosters","/api/rosters");await load("users","/api/users?role=teacher");}
    if(tab==="guardians"&&role!=="parent")await load("invitations","/api/guardian-invitations");
    if(tab==="sis")await load("sisRuns","/api/integrations/sis/runs");
    if(tab==="webhooks")await load("webhooks","/api/webhooks",r=>r||{enabled:false,eventTypes:[],data:[]});
    if(tab==="command"){
      const c=ext.command;
      const jobs=[API.request("/api/arrival/today"),API.request("/api/transport/today"),API.request("/api/users?role=teacher"),API.request("/api/arrival/reconciliation")];
      const results=await Promise.allSettled(jobs);
      const feedErrors=[];
      const arrival=results[0].status==="fulfilled"?results[0].value?.data:null;
      const transport=results[1].status==="fulfilled"?results[1].value?.data:null;
      const teachers=results[2].status==="fulfilled"?results[2].value?.data:null;
      const reconciliation=results[3].status==="fulfilled"?results[3].value?.data:null;
      if(Array.isArray(arrival))c.handoffs=arrival;else{c.handoffs=[];feedErrors.push("arrival");}
      if(transport&&typeof transport==="object"&&!Array.isArray(transport)&&Array.isArray(transport.routes))c.transport=transport;else{c.transport=null;feedErrors.push("transport");}
      if(Array.isArray(teachers))c.teachers=teachers;else{c.teachers=[];feedErrors.push("staffing");}
      if(Array.isArray(reconciliation))c.reconciliation=reconciliation;else{c.reconciliation=[];feedErrors.push("reconciliation");}
      results.forEach((r,i)=>{if(r.status==="rejected")feedErrors.push(["arrival","transport","staffing","reconciliation"][i]);});
      data.errors.command=[...new Set(feedErrors)];
    }
    if(tab==="notifications"){
      try{ext.notifications=await API.request("/api/notifications");delete data.errors.notifications;}
      catch(e){data.errors.notifications=e.message;ext.notifications={data:{items:[],unread:0}};}
    }
    if(tab==="arrival-reconciliation"){
      try{ext.arrival.reconciliation=(await API.request("/api/arrival/reconciliation")).data||[];delete data.errors.arrivalReconciliation;}
      catch(e){data.errors.arrivalReconciliation=e.message;ext.arrival.reconciliation=[];}
    }
    if(tab==="arrival-exceptions"){
      try{ext.arrival.exceptions=(await API.request("/api/arrival/exceptions")).data||[];delete data.errors.arrivalExceptions;}
      catch(e){data.errors.arrivalExceptions=e.message;ext.arrival.exceptions=[];}
      try{const [teachers,principals]=await Promise.all([API.request("/api/users?role=teacher"),API.request("/api/users?role=principal")]);ext.arrival.managers=[...(teachers.data||[]),...(principals.data||[])];}
      catch{ext.arrival.managers=[];}
    }
    if(tab==="arrival"){
      try{ext.arrival.handoffs=(await API.request("/api/arrival/today")).data||[];delete data.errors.arrival;}
      catch(e){data.errors.arrival=e.message;ext.arrival.handoffs=[];}
      try{ext.arrival.students=(await API.request("/api/students?limit=200")).data||[];}catch{ext.arrival.students=[];}
      try{ext.arrival.teachers=(await API.request("/api/users?role=teacher")).data||[];}catch{ext.arrival.teachers=[];}
      if(["driver","principal","superintendent"].includes(role)){
        try{ext.arrival.transport=(await API.request("/api/transport/today")).data||null;}catch{ext.arrival.transport=null;}
      }
    }
    render(tab);
  }
  function opts(list,value,label){return list.map(x=>`<option value="${esc(x[value])}">${esc(x[label])}</option>`).join("")}
  function renderExt(tab,role,schoolOptions,studentOptions){
    const isSup=role==="superintendent",isIT=role==="it_admin",isDist=isSup||isIT;
    if(tab==="admin"){
      // 32.2.0: district IT manages schools and school-level accounts at any school, never district roles.
      const IT_ROLES=["principal","teacher","parent","pupil"];
      const schoolCard=isDist?`<div class="api-card"><b>Schools</b><table class="api-table"><thead><tr><th>School</th><th>Level</th><th>Status</th><th></th></tr></thead><tbody>${data.schools.map(s=>`<tr><td>${esc(s.name)}</td><td>${esc(s.school_level||"—")}</td><td>${esc(s.status||"active")}</td><td><button data-action="school-status" data-id="${esc(s.id)}" data-status="${s.status==="inactive"?"active":"inactive"}">${s.status==="inactive"?"Reactivate":"Deactivate"}</button></td></tr>`).join("")||'<tr><td colspan="4">No schools yet.</td></tr>'}</tbody></table>
        <form data-form="school-create" class="api-inline"><label>New school name</label><input name="name" required maxlength="160"><label>Level</label><select name="schoolLevel"><option value="elementary">Elementary</option><option value="middle">Middle</option><option value="high">High</option><option value="k8">K-8</option><option value="k12">K-12</option><option value="other">Other</option></select><button class="primary">Create school</button></form></div>`:"";
      const roles=isSup?ext.roles:isIT?IT_ROLES:["teacher","parent","pupil"];
      const createCard=`<div class="api-card" style="margin-top:10px"><b>${isDist?"Provision a user":"Add a teacher, family member or student account"}</b><p class="api-muted">Accounts are pre-provisioned: the person signs in with your district identity provider and EduOS matches the identity-provider subject (the <code>sub</code> claim) you enter here. Nobody can sign in until they are provisioned.</p>
        <form data-form="user-create"><label>Full name</label><input name="displayName" required maxlength="160"><label>Email</label><input name="email" type="email" required><label>Identity-provider subject (sub)</label><input name="oidcSubject" required maxlength="255" pattern="[A-Za-z0-9._:@|\\-]+"><label>Role</label><select name="role">${roles.map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select>${isSup?`<label>School (leave empty for district roles)</label><select name="schoolId"><option value="">District-wide</option>${schoolOptions}</select>`:isIT?`<label>School</label><select name="schoolId" required>${schoolOptions}</select>`:""}<button class="primary">Create account</button></form></div>`;
      const grantRoles=isSup?ext.roles:IT_ROLES;
      const grantCard=isDist?`<div class="api-card" style="margin-top:10px"><b>Grant an additional role</b><form data-form="membership-add"><label>Person</label><select name="userId" required>${opts(ext.users.filter(u=>u.id!==API.actor?.userId),"id","displayName")}</select><label>Role</label><select name="role">${grantRoles.map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select><label>School</label><select name="schoolId"${isIT?" required":""}>${isSup?'<option value="">District-wide</option>':""}${schoolOptions}</select><button class="primary">Grant role</button></form></div>`:"";
      const districtUser=u=>u.memberships.some(m=>m.role==="superintendent"||m.role==="it_admin");
      const people=`<div class="api-card" style="margin-top:10px"><b>${isDist?"District people":"People at your school"}</b> <span class="api-muted">${ext.users.length} account${ext.users.length===1?"":"s"}</span><table class="api-table"><thead><tr><th>Name</th><th>Email${isDist?" · sign-in subject":""}</th><th>Roles</th><th>Account</th></tr></thead><tbody>${ext.users.map(u=>`<tr><td>${esc(u.displayName)}</td><td>${esc(u.email||"—")}${u.oidcSubject?`<br><small>${esc(u.oidcSubject)}</small>`:""}</td><td>${u.memberships.map(m=>`<div>${esc(m.role)} · ${esc(m.schoolName||"District")} · ${esc(m.status)} ${m.id&&API.actor?.userId!==u.id&&!(isIT&&districtUser(u))?`<button data-action="membership-status" data-id="${esc(m.id)}" data-status="${m.status==="active"?"disabled":"active"}">${m.status==="active"?"Disable":"Enable"}</button>`:""}</div>`).join("")}</td><td>${esc(u.status)}${(isSup||(isIT&&!districtUser(u)))&&API.actor?.userId!==u.id?` <button data-action="user-status" data-id="${esc(u.id)}" data-status="${u.status==="active"?"disabled":"active"}">${u.status==="active"?"Disable account":"Enable account"}</button>`:""}</td></tr>`).join("")||'<tr><td colspan="4">No people found.</td></tr>'}</tbody></table></div>`;
      return schoolCard+createCard+grantCard+people;
    }
    if(tab==="rosters"){
      const teachers=ext.users.filter(u=>u.memberships.some(m=>m.role==="teacher"&&m.status==="active"));
      const byTeacher=new Map();for(const r of ext.rosters){if(!byTeacher.has(r.teacher_user_id))byTeacher.set(r.teacher_user_id,{name:r.teacher_name,rows:[]});byTeacher.get(r.teacher_user_id).rows.push(r);}
      return `<div class="api-card"><b>Assign a student to a teacher</b><p class="api-muted">Teachers only see students on their roster. Changes are audited.</p><form data-form="roster-add"><label>Teacher</label><select name="teacherUserId" required>${opts(teachers,"id","displayName")}</select><label>Student</label><select name="studentId" required>${studentOptions}</select><button class="primary">Add to roster</button></form></div>
      ${[...byTeacher.entries()].map(([teacherId,t])=>`<div class="api-card" style="margin-top:10px"><b>${esc(t.name)}</b> <span class="api-muted">${t.rows.length} student${t.rows.length===1?"":"s"}</span><table class="api-table"><thead><tr><th>Student</th><th>Since</th><th></th></tr></thead><tbody>${t.rows.map(r=>`<tr><td>${esc(r.student_name)}</td><td>${esc(fmtDate(r.created_at))}</td><td><button data-action="roster-remove" data-teacher="${esc(teacherId)}" data-id="${esc(r.student_id)}">Remove</button></td></tr>`).join("")}</tbody></table></div>`).join("")||'<div class="api-card" style="margin-top:10px">No roster entries yet.</div>'}`;
    }
    if(tab==="guardians"){
      if(role==="parent"){
        const token=pendingInvite();
        return `<div class="api-card"><b>Link a child to your account</b><p>Your school sends a one-time invitation link. Opening it while signed in fills in the code below; you can also paste the code (the part after <code>guardianInvite=</code>).</p><form data-form="invite-accept"><label>Invitation code</label><input name="token" required minlength="40" maxlength="128" value="${esc(token)}" autocomplete="off"><button class="primary">Accept invitation</button></form><p class="api-muted">The invitation only works for the email address the school verified. Linked children: ${esc(data.students.map(s=>s.display_name).join(", ")||"none yet")}.</p></div>`;
      }
      return `<div class="api-card"><b>Invite a parent or guardian</b><p class="api-muted">The family member must already have a parent account (see ${isSup?"Administration":"People"}) with the same email. Email delivery is not configured, so copy the one-time link to the verified recipient.</p><form data-form="invite-create"><label>Student</label><select name="studentId" required>${studentOptions}</select><label>Guardian email</label><input name="email" type="email" required><label>Relationship</label><select name="relationship"><option value="parent">Parent</option><option value="guardian">Guardian</option></select><button class="primary">Create invitation</button></form>${ext.lastInviteUrl?`<div class="api-notice info" style="margin-top:8px"><strong>One-time invitation link (shown once)</strong><input readonly value="${esc(ext.lastInviteUrl)}" style="width:100%" id="api-invite-url"><button type="button" data-action="copy" data-target="api-invite-url">Copy link</button></div>`:""}</div>
      <div class="api-card" style="margin-top:10px"><b>Invitations</b><table class="api-table"><thead><tr><th>Student</th><th>Email</th><th>Relationship</th><th>Status</th><th>Expires</th><th></th></tr></thead><tbody>${ext.invitations.map(i=>`<tr><td>${esc(i.student_name)}</td><td>${esc(i.invited_email)}</td><td>${esc(i.relationship)}</td><td>${esc(i.status)}</td><td>${esc(fmtDate(i.expires_at))}</td><td>${i.status==="pending"?`<button data-action="invite-revoke" data-id="${esc(i.id)}">Revoke</button>`:""}</td></tr>`).join("")||'<tr><td colspan="6">No invitations yet.</td></tr>'}</tbody></table></div>`;
    }
    if(tab==="sis"){
      const now=new Date(),stamp=`${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
      const r=ext.sisResult;
      return `<div class="api-card"><b>Import from your student information system (CSV)</b><p class="api-muted">Students CSV columns: <code>local_student_number,display_name[,grade_level]</code>. Attendance CSV columns: <code>source_event_id,local_student_number,event_date,status</code> (present, absent, tardy, excused). Re-sending a batch id is refused, and re-sent attendance events are ignored, so imports are safe to retry.</p>
      <form data-form="sis-import"><label>School</label><select name="schoolId" required>${schoolOptions}</select><label>Source system</label><input name="sourceSystem" value="csv-upload" required maxlength="80"><label>Batch id</label><input name="sourceBatchId" value="csv-${esc(stamp)}" required maxlength="120"><label>Students CSV</label><input name="studentsFile" type="file" accept=".csv,text/csv"><label>Attendance CSV</label><input name="attendanceFile" type="file" accept=".csv,text/csv"><button class="primary">Import</button></form>
      ${r?`<div class="api-notice info" style="margin-top:8px"><strong>Import ${esc(r.status||"finished")}</strong>Students upserted: ${esc(r.studentsUpserted??"—")} · attendance imported: ${esc(r.attendanceImported??"—")}</div>`:""}</div>
      <div class="api-card" style="margin-top:10px"><b>Recent import runs</b><table class="api-table"><thead><tr><th>When</th><th>School</th><th>Batch</th><th>Students</th><th>Attendance</th><th>Status</th><th>By</th></tr></thead><tbody>${ext.sisRuns.map(x=>`<tr><td>${esc(fmtDate(x.created_at))}</td><td>${esc(x.school_name)}</td><td>${esc(x.source_system)} · ${esc(x.source_batch_id)}</td><td>${esc(x.students_upserted)}/${esc(x.students_received)}</td><td>${esc(x.attendance_imported)}/${esc(x.attendance_received)}</td><td>${esc(x.status)}</td><td>${esc(x.initiated_by)}</td></tr>`).join("")||'<tr><td colspan="7">No imports yet.</td></tr>'}</tbody></table></div>`;
    }
    if(tab==="webhooks"){
      const w=ext.webhooks;
      return `<div class="api-card"><b>Webhooks</b>${w.enabled?"":`<div class="api-notice"><strong>Webhooks are disabled</strong>Set WEBHOOK_SIGNING_KEY on the server to enable deliveries.</div>`}<p class="api-muted">EduOS POSTs signed JSON (no student names or other PII, only ids) to HTTPS endpoints when these events happen. Verify the <code>X-EduOS-Signature</code> header with the secret shown once at creation.</p>
      <form data-form="webhook-create"><label>Endpoint URL</label><input name="url" type="url" required placeholder="https://hooks.example.org/eduos"><fieldset><legend>Events</legend>${w.eventTypes.map(t=>`<label class="api-check"><input type="checkbox" name="eventTypes" value="${esc(t)}" checked> ${esc(t)}</label>`).join("")}</fieldset><button class="primary" ${w.enabled?"":"disabled"}>Add webhook</button></form>
      ${ext.webhookSecret?`<div class="api-notice info" style="margin-top:8px"><strong>Signing secret (copy it now; it is not shown again)</strong><input readonly id="api-webhook-secret" value="${esc(ext.webhookSecret)}" style="width:100%"><button type="button" data-action="copy" data-target="api-webhook-secret">Copy secret</button></div>`:""}</div>
      <div class="api-card" style="margin-top:10px"><b>Subscriptions</b><table class="api-table"><thead><tr><th>URL</th><th>Events</th><th>Status</th><th>Last delivery</th><th></th></tr></thead><tbody>${w.data.map(s=>`<tr><td>${esc(s.url)}</td><td>${esc((s.eventTypes||[]).join(", "))}</td><td>${esc(s.status)}${s.failureCount?` · ${esc(s.failureCount)} failures`:""}</td><td>${esc(fmtDate(s.lastDeliveryAt))} ${esc(s.lastOutcome||"")}</td><td>${s.status==="active"?`<button data-action="webhook-test" data-id="${esc(s.id)}">Send test</button> <button data-action="webhook-deliveries" data-id="${esc(s.id)}">Deliveries</button> <button data-action="webhook-disable" data-id="${esc(s.id)}">Disable</button>`:`<button data-action="webhook-deliveries" data-id="${esc(s.id)}">Deliveries</button>`}</td></tr>`).join("")||'<tr><td colspan="5">No webhooks yet.</td></tr>'}</tbody></table></div>
      ${ext.deliveries?`<div class="api-card" style="margin-top:10px"><b>Recent deliveries</b><table class="api-table"><thead><tr><th>When</th><th>Event</th><th>Attempt</th><th>Outcome</th><th>HTTP</th><th>ms</th></tr></thead><tbody>${ext.deliveries.map(d=>`<tr><td>${esc(fmtDate(d.occurredAt))}</td><td>${esc(d.eventType)}</td><td>${esc(d.attempt)}</td><td>${esc(d.outcome)}</td><td>${esc(d.statusCode??"—")}</td><td>${esc(d.durationMs??"")}</td></tr>`).join("")||'<tr><td colspan="6">No deliveries yet.</td></tr>'}</tbody></table></div>`:""}`;
    }
    if(tab==="command"){
      const c=ext.command||{handoffs:[],transport:null,teachers:[]};
      const handoffs=c.handoffs||[],pending=handoffs.filter(h=>h.status==="pending").length,received=handoffs.filter(h=>h.status==="received").length;
      const routes=c.transport?.routes||[],activeRuns=routes.filter(r=>r.run?.id).length;
      const cases=(data.cases||[]).filter(x=>x.status!=="closed"),urgent=cases.filter(x=>["urgent","high"].includes(String(x.priority||"").toLowerCase())).length;
      const overdue=cases.filter(x=>x.follow_up_at&&Date.parse(x.follow_up_at)<Date.now()).length;
      const absences=(data.attendance||[]).filter(x=>x.status==="absent").length;
      const recon=Array.isArray(c.reconciliation)?c.reconciliation:[];
      const reconOpen=recon.filter(x=>!["complete","not_riding"].includes(x.reconciliation_status));
      const reconComplete=recon.filter(x=>x.reconciliation_status==="complete").length;
      const coverage=recon.length?Math.round((reconComplete/recon.length)*100):null;
      const schoolReadiness=[...recon.reduce((m,x)=>{const k=x.school_id||"school";const v=m.get(k)||{name:x.school_name||"School",assigned:0,complete:0,review:0,attendanceMissing:0};v.assigned++;if(x.reconciliation_status==="complete")v.complete++;if(!["complete","not_riding"].includes(x.reconciliation_status))v.review++;if(x.reconciliation_status==="missing_first_attendance")v.attendanceMissing++;m.set(k,v);return m;},new Map()).values()].sort((a,b)=>a.name.localeCompare(b.name));
      const issues=(data.errors.command||[]).length;
      return `<div class="api-card"><b>District operations overview</b><p class="api-muted">Authenticated, role-scoped snapshot from the records available to this account. Counts reflect returned records, not necessarily the entire district.</p>${issues?`<div class="api-notice" role="status">Some feeds could not be loaded: ${esc(issues)}. Use the linked workspaces to retry.</div>`:""}</div>
      <div class="api-grid"><div class="api-card"><b>${issues&&data.errors.command.includes("arrival")?"—":pending}</b><div>Arrivals awaiting receipt</div></div><div class="api-card"><b>${issues&&data.errors.command.includes("arrival")?"—":received}</b><div>Arrivals received</div></div><div class="api-card"><b>${issues&&data.errors.command.includes("transport")?"—":activeRuns}</b><div>Active transport runs</div></div><div class="api-card"><b>${issues&&data.errors.command.includes("staffing")?"—":c.teachers?.length||0}</b><div>Teacher accounts returned</div></div><div class="api-card"><b>${urgent}</b><div>High / urgent open cases</div></div><div class="api-card"><b>${overdue}</b><div>Overdue case follow-ups</div></div><div class="api-card"><b>${absences}</b><div>Absence events in loaded attendance</div></div><div class="api-card"><b>${issues&&data.errors.command.includes("reconciliation")?"—":(coverage===null?"—":coverage+"%")}</b><div>AM arrival reconciliation</div></div><div class="api-card"><b>${issues&&data.errors.command.includes("reconciliation")?"—":reconOpen.length}</b><div>AM riders needing review</div></div></div>
      <div class="api-card" style="margin-top:10px"><b>Priority queue</b><table class="api-table"><thead><tr><th>Area</th><th>Signal</th><th>Recommended next action</th><th>Workspace</th></tr></thead><tbody>
      ${pending?`<tr><td>Student arrival</td><td>${pending} pending handoff(s)</td><td>Confirm independent receipt before first attendance</td><td><button data-tab="arrival">Open arrival register</button></td></tr>`:""}
      ${urgent?`<tr><td>Student support</td><td>${urgent} high / urgent open case(s)</td><td>Review assigned support plans and next steps</td><td><button data-tab="cases">Open cases</button></td></tr>`:""}
      ${overdue?`<tr><td>Follow-up</td><td>${overdue} overdue case follow-up(s)</td><td>Review and update follow-up status</td><td><button data-tab="cases">Open cases</button></td></tr>`:""}
      ${activeRuns===0?`<tr><td>Transportation</td><td>No active route runs returned</td><td>Check assigned routes and run status</td><td><button data-tab="transport">Open transportation</button></td></tr>`:""}
      ${reconOpen.length?`<tr><td>AM arrival readiness</td><td>${reconOpen.length} assigned rider(s) need review</td><td>Resolve missing check-ins, handoffs, or first attendance</td><td><button data-tab="arrival-reconciliation">Open reconciliation</button></td></tr>`:""}
      ${!pending&&!urgent&&!overdue&&!reconOpen.length&&activeRuns>0?'<tr><td colspan="4">No priority signals in the currently loaded records.</td></tr>':""}</tbody></table></div>
      <div class="api-card" style="margin-top:10px"><b>Morning readiness</b><p class="api-muted">AM reconciliation coverage is calculated from assigned riders with a completed check-in, independently received school handoff, and first attendance. “Not riding” records are excluded from the completed count.</p><div class="api-grid"><div class="api-card"><b>${reconComplete}</b><div>Reconciled riders</div></div><div class="api-card"><b>${reconOpen.length}</b><div>Riders needing review</div></div><div class="api-card"><b>${coverage===null?"—":coverage+"%"}</b><div>Completion rate</div></div></div><button data-tab="arrival-reconciliation">Review route-by-route details</button></div>
      <div class="api-card" style="margin-top:10px"><b>School attendance accountability</b><p class="api-muted">School-level completion is calculated from assigned AM bus riders in the authenticated reconciliation feed. It is not a whole-school attendance census; car riders and walk-ins are not included in this denominator.</p><div class="api-scroll"><table class="api-table"><thead><tr><th>School</th><th>Assigned bus riders</th><th>Reconciled</th><th>Needs review</th><th>Missing first attendance</th><th>Coverage</th></tr></thead><tbody>${schoolReadiness.map(x=>`<tr><td>${esc(x.name)}</td><td>${x.assigned}</td><td>${x.complete}</td><td>${x.review}</td><td>${x.attendanceMissing}</td><td>${Math.round(x.complete/Math.max(1,x.assigned)*100)}%</td></tr>`).join("")||'<tr><td colspan="6">No school-level rider data is available for this school day.</td></tr>'}</tbody></table></div><button data-tab="arrival-reconciliation">Review student-level accountability</button></div>
      <div class="api-grid"><div class="api-card"><b>Attendance & arrivals</b><p>Review daily attendance and independently confirmed student handoffs.</p><button data-tab="attendance">Attendance</button> <button data-tab="arrival">Arrival register</button></div><div class="api-card"><b>Transportation</b><p>Review active route runs and operational status.</p><button data-tab="transport">Transportation</button></div><div class="api-card"><b>Student support</b><p>Review open cases, priority, and follow-up dates.</p><button data-tab="cases">Intervention cases</button></div></div>`;
    }
    if(tab==="notifications"){
      const result=ext.notifications?.data||{},items=Array.isArray(result.items)?result.items:[];
      return `<div class="api-grid"><div class="api-card"><b>${Number(result.unread||0)}</b><div>Unread notifications</div></div><div class="api-card"><b>${items.length}</b><div>Recent notifications</div></div></div>
      ${data.errors.notifications?`<div class="api-card" role="alert">${esc(data.errors.notifications)}</div>`:""}
      <div class="api-card"><b>Notifications</b><button type="button" data-action="notifications-read-all" ${items.some(x=>!x.read_at)?"":"disabled"}>Mark all as read</button><div class="api-scroll"><table class="api-table"><thead><tr><th>Notification</th><th>Details</th><th>Received</th><th>Status</th></tr></thead><tbody>${items.map(n=>`<tr><td>${esc(n.title)}</td><td>${esc(n.body||"Open EduOS to review this item.")}</td><td>${esc(fmtDate(n.created_at))}</td><td>${n.read_at?"Read":`<button data-action="notification-read" data-id="${esc(n.id)}">Mark read</button>`}</td></tr>`).join("")||'<tr><td colspan="4">No notifications yet.</td></tr>'}</tbody></table></div></div>`;
    }
    if(tab==="arrival-reconciliation"){
      const a=ext.arrival||{},items=Array.isArray(a.reconciliation)?a.reconciliation:[];
      const counts=items.reduce((m,x)=>(m[x.reconciliation_status]=(m[x.reconciliation_status]||0)+1,m),{});
      const labels={complete:"Complete",on_route:"On route",missing_route_checkin:"Missing route check-in",missing_school_handoff:"Missing school handoff",awaiting_school_receipt:"Awaiting school receipt",missing_first_attendance:"Missing first attendance",duplicate_arrival:"Duplicate arrival",not_riding:"Not riding",review_required:"Review required"};
      const rows=items.map(x=>`<tr><td>${esc(x.display_name)}<small>${esc(x.grade_level||"")}</small></td><td>${esc(x.route_name)} · ${esc(x.bus_label)}</td><td>${esc(x.checkin_event||"—")}</td><td>${esc(x.handoff_status||"—")}</td><td>${x.attendance_recorded?"Recorded":"Missing"}</td><td>${esc(labels[x.reconciliation_status]||x.reconciliation_status)}</td></tr>`).join("");
      return `<div class="api-grid"><div class="api-card"><b>${items.length}</b><div>Assigned AM riders</div></div><div class="api-card"><b>${counts.complete||0}</b><div>Fully reconciled</div></div><div class="api-card"><b>${(counts.missing_route_checkin||0)+(counts.missing_school_handoff||0)+(counts.awaiting_school_receipt||0)+(counts.missing_first_attendance||0)+(counts.duplicate_arrival||0)+(counts.review_required||0)}</b><div>Needs review</div></div></div>
      ${data.errors.arrivalReconciliation?`<div class="api-card" role="alert">${esc(data.errors.arrivalReconciliation)}</div>`:""}
      <div class="api-card"><b>Transportation-to-classroom reconciliation</b><p class="api-muted">Compares each active AM route assignment with its latest driver check-in, matching school handoff, and first attendance for the school-local day. This is an operational exception view, not a substitute for verified physical receipt.</p><div class="api-scroll"><table class="api-table"><thead><tr><th>Student</th><th>Route</th><th>Latest check-in</th><th>School handoff</th><th>Attendance</th><th>Reconciliation</th></tr></thead><tbody>${rows||'<tr><td colspan="6">No active AM route runs or assigned riders were found for this school day.</td></tr>'}</tbody></table></div></div>`;
    }
    if(tab==="arrival-exceptions"){
      const a=ext.arrival||{},items=Array.isArray(a.exceptions)?a.exceptions:[],managers=Array.isArray(a.managers)?a.managers:[];
      const rows=items.map(x=>{
        const r=x.resolution||{},label=x.kind==="handoff_awaiting_receipt"?"Awaiting teacher receipt":"First attendance missing";
        const options=managers.map(u=>`<option value="${esc(u.id||u.user_id)}" ${r.assigned_to===(u.id||u.user_id)?"selected":""}>${esc(u.display_name||u.name||u.email||"Staff member")}</option>`).join("");
        return `<tr><td>${esc(label)}<small>${esc(x.handoffId)}</small></td><td>${esc(x.severity)}</td><td>${Number(x.ageMinutes)} min</td><td>${esc(r.status||"open")}</td><td><form data-form="exception-assign" data-handoff="${esc(x.handoffId)}" data-kind="${esc(x.kind)}"><select name="assignedTo"><option value="">Unassigned</option>${options}</select><button type="submit">Assign</button></form></td><td>${r.status==="resolved"?"Resolved":`<button data-action="exception-ack" data-id="${esc(x.handoffId)}" data-kind="${esc(x.kind)}">Acknowledge</button> <button data-action="exception-resolve" data-id="${esc(x.handoffId)}" data-kind="${esc(x.kind)}">Resolve</button>`}<button data-action="exception-history" data-id="${esc(x.handoffId)}">History</button></td></tr>`;
      }).join("");
      return `<div class="api-grid"><div class="api-card"><b>${items.length}</b><div>Detected exceptions</div></div><div class="api-card"><b>${items.filter(x=>x.severity==="high").length}</b><div>High severity</div></div><div class="api-card"><b>${items.filter(x=>!x.resolution||x.resolution.status!=="resolved").length}</b><div>Unresolved</div></div></div>
      ${data.errors.arrivalExceptions?`<div class="api-card" role="alert">${esc(data.errors.arrivalExceptions)}</div>`:""}
      <div class="api-card"><b>Principal exception queue</b><p class="api-muted">Acknowledge ownership, assign a staff member, and resolve only after the underlying arrival or attendance issue is corrected. Resolution notes are required.</p><div class="api-scroll"><table class="api-table"><thead><tr><th>Exception</th><th>Severity</th><th>Age</th><th>Status</th><th>Assignee</th><th>Actions</th></tr></thead><tbody>${rows||'<tr><td colspan="6">No active arrival exceptions detected for this school day.</td></tr>'}</tbody></table></div></div>`;
    }
    if(tab==="arrival"){
      const a=ext.arrival||{},canCreate=role==="principal"||role==="driver",canReceive=role==="principal"||role==="teacher";
      const students=Array.isArray(a.students)?a.students:[],teachers=Array.isArray(a.teachers)?a.teachers:[];
      const routes=(Array.isArray(a.transport?.routes)?a.transport.routes:[]).filter(r=>r&&r.run&&r.run.id);
      const handoffs=Array.isArray(a.handoffs)?a.handoffs:[];
      const driverRiders=routes.flatMap(r=>(Array.isArray(r.stops)?r.stops:[]).flatMap(st=>Array.isArray(st.riders)?st.riders:[]).map(s=>({id:s.studentId,display_name:s.name,grade_level:s.grade,routeRunId:r.run.id}))).filter(s=>s.id);
      const studentPool=role==="driver"?driverRiders:students;
      const initialRunId=routes[0]?.run.id||"";
      const studentOpts=studentPool.map(s=>`<option value="${esc(s.id)}" ${role==="driver"?`data-route-run="${esc(s.routeRunId)}" ${s.routeRunId===initialRunId?"":"hidden disabled"}`:""}>${esc(s.display_name)} · ${esc(s.grade_level||"")}</option>`).join("");
      const teacherOpts=teachers.map(u=>`<option value="${esc(u.id||u.user_id)}">${esc(u.display_name||u.name||u.email)}</option>`).join("");
      const runOpts=routes.map(r=>`<option value="${esc(r.run.id)}">${esc(r.name||"Assigned route")} · ${esc(r.bus_label||"Bus")} · ${esc(r.school_name||"")}</option>`).join("");
      const createForm=canCreate?`<div class="api-card"><b>Record a verified arrival</b><form data-form="arrival-create" class="api-inline">
        <label>Student</label><select name="studentId" required ${role==="driver"?`data-arrival-rider-select`:""}>${studentOpts}</select>
        <label>Arrival method</label><select name="method" required>${role==="driver"?'<option value="bus">Bus</option>':'<option value="car_rider">Car rider</option><option value="walk_in">Walk-in</option>'}</select>
        ${role==="driver"?`<label>Assigned route run</label><select name="routeRunId" required data-arrival-run-select>${runOpts}</select>${routes.length?"":'<p>No active run found. Start today’s assigned run in Transportation before recording arrivals.</p>'}`:""}
        ${role==="principal"?`<label>Receiving teacher</label><select name="assignedTeacherUserId"><option value="">Assign later</option>${teacherOpts}</select>`:""}
        <label>Note (optional)</label><input name="note" maxlength="500" placeholder="Operational note">
        <button class="primary" type="submit">Save arrival to district records</button></form></div>`:"";
      const rows=handoffs.map(h=>`<tr><td>${esc(h.display_name)}<small>${esc(h.grade_level||"")}</small></td><td>${esc(h.method)}</td><td>${esc(h.status)}</td><td>${esc(fmtDate(h.initiated_at))}</td><td>${h.status==="pending"&&canReceive?`<button data-action="arrival-receive" data-id="${esc(h.id)}">Confirm receipt</button>`:"—"}</td><td>${h.status==="received"&&role==="teacher"?`<button data-action="arrival-attendance" data-id="${esc(h.id)}">First attendance: Present</button> <button data-action="arrival-tardy" data-id="${esc(h.id)}">Tardy</button>`:"—"}</td></tr>`).join("");
      return `<div class="api-grid"><div class="api-card"><b>${handoffs.filter(h=>h.status==="pending").length}</b><div>Awaiting independent receipt</div></div><div class="api-card"><b>${handoffs.filter(h=>h.status==="received").length}</b><div>Received by school staff</div></div><div class="api-card"><b>${handoffs.length}</b><div>Arrival records returned</div></div></div>
      ${data.errors.arrival?`<div class="api-card" role="alert">${esc(data.errors.arrival)}</div>`:""}
      ${createForm}<div class="api-card"><b>Authoritative arrival register</b><p>These records come from the authenticated district API, not browser storage. A different school staff member must confirm receipt before first attendance.</p><div style="overflow:auto"><table class="api-table"><thead><tr><th>Student</th><th>Method</th><th>Status</th><th>Recorded</th><th>Receipt</th><th>Attendance</th></tr></thead><tbody>${rows||'<tr><td colspan="6">No arrival records are available for this account.</td></tr>'}</tbody></table></div></div>`;
    }
    return "";
  }
  const post=(path,body,method="POST")=>API.request(path,{method,body:JSON.stringify(body)});
  async function submitExt(form,v){
    const kind=form.dataset.form,role=API.actor?.role;
    if(kind==="exception-assign"){
      const handoff=form.dataset.handoff,exceptionKind=form.dataset.kind;
      await post(`/api/arrival/exceptions/${encodeURIComponent(handoff)}/${encodeURIComponent(exceptionKind)}/assign`,{assignedTo:v.assignedTo||null});
      notify("Exception assignment saved.");await openTab("arrival-exceptions");return true;
    }
    if(kind==="arrival-create"){
      const body={studentId:v.studentId,method:v.method,note:v.note||null};
      if(v.routeRunId)body.routeRunId=v.routeRunId;
      if(v.assignedTeacherUserId)body.assignedTeacherUserId=v.assignedTeacherUserId;
      await post("/api/arrival/handoffs",body);notify("Arrival saved to district records.");await openTab("arrival");return true;
    }
    if(kind==="school-create"){await post("/api/schools",{name:v.name,schoolLevel:v.schoolLevel});notify("School created.");await loadAll();await openTab("admin");return true;}
    if(kind==="user-create"){const body={displayName:v.displayName,email:v.email,oidcSubject:v.oidcSubject,role:v.role,schoolId:role==="principal"?API.actor.schoolId:(v.schoolId||null)};await post("/api/users",body);notify(`${v.displayName} can now sign in as ${v.role}.`);await openTab("admin");return true;}
    if(kind==="membership-add"){await post(`/api/users/${encodeURIComponent(v.userId)}/memberships`,{role:v.role,schoolId:v.schoolId||null});notify("Role granted.");await openTab("admin");return true;}
    if(kind==="roster-add"){await post("/api/rosters",{teacherUserId:v.teacherUserId,studentId:v.studentId});notify("Student added to roster.");await openTab("rosters");return true;}
    if(kind==="invite-create"){const r=await post("/api/guardian-invitations",{studentId:v.studentId,email:v.email,relationship:v.relationship});ext.lastInviteUrl=new URL(r.invitationUrl,location.origin).href;notify("Invitation created. Copy the one-time link now.");await openTab("guardians");return true;}
    if(kind==="invite-accept"){await post("/api/guardian-invitations/accept",{token:String(v.token||"").trim()});try{sessionStorage.removeItem("eduos.guardianInvite")}catch{}notify("Invitation accepted. Your child's records are now linked.");activeTab="home";await loadAll();return true;}
    if(kind==="sis-import"){
      const read=f=>f&&f.size?f.text():Promise.resolve("");
      const studentsCsv=await read(form.elements.studentsFile.files[0]),attendanceCsv=await read(form.elements.attendanceFile.files[0]);
      if(!studentsCsv&&!attendanceCsv)throw new Error("Choose a students CSV, an attendance CSV, or both.");
      const body={schoolId:v.schoolId,sourceSystem:v.sourceSystem,sourceBatchId:v.sourceBatchId};if(studentsCsv)body.studentsCsv=studentsCsv;if(attendanceCsv)body.attendanceCsv=attendanceCsv;
      let r;try{r=await post("/api/integrations/sis/import-csv",body);}catch(e){ext.sisResult=null;throw e;}
      ext.sisResult=r?.data||r;notify("SIS import finished.");await loadAll();await openTab("sis");return true;
    }
    if(kind==="webhook-create"){const eventTypes=[...form.querySelectorAll('input[name="eventTypes"]:checked')].map(x=>x.value);const r=await post("/api/webhooks",{url:v.url,eventTypes});ext.webhookSecret=r.secret;ext.deliveries=null;notify("Webhook added. Copy the signing secret now.");await openTab("webhooks");return true;}
    return false;
  }
  async function actionExt(b){
    const id=b.dataset.id,a=b.dataset.action;
    if(a==="notification-read"||a==="notifications-read-all"){
      const ids=a==="notification-read"?[id]:undefined;
      await post("/api/notifications/read",ids?{ids}:{});
      notify("Notification status updated.");await openTab("notifications");return true;
    }
    if(a==="exception-ack"){await post(`/api/arrival/exceptions/${encodeURIComponent(id)}/${encodeURIComponent(b.dataset.kind)}/acknowledge`,{});notify("Exception acknowledged.");await openTab("arrival-exceptions");return true;}
    if(a==="exception-resolve"){const note=prompt("Describe the corrective action taken (required):");if(note===null)return true;await post(`/api/arrival/exceptions/${encodeURIComponent(id)}/${encodeURIComponent(b.dataset.kind)}/resolve`,{note});notify("Exception resolution saved.");await openTab("arrival-exceptions");return true;}
    if(a==="exception-history"){const r=await API.request(`/api/arrival/exceptions/${encodeURIComponent(id)}/history`);const lines=(r.data||[]).map(x=>`${fmtDate(x.occurred_at)} · ${x.event} · ${x.actor_user_id}`).join("\\n");alert(lines||"No resolution history recorded.");return true;}
    if(a==="arrival-receive"){await post(`/api/arrival/handoffs/${encodeURIComponent(id)}/receive`,{});notify("Independent staff receipt recorded.");await openTab("arrival");return true;}
    if(a==="arrival-attendance"||a==="arrival-tardy"){await post(`/api/arrival/handoffs/${encodeURIComponent(id)}/first-attendance`,{status:a==="arrival-tardy"?"tardy":"present"});notify("First attendance saved.");await openTab("arrival");return true;}
    if(a==="copy"){const t=el(b.dataset.target);if(t){t.select();try{await navigator.clipboard.writeText(t.value);notify("Copied.");}catch{document.execCommand("copy");}}return true;}
    if(a==="school-status"){await post(`/api/schools/${id}`,{status:b.dataset.status},"PATCH");notify("School updated.");await loadAll();await openTab("admin");return true;}
    if(a==="membership-status"){await post(`/api/memberships/${id}`,{status:b.dataset.status},"PATCH");notify(b.dataset.status==="active"?"Role enabled.":"Role disabled; it stops working immediately.");await openTab("admin");return true;}
    if(a==="user-status"){if(b.dataset.status==="disabled"&&!confirm("Disable this account? The person is signed out of EduOS immediately."))return true;await post(`/api/users/${id}`,{status:b.dataset.status},"PATCH");notify("Account updated.");await openTab("admin");return true;}
    if(a==="roster-remove"){await API.request(`/api/rosters/${b.dataset.teacher}/${id}`,{method:"DELETE"});notify("Removed from roster.");await openTab("rosters");return true;}
    if(a==="invite-revoke"){await post(`/api/guardian-invitations/${id}/revoke`,{});notify("Invitation revoked.");await openTab("guardians");return true;}
    if(a==="webhook-test"){const r=await post(`/api/webhooks/${id}/test`,{});notify(`Test delivery: ${r.outcome}${r.statusCode?` (HTTP ${r.statusCode})`:""}.`);await openTab("webhooks");return true;}
    if(a==="webhook-deliveries"){const r=await API.request(`/api/webhooks/${id}/deliveries`);ext.deliveries=r.data||[];render("webhooks");return true;}
    if(a==="webhook-disable"){if(!confirm("Disable this webhook?"))return true;await API.request(`/api/webhooks/${id}`,{method:"DELETE"});ext.webhookSecret=null;notify("Webhook disabled.");await openTab("webhooks");return true;}
    if(a==="assignment-status"){await post(`/api/assignments/${id}`,{status:b.dataset.status},"PATCH");notify(`Assignment ${b.dataset.status}.`);await loadAll();render("assignments");return true;}
    if(a==="records-export"){
      const r=await post(`/api/students/${id}/records-export`,{});
      const blob=new Blob([JSON.stringify(r,null,2)],{type:"application/json"}),link=document.createElement("a");
      link.href=URL.createObjectURL(blob);link.download=`education-record-${r?.student?.local_student_number||id}.json`;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(link.href),5000);
      notify("Education record exported (audited).");return true;
    }
    if(a==="records-delete"){
      const number=prompt(`Permanently delete this student's education record?\nType the local student number (${b.dataset.number}) to confirm:`);if(number===null)return true;
      const reason=prompt("Reason for deletion (20–1,000 characters, recorded in the audit log):");if(reason===null)return true;
      const r=await post(`/api/students/${id}/records-delete`,{confirmLocalStudentNumber:number,reason});
      notify(`Record deleted (${Object.values(r.counts||{}).reduce((s,n)=>s+Number(n||0),0)} rows).`);const p=el("api-profile");if(p)p.remove();await loadAll();return true;
    }
    return false;
  }
  window.EduOSApi=Object.freeze({
    refresh:loadAll,logAgentRun,
    get actor(){return API.actor?{...API.actor}:null},
    async familyChildren(){
      if(API.actor?.role!=="parent")throw new Error("A signed-in parent or guardian account is required.");
      return API.request("/api/family/children");
    },
    async familyChildSummary(studentId){
      if(API.actor?.role!=="parent")throw new Error("A signed-in parent or guardian account is required.");
      if(typeof studentId!=="string"||!/^[0-9a-f-]{36}$/i.test(studentId))throw new Error("Invalid learner selection.");
      return API.request(`/api/family/children/${encodeURIComponent(studentId)}/summary`);
    },
    async familyContacts(studentId){
      if(!["parent","teacher","principal","superintendent"].includes(API.actor?.role))throw new Error("Family contacts are not available for this account.");
      return API.request(`/api/family/contacts?studentId=${encodeURIComponent(studentId)}`);
    },
    async directoryStudents(){
      if(!["teacher","principal","superintendent"].includes(API.actor?.role))throw new Error("Staff account required.");
      return API.request("/api/students");
    },
    async familyMessages(studentId){
      if(!["parent","teacher","principal","superintendent"].includes(API.actor?.role))throw new Error("Family messaging is not available for this account.");
      return API.request(`/api/family/messages?studentId=${encodeURIComponent(studentId)}`);
    },
    async sendFamilyMessage(payload){
      if(!["parent","teacher","principal","superintendent"].includes(API.actor?.role))throw new Error("Family messaging is not available for this account.");
      return API.request("/api/family/messages",{method:"POST",body:JSON.stringify(payload)});
    },
    async saveClassroomPreference(payload){
      if(!["teacher","principal"].includes(API.actor?.role))throw new Error("A teacher or principal account is required.");
      return API.request("/api/teacher/classroom-preferences",{method:"PUT",body:JSON.stringify(payload)});
    },
    async loadClassroomPreferences(){
      if(!["teacher","principal"].includes(API.actor?.role))throw new Error("A teacher or principal account is required.");
      return API.request("/api/teacher/classroom-preferences");
    }
    ,async createGuardianInvitation(payload){
      if(!["principal","superintendent"].includes(API.actor?.role))throw new Error("A principal or superintendent account is required.");
      return API.request("/api/guardian-invitations",{method:"POST",body:JSON.stringify(payload)});
    },
    async guardianInvitations(){
      if(!["principal","superintendent"].includes(API.actor?.role))throw new Error("A principal or superintendent account is required.");
      return API.request("/api/guardian-invitations");
    },
    async acceptGuardianInvitation(token){
      if(API.actor?.role!=="parent")throw new Error("Sign in with your pre-provisioned parent account first.");
      return API.request("/api/guardian-invitations/accept",{method:"POST",body:JSON.stringify({token})});
    },
    async revokeGuardianInvitation(invitationId){
      if(!["principal","superintendent"].includes(API.actor?.role))throw new Error("A principal or superintendent account is required.");
      return API.request(`/api/guardian-invitations/${encodeURIComponent(invitationId)}/revoke`,{method:"POST",body:JSON.stringify({})});
    },
    // Cross-profile flow events and signed outbound webhooks (Phase 32.0.44).
    async publishFlowEvent(event){
      if(!["principal","teacher"].includes(API.actor?.role))throw new Error("A signed-in principal or teacher account is required.");
      return API.request("/api/flow-events",{method:"POST",body:JSON.stringify(event)});
    },
    async flowEvents(){
      if(!API.actor)throw new Error("Sign in to load recorded flow events.");
      return API.request("/api/flow-events");
    },
    async webhooks(){
      if(!["superintendent","it_admin"].includes(API.actor?.role))throw new Error("A superintendent or district IT administrator account is required.");
      return API.request("/api/webhooks");
    },
    async createWebhook(payload){
      if(!["superintendent","it_admin"].includes(API.actor?.role))throw new Error("A superintendent or district IT administrator account is required.");
      return API.request("/api/webhooks",{method:"POST",body:JSON.stringify(payload)});
    },
    async disableWebhook(webhookId){
      if(!["superintendent","it_admin"].includes(API.actor?.role))throw new Error("A superintendent or district IT administrator account is required.");
      if(typeof webhookId!=="string"||!/^[0-9a-f-]{36}$/i.test(webhookId))throw new Error("Invalid webhook selection.");
      return API.request(`/api/webhooks/${encodeURIComponent(webhookId)}`,{method:"DELETE"});
    },
    async testWebhook(webhookId){
      if(!["superintendent","it_admin"].includes(API.actor?.role))throw new Error("A superintendent or district IT administrator account is required.");
      if(typeof webhookId!=="string"||!/^[0-9a-f-]{36}$/i.test(webhookId))throw new Error("Invalid webhook selection.");
      return API.request(`/api/webhooks/${encodeURIComponent(webhookId)}/test`,{method:"POST",body:JSON.stringify({})});
    }
  });
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount,{once:true});else mount();
})();
