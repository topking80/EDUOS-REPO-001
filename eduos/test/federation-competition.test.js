// SPORT-04: competition structure, schedules, results and championships
// (src/federation/competition.js over the registry contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCompetition, currentResult, standings, isMember } from "../src/federation/competition.js";

const dir = new URL("../../docs/architecture/federation/", import.meta.url);
const registry = JSON.parse(readFileSync(new URL("registry-seed.v0.1.json", dir), "utf8"));
const schema = JSON.parse(readFileSync(new URL("registry-seed.schema.json", dir), "utf8"));
const NEW = ["seasons", "competition_groupings", "grouping_memberships", "contests", "contest_results", "championships", "championship_entries"];
const ORG = "us-tx-uil", OTHER = "us-ok-ossaa", SPORT = "football";
const src = { source_url: "https://example.org/official", verification_status: "verified" };

function fixture() {
  const d = structuredClone(registry);
  const member = (school, org = ORG, extra = {}) => ({ id: `m-${school}-${org}`, organization_id: org, school_id: school, membership_class: "full", activity_scope: [SPORT, "volleyball"],
    status: "active", effective_from: "2026-07-01", entitlements: ["compete"], ...src, ...extra });
  d.memberships = ["a", "b", "c", "d", "e"].map(s => member(`sch-${s}`)).concat([member("sch-x", OTHER)]);
  d.governance_bodies = [{ id: "gb-uil", organization_id: ORG, body_type: "executive_committee", name: "Board", scope: ["all"], status: "active", effective_from: "2020-01-01", ...src }];
  const decision = (id, status = "approved", org = ORG) => ({ id, organization_id: org, decision_type: "alignment", decision_body_id: "gb-uil", authority_reference: "constitution-2026", decision_date: "2026-02-01", status, ...src });
  d.governance_decisions = [decision("dec-align"), decision("dec-correct"), decision("dec-vacate"), decision("dec-pending", "proposed")];
  d.rule_sources = [{ id: "rs-uil", organization_id: ORG, authority_level: "association", document_type: "constitution", title: "C&CR", ...src }];
  d.rule_versions = [{ id: "rv-2026", rule_source_id: "rs-uil", version_label: "2026-27", published_at: "2026-06-01", effective_from: "2026-08-01", status: "active", ...src }];
  d.classification_cycles = [{ id: "cy-2026", organization_id: ORG, name: "2026-28 realignment", cycle_start: "2026-08-01", cycle_end: "2028-07-31", status: "active", ...src }];
  d.classifications = ["a", "b", "c", "d"].map(s => ({ id: `cl-${s}`, organization_id: ORG, cycle_id: "cy-2026", school_id: `sch-${s}`, activity_id: SPORT, classification: "4A", effective_from: "2026-08-01", status: "final", ...src }))
    .concat([{ id: "cl-e", organization_id: ORG, cycle_id: "cy-2026", school_id: "sch-e", activity_id: SPORT, classification: "5A", effective_from: "2026-08-01", status: "final", ...src }]);
  d.sanctioning_records = [{ id: "sa-classic", organization_id: ORG, event_reference: "Border Classic 2026", sanction_type: "event_approval", status: "approved", decision_date: "2026-07-15", authority_reference: "rule-1100", ...src }];
  d.seasons = [{ id: "se-fb-2026", organization_id: ORG, activity_id: SPORT, school_year: "2026-27", start_date: "2026-08-20", end_date: "2026-12-20", regular_season_end: "2026-11-07",
    postseason_start: "2026-11-12", status: "published", rule_version_id: "rv-2026", ...src }];
  const grouping = (id, type, extra = {}) => ({ id, organization_id: ORG, grouping_type: type, name: id, activity_scope: [SPORT], exclusive: true, status: "active",
    effective_from: "2026-08-01", recognition: { recognized_by: ORG, decision_id: "dec-align" }, ...src, ...extra });
  d.competition_groupings = [grouping("div-4a", "division", { classification_cycle_id: "cy-2026", classification: "4A", exclusive: false }),
    grouping("dist-4a-1", "district", { parent_grouping_id: "div-4a" }), grouping("dist-4a-2", "district", { parent_grouping_id: "div-4a" })];
  const gm = (id, g, school, extra = {}) => ({ id, grouping_id: g, school_id: school, activity_id: SPORT, status: "active", effective_from: "2026-08-01",
    basis: { kind: "classification", reference_id: `cl-${school.slice(4)}` }, ...src, ...extra });
  d.grouping_memberships = [gm("gm-a", "dist-4a-1", "sch-a"), gm("gm-b", "dist-4a-1", "sch-b"), gm("gm-c", "dist-4a-1", "sch-c"), gm("gm-d", "dist-4a-2", "sch-d")];
  const contest = (id, a, b, date, extra = {}) => ({ id, season_id: "se-fb-2026", contest_type: "district", participant_school_ids: [a, b], home_school_id: a, contest_date: date, status: "completed", ...src, ...extra });
  // Texas-style district play: "conference" contests of the district grouping.
  d.contests = [contest("g1", "sch-a", "sch-b", "2026-09-04", { contest_type: "conference", grouping_id: "dist-4a-1" }),
    contest("g2", "sch-b", "sch-c", "2026-09-11", { contest_type: "conference", grouping_id: "dist-4a-1" }),
    contest("g3", "sch-c", "sch-a", "2026-09-18", { contest_type: "conference", grouping_id: "dist-4a-1" })];
  const res = (id, c, outcomes, extra = {}) => ({ id, contest_id: c, version: 1, result_status: "official", outcomes, recorded_by: ORG, recorded_at: "2026-09-20", ...src, ...extra });
  const o = (s, outcome, score) => ({ school_id: s, outcome, ...(score !== undefined && { score }) });
  d.contest_results = [res("r1", "g1", [o("sch-a", "win", 28), o("sch-b", "loss", 14)]), res("r2", "g2", [o("sch-b", "win", 21), o("sch-c", "loss", 7)]),
    res("r3", "g3", [o("sch-c", "tie", 10), o("sch-a", "tie", 10)])];
  d.championships = [{ id: "ch-4a", organization_id: ORG, season_id: "se-fb-2026", activity_id: SPORT, name: "4A State Football", classification_cycle_id: "cy-2026", classification: "4A",
    format: "bracket", qualification_rule_version_id: "rv-2026", entry_limit: 4, status: "seeded", ...src }];
  d.championship_entries = ["a", "b", "d"].map((s, i) => ({ id: `ce-${s}`, championship_id: "ch-4a", school_id: `sch-${s}`, seed: i + 1, status: "entered",
    qualification_basis: { kind: "grouping_finish", reference_id: s === "d" ? "dist-4a-2" : "dist-4a-1" }, ...src }));
  return d;
}
const errorsOf = d => validateCompetition(d).errors.join("\n");

