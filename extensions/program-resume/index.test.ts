import { describe, expect, it } from "bun:test";

import { buildReport } from "./index";

// Vectors from the Program Resume spec (token "dummy-token-replace-me").
const token = "dummy-token-replace-me";

describe("program-resume buildReport", () => {
  it("matches the spec's argv example", () => {
    expect(
      buildReport({
        pid: 74_877,
        time: 1_795_543_200,
        token,
        argv: [
          "nvim",
          "-S",
          "/home/user/.local/state/nvim/sessions/8f2c1d.vim",
        ],
      }),
    ).toBe(
      "\x1b]7577;pid=74877:time=1795543200:argv=bnZpbQ==,LVM=,L2hvbWUvdXNlci8ubG9jYWwvc3RhdGUvbnZpbS9zZXNzaW9ucy84ZjJjMWQudmlt:mac=9dbb99bfb856749a87563839d7ce9062818d78cf25909db93f309e0cd3b1909b\x1b\\",
    );
  });

  it("matches the spec's cwd example", () => {
    expect(
      buildReport({
        pid: 74_877,
        time: 1_795_543_200,
        token,
        argv: ["lazygit"],
        cwd: "/home/user/src/project",
      }),
    ).toBe(
      "\x1b]7577;pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1\x1b\\",
    );
  });

  it("matches the spec's clear example", () => {
    expect(buildReport({ pid: 74_877, time: 1_795_543_200, token })).toBe(
      "\x1b]7577;pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93\x1b\\",
    );
  });
});
