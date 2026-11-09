import { describe, expect, it } from "bun:test";

import { CASES } from "./cases";

const byId = (id: string) => {
  const found = CASES.find((editCase) => editCase.id === id);
  if (!found) {
    throw new Error(`missing case ${id}`);
  }
  return found;
};

describe("unified-edit cases", () => {
  it("have unique ids", () => {
    const ids = CASES.map((editCase) => editCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("change at least one file when an edit is required", () => {
    for (const editCase of CASES.filter((item) => item.requiresEdit)) {
      const changed = Object.keys(editCase.expected).some(
        (path) => editCase.files[path] !== editCase.expected[path],
      );
      expect({ id: editCase.id, changed }).toEqual({
        id: editCase.id,
        changed: true,
      });
    }
  });

  it("change exactly one row in the 300-row file", () => {
    const { files, expected } = byId("21-large-file-deep-row");
    const before = files["settings.ts"].split("\n");
    const after = expected["settings.ts"].split("\n");
    expect(after.length).toBe(before.length);
    const diffs = before.flatMap((row, index) =>
      row === after[index] ? [] : [index],
    );
    expect(diffs.length).toBe(1);
    expect(after[diffs[0]]).toContain("setting_247");
  });

  it("change only the middle of three identical blocks", () => {
    const { files, expected } = byId("22-near-duplicate-blocks");
    expect(files["retry.ts"].match(/attempts: 3,/g)?.length).toBe(3);
    expect(expected["retry.ts"].match(/attempts: 3,/g)?.length).toBe(2);
    expect(expected["retry.ts"]).toMatch(
      /downloadRetry = \{\n {2}attempts: 9,/,
    );
  });

  it("keep CRLF on every row of the inserted block", () => {
    const text = byId("23-crlf-multi-line-insert").expected["app.ini"];
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
    expect(text).toContain("[server]\r\nhost=0.0.0.0\r\nport=9000\r\n");
  });

  it("change five separated rows", () => {
    const { files, expected } = byId("24-five-hunks");
    const before = files["values.ts"].split("\n");
    const after = expected["values.ts"].split("\n");
    const changed = before.filter((row, index) => row !== after[index]);
    expect(changed).toEqual([
      "const value12 = 12;",
      "const value24 = 24;",
      "const value36 = 36;",
      "const value48 = 48;",
      "const value60 = 60;",
    ]);
  });

  it("keep tabs, trailing spaces, and a missing final newline", () => {
    const makefile = byId("25-tabs-and-trailing-space").expected.Makefile;
    expect(makefile.startsWith("# keep  \n")).toBe(true);
    expect(makefile).toContain("\tgo build -trimpath ./...\n");
    expect(
      byId("26-no-final-newline").expected["LICENSE-NOTE"].endsWith("\n"),
    ).toBe(false);
  });
});
