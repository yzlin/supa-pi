import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { ValidatedVault } from "./config";

export interface ActiveVault {
  vault: ValidatedVault;
  warnings: string[];
}

function contains(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return (
    relativePath === "" ||
    !(relativePath.startsWith("..") || isAbsolute(relativePath))
  );
}

export function realpathExistingAncestor(input: string): string | null {
  let current = resolve(input);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  try {
    return realpathSync(current);
  } catch {
    return null;
  }
}

export function resolveActiveVault(
  cwd: string,
  vaults: ValidatedVault[]
): ActiveVault | null {
  const realCwd = realpathExistingAncestor(cwd);
  if (!realCwd) {
    return null;
  }

  const matches = vaults
    .filter((vault) => contains(vault.realPath, realCwd))
    .sort((left, right) => right.realPath.length - left.realPath.length);

  const activeVault = matches[0];
  if (!activeVault) {
    return null;
  }

  const warnings =
    matches.length > 1
      ? ["Overlapping Obsidian vaults detected; deepest root wins"]
      : [];
  return { vault: activeVault, warnings };
}

export function assertContained(
  vault: ValidatedVault,
  target: string
): boolean {
  const realTarget = realpathExistingAncestor(target);
  return realTarget ? contains(vault.realPath, realTarget) : false;
}
