import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import rtkExtension from "./rtk";
import toolDisplayExtension from "./tool-display";

const packageJson = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")
) as { pi?: { extensions?: string[] } };
const rtkIndexSource = readFileSync(
  join(import.meta.dir, "rtk", "index.ts"),
  "utf8"
);
const toolDisplayIndexSource = readFileSync(
  join(import.meta.dir, "tool-display", "index.ts"),
  "utf8"
);
const fullSkillReadSummaryPattern =
  /skill read full \(\$\{details\.bytes\} bytes\$\{suffix\}\)/;

function createExtensionHarness() {
  const tools: Array<{ name: string; renderShell?: string }> = [];
  const commands: string[] = [];
  const handlers: string[] = [];

  const api = {
    on(name: string) {
      handlers.push(name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerTool(tool: { name: string; renderShell?: string }) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  return { api, commands, handlers, tools };
}

describe("extension registration compatibility", () => {
  test("tool ownership is explicit and legacy read-patch is inactive", () => {
    const extensions = packageJson.pi?.extensions ?? [];

    expect(extensions).not.toContain("./extensions/read-patch.ts");
    expect(extensions).not.toContain("./extensions/read-patch");
    expect(extensions).toContain("./extensions/rtk");
    expect(extensions).toContain("./extensions/tool-display");
    expect(extensions.indexOf("./extensions/rtk")).toBeLessThan(
      extensions.indexOf("./extensions/tool-display")
    );
  });

  test("tool-display owns default read/search/edit/write tools but not bash", () => {
    const harness = createExtensionHarness();

    toolDisplayExtension(harness.api);

    expect(harness.tools.map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
    ]);
    expect(harness.tools.map((tool) => tool.name)).not.toContain("bash");
    expect(
      harness.tools
        .filter((tool) => tool.renderShell === "default")
        .map((tool) => tool.name)
    ).toEqual(["edit", "write"]);
  });

  test("rtk actively owns bash execution while using tool-display bash renderers", () => {
    const harness = createExtensionHarness();

    rtkExtension(harness.api);

    expect(harness.tools.map((tool) => tool.name)).toEqual(["bash"]);
    expect(rtkIndexSource).toContain("createBashTool");
    expect(rtkIndexSource).toContain("renderCompactBashCall");
    expect(rtkIndexSource).toContain("renderCompactBashResult");
    expect(rtkIndexSource).toContain("toolDisplayConfig.output.bash");
    expect(rtkIndexSource).toContain("resolveRtkCommand");
  });

  test("full skill reads render summary-only tool-display details", () => {
    expect(toolDisplayIndexSource).toContain("isToolDisplayReadDetails");
    expect(toolDisplayIndexSource).toMatch(fullSkillReadSummaryPattern);
    expect(toolDisplayIndexSource).not.toContain("readPatch");
  });
});
