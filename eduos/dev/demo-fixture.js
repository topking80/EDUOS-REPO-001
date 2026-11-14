// Synthetic demo district for local evaluation (32.1.0). Every name, number
// and address here is fictional. Used by dev/seed-demo.js (database rows) and
// dev/dev-idp.js (the sign-in picker), so both always agree.
// Fixed UUIDs keep the seed idempotent and the smoke test deterministic.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const DEMO_DOMAIN = "riverside-usd.example";
export const DISTRICT = { id: id(1), name: "Riverside Unified School District (demo)" };

export const SCHOOLS = {
  elementary: { id: id(101), name: "Riverside Elementary", level: "elementary" },
  middle: { id: id(102), name: "Lincoln Middle School", level: "middle" }
};

// role: superintendent | it_admin | principal | teacher | parent | pupil | driver
export const USERS = {
  superintendent: { id: id(201), sub: "demo-superintendent", name: "Dr. Maya Chen", role: "superintendent", school: null },
  deputy: { id: id(202), sub: "demo-deputy-superintendent", name: "Samuel Okafor", role: "superintendent", school: null,
    note: "Second superintendent (access requests are approved by a different superintendent)" },
  principal: { id: id(203), sub: "demo-principal", name: "Elena Ruiz", role: "principal", school: "elementary" },
  principalMiddle: { id: id(204), sub: "demo-principal-middle", name: "Marcus Bell", role: "principal", school: "middle" },
  teacher: { id: id(205), sub: "demo-teacher", name: "Jordan Lee", role: "teacher", school: "elementary" },
  teacher2: { id: id(206), sub: "demo-teacher-2", name: "Priya Natarajan", role: "teacher", school: "elementary" },
  parent: { id: id(207), sub: "demo-parent", name: "Alex Morgan", role: "parent", school: "elementary",
    note: "Linked guardian of Ava Morgan" },
  parentInvitee: { id: id(208), sub: "demo-parent-invitee", name: "Taylor Brooks", role: "parent", school: "elementary",
    note: "Provisioned but not yet linked: use for the guardian invitation flow" },
  pupil: { id: id(209), sub: "demo-student", name: "Ava Morgan", role: "pupil", school: "elementary" },
  // 32.2.0
  itAdmin: { id: id(210), sub: "demo-it-admin", name: "Jamie Rivera", role: "it_admin", school: null,
    note: "District IT: apps, accounts, SIS and integrations; no student records" },
  pupilYoung: { id: id(211), sub: "demo-student-young", name: "Leo Park", role: "pupil", school: "elementary",
    note: "Grade 1 learner: simplified student home" },
  // 32.4.0
  driver: { id: id(212), sub: "demo-driver", name: "Dana Whitfield", role: "driver", school: "elementary",
    note: "Bus driver: route, stop list and ON BOARD check-in (no location tracking)" }
};
for (const u of Object.values(USERS)) u.email = `${u.sub.replace(/^demo-/, "")}@${DEMO_DOMAIN}`;

export const STUDENTS = {
  ava: { id: id(301), number: "RES-1001", name: "Ava Morgan", grade: "4", school: "elementary" },
  noah: { id: id(302), number: "RES-1002", name: "Noah Brooks", grade: "4", school: "elementary" },
  liam: { id: id(303), number: "RES-1003", name: "Liam Patel", grade: "4", school: "elementary" },
  sofia: { id: id(304), number: "RES-1004", name: "Sofia Garcia", grade: "4", school: "elementary" },
  mia: { id: id(305), number: "RES-1005", name: "Mia Johnson", grade: "3", school: "elementary" },
  ethan: { id: id(306), number: "RES-1006", name: "Ethan Kim", grade: "3", school: "elementary" },
  olivia: { id: id(307), number: "LMS-2001", name: "Olivia Chen", grade: "7", school: "middle" },
  lucas: { id: id(308), number: "LMS-2002", name: "Lucas Wright", grade: "8", school: "middle" },
  leo: { id: id(309), number: "RES-1007", name: "Leo Park", grade: "1", school: "elementary" }
};

// Jordan Lee teaches the four grade-4 learners; Priya Natarajan the grade-3 pair.
export const ROSTERS = [
  ["teacher", "ava"], ["teacher", "noah"], ["teacher", "liam"], ["teacher", "sofia"],
  ["teacher2", "mia"], ["teacher2", "ethan"]
];
export const LINKS = [["parent", "ava", "parent"], ["pupil", "ava", "pupil"], ["pupilYoung", "leo", "pupil"]];

