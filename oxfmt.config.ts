import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  trailingComma: "all",
  // Match the previous node/bun -> package -> alias -> relative import groups.
  sortImports: {
    ...ultracite.sortImports,
    customGroups: [
      { groupName: "runtime", selector: "builtin" },
      { groupName: "runtime", elementNamePattern: ["node:*", "bun", "bun:*"] },
      { groupName: "alias", elementNamePattern: ["@/**", "~/**", "#*"] },
      { groupName: "relative", elementNamePattern: ["./**", "../**"] },
      { groupName: "packages", selector: "external" },
    ],
    groups: ["runtime", "packages", "alias", "relative", "unknown"],
    newlinesBetween: true,
  },
  // Only TypeScript and JSON; never rewrite docs, vendored skills or lockfiles.
  ignorePatterns: [
    "**/*",
    "!**/",
    "!**/*.ts",
    "!**/*.json",
    "node_modules/",
    ".pi/",
    "skills/composition-patterns/",
    "**/*.md",
    "**/*.yml",
    "**/*.yaml",
    "**/bun.lock",
    "**/bun.lockb",
    "**/package-lock.json",
  ],
});
