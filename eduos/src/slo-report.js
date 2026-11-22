#!/usr/bin/env node
// CMP-05: service level report for a period, from the district's own
// Prometheus (no external service; aggregate metrics only, no student data).
//
//   PROMETHEUS_URL=http://prometheus.internal:9090 node src/slo-report.js [--month 2026-10 | --days 30] [--json]
//
//   PROMETHEUS_URL          required; the Prometheus that scrapes EduOS
//   PROMETHEUS_TOKEN_FILE   optional bearer token file for that Prometheus
//
// Without --month or --days it reports the last 30 days. Exit code 0 when every
// objective was met, 1 when one was missed, 2 when the report couldn't be made.
import fs from "node:fs";
import { SLOS, reportQuery, reportTrafficQuery, PERIOD_DAYS } from "./slo.js";

export function parsePeriod(args, now = new Date()) {
  const month = args[args.indexOf("--month") + 1];
  if (args.includes("--month")) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) throw new Error("--month must look like 2026-10");
    const [y, m] = month.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1)), end = new Date(Date.UTC(y, m, 1));
    if (end > now) throw new Error(`${month} hasn't ended yet; use --days for a rolling report`);
    return { label: month, start, end, days: Math.round((end - start) / 864e5) };
  }
  const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : PERIOD_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 400) throw new Error("--days must be a whole number from 1 to 400");
  return { label: `last ${days} days`, start: new Date(now - days * 864e5), end: now, days };
}

async function instant(base, query, time, headers) {
  const url = new URL("/api/v1/query", base);
  url.searchParams.set("query", query);
  url.searchParams.set("time", (time.getTime() / 1000).toFixed(0));
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.status !== "success") throw new Error(`Prometheus query failed (${res.status}): ${body?.error || "no response"}`);
  const r = body.data.result;
  return r.length ? Number(r[0].value[1]) : null;
}

/** One row per SLO: measured good ratio, error budget used, met or not. */
export async function buildReport({ base, period, token }) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const rows = [];
  for (const slo of SLOS) {
    const [badRatio, events] = await Promise.all([
      instant(base, reportQuery(slo.id, period.days), period.end, headers),
      instant(base, reportTrafficQuery(slo.id, period.days), period.end, headers)]);
    const noData = badRatio === null || !Number.isFinite(badRatio) || !events;
    const good = noData ? null : 1 - badRatio;
    const budget = 1 - slo.objective;
    rows.push({ id: slo.id, title: slo.title, description: slo.description, objective: slo.objective,
      measured: good, events: events ?? 0,
      budgetUsed: noData ? null : badRatio / budget,
      met: noData ? null : good >= slo.objective,
      ...(slo.id === "uptime" && !noData ? { downMinutes: Math.round(badRatio * period.days * 1440) } : {}) });
  }
  return { period: { label: period.label, start: period.start.toISOString(), end: period.end.toISOString(), days: period.days },
    generatedAt: new Date().toISOString(), slos: rows };
}

const pct = (x, d = 3) => x === null ? "no data" : `${(x * 100).toFixed(d).replace(/\.?0+$/, "")}%`;
export function toMarkdown(report) {
  const lines = [`# EduOS service levels: ${report.period.label}`, "",
    `${report.period.start.slice(0, 10)} to ${report.period.end.slice(0, 10)} (${report.period.days} days). Internal operating targets, not a contractual SLA.`, "",
    "| Objective | Target | Measured | Error budget used | Result |", "| --- | --- | --- | --- | --- |"];
  for (const r of report.slos)
    lines.push(`| ${r.title} | ${pct(r.objective)} | ${pct(r.measured)} | ${r.budgetUsed === null ? "no data" : pct(r.budgetUsed, 1)} | ${r.met === null ? "No data" : r.met ? "Met" : "**Missed**"} |`);
  lines.push("");
  const up = report.slos.find(r => r.id === "uptime");
  if (up?.downMinutes !== undefined) lines.push(`Unreachable for about ${up.downMinutes} minute${up.downMinutes === 1 ? "" : "s"} in the period.`, "");
  for (const r of report.slos) lines.push(`- **${r.title}:** ${r.description}`);
  if (report.slos.some(r => r.met === null))
    lines.push("", "\"No data\" means Prometheus had no samples for the whole period (retention too short, or EduOS wasn't scraped). It is not a pass.");
  return lines.join("\n") + "\n";
}

async function main() {
  const args = process.argv.slice(2);
  const base = process.env.PROMETHEUS_URL;
  if (!base) throw new Error("Set PROMETHEUS_URL to the Prometheus that scrapes EduOS");
  const token = process.env.PROMETHEUS_TOKEN_FILE ? fs.readFileSync(process.env.PROMETHEUS_TOKEN_FILE, "utf8").trim() : null;
  const report = await buildReport({ base, period: parsePeriod(args), token });
  process.stdout.write(args.includes("--json") ? JSON.stringify(report, null, 2) + "\n" : toMarkdown(report));
  return report.slos.some(r => r.met === false) ? 1 : report.slos.some(r => r.met === null) ? 2 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(code => process.exit(code), e => { console.error(e.message); process.exit(2); });
}