// 32.2.0 district resource mesh: apps bought once and shared across schools.
// Launch URLs use the reserved .example domain; the LTI app needs the local
// dev tool (node dev/lti-tool.js) and LTI_PLATFORM_PRIVATE_KEY (dev-up sets it).
export const LTI_TOOL_ORIGIN = "http://localhost:5199";
export const APPS = [
  { id: id(501), name: "Riverside Reading Room", vendor: "Open Shelf Learning", category: "Reading", owner: null, type: "link",
    url: "https://reading-room.example/riverside", scope: "roster_basic", dpa: "sdpc_signed", dpaEnds: "2028-06-30", coppa: true, ferpa: true,
    description: "Leveled e-books and read-aloud for every grade.",
    licenses: [{ seats: null, starts: "2026-07-01", ends: "2028-06-30" }], assign: [{ scope: "district", roles: ["principal", "teacher", "parent", "pupil"] }] },
  { id: id(502), name: "MathQuest", vendor: "Quest Labs", category: "Math", owner: null, type: "oidc_sso",
    url: "https://mathquest.example/district/riverside", scope: "identity", dpa: "signed", dpaEnds: "2027-06-30", coppa: true, ferpa: true,
    description: "Adaptive math practice for grades K–5. Signs in with your district account.",
    licenses: [{ seats: 500, starts: "2026-07-01", ends: "2027-06-30" }], assign: [{ scope: "district", grades: ["K", "1", "2", "3", "4", "5"], roles: ["teacher", "pupil", "principal"] }] },
  { id: id(503), name: "Lincoln Lab Notebook", vendor: "Bench Science Co.", category: "Science", owner: "middle", type: "link",
    url: "https://lab-notebook.example/lincoln", scope: "none", dpa: "none", coppa: false, ferpa: false,
    description: "Bought by Lincoln Middle School and shared with Riverside Elementary teachers.",
    licenses: [{ seats: 120, starts: "2026-08-15", ends: "2027-08-14", school: "middle" }],
    assign: [{ scope: "school", school: "middle", roles: ["principal", "teacher", "pupil"] }, { scope: "school", school: "elementary", roles: ["teacher"], sharedBy: "middle" }] },
  { id: id(504), name: "Science Lab (LTI demo)", vendor: "EduOS dev tool", category: "Science", owner: null, type: "lti13",
    url: `${LTI_TOOL_ORIGIN}/launch`, scope: "none", dpa: "none", coppa: true, ferpa: false,
    description: "LTI 1.3 launch demo. Start the local tool with: node dev/lti-tool.js",
    config: { clientId: "eduos-demo-tool", deploymentId: "riverside-1", loginUrl: `${LTI_TOOL_ORIGIN}/login`, redirectUris: [`${LTI_TOOL_ORIGIN}/launch`] },
    licenses: [{ seats: null, starts: "2026-07-01", ends: null }], assign: [{ scope: "district", roles: ["principal", "teacher", "pupil"] }] }
];
export const APP_REQUESTS = [
  { id: id(601), school: "elementary", by: "principal", name: "Phonics Plus", vendor: "Sound Start", url: "https://phonics.example", reason: "Our K–2 teachers want a structured phonics program." }
];

export const ASSIGNMENTS = [
  { id: id(401), by: "teacher", school: "elementary", status: "published", title: "Fractions practice set",
    instructions: "Complete problems 1-12 on equivalent fractions. Show your work.", dueInDays: 5 },
  { id: id(402), by: "teacher", school: "elementary", status: "published", title: "Reading log: week 3",
    instructions: "Read for 20 minutes each night and record the title and pages.", dueInDays: 2 },
  { id: id(403), by: "teacher", school: "elementary", status: "draft", title: "Science fair proposal (draft)",
    instructions: "One paragraph: your question, your hypothesis and the materials you need.", dueInDays: 14 }
];

// Fixed id range for demo accounts; anything outside it is operator-created.
export const isDemoId = value => /^00000000-0000-4000-8000-0000000[0-9]{5}$/.test(String(value));

export function demoAccounts() {
  return Object.values(USERS).map(u => ({
    sub: u.sub, name: u.name, email: u.email, role: u.role,
    school: u.school ? SCHOOLS[u.school].name : "District office", note: u.note || ""
  }));
}

