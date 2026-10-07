// Apache-2.0 adaptation of mitsuhiko/agent-stuff's human attachment wrapper.
// SupaPi: exact run lookup, private per-run metadata/server, no legacy targets.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./agents";

export const ATTACH_FLAG = "attach-subagent";
const runPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const parentPattern = /^[0-9a-f]{24}$/;

export function parseAttachArg(args: readonly string[]): string | undefined {
  let target: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      break;
    }
    if (arg !== `--${ATTACH_FLAG}` && !arg.startsWith(`--${ATTACH_FLAG}=`)) {
      continue;
    }
    if (target !== undefined) {
      throw new Error(`--${ATTACH_FLAG} may only be supplied once`);
    }
    const value =
      arg === `--${ATTACH_FLAG}`
        ? args[++index]
        : arg.slice(ATTACH_FLAG.length + 3);
    if (!value || value.startsWith("-")) {
      throw new Error(`--${ATTACH_FLAG} requires a run id`);
    }
    if (!runPattern.test(value)) {
      throw new Error("Invalid subagent run id (expected printed UUID)");
    }
    target = value;
  }
  return target;
}

function missing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
function privatePath(file: string, kind: "directory" | "file" | "socket") {
  const info = lstatSync(file);
  const typeMatches = {
    directory: info.isDirectory(),
    file: info.isFile(),
    socket: info.isSocket(),
  }[kind];
  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  const permissions =
    kind === "socket" ? info.mode % 64 === 0 : info.mode % 512 === expectedMode;
  if (
    !typeMatches ||
    !permissions ||
    !process.getuid ||
    info.uid !== process.getuid() ||
    (kind === "file" && info.nlink !== 1)
  ) {
    throw new Error(`Attachment ${kind} must be owner-only, without symlinks`);
  }
  return info;
}
function present(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (missing(error)) {
      return false;
    }
    throw error;
  }
}

export interface AttachTarget {
  runId: string;
  socket: string;
  session: string;
}
export function resolveAttachTarget(runId: string): AttachTarget {
  if (!runPattern.test(runId)) {
    throw new Error("Invalid subagent run id");
  }
  if (!present(getAgentDir())) {
    throw new Error("Subagent run not found");
  }
  const root = path.join(realpathSync(getAgentDir()), "subagents");
  if (!present(root)) {
    throw new Error("Subagent run not found");
  }
  privatePath(root, "directory");
  const matches: string[] = [];
  for (const parent of readdirSync(root)) {
    if (!parentPattern.test(parent)) {
      continue;
    }
    const directory = path.join(root, parent);
    privatePath(directory, "directory");
    const run = path.join(directory, runId);
    if (present(run)) {
      privatePath(run, "directory");
      matches.push(run);
    }
  }
  if (matches.length === 0) {
    throw new Error("Subagent run not found");
  }
  if (matches.length !== 1) {
    throw new Error("Ambiguous subagent run id");
  }
  const run = matches[0];
  for (const name of ["result.json", "failure.json"]) {
    const file = path.join(run, name);
    if (present(file)) {
      privatePath(file, "file");
      throw new Error("Subagent finished; live attachment is unavailable");
    }
  }
  const file = path.join(run, "attach.json");
  if (!present(file)) {
    throw new Error(
      "Attachment metadata not found; run finished or not started",
    );
  }
  const info = privatePath(file, "file");
  if (info.size > 4096) {
    throw new Error("Attachment metadata is too large");
  }
  const fd = openSync(file, constants.O_RDONLY + constants.O_NOFOLLOW);
  let raw: unknown;
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size > 4096 ||
      opened.mode !== info.mode ||
      opened.uid !== info.uid ||
      opened.nlink !== 1 ||
      !opened.isFile()
    ) {
      throw new Error("Attachment metadata changed during lookup");
    }
    try {
      const buffer = Buffer.alloc(4097);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > 4096) {
        throw new Error("Attachment metadata is too large");
      }
      raw = JSON.parse(buffer.toString("utf8", 0, bytes));
    } catch {
      throw new Error("Malformed attachment metadata");
    }
  } finally {
    closeSync(fd);
  }
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    raw.runId !== runId ||
    raw.session !== `pi-subagent-${runId}` ||
    typeof raw.socket !== "string" ||
    !path.isAbsolute(raw.socket) ||
    path.normalize(raw.socket) !== raw.socket ||
    path.basename(raw.socket) !== "s"
  ) {
    throw new Error("Malformed attachment metadata");
  }
  const directory = path.dirname(raw.socket);
  if (
    !path.basename(directory).startsWith("pi-sa-") ||
    realpathSync(path.dirname(directory)) !== realpathSync(tmpdir())
  ) {
    throw new Error("Invalid attachment socket metadata");
  }
  try {
    privatePath(directory, "directory");
    privatePath(raw.socket, "socket");
  } catch (error) {
    if (missing(error)) {
      throw new Error("Subagent finished or no longer live");
    }
    throw error;
  }
  return { runId, socket: raw.socket, session: raw.session };
}

export function attachToSubagent(runId: string): number {
  const target = resolveAttachTarget(runId);
  const sameServer =
    process.env.TMUX?.replace(/,[^,]*,[^,]*$/, "") === target.socket;
  const env = { ...process.env };
  if (!sameServer) {
    delete env.TMUX;
    delete env.TMUX_PANE;
  }
  const args = ["-S", target.socket];
  const live = spawnSync(
    "tmux",
    [...args, "has-session", "-t", target.session],
    { env, encoding: "utf8", timeout: 5000 },
  );
  const pane = spawnSync(
    "tmux",
    [
      ...args,
      "display-message",
      "-p",
      "-t",
      `${target.session}:0.0`,
      "#{pane_dead}",
    ],
    { env, encoding: "utf8", timeout: 5000 },
  );
  if (live.error || pane.error) {
    throw new Error("Failed to run tmux for live attachment");
  }
  if (live.status !== 0 || pane.status !== 0 || pane.stdout.trim() !== "0") {
    throw new Error("Subagent finished or no longer live");
  }
  const result = spawnSync(
    "tmux",
    [
      ...args,
      sameServer ? "switch-client" : "attach-session",
      "-t",
      target.session,
    ],
    { stdio: "inherit", env },
  );
  if (result.error) {
    process.stderr.write("Failed to run tmux attachment\n");
  }
  return result.status ?? 1;
}

export function attachFromCli(): void {
  let runId: string | undefined;
  try {
    runId = parseAttachArg(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Error: ${error instanceof Error ? error.message : "Invalid attachment flag"}\n`,
    );
    process.exit(2);
  }
  if (runId === undefined) {
    return;
  }
  try {
    process.exit(attachToSubagent(runId));
  } catch (error) {
    process.stderr.write(
      `Error: ${error instanceof Error ? error.message : "Subagent attachment failed"}\n`,
    );
    process.exit(1);
  }
}
