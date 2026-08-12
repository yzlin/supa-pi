import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import notifyExtension from "./notify";

type TestRuntime = NonNullable<Parameters<typeof notifyExtension>[1]>;

const oscNotification = "\u001b]777;notify;π;Finished\u0007";

const createChild = () =>
  Object.assign(new EventEmitter(), { unref: mock(() => undefined) });

const registerAgentEnd = (runtime: TestRuntime) => {
  let handler: ((event: { messages?: unknown[] }) => void) | undefined;
  const pi = {
    on(event: string, callback: typeof handler) {
      if (event === "agent_end") {
        handler = callback;
      }
    },
  } as unknown as ExtensionAPI;

  notifyExtension(pi, runtime);
  expect(handler).toBeDefined();
  return handler!;
};

describe("notify extension", () => {
  it("is registered in package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as { pi: { extensions: string[] } };

    expect(packageJson.pi.extensions).toContain("./extensions/notify.ts");
  });

  it("uses Ghostty-targeted AppleScript on macOS", () => {
    const child = createChild();
    const spawn = mock(
      (_command: string, _args: string[], _options: { stdio: "ignore" }) =>
        child
    );
    const write = mock(() => undefined);
    const handler = registerAgentEnd({
      platform: "darwin",
      termProgram: "ghostty",
      spawn,
      write,
    });

    handler({ messages: [{ role: "assistant", content: "Finished" }] });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe("/usr/bin/osascript");
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "-e",
      expect.stringContaining('tell application "Ghostty"'),
      "--",
      "π",
      "Finished",
    ]);
    child.emit("close", 0);
    expect(write).not.toHaveBeenCalled();
  });

  it("falls back to OSC 777 when AppleScript fails to spawn", () => {
    const child = createChild();
    const write = mock(() => undefined);
    const handler = registerAgentEnd({
      platform: "darwin",
      termProgram: "ghostty",
      spawn: mock(() => child),
      write,
    });

    handler({ messages: [{ role: "assistant", content: "Finished" }] });
    child.emit("error", new Error("spawn failed"));

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(oscNotification);
  });

  it("falls back to OSC 777 when AppleScript exits unsuccessfully", () => {
    const child = createChild();
    const write = mock(() => undefined);
    const handler = registerAgentEnd({
      platform: "darwin",
      termProgram: "ghostty",
      spawn: mock(() => child),
      write,
    });

    handler({ messages: [{ role: "assistant", content: "Finished" }] });
    child.emit("close", 1);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(oscNotification);
  });

  it("keeps OSC 777 elsewhere", () => {
    const spawn = mock(
      (_command: string, _args: string[], _options: { stdio: "ignore" }) =>
        createChild()
    );
    const write = mock(() => undefined);
    const handler = registerAgentEnd({
      platform: "linux",
      termProgram: "ghostty",
      spawn,
      write,
    });

    handler({ messages: [{ role: "assistant", content: "Finished" }] });

    expect(spawn).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(oscNotification);
  });
});
