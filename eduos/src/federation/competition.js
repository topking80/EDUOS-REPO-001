// SPORT-04: conferences, leagues, regions, divisions, seasons, schedules,
// results and championships, as a state athletic association defines them.
//
// A pure checker over the registry contract (registry-seed.schema.json):
// validateCompetition(registry) lists every problem; currentResult() and
// standings() read results the association has made official. No I/O and
// no student data: participants are member schools (opaque IDs), never
// athletes. The running app doesn't use it yet.
//
// Rules enforced:
//  * The association owns its competition structure. A conference, league,
//    region or division is recognized by the association it belongs to,
//    through an approved governance decision (SPORT-02); a grouping's parent
//    belongs to the same association.
//  * Competition groupings are not education districts, and membership in
//    one never changes a school's education tenant.
//  * Only member schools take part: a school must hold an active association
//    membership (FED-01C) for the activity on the date, unless the contest is
//    covered by an approved sanction (SPORT-03) for that event.
//  * Exclusive groupings (e.g. a school's one conference for a sport) can't
//    overlap for the same school, activity and period.
//  * Results are versioned and never overwritten. Only the association makes
//    a result official; a correction supersedes the earlier version and
//    cites a decision; vacating a result cites an approved decision.
//  * Championship entries are member schools, in the championship's
//    classification when it has one, within its entry limit.

const DAY = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);
const overlaps = (a, b) => (!a.effective_to || !b.effective_from || b.effective_from <= a.effective_to) && (!b.effective_to || !a.effective_from || a.effective_from <= b.effective_to);
const OFFICIAL = new Set(["official", "corrected", "vacated"]);
const PAIR = { win: "loss", loss: "win", tie: "tie", forfeit_win: "forfeit_loss", forfeit_loss: "forfeit_win" };

function index(d) {
  const map = k => new Map((d[k] || []).map(r => [r.id, r]));
  const ruleSources = map("rule_sources");
  return {
    orgs: map("organizations"), decisions: map("governance_decisions"), sanctions: map("sanctioning_records"),
    cycles: map("classification_cycles"), versions: map("rule_versions"), seasons: map("seasons"),
    groupings: map("competition_groupings"), contests: map("contests"), results: map("contest_results"),
    championships: map("championships"),
    versionOrg: id => { const v = (d.rule_versions || []).find(x => x.id === id); return v ? ruleSources.get(v.rule_source_id)?.organization_id : undefined; },
  };
}

/** Does the school hold an active membership in the association for the activity on that date? */
export function isMember(d, orgId, schoolId, activityId, on) {
  return (d.memberships || []).some(m => m.organization_id === orgId && m.school_id === schoolId && m.status === "active"
    && (m.activity_scope || []).includes(activityId) && inRange(on, m.effective_from, m.effective_to));
}
const approvedDecision = (ix, id, orgId) => { const x = ix.decisions.get(id); return !!x && x.organization_id === orgId && x.status === "approved"; };

