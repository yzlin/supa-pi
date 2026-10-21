// SupaPi additions: offline tests for the child dialog relay.
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseAnswer,
  parseChildMessage,
  RELAY_LIMITS,
  relayDialogs,
  startDialogRelay,
  type ParentUI,
  type RelayUI,
} from "./dialog-relay";

async function socketPath(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), "pi-sa-")), "d");
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

interface Shown {
  kind: string;
  title: string;
  body?: string | string[];
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
}
/** Parent UI whose dialogs stay open until answered or aborted, like Pi. */
function fakeParent() {
  const shown: Shown[] = [];
  const open = <T>(
    kind: string,
    title: string,
    body: string | string[] | undefined,
    deny: T,
    signal?: AbortSignal,
  ) =>
    new Promise<T>((resolve) => {
      signal?.addEventListener("abort", () => resolve(deny), { once: true });
      shown.push({
        kind,
        title,
        body,
        signal,
        resolve: (value) => resolve(value as T),
      });
    });
  const ui: ParentUI = {
    confirm: (title, message, opts) =>
      open("confirm", title, message, false, opts?.signal),
    select: (title, options, opts) =>
      open<string | undefined>(
        "select",
        title,
        options,
        undefined,
        opts?.signal,
      ),
    input: (title, placeholder, opts) =>
      open<string | undefined>(
        "input",
        title,
        placeholder,
        undefined,
        opts?.signal,
      ),
  };
  return { ui, shown };
}

/** Raw child connection for protocol-level assertions. */
async function rawClient(file: string) {
  const socket = createConnection(file);
  socket.setEncoding("utf8");
  const lines: unknown[] = [];
  let buffer = "";
  let closed = false;
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    lines.push(...parts.map((line) => JSON.parse(line)));
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.on("error", () => undefined);
  await new Promise((resolve) => socket.once("connect", resolve));
  return {
    socket,
    lines,
    closed: () => closed,
    send: (value: unknown) =>
      socket.write(
        `${typeof value === "string" ? value : JSON.stringify(value)}\n`,
      ),
  };
}

function fakeChild() {
  const notices: string[] = [];
  const shown: Shown[] = [];
  const calls: string[] = [];
  const open = <T>(
    kind: string,
    title: string,
    deny: T,
    signal?: AbortSignal,
  ) =>
    new Promise<T>((resolve) => {
      signal?.addEventListener("abort", () => resolve(deny), { once: true });
      shown.push({
        kind,
        title,
        signal,
        resolve: (value) => resolve(value as T),
      });
    });
  const ui: RelayUI = {
    confirm: (title, _message, opts) =>
      open("confirm", title, false, opts?.signal),
    select: (title, _options, opts) =>
      open<string | undefined>("select", title, undefined, opts?.signal),
    input: (title, _placeholder, opts) =>
      open<string | undefined>("input", title, undefined, opts?.signal),
    editor: async () => {
      calls.push("editor");
      return "shown";
    },
    custom: async () => {
      calls.push("custom");
      throw new Error("custom shown");
    },
    notify: (message) => {
      notices.push(message);
    },
  };
  return { ui, notices, shown, calls };
}

