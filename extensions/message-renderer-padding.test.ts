import { beforeAll, describe, expect, it } from "bun:test";

import type {
  ExtensionAPI,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";

import {
  initTheme,
  theme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import btwExtension from "./btw";
import goalExtension from "./goal";
import reviewExtension from "./review";

function captureRenderer(
  register: (pi: ExtensionAPI) => void
): MessageRenderer {
  let renderer: MessageRenderer | undefined;
  const api = new Proxy(
    {
      registerMessageRenderer(
        _customType: string,
        registeredRenderer: MessageRenderer
      ) {
        renderer = registeredRenderer;
      },
    },
    {
      get(target, property) {
        if (property in target) {
          return target[property as keyof typeof target];
        }
        return () => undefined;
      },
    }
  ) as unknown as ExtensionAPI;

  register(api);
  if (!renderer) {
    throw new Error("Expected message renderer registration");
  }
  return renderer;
}

function paddingX(component: unknown): number | undefined {
  return (component as { paddingX?: number } | undefined)?.paddingX;
}

beforeAll(() => {
  initTheme("dark", false);
});

describe("custom message output padding", () => {
  it("uses outputPad for goal messages", () => {
    const renderer = captureRenderer(goalExtension);
    const component = renderer(
      {
        role: "custom",
        customType: "goal-event",
        content: "",
        display: true,
        details: { title: "Ship", status: "active" },
        timestamp: Date.now(),
      },
      { expanded: false, outputPad: 1 },
      theme
    );

    expect(paddingX(component)).toBe(1);
  });

  it("uses outputPad for review reports", () => {
    const renderer = captureRenderer(reviewExtension);
    const component = renderer(
      {
        role: "custom",
        customType: "review-report",
        content: "# Review",
        display: true,
        details: { report: "# Review" },
        timestamp: Date.now(),
      },
      { expanded: false, outputPad: 1 },
      theme
    );

    expect(paddingX(component)).toBe(1);
  });

  it("uses outputPad for btw result cards", () => {
    const renderer = captureRenderer(btwExtension);
    const component = renderer(
      {
        role: "custom",
        customType: "btw-result",
        content: "done",
        display: true,
        details: {
          task: "Inspect",
          result: {
            task: "Inspect",
            exitCode: 0,
            displayItems: [],
            finalOutput: "Done",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          },
        },
        timestamp: Date.now(),
      },
      { expanded: false, outputPad: 0 },
      theme
    );

    expect(paddingX(component)).toBe(0);
  });
});
