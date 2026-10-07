// SupaPi additions: offline human attachment tests; see NOTICE and LICENSE.upstream.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAttachArg, resolveAttachTarget } from "./attach";

const cli = path.join(
  path.dirname(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
  ),
  "bundle",
  "cli.js",
);
const extension = fileURLToPath(new URL("./index.ts", import.meta.url));
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "supa-attach-test-"));
  const socketDirectory = await mkdtemp(path.join(tmpdir(), "pi-sa-"));
  const socket = path.join(socketDirectory, "s");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await chmod(socket, 0o600);
  const runId = randomUUID();
  const parent = path.join(root, "subagents", "a".repeat(24));
  const run = path.join(parent, runId);
  await mkdir(run, { recursive: true, mode: 0o700 });
  const metadata = {
    version: 1,
    runId,
    socket,
    session: `pi-subagent-${runId}`,
  };
  const file = path.join(run, "attach.json");
  await writeFile(file, JSON.stringify(metadata), { mode: 0o600 });
  const log = path.join(root, "tmux.jsonl");
  await writeFile(
    path.join(root, "tmux"),
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.ATTACH_LOG, JSON.stringify({args, tmux:process.env.TMUX, pane:process.env.TMUX_PANE})+'\\n');
if(args.includes('has-session')) process.exit(Number(process.env.HAS_EXIT ?? 0));
if(args.includes('display-message')) { console.log(process.env.PANE_DEAD ?? '0'); process.exit(0); }
if(process.env.READ_STDIN) console.log(readFileSync(0, 'utf8'));
console.log('ATTACHED_STDOUT'); console.error('ATTACHED_STDERR'); process.exit(23);
`,
    { mode: 0o700 },
  );
  async function invoke(args: string[], env: Record<string, string> = {}) {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "--no-extensions",
        "--extension",
        extension,
        "--no-skills",
        "--no-context-files",
        "--no-session",
        "--no-approve",
        ...args,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          SUPA_PI_SUBAGENT_CONFIG: undefined,
          PI_CODING_AGENT_DIR: root,
          PI_OFFLINE: "1",
          PATH: `${root}:${process.env.PATH}`,
          TMUX: undefined,
          TMUX_PANE: undefined,
          ATTACH_LOG: log,
          ...env,
        },
        stdin: new Blob(["CLI_STDIN"]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }
  return {
    root,
    socketDirectory,
    socket,
    server,
    runId,
    parent,
    run,
    metadata,
    file,
    log,
    invoke,
  };
}

test("exact parser respects delimiter; resolver rejects non-owner paths and absent configured agent dir", async () => {
  const f = await fixture();
  const previous = process.env.PI_CODING_AGENT_DIR;
  const getuid = process.getuid;
  try {
    expect(
      parseAttachArg(["--", "--attach-subagent", f.runId]),
    ).toBeUndefined();
    expect(parseAttachArg([`--attach-subagent=${f.runId}`])).toBe(f.runId);
    process.env.PI_CODING_AGENT_DIR = f.root;
    expect(resolveAttachTarget(f.runId)).toEqual({
      runId: f.runId,
      socket: f.socket,
      session: f.metadata.session,
    });
    process.getuid = () => -1;
    expect(() => resolveAttachTarget(f.runId)).toThrow(/owner-only/);
    process.getuid = getuid;
    process.env.PI_CODING_AGENT_DIR = path.join(f.root, "absent");
    expect(() => resolveAttachTarget(f.runId)).toThrow(/not found/);
  } finally {
    process.getuid = getuid;
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    f.server.close();
  }
});

test("native CLI attachment inherits output, preserves tmux exit, clears cross-server nesting; equals form switches same server", async () => {
  const f = await fixture();
  try {
    const attached = await f.invoke(["--attach-subagent", f.runId], {
      TMUX: "/another/socket,123,0",
      TMUX_PANE: "%7",
      READ_STDIN: "1",
    });
    expect(attached.code).toBe(23);
    expect(attached.stdout).toContain("ATTACHED_STDOUT");
    expect(attached.stdout).toContain("CLI_STDIN");
    expect(attached.stderr).toContain("ATTACHED_STDERR");
    let calls = (await readFile(f.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.at(-1)).toEqual({
      args: ["-S", f.socket, "attach-session", "-t", f.metadata.session],
    });
    const switched = await f.invoke([`--attach-subagent=${f.runId}`], {
      TMUX: `${f.socket},123,0`,
      TMUX_PANE: "%7",
    });
    expect(switched.code).toBe(23);
    calls = (await readFile(f.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.at(-1)).toEqual({
      args: ["-S", f.socket, "switch-client", "-t", f.metadata.session],
      tmux: `${f.socket},123,0`,
      pane: "%7",
    });
  } finally {
    f.server.close();
  }
}, 20_000);

test("native CLI missing/invalid values fail; delimiter leaves flag literal; help advertises string flag", async () => {
  const f = await fixture();
  try {
    for (const args of [
      ["--attach-subagent"],
      ["--attach-subagent="],
      ["--attach-subagent", "--help"],
      ["--attach-subagent", "../escape"],
      ["--attach-subagent", "--", f.runId],
      ["--attach-subagent", f.runId, `--attach-subagent=${f.runId}`],
      ["--attach-subagent", "v1.legacy"],
    ]) {
      const result = await f.invoke(args);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/requires|invalid|only/i);
    }
    const result = await f.invoke(["--help", "--", "--attach-subagent", "bad"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--attach-subagent");
  } finally {
    f.server.close();
  }
}, 30_000);

test("native CLI rejects missing, malformed, unsafe and ambiguous evidence; never attaches stale/finished children", async () => {
  for (const kind of [
    "missing",
    "missing-metadata",
    "malformed",
    "oversized",
    "mismatch",
    "invalid-socket",
    "permissions",
    "directory",
    "symlink",
    "hardlink",
    "parent-symlink",
    "run-symlink",
    "root-symlink",
    "ambiguous",
    "socket-permissions",
    "socket-symlink",
    "missing-socket",
    "tmux-unavailable",
    "stale",
    "dead",
    "finished",
    "failed",
  ] as const) {
    const f = await fixture();
    try {
      if (kind === "missing") {
        await rename(f.run, `${f.run}-hidden`);
      }
      if (kind === "missing-metadata") {
        await rename(f.file, `${f.file}.hidden`);
      }
      if (kind === "malformed") {
        await writeFile(f.file, "{broken");
      }
      if (kind === "oversized") {
        await writeFile(f.file, " ".repeat(4097));
      }
      if (kind === "invalid-socket") {
        await writeFile(
          f.file,
          JSON.stringify({ ...f.metadata, socket: "/tmp/not-owned/s" }),
        );
      }
      if (kind === "mismatch") {
        await writeFile(
          f.file,
          JSON.stringify({ ...f.metadata, session: "other" }),
        );
      }
      if (kind === "permissions") {
        await chmod(f.file, 0o644);
      }
      if (kind === "directory") {
        await chmod(f.parent, 0o755);
      }
      if (kind === "symlink") {
        await rename(f.file, `${f.file}.real`);
        await symlink(`${f.file}.real`, f.file);
      }
      if (kind === "parent-symlink") {
        await rename(f.parent, `${f.parent}.real`);
        await symlink(`${f.parent}.real`, f.parent);
      }
      if (kind === "hardlink") {
        await link(f.file, `${f.file}.linked`);
      }
      if (kind === "run-symlink") {
        await rename(f.run, `${f.run}.real`);
        await symlink(`${f.run}.real`, f.run);
      }
      if (kind === "root-symlink") {
        const root = path.dirname(f.parent);
        await rename(root, `${root}.real`);
        await symlink(`${root}.real`, root);
      }
      if (kind === "ambiguous") {
        await mkdir(path.join(f.root, "subagents", "b".repeat(24), f.runId), {
          recursive: true,
          mode: 0o700,
        });
      }
      if (kind === "socket-permissions") {
        await chmod(f.socketDirectory, 0o755);
      }
      if (kind === "socket-symlink") {
        await rename(f.socket, `${f.socket}.real`);
        await symlink(`${f.socket}.real`, f.socket);
      }
      if (kind === "missing-socket") {
        await new Promise<void>((resolve) => f.server.close(() => resolve()));
      }
      if (kind === "tmux-unavailable") {
        await chmod(path.join(f.root, "tmux"), 0o600);
      }
      if (kind === "failed") {
        await writeFile(path.join(f.run, "failure.json"), "{}", {
          mode: 0o600,
        });
      }
      if (kind === "finished") {
        await writeFile(path.join(f.run, "result.json"), "{}", { mode: 0o600 });
      }
      const env: Record<string, string> = {};
      if (kind === "stale") {
        env.HAS_EXIT = "1";
      }
      if (kind === "dead") {
        env.PANE_DEAD = "1";
      }
      if (kind === "tmux-unavailable") {
        env.PATH = f.root;
      }
      const result = await f.invoke(["--attach-subagent", f.runId], env);
      expect(result.code).not.toBe(0);
      expect(result.code).not.toBe(23);
      expect(result.stderr).toMatch(
        /not found|metadata|owner-only|symlink|ambiguous|finished|live|tmux/i,
      );
    } finally {
      f.server.close();
    }
  }
}, 60_000);
