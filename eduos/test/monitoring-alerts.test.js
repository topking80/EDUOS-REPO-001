import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("queue alert rules use only metrics exported by EduOS", async () => {
  const [rules, metrics] = await Promise.all([
    read("../monitoring/eduos-alerts.yml"),
    read("../src/metrics.js")
  ]);
  const metricNames = [
    "eduos_queue_backlog_up",
    "eduos_queue_oldest_ready_seconds",
    "eduos_queue_jobs",
    "eduos_db_pool_connections",
    "eduos_http_requests_total"
  ];
  for (const name of metricNames) {
    assert.ok(metrics.includes(name), `metric is exported: ${name}`);
    assert.ok(rules.includes(name), `metric is used by an alert: ${name}`);
  }
});

test("every alert has a unique name, duration, severity and operator guidance", async () => {
  const rules = await read("../monitoring/eduos-alerts.yml");
  const blocks = rules.split(/^      - alert: /m).slice(1);
  assert.equal(blocks.length, 7, "all seven operational alerts are present");
  const names = blocks.map(block => block.split("\n", 1)[0].trim());
  assert.equal(new Set(names).size, names.length, "alert names are unique");
  for (const block of blocks) {
    assert.match(block, /^        expr:/m);
    assert.match(block, /^        for: [1-9]/m);
    assert.match(block, /^          severity: (warning|critical)$/m);
    assert.match(block, /^          service: eduos$/m);
    assert.match(block, /^          summary: .+/m);
    assert.match(block, /^          description: .+/m);
    assert.match(block, /^          runbook: docs\/OPERATIONS-QUEUE-ALERTS\.md$/m);
  }
});

test("queue alerts retain the documented operational thresholds and failure states", async () => {
  const rules = await read("../monitoring/eduos-alerts.yml");
  assert.match(rules, /eduos_queue_oldest_ready_seconds\{queue="webhook"\} > 300/);
  assert.match(rules, /eduos_queue_oldest_ready_seconds\{queue="notification"\} > 120/);
  assert.match(rules, /eduos_queue_jobs\{queue="webhook",state="dead_letter"\} > 0/);
  assert.match(rules, /eduos_queue_jobs\{queue="notification",state="failed"\} > 0/);
  assert.match(rules, /eduos_queue_backlog_up == 0/);
  assert.match(rules, /eduos_db_pool_connections\{state="waiting"\} > 0/);
});

test("alert rules and runbook do not introduce learner or district identifiers as metric labels", async () => {
  const [rules, runbook] = await Promise.all([
    read("../monitoring/eduos-alerts.yml"),
    read("../docs/OPERATIONS-QUEUE-ALERTS.md")
  ]);
  assert.doesNotMatch(rules, /\b(student|learner|recipient|district_id|school_id|webhook_url)=/i);
  assert.match(runbook, /do not label samples by district, school, student, recipient/i);
  assert.match(runbook, /skipped.*not delivered/is);
  assert.match(runbook, /at-least-once delivery/i);
});
