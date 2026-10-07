// SupaPi additions: smoke fixtures must also work inside review workers.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("smoke isolates its parent from an inherited reviewer child marker", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      fileURLToPath(new URL("./smoke.test.ts", import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        SUPA_PI_SUBAGENT_CONFIG: "inherited-reviewer-fixture",
      },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(70_000),
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 75_000);
