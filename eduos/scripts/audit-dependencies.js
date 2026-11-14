#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = path.join(root, 'artifacts', 'dependency-audit');
const reportPath = path.join(reportDir, 'npm-audit.json');
fs.mkdirSync(reportDir, { recursive: true });

const result = spawnSync('npm', ['audit', '--json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  env: { ...process.env, npm_config_audit: 'true', npm_config_fund: 'false' }
});
let audit;
try {
  audit = JSON.parse(result.stdout || '{}');
} catch {
  audit = {
    error: 'npm audit did not return valid JSON',
    stderr: (result.stderr || '').slice(0, 12000),
    exitCode: result.status,
    signal: result.signal || null
  };
}

if (!audit.error && !audit.metadata?.vulnerabilities) {
  audit = { error: 'npm audit response is missing vulnerability metadata', stderr: (result.stderr || '').slice(0, 12000), exitCode: result.status };
}
const metadata = audit.metadata?.vulnerabilities || {};
const summary = {
  generatedAt: new Date().toISOString(),
  command: 'npm audit --json',
  status: audit.error ? 'unavailable' : (result.status === 0 ? 'clean' : 'findings-or-error'),
  exitCode: result.status,
  vulnerabilities: {
    info: metadata.info || 0,
    low: metadata.low || 0,
    moderate: metadata.moderate || 0,
    high: metadata.high || 0,
    critical: metadata.critical || 0,
    total: metadata.total || 0
  },
  advisories: Object.entries(audit.vulnerabilities || {}).map(([name, item]) => ({
    name,
    severity: item.severity || 'unknown',
    isDirect: Boolean(item.isDirect),
    range: item.range || null,
    fixAvailable: item.fixAvailable ?? null,
    via: (item.via || []).map(v => typeof v === 'string' ? v : ({
      name: v.name || null,
      title: v.title || null,
      url: v.url || null,
      range: v.range || null
    }))
  })),
  ...(audit.error ? { error: audit.error, stderr: audit.stderr } : {})
};
fs.writeFileSync(reportPath, JSON.stringify({ summary, raw: audit }, null, 2) + '\n');
console.log(`Dependency audit status: ${summary.status}`);
console.log(`Vulnerabilities: ${summary.vulnerabilities.total} total; ${summary.vulnerabilities.high} high; ${summary.vulnerabilities.critical} critical`);
console.log(`Report: ${path.relative(root, reportPath)}`);

if (audit.error || result.error || result.status === null) process.exit(2);
if (summary.vulnerabilities.high > 0 || summary.vulnerabilities.critical > 0) process.exit(1);
