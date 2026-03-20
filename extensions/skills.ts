import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const baseDir = path.dirname(url.fileURLToPath(import.meta.url));
const skillsDir = path.join(baseDir, "..", "skills");

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", () => {
    // Discover all skill files (SKILL.md) in the skills directory or its subdirectories
    const skillPaths: string[] = [];
    function discoverSkills(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          discoverSkills(fullPath);
        } else if (entry.isFile() && entry.name === "SKILL.md") {
          skillPaths.push(fullPath);
        }
      }
    }
    discoverSkills(skillsDir);

    return {
      skillPaths,
    };
  });
}
