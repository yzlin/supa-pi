// SupaPi addition: child confirm/select/input relayed to the parent UI over a private per-run Unix socket.
import { randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./agents";

export type ParentUI = Pick<ExtensionUIContext, "confirm" | "select" | "input">;
export type RelayUI = Pick<
  ExtensionUIContext,
  "confirm" | "select" | "input" | "editor" | "custom" | "notify"
>;
type DialogKind = "confirm" | "select" | "input";
type DialogBody = { title: string } & (
  | { kind: "confirm"; message: string }
  | { kind: "select"; options: string[] }
  | { kind: "input"; placeholder?: string }
);
export type DialogRequest = { type: "dialog"; id: string } & DialogBody;
export type ChildMessage = DialogRequest | { type: "cancel"; id: string };
export interface DialogAnswer {
  type: "answer";
  id: string;
  value: boolean | string | null;
  /** Parent could not show it (no UI, aborted, malformed); the child denies at once. */
  unavailable?: true;
  /** Set when the parent rejected the request itself as malformed or unsupported. */
  reason?: "malformed";
}
export const RELAY_LIMITS = {
  line: 128 * 1024,
  id: 64,
  title: 500,
  message: 8000,
  options: 100,
  option: 500,
  placeholder: 500,
};

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
function bounded(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit;
}
export function parseChildMessage(
  line: string,
): ChildMessage | { error: string; id?: string; kind?: DialogKind } {
  const raw = parseLine(line);
  if (!isRecord(raw) || !bounded(raw.id, RELAY_LIMITS.id) || !raw.id) {
    return { error: "Malformed relay message" };
  }
  const id = raw.id;
  if (raw.type === "cancel") {
    return { type: "cancel", id };
  }
  const kind =
    raw.kind === "confirm" || raw.kind === "select" || raw.kind === "input"
      ? raw.kind
      : undefined;
  if (raw.type !== "dialog" || !kind) {
    return { error: "Unsupported relay message", id };
  }
  const malformed: { error: string; id: string; kind: DialogKind } = {
    error: `Malformed ${kind} dialog`,
    id,
    kind,
  };
  if (!bounded(raw.title, RELAY_LIMITS.title)) {
    return malformed;
  }
  if (kind === "confirm") {
    return bounded(raw.message, RELAY_LIMITS.message)
      ? { type: "dialog", id, kind, title: raw.title, message: raw.message }
      : malformed;
  }
  if (kind === "select") {
    const options = raw.options;
    return Array.isArray(options) &&
      options.length > 0 &&
      options.length <= RELAY_LIMITS.options &&
      options.every((option) => bounded(option, RELAY_LIMITS.option))
      ? { type: "dialog", id, kind, title: raw.title, options }
      : malformed;
  }
  const placeholder = raw.placeholder;
  return placeholder === undefined ||
    bounded(placeholder, RELAY_LIMITS.placeholder)
    ? {
        type: "dialog",
        id,
        kind,
        title: raw.title,
        placeholder: typeof placeholder === "string" ? placeholder : undefined,
      }
    : malformed;
}
export function parseAnswer(line: string): DialogAnswer | undefined {
  const raw = parseLine(line);
  if (!isRecord(raw) || raw.type !== "answer" || typeof raw.id !== "string") {
    return;
  }
  let value: DialogAnswer["value"] = null;
  if (typeof raw.value === "boolean" || typeof raw.value === "string") {
    value = raw.value;
  } else if (raw.value !== null) {
    return;
  }
  return {
    type: "answer",
    id: raw.id,
    value,
    ...(raw.unavailable === true ? { unavailable: true as const } : {}),
    ...(raw.reason === "malformed" ? { reason: "malformed" as const } : {}),
  };
}
/** Split newline-delimited input; an over-long line closes the connection, which denies its dialogs. */
function lineReader(socket: Socket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.length > RELAY_LIMITS.line) {
        socket.destroy();
        return;
      }
      onLine(line);
      index = buffer.indexOf("\n");
    }
    if (buffer.length > RELAY_LIMITS.line) {
      socket.destroy();
    }
  });
  // Errors always end in close; never let them reach the process.
  socket.on("error", () => undefined);
}
/** Child text is untrusted: no control, escape or bidi-override characters reach the parent TUI. */
function plain(value: string, multiline = false): string {
  let text = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const unsafe =
      (code < 0x20 && !(multiline && char === "\n")) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x20_2a && code <= 0x20_2e) ||
      (code >= 0x20_66 && code <= 0x20_69);
    text += unsafe ? " " : char;
  }
  return text;
}
async function show(
  ui: ParentUI,
  request: DialogRequest,
  label: string,
  signal: AbortSignal,
): Promise<boolean | string | null> {
  const title = `${label}${plain(request.title)}`;
  if (request.kind === "confirm") {
    return ui.confirm(title, plain(request.message, true), { signal });
  }
  if (request.kind === "select") {
    const shown = request.options.map((option) => plain(option));
    const index = shown.indexOf(
      (await ui.select(title, shown, { signal })) ?? "",
    );
    return index >= 0 ? request.options[index] : null;
  }
  const placeholder =
    request.placeholder === undefined ? undefined : plain(request.placeholder);
  return (await ui.input(title, placeholder, { signal })) ?? null;
}
export interface DialogRelay {
  close(): Promise<void>;
}
/**
 * Parent side: listen on `socketPath` (inside a private 0700 directory) and show child dialogs through
 * `parentUI()`, read per request because Pi replaces ctx.ui on rebind. Never throws after listening.
 */