test("SPORT-04 collections are in the contract, empty in the seed, and carry schools, never athletes", () => {
  for (const k of NEW) {
    assert.ok(schema.required.includes(k), k);
    assert.deepEqual(registry[k], [], `${k} stays empty until official records are approved`);
    const props = Object.keys(schema.properties[k].items.properties);
    assert.equal(schema.properties[k].items.additionalProperties, false);
    assert.ok(!props.some(p => /student|athlete|player|person|name_of|dob|birth/.test(p)), `${k}: ${props}`);
  }
  assert.deepEqual(validateCompetition(registry).errors, []);
  assert.deepEqual(validateCompetition(fixture()).errors, []);
});

test("a valid season, alignment, schedule, results and championship pass", () => {
  assert.deepEqual(validateCompetition(fixture()).errors, []);
});

test("the association owns its structure: recognized by itself, with an approved decision, parents in the same association", () => {
  const bad = f => { const d = fixture(); f(d); return errorsOf(d); };
  assert.match(bad(d => { d.competition_groupings[1].recognition.recognized_by = "us-ok-ossaa"; }), /must be recognized by the association it belongs to/);
  assert.match(bad(d => { d.competition_groupings[1].recognition.decision_id = "dec-pending"; }), /needs an approved decision/);
  assert.match(bad(d => { d.competition_groupings.push({ ...d.competition_groupings[1], id: "x-dist", organization_id: OTHER, recognition: { recognized_by: OTHER, decision_id: "dec-align" } }); }), /x-dist: recognition decision not found/);
  assert.match(bad(d => { d.competition_groupings[0].parent_grouping_id = "dist-4a-1"; }), /cycle/);
  assert.match(bad(d => { d.competition_groupings[1].activity_scope = [SPORT, "basketball"]; }), /outside the parent grouping's scope/);
});

test("only member schools, in the right classification, one exclusive grouping at a time", () => {
  const bad = f => { const d = fixture(); f(d); return errorsOf(d); };
  assert.match(bad(d => { d.grouping_memberships.push({ ...d.grouping_memberships[0], id: "gm-x", school_id: "sch-x", basis: { kind: "association_alignment", reference_id: "dec-align" } }); }), /gm-x: school isn't an active association member/);
  assert.match(bad(d => { d.grouping_memberships.push({ ...d.grouping_memberships[0], id: "gm-e", school_id: "sch-e", basis: { kind: "classification", reference_id: "cl-e" } }); }), /gm-e: school is classified 5A here, not 4A \(div-4a\)/);
  assert.match(bad(d => { d.grouping_memberships.push({ ...d.grouping_memberships[0], id: "gm-a2", grouping_id: "dist-4a-2" }); }), /already in dist-4a-1 \(district\)/);
  assert.match(bad(d => { d.grouping_memberships[3].basis = { kind: "association_alignment", reference_id: "dec-pending" }; }), /needs an approved decision/);
  const d = fixture(); d.memberships[0].status = "suspended";
  assert.equal(isMember(d, ORG, "sch-a", SPORT, "2026-09-04"), false);
  assert.match(errorsOf(d), /g1: sch-a isn't an active member for football on 2026-09-04/);
});

test("schedules stay inside the season and the conference; outside schools need a sanctioned event", () => {
  const bad = f => { const d = fixture(); f(d); return errorsOf(d); };
  assert.match(bad(d => { d.contests[0].contest_date = "2027-01-05"; }), /g1: date is outside the season/);
  assert.match(bad(d => { d.contests[0].participant_school_ids = ["sch-a", "sch-d"]; d.contests[0].home_school_id = "sch-a"; d.contest_results[0].outcomes[1].school_id = "sch-d"; }), /sch-d isn't in dist-4a-1/);
  assert.match(bad(d => { d.contests[0].home_school_id = "sch-e"; }), /home school isn't a participant/);
  assert.match(bad(d => { d.contests[0].grouping_id = "div-4a"; }), /names the grouping it counts in/, "a division isn't a schedule");
  assert.match(bad(d => { d.contests.push({ id: "inv", season_id: "se-fb-2026", contest_type: "invitational", participant_school_ids: ["sch-a", "sch-x"], contest_date: "2026-10-03", status: "scheduled", ...src }); }), /an invitational needs an approved sanction/);
  const d = fixture();
  d.contests.push({ id: "inv", season_id: "se-fb-2026", contest_type: "invitational", participant_school_ids: ["sch-a", "sch-x"], contest_date: "2026-10-03", status: "scheduled", sanction_id: "sa-classic", ...src });
  assert.deepEqual(validateCompetition(d).errors, [], "an approved sanction covers the out-of-association school");
  assert.match(bad(d => { d.contests.push({ id: "po", season_id: "se-fb-2026", contest_type: "postseason", participant_school_ids: ["sch-a", "sch-b"], contest_date: "2026-11-01", status: "scheduled", ...src }); }), /postseason contest before the postseason starts/);
});

test("results are versioned; only the association makes them official; corrections and vacated results cite decisions", () => {
  const bad = f => { const d = fixture(); f(d); return errorsOf(d); };
  assert.match(bad(d => { d.contest_results[0].recorded_by = "sch-a"; }), /only the association makes a result official/);
  assert.match(bad(d => { d.contest_results[0].outcomes[1].outcome = "win"; }), /outcomes win\/win don't agree/);
  assert.match(bad(d => { d.contest_results[0].outcomes[0].score = 3; }), /scores don't match the outcome/);
  assert.match(bad(d => { d.contest_results.push({ ...d.contest_results[0], id: "r1b", version: 2 }); }), /g1: more than one current official result/);
  assert.match(bad(d => { d.contest_results.push({ ...d.contest_results[0], id: "r1b", version: 2, result_status: "corrected", supersedes_result_id: "r1" }); }), /a correction supersedes a version and cites an approved decision/);
  assert.match(bad(d => { d.contests[1].status = "scheduled"; }), /an official result needs a completed or forfeited contest/);
  // A correction flips the result; standings follow it, and the original stays on record.
  const d = fixture();
  d.contest_results.push({ ...d.contest_results[0], id: "r1b", version: 2, result_status: "corrected", supersedes_result_id: "r1", decision_id: "dec-correct",
    outcomes: [{ school_id: "sch-a", outcome: "forfeit_loss" }, { school_id: "sch-b", outcome: "forfeit_win" }] });
  assert.deepEqual(validateCompetition(d).errors, []);
  assert.equal(currentResult(d, "g1").id, "r1b");
  assert.ok(d.contest_results.some(r => r.id === "r1"), "earlier version kept");
  assert.deepEqual(standings(d, "dist-4a-1", "se-fb-2026").map(t => [t.school_id, t.wins, t.losses, t.ties]), [["sch-b", 2, 0, 0], ["sch-a", 0, 1, 1], ["sch-c", 0, 1, 1]]);
  // Vacating removes the game from the standings.
  d.contest_results.push({ ...d.contest_results[1], id: "r2v", version: 2, result_status: "vacated", supersedes_result_id: "r2", decision_id: "dec-vacate" });
  assert.deepEqual(validateCompetition(d).errors, []);
  assert.deepEqual(standings(d, "dist-4a-1", "se-fb-2026").find(t => t.school_id === "sch-b"), { school_id: "sch-b", wins: 1, losses: 0, ties: 0, played: 1, pct: 1 });
  d.contest_results.at(-1).decision_id = "dec-pending";
  assert.match(errorsOf(d), /vacating a result cites an approved decision/);
});

test("standings from the fixture: win percentage with ties as halves", () => {
  assert.deepEqual(standings(fixture(), "dist-4a-1", "se-fb-2026").map(t => [t.school_id, t.pct]), [["sch-b", 0.5], ["sch-a", 0.75], ["sch-c", 0.25]].sort((a, b) => b[1] - a[1]));
});

test("championships: member schools in the right classification, distinct seeds, within the entry limit", () => {
  const bad = f => { const d = fixture(); f(d); return errorsOf(d); };
  assert.match(bad(d => { d.championship_entries.push({ ...d.championship_entries[0], id: "ce-e", school_id: "sch-e", seed: 9 }); }), /ce-e: school isn't classified 4A/);
  assert.match(bad(d => { d.championship_entries[1].seed = 1; }), /two entries share a seed/);
  assert.match(bad(d => { d.championship_entries.push({ ...d.championship_entries[0], id: "ce-a2", seed: 8 }); }), /a school is entered twice/);
  assert.match(bad(d => { d.championships[0].entry_limit = 2; }), /more entries than the entry limit/);
  assert.match(bad(d => { d.championships[0].season_id = "nope"; }), /season must be this association's/);
  assert.match(bad(d => { d.contests.push({ id: "final", season_id: "se-fb-2026", contest_type: "championship", championship_id: "ch-4a", participant_school_ids: ["sch-a", "sch-c"], contest_date: "2026-12-12", status: "scheduled", ...src }); }), /sch-c isn't entered in ch-4a/);
});
