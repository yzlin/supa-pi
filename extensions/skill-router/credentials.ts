// Authentication storage is adapted from pi-typesafe (MIT); see ./LICENSE.pi-typesafe.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PRINTABLE_KEY = /^[!-~]+$/;
export type CredentialStatus =
  | { source: "environment" | "stored"; usable: true }
  | {
      source: "environment" | "stored";
      usable: false;
      reason: "invalid" | "permissions" | "unreadable";
    }
  | { source: "missing"; usable: false };
export interface ResolvedCredential {
  apiKey: string;
  source: "environment" | "stored";
}
export class CredentialStore {
  readonly #directory: string;
  readonly #env: Record<string, string | undefined>;
  constructor(
    options: {
      agentDir?: string;
      env?: Record<string, string | undefined>;
    } = {}
  ) {
    this.#env = options.env ?? process.env;
    this.#directory = join(
      options.agentDir ?? resolveAgentDir(this.#env.PI_CODING_AGENT_DIR),
      "skill-router"
    );
  }
  private get path() {
    return join(this.#directory, "auth.json");
  }
  async #readStored(): Promise<
    | { apiKey: string }
    | { reason: "missing" | "invalid" | "permissions" | "unreadable" }
  > {
    try {
      const directory = await lstat(this.#directory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        unsafe(directory.mode)
      ) {
        return { reason: "permissions" };
      }
      const flags =
        constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK;
      const handle = await open(this.path, flags);
      try {
        const file = await handle.stat();
        if (!file.isFile() || unsafe(file.mode)) {
          return { reason: "permissions" };
        }
        if (file.size > 1024) {
          return { reason: "invalid" };
        }
        const buffer = Buffer.alloc(file.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== file.size) {
          return { reason: "unreadable" };
        }
        const parsed: unknown = JSON.parse(
          buffer.subarray(0, bytesRead).toString("utf8")
        );
        const apiKey = storedKey(parsed);
        return apiKey ? { apiKey } : { reason: "invalid" };
      } finally {
        await handle.close();
      }
    } catch (error) {
      return { reason: errno(error, "ENOENT") ? "missing" : "unreadable" };
    }
  }
  async status(): Promise<CredentialStatus> {
    const environment = this.#env.TYPESAFE_API_KEY;
    if (environment !== undefined) {
      return validKey(environment)
        ? { source: "environment", usable: true }
        : { source: "environment", usable: false, reason: "invalid" };
    }
    const stored = await this.#readStored();
    if ("apiKey" in stored) {
      return { source: "stored", usable: true };
    }
    return stored.reason === "missing"
      ? { source: "missing", usable: false }
      : { source: "stored", usable: false, reason: stored.reason };
  }
  async resolve(): Promise<ResolvedCredential> {
    const environment = this.#env.TYPESAFE_API_KEY;
    if (environment !== undefined) {
      const apiKey = validKey(environment);
      if (!apiKey) {
        throw new Error("Environment credential is unusable");
      }
      return { apiKey, source: "environment" };
    }
    const stored = await this.#readStored();
    if (!("apiKey" in stored)) {
      throw new Error(
        stored.reason === "permissions"
          ? "Stored credential has unsafe permissions"
          : "Stored credential is unusable"
      );
    }
    return { apiKey: stored.apiKey, source: "stored" };
  }
  async save(value: string): Promise<void> {
    const apiKey = validKey(value);
    if (!apiKey) {
      throw new Error(
        "API key must be a valid printable key (16 to 512 characters)"
      );
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.#directory);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new Error("Credential directory is unsafe");
    }
    await chmod(this.#directory, 0o700);
    const temporary = join(this.#directory, `.auth-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ apiKey }), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async clear(): Promise<void> {
    const stored = await this.#readStored();
    if (!("apiKey" in stored) && stored.reason === "missing") {
      return;
    }
    if (!("apiKey" in stored) && stored.reason !== "invalid") {
      throw new Error("Stored credential path is unsafe or unreadable");
    }
    await rm(this.path, { force: true });
  }
}
export function resolveAgentDir(value?: string): string {
  const home = homedir();
  if (!value) {
    return join(home, ".pi", "agent");
  }
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return join(home, value.slice(2));
  }
  return value;
}
function validKey(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length >= 16 &&
    trimmed.length <= 512 &&
    PRINTABLE_KEY.test(trimmed)
    ? trimmed
    : undefined;
}
function storedKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  if (Object.keys(value).length !== 1) {
    return;
  }
  const key = Reflect.get(value, "apiKey");
  return typeof key === "string" ? validKey(key) : undefined;
}
function unsafe(mode: number) {
  return process.platform !== "win32" && mode % 0o100 !== 0;
}
function errno(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