export async function startDialogRelay(
  socketPath: string,
  options: {
    label: string;
    parentUI: () => ParentUI | undefined;
    signal?: AbortSignal;
  },
): Promise<DialogRelay> {
  const closed = new AbortController();
  const stop = options.signal
    ? AbortSignal.any([closed.signal, options.signal])
    : closed.signal;
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    const pending = new Map<string, AbortController>();
    const send = (answer: DialogAnswer) => {
      if (socket.writable) {
        socket.write(`${JSON.stringify(answer)}\n`);
      }
    };
    const deny = (id: string, kind?: DialogKind, malformed = false) =>
      send({
        type: "answer",
        id,
        value: kind === "confirm" ? false : null,
        unavailable: true,
        ...(malformed ? { reason: "malformed" as const } : {}),
      });
    lineReader(socket, (line) => {
      const message = parseChildMessage(line);
      if ("error" in message) {
        if (message.id) {
          deny(message.id, message.kind, true);
        }
        return;
      }
      if (message.type === "cancel") {
        pending.get(message.id)?.abort();
        pending.delete(message.id);
        return;
      }
      let ui: ParentUI | undefined;
      try {
        ui = options.parentUI();
      } catch {
        // A stale parent ctx throws; treat it as no UI.
      }
      if (!ui || stop.aborted || pending.has(message.id)) {
        deny(message.id, message.kind);
        return;
      }
      const controller = new AbortController();
      pending.set(message.id, controller);
      const signal = AbortSignal.any([controller.signal, stop]);
      void show(ui, message, options.label, signal)
        .catch(() => null)
        .then((value) => {
          // A cancelled request needs no answer; the child already settled it.
          if (pending.get(message.id) !== controller) {
            return;
          }
          pending.delete(message.id);
          if (signal.aborted) {
            deny(message.id, message.kind);
          } else {
            send({
              type: "answer",
              id: message.id,
              value: value ?? (message.kind === "confirm" ? false : null),
            });
          }
        });
    });
    socket.on("close", () => {
      connections.delete(socket);
      for (const controller of pending.values()) {
        controller.abort();
      }
      pending.clear();
    });
  });
  server.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const close = async () => {
    closed.abort();
    for (const socket of connections) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch((error: unknown) => {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
  };
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    await close();
    throw error;
  }
  return { close };
}

const relayed = new WeakSet<RelayUI>();
/**
 * Child side: wrap the shared ctx.ui in place (idempotent). confirm/select/input show locally and in the
 * parent; the first answer wins and the other copy is cancelled. editor/custom resolve undefined unseen.
 * An unavailable relay denies immediately with a notice instead of waiting on an unanswerable dialog.
 * A request the parent would reject as malformed (e.g. a select over RELAY_LIMITS) shows only locally.
 */
