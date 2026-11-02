#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import {
  findSkills,
  installLocalSource,
  listManagedSkills,
  type NotifyLevel,
  type Prompter,
  remoteSkillLabel,
  removeManaged,
  searchSkills,
  updateManaged,
} from "../extensions/skills/ops";

const USAGE = `Usage: pi-skill <command> [options]

Commands:
  list [--json]                                  List managed skills
  search <query>                                 Search skills.sh (TTY: pick one to install)
  install <source> [--skill <name>]... [--all]   Install from a local dir or GitHub source
  update [name] [--all]                          Update remote managed skills
  remove <name>                                  Remove a managed skill (moves it to Trash)

Options:
  -y, --yes       Confirm every confirmation, including dirty overwrite or removal
  --all           Install all skills in a source, or update all skills
  --skill <name>  Pick a skill in a multi-skill source (repeatable)
  --json          JSON output for list
  -h, --help      Show this help

Off a TTY, a missing choice exits with code 2 and names the flag to pass.`;

class UsageError extends Error {}

function needs(flag: string, title: string, state?: CliState): never {
  const error = new UsageError(`${title}: no TTY to ask. Pass ${flag}.`);
  // ops.ts can catch per-skill errors (e.g. update loop); remember the usage gap for the exit code.
  if (state) {
    state.usageError = true;
  }
  throw error;
}

function flagForSelect(title: string): string {
  if (title.startsWith("Update skill")) {
    return "--all or a skill name";
  }
  if (title.startsWith("Remove skill")) {
    return "a skill name";
  }
  return "--skill <name> or --all";
}

function createNonInteractivePrompter(state: CliState): Prompter {
  return {
    select: (title) => needs(flagForSelect(title), title, state),
    confirm: (title) => needs("--yes", title, state),
    input: (title) => needs("the missing argument", title, state),
    pickSkills: async (entries) =>
      onlySkillId(entries) ??
      needs("--skill <name> or --all", "Install skills", state),
    notify: (message, level) => report(state, message, level),
    progress: status,
  };
}

function createTtyPrompter(state: CliState): Prompter {
  const ask = async (question: string): Promise<string> => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };
  const pickIndexes = async (
    title: string,
    labels: string[],
    multi: boolean,
  ): Promise<number[] | undefined> => {
    process.stderr.write(`${title}\n`);
    for (const [index, label] of labels.entries()) {
      process.stderr.write(`  ${index + 1}) ${label}\n`);
    }
    const hint = multi ? "numbers (comma-separated) or a for all" : "number";
    const answer = await ask(`Choose ${hint}, blank to cancel: `);
    if (!answer) {
      return;
    }
    if (multi && answer.toLowerCase() === "a") {
      return labels.map((_, index) => index);
    }
    const indexes = answer.split(",").map((part) => Number(part.trim()) - 1);
    if (
      (!multi && indexes.length !== 1) ||
      indexes.some(
        (index) =>
          !Number.isInteger(index) || index < 0 || index >= labels.length,
      )
    ) {
      throw new UsageError(`Invalid choice: ${answer}`);
    }
    return indexes;
  };
  return {
    async select(title, options) {
      const picked = await pickIndexes(title, options, false);
      return picked ? options[picked[0] ?? -1] : undefined;
    },
    async confirm(title, message) {
      const answer = await ask(`${title}: ${message} [y/N] `);
      return ["y", "yes"].includes(answer.toLowerCase());
    },
    async input(title, placeholder) {
      return (
        (await ask(`${title}${placeholder ? ` (${placeholder})` : ""}: `)) ||
        undefined
      );
    },
    async pickSkills(entries) {
      const only = onlySkillId(entries);
      if (only) {
        return only;
      }
      const picked = await pickIndexes(
        "Install skills",
        entries.map((entry) => `${entry.name} — ${entry.sourceDir}`),
        true,
      );
      return picked?.map((index) => entries[index]?.id ?? "");
    },
    notify: (message, level) => report(state, message, level),
    progress: status,
  };
}

