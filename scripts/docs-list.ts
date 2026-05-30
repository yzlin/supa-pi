#!/usr/bin/env bun

/*
 * This script was copied from [@steipete/agent-scripts](https://github.com/steipete/agent-scripts)
 */

import { formatDocsList, listDocs } from "../extensions/docs-list/core";

function main(): void {
  const path = process.argv[2];
  try {
    console.log(formatDocsList(listDocs({ path })));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

main();
