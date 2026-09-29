import { describe, it, expect } from "vitest";
import { detectInstaller, semverGt } from "../src/utils/update-notifier.js";

describe("semverGt", () => {
  it("compares x.y.z", () => {
    expect(semverGt("1.9.0", "1.8.0")).toBe(true);
    expect(semverGt("1.10.0", "1.9.0")).toBe(true);
    expect(semverGt("1.9.0", "1.9.0")).toBe(false);
    expect(semverGt("1.8.9", "1.9.0")).toBe(false);
  });
});

describe("detectInstaller", () => {
  it("recognizes npx, npm, pnpm and bun installs", () => {
    expect(detectInstaller("/Users/a/.npm/_npx/1234/node_modules/@kodwai/cli/dist/bin/kodwai.js").kind).toBe("npx");
    expect(detectInstaller("/x/y.js", { npm_command: "exec" }).kind).toBe("npx");
    const npm = detectInstaller("/usr/local/lib/node_modules/@kodwai/cli/dist/bin/kodwai.js", {});
    expect(npm).toMatchObject({ kind: "global", cmd: "npm", display: "npm i -g @kodwai/cli@latest" });
    expect(detectInstaller("C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@kodwai\\cli\\dist\\bin\\kodwai.js", {}))
      .toMatchObject({ cmd: "npm" });
    expect(detectInstaller("/Users/a/Library/pnpm/global/5/.pnpm/@kodwai+cli@1.8.0/node_modules/@kodwai/cli/dist/bin/kodwai.js", {}))
      .toMatchObject({ cmd: "pnpm" });
    expect(detectInstaller("/Users/a/.bun/install/global/node_modules/@kodwai/cli/dist/bin/kodwai.js", {}))
      .toMatchObject({ cmd: "bun" });
    expect(detectInstaller("/Users/a/code/kodwai/cli/dist/bin/kodwai.js", {}).kind).toBe("unknown");
  });

  it("updates a project-local copy in its project, not globally", () => {
    const bin = "/Users/a/tests/node_modules/@kodwai/cli/dist/bin/kodwai.js";
    const read = (path: string) => (path === "/Users/a/tests/package.json" ? '{"dependencies":{"@kodwai/cli":"^1.8.0"}}' : null);
    expect(detectInstaller(bin, { npm_command: "exec" }, read))
      .toMatchObject({ kind: "global", cmd: "npm", args: ["install", "@kodwai/cli@latest"], cwd: "/Users/a/tests" });
    // A global prefix has no package.json listing the CLI.
    expect(detectInstaller("/usr/local/lib/node_modules/@kodwai/cli/dist/bin/kodwai.js", {}, () => null))
      .toMatchObject({ kind: "global", args: ["install", "-g", "@kodwai/cli@latest"] });
  });
});