interface CliState {
  failed: boolean;
  usageError: boolean;
}

function status(label: string): void {
  process.stderr.write(`${label}\n`);
}

/** A source with exactly one skill installs it without asking. */
function onlySkillId(entries: { id: string }[]): string[] | undefined {
  const [first] = entries;
  return entries.length === 1 && first ? [first.id] : undefined;
}

function report(state: CliState, message: string, level: NotifyLevel): void {
  // ops.ts reports failures (failed updates, empty sources, no matches) as warnings.
  if (level !== "info") {
    state.failed = true;
  }
  const stream = level === "info" ? process.stdout : process.stderr;
  stream.write(`${level === "info" ? "" : `${level}: `}${message}\n`);
}

function printList(json: boolean): void {
  const skills = listManagedSkills();
  if (json) {
    process.stdout.write(`${JSON.stringify(skills, null, 2)}\n`);
    return;
  }
  if (skills.length === 0) {
    process.stdout.write("No managed skills.\n");
    return;
  }
  const rows = [
    ["NAME", "SOURCE", "DIRTY"],
    ...skills.map((skill) => [
      skill.name,
      skill.source,
      skill.dirty ? "yes" : "",
    ]),
  ];
  const nameWidth = Math.max(...rows.map((row) => row[0]?.length ?? 0));
  const sourceWidth = Math.max(...rows.map((row) => row[1]?.length ?? 0));
  for (const [name = "", source = "", dirty = ""] of rows) {
    const line = `${name.padEnd(nameWidth)}  ${source.padEnd(sourceWidth)}  ${dirty}`;
    process.stdout.write(`${line.trimEnd()}\n`);
  }
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      yes: { type: "boolean", short: "y" },
      all: { type: "boolean" },
      skill: { type: "string", multiple: true },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...operands] = positionals;
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return values.help ? 0 : 2;
  }
  const state: CliState = { failed: false, usageError: false };
  const interactive = Boolean(process.stdin.isTTY);
  const prompter = interactive
    ? createTtyPrompter(state)
    : createNonInteractivePrompter(state);
  const operand = operands.join(" ").trim();
  const choices = {
    yes: values.yes,
    all: values.all,
    skillNames: values.skill,
  };
  switch (command) {
    case "list":
      printList(Boolean(values.json));
      break;
    case "__complete-names":
      // Used by scripts/completions/_pi-skill; prints managed skill ids.
      for (const skill of listManagedSkills()) {
        process.stdout.write(`${skill.id}\n`);
      }
      break;
    case "search":
      if (interactive) {
        await searchSkills(prompter, operand, { yes: values.yes });
      } else {
        if (!operand) {
          needs("a query", "Search skills");
        }
        status(`Searching skills.sh for ${operand}…`);
        const results = await findSkills(operand);
        process.stdout.write(
          results.length
            ? `${results.map(remoteSkillLabel).join("\n")}\n`
            : "No skills found.\n",
        );
      }
      break;
    case "install": {
      const source =
        operand || (await prompter.input("Install skill", "skill source"));
      if (!source) {
        return 2;
      }
      status(`Resolving ${source}…`);
      await installLocalSource(prompter, source, choices);
      break;
    }
    case "update":
      await updateManaged(prompter, {
        ...choices,
        skillNames: operand ? [operand] : undefined,
      });
      break;
    case "remove":
      await removeManaged(prompter, {
        yes: values.yes,
        skillNames: operand ? [operand] : undefined,
      });
      break;
    default:
      throw new UsageError(`Unknown command: ${command}\n\n${USAGE}`);
  }
  if (state.usageError) {
    return 2;
  }
  return state.failed ? 1 : 0;
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pi-skill: ${message}\n`);
  process.exitCode =
    error instanceof UsageError ||
    (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
      ? 2
      : 1;
}