// 32.3.0 school branding. The mascots are ORIGINAL drawings made for this demo
// from simple shapes (no third-party logos or artwork).
export const MASCOT_SVGS = {
  otter: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
<title>Riverside Otter (original EduOS demo mascot)</title>
<defs><clipPath id="disc"><circle cx="128" cy="128" r="124"/></clipPath></defs>
<g clip-path="url(#disc)">
<rect width="256" height="256" fill="#1b4f8a"/>
<path d="M0 200 Q32 182 64 200 T128 200 T192 200 T256 200 V256 H0 Z" fill="#0f7c80"/>
<path d="M0 222 Q32 206 64 222 T128 222 T192 222 T256 222" fill="none" stroke="#9fd8da" stroke-width="5"/>
<circle cx="62" cy="100" r="15" fill="#7a4a2a"/><circle cx="194" cy="100" r="15" fill="#7a4a2a"/>
<circle cx="62" cy="100" r="7" fill="#d3a77c"/><circle cx="194" cy="100" r="7" fill="#d3a77c"/>
<ellipse cx="128" cy="136" rx="78" ry="64" fill="#8b5a33"/>
<ellipse cx="128" cy="164" rx="52" ry="38" fill="#efd8b6"/>
<circle cx="97" cy="120" r="11" fill="#1a1a1a"/><circle cx="159" cy="120" r="11" fill="#1a1a1a"/>
<circle cx="100" cy="116" r="3.5" fill="#ffffff"/><circle cx="162" cy="116" r="3.5" fill="#ffffff"/>
<ellipse cx="128" cy="150" rx="16" ry="11" fill="#2b1a10"/>
<path d="M128 160 V170 M128 170 Q118 180 108 172 M128 170 Q138 180 148 172" fill="none" stroke="#2b1a10" stroke-width="4" stroke-linecap="round"/>
<path d="M86 162 H50 M86 172 L52 182 M170 162 H206 M170 172 L204 182" stroke="#5a3a22" stroke-width="3" stroke-linecap="round"/>
</g></svg>`,
  lynx: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
<title>Lincoln Lynx (original EduOS demo mascot)</title>
<circle cx="128" cy="128" r="124" fill="#6b1d2a"/>
<polygon points="52,120 70,34 112,86" fill="#c9965b"/><polygon points="204,120 186,34 144,86" fill="#c9965b"/>
<polygon points="64,98 72,56 96,84" fill="#f2dcc0"/><polygon points="192,98 184,56 160,84" fill="#f2dcc0"/>
<path d="M70 34 L66 12 M186 34 L190 12" stroke="#1a1a1a" stroke-width="6" stroke-linecap="round"/>
<polygon points="40,150 60,96 128,78 196,96 216,150 196,206 128,226 60,206" fill="#c9965b"/>
<polygon points="40,150 26,190 70,200 60,206" fill="#e8cfa8"/><polygon points="216,150 230,190 186,200 196,206" fill="#e8cfa8"/>
<ellipse cx="128" cy="176" rx="46" ry="34" fill="#f6ead8"/>
<ellipse cx="96" cy="136" rx="14" ry="11" fill="#d9c23c"/><ellipse cx="160" cy="136" rx="14" ry="11" fill="#d9c23c"/>
<ellipse cx="96" cy="136" rx="4" ry="9" fill="#1a1a1a"/><ellipse cx="160" cy="136" rx="4" ry="9" fill="#1a1a1a"/>
<polygon points="116,160 140,160 128,174" fill="#b85a6a"/>
<path d="M128 174 V184 M128 184 Q118 194 108 186 M128 184 Q138 194 148 186" fill="none" stroke="#3a2416" stroke-width="4" stroke-linecap="round"/>
<path d="M100 102 L108 116 M128 96 V112 M156 102 L148 116" stroke="#7a5230" stroke-width="5" stroke-linecap="round"/>
</svg>`
};
export const BRANDING = [
  { school: null, primary: "#1f3a5f", secondary: "#2f6f73", accent: "#f2b134", font: "system", tiles: { preset: "minimal", base: { shape: "rounded", bg: "surface", glyphMode: "mono", glyphColor: "primary", labelColor: "auto", badge: false }, overrides: {} } },
  { school: "elementary", mascotName: "Otters", motto: "Curious, kind and ready to learn", mascot: "otter",
    primary: "#1b4f8a", secondary: "#0f7c80", accent: "#f6c445", font: "rounded",
    tiles: { preset: "mascot_classic", base: { shape: "rounded", bg: "primary", glyphMode: "mono", glyphColor: "auto", labelColor: "auto", badge: true }, overrides: { work: { bg: "accent" } } } },
  { school: "middle", mascotName: "Lynx", motto: "Lead with courage", mascot: "lynx",
    primary: "#6b1d2a", secondary: "#2d4a3e", accent: "#e0a526", font: "slab",
    tiles: { preset: "bold", base: { shape: "square", bg: "cycle", glyphMode: "color", glyphColor: "auto", labelColor: "auto", badge: false }, overrides: {} } }
];

