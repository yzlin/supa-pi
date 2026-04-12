import type { StatusBarSegmentOptions } from "./types.js";

function mergeOptionGroup<T extends object>(
  base?: T,
  override?: T
): T | undefined {
  const merged = { ...base, ...override };
  return Object.keys(merged).length > 0 ? (merged as T) : undefined;
}

export function mergeStatusBarSegmentOptions(
  base?: StatusBarSegmentOptions,
  override?: StatusBarSegmentOptions
): StatusBarSegmentOptions | undefined {
  const model = mergeOptionGroup(base?.model, override?.model);
  const path = mergeOptionGroup(base?.path, override?.path);
  const git = mergeOptionGroup(base?.git, override?.git);
  const time = mergeOptionGroup(base?.time, override?.time);

  const merged: StatusBarSegmentOptions = {};

  if (model) merged.model = model;
  if (path) merged.path = path;
  if (git) merged.git = git;
  if (time) merged.time = time;

  return Object.keys(merged).length > 0 ? merged : undefined;
}
