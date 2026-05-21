import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI } from "@earendil-works/pi-tui";

interface SkillActivityTheme {
  fg(color: string, text: string): string;
}

export const SKILL_ACTIVITY_STATUS_KEY = "skills-activity";
export const SKILL_ACTIVITY_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
export const SKILL_ACTIVITY_INTERVAL_MS = 80;

export interface SkillOperationActivity {
  start(label: string): void;
  suspendBeforePrompt(): void;
  finishSuccess(): void;
  finishFailure(): void;
}

export function renderSkillActivityLine(
  frame: string,
  label: string,
  theme: SkillActivityTheme
): string {
  return `${theme.fg("accent", frame)} ${theme.fg("dim", label)}`;
}

function createSkillActivityWidget(label: string) {
  return (
    tui: TUI,
    theme: SkillActivityTheme
  ): Component & { dispose?(): void } => {
    let frameIndex = 0;
    const text = new Text(
      renderSkillActivityLine(SKILL_ACTIVITY_FRAMES[frameIndex], label, theme),
      1,
      0
    );
    const timer = setInterval(() => {
      frameIndex = (frameIndex + 1) % SKILL_ACTIVITY_FRAMES.length;
      text.setText(
        renderSkillActivityLine(SKILL_ACTIVITY_FRAMES[frameIndex], label, theme)
      );
      tui.requestRender();
    }, SKILL_ACTIVITY_INTERVAL_MS);

    return {
      render(width: number) {
        return [...text.render(width), ""];
      },
      invalidate() {
        text.invalidate();
      },
      dispose() {
        clearInterval(timer);
      },
    };
  };
}

export function createSkillOperationActivity(
  ctx: ExtensionCommandContext
): SkillOperationActivity {
  const setRunning = (label: string): void => {
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setStatus(SKILL_ACTIVITY_STATUS_KEY, label);
    ctx.ui.setWidget?.(
      SKILL_ACTIVITY_STATUS_KEY,
      createSkillActivityWidget(label)
    );
  };
  const stop = (): void => {
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setStatus(SKILL_ACTIVITY_STATUS_KEY, undefined);
    ctx.ui.setWidget?.(SKILL_ACTIVITY_STATUS_KEY, undefined);
  };
  return {
    start(label) {
      setRunning(label);
    },
    suspendBeforePrompt() {
      stop();
    },
    finishSuccess() {
      stop();
    },
    finishFailure() {
      stop();
    },
  };
}
