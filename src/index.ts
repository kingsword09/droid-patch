export { patchDroid } from "./patcher.ts";
export type { Patch, PatchOptions, PatchDroidResult } from "./patcher.ts";
export {
  createAlias,
  removeAlias,
  listAliases,
  replaceOriginal,
  restoreOriginal,
} from "./alias.ts";
export type { CreateAliasResult, ReplaceOriginalResult } from "./alias.ts";
