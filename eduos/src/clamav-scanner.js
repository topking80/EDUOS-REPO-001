// MEDIA-01: malware scanning with ClamAV (clamd's INSTREAM command over TCP).
//
// Every upload is scanned before anyone but its uploader's own processing can
// touch it, and the processed copy is scanned again. Anything other than a
// clean answer (a detection, an error, a timeout, clamd unreachable) blocks
// the file: scanning fails closed.
import net from "node:net";

export function createClamAvScanner({ host, port = 3310, timeoutMs = 30_000, chunk = 64 * 1024 } = {}) {
  if (!host) return null;
  return Object.freeze({
    /** -> { verdict: "clean" } | { verdict: "infected", signature } | { verdict: "error", reason } */
    scan(buffer) {
      return new Promise(resolve => {
        let reply = "", done = false;
        const finish = v => { if (!done) { done = true; sock.destroy(); resolve(v); } };
        const sock = net.connect({ host, port: Number(port) });
        sock.setTimeout(timeoutMs, () => finish({ verdict: "error", reason: "timeout" }));
        sock.on("error", e => finish({ verdict: "error", reason: e.code || "connection_error" }));
        sock.on("data", d => { reply += d.toString("utf8"); if (reply.includes("\0")) parse(); });
        sock.on("end", () => parse());
        const parse = () => {
          const line = reply.replace(/\0[\s\S]*$/, "").trim();
          if (/^stream: OK$/.test(line)) return finish({ verdict: "clean" });
          const found = /^stream: (.+) FOUND$/.exec(line);
          if (found) return finish({ verdict: "infected", signature: found[1].slice(0, 200) });
          finish({ verdict: "error", reason: line ? line.slice(0, 200) : "no_reply" });
        };
        sock.on("connect", () => {
          sock.write("zINSTREAM\0");
          for (let i = 0; i < buffer.length; i += chunk) {
            const part = buffer.subarray(i, i + chunk), len = Buffer.alloc(4);
            len.writeUInt32BE(part.length); sock.write(len); sock.write(part);
          }
          sock.write(Buffer.alloc(4));
        });
      });
    }
  });
}