// 32.4.0 mobile role apps. All synthetic. Stops are fictional street corners;
// EduOS stores driver-recorded check-ins at stops, never a student's location.
export const TRANSPORT_ROUTES = [
  { id: id(701), school: "elementary", name: "Route 7 Morning", bus: "Bus 7", direction: "am", driver: "driver",
    stops: [
      { id: id(711), seq: 1, name: "Maple Ave & 3rd St (demo)", time: "07:20" },
      { id: id(712), seq: 2, name: "Willow Ct loop (demo)", time: "07:28" },
      { id: id(713), seq: 3, name: "Cedar Park entrance (demo)", time: "07:36" },
      { id: id(714), seq: 4, name: "Riverside Elementary", time: "07:50", school: true }],
    riders: [["ava", 711], ["noah", 711], ["liam", 712], ["sofia", 713], ["leo", 713]] },
  { id: id(702), school: "elementary", name: "Route 7 Afternoon", bus: "Bus 7", direction: "pm", driver: "driver",
    stops: [
      { id: id(721), seq: 1, name: "Riverside Elementary", time: "15:05", school: true },
      { id: id(722), seq: 2, name: "Cedar Park entrance (demo)", time: "15:18" },
      { id: id(723), seq: 3, name: "Willow Ct loop (demo)", time: "15:26" },
      { id: id(724), seq: 4, name: "Maple Ave & 3rd St (demo)", time: "15:34" }],
    riders: [["ava", 724], ["noah", 724], ["liam", 723], ["sofia", 722], ["leo", 722]] }
];

// Approved, teacher-authored practice content. Christie only tutors from
// approved skills like these; answers stay on the server.
export const CHRISTIE_SKILLS = [
  { id: id(801), grade: "4", subject: "Math", code: "G4.FR.EQ", seq: 1, title: "Equivalent fractions",
    explanation: "Two fractions are equivalent when they name the same amount. Multiply or divide the top and bottom by the same number: 1/2 = 2/4 = 3/6. Think of a pizza cut into more slices: the amount you eat stays the same.",
    items: [
      { prompt: "Fill in the blank: 1/2 = ?/4", answer: "2", hints: ["What did we multiply the bottom number 2 by to get 4?", "The bottom was multiplied by 2. Do the same to the top number.", "1 × 2 = ?"] },
      { prompt: "Fill in the blank: 2/3 = ?/6", answer: "4", hints: ["How do you get from 3 to 6?", "Multiply the top by the same number you used on the bottom.", "2 × 2 = ?"] },
      { prompt: "Which fraction is equivalent to 3/4: 6/8 or 6/12?", answer: "6/8", hints: ["Try multiplying both parts of 3/4 by 2.", "3 × 2 = 6 and 4 × 2 = ?"] },
      { prompt: "Simplify 4/8 to an equivalent fraction with denominator 2.", answer: "1/2", hints: ["Divide the top and bottom by the same number.", "8 ÷ 4 = 2. Now divide the top by 4 too."] }] },
  { id: id(802), grade: "4", subject: "Math", code: "G4.FR.CMP", seq: 2, title: "Comparing fractions",
    explanation: "With the same denominator, the bigger numerator is the bigger fraction: 3/5 > 2/5. With different denominators, rewrite them as equivalent fractions with a common denominator first.",
    items: [
      { prompt: "Which is bigger: 3/8 or 5/8?", answer: "5/8", hints: ["The bottom numbers are the same.", "Compare the top numbers: 3 and 5."] },
      { prompt: "Which is bigger: 1/2 or 3/8?", answer: "1/2", hints: ["Rewrite 1/2 with 8 on the bottom.", "1/2 = 4/8. Now compare 4/8 and 3/8."] },
      { prompt: "Which is smaller: 2/3 or 3/4?", answer: "2/3", hints: ["Use 12 as a common denominator.", "2/3 = 8/12 and 3/4 = 9/12."] }] },
  { id: id(803), grade: "4", subject: "Math", code: "G4.FR.ADD", seq: 3, title: "Adding fractions with like denominators",
    explanation: "When the denominators match, add the numerators and keep the denominator: 1/5 + 2/5 = 3/5.",
    items: [
      { prompt: "1/5 + 2/5 = ?", answer: "3/5", hints: ["The bottom number stays 5.", "Add the top numbers: 1 + 2."] },
      { prompt: "3/8 + 4/8 = ?", answer: "7/8", hints: ["Keep the 8.", "3 + 4 = ?"] }] },
  { id: id(811), grade: "1", subject: "Math", code: "G1.ADD.10", seq: 1, title: "Adding within 10",
    explanation: "Adding means putting groups together. Count on from the bigger number: for 3 + 4, start at 4 and count 5, 6, 7.",
    items: [
      { prompt: "2 + 3 = ?", answer: "5", hints: ["Start at 3.", "Count on two more: 4, 5."] },
      { prompt: "4 + 4 = ?", answer: "8", hints: ["Hold up 4 fingers on each hand.", "Count all your fingers that are up."] },
      { prompt: "6 + 1 = ?", answer: "7", hints: ["What number comes after 6?"] }] },
  { id: id(812), grade: "1", subject: "Reading", code: "G1.RD.SW", seq: 2, title: "Sight words",
    explanation: "Sight words are words we see a lot, like 'the', 'and' and 'said'. We learn to read them quickly.",
    items: [
      { prompt: "Which word completes the sentence: 'I see ___ cat.' (the / tree)", answer: "the", hints: ["Which word makes sense before 'cat'?", "Try reading it both ways out loud."] },
      { prompt: "Which word rhymes with 'cat': hat or cup?", answer: "hat", hints: ["Rhyming words end with the same sound.", "Say 'cat ... hat' and 'cat ... cup'."] }] }
];
export const CHRISTIE_MASTERY = [["ava", 801, 86], ["ava", 802, 42], ["noah", 801, 35], ["liam", 801, 72], ["sofia", 801, 90], ["sofia", 802, 64], ["leo", 811, 55]];

