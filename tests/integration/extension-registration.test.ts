import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Factory loading installs prototype hooks. Keep them out of the parent test process.
// This is registration only: no live settings, session hooks, providers, or children.
test("complete repository manifest loads through public SDK without retired delegation tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "supa-manifest-loader-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const fixture = path.join(root, "manifest-proof.ts");
  await writeFile(
    fixture,
    `import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { DefaultResourceLoader, SettingsManager } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
const repo = ${JSON.stringify(path.resolve(import.meta.dir, "../.."))};
const manifest = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
assert.equal(manifest.pi.extensions[0], './extensions/skill-router');
const loader = new DefaultResourceLoader({
  cwd: ${JSON.stringify(cwd)},
  agentDir: ${JSON.stringify(agentDir)},
  settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
  additionalExtensionPaths: manifest.pi.extensions.map(entry => path.resolve(repo, entry)),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const result = loader.getExtensions();
assert.deepEqual(result.errors, []);
assert.equal(result.extensions.length, manifest.pi.extensions.length);
const names = result.extensions.flatMap(extension => [...extension.tools.values()].map(tool => tool.definition.name));
assert.equal(new Set(names).size, names.length);
for (const name of ['subagent', 'execute_checkpoint', 'review_run', 'review_finalize', 'goal_checkpoint']) {
  assert.ok(names.includes(name), name);
}
assert.ok(!names.includes('Agent'));
assert.ok(!names.includes('SubagentWorkflow'));
assert.deepEqual(names.filter(name => name.startsWith('Task')), []);
console.log('MANIFEST_PROOF_OK');
`,
    { mode: 0o600 },
  );
  const process = Bun.spawn([Bun.which("bun") ?? "bun", fixture], {
    cwd,
    env: {
      ...globalThis.process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Isolated manifest proof failed (${exitCode}): ${stderr}\n${stdout}`,
    );
  }
  expect(stdout.trim()).toBe("MANIFEST_PROOF_OK");
}, 30_000);
