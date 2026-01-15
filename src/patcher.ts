import { readFile, writeFile, copyFile, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { styleText } from "node:util";
import { platform } from "node:os";

const IS_WINDOWS = platform() === "win32";

export interface Patch {
  name: string;
  description: string;
  pattern: Buffer;
  replacement: Buffer;
  variants?: Array<{
    pattern: Buffer;
    replacement: Buffer;
  }>;
  // Regex-based matching: use $1, $2, etc. in regexReplacement for capture groups
  regexPattern?: RegExp;
  regexReplacement?: string;
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

export async function patchDroid(options: PatchOptions): Promise<PatchDroidResult> {
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

  console.log(styleText("white", `[*] Reading binary: ${styleText("cyan", inputPath)}`));
  console.log(styleText("white", `[*] File size: ${styleText("cyan", fileSizeMB)} MB`));
  console.log();

  const data = await readFile(inputPath);
  const buffer = Buffer.from(data);

  // Use a working buffer that gets updated after each patch application
  // This ensures later patches search against the already-patched content
  const workingBuffer = Buffer.from(buffer);

  const results: PatchResult[] = [];

  for (const patch of patches) {
    console.log(styleText("white", `[*] Checking patch: ${styleText("yellow", patch.name)}`));
    console.log(styleText("gray", `    ${patch.description}`));

    // Handle regex-based matching
    // For binary files, convert pattern/replacement to Buffer and use findAllPositions
    if (patch.regexPattern && patch.regexReplacement) {
      const content = workingBuffer.toString("utf-8");
      const regex = new RegExp(patch.regexPattern.source, "g");
      const matches: Array<{ charIndex: number; match: string; replacement: string }> = [];

      let match;
      while ((match = regex.exec(content)) !== null) {
        const replacement = match[0].replace(
          new RegExp(patch.regexPattern.source),
          patch.regexReplacement,
        );
        matches.push({
          charIndex: match.index,
          match: match[0],
          replacement,
        });
      }

      if (matches.length === 0) {
        console.log(styleText("yellow", `    ! Pattern not found - may already be patched`));
        // Check if already patched by looking for a sample replacement pattern
        const sampleReplacement = patch.regexReplacement.replace(/\$\d+/g, "X");
        const alreadyPatched = content.includes(sampleReplacement.slice(0, 20));
        results.push({
          name: patch.name,
          found: 0,
          success: alreadyPatched,
          alreadyPatched,
        });
        if (alreadyPatched) {
          console.log(styleText("blue", `    ✓ Binary appears to be already patched`));
        }
        continue;
      }

      console.log(styleText("green", `    ✓ Found ${matches.length} occurrences (regex)`));

      if (!dryRun) {
        // Apply regex replacement using Buffer.indexOf for accurate byte positions
        for (const { match, replacement } of matches) {
          const matchBuffer = Buffer.from(match, "utf-8");
          const replacementBuffer = Buffer.from(replacement, "utf-8");

          if (matchBuffer.length !== replacementBuffer.length) {
            console.log(
              styleText(
                "yellow",
                `    ! Warning: Length mismatch: ${matchBuffer.length} vs ${replacementBuffer.length}`,
              ),
            );
          }

          // Find the actual byte position in the buffer
          const bytePos = workingBuffer.indexOf(matchBuffer);
          if (bytePos !== -1) {
            replacementBuffer.copy(workingBuffer, bytePos, 0, replacementBuffer.length);
          }
        }
      }

      results.push({
        name: patch.name,
        found: matches.length,
        positions: matches.map((m) => m.charIndex),
        success: true,
      });
      continue;
    }

    const variants = [
      { pattern: patch.pattern, replacement: patch.replacement },
      ...(patch.variants || []),
    ];

    // Search in the working buffer (which may have earlier patches applied)
    let positions: number[] = [];
    let matchedVariant: (typeof variants)[number] | undefined;
    for (const variant of variants) {
      positions = findAllPositions(workingBuffer, variant.pattern);
      if (positions.length > 0) {
        matchedVariant = variant;
        break;
      }
    }

    if (positions.length === 0) {
      console.log(styleText("yellow", `    ! Pattern not found - may already be patched`));
      results.push({
        name: patch.name,
        found: 0,
        success: false,
        alreadyPatched: variants.some((v) => workingBuffer.includes(v.replacement)),
      });

      let totalReplacementPositions = 0;
      for (const variant of variants) {
        totalReplacementPositions += findAllPositions(workingBuffer, variant.replacement).length;
      }
      if (totalReplacementPositions > 0) {
        console.log(
          styleText(
            "blue",
            `    ✓ Found ${totalReplacementPositions} occurrences of patched pattern`,
          ),
        );
        console.log(styleText("blue", `    ✓ Binary appears to be already patched`));
        results[results.length - 1].alreadyPatched = true;
        results[results.length - 1].success = true;
      }
      continue;
    }

    if (!matchedVariant) {
      throw new Error(`Internal error: matchedVariant not set for patch ${patch.name}`);
    }

    console.log(styleText("green", `    ✓ Found ${positions.length} occurrences`));

    if (verbose) {
      for (const pos of positions.slice(0, 5)) {
        const context = getContext(workingBuffer, pos, matchedVariant.pattern.length, 25);
        console.log(
          styleText("gray", `      @ 0x${pos.toString(16).padStart(8, "0")}: ...${context}...`),
        );
      }
      if (positions.length > 5) {
        console.log(styleText("gray", `      ... and ${positions.length - 5} more`));
      }
    }

    // Apply patch immediately to working buffer so later patches see updated content
    if (!dryRun) {
      for (const pos of positions) {
        matchedVariant.replacement.copy(workingBuffer, pos);
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
          styleText("green", `  [✓] ${result.name}: ${result.found} occurrences will be patched`),
        );
      } else {
        console.log(styleText("yellow", `  [!] ${result.name}: Pattern not found`));
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
      console.log(styleText("blue", "[*] All patches already applied. Binary is up to date."));
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
      console.log(styleText("white", `[*] Created backup: ${styleText("cyan", backupPath)}`));
    } else {
      console.log(styleText("gray", `[*] Backup already exists: ${backupPath}`));
    }
  }

  console.log(styleText("white", "[*] Applying patches..."));
  // Patches have already been applied to workingBuffer during the check phase
  // Count total patches applied
  const totalPatched = results.reduce((sum, r) => sum + (r.positions?.length || 0), 0);

  console.log(styleText("green", `[*] Applied ${totalPatched} patches`));

  // Handle Windows file locking - if file is locked, use a new filename
  let actualOutputPath = finalOutputPath;
  try {
    await writeFile(finalOutputPath, workingBuffer);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EBUSY" && IS_WINDOWS) {
      // File is locked, generate new filename with timestamp
      const timestamp = Date.now();
      const ext = finalOutputPath.endsWith(".exe") ? ".exe" : "";
      const basePath = finalOutputPath
        .replace(/\.exe$/, "")
        .replace(/\.patched$/, "")
        .replace(/-\d+$/, "");
      actualOutputPath = `${basePath}-${timestamp}${ext ? ext : ".patched"}`;
      console.log(styleText("yellow", `[!] Original file locked, saving to: ${actualOutputPath}`));
      await writeFile(actualOutputPath, workingBuffer);
    } else {
      throw error;
    }
  }
  console.log(
    styleText("white", `[*] Patched binary saved: ${styleText("cyan", actualOutputPath)}`),
  );

  await chmod(actualOutputPath, 0o755);
  console.log(styleText("gray", "[*] Set executable permission"));

  console.log();
  console.log(styleText("white", "[*] Verifying patches..."));
  const verifyBuffer = await readFile(actualOutputPath);

  let allVerified = true;
  for (const patch of patches) {
    // Handle regex-based patches
    if (patch.regexPattern && patch.regexReplacement) {
      const content = verifyBuffer.toString("utf-8");
      const oldMatches = [...content.matchAll(new RegExp(patch.regexPattern.source, "g"))];
      // For verification, just check that the original pattern is no longer present
      if (oldMatches.length === 0) {
        console.log(styleText("green", `    ✓ ${patch.name}: Verified (regex)`));
      } else {
        console.log(
          styleText("red", `    ✗ ${patch.name}: ${oldMatches.length} occurrences not patched`),
        );
        allVerified = false;
      }
      continue;
    }

    const variants = [
      { pattern: patch.pattern, replacement: patch.replacement },
      ...(patch.variants || []),
    ];

    let oldCount = 0;
    let newCount = 0;
    for (const variant of variants) {
      if (variant.pattern.length > 0) {
        oldCount += findAllPositions(verifyBuffer, variant.pattern).length;
      }
      if (variant.replacement.length > 0) {
        newCount += findAllPositions(verifyBuffer, variant.replacement).length;
      }
    }

    if (oldCount === 0) {
      console.log(styleText("green", `    ✓ ${patch.name}: Verified (${newCount} patched)`));
    } else {
      console.log(styleText("red", `    ✗ ${patch.name}: ${oldCount} occurrences not patched`));
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
    outputPath: actualOutputPath,
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