export const ANNOUNCEMENTS = [
  { id: id(901), by: "principal", scope: "school", school: "elementary", audience: ["teacher", "parent", "pupil", "driver"],
    title: "Picture day is Thursday", body: "Picture day is this Thursday. Order forms went home in backpacks. Retakes are next month. (Demo announcement.)" },
  { id: id(902), by: "teacher", scope: "class", school: "elementary", audience: ["parent", "pupil"],
    title: "Fractions unit starts Monday", body: "Our class starts fractions on Monday. Christie has practice on equivalent fractions ready. A few minutes a night helps! — Mr. Lee (demo)" }
];
export const THREADS = [
  { id: id(951), kind: "family", school: "elementary", student: "ava", by: "teacher", subject: "Ava's reading log",
    participants: ["teacher", "parent"],
    messages: [["teacher", "Hi! Ava did a great job on her reading log this week. She chose Charlotte's Web. (Demo message.)"],
               ["parent", "Thank you! She has been reading every night before bed."]] },
  { id: id(952), kind: "staff", school: "elementary", by: "driver", subject: "Route 7 timing",
    participants: ["driver", "principal"],
    messages: [["driver", "Construction on Cedar Park entrance may add 5 minutes to the morning route this week. (Demo message.)"]] }
];

// 32.5.0 SafetyOS and car pick-up (synthetic). Guardians with an account get a
// "guardian" row automatically; these are the other approved/pending adults.
export const PICKUP_ADULTS = [
  { id: id(1002), student: "ava", name: "Ruth Morgan", relationship: "Grandmother", status: "approved" },
  { id: id(1003), student: "ava", name: "Sam Rivera", relationship: "Family friend", status: "pending" },
  { id: id(1004), student: "noah", name: "Chris Brooks", relationship: "Father", status: "approved" },
  { id: id(1005), student: "noah", name: "Pat Brooks", relationship: "Mother", status: "approved" }
];
// Fixed demo pass codes so the walkthrough and smoke tests can use them. Real
// passes are random, shown once, and only their hash is stored.
export const PICKUP_PASSES = [
  { id: id(1101), adult: id(1002), code: "RTHM2-AVA4K" },
  { id: id(1102), adult: id(1004), code: "CHR1S-N0AH7" },
  { id: id(1103), adult: id(1005), code: "PATB7-N0AH5" }
];
export const PICKUP_RESTRICTIONS = [
  { id: id(1201), student: "noah", kind: "do_not_release", person: "Pat Brooks", detail: "Protective order 2026-FC-118 (synthetic): do not release to Pat Brooks.", doc: true },
  { id: id(1202), student: "noah", kind: "custody_order", person: null, detail: "Custody order on file (synthetic): Chris Brooks has school-day custody.", doc: true }
];
// A finished, debriefed drill for the incident history.
export const PAST_DRILL = { id: id(1301), school: "elementary", kind: "lockdown", daysAgo: 7,
  debrief: "Lockdown drill (demo): all classes reported within 6 minutes. Fix: Room 12 door sticks; portable classroom needs a second radio." };

