import { readFile, writeFile, copyFile, chmod, stat } from 'fs/promises';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { basename, dirname, join } from 'path';

/**
 * Patch the droid binary with specified patches
 * @param {Object} options
 * @param {string} options.inputPath - Path to the original binary
 * @param {string} options.outputPath - Path for patched output
 * @param {Array} options.patches - Array of patch objects
 * @param {boolean} options.dryRun - If true, only verify without patching
 * @param {boolean} options.backup - If true, create backup
 * @param {boolean} options.verbose - Enable verbose output
 */
export async function patchDroid(options) {
  const {
    inputPath,
    outputPath,
    patches,
    dryRun = false,
    backup = true,
    verbose = false,
  } = options;

  const finalOutputPath = outputPath || `${inputPath}.patched`;

  // Verify input file exists
  if (!existsSync(inputPath)) {
    throw new Error(`Binary not found: ${inputPath}`);
  }

  // Get file info
  const stats = await stat(inputPath);
  const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  console.log(chalk.white(`[*] Reading binary: ${chalk.cyan(inputPath)}`));
  console.log(chalk.white(`[*] File size: ${chalk.cyan(fileSizeMB)} MB`));
  console.log();

  // Read binary
  const data = await readFile(inputPath);
  const buffer = Buffer.from(data);

  // Process each patch
  const results = [];

  for (const patch of patches) {
    console.log(chalk.white(`[*] Checking patch: ${chalk.yellow(patch.name)}`));
    console.log(chalk.gray(`    ${patch.description}`));

    const positions = findAllPositions(buffer, patch.pattern);

    if (positions.length === 0) {
      console.log(chalk.yellow(`    ! Pattern not found - may already be patched`));
      results.push({
        name: patch.name,
        found: 0,
        success: false,
        alreadyPatched: buffer.includes(patch.replacement),
      });

      // Check if replacement pattern exists (already patched)
      const replacementPositions = findAllPositions(buffer, patch.replacement);
      if (replacementPositions.length > 0) {
        console.log(chalk.blue(`    ✓ Found ${replacementPositions.length} occurrences of patched pattern`));
        console.log(chalk.blue(`    ✓ Binary appears to be already patched`));
        results[results.length - 1].alreadyPatched = true;
        results[results.length - 1].success = true;
      }
      continue;
    }

    console.log(chalk.green(`    ✓ Found ${positions.length} occurrences`));

    if (verbose) {
      for (const pos of positions.slice(0, 5)) {
        const context = getContext(buffer, pos, patch.pattern.length, 25);
        console.log(chalk.gray(`      @ 0x${pos.toString(16).padStart(8, '0')}: ...${context}...`));
      }
      if (positions.length > 5) {
        console.log(chalk.gray(`      ... and ${positions.length - 5} more`));
      }
    }

    results.push({
      name: patch.name,
      found: positions.length,
      positions,
      success: true,
    });
  }

  console.log();

  // If dry run, just report findings
  if (dryRun) {
    console.log(chalk.blue('─'.repeat(60)));
    console.log(chalk.blue.bold('  DRY RUN RESULTS'));
    console.log(chalk.blue('─'.repeat(60)));
    console.log();

    for (const result of results) {
      if (result.alreadyPatched) {
        console.log(chalk.blue(`  [✓] ${result.name}: Already patched`));
      } else if (result.found > 0) {
        console.log(chalk.green(`  [✓] ${result.name}: ${result.found} occurrences will be patched`));
      } else {
        console.log(chalk.yellow(`  [!] ${result.name}: Pattern not found`));
      }
    }

    return {
      success: results.every(r => r.success || r.alreadyPatched),
      dryRun: true,
      results,
    };
  }

  // Check if any patches need to be applied
  const patchesNeeded = results.filter(r => r.found > 0 && !r.alreadyPatched);

  if (patchesNeeded.length === 0) {
    const allPatched = results.every(r => r.alreadyPatched);
    if (allPatched) {
      console.log(chalk.blue('[*] All patches already applied. Binary is up to date.'));
      return {
        success: true,
        outputPath: inputPath,
        results,
        noPatchNeeded: true,
      };
    }
    console.log(chalk.yellow('[!] No patches could be applied.'));
    return { success: false, results };
  }

  // Create backup if requested
  if (backup) {
    const backupPath = `${inputPath}.backup`;
    if (!existsSync(backupPath)) {
      await copyFile(inputPath, backupPath);
      console.log(chalk.white(`[*] Created backup: ${chalk.cyan(backupPath)}`));
    } else {
      console.log(chalk.gray(`[*] Backup already exists: ${backupPath}`));
    }
  }

  // Apply patches
  console.log(chalk.white('[*] Applying patches...'));
  const patchedBuffer = Buffer.from(buffer);

  let totalPatched = 0;
  for (const patch of patches) {
    const result = results.find(r => r.name === patch.name);
    if (!result || !result.positions) continue;

    for (const pos of result.positions) {
      patch.replacement.copy(patchedBuffer, pos);
      totalPatched++;
    }
  }

  console.log(chalk.green(`[*] Applied ${totalPatched} patches`));

  // Write patched file
  await writeFile(finalOutputPath, patchedBuffer);
  console.log(chalk.white(`[*] Patched binary saved: ${chalk.cyan(finalOutputPath)}`));

  // Set executable permission
  await chmod(finalOutputPath, 0o755);
  console.log(chalk.gray('[*] Set executable permission'));

  // Verify patch
  console.log();
  console.log(chalk.white('[*] Verifying patches...'));
  const verifyBuffer = await readFile(finalOutputPath);

  let allVerified = true;
  for (const patch of patches) {
    const oldCount = findAllPositions(verifyBuffer, patch.pattern).length;
    const newCount = findAllPositions(verifyBuffer, patch.replacement).length;

    if (oldCount === 0) {
      console.log(chalk.green(`    ✓ ${patch.name}: Verified (${newCount} patched)`));
    } else {
      console.log(chalk.red(`    ✗ ${patch.name}: ${oldCount} occurrences not patched`));
      allVerified = false;
    }
  }

  if (allVerified) {
    console.log();
    console.log(chalk.green('[+] All patches verified successfully!'));
  }

  // macOS specific notes
  if (process.platform === 'darwin') {
    console.log();
    console.log(chalk.yellow('Note for macOS:'));
    console.log(chalk.gray(`  You may need to re-sign: codesign --force --deep --sign - ${finalOutputPath}`));
    console.log(chalk.gray(`  Or remove quarantine: xattr -cr ${finalOutputPath}`));
  }

  return {
    success: allVerified,
    outputPath: finalOutputPath,
    results,
    patchedCount: totalPatched,
  };
}

/**
 * Find all positions of a pattern in a buffer
 */
function findAllPositions(buffer, pattern) {
  const positions = [];
  let pos = 0;

  while (true) {
    pos = buffer.indexOf(pattern, pos);
    if (pos === -1) break;
    positions.push(pos);
    pos += pattern.length;
  }

  return positions;
}

/**
 * Get context around a position for display
 */
function getContext(buffer, position, patternLength, contextSize) {
  const start = Math.max(0, position - contextSize);
  const end = Math.min(buffer.length, position + patternLength + contextSize);
  const slice = buffer.slice(start, end);

  // Try to decode as UTF-8, replace non-printable chars
  let str = '';
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (c >= 32 && c < 127) {
      str += String.fromCharCode(c);
    } else {
      str += '.';
    }
  }
  return str;
}
