import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import corePromptExtension from "./core-prompt/index";
import rulesExtension from "./rules/index";

// claude-bridge forwards systemPromptOptions.sections but drops a returned
// systemPrompt, so prompt writers must add sections instead.
function setup(register: (pi: any) => void) {
  const handlers = new Map<string, (...args: any[]) => any>();
  register({
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
    },
  });
  return handlers;
}

function startEvent() {
  return {
    systemPrompt: "base",
    systemPromptOptions: { sections: {} as Record<string, string> },
  };
}

describe("prompt sections", () => {
  it("core-prompt adds the SupaPi prompt as a section", () => {
    const handlers = setup(corePromptExtension);
    const event = startEvent();

    expect(handlers.get("before_agent_start")?.(event)).toBeUndefined();
    expect(event.systemPromptOptions.sections.supapi_core).toContain(
      "You are SupaPi's orchestration-first coding agent.",
    );
  });

  it("rules adds the rule list as a section, not the built-in rules key", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rules-section-"));
    try {
      fs.mkdirSync(path.join(cwd, ".pi", "rules"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "rules", "style.md"), "# Style");
      const handlers = setup(rulesExtension);
      handlers.get("session_start")?.({}, { cwd, ui: { notify() {} } });
      const event = startEvent();

      expect(handlers.get("before_agent_start")?.(event)).toBeUndefined();
      const section = event.systemPromptOptions.sections.supapi_rules;
      expect(section).toContain(`- ${path.join(".pi", "rules", "style.md")}`);
      expect(section).not.toContain("<rules>");
      expect(event.systemPromptOptions.sections.rules).toBeUndefined();
    } finally {
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  });
});
