import { existsSync, mkdirSync, readdirSync, unlinkSync, lstatSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { symlink, readlink, unlink, mkdir, copyFile, chmod } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { execSync, spawnSync } from 'child_process';
import chalk from 'chalk';

// Directory to store patched binaries and symlinks
const DROID_PATCH_DIR = join(homedir(), '.droid-patch');
const ALIASES_DIR = join(DROID_PATCH_DIR, 'aliases');
const BINS_DIR = join(DROID_PATCH_DIR, 'bins');

// Common directories that are usually in PATH (in priority order)
const COMMON_PATH_DIRS = [
  // User-level directories (preferred, no sudo needed)
  join(homedir(), '.local/bin'),                    // XDG standard, very common
  join(homedir(), 'bin'),                           // Traditional user bin
  join(homedir(), '.bin'),                          // Alternative user bin

  // Homebrew (macOS)
  '/opt/homebrew/bin',                              // Apple Silicon Homebrew
  '/usr/local/bin',                                 // Intel Homebrew / system-wide

  // Node.js / npm / pnpm / yarn
  join(homedir(), '.npm-global/bin'),               // npm global (custom prefix)
  join(homedir(), '.npm/bin'),                      // npm alternative
  join(homedir(), '.pnpm-global/bin'),              // pnpm global
  join(homedir(), '.yarn/bin'),                     // Yarn global
  join(homedir(), '.config/yarn/global/node_modules/.bin'), // Yarn global bins

  // Package managers
  join(homedir(), '.cargo/bin'),                    // Rust cargo
  join(homedir(), 'go/bin'),                        // Go binaries
  join(homedir(), '.deno/bin'),                     // Deno
  join(homedir(), '.bun/bin'),                      // Bun

  // Version managers
  join(homedir(), '.local/share/mise/shims'),       // mise (formerly rtx)
  join(homedir(), '.asdf/shims'),                   // asdf
  join(homedir(), '.nvm/current/bin'),              // nvm current
  join(homedir(), '.volta/bin'),                    // Volta
  join(homedir(), '.fnm/current/bin'),              // fnm
];

/**
 * Ensure droid-patch directories exist
 */
function ensureDirectories() {
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

/**
 * Check if PATH includes our aliases directory
 */
function checkPathInclusion() {
  const pathEnv = process.env.PATH || '';
  return pathEnv.split(':').includes(ALIASES_DIR);
}

/**
 * Find a writable directory that's already in PATH
 * Returns the first match from COMMON_PATH_DIRS that's in PATH and writable
 */
function findWritablePathDir() {
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(':');

  for (const dir of COMMON_PATH_DIRS) {
    if (pathDirs.includes(dir)) {
      // Check if directory exists and is writable
      try {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        // Test write access
        const testFile = join(dir, `.droid-patch-test-${Date.now()}`);
        writeFileSync(testFile, '');
        unlinkSync(testFile);
        return dir;
      } catch {
        // Not writable, try next
        continue;
      }
    }
  }

  return null;
}

/**
 * Get shell config file path
 */
function getShellConfigPath() {
  const shell = process.env.SHELL || '/bin/bash';
  const shellName = basename(shell);

  switch (shellName) {
    case 'zsh':
      return join(homedir(), '.zshrc');
    case 'bash':
      // Check for .bash_profile first (macOS default), then .bashrc
      const bashProfile = join(homedir(), '.bash_profile');
      if (existsSync(bashProfile)) return bashProfile;
      return join(homedir(), '.bashrc');
    case 'fish':
      return join(homedir(), '.config/fish/config.fish');
    default:
      return join(homedir(), '.profile');
  }
}

/**
 * Check if PATH export line already exists in shell config
 */
function isPathConfigured(shellConfigPath) {
  if (!existsSync(shellConfigPath)) {
    return false;
  }

  try {
    const content = readFileSync(shellConfigPath, 'utf-8');
    // Check for various patterns that indicate our PATH is configured
    return content.includes('.droid-patch/aliases') ||
           content.includes('droid-patch/aliases');
  } catch {
    return false;
  }
}

/**
 * Add PATH configuration to shell config file
 */
function addPathToShellConfig(shellConfigPath, verbose = false) {
  const shell = process.env.SHELL || '/bin/bash';
  const shellName = basename(shell);

  let exportLine;
  if (shellName === 'fish') {
    exportLine = `\n# Added by droid-patch\nfish_add_path "${ALIASES_DIR}"\n`;
  } else {
    exportLine = `\n# Added by droid-patch\nexport PATH="${ALIASES_DIR}:$PATH"\n`;
  }

  try {
    appendFileSync(shellConfigPath, exportLine);
    if (verbose) {
      console.log(chalk.gray(`    Added PATH export to: ${shellConfigPath}`));
    }
    return true;
  } catch (error) {
    console.log(chalk.yellow(`[!] Could not write to ${shellConfigPath}: ${error.message}`));
    return false;
  }
}

/**
 * Create an alias for the patched binary
 * @param {string} patchedBinaryPath - Path to the patched binary
 * @param {string} aliasName - Name for the alias
 * @param {boolean} verbose - Enable verbose output
 */
export async function createAlias(patchedBinaryPath, aliasName, verbose = false) {
  ensureDirectories();

  console.log(chalk.white(`[*] Creating alias: ${chalk.cyan(aliasName)}`));

  // Strategy 1: Try to use a directory already in PATH (e.g., ~/.local/bin)
  const writablePathDir = findWritablePathDir();

  if (writablePathDir) {
    // Best case: we can write directly to a directory already in PATH
    const targetPath = join(writablePathDir, aliasName);

    // Store the binary in our bins directory for management
    const binaryDest = join(BINS_DIR, `${aliasName}-patched`);
    await copyFile(patchedBinaryPath, binaryDest);
    await chmod(binaryDest, 0o755);

    if (verbose) {
      console.log(chalk.gray(`    Stored binary: ${binaryDest}`));
    }

    // Remove existing file/symlink if it exists
    if (existsSync(targetPath)) {
      await unlink(targetPath);
      if (verbose) {
        console.log(chalk.gray(`    Removed existing: ${targetPath}`));
      }
    }

    // Create symlink in the PATH directory
    await symlink(binaryDest, targetPath);

    // On macOS, re-sign and remove quarantine
    if (process.platform === 'darwin') {
      try {
        console.log(chalk.gray('[*] Re-signing binary for macOS...'));
        execSync(`codesign --force --deep --sign - "${binaryDest}"`, { stdio: 'pipe' });
        console.log(chalk.green('[*] Binary re-signed successfully'));
      } catch {
        console.log(chalk.yellow('[!] Could not re-sign binary'));
      }

      try {
        execSync(`xattr -cr "${binaryDest}"`, { stdio: 'pipe' });
      } catch {
        // Ignore
      }
    }

    console.log(chalk.green(`[*] Created: ${targetPath} -> ${binaryDest}`));
    console.log();
    console.log(chalk.green('─'.repeat(60)));
    console.log(chalk.green.bold('  ALIAS READY - NO ACTION REQUIRED!'));
    console.log(chalk.green('─'.repeat(60)));
    console.log();
    console.log(chalk.white(`The alias "${chalk.cyan.bold(aliasName)}" is now available in ALL terminals.`));
    console.log(chalk.gray(`(Installed to: ${writablePathDir})`));

    return {
      aliasPath: targetPath,
      binaryPath: binaryDest,
      immediate: true,
    };
  }

  // Strategy 2: Fall back to our aliases directory (requires PATH modification)
  console.log(chalk.yellow('[*] No writable PATH directory found, using fallback...'));

  // Copy patched binary to our bins directory
  const binaryDest = join(BINS_DIR, `${aliasName}-patched`);
  await copyFile(patchedBinaryPath, binaryDest);
  await chmod(binaryDest, 0o755);

  if (verbose) {
    console.log(chalk.gray(`    Copied binary to: ${binaryDest}`));
  }

  // On macOS, try to re-sign the binary
  if (process.platform === 'darwin') {
    try {
      console.log(chalk.gray('[*] Re-signing binary for macOS...'));
      execSync(`codesign --force --deep --sign - "${binaryDest}"`, { stdio: 'pipe' });
      console.log(chalk.green('[*] Binary re-signed successfully'));
    } catch (error) {
      console.log(chalk.yellow('[!] Could not re-sign binary. You may need to do this manually:'));
      console.log(chalk.gray(`    codesign --force --deep --sign - "${binaryDest}"`));
    }

    // Remove quarantine attribute
    try {
      execSync(`xattr -cr "${binaryDest}"`, { stdio: 'pipe' });
    } catch {
      // Ignore errors
    }
  }

  // Create symlink in aliases directory
  const symlinkPath = join(ALIASES_DIR, aliasName);

  // Remove existing symlink if it exists
  if (existsSync(symlinkPath)) {
    await unlink(symlinkPath);
    if (verbose) {
      console.log(chalk.gray(`    Removed existing symlink`));
    }
  }

  await symlink(binaryDest, symlinkPath);
  await chmod(symlinkPath, 0o755);

  console.log(chalk.green(`[*] Created symlink: ${symlinkPath} -> ${binaryDest}`));

  // Check if PATH includes our aliases directory
  const shellConfig = getShellConfigPath();

  if (!checkPathInclusion()) {
    // Check if already configured in shell config file
    if (!isPathConfigured(shellConfig)) {
      console.log(chalk.white(`[*] Configuring PATH in ${shellConfig}...`));

      if (addPathToShellConfig(shellConfig, verbose)) {
        console.log(chalk.green(`[*] PATH configured successfully!`));
        console.log();
        console.log(chalk.yellow('─'.repeat(60)));
        console.log(chalk.yellow.bold('  ACTION REQUIRED'));
        console.log(chalk.yellow('─'.repeat(60)));
        console.log();
        console.log(chalk.white('To use the alias in this terminal, run:'));
        console.log();
        console.log(chalk.cyan(`  source ${shellConfig}`));
        console.log();
        console.log(chalk.gray('Or simply open a new terminal window.'));
        console.log(chalk.yellow('─'.repeat(60)));
      } else {
        // Manual fallback
        const exportLine = `export PATH="${ALIASES_DIR}:$PATH"`;
        console.log();
        console.log(chalk.yellow('─'.repeat(60)));
        console.log(chalk.yellow.bold('  Manual PATH Configuration Required'));
        console.log(chalk.yellow('─'.repeat(60)));
        console.log();
        console.log(chalk.white('Add this line to your shell config:'));
        console.log(chalk.cyan(`  ${exportLine}`));
        console.log();
        console.log(chalk.gray(`Shell config file: ${shellConfig}`));
        console.log(chalk.yellow('─'.repeat(60)));
      }
    } else {
      console.log(chalk.green(`[*] PATH already configured in ${shellConfig}`));
      console.log();
      console.log(chalk.yellow(`Note: Run \`source ${shellConfig}\` or open a new terminal to use the alias.`));
    }
  } else {
    console.log(chalk.green(`[*] PATH already includes aliases directory`));
    console.log();
    console.log(chalk.green(`You can now use "${chalk.cyan.bold(aliasName)}" command directly!`));
  }

  return {
    aliasPath: symlinkPath,
    binaryPath: binaryDest,
  };
}

/**
 * Remove an alias
 * @param {string} aliasName - Name of the alias to remove
 */
export async function removeAlias(aliasName) {
  console.log(chalk.white(`[*] Removing alias: ${chalk.cyan(aliasName)}`));

  let removed = false;

  // Check common PATH directories first (e.g., ~/.local/bin)
  for (const pathDir of COMMON_PATH_DIRS) {
    const pathSymlink = join(pathDir, aliasName);
    if (existsSync(pathSymlink)) {
      try {
        const stats = lstatSync(pathSymlink);
        if (stats.isSymbolicLink()) {
          const target = await readlink(pathSymlink);
          if (target.includes('.droid-patch/bins')) {
            await unlink(pathSymlink);
            console.log(chalk.green(`    Removed: ${pathSymlink}`));
            removed = true;
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  // Also check our aliases directory
  const symlinkPath = join(ALIASES_DIR, aliasName);
  if (existsSync(symlinkPath)) {
    await unlink(symlinkPath);
    console.log(chalk.green(`    Removed: ${symlinkPath}`));
    removed = true;
  }

  // Remove the binary
  const binaryPath = join(BINS_DIR, `${aliasName}-patched`);
  if (existsSync(binaryPath)) {
    await unlink(binaryPath);
    console.log(chalk.green(`    Removed binary: ${binaryPath}`));
    removed = true;
  }

  if (!removed) {
    console.log(chalk.yellow(`    Alias "${aliasName}" not found`));
  } else {
    console.log(chalk.green(`[*] Alias "${aliasName}" removed successfully`));
  }
}

/**
 * List all aliases
 */
export async function listAliases() {
  ensureDirectories();

  console.log(chalk.cyan('═'.repeat(60)));
  console.log(chalk.cyan.bold('  Droid-Patch Aliases'));
  console.log(chalk.cyan('═'.repeat(60)));
  console.log();

  const aliases = [];

  // Check aliases in common PATH directories (e.g., ~/.local/bin)
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
            // Check if it points to our bins directory
            if (target.includes('.droid-patch/bins')) {
              aliases.push({ name: file, target, location: pathDir, immediate: true });
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

  // Also check our aliases directory (fallback location)
  try {
    const files = readdirSync(ALIASES_DIR);

    for (const file of files) {
      const fullPath = join(ALIASES_DIR, file);
      try {
        const stats = lstatSync(fullPath);
        if (stats.isSymbolicLink()) {
          const target = await readlink(fullPath);
          // Avoid duplicates
          if (!aliases.find(a => a.name === file)) {
            aliases.push({ name: file, target, location: ALIASES_DIR, immediate: false });
          }
        }
      } catch {
        // Ignore errors reading individual files
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  if (aliases.length === 0) {
    console.log(chalk.gray('  No aliases configured.'));
    console.log();
    console.log(chalk.gray('  Create one with: npx droid-patch --is-custom <alias-name>'));
  } else {
    console.log(chalk.white(`  Found ${aliases.length} alias(es):`));
    console.log();
    for (const alias of aliases) {
      const status = alias.immediate
        ? chalk.green('✓ immediate')
        : chalk.yellow('requires source');
      console.log(chalk.green(`  • ${chalk.cyan.bold(alias.name)} [${status}]`));
      console.log(chalk.gray(`    → ${alias.target}`));
    }
  }

  console.log();
  console.log(chalk.gray(`  Aliases directory: ${ALIASES_DIR}`));
  console.log(chalk.gray(`  PATH configured: ${checkPathInclusion() ? chalk.green('Yes') : chalk.yellow('No')}`));
  console.log();
}

/**
 * Replace the original binary with the patched version
 * This is the recommended approach - works immediately in all terminals
 * @param {string} patchedBinaryPath - Path to the patched binary
 * @param {string} originalPath - Path to the original binary
 * @param {boolean} verbose - Enable verbose output
 */
export async function replaceOriginal(patchedBinaryPath, originalPath, verbose = false) {
  ensureDirectories();

  console.log(chalk.white(`[*] Replacing original binary: ${chalk.cyan(originalPath)}`));

  // Create backup in our directory (more reliable location)
  const backupName = `droid-original-${Date.now()}`;
  const backupPath = join(BINS_DIR, backupName);

  // Also keep a "latest" backup for easy restore
  const latestBackupPath = join(BINS_DIR, 'droid-original-latest');

  // Check if we already have a latest backup (don't overwrite the original-original)
  if (!existsSync(latestBackupPath)) {
    await copyFile(originalPath, latestBackupPath);
    console.log(chalk.green(`[*] Created backup: ${latestBackupPath}`));
  } else {
    if (verbose) {
      console.log(chalk.gray(`    Backup already exists: ${latestBackupPath}`));
    }
  }

  // Copy patched binary to original location
  await copyFile(patchedBinaryPath, originalPath);
  await chmod(originalPath, 0o755);
  console.log(chalk.green(`[*] Replaced: ${originalPath}`));

  // On macOS, re-sign and remove quarantine
  if (process.platform === 'darwin') {
    try {
      console.log(chalk.gray('[*] Re-signing binary for macOS...'));
      execSync(`codesign --force --deep --sign - "${originalPath}"`, { stdio: 'pipe' });
      console.log(chalk.green('[*] Binary re-signed successfully'));
    } catch (error) {
      console.log(chalk.yellow('[!] Could not re-sign binary. You may need to run:'));
      console.log(chalk.gray(`    codesign --force --deep --sign - "${originalPath}"`));
    }

    try {
      execSync(`xattr -cr "${originalPath}"`, { stdio: 'pipe' });
    } catch {
      // Ignore
    }
  }

  console.log();
  console.log(chalk.green('─'.repeat(60)));
  console.log(chalk.green.bold('  REPLACEMENT COMPLETE'));
  console.log(chalk.green('─'.repeat(60)));
  console.log();
  console.log(chalk.white('The patched binary is now active in all terminals.'));
  console.log(chalk.white('No need to restart or source anything!'));
  console.log();
  console.log(chalk.gray(`To restore the original, run:`));
  console.log(chalk.cyan(`  npx droid-patch restore`));

  return {
    originalPath,
    backupPath: latestBackupPath,
  };
}

/**
 * Restore the original droid binary from backup
 * @param {string} originalPath - Path where droid should be restored
 */
export async function restoreOriginal(originalPath) {
  ensureDirectories();

  const latestBackupPath = join(BINS_DIR, 'droid-original-latest');

  console.log(chalk.cyan('═'.repeat(60)));
  console.log(chalk.cyan.bold('  Restore Original Droid'));
  console.log(chalk.cyan('═'.repeat(60)));
  console.log();

  if (!existsSync(latestBackupPath)) {
    // Also check for .backup file next to original
    const localBackup = `${originalPath}.backup`;
    if (existsSync(localBackup)) {
      console.log(chalk.white(`[*] Found local backup: ${localBackup}`));
      console.log(chalk.white(`[*] Restoring to: ${originalPath}`));

      await copyFile(localBackup, originalPath);
      await chmod(originalPath, 0o755);

      if (process.platform === 'darwin') {
        try {
          execSync(`codesign --force --deep --sign - "${originalPath}"`, { stdio: 'pipe' });
          execSync(`xattr -cr "${originalPath}"`, { stdio: 'pipe' });
        } catch {
          // Ignore
        }
      }

      console.log();
      console.log(chalk.green('═'.repeat(60)));
      console.log(chalk.green.bold('  RESTORE COMPLETE'));
      console.log(chalk.green('═'.repeat(60)));
      console.log();
      console.log(chalk.green('Original droid binary has been restored from local backup.'));
      return;
    }

    console.log(chalk.red('[!] No backup found.'));
    console.log(chalk.gray(`    Checked: ${latestBackupPath}`));
    console.log(chalk.gray(`    Checked: ${localBackup}`));
    console.log();
    console.log(chalk.gray('If you have a manual backup, restore it with:'));
    console.log(chalk.cyan(`  cp /path/to/backup ${originalPath}`));
    return;
  }

  console.log(chalk.white(`[*] Restoring from: ${latestBackupPath}`));
  console.log(chalk.white(`[*] Restoring to: ${originalPath}`));

  // Ensure target directory exists
  const targetDir = dirname(originalPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  await copyFile(latestBackupPath, originalPath);
  await chmod(originalPath, 0o755);

  // On macOS, re-sign
  if (process.platform === 'darwin') {
    try {
      execSync(`codesign --force --deep --sign - "${originalPath}"`, { stdio: 'pipe' });
      execSync(`xattr -cr "${originalPath}"`, { stdio: 'pipe' });
    } catch {
      // Ignore
    }
  }

  console.log();
  console.log(chalk.green('═'.repeat(60)));
  console.log(chalk.green.bold('  RESTORE COMPLETE'));
  console.log(chalk.green('═'.repeat(60)));
  console.log();
  console.log(chalk.green('Original droid binary has been restored.'));
  console.log(chalk.green('All terminals will now use the original version.'));
}
