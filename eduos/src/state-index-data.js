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

const ed = (code, agency) => ({ category: "agency", title: `U.S. Department of Education: ${STATE_NAME[code]} contacts`,
  url: `https://www.ed.gov/about/contact-us/state-contacts/${code.toLowerCase()}`,
  description: `Lists the state education agency (${agency}) and related state offices.`,
  source: `https://www.ed.gov/about/contact-us/state-contacts/${code.toLowerCase()}`, checked: "2026-11-22" });

// State entries checked so far.
export const ENTRIES = {
  CA: [ed("CA", "California Department of Education")],
  DE: [ed("DE", "Delaware Department of Education")],
  DC: [ed("DC", "Office of the State Superintendent of Education")],
  LA: [ed("LA", "Louisiana Department of Education")],
  MA: [ed("MA", "Massachusetts Department of Elementary and Secondary Education")],
  MN: [ed("MN", "Minnesota Department of Education")],
  MS: [ed("MS", "Mississippi Department of Education")],
  NE: [ed("NE", "Nebraska Department of Education")],
  NH: [ed("NH", "New Hampshire Department of Education")],
  NY: [ed("NY", "New York State Education Department")],
  OH: [ed("OH", "Ohio Department of Education")],
  TX: [ed("TX", "Texas Education Agency")],
  WA: [ed("WA", "Office of Superintendent of Public Instruction")]
};

/** The curated index for one state: its own checked entries plus the national directories. */
export function curatedFor(code) {
  return [...(ENTRIES[code] || []).map(e => ({ ...e, scope: "state" })), ...NATIONAL.map(e => ({ ...e, scope: "national" }))];
}
