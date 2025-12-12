import bin from "tiny-bin";
import { styleText } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { patchDroid, type Patch } from "./patcher.ts";
import {
  createAlias,
  removeAlias,
  listAliases,
  createAliasForWrapper,
} from "./alias.ts";
import { createWebSearchUnifiedFiles } from "./websearch-patch.ts";

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
  .option(
    "--api-base <url>",
    "Replace Factory API base URL (https://api.factory.ai) with custom URL",
  )
  .option(
    "--websearch",
    "Enable local WebSearch via fetch hook (Google PSE + DuckDuckGo fallback)",
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
    const webSearch = options["websearch"] as boolean;
    const dryRun = options["dry-run"] as boolean;
    const path = (options.path as string) || findDefaultDroidPath();
    const outputDir = options.output as string | undefined;
    const backup = options.backup !== false;
    const verbose = options.verbose as boolean;

    // If -o is specified with alias, output to that directory with alias name
    const outputPath = outputDir && alias ? join(outputDir, alias) : undefined;

    // Handle --websearch only (no binary patching needed)
    if (webSearch && !isCustom && !skipLogin && !apiBase) {
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

      // Create unified websearch files (preload script + wrapper)
      const websearchDir = join(homedir(), ".droid-patch", "websearch");
      const { wrapperScript } = await createWebSearchUnifiedFiles(
        websearchDir,
        path,
        alias,
      );

      // Create alias pointing to wrapper
      await createAliasForWrapper(wrapperScript, alias, verbose);

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

    if (!isCustom && !skipLogin && !apiBase && !webSearch) {
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
      console.log(
        styleText(
          "gray",
          "  --api-base     Replace Factory API URL with custom server",
        ),
      );
      console.log(
        styleText(
          "gray",
          "  --websearch    Enable local WebSearch (Google PSE + DuckDuckGo)",
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
      console.log(
        styleText(
          "cyan",
          "  npx droid-patch --api-base http://localhost:3000 droid-local",
        ),
      );
      console.log(
        styleText("cyan", "  npx droid-patch --websearch droid-search"),
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
    if (apiBase) {
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
        if (webSearch) {
          const websearchDir = join(homedir(), ".droid-patch", "websearch");
          const { wrapperScript } = await createWebSearchUnifiedFiles(
            websearchDir,
            result.outputPath,
            alias,
          );
          await createAliasForWrapper(wrapperScript, alias, verbose);

          console.log();
          console.log(styleText("cyan", "WebSearch providers (optional):"));
          console.log(
            styleText("gray", "  Works out of the box with DuckDuckGo fallback"),
          );
          console.log(
            styleText("gray", "  For better results, configure a provider:"),
          );
          console.log();
          console.log(
            styleText("yellow", "  Smithery Exa"),
            styleText("gray", " - Best quality, free via smithery.ai"),
          );
          console.log(
            styleText("gray", "    export SMITHERY_API_KEY=... SMITHERY_PROFILE=..."),
          );
          console.log(
            styleText("yellow", "  Google PSE"),
            styleText("gray", " - 10,000/day free"),
          );
          console.log(
            styleText("gray", "    export GOOGLE_PSE_API_KEY=... GOOGLE_PSE_CX=..."),
          );
          console.log();
          console.log(
            styleText("gray", "  See README for all providers and setup guides"),
          );
        } else {
          await createAlias(result.outputPath, alias, verbose);
        }
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
  .command("proxy-status", "Check websearch proxy status")
  .action(async () => {
    const pidFile = "/tmp/droid-search-proxy.pid";
    const logFile = "/tmp/droid-search-proxy.log";
    const port = 23119;

    console.log(styleText("cyan", "═".repeat(60)));
    console.log(styleText(["cyan", "bold"], "  WebSearch Proxy Status"));
    console.log(styleText("cyan", "═".repeat(60)));
    console.log();

    // Check if proxy is running
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        const data = (await response.json()) as {
          status: string;
          port: number;
          idleTimeout?: number;
          idleSeconds?: number;
          droidRunning?: boolean;
          willShutdownIn?: number | null;
        };
        console.log(styleText("green", `  Status: Running ✓`));
        console.log(styleText("white", `  Port: ${port}`));

        if (existsSync(pidFile)) {
          const { readFileSync } = await import("node:fs");
          const pid = readFileSync(pidFile, "utf-8").trim();
          console.log(styleText("white", `  PID: ${pid}`));
        }

        // Show droid running status
        if (data.droidRunning !== undefined) {
          console.log(
            styleText(
              "white",
              `  Droid running: ${data.droidRunning ? "yes (proxy will stay alive)" : "no"}`,
            ),
          );
        }

        // Show idle timeout info
        if (data.idleTimeout !== undefined) {
          if (data.idleTimeout > 0) {
            const idleMins = Math.floor((data.idleSeconds || 0) / 60);
            const idleSecs = (data.idleSeconds || 0) % 60;
            if (data.droidRunning) {
              console.log(
                styleText(
                  "white",
                  `  Idle: ${idleMins}m ${idleSecs}s (won't shutdown while droid runs)`,
                ),
              );
            } else if (data.willShutdownIn !== null) {
              const shutdownMins = Math.floor((data.willShutdownIn || 0) / 60);
              const shutdownSecs = (data.willShutdownIn || 0) % 60;
              console.log(
                styleText("white", `  Idle: ${idleMins}m ${idleSecs}s`),
              );
              console.log(
                styleText(
                  "white",
                  `  Auto-shutdown in: ${shutdownMins}m ${shutdownSecs}s`,
                ),
              );
            }
          } else {
            console.log(styleText("white", `  Auto-shutdown: disabled`));
          }
        }

        console.log(styleText("white", `  Log: ${logFile}`));
        console.log();
        console.log(styleText("gray", "To stop the proxy manually:"));
        console.log(styleText("cyan", "  npx droid-patch proxy-stop"));
        console.log();
        console.log(styleText("gray", "To disable auto-shutdown:"));
        console.log(styleText("cyan", "  export DROID_PROXY_IDLE_TIMEOUT=0"));
      }
    } catch {
      console.log(styleText("yellow", `  Status: Not running`));
      console.log();
      console.log(
        styleText(
          "gray",
          "The proxy will start automatically when you run droid-full.",
        ),
      );
      console.log(
        styleText(
          "gray",
          "It will auto-shutdown after 5 minutes of idle (configurable).",
        ),
      );
    }
    console.log();
  })
  .command("proxy-stop", "Stop the websearch proxy")
  .action(async () => {
    const pidFile = "/tmp/droid-search-proxy.pid";

    if (!existsSync(pidFile)) {
      console.log(styleText("yellow", "Proxy is not running (no PID file)"));
      return;
    }

    try {
      const { readFileSync, unlinkSync } = await import("node:fs");
      const pid = readFileSync(pidFile, "utf-8").trim();

      process.kill(parseInt(pid), "SIGTERM");
      unlinkSync(pidFile);

      console.log(styleText("green", `[*] Proxy stopped (PID: ${pid})`));
    } catch (error) {
      console.log(
        styleText(
          "yellow",
          `[!] Could not stop proxy: ${(error as Error).message}`,
        ),
      );

      // Clean up stale PID file
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(pidFile);
        console.log(styleText("gray", "Cleaned up stale PID file"));
      } catch {}
    }
  })
  .command("proxy-log", "Show websearch proxy logs")
  .action(async () => {
    const logFile = "/tmp/droid-search-proxy.log";

    if (!existsSync(logFile)) {
      console.log(styleText("yellow", "No log file found"));
      return;
    }

    const { readFileSync } = await import("node:fs");
    const log = readFileSync(logFile, "utf-8");
    const lines = log.split("\n").slice(-50); // Last 50 lines

    console.log(styleText("cyan", "═".repeat(60)));
    console.log(
      styleText(["cyan", "bold"], "  WebSearch Proxy Logs (last 50 lines)"),
    );
    console.log(styleText("cyan", "═".repeat(60)));
    console.log();
    console.log(lines.join("\n"));
  })
  .run()
  .catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