export function relayDialogs(
  ui: RelayUI,
  socketPath: string | undefined,
): void {
  if (relayed.has(ui)) {
    return;
  }
  relayed.add(ui);
  const { confirm, select, input } = ui;
  const notice = (title: string, reason: string) =>
    ui.notify(
      `Subagent dialog "${title.slice(0, 80)}" denied: parent ${reason}.`,
      "warning",
    );
  const ask = <T>(
    body: DialogBody,
    deny: T,
    read: (value: boolean | string | null) => T,
    local: (signal: AbortSignal | undefined) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> => {
    if (callerSignal?.aborted) {
      return Promise.resolve(deny);
    }
    if (!socketPath) {
      notice(body.title, "relay is not configured");
      return Promise.resolve(deny);
    }
    const id = randomUUID();
    const request = JSON.stringify({ type: "dialog", id, ...body });
    if (
      request.length > RELAY_LIMITS.line ||
      "error" in parseChildMessage(request)
    ) {
      return local(callerSignal);
    }
    return new Promise<T>((resolve) => {
      const localAbort = new AbortController();
      let settled = false;
      let answered = false;
      let connected = false;
      const socket = createConnection(socketPath);
      const finish = (value: T, reason?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        callerSignal?.removeEventListener("abort", onAbort);
        localAbort.abort();
        if (!answered && socket.writable) {
          socket.write(`${JSON.stringify({ type: "cancel", id })}\n`);
        }
        socket.end();
        if (reason) {
          notice(body.title, reason);
        }
        resolve(value);
      };
      const onAbort = () => finish(deny);
      callerSignal?.addEventListener("abort", onAbort, { once: true });
      // Written before connect so the request always precedes any cancel.
      socket.write(`${request}\n`);
      socket.on("connect", () => {
        connected = true;
      });
      lineReader(socket, (line) => {
        const answer = parseAnswer(line);
        if (answer?.id !== id) {
          return;
        }
        answered = true;
        if (answer.unavailable) {
          finish(
            deny,
            answer.reason === "malformed"
              ? "rejected the dialog as malformed"
              : "has no UI or aborted",
          );
        } else {
          finish(read(answer.value));
        }
      });
      socket.on("close", () =>
        finish(
          deny,
          connected ? "relay disconnected" : "relay connection failed",
        ),
      );
      const signal = callerSignal
        ? AbortSignal.any([localAbort.signal, callerSignal])
        : localAbort.signal;
      local(signal).then(
        (value) => finish(value),
        () => finish(deny),
      );
    });
  };
  ui.confirm = (title, message, opts) =>
    ask(
      {
        kind: "confirm",
        title: title.slice(0, RELAY_LIMITS.title),
        message: message.slice(0, RELAY_LIMITS.message),
      },
      false,
      (value) => value === true,
      (signal) => confirm.call(ui, title, message, { ...opts, signal }),
      opts?.signal,
    );
  ui.select = (title, options, opts) =>
    ask<string | undefined>(
      { kind: "select", title: title.slice(0, RELAY_LIMITS.title), options },
      undefined,
      (value) =>
        typeof value === "string" && options.includes(value)
          ? value
          : undefined,
      (signal) => select.call(ui, title, options, { ...opts, signal }),
      opts?.signal,
    );
  ui.input = (title, placeholder, opts) =>
    ask<string | undefined>(
      {
        kind: "input",
        title: title.slice(0, RELAY_LIMITS.title),
        placeholder: placeholder?.slice(0, RELAY_LIMITS.placeholder),
      },
      undefined,
      (value) => (typeof value === "string" ? value : undefined),
      (signal) => input.call(ui, title, placeholder, { ...opts, signal }),
      opts?.signal,
    );
  // Not relayed: a child pane nobody watches must not wait on them.
  ui.editor = async () => undefined;
  ui.custom = async () => undefined;
}
