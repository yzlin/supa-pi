import { createPickerState } from "../config/file-picker.js";
import { loadConfig } from "../config/index.js";
import type { PickerRuntimeConfig, PickerState } from "./types.js";

export interface FilePickerRuntime {
  config: PickerRuntimeConfig;
  state: PickerState;
}

export function createFilePickerRuntime(
  config: PickerRuntimeConfig = loadConfig().filePicker
): FilePickerRuntime {
  return {
    config,
    state: createPickerState(config),
  };
}

let sharedRuntime: FilePickerRuntime | undefined;

export function getSharedFilePickerRuntime(): FilePickerRuntime {
  if (!sharedRuntime) {
    sharedRuntime = createFilePickerRuntime();
  }
  return sharedRuntime;
}
