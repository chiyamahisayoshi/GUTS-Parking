const fs = require("node:fs");
const path = require("node:path");
const { version } = require("../package.json");

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const ROTATED_LOGS = 3;
const MAX_ENTRY_BYTES = 16 * 1024;
const BEARER_PATTERN = /\b(authorization)(\s*:\s*)bearer\s+[^\s,;]+/gi;
const SECRET_PATTERN = /\b(password|passwd|token|secret|authorization|cookie|api[_-]?key)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const QUERY_SECRET_PATTERN = /([?&](?:password|token|secret|key|api_key|access_token)=)[^&#\s]*/gi;

function sanitize(value, limit) {
  return String(value ?? "")
    .replace(BEARER_PATTERN, "$1$2Bearer [REDACTED]")
    .replace(SECRET_PATTERN, "$1$2[REDACTED]")
    .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, limit);
}

class ErrorLogger {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
  }

  capture(type, error, details = {}) {
    const normalized = error instanceof Error
      ? { message: error.message, stack: error.stack }
      : { message: String(error ?? "Unknown error") };
    this.write({
      type,
      message: normalized.message,
      ...(normalized.stack ? { stack: normalized.stack } : {}),
      ...details,
    });
  }

  write(entry) {
    const record = { timestamp: new Date().toISOString(), app_version: version };
    for (const [key, value] of Object.entries(entry)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "number" && Number.isFinite(value)) {
        record[key] = value;
      } else if (typeof value === "string") {
        const safeValue = key === "path" || key === "source"
          ? value.split(/[?#]/, 1)[0]
          : value;
        record[key] = sanitize(safeValue, key === "stack" ? 6000 : 1000);
      }
    }
    let line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > MAX_ENTRY_BYTES) {
      record.stack = sanitize(record.stack, 2000);
      record.message = sanitize(record.message, 1000);
      line = `${JSON.stringify(record)}\n`;
    }
    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this.filePath, line, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      console.error("Unable to write application error log:", error.message);
    }
  }

  rotateIfNeeded(incomingBytes) {
    let size = 0;
    try {
      size = fs.statSync(this.filePath).size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (size + incomingBytes <= MAX_LOG_BYTES) return;
    fs.rmSync(`${this.filePath}.${ROTATED_LOGS}`, { force: true });
    for (let index = ROTATED_LOGS - 1; index >= 1; index -= 1) {
      const source = `${this.filePath}.${index}`;
      if (fs.existsSync(source)) fs.renameSync(source, `${this.filePath}.${index + 1}`);
    }
    if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
  }
}

module.exports = { ErrorLogger, sanitize };