test("child messages are validated, bounded and denied when malformed", () => {
  expect(
    parseChildMessage(
      JSON.stringify({
        type: "dialog",
        id: "a",
        kind: "confirm",
        title: "T",
        message: "M",
      }),
    ),
  ).toEqual({
    type: "dialog",
    id: "a",
    kind: "confirm",
    title: "T",
    message: "M",
  });
  expect(
    parseChildMessage(
      JSON.stringify({
        type: "dialog",
        id: "b",
        kind: "select",
        title: "T",
        options: ["x", "y"],
      }),
    ),
  ).toMatchObject({ kind: "select", options: ["x", "y"] });
  expect(
    parseChildMessage(
      JSON.stringify({ type: "dialog", id: "c", kind: "input", title: "T" }),
    ),
  ).toMatchObject({ kind: "input", placeholder: undefined });
  expect(
    parseChildMessage(JSON.stringify({ type: "cancel", id: "a" })),
  ).toEqual({ type: "cancel", id: "a" });
  const long = "x".repeat(RELAY_LIMITS.title + 1);
  for (const [raw, id, kind] of [
    ["not json", undefined, undefined],
    [JSON.stringify([1]), undefined, undefined],
    [
      JSON.stringify({ type: "dialog", kind: "confirm", title: "T" }),
      undefined,
      undefined,
    ],
    [
      JSON.stringify({
        type: "dialog",
        id: "x".repeat(RELAY_LIMITS.id + 1),
        kind: "confirm",
        title: "T",
        message: "",
      }),
      undefined,
      undefined,
    ],
    [
      JSON.stringify({
        type: "dialog",
        id: "d",
        kind: "confirm",
        title: long,
        message: "",
      }),
      "d",
      "confirm",
    ],
    [
      JSON.stringify({ type: "dialog", id: "d", kind: "confirm", title: "T" }),
      "d",
      "confirm",
    ],
    [
      JSON.stringify({
        type: "dialog",
        id: "d",
        kind: "select",
        title: "T",
        options: [],
      }),
      "d",
      "select",
    ],
    [
      JSON.stringify({
        type: "dialog",
        id: "d",
        kind: "select",
        title: "T",
        options: [1],
      }),
      "d",
      "select",
    ],
    [
      JSON.stringify({
        type: "dialog",
        id: "d",
        kind: "select",
        title: "T",
        options: Array.from({ length: RELAY_LIMITS.options + 1 }, String),
      }),
      "d",
      "select",
    ],
    [
      JSON.stringify({
        type: "dialog",
        id: "d",
        kind: "input",
        title: "T",
        placeholder: 3,
      }),
      "d",
      "input",
    ],
    [
      JSON.stringify({ type: "dialog", id: "d", kind: "editor", title: "T" }),
      "d",
      undefined,
    ],
    [JSON.stringify({ type: "answer", id: "d", value: true }), "d", undefined],
  ] as const) {
    const parsed = parseChildMessage(raw);
    if (!("error" in parsed)) {
      throw new Error(`Accepted malformed message: ${raw}`);
    }
    expect(parsed.id).toBe(id);
    expect(parsed.kind).toBe(kind);
  }
  expect(
    parseAnswer(JSON.stringify({ type: "answer", id: "a", value: true })),
  ).toEqual({ type: "answer", id: "a", value: true });
  expect(
    parseAnswer(
      JSON.stringify({
        type: "answer",
        id: "a",
        value: null,
        unavailable: true,
      }),
    ),
  ).toEqual({ type: "answer", id: "a", value: null, unavailable: true });
  expect(
    parseAnswer(
      JSON.stringify({
        type: "answer",
        id: "a",
        value: null,
        unavailable: true,
        reason: "malformed",
      }),
    ),
  ).toEqual({
    type: "answer",
    id: "a",
    value: null,
    unavailable: true,
    reason: "malformed",
  });
  expect(
    parseAnswer(
      JSON.stringify({
        type: "answer",
        id: "a",
        value: null,
        unavailable: true,
        reason: "other",
      }),
    ),
  ).toEqual({ type: "answer", id: "a", value: null, unavailable: true });
  for (const raw of [
    "{",
    JSON.stringify({ type: "answer", id: 1, value: true }),
    JSON.stringify({ type: "answer", id: "a", value: 2 }),
  ]) {
    expect(parseAnswer(raw)).toBeUndefined();
  }
});

