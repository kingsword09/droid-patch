import bin from "tiny-bin";
import { styleText } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { patchDroid, type Patch } from "./patcher.ts";
import { createAlias, removeAlias, listAliases } from "./alias.ts";

const version = "0.1.0";

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
  .option("--dry-run", "Verify patches without actually modifying the binary")
  .option("-p, --path <path>", "Path to the droid binary")
  .option("-o, --output <path>", "Output path for patched binary")
  .option("--no-backup", "Do not create backup of original binary")
  .option("-v, --verbose", "Enable verbose output")
  .argument("[alias]", "Alias name for the patched binary")
  .action(async ({ args, options }) => {
    const alias = args[0] as string | undefined;
    const isCustom = options["is-custom"] as boolean;
    const dryRun = options["dry-run"] as boolean;
    const path = (options.path as string) || findDefaultDroidPath();
    const output = options.output as string | undefined;
    const backup = options.backup !== false;
    const verbose = options.verbose as boolean;

    if (!isCustom) {
      console.log(
        styleText("yellow", "No patch flags specified. Available patches:"),
      );
      console.log(
        styleText("gray", "  --is-custom    Patch isCustom for custom models"),
      );
      console.log();
      console.log("Usage examples:");
      console.log(
        styleText("cyan", "  npx droid-patch --is-custom droid-custom"),
      );
      process.exit(1);
    }

    if (!alias && !dryRun) {
      console.log(styleText("red", "Error: alias name is required"));
      console.log(
        styleText("gray", "Usage: droid-patch --is-custom <alias-name>"),
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

    try {
      const result = await patchDroid({
        inputPath: path,
        outputPath: output,
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
  .command("remove", "Remove a droid-patch alias")
  .argument("<alias>", "Alias name to remove")
  .action(async ({ args }) => {
    await removeAlias(args[0] as string);
  })
  .run()
  .catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
