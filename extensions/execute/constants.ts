import { readFileSync } from "node:fs";

export const EXECUTE_COMMAND_NAME = "execute";
export const EXECUTE_PROMPT = readFileSync(
  new URL("./prompt.md", import.meta.url),
  "utf8"
).trim();
