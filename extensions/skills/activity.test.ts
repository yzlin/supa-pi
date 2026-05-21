import { describe, expect, it } from "bun:test";

import {
  createSkillOperationActivity,
  renderSkillActivityLine,
  SKILL_ACTIVITY_FRAMES,
  SKILL_ACTIVITY_INTERVAL_MS,
  SKILL_ACTIVITY_STATUS_KEY,
} from "./activity";

const theme = {
  fg(color: string, text: string) {
    return `<${color}:${text}>`;
  },
};

describe("skill operation activity", () => {
  it("uses a static status label and animated Pi-style widget content", async () => {
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const widgets: Array<{ key: string; content: unknown }> = [];
    let renderRequests = 0;
    const ctx = {
      hasUI: true,
      ui: {
        setStatus(key: string, text: string | undefined) {
          statuses.push({ key, text });
        },
        setWidget(key: string, content: unknown) {
          widgets.push({ key, content });
        },
        setWorkingMessage() {
          throw new Error("must not touch global Working message");
        },
        setWorkingVisible() {
          throw new Error("must not touch global Working visibility");
        },
      },
    };

    createSkillOperationActivity(ctx as never).start("Installing skill…");

    expect(statuses).toEqual([
      { key: SKILL_ACTIVITY_STATUS_KEY, text: "Installing skill…" },
    ]);
    expect(widgets).toEqual([
      { key: SKILL_ACTIVITY_STATUS_KEY, content: expect.any(Function) },
    ]);

    const factory = widgets[0]?.content as (
      tui: { requestRender(): void },
      activeTheme: typeof theme
    ) => { render(width: number): string[]; dispose(): void };
    const component = factory(
      { requestRender: () => (renderRequests += 1) },
      theme
    );

    const initialLines = component.render(80);
    expect(initialLines[0]?.startsWith(" ")).toBe(true);
    expect(initialLines.at(-1)).toBe("");
    expect(initialLines.join("\n")).toContain(
      renderSkillActivityLine(
        SKILL_ACTIVITY_FRAMES[0],
        "Installing skill…",
        theme as never
      )
    );

    await new Promise((resolve) =>
      setTimeout(resolve, SKILL_ACTIVITY_INTERVAL_MS + 20)
    );

    expect(renderRequests).toBeGreaterThan(0);
    expect(component.render(80).join("\n")).toContain(
      renderSkillActivityLine(
        SKILL_ACTIVITY_FRAMES[1],
        "Installing skill…",
        theme as never
      )
    );

    component.dispose();
  });

  it("clears dedicated status and widget when prompts suspend and later resumes with the same label", () => {
    const calls: string[] = [];
    const activity = createSkillOperationActivity({
      hasUI: true,
      ui: {
        setStatus(_key: string, text: string | undefined) {
          calls.push(`status:${text ?? ""}`);
        },
        setWidget(_key: string, content: unknown) {
          calls.push(
            `widget:${typeof content === "function" ? "factory" : ""}`
          );
        },
      },
    } as never);

    activity.start("Searching skills…");
    activity.suspendBeforePrompt();
    activity.start("Searching skills…");
    activity.finishSuccess();

    expect(calls).toEqual([
      "status:Searching skills…",
      "widget:factory",
      "status:",
      "widget:",
      "status:Searching skills…",
      "widget:factory",
      "status:",
      "widget:",
    ]);
  });
});
