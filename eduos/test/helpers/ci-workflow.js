// The CI workflow lives at the repository root's .github/ (GitHub only runs
// workflows there). In this repository the project is in eduos/, so look one
// level up first, then fall back to the project root for standalone checkouts.
import { readFileSync, existsSync } from "node:fs";

export function readCiWorkflow() {
  for (const rel of ["../../../.github/workflows/ci.yml", "../../.github/workflows/ci.yml"]) {
    const url = new URL(rel, import.meta.url);
    if (existsSync(url)) return readFileSync(url, "utf8");
  }
  throw new Error("CI workflow .github/workflows/ci.yml not found at the repository or project root");
}