/** Check the competition collections. Returns {ok, errors}. */
export function validateCompetition(d) {
  const errors = [], ix = index(d);
  const err = (id, msg) => errors.push(`${id}: ${msg}`);
  for (const k of ["seasons", "competition_groupings", "grouping_memberships", "contests", "contest_results", "championships", "championship_entries"]) {
    const ids = (d[k] || []).map(r => r.id);
    if (new Set(ids).size !== ids.length) errors.push(`${k}: IDs must be unique`);
  }
  const dates = (r, from, to) => {
    for (const f of [from, to]) if (r[f] !== undefined && !DAY(r[f])) err(r.id, `${f} must be an ISO date`);
    if (DAY(r[from]) && DAY(r[to]) && r[to] < r[from]) err(r.id, `${to} is before ${from}`);
  };

  for (const s of d.seasons || []) {
    if (!ix.orgs.has(s.organization_id)) err(s.id, "unknown association");
    dates(s, "start_date", "end_date");
    for (const f of ["regular_season_end", "postseason_start"]) if (s[f] && !inRange(s[f], s.start_date, s.end_date)) err(s.id, `${f} is outside the season`);
    if (s.rule_version_id && ix.versionOrg(s.rule_version_id) !== s.organization_id) err(s.id, "rule version belongs to another association");
  }

  for (const g of d.competition_groupings || []) {
    if (!ix.orgs.has(g.organization_id)) err(g.id, "unknown association");
    dates(g, "effective_from", "effective_to");
    if (g.recognition?.recognized_by !== g.organization_id) err(g.id, "must be recognized by the association it belongs to");
    const dec = ix.decisions.get(g.recognition?.decision_id);
    if (!dec || dec.organization_id !== g.organization_id) err(g.id, "recognition decision not found for this association");
    else if (["recognized", "active"].includes(g.status) && dec.status !== "approved") err(g.id, "a recognized grouping needs an approved decision");
    if (g.parent_grouping_id) {
      const seen = new Set([g.id]);
      for (let p = ix.groupings.get(g.parent_grouping_id); p; p = p.parent_grouping_id ? ix.groupings.get(p.parent_grouping_id) : null) {
        if (seen.has(p.id)) { err(g.id, "grouping hierarchy has a cycle"); break; }
        seen.add(p.id);
      }
      const parent = ix.groupings.get(g.parent_grouping_id);
      if (!parent) err(g.id, "parent grouping not found");
      else {
        if (parent.organization_id !== g.organization_id) err(g.id, "parent grouping belongs to another association");
        if (g.activity_scope.some(a => !parent.activity_scope.includes(a))) err(g.id, "activities outside the parent grouping's scope");
      }
    }
    if (g.classification_cycle_id) {
      const c = ix.cycles.get(g.classification_cycle_id);
      if (!c || c.organization_id !== g.organization_id) err(g.id, "classification cycle not found for this association");
      if (!g.classification) err(g.id, "a classification cycle needs the classification it groups");
    }
  }

  const active = (r, on) => r.status === "active" && inRange(on, r.effective_from, r.effective_to);
  // A grouping inherits the classification band of the nearest ancestor that has one.
  const bandOf = g => { for (let x = g, i = 0; x && i < 20; x = x.parent_grouping_id ? ix.groupings.get(x.parent_grouping_id) : null, i++) if (x.classification) return x; return null; };
  for (const m of d.grouping_memberships || []) {
    const g = ix.groupings.get(m.grouping_id);
    dates(m, "effective_from", "effective_to");
    if (!g) { err(m.id, "grouping not found"); continue; }
    if (!g.activity_scope.includes(m.activity_id)) err(m.id, "activity outside the grouping's scope");
    if (m.status === "active" && !isMember(d, g.organization_id, m.school_id, m.activity_id, m.effective_from)) err(m.id, "school isn't an active association member for this activity");
    const b = m.basis || {}, band = bandOf(g);
    if (b.kind === "classification") {
      const c = (d.classifications || []).find(x => x.id === b.reference_id);
      if (!c || c.organization_id !== g.organization_id || c.school_id !== m.school_id || c.activity_id !== m.activity_id || !["assigned", "final"].includes(c.status))
        err(m.id, "classification basis doesn't match this school, activity and association");
    } else if (!approvedDecision(ix, b.reference_id, g.organization_id)) err(m.id, "basis needs an approved decision of the association");
    if (band && m.status === "active") {
      const c = (d.classifications || []).find(x => x.organization_id === g.organization_id && x.school_id === m.school_id && x.activity_id === m.activity_id
        && (!band.classification_cycle_id || x.cycle_id === band.classification_cycle_id) && ["assigned", "final"].includes(x.status));
      if (!c || c.classification !== band.classification) err(m.id, `school is classified ${c?.classification || "nothing"} here, not ${band.classification} (${band.id})`);
    }
    if (m.status === "active" && g.exclusive) {
      for (const o of d.grouping_memberships || []) {
        if (o === m || o.status !== "active" || o.school_id !== m.school_id || o.activity_id !== m.activity_id || o.id > m.id) continue;
        const og = ix.groupings.get(o.grouping_id);
        if (og && og.exclusive && og.organization_id === g.organization_id && og.grouping_type === g.grouping_type && og.id !== g.id && overlaps(o, m))
          err(m.id, `school is already in ${og.id} (${g.grouping_type}) for this activity in that period`);
      }
    }
  }

  const groupMembers = (gid, activity, on) => new Set((d.grouping_memberships || []).filter(m => m.grouping_id === gid && m.activity_id === activity && active(m, on)).map(m => m.school_id));
  const entriesOf = cid => (d.championship_entries || []).filter(e => e.championship_id === cid);
  for (const c of d.contests || []) {
    const s = ix.seasons.get(c.season_id);
    if (!DAY(c.contest_date)) err(c.id, "contest_date must be an ISO date");
    if (!s) { err(c.id, "season not found"); continue; }
    if (!inRange(c.contest_date, s.start_date, s.end_date)) err(c.id, "date is outside the season");
    if (["postseason", "championship"].includes(c.contest_type) && s.postseason_start && c.contest_date < s.postseason_start) err(c.id, "postseason contest before the postseason starts");
    if (c.home_school_id && !c.participant_school_ids.includes(c.home_school_id)) err(c.id, "home school isn't a participant");
    let sanctioned = false;
    if (c.sanction_id) {
      const x = ix.sanctions.get(c.sanction_id);
      sanctioned = !!x && x.organization_id === s.organization_id && x.sanction_type === "event_approval" && ["approved", "active"].includes(x.status);
      if (!sanctioned) err(c.id, "sanction not found, not approved, or from another association");
    } else if (c.contest_type === "invitational") err(c.id, "an invitational needs an approved sanction");
    if (!sanctioned) for (const sc of c.participant_school_ids)
      if (!isMember(d, s.organization_id, sc, s.activity_id, c.contest_date)) err(c.id, `${sc} isn't an active member for ${s.activity_id} on ${c.contest_date}`);
    if (c.contest_type === "conference") {
      const g = ix.groupings.get(c.grouping_id);
      // Group play: a conference, league, or an association's district,
      // region or section that plays a schedule. Divisions are classification
      // bands, not schedules.
      if (!g || g.grouping_type === "division" || g.organization_id !== s.organization_id) err(c.id, "a conference contest names the grouping it counts in");
      else {
        const members = groupMembers(g.id, s.activity_id, c.contest_date);
        for (const sc of c.participant_school_ids) if (!members.has(sc)) err(c.id, `${sc} isn't in ${g.id} on ${c.contest_date}`);
      }
    }
    if (c.contest_type === "championship") {
      const ch = ix.championships.get(c.championship_id);
      if (!ch || ch.season_id !== s.id) err(c.id, "a championship contest names a championship in this season");
      else {
        const ok = new Set(entriesOf(ch.id).filter(e => !["withdrawn", "disqualified"].includes(e.status)).map(e => e.school_id));
        for (const sc of c.participant_school_ids) if (!ok.has(sc)) err(c.id, `${sc} isn't entered in ${ch.id}`);
      }
    }
  }

  const byContest = new Map();
  for (const r of d.contest_results || []) {
    const c = ix.contests.get(r.contest_id), s = c && ix.seasons.get(c.season_id);
    if (!c || !s) { err(r.id, "contest not found"); continue; }
    if (!Number.isInteger(r.version) || r.version < 1) err(r.id, "version is a positive integer");
    (byContest.get(c.id) || byContest.set(c.id, []).get(c.id)).push(r);
    if (OFFICIAL.has(r.result_status)) {
      if (r.recorded_by !== s.organization_id) err(r.id, "only the association makes a result official");
      if (!["completed", "forfeited"].includes(c.status)) err(r.id, "an official result needs a completed or forfeited contest");
    } else if (r.recorded_by !== s.organization_id && !c.participant_school_ids.includes(r.recorded_by)) err(r.id, "a provisional result comes from the association or a participant");
    if (r.supersedes_result_id) {
      const prev = ix.results.get(r.supersedes_result_id);
      if (!prev || prev.contest_id !== c.id || prev.version >= r.version) err(r.id, "supersedes an earlier version of the same contest");
    }
    if (r.result_status === "corrected" && (!r.supersedes_result_id || !approvedDecision(ix, r.decision_id, s.organization_id))) err(r.id, "a correction supersedes a version and cites an approved decision");
    if (r.result_status === "vacated" && !approvedDecision(ix, r.decision_id, s.organization_id)) err(r.id, "vacating a result cites an approved decision");
    if (r.result_status !== "vacated") {
      const got = r.outcomes.map(o => o.school_id).sort(), want = [...c.participant_school_ids].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) err(r.id, "outcomes must cover exactly the contest's participants");
      if (want.length === 2 && r.outcomes.length === 2) {
        const [a, b] = r.outcomes;
        if (PAIR[a.outcome] !== b.outcome) err(r.id, `outcomes ${a.outcome}/${b.outcome} don't agree`);
        else if (typeof a.score === "number" && typeof b.score === "number" && !a.outcome.startsWith("forfeit")) {
          const cmp = Math.sign(a.score - b.score), want2 = { win: 1, loss: -1, tie: 0 }[a.outcome];
          if (cmp !== want2) err(r.id, "scores don't match the outcome");
        }
      } else if (want.length > 2) {
        const places = r.outcomes.filter(o => o.outcome === "placed").map(o => o.placement);
        if (places.some(p => !Number.isInteger(p) || p < 1) || new Set(places).size !== places.length) err(r.id, "placements must be distinct positive integers");
      }
    }
  }
  for (const [cid, list] of byContest) {
    const versions = list.map(r => r.version);
    if (new Set(versions).size !== versions.length) errors.push(`${cid}: two results with the same version`);
    const superseded = new Set(list.map(r => r.supersedes_result_id).filter(Boolean));
    const heads = list.filter(r => OFFICIAL.has(r.result_status) && !superseded.has(r.id));
    if (heads.length > 1) errors.push(`${cid}: more than one current official result (${heads.map(r => r.id).join(", ")}); a later one must supersede`);
  }

  for (const ch of d.championships || []) {
    const s = ix.seasons.get(ch.season_id);
    if (!ix.orgs.has(ch.organization_id)) err(ch.id, "unknown association");
    if (!s || s.organization_id !== ch.organization_id || s.activity_id !== ch.activity_id) err(ch.id, "season must be this association's, for this activity");
    if (ch.classification_cycle_id && ix.cycles.get(ch.classification_cycle_id)?.organization_id !== ch.organization_id) err(ch.id, "classification cycle belongs to another association");
    if (ch.qualification_rule_version_id && ix.versionOrg(ch.qualification_rule_version_id) !== ch.organization_id) err(ch.id, "qualification rule version belongs to another association");
    const entries = entriesOf(ch.id);
    const schools = entries.map(e => e.school_id), seeds = entries.filter(e => Number.isInteger(e.seed)).map(e => e.seed);
    if (new Set(schools).size !== schools.length) err(ch.id, "a school is entered twice");
    if (new Set(seeds).size !== seeds.length) err(ch.id, "two entries share a seed");
    if (Number.isInteger(ch.entry_limit) && entries.filter(e => !["withdrawn", "disqualified"].includes(e.status)).length > ch.entry_limit) err(ch.id, "more entries than the entry limit");
  }
  for (const e of d.championship_entries || []) {
    const ch = ix.championships.get(e.championship_id), s = ch && ix.seasons.get(ch.season_id);
    if (!ch || !s) { err(e.id, "championship not found"); continue; }
    if (!isMember(d, ch.organization_id, e.school_id, ch.activity_id, s.postseason_start || s.start_date)) err(e.id, "school isn't an active association member for this activity");
    if (ch.classification) {
      const c = (d.classifications || []).find(x => x.organization_id === ch.organization_id && x.school_id === e.school_id && x.activity_id === ch.activity_id
        && (!ch.classification_cycle_id || x.cycle_id === ch.classification_cycle_id) && ["assigned", "final"].includes(x.status));
      if (!c || c.classification !== ch.classification) err(e.id, `school isn't classified ${ch.classification} for this championship`);
    }
    const b = e.qualification_basis || {};
    if (b.kind === "grouping_finish" && ix.groupings.get(b.reference_id)?.organization_id !== ch.organization_id) err(e.id, "qualifying grouping belongs to another association");
    if (b.kind === "appeal_decision" && !approvedDecision(ix, b.reference_id, ch.organization_id)) err(e.id, "appeal basis needs an approved decision");
  }
  return { ok: errors.length === 0, errors };
}

