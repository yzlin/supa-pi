import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_OM_CONFIG_SNAPSHOT } from "./config";
import { getOmConfigPath, loadOmConfig } from "./file-config";

describe("om file config", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-om-config-"));
    tempDirs.push(dir);
    return dir;
  }

  it("uses defaults when the config file is missing", () => {
    const cwd = createTempDir();

    expect(loadOmConfig(cwd)).toEqual(DEFAULT_OM_CONFIG_SNAPSHOT);
  });

  it("falls back safely on malformed JSON", () => {
    const cwd = createTempDir();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(getOmConfigPath(cwd), "{not-json", "utf8");

    expect(loadOmConfig(cwd)).toEqual(DEFAULT_OM_CONFIG_SNAPSHOT);
  });

  it("loads and normalizes project-local config", () => {
    const cwd = createTempDir();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      getOmConfigPath(cwd),
      `${JSON.stringify(
        {
          enabled: false,
          observerMaxTurns: 12,
          observation: {
            messageTokens: 9000,
            previousObserverTokens: false,
          },
          reflectionObservationTokens: 4321,
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    expect(loadOmConfig(cwd)).toEqual({
      ...DEFAULT_OM_CONFIG_SNAPSHOT,
      enabled: false,
      observerMaxTurns: 12,
      observation: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
        messageTokens: 9000,
        previousObserverTokens: false,
      },
      reflection: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT.reflection,
        observationTokens: 4321,
      },
      observationMessageTokens: 9000,
      observationPreviousTokens: false,
      reflectionObservationTokens: 4321,
    });
  });
});
