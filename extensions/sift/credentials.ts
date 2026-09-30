import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
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
  readonly #agentDir: string;
  readonly #env: Record<string, string | undefined>;

  constructor(
    options: {
      agentDir?: string;
      env?: Record<string, string | undefined>;
    } = {},
  ) {
    this.#env = options.env ?? process.env;
    this.#agentDir =
      options.agentDir ?? resolveAgentDir(this.#env.PI_CODING_AGENT_DIR);
  }

  async status(): Promise<CredentialStatus> {
    const environment = this.#env.TYPESAFE_API_KEY;
    if (environment !== undefined) {
      return validKey(environment)
        ? { source: "environment", usable: true }
        : { source: "environment", usable: false, reason: "invalid" };
    }
    try {
      if (
        process.platform !== "win32" &&
        (await stat(this.path)).mode % 0o100 !== 0
      ) {
        return { source: "stored", usable: false, reason: "permissions" };
      }
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const key = storedKey(parsed);
      return key
        ? { source: "stored", usable: true }
        : { source: "stored", usable: false, reason: "invalid" };
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return { source: "missing", usable: false };
      }
      return { source: "stored", usable: false, reason: "unreadable" };
    }
  }

  /** Internal credential-bearing operation; use status() for display. */
  async resolve(): Promise<ResolvedCredential> {
    const environment = this.#env.TYPESAFE_API_KEY;
    if (environment !== undefined) {
      const apiKey = validKey(environment);
      if (!apiKey) {
        throw new Error("Environment credential is unusable");
      }
      return { apiKey, source: "environment" };
    }
    const status = await this.status();
    if (!status.usable) {
      throw new Error(
        "reason" in status && status.reason === "permissions"
          ? "Stored credential has unsafe permissions"
          : "Stored credential is unusable",
      );
    }
    const apiKey = storedKey(JSON.parse(await readFile(this.path, "utf8")));
    if (!apiKey) {
      throw new Error("Stored credential is unusable");
    }
    return { apiKey, source: "stored" };
  }

  async save(value: string): Promise<void> {
    const apiKey = validKey(value);
    if (!apiKey) {
      throw new Error(
        "API key must be a valid printable key (16 to 512 characters)",
      );
    }
    const directory = join(this.#agentDir, "sift");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = join(directory, `.auth-${randomUUID()}.tmp`);
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
    await rm(this.path, { force: true });
  }
  private get path(): string {
    return join(this.#agentDir, "sift", "auth.json");
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
  const apiKey = (value as { apiKey?: unknown }).apiKey;
  return typeof apiKey === "string" ? validKey(apiKey) : undefined;
}
function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
