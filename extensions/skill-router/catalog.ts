import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { EXPLICIT_ONLY_SKILLS } from "./policy";
export async function writeRecoveryCatalog(
  agentDir: string,
  skills: readonly Skill[],
): Promise<string> {
  const visible = skills
    .filter(
      (skill) =>
        !(skill.disableModelInvocation || EXPLICIT_ONLY_SKILLS.has(skill.name)),
    )
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath),
    );
  const explicit = skills
    .filter((skill) => EXPLICIT_ONLY_SKILLS.has(skill.name))
    .map((skill) => skill.name)
    .sort();
  const content = `${formatSkillsForPrompt(visible)}\n\nExplicit-only (native invocation; never auto-routed): ${explicit.join(", ") || "none"}\n`;
  if (Buffer.byteLength(content) > 65_536) {
    throw new Error("Recovery catalog limit exceeded");
  }
  const parent = join(agentDir, "skill-router");
  const directory = join(parent, "catalogs");
  for (const path of [parent, directory]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Recovery catalog directory is unsafe");
    }
    await chmod(path, 0o700);
  }
  const digest = createHash("sha256").update(content).digest("hex");
  const destination = join(directory, `${digest}.md`);
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("Recovery catalog path is unsafe");
    }
    const flags =
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK;
    const handle = await open(destination, flags);
    try {
      const stat = await handle.stat();
      if (stat.size > 65_536 || stat.size !== Buffer.byteLength(content)) {
        throw new Error("Recovery catalog content mismatch");
      }
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (
        bytesRead !== stat.size ||
        buffer.subarray(0, bytesRead).toString("utf8") !== content
      ) {
        throw new Error("Recovery catalog content mismatch");
      }
    } finally {
      await handle.close();
    }
    await chmod(destination, 0o600);
    return destination;
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  const temporary = join(directory, `.catalog-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}
