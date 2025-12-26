/**
 * Alias Metadata Management
 *
 * Stores and retrieves metadata about created aliases, including
 * which patches were applied. This enables the `update` command
 * to re-apply the same patches when the original droid binary is updated.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Metadata structure for an alias
 */
export interface AliasMetadata {
  /** Alias name */
  name: string;
  /** ISO timestamp when created */
  createdAt: string;
  /** ISO timestamp when last updated */
  updatedAt: string;
  /** Path to the original droid binary used for patching */
  originalBinaryPath: string;
  /** Path where the alias symlink was created */
  aliasPath?: string;
  /** droid-patch version used to create this alias */
  droidPatchVersion?: string;
  /** droid binary version */
  droidVersion?: string;
  /** Patches that were applied */
  patches: {
    isCustom: boolean;
    skipLogin: boolean;
    /** API base URL for binary patching or websearch forward target */
    apiBase: string | null;
    /** Whether websearch is enabled */
    websearch: boolean;
    /** @deprecated Old proxy field, kept for backward compatibility */
    proxy?: string | null;
    reasoningEffort: boolean;
    /** Whether telemetry/Sentry is disabled */
    noTelemetry?: boolean;
    /** Standalone mode: mock non-LLM Factory APIs */
    standalone?: boolean;
    /** Hardcode autonomy mode to auto-high */
    autoHigh?: boolean;
  };
}

// Directory for storing metadata files
const META_DIR = join(homedir(), ".droid-patch", "meta");

/**
 * Ensure metadata directory exists
 */
async function ensureMetaDir(): Promise<void> {
  if (!existsSync(META_DIR)) {
    await mkdir(META_DIR, { recursive: true });
  }
}

/**
 * Get the path to a metadata file for an alias
 */
function getMetaPath(aliasName: string): string {
  return join(META_DIR, `${aliasName}.json`);
}

/**
 * Save alias metadata to disk
 */
export async function saveAliasMetadata(meta: AliasMetadata): Promise<void> {
  await ensureMetaDir();
  const metaPath = getMetaPath(meta.name);
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Load alias metadata from disk
 * Returns null if metadata doesn't exist
 */
export async function loadAliasMetadata(aliasName: string): Promise<AliasMetadata | null> {
  const metaPath = getMetaPath(aliasName);
  if (!existsSync(metaPath)) {
    return null;
  }
  try {
    const content = await readFile(metaPath, "utf-8");
    return JSON.parse(content) as AliasMetadata;
  } catch {
    return null;
  }
}

/**
 * List all alias metadata
 */
export async function listAllMetadata(): Promise<AliasMetadata[]> {
  await ensureMetaDir();

  const files = await readdir(META_DIR);
  const metaList: AliasMetadata[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const aliasName = file.replace(/\.json$/, "");
    const meta = await loadAliasMetadata(aliasName);
    if (meta) {
      metaList.push(meta);
    }
  }

  return metaList;
}

/**
 * Remove alias metadata
 */
export async function removeAliasMetadata(aliasName: string): Promise<boolean> {
  const metaPath = getMetaPath(aliasName);
  if (!existsSync(metaPath)) {
    return false;
  }
  try {
    await unlink(metaPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new metadata object with current timestamp
 */
export function createMetadata(
  name: string,
  originalBinaryPath: string,
  patches: AliasMetadata["patches"],
  options?: {
    droidPatchVersion?: string;
    droidVersion?: string;
    aliasPath?: string;
  },
): AliasMetadata {
  const now = new Date().toISOString();
  return {
    name,
    createdAt: now,
    updatedAt: now,
    originalBinaryPath,
    aliasPath: options?.aliasPath,
    droidPatchVersion: options?.droidPatchVersion,
    droidVersion: options?.droidVersion,
    patches,
  };
}

/**
 * Format patches for display
 */
export function formatPatches(patches: AliasMetadata["patches"]): string {
  const applied: string[] = [];
  if (patches.isCustom) applied.push("isCustom");
  if (patches.skipLogin) applied.push("skipLogin");
  // Show apiBase only when not using websearch (binary patch mode)
  if (patches.apiBase && !patches.websearch) applied.push(`apiBase(${patches.apiBase})`);
  // Show websearch with optional custom target
  if (patches.websearch) {
    const target = patches.apiBase || "api.factory.ai";
    applied.push(`websearch(${target})`);
  }
  // Support old proxy field for backward compatibility
  if (patches.proxy && !patches.websearch) applied.push(`websearch(${patches.proxy})`);
  if (patches.reasoningEffort) applied.push("reasoningEffort");
  if (patches.noTelemetry) applied.push("noTelemetry");
  if (patches.standalone) applied.push("standalone");
  if (patches.autoHigh) applied.push("autoHigh");
  return applied.length > 0 ? applied.join(", ") : "(none)";
}
