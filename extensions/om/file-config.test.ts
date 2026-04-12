import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_OM_CONFIG_SNAPSHOT } from "./config";
import {
  getGlobalOmConfigPath,
  getOmConfigPath,
  loadOmConfig,
} from "./file-config";

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

  it("uses defaults when both global and project config files are missing", () => {
    const cwd = createTempDir();
    const homeDir = createTempDir();

    expect(loadOmConfig(cwd, homeDir)).toEqual(DEFAULT_OM_CONFIG_SNAPSHOT);
  });

  it("falls back safely on malformed JSON", () => {
    const cwd = createTempDir();
    const homeDir = createTempDir();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(getOmConfigPath(cwd), "{not-json", "utf8");

    expect(loadOmConfig(cwd, homeDir)).toEqual(DEFAULT_OM_CONFIG_SNAPSHOT);
  });

  it("loads and normalizes project-local config", () => {
    const cwd = createTempDir();
    const homeDir = createTempDir();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      getOmConfigPath(cwd),
      `${JSON.stringify(
        {
          enabled: false,
          model: "openai/gpt-5-mini",
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

    expect(loadOmConfig(cwd, homeDir)).toEqual({
      ...DEFAULT_OM_CONFIG_SNAPSHOT,
      enabled: false,
      model: "openai/gpt-5-mini",
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

  it("falls back to the default model setting on blank model config", () => {
    const cwd = createTempDir();
    const homeDir = createTempDir();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      getOmConfigPath(cwd),
      `${JSON.stringify({ model: "   " }, null, 2)}\n`,
      "utf8"
    );

    expect(loadOmConfig(cwd, homeDir)).toEqual(DEFAULT_OM_CONFIG_SNAPSHOT);
  });

  it("loads a bare modelId from config", () => {
    const cwd = createTempDir();
    const homeDir = createTempDir();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      getOmConfigPath(cwd),
      `${JSON.stringify({ model: "gpt-5-mini" }, null, 2)}\n`,
      "utf8"
    );

    expect(loadOmConfig(cwd, homeDir)).toEqual({
      ...DEFAULT_OM_CONFIG_SNAPSHOT,
      model: "gpt-5-mini",
    });
  });

  it("loads global config when project config is missing", () => {
    const cwd = createTempDir();
    const homeDir = createTempDir();
    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      getGlobalOmConfigPath(homeDir),
      `${JSON.stringify({ model: "openai/gpt-5-mini", enabled: false }, null, 2)}\n`,
      "utf8"
    );

    expect(loadOmConfig(cwd, homeDir)).toEqual({
      ...DEFAULT_OM_CONFIG_SNAPSHOT,
      model: "openai/gpt-5-mini",
      enabled: false,
    });
  });

  it("applies project config over global config", () => {
    const cwd = createTempDir();
    const homeDir = createTempDir();
    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      getGlobalOmConfigPath(homeDir),
      `${JSON.stringify(
        {
          enabled: false,
          model: "openai/gpt-5-mini",
          observation: { messageTokens: 7000 },
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    writeFileSync(
      getOmConfigPath(cwd),
      `${JSON.stringify(
        {
          enabled: true,
          observation: { previousObserverTokens: false },
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    expect(loadOmConfig(cwd, homeDir)).toEqual({
      ...DEFAULT_OM_CONFIG_SNAPSHOT,
      enabled: true,
      model: "openai/gpt-5-mini",
      observation: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
        messageTokens: 7000,
        previousObserverTokens: false,
      },
      observationMessageTokens: 7000,
      observationPreviousTokens: false,
    });
  });

  it("preserves a valid global model when the project model override is blank", () => {
    const cwd = createTempDir();
    const homeDir = createTempDir();
    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      getGlobalOmConfigPath(homeDir),
      `${JSON.stringify({ model: "openai/gpt-5-mini" }, null, 2)}\n`,
      "utf8"
    );
    writeFileSync(
      getOmConfigPath(cwd),
      `${JSON.stringify({ model: "   " }, null, 2)}\n`,
      "utf8"
    );

    expect(loadOmConfig(cwd, homeDir)).toEqual({
      ...DEFAULT_OM_CONFIG_SNAPSHOT,
      model: "openai/gpt-5-mini",
    });
  });
});
