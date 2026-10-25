import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

// Sibling extensions must not import each other, so this mirrors the
// subagent role parser's rules for the fields spec-reviewer uses.
const AGENT_PATH = join(import.meta.dir, "../../agents/spec-reviewer.md");
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

it("defines a read-only spec-reviewer role that the subagent parser accepts", () => {
  const text = readFileSync(AGENT_PATH, "utf8");
  expect(text).toMatch(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text);
  expect(Object.keys(frontmatter).toSorted()).toEqual(
    ["caveman", "description", "model", "thinking", "tools"].toSorted(),
  );
  expect(frontmatter.description).toEqual(expect.stringMatching(/\S/));
  expect(frontmatter.model).toMatch(/^[^/\s]+\/[^\s]+$/);
  expect(frontmatter.thinking).toBe("high");
  expect(frontmatter.caveman).toBe(false);
  expect(typeof frontmatter.tools).toBe("string");
  const tools = String(frontmatter.tools as string)
    .split(",")
    .map((tool) => tool.trim());
  expect(tools).toEqual(READ_ONLY_TOOLS);
  for (const tool of tools) {
    expect(tool).toMatch(/^[a-zA-Z0-9_:-]+$/);
  }
  for (const phrase of [
    "Never edit",
    "DC-n",
    "US-n",
    "Plan",
    "Scope",
    "at most 5 questions",
    "2-4 options",
    "StructuredOutput",
    "data",
  ]) {
    expect(body).toContain(phrase);
  }
});
