import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { resolveAgentDir } from "./credentials";

export class RouterConfigStore {
  readonly #directory: string;
  constructor(
    options: {
      agentDir?: string;
      env?: Record<string, string | undefined>;
    } = {}
  ) {
    const env = options.env ?? process.env;
    this.#directory = join(
      options.agentDir ?? resolveAgentDir(env.PI_CODING_AGENT_DIR),
      "skill-router"
    );
  }
  get path(): string {
    return join(this.#directory, "config.json");
  }
  async load(): Promise<boolean> {
    try {
      const [directory, file] = await Promise.all([
        lstat(this.#directory),
        lstat(this.path),
      ]);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        !file.isFile() ||
        file.isSymbolicLink() ||
        unsafe(directory.mode) ||
        unsafe(file.mode)
      ) {
        throw new Error("unsafe");
      }
      const flags =
        constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK;
      const handle = await open(this.path, flags);
      let parsed: unknown;
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.size > 128 || unsafe(current.mode)) {
          throw new Error("invalid");
        }
        const buffer = Buffer.alloc(current.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== current.size) {
          throw new Error("invalid");
        }
        parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await handle.close();
      }
      if (!isConfig(parsed)) {
        throw new Error("invalid");
      }
      return parsed.enabled;
    } catch (error) {
      if (errno(error, "ENOENT")) {
        return false;
      }
      throw new Error("Skill router config is unusable");
    }
  }
  async save(enabled: boolean): Promise<void> {
    await secureDirectory(this.#directory);
    // Refuse to replace an existing invalid or unsafe file.
    try {
      await this.load();
    } catch (error) {
      if (!errno(error, "ENOENT")) {
        throw error;
      }
    }
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
    typeof Reflect.get(value, "enabled") === "boolean"
  );
}
function unsafe(mode: number): boolean {
  return process.platform !== "win32" && mode % 0o100 !== 0;
}
function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
async function secureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Skill router state is unsafe");
  }
  await chmod(directory, 0o700);
}