test("parent relay listens owner-only, labels untrusted text, maps answers and removes its socket", async () => {
  const file = await socketPath();
  const parent = fakeParent();
  const relay = await startDialogRelay(file, {
    label: "Subagent worker run-1: ",
    parentUI: () => parent.ui,
  });
  expect((await stat(file)).mode % 512).toBe(0o600);
  const child = await rawClient(file);
  child.send({
    type: "dialog",
    id: "c",
    kind: "confirm",
    title: "Run \u001b[31mrm\u001b[0m?\nnow",
    message: "line1\nline2\u0007\u202e",
  });
  child.send({
    type: "dialog",
    id: "s",
    kind: "select",
    title: "Pick",
    options: ["a\u001bb", "plain"],
  });
  child.send({ type: "dialog", id: "i", kind: "input", title: "Name" });
  await tick();
  const [confirm, select, input] = parent.shown;
  expect(confirm.title).toBe("Subagent worker run-1: Run  [31mrm [0m? now");
  expect(confirm.body).toBe("line1\nline2  ");
  expect(select.body).toEqual(["a b", "plain"]);
  confirm.resolve(true);
  select.resolve("a b");
  input.resolve(undefined);
  await tick();
  expect(child.lines).toEqual([
    { type: "answer", id: "c", value: true },
    { type: "answer", id: "s", value: "a\u001bb" },
    { type: "answer", id: "i", value: null },
  ]);
  child.socket.destroy();
  await relay.close();
  await rejects(stat(file), /ENOENT/);
});

test("parent relay denies malformed, no-UI and aborted requests without crashing", async () => {
  const file = await socketPath();
  const parent = fakeParent();
  let hasUI: boolean | "stale" = false;
  const run = new AbortController();
  const relay = await startDialogRelay(file, {
    label: "L: ",
    parentUI: () => {
      if (hasUI === "stale") {
        throw new Error("stale ctx");
      }
      return hasUI ? parent.ui : undefined;
    },
    signal: run.signal,
  });
  const child = await rawClient(file);
  child.send("garbage");
  child.send({ type: "dialog", id: "m", kind: "confirm", title: 5 });
  child.send({
    type: "dialog",
    id: "n",
    kind: "select",
    title: "T",
    options: [],
  });
  child.send({
    type: "dialog",
    id: "u",
    kind: "confirm",
    title: "T",
    message: "",
  });
  await tick();
  hasUI = "stale";
  child.send({ type: "dialog", id: "s", kind: "input", title: "T" });
  await tick();
  hasUI = true;
  child.send({ type: "dialog", id: "a", kind: "input", title: "T" });
  await tick();
  expect(parent.shown).toHaveLength(1);
  run.abort();
  await tick();
  child.send({
    type: "dialog",
    id: "late",
    kind: "confirm",
    title: "T",
    message: "",
  });
  await tick();
  expect(parent.shown).toHaveLength(1);
  expect(child.lines).toEqual([
    {
      type: "answer",
      id: "m",
      value: false,
      unavailable: true,
      reason: "malformed",
    },
    {
      type: "answer",
      id: "n",
      value: null,
      unavailable: true,
      reason: "malformed",
    },
    { type: "answer", id: "u", value: false, unavailable: true },
    { type: "answer", id: "s", value: null, unavailable: true },
    { type: "answer", id: "a", value: null, unavailable: true },
    { type: "answer", id: "late", value: false, unavailable: true },
  ]);
  child.send("x".repeat(RELAY_LIMITS.line + 1));
  await tick();
  expect(child.closed()).toBe(true);
  await relay.close();
});

test("parent relay aborts the shown dialog on child cancel and on disconnect", async () => {
  const file = await socketPath();
  const parent = fakeParent();
  const relay = await startDialogRelay(file, {
    label: "L: ",
    parentUI: () => parent.ui,
  });
  const child = await rawClient(file);
  child.send({
    type: "dialog",
    id: "a",
    kind: "confirm",
    title: "T",
    message: "",
  });
  child.send({
    type: "dialog",
    id: "b",
    kind: "confirm",
    title: "T",
    message: "",
  });
  await tick();
  child.send({ type: "cancel", id: "a" });
  await tick();
  expect(parent.shown[0].signal?.aborted).toBe(true);
  expect(parent.shown[1].signal?.aborted).toBe(false);
  expect(child.lines).toEqual([]);
  child.socket.destroy();
  await tick();
  expect(parent.shown[1].signal?.aborted).toBe(true);
  await relay.close();
});

