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
  clearAllAliases,
  removeAliasesByFilter,
  type FilterFlag,
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

function getDroidVersion(droidPath: string): string | undefined {
  try {
    const result = execSync(`"${droidPath}" --version`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    // Parse version from output like "droid 1.2.3" or just "1.2.3"
    const match = result.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : result || undefined;
  } catch {
    return undefined;
  }
}

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
    "Replace API URL (standalone: binary patch, max 22 chars; with --websearch: proxy forward target, no limit)",
  )
  .option(
    "--websearch",
    "Enable local WebSearch proxy (each instance runs own proxy, auto-cleanup on exit)",
  )
  .option("--standalone", "Standalone mode: mock non-LLM Factory APIs (use with --websearch)")
  .option(
    "--reasoning-effort",
    "Enable reasoning effort for custom models (set to high, enable UI selector)",
  )
  .option(
    "--disable-telemetry",
    "Disable telemetry and Sentry error reporting (block data uploads)",
  )
  .option(
    "--auto-high",
    "Set default autonomy mode to auto-high (bypass settings.json race condition)",
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
    const standalone = options["standalone"] as boolean;
    // When --websearch is used with --api-base, forward to custom URL
    // Otherwise forward to official Factory API
    const websearchTarget = websearch ? apiBase || "https://api.factory.ai" : undefined;
    const reasoningEffort = options["reasoning-effort"] as boolean;
    const noTelemetry = options["disable-telemetry"] as boolean;
    const autoHigh = options["auto-high"] as boolean;
    const dryRun = options["dry-run"] as boolean;
    const path = (options.path as string) || findDefaultDroidPath();
    const outputDir = options.output as string | undefined;
    const backup = options.backup !== false;
    const verbose = options.verbose as boolean;

    // If -o is specified with alias, output to that directory with alias name
    const outputPath = outputDir && alias ? join(outputDir, alias) : undefined;

    const needsBinaryPatch =
      !!isCustom ||
      !!skipLogin ||
      !!reasoningEffort ||
      !!noTelemetry ||
      !!autoHigh ||
      (!!apiBase && !websearch);

    // Wrapper-only mode (no binary patching needed):
    // - --websearch (optional --standalone)
    if (!needsBinaryPatch && websearch) {
      if (!alias) {
        console.log(styleText("red", "Error: Alias name required for --websearch"));
        console.log(styleText("gray", "Usage: npx droid-patch --websearch <alias>"));
        process.exit(1);
      }

      console.log(styleText("cyan", "═".repeat(60)));
      console.log(styleText(["cyan", "bold"], "  Droid Wrapper Setup"));
      console.log(styleText("cyan", "═".repeat(60)));
      console.log();
      if (websearch) {
        console.log(styleText("white", `WebSearch: enabled`));
        console.log(styleText("white", `Forward target: ${websearchTarget}`));
        if (standalone) {
          console.log(styleText("white", `Standalone mode: enabled`));
        }
      }
      console.log();

      let execTargetPath = path;
      // Create websearch proxy files (proxy script + wrapper)
      const proxyDir = join(homedir(), ".droid-patch", "proxy");
      const { wrapperScript } = await createWebSearchUnifiedFiles(
        proxyDir,
        execTargetPath,
        alias,
        websearchTarget,
        standalone,
      );
      execTargetPath = wrapperScript;

      // Create alias pointing to outer wrapper
      const aliasResult = await createAliasForWrapper(execTargetPath, alias, verbose);

      // Save metadata for update command
      const droidVersion = getDroidVersion(path);
      const metadata = createMetadata(
        alias,
        path,
        {
          isCustom: false,
          skipLogin: false,
          apiBase: apiBase || null,
          websearch: !!websearch,
          reasoningEffort: false,
          noTelemetry: false,
          standalone: standalone,
        },
        {
          droidPatchVersion: version,
          droidVersion,
          aliasPath: aliasResult.aliasPath,
        },
      );
      await saveAliasMetadata(metadata);

      console.log();
      console.log(styleText("green", "═".repeat(60)));
      console.log(styleText(["green", "bold"], "  Wrapper Ready!"));
      console.log(styleText("green", "═".repeat(60)));
      console.log();
      console.log("Run directly:");
      console.log(styleText("yellow", `  ${alias}`));
      console.log();
      if (websearch) {
        console.log(styleText("cyan", "Auto-shutdown:"));
        console.log(
          styleText("gray", "  Proxy auto-shuts down after 5 min idle (no manual cleanup needed)"),
        );
        console.log(styleText("gray", "  To disable: export DROID_PROXY_IDLE_TIMEOUT=0"));
        console.log();
        console.log("Search providers (in priority order):");
        console.log(styleText("yellow", "  1. Smithery Exa (best quality):"));
        console.log(styleText("gray", "     export SMITHERY_API_KEY=your_api_key"));
        console.log(styleText("gray", "     export SMITHERY_PROFILE=your_profile"));
        console.log(styleText("gray", "  2. Google PSE:"));
        console.log(styleText("gray", "     export GOOGLE_PSE_API_KEY=your_api_key"));
        console.log(styleText("gray", "     export GOOGLE_PSE_CX=your_search_engine_id"));
        console.log(styleText("gray", "  3-6. Serper, Brave, SearXNG, DuckDuckGo (fallbacks)"));
        console.log();
        console.log("Debug mode:");
        console.log(styleText("gray", "  export DROID_SEARCH_DEBUG=1"));
      }
      return;
    }

    if (
      !isCustom &&
      !skipLogin &&
      !apiBase &&
      !websearch &&
      !reasoningEffort &&
      !noTelemetry &&
      !autoHigh
    ) {
      console.log(styleText("yellow", "No patch flags specified. Available patches:"));
      console.log(styleText("gray", "  --is-custom         Patch isCustom for custom models"));
      console.log(
        styleText("gray", "  --skip-login        Bypass login by injecting a fake API key"),
      );
      console.log(
        styleText(
          "gray",
          "  --api-base          Replace API URL (standalone: max 22 chars; with --websearch: no limit)",
        ),
      );
      console.log(styleText("gray", "  --websearch         Enable local WebSearch proxy"));
      console.log(
        styleText("gray", "  --reasoning-effort  Set reasoning effort level for custom models"),
      );
      console.log(
        styleText("gray", "  --disable-telemetry Disable telemetry and Sentry error reporting"),
      );
      console.log(
        styleText("gray", "  --auto-high         Set default autonomy mode to auto-high"),
      );
      console.log(
        styleText("gray", "  --standalone        Standalone mode: mock non-LLM Factory APIs"),
      );
      console.log();
      console.log("Usage examples:");
      console.log(styleText("cyan", "  npx droid-patch --is-custom droid-custom"));
      console.log(styleText("cyan", "  npx droid-patch --skip-login droid-nologin"));
      console.log(styleText("cyan", "  npx droid-patch --is-custom --skip-login droid-patched"));
      console.log(styleText("cyan", "  npx droid-patch --websearch droid-search"));
      console.log(styleText("cyan", "  npx droid-patch --websearch --standalone droid-local"));
      console.log(styleText("cyan", "  npx droid-patch --disable-telemetry droid-private"));
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
        description: 'Replace process.env.FACTORY_API_KEY with "fk-droid-patch-skip-00000"',
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
          styleText("red", `Error: API base URL must be ${originalLength} characters or less`),
        );
        console.log(
          styleText("gray", `  Your URL: "${normalizedUrl}" (${normalizedUrl.length} chars)`),
        );
        console.log(styleText("gray", `  Maximum:  ${originalLength} characters`));
        console.log();
        console.log(styleText("yellow", "Tip: Use a shorter URL or set up a local redirect."));
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
      // v0.39.0+: T!=="none"&&T!=="off"&&!W.supportedReasoningEfforts.includes(T)
      // Changed:  T!="none"&&T!="off"&&0&&W... - use != (2 chars less) + 0&& (2 chars more) = same length
      // Logic: && 0 && makes entire condition always false, bypassing validation
      patches.push({
        name: "reasoningEffortValidationBypass",
        description: "Bypass reasoning effort validation (allows xhigh in settings.json)",
        pattern: Buffer.from('T!=="none"&&T!=="off"&&!W.supportedReasoningEfforts.includes(T)'),
        replacement: Buffer.from('T!="none"&&T!="off"&&0&&W.supportedReasoningEfforts.includes(T)'),
      });
    }

    // Add no-telemetry patches: disable telemetry uploads and Sentry error reporting
    // Strategy:
    // 1. Break environment variable names so Sentry is never initialized (Q1() returns false)
    // 2. Invert flushToWeb condition so it returns early without making any fetch request
    if (noTelemetry) {
      // Patch 1: Break Sentry environment variable checks
      // Q1() function checks: VITE_VERCEL_ENV, ENABLE_SENTRY, NEXT_PUBLIC_ENABLE_SENTRY, FACTORY_ENABLE_SENTRY
      // By changing first letter to X, the env vars will never match, so Q1() returns false
      // and Sentry is never initialized
      patches.push({
        name: "noTelemetrySentryEnv1",
        description: "Break ENABLE_SENTRY env var check (E->X)",
        pattern: Buffer.from("ENABLE_SENTRY"),
        replacement: Buffer.from("XNABLE_SENTRY"),
      });

      patches.push({
        name: "noTelemetrySentryEnv2",
        description: "Break VITE_VERCEL_ENV env var check (V->X)",
        pattern: Buffer.from("VITE_VERCEL_ENV"),
        replacement: Buffer.from("XITE_VERCEL_ENV"),
      });

      // Patch 2: Make flushToWeb always return early to prevent ANY fetch request
      // Original: if(this.webEvents.length===0)return; // returns only when empty
      // Changed:  if(!0||this.webEvents.length)return; // !0=true, ALWAYS returns
      // Result: Function always exits immediately, no telemetry is ever sent
      patches.push({
        name: "noTelemetryFlushBlock",
        description: "Make flushToWeb always return (!0|| = always true)",
        pattern: Buffer.from("this.webEvents.length===0"),
        replacement: Buffer.from("!0||this.webEvents.length"),
      });
    }

    // Add auto-high autonomy patch: hardcode getCurrentAutonomyMode to return "auto-high"
    // This bypasses the race condition where AutonomyManager.initialize() runs before
    // SettingsService has loaded settings.json, causing the default "normal" to be used.
    // Pattern (50 chars): getCurrentAutonomyMode(){return this.autonomyMode}
    // Replace (50 chars): getCurrentAutonomyMode(){return"auto-high"       }
    if (autoHigh) {
      patches.push({
        name: "autoHighAutonomy",
        description: 'Hardcode getCurrentAutonomyMode() to return "auto-high"',
        pattern: Buffer.from("getCurrentAutonomyMode(){return this.autonomyMode}"),
        replacement: Buffer.from('getCurrentAutonomyMode(){return"auto-high"       }'),
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
        console.log(styleText("gray", "To apply the patches, run without --dry-run:"));
        console.log(styleText("cyan", `  npx droid-patch --is-custom ${alias || "<alias-name>"}`));
        process.exit(0);
      }

      // If -o is specified, just output the file without creating alias
      if (outputDir && result.success && result.outputPath) {
        console.log();
        console.log(styleText("green", "═".repeat(60)));
        console.log(styleText(["green", "bold"], "  PATCH SUCCESSFUL"));
        console.log(styleText("green", "═".repeat(60)));
        console.log();
        console.log(styleText("white", `Patched binary saved to: ${result.outputPath}`));
        process.exit(0);
      }

      if (result.success && result.outputPath && alias) {
        console.log();

        let execTargetPath = result.outputPath;

        if (websearch) {
          const proxyDir = join(homedir(), ".droid-patch", "proxy");
          const { wrapperScript } = await createWebSearchUnifiedFiles(
            proxyDir,
            execTargetPath,
            alias,
            websearchTarget,
            standalone,
          );
          execTargetPath = wrapperScript;

          console.log();
          console.log(styleText("cyan", "WebSearch enabled"));
          console.log(styleText("white", `  Forward target: ${websearchTarget}`));
          if (standalone) {
            console.log(styleText("white", `  Standalone mode: enabled`));
          }
        }

        let aliasResult;
        if (websearch) {
          aliasResult = await createAliasForWrapper(execTargetPath, alias, verbose);
        } else {
          aliasResult = await createAlias(result.outputPath, alias, verbose);
        }

        // Save metadata for update command
        const droidVersion = getDroidVersion(path);
        const metadata = createMetadata(
          alias,
          path,
          {
            isCustom: !!isCustom,
            skipLogin: !!skipLogin,
            apiBase: apiBase || null,
            websearch: !!websearch,
            reasoningEffort: !!reasoningEffort,
            noTelemetry: !!noTelemetry,
            standalone: !!standalone,
            autoHigh: !!autoHigh,
          },
          {
            droidPatchVersion: version,
            droidVersion,
            aliasPath: aliasResult.aliasPath,
          },
        );
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
  .command("remove", "Remove alias(es) by name or filter")
  .argument("[alias-or-path]", "Alias name or file path to remove")
  .option("--patch-version <version>", "Remove aliases created by this droid-patch version")
  .option("--droid-version <version>", "Remove aliases for this droid version")
  .option(
    "--flag <flag>",
    "Remove aliases with this flag (is-custom, skip-login, websearch, api-base, reasoning-effort, disable-telemetry, standalone)",
  )
  .action(async (options, args) => {
    const target = args?.[0] as string | undefined;
    const patchVersion = options["patch-version"] as string | undefined;
    const droidVersion = options["droid-version"] as string | undefined;
    const flagRaw = options.flag as string | undefined;
    let flag: FilterFlag | undefined;
    if (flagRaw) {
      const allowedFlags: FilterFlag[] = [
        "is-custom",
        "skip-login",
        "websearch",
        "api-base",
        "reasoning-effort",
        "disable-telemetry",
        "standalone",
      ];
      if (!allowedFlags.includes(flagRaw as FilterFlag)) {
        console.error(styleText("red", `Error: Invalid --flag value: ${flagRaw}`));
        console.error(styleText("gray", `Allowed: ${allowedFlags.join(", ")}`));
        process.exit(1);
      }
      flag = flagRaw as FilterFlag;
    }

    // If filter options are provided, use filter mode
    if (patchVersion || droidVersion || flag) {
      await removeAliasesByFilter({
        patchVersion,
        droidVersion,
        flags: flag ? [flag] : undefined,
      });
      return;
    }

    // If no target and no filter, show error
    if (!target) {
      console.error(
        styleText(
          "red",
          "Error: Provide an alias name or use filter options (--patch-version, --droid-version, --flag)",
        ),
      );
      process.exit(1);
    }

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
  .command("clear", "Remove all droid-patch aliases and related files")
  .action(async () => {
    await clearAllAliases();
  })
  .command("update", "Update aliases with latest droid binary")
  .argument("[alias]", "Specific alias to update (optional, updates all if not specified)")
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
      console.log(styleText("red", `Error: Droid binary not found at ${newBinaryPath}`));
      console.log(styleText("gray", "Use -p to specify a different path"));
      process.exit(1);
    }

    // Get aliases to update
    let metaList: Awaited<ReturnType<typeof loadAliasMetadata>>[];
    if (aliasName) {
      const meta = await loadAliasMetadata(aliasName);
      if (!meta) {
        console.log(styleText("red", `Error: No metadata found for alias "${aliasName}"`));
        console.log(
          styleText("gray", "This alias may have been created before update tracking was added."),
        );
        console.log(styleText("gray", "Remove and recreate the alias to enable update support."));
        process.exit(1);
      }
      metaList = [meta];
    } else {
      metaList = await listAllMetadata();
      if (metaList.length === 0) {
        console.log(styleText("yellow", "No aliases with metadata found."));
        console.log(styleText("gray", "Create aliases with droid-patch to enable update support."));
        process.exit(0);
      }
    }

    console.log(styleText("white", `Using droid binary: ${newBinaryPath}`));
    console.log(styleText("white", `Found ${metaList.length} alias(es) to update`));
    if (dryRun) {
      console.log(styleText("blue", "(DRY RUN - no changes will be made)"));
    }
    console.log();

    let successCount = 0;
    let failCount = 0;

    for (const meta of metaList) {
      if (!meta) continue;

      console.log(styleText("cyan", `─`.repeat(40)));
      console.log(styleText("white", `Updating: ${styleText(["cyan", "bold"], meta.name)}`));
      console.log(styleText("gray", `  Patches: ${formatPatches(meta.patches)}`));

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

        // Only apply apiBase binary patch when NOT using websearch
        // When websearch is enabled, apiBase is used as forward target, not binary patch
        if (meta.patches.apiBase && !meta.patches.websearch) {
          const originalUrl = "https://api.factory.ai";
          const paddedUrl = meta.patches.apiBase.padEnd(originalUrl.length, " ");
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
            description: 'Change supportedReasoningEfforts:["none"] to ["high"]',
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
            description: "Change supportedReasoningEfforts.length>1 to length>0",
            pattern: Buffer.from("supportedReasoningEfforts.length>1"),
            replacement: Buffer.from("supportedReasoningEfforts.length>0"),
          });
          patches.push({
            name: "reasoningEffortUIEnable",
            description: "Change supportedReasoningEfforts.length<=1 to length<=0",
            pattern: Buffer.from("supportedReasoningEfforts.length<=1"),
            replacement: Buffer.from("supportedReasoningEfforts.length<=0"),
          });
          patches.push({
            name: "reasoningEffortValidationBypass",
            description: "Bypass reasoning effort validation (allows xhigh in settings.json)",
            pattern: Buffer.from('T!=="none"&&T!=="off"&&!W.supportedReasoningEfforts.includes(T)'),
            replacement: Buffer.from(
              'T!="none"&&T!="off"&&0&&W.supportedReasoningEfforts.includes(T)',
            ),
          });
        }

        if (meta.patches.noTelemetry) {
          patches.push({
            name: "noTelemetrySentryEnv1",
            description: "Break ENABLE_SENTRY env var check (E->X)",
            pattern: Buffer.from("ENABLE_SENTRY"),
            replacement: Buffer.from("XNABLE_SENTRY"),
          });
          patches.push({
            name: "noTelemetrySentryEnv2",
            description: "Break VITE_VERCEL_ENV env var check (V->X)",
            pattern: Buffer.from("VITE_VERCEL_ENV"),
            replacement: Buffer.from("XITE_VERCEL_ENV"),
          });
          patches.push({
            name: "noTelemetryFlushBlock",
            description: "Make flushToWeb always return (!0|| = always true)",
            pattern: Buffer.from("this.webEvents.length===0"),
            replacement: Buffer.from("!0||this.webEvents.length"),
          });
        }

        if (meta.patches.autoHigh) {
          patches.push({
            name: "autoHighAutonomy",
            description: 'Hardcode getCurrentAutonomyMode() to return "auto-high"',
            pattern: Buffer.from("getCurrentAutonomyMode(){return this.autonomyMode}"),
            replacement: Buffer.from('getCurrentAutonomyMode(){return"auto-high"       }'),
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
              console.log(styleText("yellow", `  [!] Could not re-sign binary`));
            }
          }
        }

        let execTargetPath = patches.length > 0 ? outputPath : newBinaryPath;

        // If websearch is enabled, regenerate wrapper files
        // Support both new 'websearch' field and old 'proxy' field for backward compatibility
        const hasWebsearch = meta.patches.websearch || !!meta.patches.proxy;
        if (hasWebsearch) {
          // Determine forward target: apiBase > proxy (legacy) > default
          const forwardTarget =
            meta.patches.apiBase || meta.patches.proxy || "https://api.factory.ai";
          const proxyDir = join(homedir(), ".droid-patch", "proxy");
          const { wrapperScript } = await createWebSearchUnifiedFiles(
            proxyDir,
            execTargetPath,
            meta.name,
            forwardTarget,
            meta.patches.standalone || false,
          );
          execTargetPath = wrapperScript;
          if (verbose) {
            console.log(styleText("gray", `  Regenerated websearch wrapper`));
            if (meta.patches.standalone) {
              console.log(styleText("gray", `  Standalone mode: enabled`));
            }
          }
          // Migrate old proxy field to new websearch field
          if (meta.patches.proxy && !meta.patches.websearch) {
            meta.patches.websearch = true;
            meta.patches.apiBase = meta.patches.proxy;
            delete meta.patches.proxy;
          }
        }

        // If this alias previously used removed features (statusline/sessions), drop legacy flags
        // so the updated alias points directly to the new target wrapper/binary.
        delete (meta.patches as Record<string, unknown>).statusline;
        delete (meta.patches as Record<string, unknown>).sessions;

        // Update symlink - find existing or use stored aliasPath
        const { symlink, unlink, readlink, lstat } = await import("node:fs/promises");
        let aliasPath = meta.aliasPath;

        // If aliasPath not stored (old version), try to find existing symlink
        if (!aliasPath) {
          const commonPathDirs = [
            join(homedir(), ".local/bin"),
            join(homedir(), "bin"),
            join(homedir(), ".bin"),
            "/opt/homebrew/bin",
            "/usr/local/bin",
            join(homedir(), ".droid-patch", "aliases"),
          ];

          for (const dir of commonPathDirs) {
            const possiblePath = join(dir, meta.name);
            if (existsSync(possiblePath)) {
              try {
                const stats = await lstat(possiblePath);
                if (stats.isSymbolicLink()) {
                  const target = await readlink(possiblePath);
                  if (
                    target.includes(".droid-patch/bins") ||
                    target.includes(".droid-patch/proxy") ||
                    target.includes(".droid-patch/statusline")
                  ) {
                    aliasPath = possiblePath;
                    if (verbose) {
                      console.log(styleText("gray", `  Found existing symlink: ${aliasPath}`));
                    }
                    break;
                  }
                }
              } catch {
                // Ignore errors, continue searching
              }
            }
          }
        }

        // Update symlink if we have a path
        if (aliasPath) {
          try {
            if (existsSync(aliasPath)) {
              const currentTarget = await readlink(aliasPath);
              if (currentTarget !== execTargetPath) {
                await unlink(aliasPath);
                await symlink(execTargetPath, aliasPath);
                if (verbose) {
                  console.log(styleText("gray", `  Updated symlink: ${aliasPath}`));
                }
              }
            } else {
              // Symlink doesn't exist, recreate it
              await symlink(execTargetPath, aliasPath);
              if (verbose) {
                console.log(styleText("gray", `  Recreated symlink: ${aliasPath}`));
              }
            }
            // Store aliasPath in metadata for future updates
            meta.aliasPath = aliasPath;
          } catch (symlinkError) {
            console.log(
              styleText(
                "yellow",
                `  [!] Could not update symlink: ${(symlinkError as Error).message}`,
              ),
            );
          }
        }

        // Update metadata
        meta.updatedAt = new Date().toISOString();
        meta.originalBinaryPath = newBinaryPath;
        meta.droidVersion = getDroidVersion(newBinaryPath);
        meta.droidPatchVersion = version;
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
      console.log(styleText("gray", `  Would update ${successCount} alias(es)`));
    } else if (failCount === 0) {
      console.log(styleText(["green", "bold"], "  UPDATE COMPLETE"));
      console.log(styleText("gray", `  Updated ${successCount} alias(es)`));
    } else {
      console.log(styleText(["yellow", "bold"], "  UPDATE FINISHED WITH ERRORS"));
      console.log(styleText("gray", `  Success: ${successCount}, Failed: ${failCount}`));
    }
    console.log(styleText("cyan", "═".repeat(60)));
  })
  .run()
  .catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
