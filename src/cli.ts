import bin from "tiny-bin";
import { styleText } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { patchDroid, type Patch } from "./patcher.ts";
import { createAlias, removeAlias, listAliases } from "./alias.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const version = getVersion();

function findDefaultDroidPath(): string {
  const home = homedir();
  const paths = [
    join(home, ".droid/bin/droid"),
    "/usr/local/bin/droid",
    "./droid",
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return join(home, ".droid/bin/droid");
}

bin("droid-patch", "CLI tool to patch droid binary with various modifications")
  .package("droid-patch", version)
  .option(
    "--is-custom",
    "Patch isCustom:!0 to isCustom:!1 (enable context compression for custom models)",
  )
  .option(
    "--skip-login",
    "Inject a fake FACTORY_API_KEY to bypass login requirement (no real key needed)",
  )
  .option("--dry-run", "Verify patches without actually modifying the binary")
  .option("-p, --path <path>", "Path to the droid binary")
  .option("-o, --output <dir>", "Output directory for patched binary")
  .option("--no-backup", "Do not create backup of original binary")
  .option("-v, --verbose", "Enable verbose output")
  .argument("[alias]", "Alias name for the patched binary")
  .action(async (options, args) => {
    const alias = args?.[0] as string | undefined;
    const isCustom = options["is-custom"] as boolean;
    const skipLogin = options["skip-login"] as boolean;
    const dryRun = options["dry-run"] as boolean;
    const path = (options.path as string) || findDefaultDroidPath();
    const outputDir = options.output as string | undefined;
    const backup = options.backup !== false;
    const verbose = options.verbose as boolean;

    // If -o is specified with alias, output to that directory with alias name
    const outputPath = outputDir && alias ? join(outputDir, alias) : undefined;

    if (!isCustom && !skipLogin) {
      console.log(
        styleText("yellow", "No patch flags specified. Available patches:"),
      );
      console.log(
        styleText("gray", "  --is-custom    Patch isCustom for custom models"),
      );
      console.log(
        styleText(
          "gray",
          "  --skip-login   Bypass login by injecting a fake API key",
        ),
      );
      console.log();
      console.log("Usage examples:");
      console.log(
        styleText("cyan", "  npx droid-patch --is-custom droid-custom"),
      );
      console.log(
        styleText("cyan", "  npx droid-patch --skip-login droid-nologin"),
      );
      console.log(
        styleText(
          "cyan",
          "  npx droid-patch --is-custom --skip-login droid-patched",
        ),
      );
      console.log(
        styleText("cyan", "  npx droid-patch --skip-login -o . my-droid"),
      );
      process.exit(1);
    }

    if (!alias && !dryRun) {
      console.log(styleText("red", "Error: alias name is required"));
      console.log(
        styleText(
          "gray",
          "Usage: droid-patch [--is-custom] [--skip-login] [-o <dir>] <alias-name>",
        ),
      );
      process.exit(1);
    }

    console.log(styleText("cyan", "═".repeat(60)));
    console.log(styleText(["cyan", "bold"], "  Droid Binary Patcher"));
    console.log(styleText("cyan", "═".repeat(60)));
    console.log();

    const patches: Patch[] = [];
    if (isCustom) {
      patches.push({
        name: "isCustom",
        description: "Change isCustom:!0 to isCustom:!1",
        pattern: Buffer.from("isCustom:!0"),
        replacement: Buffer.from("isCustom:!1"),
      });
    }

    // Add skip-login patch: replace process.env.FACTORY_API_KEY with a fixed fake key
    // "process.env.FACTORY_API_KEY" is 27 chars, we replace with "fk-droid-patch-skip-00000" (25 chars + quotes = 27)
    if (skipLogin) {
      patches.push({
        name: "skipLogin",
        description:
          'Replace process.env.FACTORY_API_KEY with "fk-droid-patch-skip-00000"',
        pattern: Buffer.from("process.env.FACTORY_API_KEY"),
        replacement: Buffer.from('"fk-droid-patch-skip-00000"'),
      });
    }

    try {
      const result = await patchDroid({
        inputPath: path,
        outputPath: outputPath,
        patches,
        dryRun,
        backup,
        verbose,
      });

      if (dryRun) {
        console.log();
        console.log(styleText("blue", "═".repeat(60)));
        console.log(styleText(["blue", "bold"], "  DRY RUN COMPLETE"));
        console.log(styleText("blue", "═".repeat(60)));
        console.log();
        console.log(
          styleText("gray", "To apply the patches, run without --dry-run:"),
        );
        console.log(
          styleText(
            "cyan",
            `  npx droid-patch --is-custom ${alias || "<alias-name>"}`,
          ),
        );
        process.exit(0);
      }

      // If -o is specified, just output the file without creating alias
      if (outputDir && result.success && result.outputPath) {
        console.log();
        console.log(styleText("green", "═".repeat(60)));
        console.log(styleText(["green", "bold"], "  PATCH SUCCESSFUL"));
        console.log(styleText("green", "═".repeat(60)));
        console.log();
        console.log(
          styleText("white", `Patched binary saved to: ${result.outputPath}`),
        );
        process.exit(0);
      }

      if (result.success && result.outputPath && alias) {
        console.log();
        await createAlias(result.outputPath, alias, verbose);
      }

      if (result.success) {
        console.log();
        console.log(styleText("green", "═".repeat(60)));
        console.log(styleText(["green", "bold"], "  PATCH SUCCESSFUL"));
        console.log(styleText("green", "═".repeat(60)));
      }

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(styleText("red", `Error: ${(error as Error).message}`));
      if (verbose) console.error((error as Error).stack);
      process.exit(1);
    }
  })
  .command("list", "List all droid-patch aliases")
  .action(async () => {
    await listAliases();
  })
  .command("remove", "Remove a droid-patch alias or patched binary file")
  .argument("<alias-or-path>", "Alias name or file path to remove")
  .action(async (_options, args) => {
    const target = args[0] as string;
    // Check if it's a file path (contains / or .)
    if (target.includes("/") || existsSync(target)) {
      // It's a file path, delete directly
      const { unlink } = await import("node:fs/promises");
      try {
        await unlink(target);
        console.log(styleText("green", `[*] Removed: ${target}`));
      } catch (error) {
        console.error(styleText("red", `Error: ${(error as Error).message}`));
        process.exit(1);
      }
    } else {
      // It's an alias name
      await removeAlias(target);
    }
  })
  .command("version", "Print droid-patch version")
  .action(() => {
    console.log(`droid-patch v${version}`);
  })
  .run()
  .catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
