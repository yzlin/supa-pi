import { describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SiftConfigStore } from "./config";

describe("Sift config", () => {
  it("persists global enablement atomically with owner-only permissions", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "sift-config-store-"));
    const store = new SiftConfigStore({ agentDir });
    const path = join(agentDir, "sift", "config.json");

    expect(await store.load()).toBe(false);
    await store.save(true);
    expect(await store.load()).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      enabled: true,
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode % 0o1000).toBe(0o600);
      expect((await stat(join(agentDir, "sift"))).mode % 0o1000).toBe(0o700);
    }

    await store.save(false);
    expect(await store.load()).toBe(false);
  });

  it("fails closed for invalid or unsafe persisted config", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "sift-config-invalid-"));
    const directory = join(agentDir, "sift");
    const path = join(directory, "config.json");
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify({ enabled: "yes" }));
    if (process.platform !== "win32") {
      await chmod(directory, 0o700);
      await chmod(path, 0o600);
    }
    const store = new SiftConfigStore({ agentDir });

    await expect(store.load()).rejects.toThrow("invalid");
    if (process.platform !== "win32") {
      await writeFile(path, JSON.stringify({ enabled: true }));
      await chmod(path, 0o666);
      await expect(store.load()).rejects.toThrow("unsafe permissions");
    }
  });
});
