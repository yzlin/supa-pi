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

const createRuntime = (overrides: Partial<TestRuntime> = {}): TestRuntime => ({
  platform: "darwin",
  termProgram: "ghostty",
  notifierDirectory: "/cache/pi-agent-notifier",
  compileId: "test",
  environment: { PATH: "/bin" },
  exists: mock(() => true),
  mkdir: mock(() => undefined),
  rename: mock(() => undefined),
  remove: mock(() => undefined),
  spawn: mock(() => createChild()),
  spawnSync: mock(() => ({ status: 0 })),
  write: mock(() => undefined),
  ...overrides,
});

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

  it("uses a cached app named Pi agent on macOS", () => {
    const child = createChild();
    let appExists = false;
    const runtime = createRuntime({
      exists: mock(() => appExists),
      rename: mock(() => {
        appExists = true;
      }),
      spawn: mock(() => child),
    });
    const handler = registerAgentEnd(runtime);

    handler({ messages: [{ role: "assistant", content: "Finished" }] });

    expect(runtime.mkdir).toHaveBeenCalledWith("/cache/pi-agent-notifier", {
      recursive: true,
      mode: 0o700,
    });
    expect(runtime.spawnSync).toHaveBeenCalledWith(
      "/usr/bin/osacompile",
      [
        "-o",
        "/cache/pi-agent-notifier/.compile-test/Pi agent.app",
        "-e",
        expect.stringContaining("display notification"),
      ],
      { stdio: "ignore" }
    );
    expect(runtime.rename).toHaveBeenCalledWith(
      "/cache/pi-agent-notifier/.compile-test/Pi agent.app",
      "/cache/pi-agent-notifier/Pi agent.app"
    );
    expect(runtime.remove).toHaveBeenCalledWith(
      "/cache/pi-agent-notifier/.compile-test",
      { recursive: true, force: true }
    );
    expect(runtime.spawn).toHaveBeenCalledWith(
      "/cache/pi-agent-notifier/Pi agent.app/Contents/MacOS/applet",
      [],
      {
        stdio: "ignore",
        env: {
          PATH: "/bin",
          PI_AGENT_NOTIFICATION_TITLE: "π",
          PI_AGENT_NOTIFICATION_BODY: "Finished",
        },
      }
    );
    child.emit("close", 0);
    expect(runtime.write).not.toHaveBeenCalled();
  });

  it("uses an app published by another process after a compile race", () => {
    let existsChecks = 0;
    const runtime = createRuntime({
      exists: mock(() => {
        existsChecks += 1;
        return existsChecks > 1;
      }),
      rename: mock(() => {
        throw new Error("destination exists");
      }),
    });
    const handler = registerAgentEnd(runtime);

    handler({ messages: [{ role: "assistant", content: "Finished" }] });

    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    expect(runtime.write).not.toHaveBeenCalled();
  });

  it("keeps concurrent notification payloads isolated", () => {
    const children = [createChild(), createChild()];
    const spawn = mock(
      (
        _command: string,
        _args: string[],
        _options: { stdio: "ignore"; env?: NodeJS.ProcessEnv }
      ) => children.shift()!
    );
    const handler = registerAgentEnd(createRuntime({ spawn }));

    handler({ messages: [{ role: "assistant", content: "First" }] });
    handler({ messages: [{ role: "assistant", content: "Second" }] });

    expect(spawn.mock.calls[0]?.[2]?.env?.PI_AGENT_NOTIFICATION_BODY).toBe(
      "First"
    );
    expect(spawn.mock.calls[1]?.[2]?.env?.PI_AGENT_NOTIFICATION_BODY).toBe(
      "Second"
    );
  });

  it("falls back to OSC 777 when the app cannot be compiled", () => {
    const runtime = createRuntime({
      exists: mock(() => false),
      spawnSync: mock(() => ({ status: 1 })),
    });
    const handler = registerAgentEnd(runtime);

    handler({ messages: [{ role: "assistant", content: "Finished" }] });

    expect(runtime.write).toHaveBeenCalledWith(oscNotification);
  });

  it("falls back to OSC 777 when app setup throws", () => {
    const runtime = createRuntime({
      mkdir: mock(() => {
        throw new Error("permission denied");
      }),
    });
    const handler = registerAgentEnd(runtime);

    handler({ messages: [{ role: "assistant", content: "Finished" }] });

    expect(runtime.write).toHaveBeenCalledWith(oscNotification);
  });

  it("falls back to OSC 777 when the app fails to launch", () => {
    const child = createChild();
    const runtime = createRuntime({ spawn: mock(() => child) });
    const handler = registerAgentEnd(runtime);

    handler({ messages: [{ role: "assistant", content: "Finished" }] });
    child.emit("error", new Error("spawn failed"));

    expect(runtime.write).toHaveBeenCalledTimes(1);
    expect(runtime.write).toHaveBeenCalledWith(oscNotification);
  });

  it("falls back to OSC 777 when the app exits unsuccessfully", () => {
    const child = createChild();
    const runtime = createRuntime({ spawn: mock(() => child) });
    const handler = registerAgentEnd(runtime);

    handler({ messages: [{ role: "assistant", content: "Finished" }] });
    child.emit("close", 1);

    expect(runtime.write).toHaveBeenCalledTimes(1);
    expect(runtime.write).toHaveBeenCalledWith(oscNotification);
  });

  it("keeps OSC 777 elsewhere", () => {
    const runtime = createRuntime({ platform: "linux" });
    const handler = registerAgentEnd(runtime);

    handler({ messages: [{ role: "assistant", content: "Finished" }] });

    expect(runtime.spawn).not.toHaveBeenCalled();
    expect(runtime.write).toHaveBeenCalledWith(oscNotification);
  });
});
