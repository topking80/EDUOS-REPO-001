// Event handling for the district interface (public/index.html, legacy-app.js)
// without inline handlers, so the Content Security Policy can forbid inline
// script ('unsafe-inline' removed from script-src and script-src-attr).
//
// Markup says what to call, e.g.
//   <button data-on-click="showSchool('abc')">   <select data-on-change="selectInfraSchool(this.value)">
// One document-level listener per event type finds the nearest element with
// data-on-<type>, parses the calls (no eval) and runs them. Only the handlers
// listed in HANDLERS can be called, and arguments can only be literals
// ('text', numbers, true/false/null) or this, this.value, this.checked, event.
// Anything else is refused and logged.
(function () {
  "use strict";
  // Looked up when called, so handlers defined by later scripts work too.
  const HANDLERS = {
    addBuildRoom: (...a) => addBuildRoom(...a),
    addSchool: (...a) => addSchool(...a),
    addSection: (...a) => addSection(...a),
    arrivalCheckIn: (...a) => arrivalCheckIn(...a),
    arrivalHandoff: (...a) => arrivalHandoff(...a),
    askDistrict: (...a) => askDistrict(...a),
    assignArrivalTeacher: (...a) => assignArrivalTeacher(...a),
    clearDistrictLookup: (...a) => clearDistrictLookup(...a),
    closeModal: (...a) => closeModal(...a),
    downloadProposal: (...a) => downloadProposal(...a),
    ecpChooseRoom: (...a) => ecpChooseRoom(...a),
    ecpEmergencyInfo: (...a) => ecpEmergencyInfo(...a),
    ecpExport: (...a) => ecpExport(...a),
    ecpFloorChanged: (...a) => ecpFloorChanged(...a),
    ecpImport: (...a) => ecpImport(...a),
    ecpOpenImport: (...a) => ecpOpenImport(...a),
    ecpRender: (...a) => ecpRender(...a),
    ecpRoomChanged: (...a) => ecpRoomChanged(...a),
    ecpSave: (...a) => ecpSave(...a),
    ecpSetLayout: (...a) => ecpSetLayout(...a),
    eduosSelectEnvironment: (...a) => eduosSelectEnvironment(...a),
    enrollPupil: (...a) => enrollPupil(...a),
    exportBlueprint: (...a) => exportBlueprint(...a),
    exportBuildSpec: (...a) => exportBuildSpec(...a),
    exportCostPlan: (...a) => exportCostPlan(...a),
    exportData: (...a) => exportData(...a),
    exportInfrastructure: (...a) => exportInfrastructure(...a),
    exportNcesSnapshot: (...a) => exportNcesSnapshot(...a),
    exportPhase14Budget: (...a) => exportPhase14Budget(...a),
    familyMessagesSend: (...a) => familyMessagesSend(...a),
    filterDistrictProfiles: (...a) => filterDistrictProfiles(...a),
    filterSchools: (...a) => filterSchools(...a),
    filterServiceCases: (...a) => filterServiceCases(...a),
    flowWebhookCreate: (...a) => flowWebhookCreate(...a),
    flowWebhookDisable: (...a) => flowWebhookDisable(...a),
    flowWebhookTest: (...a) => flowWebhookTest(...a),
    go: (...a) => go(...a),
    hireTeacher: (...a) => hireTeacher(...a),
    importNcesSnapshot: (...a) => importNcesSnapshot(...a),
    loadDistrictPreset: (...a) => loadDistrictPreset(...a),
    openAddSchool: (...a) => openAddSchool(...a),
    openDepartment: (...a) => openDepartment(...a),
    openSchoolDetail: (...a) => openSchoolDetail(...a),
    parentPortalExport: (...a) => parentPortalExport(...a),
    parentPortalSendMessage: (...a) => parentPortalSendMessage(...a),
    printPage: (...a) => printPage(...a),
    recalculateCosts: (...a) => recalculateCosts(...a),
    removeBuildRoom: (...a) => removeBuildRoom(...a),
    removeTeacher: (...a) => removeTeacher(...a),
    resetDemo: (...a) => resetDemo(...a),
    resetPlanner: (...a) => resetPlanner(...a),
    runAgent: (...a) => runAgent(...a),
    saveBuildNotes: (...a) => saveBuildNotes(...a),
    saveInfraInputs: (...a) => saveInfraInputs(...a),
    savePhase14Budget: (...a) => savePhase14Budget(...a),
    selectBuildSpecSchool: (...a) => selectBuildSpecSchool(...a),
    selectEnrollSection: (...a) => selectEnrollSection(...a),
    selectInfraSchool: (...a) => selectInfraSchool(...a),
    showSchool: (...a) => showSchool(...a),
    teacherFirstAttendance: (...a) => teacherFirstAttendance(...a),
    toast: (...a) => toast(...a),
    unenrollPupil: (...a) => unenrollPupil(...a),
    updatePlanner: (...a) => updatePlanner(...a)
  };

  /** Parses "fn('a', 2, this); other(event)" into [{name, args:[tokens]}], or throws. */
  function parse(src) {
    const calls = [];
    let i = 0;
    const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
    const ident = () => { const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i)); if (!m) throw new Error("name expected"); i += m[0].length; return m[0]; };
    const arg = () => {
      ws();
      const c = src[i];
      if (c === "'" || c === '"') {
        let out = ""; i++;
        while (i < src.length && src[i] !== c) {
          if (src[i] === "\\") { i++; if (i >= src.length) break; }
          out += src[i++];
        }
        if (src[i] !== c) throw new Error("unterminated string");
        i++; return { lit: out };
      }
      const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
      if (num) { i += num[0].length; return { lit: Number(num[0]) }; }
      const word = /^(this\.value|this\.checked|this|event|true|false|null)\b/.exec(src.slice(i));
      if (!word) throw new Error("argument not allowed");
      i += word[0].length;
      return ({ "true": { lit: true }, "false": { lit: false }, "null": { lit: null } })[word[0]] || { ref: word[0] };
    };
    for (;;) {
      ws();
      if (i >= src.length) break;
      const name = ident(); ws();
      if (src[i++] !== "(") throw new Error("( expected");
      const args = []; ws();
      if (src[i] === ")") i++;
      else for (;;) { args.push(arg()); ws(); const sep = src[i++]; if (sep === ")") break; if (sep !== ",") throw new Error(", or ) expected"); }
      calls.push({ name, args }); ws();
      if (i < src.length && src[i++] !== ";") throw new Error("; expected");
    }
    return calls;
  }

  function run(el, src, event) {
    let calls;
    try { calls = parse(src); } catch (e) { console.warn("EduOS: refused handler", JSON.stringify(src), e.message); return; }
    for (const { name, args } of calls) {
      const fn = Object.prototype.hasOwnProperty.call(HANDLERS, name) ? HANDLERS[name] : null;
      if (!fn) { console.warn("EduOS: unknown handler", name); return; }
      const values = args.map(a => "lit" in a ? a.lit : a.ref === "this" ? el : a.ref === "this.value" ? el.value : a.ref === "this.checked" ? el.checked : event);
      fn.apply(el, values);
    }
  }

  for (const type of ["click", "change", "input", "submit"]) {
    document.addEventListener(type, (event) => {
      const el = event.target instanceof Element ? event.target.closest(`[data-on-${type}]`) : null;
      if (el) run(el, el.getAttribute(`data-on-${type}`), event);
    });
  }
  window.EduosLegacyEvents = { parse, handlers: Object.keys(HANDLERS) };
})();
