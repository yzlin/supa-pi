import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function corePromptExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const promptPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "prompt.md",
    );
    // A section, not a returned systemPrompt: providers such as claude-bridge
    // forward sections but drop whole-prompt replacements.
    event.systemPromptOptions.sections.supapi_core = fs
      .readFileSync(promptPath, "utf8")
      .trim();
  });
}
