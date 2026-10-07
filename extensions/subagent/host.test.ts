// SupaPi additions: offline tests for the Apache-2.0 subagent adaptation; see extensions/subagent/NOTICE and LICENSE.upstream.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseAgent } from "./agents";
import { createChildHost } from "./host";
import type { ChildConfig } from "./protocol";

test("skills false stays disabled even when extensions repopulate resource paths; fresh session identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "supa-subagent-skills-"));
  const skill = path.join(root, "skill");
  await mkdir(skill);
  await writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: disabled-proof\ndescription: should not be in child catalog\n---\nDISABLED_BODY",
  );
  const fake = path.join(root, "fake.ts");
  await writeFile(
    fake,
    `import { fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))}; export default pi => { pi.registerProvider(fauxProvider().provider); pi.on('resources_discover', () => ({ skillPaths: [${JSON.stringify(skill)}] })); };`,
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const config: ChildConfig = {
    version: 1,
    runId: randomUUID(),
    parentSessionId: randomUUID(),
    cwd: root,
    provider: "faux",
    model: "faux-1",
    thinking: "off",
    trusted: false,
    agent: parseAgent(
      `---\nname: worker\nextensions: [${JSON.stringify(fake)}]\nskills: false\n---\nrole`,
      path.join(root, "worker.md"),
    ),
  };
  let host;
  try {
    host = await createChildHost(config, root);
    await host.session.bindExtensions({
      mode: "print",
      shutdownHandler: () => {},
    });
    expect(host.services.resourceLoader.getSkills().skills).toEqual([]);
    expect(host.session.sessionManager.getSessionId()).toBe(config.runId);
  } finally {
    host?.session.dispose();
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
});
