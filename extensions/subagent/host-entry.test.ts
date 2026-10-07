// SupaPi additions: regression coverage for parent-owned strict child runtimes.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAgent } from "./agents";
import type { ChildConfig } from "./protocol";

async function fixture(skills: false | string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "supa-parent-sdk-"));
  const parentPackage = path.join(root, "parent Pi package");
  const sdkEntry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  await cp(path.dirname(sdkEntry), path.join(parentPackage, "dist"), {
    recursive: true,
  });
  await copyFile(sdkEntry, path.join(parentPackage, "dist", "native-sdk.js"));
  await copyFile(
    path.resolve(path.dirname(sdkEntry), "../package.json"),
    path.join(parentPackage, "package.json"),
  );
  await symlink(
    path.resolve(path.dirname(sdkEntry), "../../.."),
    path.join(root, "node_modules"),
    "dir",
  );
  const skillPaths = ["approved", "unapproved"];
  for (const name of skillPaths) {
    await mkdir(path.join(root, name));
    await writeFile(
      path.join(root, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: fixture skill\n---\nFixture body`,
    );
  }
  const cachedEntry = path.join(
    root,
    "pi-coding-agent@checkout-version@@@1",
    "dist",
    "index.js",
  );
  await mkdir(path.dirname(cachedEntry), { recursive: true });
  await writeFile(
    cachedEntry,
    "export const VERSION = 'checkout-should-not-load';",
  );
  const provider = path.join(root, "provider.ts");
  await writeFile(
    provider,
    `import { fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { VERSION } from '@earendil-works/pi-coding-agent';
import { VERSION as cachedVersion } from ${JSON.stringify(cachedEntry)};
import { writeFileSync } from 'node:fs';
export default pi => {
 writeFileSync(${JSON.stringify(path.join(root, "extension-runtime.json"))}, JSON.stringify({version: VERSION, cachedVersion}));
 pi.registerProvider(fauxProvider().provider);
 pi.on('resources_discover', () => ({skillPaths: ${JSON.stringify(skillPaths.map((name) => path.join(root, name)))}}));
};`,
  );
  const proof = path.join(root, "runtime-proof.json");
  await writeFile(
    path.join(parentPackage, "dist", "index.js"),
    `import * as sdk from './native-sdk.js';
import { writeFileSync } from 'node:fs';
export * from './native-sdk.js';
export const VERSION = 'parent-fixture-version';
export const getPackageDir = () => ${JSON.stringify(parentPackage)};
let parsed = false;
let created = false;
let themed = false;
export const parseFrontmatter = (...args) => { parsed = true; return sdk.parseFrontmatter(...args); };
export const createAgentSessionRuntime = (...args) => { created = true; return sdk.createAgentSessionRuntime(...args); };
export const initTheme = () => { themed = true; };
export class InteractiveMode {
 constructor(host, options) { this.host = host; this.options = options; }
 async run() {
  await this.host.session.bindExtensions({mode: 'print', shutdownHandler() {}});
  writeFileSync(${JSON.stringify(proof)}, JSON.stringify({version: VERSION, packageDir: getPackageDir(), parsed, created, themed,
   task: this.options.initialMessage,
   skills: this.host.services.resourceLoader.getSkills().skills.map(skill => skill.name),
   tools: this.host.session.getActiveToolNames()}));
  this.host.session.dispose();
 }
}`,
  );
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
      `---\nname: strict\ntools: [read]\nextensions: [${JSON.stringify(provider)}]\nskills: ${JSON.stringify(skills)}\n---\nStrict role`,
      path.join(root, "strict.md"),
    ),
  };
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(root, "task.md"), "CHILD_TASK_ONLY");
  return { root, parentPackage, configPath, proof };
}

async function launch(
  configPath: string,
  root: string,
  parentPackage?: string,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./host-entry.ts", import.meta.url)),
      ...(parentPackage === undefined ? [] : [parentPackage]),
    ],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: root,
        PI_OFFLINE: "1",
        PI_PACKAGE_DIR: undefined,
        SUPA_PI_SUBAGENT_CONFIG: configPath,
      },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

for (const skills of [false, ["approved"]] as const) {
  test(`strict host uses parent SDK and preserves skills ${JSON.stringify(skills)}`, async () => {
    const files = await fixture(skills === false ? false : [...skills]);
    const result = await launch(
      files.configPath,
      files.root,
      files.parentPackage,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(
      JSON.parse(
        await readFile(path.join(files.root, "extension-runtime.json"), "utf8"),
      ),
    ).toEqual({
      version: "parent-fixture-version",
      cachedVersion: "parent-fixture-version",
    });
    expect(JSON.parse(await readFile(files.proof, "utf8"))).toEqual({
      version: "parent-fixture-version",
      packageDir: files.parentPackage,
      parsed: true,
      created: true,
      themed: true,
      task: "CHILD_TASK_ONLY",
      skills: skills === false ? [] : ["approved"],
      tools: ["read"],
    });
  }, 20_000);
}

for (const parent of [undefined, "missing-parent-package"]) {
  test(`strict host fails closed with parent package ${parent}`, async () => {
    const files = await fixture(false);
    const result = await launch(
      files.configPath,
      files.root,
      parent === undefined ? undefined : path.join(files.root, parent),
    );
    expect(result.code).toBe(1);
    const error = JSON.parse(
      await readFile(path.join(files.root, "startup-error.json"), "utf8"),
    );
    expect(error.error).toMatch(
      parent === undefined
        ? /parent Pi package/i
        : /Cannot find|module|ENOENT/i,
    );
    expect(await Bun.file(files.proof).exists()).toBe(false);
  }, 20_000);
}
