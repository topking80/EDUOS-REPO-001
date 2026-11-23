// STATE-01: the curated state index. Every link here was checked against its
// source on the date given; nothing is filled in from memory. Where a state
// has no checked link yet for a category, the index says so, and a district
// adds its own entry (with a source) in the app (db/107).
//
// Categories:
//   licensing  the state's educator license lookup and registration/renewal
//   athletics  the state high school athletic/activities association
//   agency     the state education agency and its school data (report cards,
//              assessments, graduation and accountability)
//   records    the state's rules on student record retention, transfer, privacy
//
// To add entries: put the link, the page it was confirmed on (source) and the
// date checked. Keep it to official sources (the state, its association, or a
// federal page about the state).

export const CATEGORIES = { licensing: "Educator licensing", athletics: "Athletics", agency: "Education agency & school data", records: "Student records rules" };

// 50 states and the District of Columbia.
export const JURISDICTIONS = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"],
  ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"],
  ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"],
  ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"],
  ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"]
];
export const STATE_NAME = Object.fromEntries(JURISDICTIONS);

// National directories that apply to every state.
export const NATIONAL = [
  { category: "athletics", title: "NFHS: the national federation of state high school associations",
    url: "https://nfhs.org/about", description: "51 member state associations (the 50 states and Washington, D.C.), one per state; find your state's association here.",
    source: "https://nfhs.org/about", checked: "2026-11-22" }
];

// State agency: the U.S. Department of Education's contact page for each
// state, which names the state education agency and related offices. Each
// page was opened and confirmed on the date given (ME and WV could not be
// read on 2026-11-23 and are left out until they are).
const ed = (code, checked) => ({ category: "agency", title: `U.S. Department of Education: ${STATE_NAME[code]} contacts`,
  url: `https://www.ed.gov/about/contact-us/state-contacts/${code.toLowerCase()}`,
  description: "Names the state education agency and related state offices, with addresses and phone numbers.",
  source: `https://www.ed.gov/about/contact-us/state-contacts/${code.toLowerCase()}`, checked });