// ---------------------------------------------------------------------------
// 32.6.0 learning core. Standards are Common Core State Standards codes; the
// descriptions are short paraphrased summaries (not the official wording),
// linked to the official pages. Primary sources are REAL public-domain items
// at the Library of Congress and the U.S. National Archives (links checked
// when this release was built); everything else (courses, lessons, quizzes,
// grades) is synthetic demo content written for EduOS.
// ---------------------------------------------------------------------------
export const STANDARDS = [
  { id: id(1501), code: "4.NF.A.1", subject: "Math", grade: "4", url: "https://www.thecorestandards.org/Math/Content/4/NF/A/1/",
    description: "Summary: explain why two fractions are equivalent by multiplying top and bottom by the same number, using visual models." },
  { id: id(1502), code: "4.NF.A.2", subject: "Math", grade: "4", url: "https://www.thecorestandards.org/Math/Content/4/NF/A/2/",
    description: "Summary: compare two fractions with different numerators and denominators, using a common denominator or a benchmark like 1/2." },
  { id: id(1503), code: "4.NF.B.3", subject: "Math", grade: "4", url: "https://www.thecorestandards.org/Math/Content/4/NF/B/3/",
    description: "Summary: understand adding and subtracting fractions as joining and separating parts of the same whole." },
  { id: id(1504), code: "RI.4.3", subject: "Reading", grade: "4", url: "https://www.thecorestandards.org/ELA-Literacy/RI/4/3/",
    description: "Summary: explain events or ideas in a historical text, including what happened and why, using details from the text." },
  { id: id(1505), code: "RI.4.6", subject: "Reading", grade: "4", url: "https://www.thecorestandards.org/ELA-Literacy/RI/4/6/",
    description: "Summary: compare a firsthand and a secondhand account of the same event and describe how they differ in focus and information." },
  { id: id(1506), code: "RI.4.7", subject: "Reading", grade: "4", url: "https://www.thecorestandards.org/ELA-Literacy/RI/4/7/",
    description: "Summary: interpret information shown visually (photos, charts, timelines) and explain how it adds to the text." }
];
// Real items; titles, creators and rights as the archives state them.
export const PRIMARY_SOURCES = [
  { id: id(1521), kind: "photograph", archive: "Library of Congress", url: "https://www.loc.gov/item/00652085/",
    title: "[First flight, 120 feet in 12 seconds, 10:35 a.m.; Kitty Hawk, North Carolina]",
    creator: "Orville Wright and John T. Daniels (photographer)", date: "December 17, 1903",
    rights: "Library of Congress: \"No known restrictions on publication.\"",
    excerpt: null,
    description: "Glass-plate photograph of the Wright Flyer just after take-off, with Wilbur Wright running alongside. Open the Library of Congress page to see the image." },
  { id: id(1522), kind: "telegram", archive: "Library of Congress", url: "https://www.loc.gov/item/today-in-history/december-17/",
    title: "Telegram from Orville Wright to Bishop Milton Wright, December 17, 1903 (as quoted by the Library of Congress)",
    creator: "Orville Wright", date: "December 17, 1903",
    rights: "Public domain (1903). Quoted on the Library of Congress \"Today in History - December 17\" page; the original is in the Wright Brothers Papers, Manuscript Division.",
    excerpt: "Success four flights Thursday morning all against twenty one mile wind started from level with engine power alone average speed through air thirty one miles longest 57 seconds inform Press home Christmas.",
    description: "Orville's telegram home on the day of the first flights: a firsthand account. The Library of Congress page around it is a secondhand account of the same day." },
  { id: id(1523), kind: "document", archive: "National Archives", url: "https://www.archives.gov/founding-docs/declaration-transcript",
    title: "Declaration of Independence: A Transcription",
    creator: "Second Continental Congress", date: "July 4, 1776",
    rights: "Public domain (1776). Transcription published by the U.S. National Archives.",
    excerpt: "We hold these truths to be self-evident, that all men are created equal, that they are endowed by their Creator with certain unalienable Rights, that among these are Life, Liberty and the pursuit of Happiness.",
    description: "The sentence most people know from the Declaration. Read it slowly: what idea does it say everyone should already agree on?" }
];
export const COURSES = [
  { id: id(1601), title: "Grade 4 Math: Fractions", subject: "Math", grade: "4", term: "Fall 2026", teacher: "teacher", status: "active",
    students: ["ava", "noah", "liam", "sofia"] },
  { id: id(1602), title: "Grade 4 Reading: Primary Sources", subject: "Reading", grade: "4", term: "Fall 2026", teacher: "teacher", status: "active",
    students: ["ava", "noah", "liam", "sofia"] },
  // Last year's course: holds Ava's posted final grade (on the EDAL ledger).
  { id: id(1603), title: "Grade 3 Math", subject: "Math", grade: "3", term: "2025-26", teacher: "teacher2", status: "archived", students: ["ava"] }
];
export const UNITS = [
  { id: id(1611), course: 1601, seq: 1, title: "Equivalent fractions", summary: "Same amount, different names." },
  { id: id(1612), course: 1601, seq: 2, title: "Comparing and adding fractions", summary: "Common denominators and benchmarks." },
  { id: id(1613), course: 1602, seq: 1, title: "Eyewitness or retold?", summary: "Firsthand and secondhand accounts with real primary sources." }
];
export const LESSONS = [
  { id: id(1621), unit: 1611, course: 1601, seq: 1, title: "Equivalent fractions with models", approved: true, standards: [1501],
    objective: "I can show two fractions are equivalent with a model and by multiplying.",
    content: "Fractions are equivalent when they name the same amount of the same whole. Fold a paper strip in half, then fold it again: one half is now two fourths, so 1/2 = 2/4. Multiplying the numerator and the denominator by the same number makes more, smaller pieces but keeps the amount the same. Dividing both by the same number does the reverse. Always check that you changed the top and the bottom in the same way." },
  { id: id(1622), unit: 1612, course: 1601, seq: 1, title: "Compare fractions with different denominators", approved: true, standards: [1502],
    objective: "I can compare two fractions using a common denominator or the benchmark 1/2.",
    content: "To compare fractions with different denominators, rename them so the pieces are the same size. Find a common denominator, rewrite each fraction, then compare the numerators. Another way is a benchmark: decide whether each fraction is more or less than one half. Only compare fractions of the same whole, and write the answer with >, < or =." },
  { id: id(1623), unit: 1612, course: 1601, seq: 2, title: "Add fractions with like denominators", approved: false, standards: [1503],
    objective: "I can add fractions that have the same denominator.",
    content: "When fractions have the same denominator, the pieces are the same size, so you can join them: add the numerators and keep the denominator. Draw the pieces on one whole to check your answer." },
  { id: id(1624), unit: 1613, course: 1602, seq: 1, title: "The first flight: a photograph and a telegram", approved: true, standards: [1505, 1506],
    objective: "I can compare a firsthand and a secondhand account of the Wright brothers' first flights.",
    content: "On December 17, 1903, Orville and Wilbur Wright flew the first powered airplane near Kitty Hawk, North Carolina. A firsthand account comes from someone who was there, like Orville's telegram home that evening. A secondhand account is written later by someone who learned about the event, like a history web page. The famous photograph is a primary source too: it shows one moment of one flight. Look at what each source tells you and what it leaves out.",
    sources: [[1521, ["What is happening in the photograph? List three things you can see.", "What can the photograph NOT tell you about the day?"]],
              [1522, ["Who wrote the telegram, and how do you know he was there?", "Which facts in the telegram are numbers? Why might Orville include them?", "Why do you think the telegram has no punctuation?"]]] },
  { id: id(1625), unit: 1613, course: 1602, seq: 2, title: "Words that started a country", approved: true, standards: [1504],
    objective: "I can explain the big idea in one famous sentence and why it mattered in 1776.",
    content: "In 1776, leaders from the thirteen American colonies wrote the Declaration of Independence to explain why they were breaking away from Great Britain. Its most famous sentence says that some truths are \"self-evident\", meaning they should be obvious to everyone. Read the sentence, find the rights it names, and think about why the writers started with an idea instead of a list of complaints.",
    sources: [[1523, ["Which three rights does the sentence name?", "What does \"self-evident\" mean in your own words?", "Who do you think the writers wanted to read this?"]]] }
];
// Christie skills linked to standards and lessons (32.4 skills keep their ids).
export const SKILL_LINKS = [[801, 1501, 1621], [802, 1502, 1622], [803, 1503, 1623]];
const r3 = (title, std, labels) => ({ id: title.toLowerCase().replace(/[^a-z]+/g, "-").slice(0, 20), title, standardId: std ? id(std) : null,
  levels: labels.map((label, i) => ({ points: i + 1, label })) });
