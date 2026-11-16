// Headless Chrome over the DevTools protocol (Node's own WebSocket, no extra
// dependencies), shared by the browser tests. Not a test file itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export { sleep };
export const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find(p => p && fs.existsSync(p));

// Chrome is always killed, even when it starts slowly or the test fails early:
// a live child process would keep `node --test` (and the CI job) running forever.
export async function startChrome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eduos-smoke-"));
  const proc = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"], { stdio: "ignore" });
  proc.unref();
  // Removing the profile is best effort: Chrome's helper processes can still
  // be writing into it for a moment after the kill, and a failed cleanup
  // (ENOTEMPTY) must not fail the test that used the browser. The test-end
  // hook waits for the browser to exit and retries; the process-exit hook
  // can only be synchronous.
  const kill = () => { try { proc.kill("SIGKILL"); } catch {} };
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} };
  t.after(async () => {
    kill();
    // A referenced timer keeps the event loop alive while we wait (the child
    // itself is unref'd), so the hook can't be cut short.
    if (proc.exitCode === null && proc.signalCode === null) await new Promise(r => { const t = setTimeout(r, 5000); proc.once("exit", () => { clearTimeout(t); r(); }); });
    remove();
  });
  process.once("exit", () => { kill(); remove(); });
  const portFile = path.join(dir, "DevToolsActivePort");
  for (let i = 0; i < 300 && !fs.existsSync(portFile) && proc.exitCode === null; i++) await sleep(100);
  assert.ok(fs.existsSync(portFile), `Chrome didn't start within 30 s (exit code ${proc.exitCode})`);
  return { port: Number(fs.readFileSync(portFile, "utf8").split("\n")[0]) };
}

export const withTimeout = (promise, ms, what) => Promise.race([promise, sleep(ms, undefined, { ref: false }).then(() => { throw new Error(`timed out: ${what}`); })]);

export class Page {
  static async open(chromePort) {
    const target = await withTimeout(fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: "PUT" }).then(r => r.json()), 15000, "open a tab");
    const page = new Page(new WebSocket(target.webSocketDebuggerUrl));
    await withTimeout(new Promise((resolve, reject) => { page.ws.onopen = resolve; page.ws.onerror = reject; }), 15000, "connect to the tab");
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    return page;
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
      if (msg.method === "Runtime.exceptionThrown") this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return withTimeout(new Promise(resolve => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })); }), 15000, method);
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  }
  async mainText({ timeout = 10000 } = {}) {
    const end = Date.now() + timeout;
    let text = "";
    while (Date.now() < end) {
      text = (await this.eval(`document.getElementById("main")?.innerText || ""`)) || "";
      if (this.errors.length || (text.trim() && !/^Loading/.test(text.trim()))) return text;
      await sleep(100);
    }
    return text;
  }
  close() { this.ws.close(); }
}

