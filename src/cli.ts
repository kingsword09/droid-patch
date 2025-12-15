import bin from "tiny-bin";
import { styleText } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { patchDroid, type Patch } from "./patcher.ts";
import {
  createAlias,
  removeAlias,
  listAliases,
  createAliasForWrapper,
} from "./alias.ts";
import { createWebSearchUnifiedFiles } from "./websearch-patch.ts";
import {
  saveAliasMetadata,
  createMetadata,
  loadAliasMetadata,
  listAllMetadata,
  formatPatches,
} from "./metadata.ts";

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

  // Try `which droid` first to find droid in PATH
  try {
    const result = execSync("which droid", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (result && existsSync(result)) {
      return result;
    }
  } catch {
    // which command failed, continue with fallback paths
  }

  // Common installation paths
  const paths = [
    // Default sh install location
    join(home, ".droid", "bin", "droid"),
    // Homebrew on Apple Silicon
    "/opt/homebrew/bin/droid",
    // Homebrew on Intel Mac / Linux
    "/usr/local/bin/droid",
    // Linux system-wide
    "/usr/bin/droid",
    // Current directory
    "./droid",
  ];

  for (const p of paths) {
    if (existsSync(p)) return p;
  }

  // Return default path even if not found (will error later with helpful message)
  return join(home, ".droid", "bin", "droid");
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
  .option(
    "--api-base <url>",
    "Replace Factory API base URL (https://api.factory.ai) with custom URL (binary patch)",
  )
  .option(
    "--websearch",
    "Enable local WebSearch proxy (intercepts search requests)",
  )
  .option(
    "--reasoning-effort",
    "Enable reasoning effort for custom models (set to high, enable UI selector)",
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
    const apiBase = options["api-base"] as string | undefined;
    const websearch = options["websearch"] as boolean;
    // When --websearch is used with --api-base, forward to custom URL
    // Otherwise forward to official Factory API
    const websearchTarget = websearch
      ? apiBase || "https://api.factory.ai"
      : undefined;
    const reasoningEffort = options["reasoning-effort"] as boolean;
    const dryRun = options["dry-run"] as boolean;
    const path = (options.path as string) || findDefaultDroidPath();
    const outputDir = options.output as string | undefined;
    const backup = options.backup !== false;
    const verbose = options.verbose as boolean;

    // If -o is specified with alias, output to that directory with alias name
    const outputPath = outputDir && alias ? join(outputDir, alias) : undefined;

    // Handle --websearch only (no binary patching needed)
    // When --websearch is used alone, create proxy wrapper without modifying binary
    if (websearch && !isCustom && !skipLogin && !reasoningEffort) {
      if (!alias) {
        console.log(
          styleText("red", "Error: Alias name required for --websearch"),
        );
        console.log(
          styleText("gray", "Usage: npx droid-patch --websearch <alias>"),
        );
        process.exit(1);
      }

      console.log(styleText("cyan", "═".repeat(60)));
      console.log(styleText(["cyan", "bold"], "  Droid WebSearch Setup"));
      console.log(styleText("cyan", "═".repeat(60)));
      console.log();
      console.log(styleText("white", `Forward target: ${websearchTarget}`));
      console.log();

      // Create websearch proxy files (proxy script + wrapper)
      const proxyDir = join(homedir(), ".droid-patch", "proxy");
      const { wrapperScript } = await createWebSearchUnifiedFiles(
        proxyDir,
        path,
        alias,
        websearchTarget,
      );

      // Create alias pointing to wrapper
      await createAliasForWrapper(wrapperScript, alias, verbose);

      // Save metadata for update command
      const metadata = createMetadata(alias, path, {
        isCustom: false,
        skipLogin: false,
        apiBase: apiBase || null,
        websearch: true,
        reasoningEffort: false,
      });
      await saveAliasMetadata(metadata);

      console.log();
      console.log(styleText("green", "═".repeat(60)));
      console.log(styleText(["green", "bold"], "  WebSearch Ready!"));
      console.log(styleText("green", "═".repeat(60)));
      console.log();
      console.log("Run directly:");
      console.log(styleText("yellow", `  ${alias}`));
      console.log();
      console.log(styleText("cyan", "Auto-shutdown:"));
      console.log(
        styleText(
          "gray",
          "  Proxy auto-shuts down after 5 min idle (no manual cleanup needed)",
        ),
      );
      console.log(
        styleText("gray", "  To disable: export DROID_PROXY_IDLE_TIMEOUT=0"),
      );
      console.log();
      console.log("Search providers (in priority order):");
      console.log(styleText("yellow", "  1. Smithery Exa (best quality):"));
      console.log(
        styleText("gray", "     export SMITHERY_API_KEY=your_api_key"),
      );
      console.log(
        styleText("gray", "     export SMITHERY_PROFILE=your_profile"),
      );
      console.log(styleText("gray", "  2. Google PSE:"));
      console.log(
        styleText("gray", "     export GOOGLE_PSE_API_KEY=your_api_key"),
      );
      console.log(
        styleText("gray", "     export GOOGLE_PSE_CX=your_search_engine_id"),
      );
      console.log(
        styleText(
          "gray",
          "  3-6. Serper, Brave, SearXNG, DuckDuckGo (fallbacks)",
        ),
      );
      console.log();
      console.log("Debug mode:");
      console.log(styleText("gray", "  export DROID_SEARCH_DEBUG=1"));
      return;
    }

    if (!isCustom && !skipLogin && !apiBase && !websearch && !reasoningEffort) {
      console.log(
        styleText("yellow", "No patch flags specified. Available patches:"),
      );
      console.log(
        styleText(
          "gray",
          "  --is-custom         Patch isCustom for custom models",
        ),
      );
      console.log(
        styleText(
          "gray",
          "  --skip-login        Bypass login by injecting a fake API key",
        ),
      );
      console.log(
        styleText(
          "gray",
          "  --api-base          Replace Factory API URL (binary patch)",
        ),
      );
      console.log(
        styleText("gray", "  --websearch         Enable local WebSearch proxy"),
      );
      console.log(
        styleText(
          "gray",
          "  --reasoning-effort  Set reasoning effort level for custom models",
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
        styleText("cyan", "  npx droid-patch --websearch droid-search"),
      );
      console.log(
        styleText(
          "cyan",
          "  npx droid-patch --websearch --api-base=http://127.0.0.1:20002 my-droid",
        ),
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

    // Add api-base patch: replace the Factory API base URL
    // Original: "https://api.factory.ai" (22 chars)
    // We need to pad the replacement URL to be exactly 22 chars
    // Note: When --websearch is used, --api-base sets the forward target instead of binary patching
    if (apiBase && !websearch) {
      const originalUrl = "https://api.factory.ai";
      const originalLength = originalUrl.length; // 22 chars

      // Validate and normalize the URL
      let normalizedUrl = apiBase.replace(/\/+$/, ""); // Remove trailing slashes

      if (normalizedUrl.length > originalLength) {
        console.log(
          styleText(
            "red",
            `Error: API base URL must be ${originalLength} characters or less`,
          ),
        );
        console.log(
          styleText(
            "gray",
            `  Your URL: "${normalizedUrl}" (${normalizedUrl.length} chars)`,
          ),
        );
        console.log(
          styleText("gray", `  Maximum:  ${originalLength} characters`),
        );
        console.log();
        console.log(
          styleText(
            "yellow",
            "Tip: Use a shorter URL or set up a local redirect.",
          ),
        );
        console.log(styleText("gray", "  Examples:"));
        console.log(styleText("gray", "    http://127.0.0.1:3000 (19 chars)"));
        console.log(styleText("gray", "    http://localhost:80  (19 chars)"));
        process.exit(1);
      }

      // Pad the URL with spaces at the end to match original length
      // Note: trailing spaces in URL are generally ignored
      const paddedUrl = normalizedUrl.padEnd(originalLength, " ");

      patches.push({
        name: "apiBase",
        description: `Replace Factory API URL with "${normalizedUrl}"`,
        pattern: Buffer.from(originalUrl),
        replacement: Buffer.from(paddedUrl),
      });
    }

    // Add reasoning-effort patch: set custom models to use "high" reasoning
    // Also modify UI conditions to show reasoning selector for custom models
    if (reasoningEffort) {
      // ["none"] is 8 chars, ["high"] is 8 chars - perfect match!
      patches.push({
        name: "reasoningEffortSupported",
        description: 'Change supportedReasoningEfforts:["none"] to ["high"]',
        pattern: Buffer.from('supportedReasoningEfforts:["none"]'),
        replacement: Buffer.from('supportedReasoningEfforts:["high"]'),
      });

      // "none" is 4 chars, "high" is 4 chars - perfect match!
      patches.push({
        name: "reasoningEffortDefault",
        description: 'Change defaultReasoningEffort:"none" to "high"',
        pattern: Buffer.from('defaultReasoningEffort:"none"'),
        replacement: Buffer.from('defaultReasoningEffort:"high"'),
      });

      // Change UI condition from length>1 to length>0
      // This allows custom models with single reasoning option to show the selector
      patches.push({
        name: "reasoningEffortUIShow",
        description: "Change supportedReasoningEfforts.length>1 to length>0",
        pattern: Buffer.from("supportedReasoningEfforts.length>1"),
        replacement: Buffer.from("supportedReasoningEfforts.length>0"),
      });

      // Change UI condition from length<=1 to length<=0
      // This enables the reasoning setting in /settings menu for custom models
      patches.push({
        name: "reasoningEffortUIEnable",
        description: "Change supportedReasoningEfforts.length<=1 to length<=0",
        pattern: Buffer.from("supportedReasoningEfforts.length<=1"),
        replacement: Buffer.from("supportedReasoningEfforts.length<=0"),
      });

      // Bypass reasoning effort validation to allow settings.json override
      // This allows "xhigh" in settings.json to work even though default is "high"
      // Original: if(R&&!B.supportedReasoningEfforts.includes(R)) throw error
      // Changed:  if(0&&...) - never throws, any value is accepted
      patches.push({
        name: "reasoningEffortValidationBypass",
        description:
          "Bypass reasoning effort validation (allows xhigh in settings.json)",
        pattern: Buffer.from("if(R&&!B.supportedReasoningEfforts.includes(R))"),
        replacement: Buffer.from(
          "if(0&&!B.supportedReasoningEfforts.includes(R))",
        ),
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

        // If --websearch is also used, create wrapper and point to it
        if (websearch) {
          const proxyDir = join(homedir(), ".droid-patch", "proxy");
          const { wrapperScript } = await createWebSearchUnifiedFiles(
            proxyDir,
            result.outputPath,
            alias,
            websearchTarget,
          );
          await createAliasForWrapper(wrapperScript, alias, verbose);

          console.log();
          console.log(styleText("cyan", "WebSearch enabled"));
          console.log(
            styleText("white", `  Forward target: ${websearchTarget}`),
          );
        } else {
          await createAlias(result.outputPath, alias, verbose);
        }

        // Save metadata for update command
        const metadata = createMetadata(alias, path, {
          isCustom: !!isCustom,
          skipLogin: !!skipLogin,
          apiBase: apiBase || null,
          websearch: !!websearch,
          reasoningEffort: !!reasoningEffort,
        });
        await saveAliasMetadata(metadata);
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
  .command("update", "Update aliases with latest droid binary")
  .argument(
    "[alias]",
    "Specific alias to update (optional, updates all if not specified)",
  )
  .option("--dry-run", "Preview without making changes")
  .option("-p, --path <path>", "Path to new droid binary")
  .option("-v, --verbose", "Enable verbose output")
  .action(async (options, args) => {
    const aliasName = args?.[0] as string | undefined;
    const dryRun = options["dry-run"] as boolean;
    const newBinaryPath = (options.path as string) || findDefaultDroidPath();
    const verbose = options.verbose as boolean;

    console.log(styleText("cyan", "═".repeat(60)));
    console.log(styleText(["cyan", "bold"], "  Droid-Patch Update"));
    console.log(styleText("cyan", "═".repeat(60)));
    console.log();

    // Verify the new binary exists
    if (!existsSync(newBinaryPath)) {
      console.log(
        styleText("red", `Error: Droid binary not found at ${newBinaryPath}`),
      );
      console.log(styleText("gray", "Use -p to specify a different path"));
      process.exit(1);
    }

    // Get aliases to update
    let metaList: Awaited<ReturnType<typeof loadAliasMetadata>>[];
    if (aliasName) {
      const meta = await loadAliasMetadata(aliasName);
      if (!meta) {
        console.log(
          styleText("red", `Error: No metadata found for alias "${aliasName}"`),
        );
        console.log(
          styleText(
            "gray",
            "This alias may have been created before update tracking was added.",
          ),
        );
        console.log(
          styleText(
            "gray",
            "Remove and recreate the alias to enable update support.",
          ),
        );
        process.exit(1);
      }
      metaList = [meta];
    } else {
      metaList = await listAllMetadata();
      if (metaList.length === 0) {
        console.log(styleText("yellow", "No aliases with metadata found."));
        console.log(
          styleText(
            "gray",
            "Create aliases with droid-patch to enable update support.",
          ),
        );
        process.exit(0);
      }
    }

    console.log(styleText("white", `Using droid binary: ${newBinaryPath}`));
    console.log(
      styleText("white", `Found ${metaList.length} alias(es) to update`),
    );
    if (dryRun) {
      console.log(styleText("blue", "(DRY RUN - no changes will be made)"));
    }
    console.log();

    let successCount = 0;
    let failCount = 0;

    for (const meta of metaList) {
      if (!meta) continue;

      console.log(styleText("cyan", `─`.repeat(40)));
      console.log(
        styleText(
          "white",
          `Updating: ${styleText(["cyan", "bold"], meta.name)}`,
        ),
      );
      console.log(
        styleText("gray", `  Patches: ${formatPatches(meta.patches)}`),
      );

      if (dryRun) {
        console.log(styleText("blue", `  [DRY RUN] Would re-apply patches`));
        successCount++;
        continue;
      }

      try {
        // Build patch list based on metadata
        const patches: Patch[] = [];

        if (meta.patches.isCustom) {
          patches.push({
            name: "isCustom",
            description: "Change isCustom:!0 to isCustom:!1",
            pattern: Buffer.from("isCustom:!0"),
            replacement: Buffer.from("isCustom:!1"),
          });
        }

        if (meta.patches.skipLogin) {
          patches.push({
            name: "skipLogin",
            description: "Replace process.env.FACTORY_API_KEY with fake key",
            pattern: Buffer.from("process.env.FACTORY_API_KEY"),
            replacement: Buffer.from('"fk-droid-patch-skip-00000"'),
          });
        }

        if (meta.patches.apiBase) {
          const originalUrl = "https://api.factory.ai";
          const paddedUrl = meta.patches.apiBase.padEnd(
            originalUrl.length,
            " ",
          );
          patches.push({
            name: "apiBase",
            description: `Replace Factory API URL with "${meta.patches.apiBase}"`,
            pattern: Buffer.from(originalUrl),
            replacement: Buffer.from(paddedUrl),
          });
        }

        if (meta.patches.reasoningEffort) {
          patches.push({
            name: "reasoningEffortSupported",
            description:
              'Change supportedReasoningEfforts:["none"] to ["high"]',
            pattern: Buffer.from('supportedReasoningEfforts:["none"]'),
            replacement: Buffer.from('supportedReasoningEfforts:["high"]'),
          });
          patches.push({
            name: "reasoningEffortDefault",
            description: 'Change defaultReasoningEffort:"none" to "high"',
            pattern: Buffer.from('defaultReasoningEffort:"none"'),
            replacement: Buffer.from('defaultReasoningEffort:"high"'),
          });
          patches.push({
            name: "reasoningEffortUIShow",
            description:
              "Change supportedReasoningEfforts.length>1 to length>0",
            pattern: Buffer.from("supportedReasoningEfforts.length>1"),
            replacement: Buffer.from("supportedReasoningEfforts.length>0"),
          });
          patches.push({
            name: "reasoningEffortUIEnable",
            description:
              "Change supportedReasoningEfforts.length<=1 to length<=0",
            pattern: Buffer.from("supportedReasoningEfforts.length<=1"),
            replacement: Buffer.from("supportedReasoningEfforts.length<=0"),
          });
          patches.push({
            name: "reasoningEffortValidationBypass",
            description:
              "Bypass reasoning effort validation (allows xhigh in settings.json)",
            pattern: Buffer.from(
              "if(R&&!B.supportedReasoningEfforts.includes(R))",
            ),
            replacement: Buffer.from(
              "if(0&&!B.supportedReasoningEfforts.includes(R))",
            ),
          });
        }

        // Determine output path based on whether this is a websearch alias
        const binsDir = join(homedir(), ".droid-patch", "bins");
        const outputPath = join(binsDir, `${meta.name}-patched`);

        // Apply patches (only if there are binary patches to apply)
        if (patches.length > 0) {
          const result = await patchDroid({
            inputPath: newBinaryPath,
            outputPath,
            patches,
            dryRun: false,
            backup: false,
            verbose,
          });

          if (!result.success) {
            console.log(styleText("red", `  ✗ Failed to apply patches`));
            failCount++;
            continue;
          }

          // Re-sign on macOS
          if (process.platform === "darwin") {
            try {
              const { execSync } = await import("node:child_process");
              execSync(`codesign --force --deep --sign - "${outputPath}"`, {
                stdio: "pipe",
              });
              if (verbose) {
                console.log(styleText("gray", `  Re-signed binary`));
              }
            } catch {
              console.log(
                styleText("yellow", `  [!] Could not re-sign binary`),
              );
            }
          }
        }

        // If websearch is enabled, regenerate wrapper files
        // Support both new 'websearch' field and old 'proxy' field for backward compatibility
        const hasWebsearch = meta.patches.websearch || !!meta.patches.proxy;
        if (hasWebsearch) {
          // Determine forward target: apiBase > proxy (legacy) > default
          const forwardTarget =
            meta.patches.apiBase ||
            meta.patches.proxy ||
            "https://api.factory.ai";
          const proxyDir = join(homedir(), ".droid-patch", "proxy");
          const targetBinaryPath =
            patches.length > 0 ? outputPath : newBinaryPath;
          await createWebSearchUnifiedFiles(
            proxyDir,
            targetBinaryPath,
            meta.name,
            forwardTarget,
          );
          if (verbose) {
            console.log(styleText("gray", `  Regenerated websearch wrapper`));
          }
          // Migrate old proxy field to new websearch field
          if (meta.patches.proxy && !meta.patches.websearch) {
            meta.patches.websearch = true;
            meta.patches.apiBase = meta.patches.proxy;
            delete meta.patches.proxy;
          }
        }

        // Update metadata
        meta.updatedAt = new Date().toISOString();
        meta.originalBinaryPath = newBinaryPath;
        await saveAliasMetadata(meta);

        console.log(styleText("green", `  ✓ Updated successfully`));
        successCount++;
      } catch (error) {
        console.log(styleText("red", `  ✗ Error: ${(error as Error).message}`));
        if (verbose) {
          console.error((error as Error).stack);
        }
        failCount++;
      }
    }

    console.log();
    console.log(styleText("cyan", "═".repeat(60)));
    if (dryRun) {
      console.log(styleText(["blue", "bold"], "  DRY RUN COMPLETE"));
      console.log(
        styleText("gray", `  Would update ${successCount} alias(es)`),
      );
    } else if (failCount === 0) {
      console.log(styleText(["green", "bold"], "  UPDATE COMPLETE"));
      console.log(styleText("gray", `  Updated ${successCount} alias(es)`));
    } else {
      console.log(
        styleText(["yellow", "bold"], "  UPDATE FINISHED WITH ERRORS"),
      );
      console.log(
        styleText("gray", `  Success: ${successCount}, Failed: ${failCount}`),
      );
    }
    console.log(styleText("cyan", "═".repeat(60)));
  })
  .run()
  .catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
