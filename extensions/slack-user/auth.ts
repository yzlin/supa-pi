import { randomUUID } from "node:crypto";
import fs, { type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const INVALID_CREDENTIAL =
  "Slack saved credential is unavailable or unsafe. Check its ownership, permissions and JSON format.";
const USER_TOKEN = /^xoxp-[A-Za-z0-9-]+$/;

export function isUserToken(value: unknown): value is string {
  return typeof value === "string" && USER_TOKEN.test(value);
}

function statIfPresent(path: string): Stats | undefined {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function checkAncestors(path: string): void {
  let current = resolve(path);
  while (true) {
    const stat = statIfPresent(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(INVALID_CREDENTIAL);
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

function checkOwner(stat: Stats): void {
  if (stat.uid !== process.getuid?.()) {
    throw new Error(INVALID_CREDENTIAL);
  }
}

function checkDirectory(path: string): void {
  const stat = fs.lstatSync(path);
  checkOwner(stat);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode % 4096 !== 0o700
  ) {
    throw new Error(INVALID_CREDENTIAL);
  }
}

function checkFile(stat: Stats): void {
  checkOwner(stat);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.mode % 4096 !== 0o600
  ) {
    throw new Error(INVALID_CREDENTIAL);
  }
}

function locations() {
  const agentDir = resolve(getAgentDir());
  checkAncestors(agentDir);
  const agentStat = statIfPresent(agentDir);
  if (agentStat) {
    checkOwner(agentStat);
    const group = Math.floor(agentStat.mode / 0o10) % 0o10;
    const other = agentStat.mode % 0o10;
    if ([2, 3, 6, 7].includes(group) || [2, 3, 6, 7].includes(other)) {
      throw new Error(INVALID_CREDENTIAL);
    }
  }
  const directory = join(agentDir, "slack-user");
  if (statIfPresent(directory)) {
    checkDirectory(directory);
  }
  const file = join(directory, "auth.json");
  const stat = statIfPresent(file);
  if (stat) {
    checkFile(stat);
  }
  return { agentDir, directory, file, exists: Boolean(stat) };
}

export function loadSavedToken(): string | undefined {
  try {
    const { file, exists } = locations();
    if (!exists) {
      return undefined;
    }
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY + fs.constants.O_NOFOLLOW,
    );
    try {
      checkFile(fs.fstatSync(fd));
      const value: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (
        typeof value !== "object" ||
        value === null ||
        !("token" in value) ||
        !isUserToken(value.token)
      ) {
        throw new Error(INVALID_CREDENTIAL);
      }
      return value.token;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw new Error(INVALID_CREDENTIAL);
  }
}

export function resolveUserToken(): string {
  const environment = process.env.SLACK_USER_TOKEN?.trim();
  if (environment) {
    return environment;
  }
  const saved = loadSavedToken();
  if (saved) {
    return saved;
  }
  throw new Error(
    "Missing SLACK_USER_TOKEN or saved Slack credential. Run /slack-user init in the interactive terminal.",
  );
}

export function saveUserToken(token: string): void {
  let temporary: string | undefined;
  let fd: number | undefined;
  try {
    if (!isUserToken(token)) {
      throw new Error(INVALID_CREDENTIAL);
    }
    const { agentDir, directory, file } = locations();
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    locations();
    const candidate = join(directory, `.auth-${randomUUID()}.tmp`);
    fd = fs.openSync(
      candidate,
      fs.constants.O_WRONLY +
        fs.constants.O_CREAT +
        fs.constants.O_EXCL +
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    temporary = candidate;
    checkFile(fs.fstatSync(fd));
    fs.writeFileSync(fd, `${JSON.stringify({ token })}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Recheck before replacement; never chmod or truncate an existing credential.
    locations();
    fs.renameSync(temporary, file);
    temporary = undefined;
  } catch {
    let cleanupFailed = false;
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        cleanupFailed = true;
      }
    }
    if (temporary) {
      // Only the exclusive temporary file created by this operation is removed.
      try {
        fs.unlinkSync(temporary);
      } catch {
        cleanupFailed = true;
      }
    }
    throw new Error(
      cleanupFailed
        ? "Slack credential save failed; private temporary cleanup failed."
        : "Slack credential save failed. Existing credentials were not changed.",
    );
  }
}