// Athletics: each state's NFHS member association and its website, as printed
// in the NFHS Handbook 2026-27 directory of member state associations. The
// District of Columbia's entry there gives no website.
const NFHS_HANDBOOK = "https://assets.nfhs.org/storyblok/f/1022696/x/54e2358c8d/2026-27-nfhs-handbook.pdf";
const assoc = (title, url) => ({ category: "athletics", title, url, description: "The state's NFHS member high school athletic/activities association.", source: NFHS_HANDBOOK, checked: "2026-11-23" });
const AGENCY_CHECKED = { AL: "2026-11-23", AK: "2026-11-23", AZ: "2026-11-23", AR: "2026-11-23", CA: "2026-11-22", CO: "2026-11-23", CT: "2026-11-23", DE: "2026-11-22", DC: "2026-11-22", FL: "2026-11-23", GA: "2026-11-23", HI: "2026-11-23", ID: "2026-11-23", IL: "2026-11-23", IN: "2026-11-23", IA: "2026-11-23", KS: "2026-11-23", KY: "2026-11-23", LA: "2026-11-22", MD: "2026-11-23", MA: "2026-11-22", MI: "2026-11-23", MN: "2026-11-22", MS: "2026-11-22", MO: "2026-11-23", MT: "2026-11-23", NE: "2026-11-22", NV: "2026-11-23", NH: "2026-11-22", NJ: "2026-11-23", NM: "2026-11-23", NY: "2026-11-22", NC: "2026-11-23", ND: "2026-11-23", OH: "2026-11-22", OK: "2026-11-23", OR: "2026-11-23", PA: "2026-11-23", RI: "2026-11-23", SC: "2026-11-23", SD: "2026-11-23", TN: "2026-11-23", TX: "2026-11-22", UT: "2026-11-23", VT: "2026-11-23", VA: "2026-11-23", WA: "2026-11-22", WI: "2026-11-23", WY: "2026-11-23" };
const ATHLETICS = {
  AL: ["Alabama High School Athletic Association", "https://www.ahsaa.com/"],
  AK: ["Alaska School Activities Association", "https://www.asaa.org/"],
  AZ: ["Arizona Interscholastic Association", "https://www.aiaonline.org/"],
  AR: ["Arkansas Activities Association", "https://www.ahsaa.org/"],
  CA: ["California Interscholastic Federation", "https://www.cifstate.org/"],
  CO: ["Colorado High School Activities Association", "https://www.chsaanow.com/"],
  CT: ["Connecticut Interscholastic Athletic Conference", "https://www.casciac.org/"],
  DE: ["Delaware Interscholastic Athletic Association", "https://education.delaware.gov/diaa/"],
  FL: ["Florida High School Athletic Association", "https://www.fhsaa.com/"],
  GA: ["Georgia High School Association", "https://www.ghsa.net/"],
  HI: ["Hawaii High School Athletic Association", "https://www.hhsaa.org/"],
  ID: ["Idaho High School Activities Association", "https://www.idhsaa.org/"],
  IL: ["Illinois High School Association", "https://www.ihsa.org/"],
  IN: ["Indiana High School Athletic Association", "https://www.ihsaa.org/"],
  IA: ["Iowa High School Athletic Association", "https://www.iahsaa.org/"],
  KS: ["Kansas State High School Activities Association", "https://www.kshsaa.org/"],
  KY: ["Kentucky High School Athletic Association", "https://www.khsaa.org/"],
  LA: ["Louisiana High School Athletic Association", "https://www.lhsaa.org/"],
  ME: ["Maine Principals' Association", "https://www.mpa.cc/"],
  MD: ["Maryland Public Secondary Schools Athletic Association", "https://www.mpssaa.org/"],
  MA: ["Massachusetts Interscholastic Athletic Association", "https://www.miaa.net/"],
  MI: ["Michigan High School Athletic Association", "https://www.mhsaa.com/"],
  MN: ["Minnesota State High School League", "https://www.mshsl.org/"],
  MS: ["Mississippi High School Activities Association", "https://misshsaa.com/"],
  MO: ["Missouri State High School Activities Association", "https://www.mshsaa.org/"],
  MT: ["Montana High School Association", "https://www.mhsa.org/"],
  NE: ["Nebraska School Activities Association", "https://www.nsaahome.org/"],
  NV: ["Nevada Interscholastic Activities Association", "https://www.niaa.com/"],
  NH: ["New Hampshire Interscholastic Athletic Association", "https://www.nhiaa.org/"],
  NJ: ["New Jersey State Interscholastic Athletic Association", "https://www.njsiaa.org/"],
  NM: ["New Mexico Activities Association", "https://www.nmact.org/"],
  NY: ["New York State Public High School Athletic Association", "https://www.nysphsaa.org/"],
  NC: ["North Carolina High School Athletic Association", "https://www.nchsaa.org/"],
  ND: ["North Dakota High School Activities Association", "https://www.ndhsaa.com/"],
  OH: ["Ohio High School Athletic Association", "https://www.ohsaa.org/"],
  OK: ["Oklahoma Secondary School Activities Association", "https://www.ossaa.com/"],
  OR: ["Oregon School Activities Association", "https://www.osaa.org/"],
  PA: ["Pennsylvania Interscholastic Athletic Association", "https://www.piaa.org/"],
  RI: ["Rhode Island Interscholastic League", "https://www.riil.org/"],
  SC: ["South Carolina High School League", "https://www.schsl.org/"],
  SD: ["South Dakota High School Activities Association", "https://www.sdhsaa.com/"],
  TN: ["Tennessee Secondary School Athletic Association", "https://www.tssaa.org/"],
  TX: ["University Interscholastic League", "https://www.uiltexas.org/"],
  UT: ["Utah High School Activities Association", "https://www.uhsaa.org/"],
  VT: ["Vermont Principals' Association", "https://www.vpaonline.org/"],
  VA: ["Virginia High School League", "https://www.vhsl.org/"],
  WA: ["Washington Interscholastic Activities Association", "https://www.wiaa.com/"],
  WV: ["West Virginia Secondary School Activities Commission", "https://www.wvssac.org/"],
  WI: ["Wisconsin Interscholastic Athletic Association", "https://www.wiaawi.org/"],
  WY: ["Wyoming High School Activities Association", "https://www.whsaa.org/"]
};

export const ENTRIES = Object.fromEntries(JURISDICTIONS.map(([code]) => [code, [
  ...(AGENCY_CHECKED[code] ? [ed(code, AGENCY_CHECKED[code])] : []),
  ...(ATHLETICS[code] ? [assoc(...ATHLETICS[code])] : [])]]));

/** The curated index for one state: its own checked entries plus the national directories. */
export function curatedFor(code) {
  return [...(ENTRIES[code] || []).map(e => ({ ...e, scope: "state" })), ...NATIONAL.map(e => ({ ...e, scope: "national" }))];
}
