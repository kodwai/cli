import { describe, it, expect } from "vitest";
import { pickPrimaryModel } from "../src/traces/model.js";

describe("pickPrimaryModel", () => {
  it("returns the most frequent non-empty model", () => {
    expect(pickPrimaryModel(["gpt-5.5", "gpt-5.5", "gpt-5"])).toBe("gpt-5.5");
  });
  it("ignores empty, null, and 'default' (case-insensitive)", () => {
    expect(pickPrimaryModel([null, "", "Default", "default", "claude-opus-4-8"])).toBe("claude-opus-4-8");
  });
  it("returns undefined when there is no usable signal", () => {
    expect(pickPrimaryModel([null, "", "default"])).toBeUndefined();
    expect(pickPrimaryModel([])).toBeUndefined();
  });
  it("breaks ties by first appearance", () => {
    expect(pickPrimaryModel(["a", "b", "a", "b"])).toBe("a");
  });
});
