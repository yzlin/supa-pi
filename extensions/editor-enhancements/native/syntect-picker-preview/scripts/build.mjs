#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const debug = process.argv.includes("--debug");
const profileDir = debug ? "debug" : "release";
const crateName = "syntect_picker_preview_native";
const targetTriple = resolveTargetTriple();
const bindingName = resolveBindingName();
const sourceExtension = process.platform === "darwin" ? "dylib" : "so";
const sourceLibrary = join(
  packageDir,
  "target",
  targetTriple,
  profileDir,
  `lib${crateName}.${sourceExtension}`
);
const outputFile = join(packageDir, bindingName);

runCargoBuild(targetTriple, debug);

if (!existsSync(sourceLibrary)) {
  throw new Error(`Expected native library at ${sourceLibrary}`);
}

rmSync(outputFile, { force: true });
mkdirSync(dirname(outputFile), { recursive: true });
copyFileSync(sourceLibrary, outputFile);
console.log(`Wrote ${bindingName}`);

function runCargoBuild(target, isDebug) {
  const args = ["build", "--target", target];
  if (!isDebug) {
    args.push("--release");
  }

  const result = spawnSync("cargo", args, {
    cwd: packageDir,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(
      `cargo ${args.join(" ")} failed with code ${result.status ?? 1}`
    );
  }
}

function resolveTargetTriple() {
  switch (`${process.platform}:${process.arch}`) {
    case "darwin:arm64":
      return "aarch64-apple-darwin";
    case "darwin:x64":
      return "x86_64-apple-darwin";
    case "linux:arm64":
      return "aarch64-unknown-linux-gnu";
    case "linux:x64":
      return "x86_64-unknown-linux-gnu";
    default:
      throw new Error(
        `Unsupported build target ${process.platform}/${process.arch}; this addon currently supports macOS + Linux on x64/arm64 only.`
      );
  }
}

function resolveBindingName() {
  switch (`${process.platform}:${process.arch}`) {
    case "darwin:arm64":
      return "syntect-picker-preview.darwin-arm64.node";
    case "darwin:x64":
      return "syntect-picker-preview.darwin-x64.node";
    case "linux:arm64":
      return "syntect-picker-preview.linux-arm64.node";
    case "linux:x64":
      return "syntect-picker-preview.linux-x64.node";
    default:
      throw new Error(
        `Unsupported runtime target ${process.platform}/${process.arch}; this addon currently supports macOS + Linux on x64/arm64 only.`
      );
  }
}
