import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const MANAGED_ALIAS_TARGET_MARKERS = [
  ".droid-patch/bins",
  ".droid-patch/websearch",
  ".droid-patch/proxy",
  ".droid-patch/statusline",
];

export function pathExistsWithLstat(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function isManagedAliasTarget(target: string): boolean {
  return MANAGED_ALIAS_TARGET_MARKERS.some((marker) => target.includes(marker));
}

export function symlinkTargetExists(symlinkPath: string, target: string): boolean {
  const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(symlinkPath), target);
  return existsSync(resolvedTarget);
}
