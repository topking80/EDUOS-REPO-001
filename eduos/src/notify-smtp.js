// SMTP adapter for EduOS external notifications.
// Uses implicit TLS only (port 465); credentials and message content are never logged.
import tls from "node:tls";

const validAddress = value => typeof value === "string" && value.length <= 254 && !/[\r\n<>\s]/.test(value)
  && /^[^@]+@[^@]+\.[^@]+$/.test(value);
const safeDomain = value => /^[a-z0-9.-]+$/i.test(value) ? value : "eduos.local";

function smtpError(message, code = null) {
  const error = new Error(message);
  error.smtpCode = code;
  return error;
}

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.waiters = [];
    this.failure = null;
    socket.on("data", chunk => { this.buffer += chunk.toString("utf8"); this.drain(); });
    socket.on("error", error => { this.failure = error; this.drain(); });
    socket.on("close", () => { if (!this.failure) this.failure = new Error("SMTP connection closed"); this.drain(); });
  }
  drain() {
    while (this.waiters.length) {
      const parsed = this.parseResponse();
      if (parsed) { this.waiters.shift().resolve(parsed); continue; }
      if (this.failure) { while (this.waiters.length) this.waiters.shift().reject(this.failure); }
      break;
    }
  }
  parseResponse() {
    const lines = this.buffer.split("\r\n");
    if (lines.length < 2) return null;
    const first = /^(\d{3})([- ])/.exec(lines[0]);
    if (!first) return null;
    const code = Number(first[1]);
    let end = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      if (new RegExp("^" + code + " ").test(lines[i])) { end = i; break; }
    }
    if (end < 0) return null;
    const response = { code, text: lines.slice(0, end + 1).join("\n") };
    this.buffer = lines.slice(end + 1).join("\r\n");
    return response;
  }
  response() {
    const parsed = this.parseResponse();
    if (parsed) return Promise.resolve(parsed);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  async command(value, expected) {
    this.socket.write(value + "\r\n");
    const result = await this.response();
    if (!expected.includes(result.code)) throw smtpError("SMTP command rejected (" + result.code + ")", result.code);
    return result;
  }
  async data(value) {
    this.socket.write(value.replace(/\r?\n/g, "\r\n") + "\r\n.\r\n");
    const result = await this.response();
    if (result.code !== 250) throw smtpError("SMTP message rejected (" + result.code + ")", result.code);
    return result;
  }
}

export function buildNotificationMessage({ id, from, to, domain }) {
  if (!validAddress(from) || !validAddress(to)) throw new TypeError("SMTP sender and recipient must be valid email addresses");
  if (typeof id !== "string" || !/^[0-9a-f-]{16,64}$/i.test(id)) throw new TypeError("notification id is invalid");
  const messageDomain = safeDomain(domain || from.split("@")[1]);
  const lines = [
    "From: <" + from + ">", "To: <" + to + ">", "Subject: EduOS notification",
    "Message-ID: <" + id + "@" + messageDomain + ">", "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "",
    "You have a new EduOS notification.", "Open the EduOS app to read it."
  ];
  return lines.join("\r\n").replace(/\n\./g, "\n..");
}

export function createSmtpAdapter({ config, connect = tls.connect }) {
  return Object.freeze({
    name: "smtp",
    async send(row) {
      const from = config.notifySmtpFrom;
      const to = row.recipient_email;
      if (!validAddress(to)) return { status: "failed", note: "recipient email address is missing or invalid" };
      let socket;
      try {
        socket = connect({ host: config.notifySmtpHost, port: config.notifySmtpPort, servername: config.notifySmtpHost, rejectUnauthorized: true });
        socket.setTimeout(config.notifySmtpTimeoutMs, () => socket.destroy(new Error("SMTP connection timed out")));
        const session = new SmtpSession(socket);
        const greeting = await session.response();
        if (greeting.code !== 220) throw smtpError("SMTP greeting rejected (" + greeting.code + ")", greeting.code);
        await session.command("EHLO " + safeDomain(config.notifySmtpEhlo), [250]);
        const auth = Buffer.from("\0" + config.notifySmtpUsername + "\0" + config.notifySmtpPassword).toString("base64");
        await session.command("AUTH PLAIN " + auth, [235]);
        await session.command("MAIL FROM:<" + from + ">", [250]);
        await session.command("RCPT TO:<" + to + ">", [250, 251]);
        await session.command("DATA", [354]);
        await session.data(buildNotificationMessage({ id: row.id, from, to, domain: config.notifySmtpEhlo }));
        await session.command("QUIT", [221]);
        return { status: "accepted", note: "accepted by SMTP relay; mailbox delivery is not confirmed" };
      } catch (error) {
        const transient = !error.smtpCode || (error.smtpCode >= 400 && error.smtpCode < 500);
        return { status: transient ? "pending" : "failed", note: transient ? "SMTP temporary failure" : "SMTP permanent rejection (" + error.smtpCode + ")" };
      } finally {
        socket?.end();
      }
    }
  });
}
