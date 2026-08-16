import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import notifyExtension from "./notify";

type TestRuntime = NonNullable<Parameters<typeof notifyExtension>[1]>;

const oscNotification = "\u001b]777;notify;π;Finished\u0007";
const shownResult = JSON.stringify({ result: { shown: true } });
const createContext = () => ({
  ui: { notify: mock(() => undefined) },
});
type TestContext = ReturnType<typeof createContext>;

const createRuntime = (overrides: Partial<TestRuntime> = {}): TestRuntime => ({
  environment: {},
  execFile: mock((_command, _args, callback) => callback(null, shownResult)),
  write: mock(() => undefined),
  ...overrides,
});

const registerAgentEnd = (runtime: TestRuntime) => {
  let handler:
    | ((event: { messages?: unknown[] }, ctx?: TestContext) => void)
    | undefined;
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

const expectHerdrFailure = (runtime: TestRuntime) => {
  const handler = registerAgentEnd(runtime);
  const context = createContext();

  handler({ messages: [{ role: "assistant", content: "Finished" }] }, context);

  expect(runtime.write).not.toHaveBeenCalled();
  expect(context.ui.notify).toHaveBeenCalledWith(
    "Desktop notification failed.",
    "warning"
  );
};

describe("notify extension", () => {
  it("is registered in package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as { pi: { extensions: string[] } };

    expect(packageJson.pi.extensions).toContain("./extensions/notify.ts");
  });

  it("uses Herdr's notification API inside a Herdr pane", () => {
    const runtime = createRuntime({ environment: { HERDR_ENV: "1" } });
    const handler = registerAgentEnd(runtime);

    handler({ messages: [{ role: "assistant", content: "Finished" }] });

    expect(runtime.execFile).toHaveBeenCalledWith(
      "herdr",
      ["notification", "show", "π", "--body", "Finished", "--sound", "none"],
      expect.any(Function)
    );
    expect(runtime.write).not.toHaveBeenCalled();
  });

  it("handles empty assistant output through Herdr", () => {
    const runtime = createRuntime({ environment: { HERDR_ENV: "1" } });
    const handler = registerAgentEnd(runtime);

    handler({ messages: [] });

    expect(runtime.execFile).toHaveBeenCalledWith(
      "herdr",
      [
        "notification",
        "show",
        "Ready for input",
        "--body",
        "",
        "--sound",
        "none",
      ],
      expect.any(Function)
    );
  });

  it("normalizes rich assistant content for Herdr", () => {
    const runtime = createRuntime({ environment: { HERDR_ENV: "1" } });
    const handler = registerAgentEnd(runtime);

    handler({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "# Done\n\n[details](https://example.com) with **bold** and `code`",
            },
            { type: "toolCall" },
          ],
        },
      ],
    });

    expect(runtime.execFile).toHaveBeenCalledWith(
      "herdr",
      [
        "notification",
        "show",
        "π",
        "--body",
        "Done details with bold and code",
        "--sound",
        "none",
      ],
      expect.any(Function)
    );
  });

  it("keeps concurrent Herdr notification payloads isolated", () => {
    const runtime = createRuntime({ environment: { HERDR_ENV: "1" } });
    const handler = registerAgentEnd(runtime);

    handler({ messages: [{ role: "assistant", content: "First" }] });
    handler({ messages: [{ role: "assistant", content: "Second" }] });

    expect(runtime.execFile).toHaveBeenNthCalledWith(
      1,
      "herdr",
      ["notification", "show", "π", "--body", "First", "--sound", "none"],
      expect.any(Function)
    );
    expect(runtime.execFile).toHaveBeenNthCalledWith(
      2,
      "herdr",
      ["notification", "show", "π", "--body", "Second", "--sound", "none"],
      expect.any(Function)
    );
  });

  it("reports when Herdr does not confirm delivery", () => {
    const runtime = createRuntime({
      environment: { HERDR_ENV: "1" },
      execFile: mock((_command, _args, callback) =>
        callback(null, JSON.stringify({ result: { shown: false } }))
      ),
    });

    expectHerdrFailure(runtime);
  });

  it("reports when Herdr returns malformed output", () => {
    const runtime = createRuntime({
      environment: { HERDR_ENV: "1" },
      execFile: mock((_command, _args, callback) => callback(null, "not json")),
    });

    expectHerdrFailure(runtime);
  });

  it("reports when the Herdr command fails", () => {
    const runtime = createRuntime({
      environment: { HERDR_ENV: "1" },
      execFile: mock((_command, _args, callback) =>
        callback(new Error("herdr unavailable"), "")
      ),
    });

    expectHerdrFailure(runtime);
  });

  it("reports when the Herdr command throws", () => {
    const runtime = createRuntime({
      environment: { HERDR_ENV: "1" },
      execFile: mock(() => {
        throw new Error("herdr unavailable");
      }),
    });

    expectHerdrFailure(runtime);
  });

  it("uses OSC 777 outside Herdr", () => {
    const runtime = createRuntime();
    const handler = registerAgentEnd(runtime);

    handler({ messages: [{ role: "assistant", content: "Finished" }] });

    expect(runtime.execFile).not.toHaveBeenCalled();
    expect(runtime.write).toHaveBeenCalledWith(oscNotification);
  });
});