export const COURSE_WORK = [
  { id: id(1631), course: 1601, lesson: 1621, kind: "quiz", title: "Quiz: Equivalent fractions", dueDays: 7, maxAttempts: 2, retake: "highest", minutes: 15,
    standards: [1501],
    items: [
      { kind: "mc", prompt: "Which fraction is equivalent to 1/2?", choices: ["2/3", "3/6", "1/4", "2/5"], key: { index: 1 }, std: 1501 },
      { kind: "numeric", prompt: "Fill in the missing number: 3/4 = ?/8", key: { value: "6", tolerance: 0 }, std: 1501 },
      { kind: "short", prompt: "Write a fraction equivalent to 2/5 with denominator 10.", key: { accepted: ["4/10"] }, std: 1501 },
      { kind: "numeric", prompt: "Fill in the missing number: 6/9 = 2/?", key: { value: "3", tolerance: 0 }, std: 1501 },
      { kind: "short", prompt: "In one sentence: why are 1/2 and 4/8 equivalent?", key: { accepted: [] }, std: 1501 }] },
  { id: id(1632), course: 1601, lesson: 1622, kind: "quiz", title: "Quiz: Comparing fractions", dueDays: 10, maxAttempts: 1, retake: "highest", minutes: 10,
    standards: [1502],
    items: [
      { kind: "mc", prompt: "Which is greater: 3/8 or 1/2?", choices: ["3/8", "1/2", "They are equal"], key: { index: 1 }, std: 1502 },
      { kind: "mc", prompt: "Which symbol makes this true? 2/3 __ 3/4", choices: [">", "<", "="], key: { index: 1 }, std: 1502 },
      { kind: "numeric", prompt: "Rewrite 2/5 with denominator 10. What is the new numerator?", key: { value: "4", tolerance: 0 }, std: 1502 },
      { kind: "short", prompt: "Name a fraction between 1/4 and 3/4.", key: { accepted: ["1/2", "2/4", "3/8", "5/8"] }, std: 1502 }] },
  { id: id(1633), course: 1601, lesson: 1621, kind: "work", title: "Fraction strips poster", dueDays: -3, category: "Classwork", standards: [1501],
    rubric: [r3("Accuracy", 1501, ["Not yet", "Some correct", "Mostly correct", "All correct"]),
             r3("Explanation", 1501, ["Missing", "Partial", "Clear", "Clear with examples"]),
             r3("Presentation", null, ["Hard to read", "Readable", "Neat and labelled", "Neat, labelled and colourful"])] },
  { id: id(1634), course: 1602, lesson: 1624, kind: "quiz", title: "Source check: The first flight", dueDays: 5, maxAttempts: 1, retake: "highest", minutes: null,
    standards: [1505, 1506],
    items: [
      { kind: "mc", prompt: "Who sent the telegram?", choices: ["Wilbur Wright", "Orville Wright", "A newspaper reporter"], key: { index: 1 }, std: 1505 },
      { kind: "numeric", prompt: "According to the telegram, how many seconds was the longest flight?", key: { value: "57", tolerance: 0 }, std: 1505 },
      { kind: "source", prompt: "Look at the photograph and read the telegram. Name one thing the photo shows that the telegram does not, and one thing the telegram tells you that the photo cannot.", source: 1521, std: 1506 }] },
  { id: id(1635), course: 1602, lesson: 1624, kind: "work", title: "Firsthand vs secondhand chart", dueDays: 9, category: "Classwork", standards: [1505],
    rubric: [r3("Compares both accounts", 1505, ["Not yet", "One account", "Both, a little", "Both, with details"]),
             r3("Uses evidence", 1505, ["None", "One quote", "Two quotes", "Quotes and explains"])] }
];
export const ACCOMMODATIONS = [["noah", 50, true, "Extra time and read-aloud (demo plan)"], ["ava", 25, true, "Read-aloud on request (demo)"]];
