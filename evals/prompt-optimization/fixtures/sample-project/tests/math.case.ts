import { describe, expect, it } from "bun:test";

import { add, multiply } from "../src/math";

describe("math", () => {
  it("adds numbers", () => {
    expect(add(7, 5)).toBe(12);
  });

  it("multiplies numbers", () => {
    expect(multiply(7, 5)).toBe(35);
  });
});
