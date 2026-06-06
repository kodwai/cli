import { describe, it, expect } from "vitest";
import { parseComposerIds } from "../src/traces/cursor.js";

describe("parseComposerIds", () => {
  // The real-world bug: newer Cursor versions store only pointers to the
  // selected/last-focused composers in the per-workspace ItemTable and no
  // longer write the full `allComposers` blob. The old code only read
  // `allComposers`, so freshly-opened workspaces yielded zero composer IDs
  // (and therefore "0 turns from cursor").
  it("reads selectedComposerIds when allComposers is absent (current Cursor schema)", () => {
    const raw = JSON.stringify({
      selectedComposerIds: ["fb6b9b01-f5be-4cac-a110-b26a4323a9df"],
      lastFocusedComposerIds: ["fb6b9b01-f5be-4cac-a110-b26a4323a9df"],
      hasMigratedComposerData: true,
    });
    expect(parseComposerIds(raw)).toEqual(["fb6b9b01-f5be-4cac-a110-b26a4323a9df"]);
  });

  it("reads composerId from allComposers (legacy schema)", () => {
    const raw = JSON.stringify({
      allComposers: [{ composerId: "a1" }, { composerId: "a2" }],
    });
    expect(parseComposerIds(raw)).toEqual(["a1", "a2"]);
  });

  it("unions and de-duplicates across allComposers and selected/lastFocused", () => {
    const raw = JSON.stringify({
      allComposers: [{ composerId: "a1" }],
      selectedComposerIds: ["a1", "a2"],
      lastFocusedComposerIds: ["a2", "a3"],
    });
    expect(parseComposerIds(raw).sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("returns empty array for empty, malformed, or composer-less input", () => {
    expect(parseComposerIds("")).toEqual([]);
    expect(parseComposerIds("not json")).toEqual([]);
    expect(parseComposerIds(JSON.stringify({ hasMigratedComposerData: true }))).toEqual([]);
  });

  it("filters out falsy composer IDs", () => {
    const raw = JSON.stringify({
      allComposers: [{ composerId: "a1" }, { composerId: "" }, {}],
      selectedComposerIds: [null, "a2"],
    });
    expect(parseComposerIds(raw).sort()).toEqual(["a1", "a2"]);
  });
});
