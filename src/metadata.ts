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
  /** Patches that were applied */
  patches: {
    isCustom: boolean;
    skipLogin: boolean;
    apiBase: string | null;
    websearch: boolean;
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
export async function loadAliasMetadata(
  aliasName: string,
): Promise<AliasMetadata | null> {
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
): AliasMetadata {
  const now = new Date().toISOString();
  return {
    name,
    createdAt: now,
    updatedAt: now,
    originalBinaryPath,
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
  if (patches.apiBase) applied.push(`apiBase(${patches.apiBase})`);
  if (patches.websearch) applied.push("websearch");
  return applied.length > 0 ? applied.join(", ") : "(none)";
}
