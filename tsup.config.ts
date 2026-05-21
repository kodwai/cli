import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "bin/kodwai": "src/bin/kodwai.ts",
  },
  format: ["esm"],
  target: "node20",
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
