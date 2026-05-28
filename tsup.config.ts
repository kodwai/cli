import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig({
  entry: {
    "bin/kodwai": "src/bin/kodwai.ts",
  },
  format: ["esm"],
  target: "node20",
  splitting: false,
  sourcemap: true,
  clean: true,
  // Inline the package version so the update notifier can compare against npm.
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
