import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";

export const DOUBLE_ESCAPE_WINDOW_MS = 500;

export function matchesInterrupt(
  keybindingsManager: KeybindingsManager,
  data: string
): boolean {
  const matches = keybindingsManager.matches.bind(
    keybindingsManager
  ) as unknown as (data: string, key: string) => boolean;
  return matches(data, "app.interrupt") || matches(data, "interrupt");
}

export function shouldHandleConfiguredDoubleEscape(options: {
  doubleEscapeCommand: string | null;
  data: string;
  keybindingsManager: KeybindingsManager;
  isShowingAutocomplete: boolean;
  editorText: string;
  canTriggerDoubleEscapeCommand: boolean;
}): boolean {
  return Boolean(
    options.doubleEscapeCommand &&
      matchesInterrupt(options.keybindingsManager, options.data) &&
      !options.isShowingAutocomplete &&
      !options.editorText.trim() &&
      options.canTriggerDoubleEscapeCommand
  );
}

export function consumeDoubleEscape(options: {
  lastEscapeTime: number;
  now?: number;
  windowMs?: number;
}): { nextLastEscapeTime: number; shouldSubmit: boolean } {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DOUBLE_ESCAPE_WINDOW_MS;

  if (now - options.lastEscapeTime >= windowMs) {
    return {
      nextLastEscapeTime: now,
      shouldSubmit: false,
    };
  }

  return {
    nextLastEscapeTime: 0,
    shouldSubmit: true,
  };
}
