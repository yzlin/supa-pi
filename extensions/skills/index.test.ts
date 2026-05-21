import { describe, expect, it } from "bun:test";

import { skillOperationLabel } from "./index";

describe("skills command activity labels", () => {
  it("preserves known /skill subcommand labels", () => {
    expect(skillOperationLabel("list")).toBe("Loading skills…");
    expect(skillOperationLabel("search")).toBe("Searching skills…");
    expect(skillOperationLabel("install")).toBe("Installing skill…");
    expect(skillOperationLabel("update")).toBe("Updating skills…");
    expect(skillOperationLabel("remove")).toBe("Removing skill…");
  });

  it("uses the entered token for unknown /skill subcommand labels", () => {
    expect(skillOperationLabel("unknown", "wat")).toBe("Running skill wat…");
  });
});
