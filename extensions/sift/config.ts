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
import { join } from "node:path";

import { resolveAgentDir } from "./credentials";

export class SiftConfigStore {
  readonly #directory: string;

  constructor(
    options: {
      agentDir?: string;
      env?: Record<string, string | undefined>;
    } = {},
  ) {
    const env = options.env ?? process.env;
    const agentDir =
      options.agentDir ?? resolveAgentDir(env.PI_CODING_AGENT_DIR);
    this.#directory = join(agentDir, "sift");
  }

  private get path(): string {
    return join(this.#directory, "config.json");
  }

  async load(): Promise<boolean> {
    let contents: string;
    try {
      const [directoryInfo, fileInfo] = await Promise.all([
        stat(this.#directory),
        stat(this.path),
      ]);
      if (
        process.platform !== "win32" &&
        (directoryInfo.mode % 0o100 !== 0 || fileInfo.mode % 0o100 !== 0)
      ) {
        throw new Error("Sift config has unsafe permissions");
      }
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return false;
      }
      if (
        error instanceof Error &&
        error.message.includes("unsafe permissions")
      ) {
        throw error;
      }
      throw new Error("Sift config is unreadable", { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error("Sift config is invalid", { cause: error });
    }
    if (!isConfig(parsed)) {
      throw new Error("Sift config is invalid");
    }
    return parsed.enabled;
  }

  async save(enabled: boolean): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const temporary = join(this.#directory, `.config-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ enabled }), "utf8");
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
}

function isConfig(value: unknown): value is { enabled: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { enabled?: unknown }).enabled === "boolean"
  );
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
