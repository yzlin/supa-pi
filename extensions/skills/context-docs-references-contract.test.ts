import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = process.cwd();
const skillPath = join(repositoryRoot, "skills", "context-docs", "SKILL.md");
const safeguardsPath = join(
  repositoryRoot,
  "skills",
  "context-docs",
  "references",
  "documentation-safeguards.md"
);

const originalDocumentationSafeguards = `## Documentation and codemap safeguards

When updating a README, guide, codemap, or durable context:

- Treat code, configuration, scripts, and existing project context as sources of truth. Inspect the requested scope and applicable \`AGENTS.md\` guidance before editing.
- Inspect real entry points, exports, dependencies, routes, schemas, environment variables, package scripts, and context boundaries before describing them.
- Verify referenced paths, links, commands, snippets, and examples rather than guessing. Keep the requested documentation scope; do not change code unless the request includes it.
- For codemaps, describe actual boundaries, responsibilities, dependencies, entry points, and data flow. Keep maps focused and cross-link related areas.
- Update freshness metadata only after the documented content has been verified.
- Validate changed links, paths, snippets, and commands where practical, and report what was checked and what remains uncertain.
`;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("context-docs selective reference contract", () => {
  it("loads documentation safeguards through one skill-relative reference", () => {
    const skill = read(skillPath);
    const link = "references/documentation-safeguards.md";

    expect(skill).toContain(
      `For README, guide, codemap, or durable context changes, load and follow the [Documentation and codemap safeguards](${link}) reference as part of this workflow.`
    );
    expect(
      skill.match(/references\/documentation-safeguards\.md/g)
    ).toHaveLength(1);

    const referencePath = resolve(dirname(skillPath), link);
    expect(referencePath.startsWith(dirname(skillPath))).toBe(true);
    expect(existsSync(referencePath)).toBe(true);
  });

  it("routes ordinary documentation work directly to the reference", () => {
    const rule = read(
      join(repositoryRoot, "rules", "common", "development-workflow.md")
    );

    expect(rule).toContain(
      "../../skills/context-docs/references/documentation-safeguards.md"
    );
    expect(rule).not.toContain(
      "skills/context-docs/SKILL.md#documentation-and-codemap-safeguards"
    );
  });

  it("moves the safeguards without changing their wording", () => {
    const safeguards = read(safeguardsPath);
    const skill = read(skillPath);

    expect(safeguards).toBe(originalDocumentationSafeguards);
    expect(skill).not.toContain(
      "- Treat code, configuration, scripts, and existing project context as sources of truth."
    );
    expect(skill).not.toContain(
      "- Validate changed links, paths, snippets, and commands where practical"
    );
  });
});
