import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function corePromptExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const promptPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "prompt.md"
    );
    const prompt = fs.readFileSync(promptPath, "utf8").trim();

    return {
      systemPrompt: event.systemPrompt + "\n\n" + prompt,
    };
  });
}
