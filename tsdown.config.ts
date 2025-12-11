import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: true,
  shims: true,
  onSuccess: async () => {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile("dist/cli.js", "utf-8");
    if (!content.startsWith("#!/usr/bin/env node")) {
      await fs.writeFile("dist/cli.js", `#!/usr/bin/env node\n${content}`);
    }
  },
});
