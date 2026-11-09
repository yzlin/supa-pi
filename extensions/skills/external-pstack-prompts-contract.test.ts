import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const externalSkills = [
  "statechart",
  "create-formal-verification-skill",
  "maintain-formal-verification-skill",
];

describe("external pstack skill prompts (wiring, not model adherence)", () => {
  for (const name of externalSkills) {
    it(`/${name} reads the installed skill and stops with its install command when missing`, () => {
      const prompt = read(`prompts/${name}.md`);
      expect(prompt).toContain(
        `Read \`~/.pi/agent/skills/${name}/SKILL.md\` and follow it as canonical for this explicit command.`,
      );
      expect(prompt).toContain(
        `\`/skill install https://github.com/cursor/plugins/tree/main/pstack/skills/${name}\``,
      );
      expect(prompt).toContain("$@");
    });
  }

  it("documents the formal verification skills where agents route", () => {
    const map = read("CONTEXT-MAP.md");
    expect(map).toContain(
      '"Formal verification skills: implemented direction"',
    );
    expect(read("docs/context/subsystems.md")).toContain(
      "## Formal verification skills: implemented direction",
    );
    const readme = read("README.md");
    for (const name of externalSkills.slice(1)) {
      expect(readme).toContain(
        `/skill install https://github.com/cursor/plugins/tree/main/pstack/skills/${name}`,
      );
    }
  });
});
