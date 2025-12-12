import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  lstatSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { symlink, readlink, unlink, copyFile, chmod } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { styleText } from "node:util";

const DROID_PATCH_DIR = join(homedir(), ".droid-patch");
const ALIASES_DIR = join(DROID_PATCH_DIR, "aliases");
const BINS_DIR = join(DROID_PATCH_DIR, "bins");

const COMMON_PATH_DIRS = [
  join(homedir(), ".local/bin"),
  join(homedir(), "bin"),
  join(homedir(), ".bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(homedir(), ".npm-global/bin"),
  join(homedir(), ".npm/bin"),
  join(homedir(), ".pnpm-global/bin"),
  join(homedir(), ".yarn/bin"),
  join(homedir(), ".config/yarn/global/node_modules/.bin"),
  join(homedir(), ".cargo/bin"),
  join(homedir(), "go/bin"),
  join(homedir(), ".deno/bin"),
  join(homedir(), ".bun/bin"),
  join(homedir(), ".local/share/mise/shims"),
  join(homedir(), ".asdf/shims"),
  join(homedir(), ".nvm/current/bin"),
  join(homedir(), ".volta/bin"),
  join(homedir(), ".fnm/current/bin"),
];

function ensureDirectories(): void {
  if (!existsSync(DROID_PATCH_DIR)) {
    mkdirSync(DROID_PATCH_DIR, { recursive: true });
  }
  if (!existsSync(ALIASES_DIR)) {
    mkdirSync(ALIASES_DIR, { recursive: true });
  }
  if (!existsSync(BINS_DIR)) {
    mkdirSync(BINS_DIR, { recursive: true });
  }
}

function checkPathInclusion(): boolean {
  const pathEnv = process.env.PATH || "";
  return pathEnv.split(":").includes(ALIASES_DIR);
}

export function findWritablePathDir(): string | null {
  const pathEnv = process.env.PATH || "";
  const pathDirs = pathEnv.split(":");

  for (const dir of COMMON_PATH_DIRS) {
    if (pathDirs.includes(dir)) {
      try {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        const testFile = join(dir, `.droid-patch-test-${Date.now()}`);
        writeFileSync(testFile, "");
        unlinkSync(testFile);
        return dir;
      } catch {
        continue;
      }
    }
  }

  return null;
}

function getShellConfigPath(): string {
  const shell = process.env.SHELL || "/bin/bash";
  const shellName = basename(shell);

  switch (shellName) {
    case "zsh":
      return join(homedir(), ".zshrc");
    case "bash": {
      const bashProfile = join(homedir(), ".bash_profile");
      if (existsSync(bashProfile)) return bashProfile;
      return join(homedir(), ".bashrc");
    }
    case "fish":
      return join(homedir(), ".config/fish/config.fish");
    default:
      return join(homedir(), ".profile");
  }
}

function isPathConfigured(shellConfigPath: string): boolean {
  if (!existsSync(shellConfigPath)) {
    return false;
  }

  try {
    const content = readFileSync(shellConfigPath, "utf-8");
    return (
      content.includes(".droid-patch/aliases") ||
      content.includes("droid-patch/aliases")
    );
  } catch {
    return false;
  }
}

function addPathToShellConfig(
  shellConfigPath: string,
  verbose = false,
): boolean {
  const shell = process.env.SHELL || "/bin/bash";
  const shellName = basename(shell);

  let exportLine: string;
  if (shellName === "fish") {
    exportLine = `\n# Added by droid-patch\nfish_add_path "${ALIASES_DIR}"\n`;
  } else {
    exportLine = `\n# Added by droid-patch\nexport PATH="${ALIASES_DIR}:$PATH"\n`;
  }

  try {
    appendFileSync(shellConfigPath, exportLine);
    if (verbose) {
      console.log(
        styleText("gray", `    Added PATH export to: ${shellConfigPath}`),
      );
    }
    return true;
  } catch (error) {
    console.log(
      styleText(
        "yellow",
        `[!] Could not write to ${shellConfigPath}: ${(error as Error).message}`,
      ),
    );
    return false;
  }
}

export interface CreateAliasResult {
  aliasPath: string;
  binaryPath: string;
  immediate?: boolean;
}

export async function createAlias(
  patchedBinaryPath: string,
  aliasName: string,
  verbose = false,
): Promise<CreateAliasResult> {
  ensureDirectories();

  console.log(
    styleText("white", `[*] Creating alias: ${styleText("cyan", aliasName)}`),
  );

  const writablePathDir = findWritablePathDir();

  if (writablePathDir) {
    const targetPath = join(writablePathDir, aliasName);
    const binaryDest = join(BINS_DIR, `${aliasName}-patched`);
    await copyFile(patchedBinaryPath, binaryDest);
    await chmod(binaryDest, 0o755);

    if (verbose) {
      console.log(styleText("gray", `    Stored binary: ${binaryDest}`));
    }

    if (existsSync(targetPath)) {
      await unlink(targetPath);
      if (verbose) {
        console.log(styleText("gray", `    Removed existing: ${targetPath}`));
      }
    }

    await symlink(binaryDest, targetPath);

    if (process.platform === "darwin") {
      try {
        console.log(styleText("gray", "[*] Re-signing binary for macOS..."));
        execSync(`codesign --force --deep --sign - "${binaryDest}"`, {
          stdio: "pipe",
        });
        console.log(styleText("green", "[*] Binary re-signed successfully"));
      } catch {
        console.log(styleText("yellow", "[!] Could not re-sign binary"));
      }

      try {
        execSync(`xattr -cr "${binaryDest}"`, { stdio: "pipe" });
      } catch {
        // Ignore
      }
    }

    console.log(
      styleText("green", `[*] Created: ${targetPath} -> ${binaryDest}`),
    );
    console.log();
    console.log(styleText("green", "─".repeat(60)));
    console.log(
      styleText(["green", "bold"], "  ALIAS READY - NO ACTION REQUIRED!"),
    );
    console.log(styleText("green", "─".repeat(60)));
    console.log();
    console.log(
      styleText(
        "white",
        `The alias "${styleText(["cyan", "bold"], aliasName)}" is now available in ALL terminals.`,
      ),
    );
    console.log(styleText("gray", `(Installed to: ${writablePathDir})`));

    return {
      aliasPath: targetPath,
      binaryPath: binaryDest,
      immediate: true,
    };
  }

  console.log(
    styleText(
      "yellow",
      "[*] No writable PATH directory found, using fallback...",
    ),
  );

  const binaryDest = join(BINS_DIR, `${aliasName}-patched`);
  await copyFile(patchedBinaryPath, binaryDest);
  await chmod(binaryDest, 0o755);

  if (verbose) {
    console.log(styleText("gray", `    Copied binary to: ${binaryDest}`));
  }

  if (process.platform === "darwin") {
    try {
      console.log(styleText("gray", "[*] Re-signing binary for macOS..."));
      execSync(`codesign --force --deep --sign - "${binaryDest}"`, {
        stdio: "pipe",
      });
      console.log(styleText("green", "[*] Binary re-signed successfully"));
    } catch {
      console.log(
        styleText(
          "yellow",
          "[!] Could not re-sign binary. You may need to do this manually:",
        ),
      );
      console.log(
        styleText(
          "gray",
          `    codesign --force --deep --sign - "${binaryDest}"`,
        ),
      );
    }

    try {
      execSync(`xattr -cr "${binaryDest}"`, { stdio: "pipe" });
    } catch {
      // Ignore
    }
  }

  const symlinkPath = join(ALIASES_DIR, aliasName);

  if (existsSync(symlinkPath)) {
    await unlink(symlinkPath);
    if (verbose) {
      console.log(styleText("gray", `    Removed existing symlink`));
    }
  }

  await symlink(binaryDest, symlinkPath);
  await chmod(symlinkPath, 0o755);

  console.log(
    styleText("green", `[*] Created symlink: ${symlinkPath} -> ${binaryDest}`),
  );

  const shellConfig = getShellConfigPath();

  if (!checkPathInclusion()) {
    if (!isPathConfigured(shellConfig)) {
      console.log(
        styleText("white", `[*] Configuring PATH in ${shellConfig}...`),
      );

      if (addPathToShellConfig(shellConfig, verbose)) {
        console.log(styleText("green", `[*] PATH configured successfully!`));
        console.log();
        console.log(styleText("yellow", "─".repeat(60)));
        console.log(styleText(["yellow", "bold"], "  ACTION REQUIRED"));
        console.log(styleText("yellow", "─".repeat(60)));
        console.log();
        console.log(
          styleText("white", "To use the alias in this terminal, run:"),
        );
        console.log();
        console.log(styleText("cyan", `  source ${shellConfig}`));
        console.log();
        console.log(styleText("gray", "Or simply open a new terminal window."));
        console.log(styleText("yellow", "─".repeat(60)));
      } else {
        const exportLine = `export PATH="${ALIASES_DIR}:$PATH"`;
        console.log();
        console.log(styleText("yellow", "─".repeat(60)));
        console.log(
          styleText(["yellow", "bold"], "  Manual PATH Configuration Required"),
        );
        console.log(styleText("yellow", "─".repeat(60)));
        console.log();
        console.log(styleText("white", "Add this line to your shell config:"));
        console.log(styleText("cyan", `  ${exportLine}`));
        console.log();
        console.log(styleText("gray", `Shell config file: ${shellConfig}`));
        console.log(styleText("yellow", "─".repeat(60)));
      }
    } else {
      console.log(
        styleText("green", `[*] PATH already configured in ${shellConfig}`),
      );
      console.log();
      console.log(
        styleText(
          "yellow",
          `Note: Run \`source ${shellConfig}\` or open a new terminal to use the alias.`,
        ),
      );
    }
  } else {
    console.log(
      styleText("green", `[*] PATH already includes aliases directory`),
    );
    console.log();
    console.log(
      styleText(
        "green",
        `You can now use "${styleText(["cyan", "bold"], aliasName)}" command directly!`,
      ),
    );
  }

  return {
    aliasPath: symlinkPath,
    binaryPath: binaryDest,
  };
}

export async function removeAlias(aliasName: string): Promise<void> {
  console.log(
    styleText("white", `[*] Removing alias: ${styleText("cyan", aliasName)}`),
  );

  let removed = false;

  // Check common PATH directories for symlinks
  for (const pathDir of COMMON_PATH_DIRS) {
    const pathSymlink = join(pathDir, aliasName);
    if (existsSync(pathSymlink)) {
      try {
        const stats = lstatSync(pathSymlink);
        if (stats.isSymbolicLink()) {
          const target = await readlink(pathSymlink);
          // Support both regular aliases (.droid-patch/bins) and websearch wrappers (.droid-patch/websearch)
          if (target.includes(".droid-patch/bins") || target.includes(".droid-patch/websearch")) {
            await unlink(pathSymlink);
            console.log(styleText("green", `    Removed: ${pathSymlink}`));
            removed = true;
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  // Check aliases directory
  const symlinkPath = join(ALIASES_DIR, aliasName);
  if (existsSync(symlinkPath)) {
    await unlink(symlinkPath);
    console.log(styleText("green", `    Removed: ${symlinkPath}`));
    removed = true;
  }

  // Remove binary if exists
  const binaryPath = join(BINS_DIR, `${aliasName}-patched`);
  if (existsSync(binaryPath)) {
    await unlink(binaryPath);
    console.log(styleText("green", `    Removed binary: ${binaryPath}`));
    removed = true;
  }

  // Remove websearch wrapper and related files if exist
  const websearchDir = join(DROID_PATCH_DIR, "websearch");
  const wrapperPath = join(websearchDir, aliasName);
  const proxyPath = join(websearchDir, `${aliasName}-proxy.js`);
  const preloadPath = join(websearchDir, `${aliasName}-preload.js`);

  if (existsSync(wrapperPath)) {
    await unlink(wrapperPath);
    console.log(styleText("green", `    Removed wrapper: ${wrapperPath}`));
    removed = true;
  }

  if (existsSync(proxyPath)) {
    await unlink(proxyPath);
    console.log(styleText("green", `    Removed proxy: ${proxyPath}`));
    removed = true;
  }

  if (existsSync(preloadPath)) {
    await unlink(preloadPath);
    console.log(styleText("green", `    Removed preload: ${preloadPath}`));
    removed = true;
  }

  if (!removed) {
    console.log(styleText("yellow", `    Alias "${aliasName}" not found`));
  } else {
    console.log(
      styleText("green", `[*] Alias "${aliasName}" removed successfully`),
    );
  }
}

export async function listAliases(): Promise<void> {
  ensureDirectories();

  console.log(styleText("cyan", "═".repeat(60)));
  console.log(styleText(["cyan", "bold"], "  Droid-Patch Aliases"));
  console.log(styleText("cyan", "═".repeat(60)));
  console.log();

  interface AliasInfo {
    name: string;
    target: string;
    location: string;
    immediate: boolean;
  }

  const aliases: AliasInfo[] = [];

  for (const pathDir of COMMON_PATH_DIRS) {
    if (!existsSync(pathDir)) continue;

    try {
      const files = readdirSync(pathDir);
      for (const file of files) {
        const fullPath = join(pathDir, file);
        try {
          const stats = lstatSync(fullPath);
          if (stats.isSymbolicLink()) {
            const target = await readlink(fullPath);
            // Support both regular aliases and websearch wrappers
            if (target.includes(".droid-patch/bins") || target.includes(".droid-patch/websearch")) {
              aliases.push({
                name: file,
                target,
                location: pathDir,
                immediate: true,
              });
            }
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      // Directory can't be read
    }
  }

  try {
    const files = readdirSync(ALIASES_DIR);

    for (const file of files) {
      const fullPath = join(ALIASES_DIR, file);
      try {
        const stats = lstatSync(fullPath);
        if (stats.isSymbolicLink()) {
          const target = await readlink(fullPath);
          if (!aliases.find((a) => a.name === file)) {
            aliases.push({
              name: file,
              target,
              location: ALIASES_DIR,
              immediate: false,
            });
          }
        }
      } catch {
        // Ignore
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  if (aliases.length === 0) {
    console.log(styleText("gray", "  No aliases configured."));
    console.log();
    console.log(
      styleText(
        "gray",
        "  Create one with: npx droid-patch --is-custom <alias-name>",
      ),
    );
  } else {
    console.log(styleText("white", `  Found ${aliases.length} alias(es):`));
    console.log();
    for (const alias of aliases) {
      const status = alias.immediate
        ? styleText("green", "✓ immediate")
        : styleText("yellow", "requires source");
      console.log(
        styleText(
          "green",
          `  • ${styleText(["cyan", "bold"], alias.name)} [${status}]`,
        ),
      );
      console.log(styleText("gray", `    → ${alias.target}`));
    }
  }

  console.log();
  console.log(styleText("gray", `  Aliases directory: ${ALIASES_DIR}`));
  console.log(
    styleText(
      "gray",
      `  PATH configured: ${checkPathInclusion() ? styleText("green", "Yes") : styleText("yellow", "No")}`,
    ),
  );
  console.log();
}

export interface ReplaceOriginalResult {
  originalPath: string;
  backupPath: string;
}

export async function replaceOriginal(
  patchedBinaryPath: string,
  originalPath: string,
  verbose = false,
): Promise<ReplaceOriginalResult> {
  ensureDirectories();

  console.log(
    styleText(
      "white",
      `[*] Replacing original binary: ${styleText("cyan", originalPath)}`,
    ),
  );

  const latestBackupPath = join(BINS_DIR, "droid-original-latest");

  if (!existsSync(latestBackupPath)) {
    await copyFile(originalPath, latestBackupPath);
    console.log(styleText("green", `[*] Created backup: ${latestBackupPath}`));
  } else {
    if (verbose) {
      console.log(
        styleText("gray", `    Backup already exists: ${latestBackupPath}`),
      );
    }
  }

  await copyFile(patchedBinaryPath, originalPath);
  await chmod(originalPath, 0o755);
  console.log(styleText("green", `[*] Replaced: ${originalPath}`));

  if (process.platform === "darwin") {
    try {
      console.log(styleText("gray", "[*] Re-signing binary for macOS..."));
      execSync(`codesign --force --deep --sign - "${originalPath}"`, {
        stdio: "pipe",
      });
      console.log(styleText("green", "[*] Binary re-signed successfully"));
    } catch {
      console.log(
        styleText(
          "yellow",
          "[!] Could not re-sign binary. You may need to run:",
        ),
      );
      console.log(
        styleText(
          "gray",
          `    codesign --force --deep --sign - "${originalPath}"`,
        ),
      );
    }

    try {
      execSync(`xattr -cr "${originalPath}"`, { stdio: "pipe" });
    } catch {
      // Ignore
    }
  }

  console.log();
  console.log(styleText("green", "─".repeat(60)));
  console.log(styleText(["green", "bold"], "  REPLACEMENT COMPLETE"));
  console.log(styleText("green", "─".repeat(60)));
  console.log();
  console.log(
    styleText("white", "The patched binary is now active in all terminals."),
  );
  console.log(styleText("white", "No need to restart or source anything!"));
  console.log();
  console.log(styleText("gray", `To restore the original, run:`));
  console.log(styleText("cyan", `  npx droid-patch restore`));

  return {
    originalPath,
    backupPath: latestBackupPath,
  };
}

/**
 * Create alias for wrapper script
 * Unlike createAlias, this function creates symlink pointing to wrapper script
 * Used for features like websearch that require preprocessing
 */
export async function createAliasForWrapper(
  wrapperPath: string,
  aliasName: string,
  verbose = false,
): Promise<CreateAliasResult> {
  ensureDirectories();

  console.log(
    styleText("white", `[*] Creating alias: ${styleText("cyan", aliasName)}`),
  );

  const writablePathDir = findWritablePathDir();

  if (writablePathDir) {
    const targetPath = join(writablePathDir, aliasName);

    if (verbose) {
      console.log(styleText("gray", `    Wrapper: ${wrapperPath}`));
    }

    if (existsSync(targetPath)) {
      await unlink(targetPath);
      if (verbose) {
        console.log(styleText("gray", `    Removed existing: ${targetPath}`));
      }
    }

    await symlink(wrapperPath, targetPath);

    console.log(
      styleText("green", `[*] Created: ${targetPath} -> ${wrapperPath}`),
    );
    console.log();
    console.log(styleText("green", "─".repeat(60)));
    console.log(
      styleText(["green", "bold"], "  ALIAS READY - NO ACTION REQUIRED!"),
    );
    console.log(styleText("green", "─".repeat(60)));
    console.log();
    console.log(
      styleText(
        "white",
        `The alias "${styleText(["cyan", "bold"], aliasName)}" is now available in ALL terminals.`,
      ),
    );
    console.log(styleText("gray", `(Installed to: ${writablePathDir})`));

    return {
      aliasPath: targetPath,
      binaryPath: wrapperPath,
      immediate: true,
    };
  }

  // Fallback: use ~/.droid-patch/aliases
  console.log(
    styleText(
      "yellow",
      "[*] No writable PATH directory found, using fallback...",
    ),
  );

  const symlinkPath = join(ALIASES_DIR, aliasName);

  if (existsSync(symlinkPath)) {
    await unlink(symlinkPath);
    if (verbose) {
      console.log(styleText("gray", `    Removed existing symlink`));
    }
  }

  await symlink(wrapperPath, symlinkPath);

  console.log(
    styleText("green", `[*] Created symlink: ${symlinkPath} -> ${wrapperPath}`),
  );

  const shellConfig = getShellConfigPath();

  if (!checkPathInclusion()) {
    if (!isPathConfigured(shellConfig)) {
      console.log(
        styleText("white", `[*] Configuring PATH in ${shellConfig}...`),
      );

      if (addPathToShellConfig(shellConfig, verbose)) {
        console.log(styleText("green", `[*] PATH configured successfully!`));
        console.log();
        console.log(styleText("yellow", "─".repeat(60)));
        console.log(styleText(["yellow", "bold"], "  ACTION REQUIRED"));
        console.log(styleText("yellow", "─".repeat(60)));
        console.log();
        console.log(
          styleText("white", "To use the alias in this terminal, run:"),
        );
        console.log();
        console.log(styleText("cyan", `  source ${shellConfig}`));
        console.log();
        console.log(styleText("gray", "Or simply open a new terminal window."));
        console.log(styleText("yellow", "─".repeat(60)));
      } else {
        const exportLine = `export PATH="${ALIASES_DIR}:$PATH"`;
        console.log();
        console.log(styleText("yellow", "─".repeat(60)));
        console.log(
          styleText(["yellow", "bold"], "  Manual PATH Configuration Required"),
        );
        console.log(styleText("yellow", "─".repeat(60)));
        console.log();
        console.log(styleText("white", "Add this line to your shell config:"));
        console.log(styleText("cyan", `  ${exportLine}`));
        console.log();
        console.log(styleText("gray", `Shell config file: ${shellConfig}`));
        console.log(styleText("yellow", "─".repeat(60)));
      }
    } else {
      console.log(
        styleText("green", `[*] PATH already configured in ${shellConfig}`),
      );
      console.log();
      console.log(
        styleText(
          "yellow",
          `Note: Run \`source ${shellConfig}\` or open a new terminal to use the alias.`,
        ),
      );
    }
  } else {
    console.log(
      styleText("green", `[*] PATH already includes aliases directory`),
    );
    console.log();
    console.log(
      styleText(
        "green",
        `You can now use "${styleText(["cyan", "bold"], aliasName)}" command directly!`,
      ),
    );
  }

  return {
    aliasPath: symlinkPath,
    binaryPath: wrapperPath,
  };
}

export async function restoreOriginal(originalPath: string): Promise<void> {
  ensureDirectories();

  const latestBackupPath = join(BINS_DIR, "droid-original-latest");

  console.log(styleText("cyan", "═".repeat(60)));
  console.log(styleText(["cyan", "bold"], "  Restore Original Droid"));
  console.log(styleText("cyan", "═".repeat(60)));
  console.log();

  if (!existsSync(latestBackupPath)) {
    const localBackup = `${originalPath}.backup`;
    if (existsSync(localBackup)) {
      console.log(styleText("white", `[*] Found local backup: ${localBackup}`));
      console.log(styleText("white", `[*] Restoring to: ${originalPath}`));

      await copyFile(localBackup, originalPath);
      await chmod(originalPath, 0o755);

      if (process.platform === "darwin") {
        try {
          execSync(`codesign --force --deep --sign - "${originalPath}"`, {
            stdio: "pipe",
          });
          execSync(`xattr -cr "${originalPath}"`, { stdio: "pipe" });
        } catch {
          // Ignore
        }
      }

      console.log();
      console.log(styleText("green", "═".repeat(60)));
      console.log(styleText(["green", "bold"], "  RESTORE COMPLETE"));
      console.log(styleText("green", "═".repeat(60)));
      console.log();
      console.log(
        styleText(
          "green",
          "Original droid binary has been restored from local backup.",
        ),
      );
      return;
    }

    console.log(styleText("red", "[!] No backup found."));
    console.log(styleText("gray", `    Checked: ${latestBackupPath}`));
    console.log(styleText("gray", `    Checked: ${localBackup}`));
    console.log();
    console.log(
      styleText("gray", "If you have a manual backup, restore it with:"),
    );
    console.log(styleText("cyan", `  cp /path/to/backup ${originalPath}`));
    return;
  }

  console.log(styleText("white", `[*] Restoring from: ${latestBackupPath}`));
  console.log(styleText("white", `[*] Restoring to: ${originalPath}`));

  const targetDir = dirname(originalPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  await copyFile(latestBackupPath, originalPath);
  await chmod(originalPath, 0o755);

  if (process.platform === "darwin") {
    try {
      execSync(`codesign --force --deep --sign - "${originalPath}"`, {
        stdio: "pipe",
      });
      execSync(`xattr -cr "${originalPath}"`, { stdio: "pipe" });
    } catch {
      // Ignore
    }
  }

  console.log();
  console.log(styleText("green", "═".repeat(60)));
  console.log(styleText(["green", "bold"], "  RESTORE COMPLETE"));
  console.log(styleText("green", "═".repeat(60)));
  console.log();
  console.log(styleText("green", "Original droid binary has been restored."));
  console.log(
    styleText("green", "All terminals will now use the original version."),
  );
}