test("relay close aborts open parent dialogs", async () => {
  const file = await socketPath();
  const parent = fakeParent();
  const relay = await startDialogRelay(file, {
    label: "L: ",
    parentUI: () => parent.ui,
  });
  const child = await rawClient(file);
  child.send({
    type: "dialog",
    id: "a",
    kind: "confirm",
    title: "T",
    message: "",
  });
  await tick();
  await relay.close();
  expect(parent.shown[0].signal?.aborted).toBe(true);
  await tick();
  expect(child.closed()).toBe(true);
});

test("child relay: parent answer wins and aborts the local copy", async () => {
  const file = await socketPath();
  const parent = fakeParent();
  const relay = await startDialogRelay(file, {
    label: "Subagent generic r: ",
    parentUI: () => parent.ui,
  });
  const child = fakeChild();
  relayDialogs(child.ui, file);
  const answer = child.ui.select("Pick", ["x", "y"]);
  await tick();
  expect(child.shown[0].title).toBe("Pick");
  expect(parent.shown[0].title).toBe("Subagent generic r: Pick");
  parent.shown[0].resolve("y");
  expect(await answer).toBe("y");
  expect(child.shown[0].signal?.aborted).toBe(true);
  expect(child.notices).toEqual([]);
  await relay.close();
});

test("child relay: local answer wins (deny included) and cancels the parent copy", async () => {
  const file = await socketPath();
  const parent = fakeParent();
  const relay = await startDialogRelay(file, {
    label: "L: ",
    parentUI: () => parent.ui,
  });
  const child = fakeChild();
  relayDialogs(child.ui, file);
  const answer = child.ui.confirm("Go?", "now");
  await tick();
  child.shown[0].resolve(false);
  expect(await answer).toBe(false);
  await tick();
  expect(parent.shown[0].signal?.aborted).toBe(true);
  expect(child.notices).toEqual([]);
  const typed = child.ui.input("Name", "hint");
  await tick();
  child.shown[1].resolve("local");
  expect(await typed).toBe("local");
  await relay.close();
});

test("child relay: caller abort cancels both copies and denies", async () => {
  const file = await socketPath();
  const parent = fakeParent();
  const relay = await startDialogRelay(file, {
    label: "L: ",
    parentUI: () => parent.ui,
  });
  const child = fakeChild();
  relayDialogs(child.ui, file);
  const controller = new AbortController();
  const answer = child.ui.confirm("Go?", "now", { signal: controller.signal });
  await tick();
  controller.abort();
  expect(await answer).toBe(false);
  await tick();
  expect(child.shown[0].signal?.aborted).toBe(true);
  expect(parent.shown[0].signal?.aborted).toBe(true);
  const aborted = new AbortController();
  aborted.abort();
  expect(
    await child.ui.input("x", undefined, { signal: aborted.signal }),
  ).toBeUndefined();
  await relay.close();
});