/** The result that stands for a contest: the latest official version not superseded, or null. */
export function currentResult(d, contestId) {
  const list = (d.contest_results || []).filter(r => r.contest_id === contestId);
  const superseded = new Set(list.map(r => r.supersedes_result_id).filter(Boolean));
  return list.filter(r => OFFICIAL.has(r.result_status) && !superseded.has(r.id)).sort((a, b) => b.version - a.version)[0] || null;
}

/**
 * Standings for a conference or league in a season, from results the
 * association made official. Vacated and unofficial results don't count.
 * Forfeits count as wins and losses. Sorted by win percentage (ties half).
 */
export function standings(d, groupingId, seasonId) {
  const table = new Map();
  const row = id => table.get(id) || table.set(id, { school_id: id, wins: 0, losses: 0, ties: 0, played: 0 }).get(id);
  for (const c of (d.contests || []).filter(x => x.grouping_id === groupingId && x.season_id === seasonId && x.contest_type === "conference")) {
    const r = currentResult(d, c.id);
    if (!r || r.result_status === "vacated") continue;
    for (const o of r.outcomes) {
      const t = row(o.school_id);
      if (o.outcome === "win" || o.outcome === "forfeit_win") t.wins++;
      else if (o.outcome === "loss" || o.outcome === "forfeit_loss") t.losses++;
      else if (o.outcome === "tie") t.ties++;
      else continue;
      t.played++;
    }
  }
  const pct = t => t.played ? (t.wins + t.ties / 2) / t.played : 0;
  return [...table.values()].map(t => ({ ...t, pct: Math.round(pct(t) * 1000) / 1000 })).sort((a, b) => b.pct - a.pct || b.wins - a.wins || a.school_id.localeCompare(b.school_id));
}
