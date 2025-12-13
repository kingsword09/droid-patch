import { readFile, writeFile, copyFile, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { styleText } from "node:util";

export interface Patch {
  name: string;
  description: string;
  pattern: Buffer;
  replacement: Buffer;
}

export interface PatchOptions {
  inputPath: string;
  outputPath?: string;
  patches: Patch[];
  dryRun?: boolean;
  backup?: boolean;
  verbose?: boolean;
}

interface PatchResult {
  name: string;
  found: number;
  positions?: number[];
  success: boolean;
  alreadyPatched?: boolean;
}

export interface PatchDroidResult {
  success: boolean;
  dryRun?: boolean;
  results: PatchResult[];
  outputPath?: string;
  noPatchNeeded?: boolean;
  patchedCount?: number;
}

export async function patchDroid(
  options: PatchOptions,
): Promise<PatchDroidResult> {
  const {
    inputPath,
    outputPath,
    patches,
    dryRun = false,
    backup = true,
    verbose = false,
  } = options;

  const finalOutputPath = outputPath || `${inputPath}.patched`;

  if (!existsSync(inputPath)) {
    throw new Error(`Binary not found: ${inputPath}`);
  }

  const stats = await stat(inputPath);
  const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  console.log(
    styleText("white", `[*] Reading binary: ${styleText("cyan", inputPath)}`),
  );
  console.log(
    styleText("white", `[*] File size: ${styleText("cyan", fileSizeMB)} MB`),
  );
  console.log();

  const data = await readFile(inputPath);
  const buffer = Buffer.from(data);

  // Use a working buffer that gets updated after each patch application
  // This ensures later patches search against the already-patched content
  const workingBuffer = Buffer.from(buffer);

  const results: PatchResult[] = [];

  for (const patch of patches) {
    console.log(
      styleText(
        "white",
        `[*] Checking patch: ${styleText("yellow", patch.name)}`,
      ),
    );
    console.log(styleText("gray", `    ${patch.description}`));

    // Search in the working buffer (which may have earlier patches applied)
    const positions = findAllPositions(workingBuffer, patch.pattern);

    if (positions.length === 0) {
      console.log(
        styleText("yellow", `    ! Pattern not found - may already be patched`),
      );
      results.push({
        name: patch.name,
        found: 0,
        success: false,
        alreadyPatched: workingBuffer.includes(patch.replacement),
      });

      const replacementPositions = findAllPositions(
        workingBuffer,
        patch.replacement,
      );
      if (replacementPositions.length > 0) {
        console.log(
          styleText(
            "blue",
            `    ✓ Found ${replacementPositions.length} occurrences of patched pattern`,
          ),
        );
        console.log(
          styleText("blue", `    ✓ Binary appears to be already patched`),
        );
        results[results.length - 1].alreadyPatched = true;
        results[results.length - 1].success = true;
      }
      continue;
    }

    console.log(
      styleText("green", `    ✓ Found ${positions.length} occurrences`),
    );

    if (verbose) {
      for (const pos of positions.slice(0, 5)) {
        const context = getContext(
          workingBuffer,
          pos,
          patch.pattern.length,
          25,
        );
        console.log(
          styleText(
            "gray",
            `      @ 0x${pos.toString(16).padStart(8, "0")}: ...${context}...`,
          ),
        );
      }
      if (positions.length > 5) {
        console.log(
          styleText("gray", `      ... and ${positions.length - 5} more`),
        );
      }
    }

    // Apply patch immediately to working buffer so later patches see updated content
    if (!dryRun) {
      for (const pos of positions) {
        patch.replacement.copy(workingBuffer, pos);
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

  if (dryRun) {
    console.log(styleText("blue", "─".repeat(60)));
    console.log(styleText(["blue", "bold"], "  DRY RUN RESULTS"));
    console.log(styleText("blue", "─".repeat(60)));
    console.log();

    for (const result of results) {
      if (result.alreadyPatched) {
        console.log(styleText("blue", `  [✓] ${result.name}: Already patched`));
      } else if (result.found > 0) {
        console.log(
          styleText(
            "green",
            `  [✓] ${result.name}: ${result.found} occurrences will be patched`,
          ),
        );
      } else {
        console.log(
          styleText("yellow", `  [!] ${result.name}: Pattern not found`),
        );
      }
    }

    return {
      success: results.every((r) => r.success || r.alreadyPatched),
      dryRun: true,
      results,
    };
  }

  const patchesNeeded = results.filter((r) => r.found > 0 && !r.alreadyPatched);

  if (patchesNeeded.length === 0) {
    const allPatched = results.every((r) => r.alreadyPatched);
    if (allPatched) {
      console.log(
        styleText(
          "blue",
          "[*] All patches already applied. Binary is up to date.",
        ),
      );
      return {
        success: true,
        outputPath: inputPath,
        results,
        noPatchNeeded: true,
      };
    }
    console.log(styleText("yellow", "[!] No patches could be applied."));
    return { success: false, results };
  }

  if (backup) {
    const backupPath = `${inputPath}.backup`;
    if (!existsSync(backupPath)) {
      await copyFile(inputPath, backupPath);
      console.log(
        styleText(
          "white",
          `[*] Created backup: ${styleText("cyan", backupPath)}`,
        ),
      );
    } else {
      console.log(
        styleText("gray", `[*] Backup already exists: ${backupPath}`),
      );
    }
  }

  console.log(styleText("white", "[*] Applying patches..."));
  // Patches have already been applied to workingBuffer during the check phase
  // Count total patches applied
  const totalPatched = results.reduce(
    (sum, r) => sum + (r.positions?.length || 0),
    0,
  );

  console.log(styleText("green", `[*] Applied ${totalPatched} patches`));

  await writeFile(finalOutputPath, workingBuffer);
  console.log(
    styleText(
      "white",
      `[*] Patched binary saved: ${styleText("cyan", finalOutputPath)}`,
    ),
  );

  await chmod(finalOutputPath, 0o755);
  console.log(styleText("gray", "[*] Set executable permission"));

  console.log();
  console.log(styleText("white", "[*] Verifying patches..."));
  const verifyBuffer = await readFile(finalOutputPath);

  let allVerified = true;
  for (const patch of patches) {
    const oldCount = findAllPositions(verifyBuffer, patch.pattern).length;
    const newCount = findAllPositions(verifyBuffer, patch.replacement).length;

    if (oldCount === 0) {
      console.log(
        styleText(
          "green",
          `    ✓ ${patch.name}: Verified (${newCount} patched)`,
        ),
      );
    } else {
      console.log(
        styleText(
          "red",
          `    ✗ ${patch.name}: ${oldCount} occurrences not patched`,
        ),
      );
      allVerified = false;
    }
  }

  if (allVerified) {
    console.log();
    console.log(styleText("green", "[+] All patches verified successfully!"));
  }

  if (process.platform === "darwin") {
    console.log();
    try {
      console.log(styleText("gray", "[*] Re-signing binary for macOS..."));
      execSync(`codesign --force --deep --sign - "${finalOutputPath}"`, {
        stdio: "pipe",
      });
      console.log(styleText("green", "[*] Binary re-signed successfully"));
    } catch {
      console.log(styleText("yellow", "[!] Could not re-sign binary"));
      console.log(
        styleText(
          "gray",
          `  You may need to run: codesign --force --deep --sign - ${finalOutputPath}`,
        ),
      );
    }

    try {
      execSync(`xattr -cr "${finalOutputPath}"`, { stdio: "pipe" });
    } catch {
      // Ignore
    }
  }

  return {
    success: allVerified,
    outputPath: finalOutputPath,
    results,
    patchedCount: totalPatched,
  };
}

function findAllPositions(buffer: Buffer, pattern: Buffer): number[] {
  const positions: number[] = [];
  let pos = 0;

  while (true) {
    pos = buffer.indexOf(pattern, pos);
    if (pos === -1) break;
    positions.push(pos);
    pos += pattern.length;
  }

  return positions;
}

function getContext(
  buffer: Buffer,
  position: number,
  patternLength: number,
  contextSize: number,
): string {
  const start = Math.max(0, position - contextSize);
  const end = Math.min(buffer.length, position + patternLength + contextSize);
  const slice = buffer.slice(start, end);

  let str = "";
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (c >= 32 && c < 127) {
      str += String.fromCharCode(c);
    } else {
      str += ".";
    }
  }
  return str;
}
