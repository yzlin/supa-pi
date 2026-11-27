/**
 * Program Resume (OSC 7577): tell the terminal how to reopen this chat.
 *
 * On every session start, reports `pi --session-id <id>` with the session's
 * directory, signed with the terminal's OSC7577_TOKEN. Reports nothing when
 * the token is absent or the session is not saved.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-resume
 */

import { createHash } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOKEN_ENV = "OSC7577_TOKEN";
// Survives extension re-imports on /reload and session switches, after the
// env var is gone.
const TOKEN_KEY = Symbol.for("supa-pi.program-resume.token");

interface ReportFields {
  pid: number;
  time: number;
  token: string;
  argv?: string[];
  cwd?: string;
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Build one OSC 7577 sequence: an `argv` report, or `clear` without argv. */
export function buildReport(fields: ReportFields): string {
  const pairs = [`pid=${fields.pid}`, `time=${fields.time}`];
  if (fields.argv) {
    pairs.push(`argv=${fields.argv.map(b64).join(",")}`);
    if (fields.cwd) {
      pairs.push(`cwd=${b64(fields.cwd)}`);
    }
  } else {
    pairs.push("clear=1");
  }
  const body = pairs.join(":");
  const mac = createHash("sha256")
    .update(`${body}:${fields.token}`)
    .digest("hex");
  return `\x1b]7577;${body}:mac=${mac}\x1b\\`;
}

/** Take the token out of the environment so child processes cannot report. */
function takeToken(): string | undefined {
  const store = globalThis as Record<symbol, string | undefined>;
  const fromEnv = process.env[TOKEN_ENV];
  if (fromEnv) {
    store[TOKEN_KEY] = fromEnv;
    delete process.env[TOKEN_ENV];
  }
  return store[TOKEN_KEY];
}

export default function programResume(pi: ExtensionAPI): void {
  const token = takeToken();
  if (!token) {
    return;
  }

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }
    const session = ctx.sessionManager;
    const time = Math.floor(Date.now() / 1000);
    // --no-session has nothing to reopen; drop any earlier command. A new
    // empty session is fine: --session-id recreates it if never written.
    const report = session.getSessionFile()
      ? buildReport({
          pid: process.pid,
          time,
          token,
          argv: ["pi", "--session-id", session.getSessionId()],
          cwd: session.getCwd(),
        })
      : buildReport({ pid: process.pid, time, token });
    process.stdout.write(report);
  });
}