test("child relay: unavailable relay denies immediately with a notice", async () => {
  // Not configured.
  const unconfigured = fakeChild();
  relayDialogs(unconfigured.ui, undefined);
  expect(await unconfigured.ui.confirm("A", "m")).toBe(false);
  expect(unconfigured.shown).toHaveLength(0);
  expect(unconfigured.notices).toHaveLength(1);
  // Connect failure.
  const missing = fakeChild();
  relayDialogs(missing.ui, await socketPath());
  expect(await missing.ui.select("B", ["x"])).toBeUndefined();
  expect(missing.notices).toHaveLength(1);
  // Parent without UI.
  const file = await socketPath();
  const relay = await startDialogRelay(file, {
    label: "L: ",
    parentUI: () => undefined,
  });
  const noUI = fakeChild();
  relayDialogs(noUI.ui, file);
  expect(await noUI.ui.input("C")).toBeUndefined();
  expect(noUI.notices).toEqual([
    'Subagent dialog "C" denied: parent has no UI or aborted.',
  ]);
  expect(noUI.shown[0].signal?.aborted).toBe(true);
  // Parent disconnects while open.
  const parent = fakeParent();
  const closing = await socketPath();
  const closingRelay = await startDialogRelay(closing, {
    label: "L: ",
    parentUI: () => parent.ui,
  });
  const dropped = fakeChild();
  relayDialogs(dropped.ui, closing);
  const pending = dropped.ui.confirm("D", "m");
  await tick();
  await closingRelay.close();
  expect(await pending).toBe(false);
  expect(dropped.notices).toHaveLength(1);
  await relay.close();
});

test("child relay shows an out-of-bounds select only locally", async () => {
  const file = await socketPath();
  const requests: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => requests.push(chunk));
  });
  await new Promise<void>((resolve) => server.listen(file, resolve));
  const child = fakeChild();
  relayDialogs(child.ui, file);
  const many = Array.from({ length: RELAY_LIMITS.options + 1 }, String);
  const long = ["ok", "x".repeat(RELAY_LIMITS.option + 1)];
  for (const [index, options] of [many, long].entries()) {
    const controller = new AbortController();
    const answer = child.ui.select("Pick", options, {
      signal: controller.signal,
    });
    await tick();
    expect(child.shown[index].signal).toBe(controller.signal);
    child.shown[index].resolve(options[1]);
    expect(await answer).toBe(options[1]);
  }
  await tick();
  expect(requests).toEqual([]);
  expect(child.notices).toEqual([]);
  await new Promise((resolve) => server.close(resolve));
});

test("child relay names a malformed rejection in its notice", async () => {
  const file = await socketPath();
  const server = createServer((socket: Socket) => {
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      const { id } = JSON.parse(chunk.split("\n")[0]) as { id: string };
      socket.write(
        `${JSON.stringify({ type: "answer", id, value: false, unavailable: true, reason: "malformed" })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(file, resolve));
  const child = fakeChild();
  relayDialogs(child.ui, file);
  expect(await child.ui.confirm("A", "m")).toBe(false);
  expect(child.notices).toEqual([
    'Subagent dialog "A" denied: parent rejected the dialog as malformed.',
  ]);
  expect(child.shown[0].signal?.aborted).toBe(true);
  await new Promise((resolve) => server.close(resolve));
});

test("child relay ignores foreign/garbled answers and denies an oversized stream", async () => {
  const file = await socketPath();
  const server = createServer((socket: Socket) => {
    socket.on("error", () => undefined);
    socket.write("garbage\n");
    socket.write(
      `${JSON.stringify({ type: "answer", id: "other", value: true })}\n`,
    );
    socket.write("x".repeat(RELAY_LIMITS.line + 1));
  });
  await new Promise<void>((resolve) => server.listen(file, resolve));
  const child = fakeChild();
  relayDialogs(child.ui, file);
  expect(await child.ui.confirm("A", "m")).toBe(false);
  expect(child.notices).toHaveLength(1);
  await new Promise((resolve) => server.close(resolve));
});

test("child editor/custom resolve undefined without display; wrap is idempotent", async () => {
  const child = fakeChild();
  relayDialogs(child.ui, undefined);
  const wrapped = Object.getOwnPropertyDescriptor(child.ui, "confirm")?.value;
  relayDialogs(child.ui, undefined);
  expect(Object.getOwnPropertyDescriptor(child.ui, "confirm")?.value).toBe(
    wrapped,
  );
  expect(await child.ui.editor("E")).toBeUndefined();
  expect(
    await child.ui.custom(() => {
      throw new Error("factory called");
    }),
  ).toBeUndefined();
  expect(child.calls).toEqual([]);
});
