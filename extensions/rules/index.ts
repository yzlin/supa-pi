import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const USER_RULES_DIR = path.join(os.homedir(), ".pi", "agent", "rules");

/**
 * Recursively find all .md files in a directory
 */
function findMarkdownFiles(dir: string, basePath: string = ""): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      results.push(
        ...findMarkdownFiles(path.join(dir, entry.name), relativePath)
      );
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(relativePath);
    }
  }

  return results;
}

export default function rulesExtension(pi: ExtensionAPI) {
  let userRuleFiles: string[] = [];
  let projectRuleFiles: string[] = [];

  // Scan for rules on session start
  pi.on("session_start", async (_event, ctx) => {
    userRuleFiles = findMarkdownFiles(USER_RULES_DIR);

    if (userRuleFiles.length > 0) {
      ctx.ui.notify(
        `Found ${userRuleFiles.length} user rule(s) in ${USER_RULES_DIR}`,
        "info"
      );
    }

    const projectRulesDir = path.join(ctx.cwd, ".pi", "rules");
    projectRuleFiles = findMarkdownFiles(projectRulesDir);

    if (projectRuleFiles.length > 0) {
      ctx.ui.notify(
        `Found ${projectRuleFiles.length} project rule(s) in ${projectRulesDir}`,
        "info"
      );
    }
  });

  // Append available rules to system prompt
  pi.on("before_agent_start", async (event) => {
    if (userRuleFiles.length === 0 && projectRuleFiles.length === 0) {
      return;
    }

    const promptPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "prompt.md"
    );
    const prompt = fs.readFileSync(promptPath, "utf8").trim();

    return {
      systemPrompt:
        event.systemPrompt +
        prompt +
        (userRuleFiles.length > 0
          ? `
<rules>

## User Rules

The following user rules are available:

${userRuleFiles.map((f) => `- ${path.join(USER_RULES_DIR, f)}`).join("\n")}
`
          : "") +
        (projectRuleFiles.length > 0
          ? `

## Project Rules

The following project rules are available:

${projectRuleFiles.map((f) => `- ${path.join(".pi", "rules", f)}`).join("\n")}
`
          : "") +
        `

When working on tasks related to these rules, use the read tool to load the relevant rule files for guidance.
</rules>
`,
    };
  });
}
