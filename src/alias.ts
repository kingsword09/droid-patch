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
import { join, basename, dirname, delimiter } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { styleText } from "node:util";
import { removeAliasMetadata, loadAliasMetadata, formatPatches } from "./metadata.ts";

const IS_WINDOWS = platform() === "win32";

const DROID_PATCH_DIR = join(homedir(), ".droid-patch");
const ALIASES_DIR = join(DROID_PATCH_DIR, "aliases");
const BINS_DIR = join(DROID_PATCH_DIR, "bins");

// Unix common PATH directories
const UNIX_PATH_DIRS = [
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

// Windows common PATH directories
const WINDOWS_PATH_DIRS = [
  join(homedir(), ".droid-patch", "bin"),
  join(homedir(), "scoop", "shims"),
  join(homedir(), "AppData", "Local", "Programs", "bin"),
];

const COMMON_PATH_DIRS = IS_WINDOWS ? WINDOWS_PATH_DIRS : UNIX_PATH_DIRS;

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
  return pathEnv.split(delimiter).some((p) => p.toLowerCase() === ALIASES_DIR.toLowerCase());
}

export function findWritablePathDir(): string | null {
  const pathEnv = process.env.PATH || "";
  const pathDirs = pathEnv.split(delimiter);

  for (const dir of COMMON_PATH_DIRS) {
    // Case-insensitive comparison for Windows
    const isInPath = pathDirs.some((p) => p.toLowerCase() === dir.toLowerCase());
    if (isInPath) {
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
  if (IS_WINDOWS) {
    // Windows doesn't use shell config files for PATH
    return "";
  }
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
  if (IS_WINDOWS || !shellConfigPath) {
    return false;
  }

  if (!existsSync(shellConfigPath)) {
    return false;
  }

  try {
    const content = readFileSync(shellConfigPath, "utf-8");
    return content.includes(".droid-patch/aliases") || content.includes("droid-patch/aliases");
  } catch {
    return false;
  }
}

/**
 * Add directory to Windows user PATH using setx command
 * This modifies the user's PATH permanently (requires terminal restart)
 */
function addToWindowsUserPath(dir: string): boolean {
  try {
    // Get current user PATH from registry
    let existingPath = "";
    try {
      const result = execSync('reg query "HKCU\\Environment" /v Path 2>nul', {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const match = result.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
      existingPath = match ? match[1].trim() : "";
    } catch {
      // PATH not set yet, that's fine
    }

    // Check if already in PATH (case-insensitive)
    const paths = existingPath.split(";").map((p) => p.toLowerCase().trim());
    if (paths.includes(dir.toLowerCase())) {
      return true; // Already in PATH
    }

    // Add to PATH
    const newPath = existingPath ? `${existingPath};${dir}` : dir;
    execSync(`setx PATH "${newPath}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate Windows .cmd launcher script
 */
function generateWindowsLauncher(targetPath: string): string {
  return `@echo off\r\n"${targetPath}" %*\r\n`;
}

function addPathToShellConfig(shellConfigPath: string, verbose = false): boolean {
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
      console.log(styleText("gray", `    Added PATH export to: ${shellConfigPath}`));
    }
    return true;
  } catch (error) {
    console.log(
      styleText("yellow", `[!] Could not write to ${shellConfigPath}: ${(error as Error).message}`),
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

  console.log(styleText("white", `[*] Creating alias: ${styleText("cyan", aliasName)}`));

  // Windows: use .cmd launcher instead of symlink
  if (IS_WINDOWS) {
    return createWindowsAlias(patchedBinaryPath, aliasName, verbose);
  }

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

    console.log(styleText("green", `[*] Created: ${targetPath} -> ${binaryDest}`));
    console.log();
    console.log(styleText("green", "─".repeat(60)));
    console.log(styleText(["green", "bold"], "  ALIAS READY - NO ACTION REQUIRED!"));
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

  console.log(styleText("yellow", "[*] No writable PATH directory found, using fallback..."));

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
        styleText("yellow", "[!] Could not re-sign binary. You may need to do this manually:"),
      );
      console.log(styleText("gray", `    codesign --force --deep --sign - "${binaryDest}"`));
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

  console.log(styleText("green", `[*] Created symlink: ${symlinkPath} -> ${binaryDest}`));

  const shellConfig = getShellConfigPath();

  if (!checkPathInclusion()) {
    if (!isPathConfigured(shellConfig)) {
      console.log(styleText("white", `[*] Configuring PATH in ${shellConfig}...`));

      if (addPathToShellConfig(shellConfig, verbose)) {
        console.log(styleText("green", `[*] PATH configured successfully!`));
        console.log();
        console.log(styleText("yellow", "─".repeat(60)));
        console.log(styleText(["yellow", "bold"], "  ACTION REQUIRED"));
        console.log(styleText("yellow", "─".repeat(60)));
        console.log();
        console.log(styleText("white", "To use the alias in this terminal, run:"));
        console.log();
        console.log(styleText("cyan", `  source ${shellConfig}`));
        console.log();
        console.log(styleText("gray", "Or simply open a new terminal window."));
        console.log(styleText("yellow", "─".repeat(60)));
      } else {
        const exportLine = `export PATH="${ALIASES_DIR}:$PATH"`;
        console.log();
        console.log(styleText("yellow", "─".repeat(60)));
        console.log(styleText(["yellow", "bold"], "  Manual PATH Configuration Required"));
        console.log(styleText("yellow", "─".repeat(60)));
        console.log();
        console.log(styleText("white", "Add this line to your shell config:"));
        console.log(styleText("cyan", `  ${exportLine}`));
        console.log();
        console.log(styleText("gray", `Shell config file: ${shellConfig}`));
        console.log(styleText("yellow", "─".repeat(60)));
      }
    } else {
      console.log(styleText("green", `[*] PATH already configured in ${shellConfig}`));
      console.log();
      console.log(
        styleText(
          "yellow",
          `Note: Run \`source ${shellConfig}\` or open a new terminal to use the alias.`,
        ),
      );
    }
  } else {
    console.log(styleText("green", `[*] PATH already includes aliases directory`));
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

/**
 * Create alias on Windows using .cmd launcher and setx for PATH
 */
/**
 * Try to copy file, handling Windows file locking
 * If target is locked, use a new filename with timestamp
 */
async function copyFileWithLockHandling(
  src: string,
  dest: string,
  verbose = false,
): Promise<string> {
  try {
    await copyFile(src, dest);
    return dest;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // EBUSY = file is locked/in use (Windows)
    if (err.code === "EBUSY" && IS_WINDOWS) {
      // Generate new filename with timestamp
      const timestamp = Date.now();
      const ext = dest.endsWith(".exe") ? ".exe" : "";
      const baseName = dest.replace(/\.exe$/, "").replace(/-\d+$/, ""); // Remove old timestamp if any
      const newDest = `${baseName}-${timestamp}${ext}`;

      if (verbose) {
        console.log(
          styleText("yellow", `    [!] File locked, using new path: ${newDest}`),
        );
      }

      await copyFile(src, newDest);
      return newDest;
    }
    throw error;
  }
}

async function createWindowsAlias(
  patchedBinaryPath: string,
  aliasName: string,
  verbose = false,
): Promise<CreateAliasResult> {
  const binDir = join(DROID_PATCH_DIR, "bin");
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  // Copy binary to bins directory, handling file locking
  const targetPath = join(BINS_DIR, `${aliasName}-patched.exe`);
  const binaryDest = await copyFileWithLockHandling(patchedBinaryPath, targetPath, verbose);

  if (verbose) {
    console.log(styleText("gray", `    Stored binary: ${binaryDest}`));
  }

  // Create .cmd launcher in bin directory
  const cmdPath = join(binDir, `${aliasName}.cmd`);
  const cmdContent = generateWindowsLauncher(binaryDest);
  writeFileSync(cmdPath, cmdContent);

  if (verbose) {
    console.log(styleText("gray", `    Created launcher: ${cmdPath}`));
  }

  // Try to add bin directory to user PATH
  const pathAdded = addToWindowsUserPath(binDir);

  console.log(styleText("green", `[*] Created: ${cmdPath}`));
  console.log();

  if (pathAdded) {
    if (checkPathInclusion()) {
      console.log(styleText("green", "─".repeat(60)));
      console.log(styleText(["green", "bold"], "  ALIAS READY!"));
      console.log(styleText("green", "─".repeat(60)));
      console.log();
      console.log(
        styleText(
          "white",
          `The alias "${styleText(["cyan", "bold"], aliasName)}" is now available.`,
        ),
      );
      console.log(styleText("gray", `(Installed to: ${binDir})`));

      return {
        aliasPath: cmdPath,
        binaryPath: binaryDest,
        immediate: true,
      };
    }

    console.log(styleText("yellow", "─".repeat(60)));
    console.log(styleText(["yellow", "bold"], "  PATH Updated - Restart Terminal"));
    console.log(styleText("yellow", "─".repeat(60)));
    console.log();
    console.log(styleText("white", "PATH has been updated. Please restart your terminal."));
    console.log(
      styleText(
        "white",
        `Then you can use "${styleText(["cyan", "bold"], aliasName)}" command directly.`,
      ),
    );
    console.log();
    console.log(styleText("gray", `Installed to: ${binDir}`));
  } else {
    console.log(styleText("yellow", "─".repeat(60)));
    console.log(styleText(["yellow", "bold"], "  Manual PATH Configuration Required"));
    console.log(styleText("yellow", "─".repeat(60)));
    console.log();
    console.log(styleText("white", "Add this directory to your PATH:"));
    console.log(styleText("cyan", `  ${binDir}`));
    console.log();
    console.log(styleText("gray", "Or run directly:"));
    console.log(styleText("cyan", `  "${cmdPath}"`));
  }

  return {
    aliasPath: cmdPath,
    binaryPath: binaryDest,
    immediate: false,
  };
}

export async function removeAlias(aliasName: string): Promise<void> {
  console.log(styleText("white", `[*] Removing alias: ${styleText("cyan", aliasName)}`));

  let removed = false;

  // Windows: check for .cmd launcher
  if (IS_WINDOWS) {
    const binDir = join(DROID_PATCH_DIR, "bin");
    const cmdPath = join(binDir, `${aliasName}.cmd`);
    if (existsSync(cmdPath)) {
      await unlink(cmdPath);
      console.log(styleText("green", `    Removed: ${cmdPath}`));
      removed = true;
    }

    // Remove Windows binary (.exe)
    const exePath = join(BINS_DIR, `${aliasName}-patched.exe`);
    if (existsSync(exePath)) {
      await unlink(exePath);
      console.log(styleText("green", `    Removed binary: ${exePath}`));
      removed = true;
    }

    // Also check for wrapper .cmd in proxy directory
    const proxyDir = join(DROID_PATCH_DIR, "proxy");
    const proxyWrapperCmd = join(proxyDir, `${aliasName}.cmd`);
    if (existsSync(proxyWrapperCmd)) {
      await unlink(proxyWrapperCmd);
      console.log(styleText("green", `    Removed wrapper: ${proxyWrapperCmd}`));
      removed = true;
    }
  }

  // Check common PATH directories for symlinks (Unix)
  if (!IS_WINDOWS) {
    for (const pathDir of COMMON_PATH_DIRS) {
      const pathSymlink = join(pathDir, aliasName);
      if (existsSync(pathSymlink)) {
        try {
          const stats = lstatSync(pathSymlink);
          if (stats.isSymbolicLink()) {
            const target = await readlink(pathSymlink);
            // Support regular aliases, old websearch wrappers, and new proxy wrappers
            if (
              target.includes(".droid-patch/bins") ||
              target.includes(".droid-patch/websearch") ||
              target.includes(".droid-patch/proxy") ||
              target.includes(".droid-patch/statusline")
            ) {
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
  }

  // Check aliases directory
  const symlinkPath = join(ALIASES_DIR, aliasName);
  if (existsSync(symlinkPath)) {
    await unlink(symlinkPath);
    console.log(styleText("green", `    Removed: ${symlinkPath}`));
    removed = true;
  }

  // Remove binary if exists (Unix style without .exe)
  const binaryPath = join(BINS_DIR, `${aliasName}-patched`);
  if (existsSync(binaryPath)) {
    await unlink(binaryPath);
    console.log(styleText("green", `    Removed binary: ${binaryPath}`));
    removed = true;
  }

  // Remove new proxy wrapper and related files if exist
  const proxyDir = join(DROID_PATCH_DIR, "proxy");
  const proxyWrapperPath = join(proxyDir, aliasName);
  const proxyScriptPath = join(proxyDir, `${aliasName}-proxy.js`);

  if (existsSync(proxyWrapperPath)) {
    await unlink(proxyWrapperPath);
    console.log(styleText("green", `    Removed wrapper: ${proxyWrapperPath}`));
    removed = true;
  }

  if (existsSync(proxyScriptPath)) {
    await unlink(proxyScriptPath);
    console.log(styleText("green", `    Removed proxy script: ${proxyScriptPath}`));
    removed = true;
  }

  // Remove old websearch wrapper and related files if exist (backward compatibility)
  const websearchDir = join(DROID_PATCH_DIR, "websearch");
  const wrapperPath = join(websearchDir, aliasName);
  const oldProxyPath = join(websearchDir, `${aliasName}-proxy.js`);
  const preloadPath = join(websearchDir, `${aliasName}-preload.js`);

  if (existsSync(wrapperPath)) {
    await unlink(wrapperPath);
    console.log(styleText("green", `    Removed legacy wrapper: ${wrapperPath}`));
    removed = true;
  }

  if (existsSync(oldProxyPath)) {
    await unlink(oldProxyPath);
    console.log(styleText("green", `    Removed legacy proxy: ${oldProxyPath}`));
    removed = true;
  }

  if (existsSync(preloadPath)) {
    await unlink(preloadPath);
    console.log(styleText("green", `    Removed legacy preload: ${preloadPath}`));
    removed = true;
  }

  // Remove statusline wrapper and monitor script if exist
  const statuslineDir = join(DROID_PATCH_DIR, "statusline");
  const statuslineWrapperPath = join(statuslineDir, aliasName);
  const statuslineMonitorPath = join(statuslineDir, `${aliasName}-statusline.js`);
  const statuslineSessionsPath = join(statuslineDir, `${aliasName}-sessions.js`);

  if (existsSync(statuslineWrapperPath)) {
    await unlink(statuslineWrapperPath);
    console.log(styleText("green", `    Removed statusline wrapper: ${statuslineWrapperPath}`));
    removed = true;
  }

  if (existsSync(statuslineMonitorPath)) {
    await unlink(statuslineMonitorPath);
    console.log(styleText("green", `    Removed statusline monitor: ${statuslineMonitorPath}`));
    removed = true;
  }

  if (existsSync(statuslineSessionsPath)) {
    await unlink(statuslineSessionsPath);
    console.log(styleText("green", `    Removed sessions browser: ${statuslineSessionsPath}`));
    removed = true;
  }

  // Remove metadata
  const metaRemoved = await removeAliasMetadata(aliasName);
  if (metaRemoved) {
    console.log(styleText("green", `    Removed metadata`));
    removed = true;
  }

  if (!removed) {
    console.log(styleText("yellow", `    Alias "${aliasName}" not found`));
  } else {
    console.log(styleText("green", `[*] Alias "${aliasName}" removed successfully`));
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

  // Windows: check for .cmd launchers in bin directory
  if (IS_WINDOWS) {
    const binDir = join(DROID_PATCH_DIR, "bin");
    if (existsSync(binDir)) {
      try {
        const files = readdirSync(binDir);
        for (const file of files) {
          if (file.endsWith(".cmd")) {
            const aliasName = file.replace(/\.cmd$/, "");
            const fullPath = join(binDir, file);
            // Read .cmd to find target
            try {
              const content = readFileSync(fullPath, "utf-8");
              const match = content.match(/"([^"]+)"/);
              const target = match ? match[1] : fullPath;
              aliases.push({
                name: aliasName,
                target,
                location: binDir,
                immediate: checkPathInclusion(),
              });
            } catch {
              aliases.push({
                name: aliasName,
                target: fullPath,
                location: binDir,
                immediate: false,
              });
            }
          }
        }
      } catch {
        // Directory can't be read
      }
    }

    // Also check proxy directory for wrapper .cmd files
    const proxyDir = join(DROID_PATCH_DIR, "proxy");
    if (existsSync(proxyDir)) {
      try {
        const files = readdirSync(proxyDir);
        for (const file of files) {
          if (file.endsWith(".cmd")) {
            const aliasName = file.replace(/\.cmd$/, "");
            if (!aliases.find((a) => a.name === aliasName)) {
              const fullPath = join(proxyDir, file);
              aliases.push({
                name: aliasName,
                target: fullPath,
                location: proxyDir,
                immediate: false,
              });
            }
          }
        }
      } catch {
        // Ignore
      }
    }
  } else {
    // Unix: check for symlinks
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
              // Support regular aliases, old websearch wrappers, and new proxy wrappers
              if (
                target.includes(".droid-patch/bins") ||
                target.includes(".droid-patch/websearch") ||
                target.includes(".droid-patch/proxy") ||
                target.includes(".droid-patch/statusline")
              ) {
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
  }

  if (aliases.length === 0) {
    console.log(styleText("gray", "  No aliases configured."));
    console.log();
    console.log(styleText("gray", "  Create one with: npx droid-patch --is-custom <alias-name>"));
  } else {
    console.log(styleText("white", `  Found ${aliases.length} alias(es):`));
    console.log();
    for (const alias of aliases) {
      const status = alias.immediate
        ? styleText("green", "✓ immediate")
        : styleText("yellow", "requires source");
      console.log(styleText("green", `  • ${styleText(["cyan", "bold"], alias.name)} [${status}]`));
      console.log(styleText("gray", `    → ${alias.target}`));

      // Load and display metadata
      const meta = await loadAliasMetadata(alias.name);
      if (meta) {
        // Version info
        const patchVer = meta.droidPatchVersion
          ? `droid-patch@${meta.droidPatchVersion}`
          : "unknown";
        const droidVer = meta.droidVersion ? `droid@${meta.droidVersion}` : "unknown";
        console.log(styleText("gray", `    Versions: ${patchVer}, ${droidVer}`));

        // Flags/patches
        const flags = formatPatches(meta.patches);
        console.log(styleText("gray", `    Flags: ${flags}`));

        // Created time
        if (meta.createdAt) {
          const date = new Date(meta.createdAt).toLocaleString();
          console.log(styleText("gray", `    Created: ${date}`));
        }
      } else {
        console.log(styleText("yellow", `    (no metadata - created by older version)`));
      }
      console.log();
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
    styleText("white", `[*] Replacing original binary: ${styleText("cyan", originalPath)}`),
  );

  const latestBackupPath = join(BINS_DIR, "droid-original-latest");

  if (!existsSync(latestBackupPath)) {
    await copyFile(originalPath, latestBackupPath);
    console.log(styleText("green", `[*] Created backup: ${latestBackupPath}`));
  } else {
    if (verbose) {
      console.log(styleText("gray", `    Backup already exists: ${latestBackupPath}`));
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
      console.log(styleText("yellow", "[!] Could not re-sign binary. You may need to run:"));
      console.log(styleText("gray", `    codesign --force --deep --sign - "${originalPath}"`));
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
  console.log(styleText("white", "The patched binary is now active in all terminals."));
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

  console.log(styleText("white", `[*] Creating alias: ${styleText("cyan", aliasName)}`));

  // Windows: create .cmd launcher pointing to wrapper
  if (IS_WINDOWS) {
    return createWindowsWrapperAlias(wrapperPath, aliasName, verbose);
  }

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

    console.log(styleText("green", `[*] Created: ${targetPath} -> ${wrapperPath}`));
    console.log();
    console.log(styleText("green", "─".repeat(60)));
    console.log(styleText(["green", "bold"], "  ALIAS READY - NO ACTION REQUIRED!"));
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
  console.log(styleText("yellow", "[*] No writable PATH directory found, using fallback..."));

  const symlinkPath = join(ALIASES_DIR, aliasName);

  if (existsSync(symlinkPath)) {
    await unlink(symlinkPath);
    if (verbose) {
      console.log(styleText("gray", `    Removed existing symlink`));
    }
  }

  await symlink(wrapperPath, symlinkPath);

  console.log(styleText("green", `[*] Created symlink: ${symlinkPath} -> ${wrapperPath}`));

  const shellConfig = getShellConfigPath();

  if (!checkPathInclusion()) {
    if (!isPathConfigured(shellConfig)) {
      console.log(styleText("white", `[*] Configuring PATH in ${shellConfig}...`));

      if (addPathToShellConfig(shellConfig, verbose)) {
        console.log(styleText("green", `[*] PATH configured successfully!`));
        console.log();
        console.log(styleText("yellow", "─".repeat(60)));
        console.log(styleText(["yellow", "bold"], "  ACTION REQUIRED"));
        console.log(styleText("yellow", "─".repeat(60)));
        console.log();
        console.log(styleText("white", "To use the alias in this terminal, run:"));
        console.log();
        console.log(styleText("cyan", `  source ${shellConfig}`));
        console.log();
        console.log(styleText("gray", "Or simply open a new terminal window."));
        console.log(styleText("yellow", "─".repeat(60)));
      } else {
        const exportLine = `export PATH="${ALIASES_DIR}:$PATH"`;
        console.log();
        console.log(styleText("yellow", "─".repeat(60)));
        console.log(styleText(["yellow", "bold"], "  Manual PATH Configuration Required"));
        console.log(styleText("yellow", "─".repeat(60)));
        console.log();
        console.log(styleText("white", "Add this line to your shell config:"));
        console.log(styleText("cyan", `  ${exportLine}`));
        console.log();
        console.log(styleText("gray", `Shell config file: ${shellConfig}`));
        console.log(styleText("yellow", "─".repeat(60)));
      }
    } else {
      console.log(styleText("green", `[*] PATH already configured in ${shellConfig}`));
      console.log();
      console.log(
        styleText(
          "yellow",
          `Note: Run \`source ${shellConfig}\` or open a new terminal to use the alias.`,
        ),
      );
    }
  } else {
    console.log(styleText("green", `[*] PATH already includes aliases directory`));
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

/**
 * Create Windows alias for wrapper script (.cmd pointing to wrapper .cmd)
 */
async function createWindowsWrapperAlias(
  wrapperPath: string,
  aliasName: string,
  verbose = false,
): Promise<CreateAliasResult> {
  const binDir = join(DROID_PATCH_DIR, "bin");
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  if (verbose) {
    console.log(styleText("gray", `    Wrapper: ${wrapperPath}`));
  }

  // Create .cmd launcher in bin directory that calls the wrapper
  const cmdPath = join(binDir, `${aliasName}.cmd`);
  const cmdContent = generateWindowsLauncher(wrapperPath);
  writeFileSync(cmdPath, cmdContent);

  if (verbose) {
    console.log(styleText("gray", `    Created launcher: ${cmdPath}`));
  }

  // Try to add bin directory to user PATH
  const pathAdded = addToWindowsUserPath(binDir);

  console.log(styleText("green", `[*] Created: ${cmdPath}`));
  console.log();

  if (pathAdded) {
    if (checkPathInclusion()) {
      console.log(styleText("green", "─".repeat(60)));
      console.log(styleText(["green", "bold"], "  ALIAS READY!"));
      console.log(styleText("green", "─".repeat(60)));
      console.log();
      console.log(
        styleText(
          "white",
          `The alias "${styleText(["cyan", "bold"], aliasName)}" is now available.`,
        ),
      );
      console.log(styleText("gray", `(Installed to: ${binDir})`));

      return {
        aliasPath: cmdPath,
        binaryPath: wrapperPath,
        immediate: true,
      };
    }

    console.log(styleText("yellow", "─".repeat(60)));
    console.log(styleText(["yellow", "bold"], "  PATH Updated - Restart Terminal"));
    console.log(styleText("yellow", "─".repeat(60)));
    console.log();
    console.log(styleText("white", "PATH has been updated. Please restart your terminal."));
    console.log(
      styleText(
        "white",
        `Then you can use "${styleText(["cyan", "bold"], aliasName)}" command directly.`,
      ),
    );
    console.log();
    console.log(styleText("gray", `Installed to: ${binDir}`));
  } else {
    console.log(styleText("yellow", "─".repeat(60)));
    console.log(styleText(["yellow", "bold"], "  Manual PATH Configuration Required"));
    console.log(styleText("yellow", "─".repeat(60)));
    console.log();
    console.log(styleText("white", "Add this directory to your PATH:"));
    console.log(styleText("cyan", `  ${binDir}`));
    console.log();
    console.log(styleText("gray", "Or run directly:"));
    console.log(styleText("cyan", `  "${cmdPath}"`));
  }

  return {
    aliasPath: cmdPath,
    binaryPath: wrapperPath,
    immediate: false,
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
      console.log(styleText("green", "Original droid binary has been restored from local backup."));
      return;
    }

    console.log(styleText("red", "[!] No backup found."));
    console.log(styleText("gray", `    Checked: ${latestBackupPath}`));
    console.log(styleText("gray", `    Checked: ${localBackup}`));
    console.log();
    console.log(styleText("gray", "If you have a manual backup, restore it with:"));
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
  console.log(styleText("green", "All terminals will now use the original version."));
}

/**
 * Filter options for removing aliases
 * Uses the same names as CLI options for consistency
 */
export type FilterFlag =
  | "is-custom"
  | "skip-login"
  | "websearch"
  | "api-base"
  | "reasoning-effort"
  | "disable-telemetry"
  | "standalone"
  | "spec-model-custom";

export interface RemoveFilterOptions {
  /** Remove aliases created by this droid-patch version */
  patchVersion?: string;
  /** Remove aliases for this droid version */
  droidVersion?: string;
  /** Remove aliases that have these flags enabled (all must match) */
  flags?: FilterFlag[];
}

/**
 * Remove aliases matching filter criteria
 */
export async function removeAliasesByFilter(filter: RemoveFilterOptions): Promise<void> {
  console.log(styleText("cyan", "═".repeat(60)));
  console.log(styleText(["cyan", "bold"], "  Remove Aliases by Filter"));
  console.log(styleText("cyan", "═".repeat(60)));
  console.log();

  // Show filter criteria
  if (filter.patchVersion) {
    console.log(styleText("white", `  Filter: droid-patch version = ${filter.patchVersion}`));
  }
  if (filter.droidVersion) {
    console.log(styleText("white", `  Filter: droid version = ${filter.droidVersion}`));
  }
  if (filter.flags && filter.flags.length > 0) {
    console.log(styleText("white", `  Filter: flags = ${filter.flags.join(", ")}`));
  }
  console.log();

  // Collect all alias names
  const aliasNames = new Set<string>();

  // Check common PATH directories for symlinks
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
            if (
              target.includes(".droid-patch/bins") ||
              target.includes(".droid-patch/websearch") ||
              target.includes(".droid-patch/proxy") ||
              target.includes(".droid-patch/statusline")
            ) {
              aliasNames.add(file);
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

  // Check aliases directory
  if (existsSync(ALIASES_DIR)) {
    try {
      const files = readdirSync(ALIASES_DIR);
      for (const file of files) {
        const fullPath = join(ALIASES_DIR, file);
        try {
          const stats = lstatSync(fullPath);
          if (stats.isSymbolicLink()) {
            aliasNames.add(file);
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      // Directory can't be read
    }
  }

  // Filter aliases by metadata
  const matchingAliases: string[] = [];

  for (const aliasName of aliasNames) {
    const meta = await loadAliasMetadata(aliasName);

    // If no metadata, skip (can't filter without metadata)
    if (!meta) {
      continue;
    }

    let matches = true;

    // Check droid-patch version
    if (filter.patchVersion && meta.droidPatchVersion !== filter.patchVersion) {
      matches = false;
    }

    // Check droid version
    if (filter.droidVersion && meta.droidVersion !== filter.droidVersion) {
      matches = false;
    }

    // Check flags (all specified flags must match)
    if (filter.flags && filter.flags.length > 0) {
      const patches = meta.patches;
      for (const flag of filter.flags) {
        switch (flag) {
          case "is-custom":
            if (!patches.isCustom) matches = false;
            break;
          case "skip-login":
            if (!patches.skipLogin) matches = false;
            break;
          case "websearch":
            if (!patches.websearch) matches = false;
            break;
          case "reasoning-effort":
            if (!patches.reasoningEffort) matches = false;
            break;
          case "api-base":
            if (!patches.apiBase) matches = false;
            break;
          case "disable-telemetry":
            if (!patches.noTelemetry) matches = false;
            break;
          case "standalone":
            if (!patches.standalone) matches = false;
            break;
          case "spec-model-custom":
            if (!patches.specModelCustom) matches = false;
            break;
        }
        if (!matches) break;
      }
    }

    if (matches) {
      matchingAliases.push(aliasName);
    }
  }

  if (matchingAliases.length === 0) {
    console.log(styleText("yellow", "  No aliases match the filter criteria."));
    console.log();
    return;
  }

  console.log(styleText("white", `  Found ${matchingAliases.length} matching alias(es):`));
  for (const name of matchingAliases) {
    console.log(styleText("gray", `    • ${name}`));
  }
  console.log();

  // Remove each matching alias
  for (const aliasName of matchingAliases) {
    await removeAlias(aliasName);
    console.log();
  }

  console.log(styleText("green", `[*] Removed ${matchingAliases.length} alias(es)`));
}

/**
 * Clear all droid-patch aliases and related files
 */
export async function clearAllAliases(): Promise<void> {
  console.log(styleText("cyan", "═".repeat(60)));
  console.log(styleText(["cyan", "bold"], "  Clearing All Droid-Patch Data"));
  console.log(styleText("cyan", "═".repeat(60)));
  console.log();

  // Collect all alias names
  const aliasNames = new Set<string>();

  // Check common PATH directories for symlinks
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
            if (
              target.includes(".droid-patch/bins") ||
              target.includes(".droid-patch/websearch") ||
              target.includes(".droid-patch/proxy") ||
              target.includes(".droid-patch/statusline")
            ) {
              aliasNames.add(file);
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

  // Check aliases directory
  if (existsSync(ALIASES_DIR)) {
    try {
      const files = readdirSync(ALIASES_DIR);
      for (const file of files) {
        const fullPath = join(ALIASES_DIR, file);
        try {
          const stats = lstatSync(fullPath);
          if (stats.isSymbolicLink()) {
            aliasNames.add(file);
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      // Directory can't be read
    }
  }

  if (aliasNames.size === 0) {
    console.log(styleText("yellow", "  No aliases found."));
  } else {
    console.log(styleText("white", `  Found ${aliasNames.size} alias(es) to remove:`));
    for (const name of aliasNames) {
      console.log(styleText("gray", `    • ${name}`));
    }
    console.log();

    // Remove each alias
    for (const aliasName of aliasNames) {
      await removeAlias(aliasName);
      console.log();
    }
  }

  // Clean up directories (including legacy files)
  console.log(styleText("white", "  Cleaning up directories..."));
  const dirsToClean = [
    join(DROID_PATCH_DIR, "bins"),
    join(DROID_PATCH_DIR, "aliases"),
    join(DROID_PATCH_DIR, "proxy"),
    join(DROID_PATCH_DIR, "websearch"),
    join(DROID_PATCH_DIR, "statusline"),
  ];

  for (const dir of dirsToClean) {
    if (existsSync(dir)) {
      try {
        const files = readdirSync(dir);
        for (const file of files) {
          const fullPath = join(dir, file);
          try {
            await unlink(fullPath);
            console.log(styleText("green", `    Removed: ${fullPath}`));
          } catch {
            // Ignore
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  // Clean up legacy temp files from old versions
  const legacyTempFiles = ["/tmp/droid-search-proxy.pid", "/tmp/droid-search-proxy.log"];

  for (const tempFile of legacyTempFiles) {
    if (existsSync(tempFile)) {
      try {
        await unlink(tempFile);
        console.log(styleText("green", `    Removed legacy: ${tempFile}`));
      } catch {
        // Ignore
      }
    }
  }

  // Clean up temp port files (pattern: /tmp/droid-websearch-*.port)
  try {
    const tmpFiles = readdirSync("/tmp");
    for (const file of tmpFiles) {
      if (file.startsWith("droid-websearch-") && file.endsWith(".port")) {
        const fullPath = join("/tmp", file);
        try {
          await unlink(fullPath);
          console.log(styleText("green", `    Removed temp: ${fullPath}`));
        } catch {
          // Ignore
        }
      }
      // Also clean old droid-search-proxy-*.port files
      if (file.startsWith("droid-search-proxy-") && file.endsWith(".port")) {
        const fullPath = join("/tmp", file);
        try {
          await unlink(fullPath);
          console.log(styleText("green", `    Removed legacy temp: ${fullPath}`));
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore
  }

  // Clean up metadata file
  const metadataFile = join(DROID_PATCH_DIR, "metadata.json");
  if (existsSync(metadataFile)) {
    try {
      await unlink(metadataFile);
      console.log(styleText("green", `    Removed: ${metadataFile}`));
    } catch {
      // Ignore
    }
  }

  console.log();
  console.log(styleText("green", "[*] All droid-patch data cleared successfully"));
}
