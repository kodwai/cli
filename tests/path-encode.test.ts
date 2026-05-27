import { describe, it, expect } from "vitest";
import { encodeProjectPath } from "../src/traces/path-encode.js";

describe("encodeProjectPath", () => {
  it("encodes a POSIX absolute path (macOS/Linux)", () => {
    expect(encodeProjectPath("/Users/x/proj")).toBe("-Users-x-proj");
  });

  it("encodes a Windows absolute path (backslashes + drive colon)", () => {
    expect(encodeProjectPath("C:\\Users\\x\\proj")).toBe("C--Users-x-proj");
  });

  it("encodes a Windows path with mixed separators", () => {
    expect(encodeProjectPath("C:/Users/x/proj")).toBe("C--Users-x-proj");
  });

  it("encodes a deeper POSIX path", () => {
    expect(encodeProjectPath("/home/alice/dev/my-project")).toBe("-home-alice-dev-my-project");
  });

  it("encodes a deeper Windows path", () => {
    expect(encodeProjectPath("D:\\work\\kodwai\\cli")).toBe("D--work-kodwai-cli");
  });

  it("returns an empty string unchanged", () => {
    expect(encodeProjectPath("")).toBe("");
  });

  it("is a no-op on an already-encoded path (no separators or colons)", () => {
    expect(encodeProjectPath("-Users-x-proj")).toBe("-Users-x-proj");
  });
});
