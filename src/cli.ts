import bin from "tiny-bin";
import { styleText } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { patchDroid, type Patch } from "./patcher.ts";
import {
  createAlias,
  removeAlias,
  listAliases,
  createAliasForWrapper,
  clearAllAliases,
  removeAliasesByFilter,
  type FilterFlag,
} from "./alias.ts";
import { isManagedAliasTarget, pathExistsWithLstat } from "./alias-utils.ts";
import { createWebSearchUnifiedFiles } from "./websearch-patch.ts";
import {
  saveAliasMetadata,
  createMetadata,
  loadAliasMetadata,
  listAllMetadata,
  formatPatches,
} from "./metadata.ts";
import {
  addModel,
  addModelInteractive,
  removeModel,
  printModelsList,
  type Provider,
} from "./model-manager.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = platform() === "win32";

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const version = getVersion();

function getDroidVersion(droidPath: string): string | undefined {
  try {
    const result = execSync(`"${droidPath}" --version`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    // Parse version from output like "droid 1.2.3" or just "1.2.3"
    const match = result.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : result || undefined;
  } catch {
    return undefined;
  }
}

function parseSemver(versionText: string): [number, number, number] | null {
  const match = versionText.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left: string, right: string): number {
  const l = parseSemver(left);
  const r = parseSemver(right);
  if (!l || !r) {
    throw new Error(`Invalid semver comparison: "${left}" vs "${right}"`);
  }

  for (let i = 0; i < 3; i++) {
    if (l[i] > r[i]) return 1;
    if (l[i] < r[i]) return -1;
  }
  return 0;
}

interface VersionedPatchRule {
  id: string;
  minVersion?: string;
  maxVersion?: string; // Exclusive upper bound
  buildPatches: () => Patch[];
}

function regexMatchesText(text: string, regex: RegExp): boolean {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags).test(text);
}

function patchMatchesBinary(binaryBuffer: Buffer, binaryText: string, patch: Patch): boolean {
  if (patch.semanticMatcher) {
    return (
      patch.semanticMatcher(binaryText).length > 0 ||
      (!!patch.alreadyPatchedRegexPattern &&
        regexMatchesText(binaryText, patch.alreadyPatchedRegexPattern))
    );
  }

  if (patch.regexPattern) {
    return (
      regexMatchesText(binaryText, patch.regexPattern) ||
      (!!patch.alreadyPatchedRegexPattern &&
        regexMatchesText(binaryText, patch.alreadyPatchedRegexPattern))
    );
  }

  const variants = [
    { pattern: patch.pattern, replacement: patch.replacement },
    ...(patch.variants || []),
  ];

  return variants.some(
    (variant) =>
      (!!variant.pattern.length && binaryBuffer.includes(variant.pattern)) ||
      (!!variant.replacement.length && binaryBuffer.includes(variant.replacement)),
  );
}

function inferVersionedPatchRuleFromBinary(
  droidPath: string | undefined,
  rules: VersionedPatchRule[],
): VersionedPatchRule | undefined {
  if (!droidPath || !existsSync(droidPath)) {
    return undefined;
  }

  try {
    const binaryBuffer = readFileSync(droidPath);
    const binaryText = binaryBuffer.toString("utf-8");
    const matchingRules = rules.filter((rule) =>
      rule.buildPatches().every((patch) => patchMatchesBinary(binaryBuffer, binaryText, patch)),
    );

    if (matchingRules.length === 1) {
      return matchingRules[0];
    }
  } catch {
    // Fall through to the existing version-based errors below.
  }

  return undefined;
}

function matchesVersionRule(droidVersion: string, rule: VersionedPatchRule): boolean {
  if (rule.minVersion && compareSemver(droidVersion, rule.minVersion) < 0) {
    return false;
  }
  if (rule.maxVersion && compareSemver(droidVersion, rule.maxVersion) >= 0) {
    return false;
  }
  return true;
}

function resolveVersionedPatches(
  featureName: string,
  droidVersion: string | undefined,
  rules: VersionedPatchRule[],
  droidPath?: string,
): Patch[] {
  if (droidVersion && parseSemver(droidVersion)) {
    const matchedRule = rules.find((rule) => matchesVersionRule(droidVersion, rule));
    if (matchedRule) {
      return matchedRule.buildPatches();
    }
  }

  const inferredRule = inferVersionedPatchRuleFromBinary(droidPath, rules);
  if (inferredRule) {
    return inferredRule.buildPatches();
  }

  if (!droidVersion) {
    throw new Error(`Unable to detect droid version for ${featureName}`);
  }
  if (!parseSemver(droidVersion)) {
    throw new Error(`Unsupported droid version format "${droidVersion}" for ${featureName}`);
  }

  const matchedRule = rules.find((rule) => matchesVersionRule(droidVersion, rule));
  if (!matchedRule) {
    throw new Error(`No patch rule matched ${featureName} on droid ${droidVersion}`);
  }
  return matchedRule.buildPatches();
}

const SKIP_LOGIN_V068_PLUS_REGEX =
  /process\.env\[[A-Za-z_$][A-Za-z0-9_$]*\.FACTORY_API_KEY\](?:\?\.trim\(\))?/g;
const SKIP_LOGIN_V068_PLUS_REPLACEMENT_PREFIX = "fk-droid-patch-skip-";
const SKIP_LOGIN_V068_PLUS_PATCHED_REGEX = /(?:"fk-droid-patch-skip-[0-9]*"|"fk-skip-login"[ ]*)/g;

function createFixedLengthStringLiteral(prefix: string, targetLength: number): string {
  if (targetLength < 2) {
    throw new Error(`String literal target length must be at least 2, got ${targetLength}`);
  }

  const contentLength = targetLength - 2;
  const content =
    prefix.length >= contentLength
      ? prefix.slice(0, contentLength)
      : prefix.padEnd(contentLength, "0");

  return `"${content}"`;
}

const SKIP_LOGIN_PATCH_RULES: VersionedPatchRule[] = [
  {
    id: "skip-login-legacy",
    maxVersion: "0.68.0",
    buildPatches: () => [
      {
        name: "skipLogin",
        description: 'Replace process.env.FACTORY_API_KEY with "fk-droid-patch-skip-00000"',
        pattern: Buffer.from("process.env.FACTORY_API_KEY"),
        replacement: Buffer.from('"fk-droid-patch-skip-00000"'),
      },
    ],
  },
  {
    id: "skip-login-v068-plus",
    minVersion: "0.68.0",
    buildPatches: () => [
      {
        name: "factoryApiKeyLookupV068",
        description:
          "Replace process.env[<minified>.FACTORY_API_KEY]?.trim() with a fixed-length fake key via regex matching",
        pattern: Buffer.from(""),
        replacement: Buffer.from(""),
        regexPattern: SKIP_LOGIN_V068_PLUS_REGEX,
        regexReplacement: (match) =>
          createFixedLengthStringLiteral(SKIP_LOGIN_V068_PLUS_REPLACEMENT_PREFIX, match.length),
        alreadyPatchedRegexPattern: SKIP_LOGIN_V068_PLUS_PATCHED_REGEX,
      },
    ],
  },
];

const INLINE_MODEL_PICKER_CALLBACK_REGEX =
  /([A-Za-z$_][A-Za-z0-9$_]*)=[A-Za-z$_][A-Za-z0-9$_]*\.useCallback\(\(\)=>\{if\(([A-Za-z$_][A-Za-z0-9$_]*)\.length<=1\)return;let ([A-Za-z$_][A-Za-z0-9$_]*)=[A-Za-z$_][A-Za-z0-9$_]*\(\)\.getModelPolicy\(\);if\(!\2\.some\(\(([A-Za-z$_][A-Za-z0-9$_]*)\)=>[A-Za-z$_][A-Za-z0-9$_]*\(\4,\3\)\.allowed\)\)return;([A-Za-z$_][A-Za-z0-9$_]*)\(\(([A-Za-z$_][A-Za-z0-9$_]*)\)=>!\6\)\},\[\2\]\)/g;
const INLINE_MODEL_PICKER_INLINE_SETTER_REGEX =
  /availableModels:([A-Za-z$_][A-Za-z0-9$_]*),currentModel:[^,]+,onSelect:[A-Za-z$_][A-Za-z0-9$_]*,onCancel:\(\)=>([A-Za-z$_][A-Za-z0-9$_]*)\(!1\)/g;
const INLINE_MODEL_PICKER_FULL_SELECTOR_REGEX =
  /onCancel:\(\)=>\{([A-Za-z$_][A-Za-z0-9$_]*)\(!1\),([A-Za-z$_][A-Za-z0-9$_]*)\(!1\),([A-Za-z$_][A-Za-z0-9$_]*)\.current\?\.closeSuggestions\?\.\(\),\3\.current\?\.setInput\?\.\(""\)\}/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createInlineModelPickerSemanticPatch(binaryText: string): Patch | null {
  const inlinePickerContexts = [
    ...binaryText.matchAll(INLINE_MODEL_PICKER_INLINE_SETTER_REGEX),
  ].map((match) => ({
    modelsVar: match[1],
    inlineSetter: match[2],
  }));

  if (inlinePickerContexts.length === 0) {
    return null;
  }

  const callbackMatches = [...binaryText.matchAll(INLINE_MODEL_PICKER_CALLBACK_REGEX)].filter(
    (match) =>
      inlinePickerContexts.some(
        (context) => context.modelsVar === match[2] && context.inlineSetter === match[5],
      ),
  );

  if (callbackMatches.length !== 1) {
    return null;
  }

  const callbackMatch = callbackMatches[0];
  const inlineSetter = callbackMatch[5];
  const fullSelectorSetters = [
    ...new Set(
      [...binaryText.matchAll(INLINE_MODEL_PICKER_FULL_SELECTOR_REGEX)]
        .map((match) => match[1])
        .filter((setter) => setter !== inlineSetter),
    ),
  ];

  if (fullSelectorSetters.length !== 1) {
    return null;
  }

  const fullSelectorSetter = fullSelectorSetters[0];
  if (inlineSetter.length !== fullSelectorSetter.length) {
    return null;
  }

  const callbackSource = callbackMatch[0];
  const toggleParam = callbackMatch[6];
  const inlineToggle = `${inlineSetter}((${toggleParam})=>!${toggleParam})`;
  const fullSelectorToggle = `${fullSelectorSetter}((${toggleParam})=>!${toggleParam})`;

  if (!callbackSource.includes(inlineToggle)) {
    return null;
  }

  const callbackReplacement = callbackSource.replace(inlineToggle, fullSelectorToggle);
  if (callbackReplacement === callbackSource) {
    return null;
  }

  return {
    name: "inlineModelPickerUsesFullSelector",
    description:
      "Change ctrl+N callback from inline built-in picker to full model selector overlay",
    pattern: Buffer.from(""),
    replacement: Buffer.from(""),
    regexPattern: new RegExp(escapeRegExp(callbackSource), "g"),
    regexReplacement: () => callbackReplacement,
    alreadyPatchedRegexPattern: new RegExp(escapeRegExp(callbackReplacement), "g"),
    suppressCheckUnlessFound: true,
  };
}

function resolveInlineModelPickerPatch(droidPath: string | undefined): Patch | null {
  if (!droidPath || !existsSync(droidPath)) {
    return null;
  }

  try {
    const binaryText = readFileSync(droidPath, "utf-8");
    return createInlineModelPickerSemanticPatch(binaryText);
  } catch {
    return null;
  }
}

const FACTORYD_SELF_PATH_REGEX =
  /if\(([A-Za-z$_][A-Za-z0-9$_]*)\.basename\(process\.execPath\)\.includes\("droid"\)\)/g;
const FACTORYD_SELF_PATH_PATCHED_REGEX =
  /if\(\(1\|\|([A-Za-z$_][A-Za-z0-9$_]*)\.basename\(process\.execPath\)\.includes\(""\)\)\)/g;
const JS_IDENTIFIER = "[A-Za-z$_][A-Za-z0-9$_]*";
const FACTORYD_SKIP_LOGIN_AUTH_PATCHED_REGEX =
  /if\(\/\^fk\/\.test\([A-Za-z$_][A-Za-z0-9$_]*\)\)return\{userId:"f",orgId:"f"\}/g;
const SKIP_LOGIN_APIKEY_PRIORITY_PATCHED_REGEX =
  /async function [A-Za-z$_][A-Za-z0-9$_]*\([A-Za-z$_][A-Za-z0-9$_]*\)\{(?:if\([A-Za-z$_][A-Za-z0-9$_]*\.airgapEnabled\)return [A-Za-z$_][A-Za-z0-9$_]*;)?let [A-Za-z$_][A-Za-z0-9$_]*=[A-Za-z$_][A-Za-z0-9$_]*\.apiKey\?\.trim\(\);if\([A-Za-z$_][A-Za-z0-9$_]*&&\/\^fk\/\.test\([A-Za-z$_][A-Za-z0-9$_]*\)\)return\{type:"api-key",token:[A-Za-z$_][A-Za-z0-9$_]*\}/g;
const MISSION_WORKER_EXIT_ANCHORS = [
  '"[JsonRpc] Worker session exiting after completing turn"',
  '"[JsonRpcStreamingExec] Worker session exiting after completing turn"',
];
const MISSION_WORKER_EXIT_PATCHED_REGEX =
  /if\(0\s*\)[A-Za-z$_][A-Za-z0-9$_]*\("\[JsonRpc(?:StreamingExec)?\] Worker session exiting after completing turn"\)/g;
const REASONING_EFFORT_CUSTOM_MODELS_REGEX =
  /supportedReasoningEfforts:(?:[A-Za-z$_][A-Za-z0-9$_]*\?\["off","low","medium","high"\]:\["none"\]|1\?\["high","max","xhigh","none"\]:\["high"\]),defaultReasoningEffort:([A-Za-z$_][A-Za-z0-9$_]*)\.reasoningEffort\?\?"(?:none|high)"/g;
const REASONING_EFFORT_CUSTOM_MODELS_PATCHED_REGEX =
  /supportedReasoningEfforts:1\?\["high","medium","xhigh","max"\]:\["xx"\],defaultReasoningEffort:[A-Za-z$_][A-Za-z0-9$_]*\.reasoningEffort\?\?"high"/g;
const REASONING_EFFORT_CUSTOM_MODELS_HELPER_REGEX =
  /function ([A-Za-z$_][A-Za-z0-9$_]*)\(([A-Za-z$_][A-Za-z0-9$_]*),([A-Za-z$_][A-Za-z0-9$_]*)\)\{(?:if\(!\(\2!==void 0&&\2!=="none"\)\)return\["none"\];let ([A-Za-z$_][A-Za-z0-9$_]*)=\3\?([A-Za-z$_][A-Za-z0-9$_]*)\(\3\):void 0;if\(\4\)return \4;return\[\.\.\.([A-Za-z$_][A-Za-z0-9$_]*)\]|let ([A-Za-z$_][A-Za-z0-9$_]*)=\3\?([A-Za-z$_][A-Za-z0-9$_]*)\(\3\):void 0;if\(\7\)return \7\.supportedReasoningEfforts;if\(!\(\2!==void 0&&\2!=="none"\)\)return\["none"\];return [A-Za-z$_][A-Za-z0-9$_]*\([A-Za-z$_][A-Za-z0-9$_]*,\2\))\}/g;
const REASONING_EFFORT_CUSTOM_MODELS_HELPER_PATCHED_REGEX =
  /function [A-Za-z$_][A-Za-z0-9$_]*\([A-Za-z$_][A-Za-z0-9$_]*,[A-Za-z$_][A-Za-z0-9$_]*\)\{return\["high","medium","xhigh","max"\]\}\s*/g;
const REASONING_EFFORT_DEFAULT_FROM_CONFIG_REGEX =
  /defaultReasoningEffort:([A-Za-z$_][A-Za-z0-9$_]*)\.reasoningEffort\?\?"none"/g;
const REASONING_EFFORT_DEFAULT_FROM_CONFIG_PATCHED_REGEX =
  /defaultReasoningEffort:([A-Za-z$_][A-Za-z0-9$_]*)\.reasoningEffort\?\?"high"/g;

type TextPatchMatch = ReturnType<NonNullable<Patch["semanticMatcher"]>>[number];

interface AsyncFunctionBounds {
  start: number;
  end: number;
  name: string;
  params: string;
  source: string;
}

function findMatchingDelimiter(
  source: string,
  openIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let i = openIndex; i < source.length; i++) {
    const char = source[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function findEnclosingAsyncFunction(
  content: string,
  anchorIndex: number,
): AsyncFunctionBounds | null {
  let searchIndex = anchorIndex;
  const headerRegex = new RegExp(`^async function\\s+(${JS_IDENTIFIER})\\s*\\(([^)]*)\\)\\s*\\{`);

  while (searchIndex >= 0) {
    const functionStart = content.lastIndexOf("async function", searchIndex);
    if (functionStart === -1) {
      return null;
    }

    const header = headerRegex.exec(content.slice(functionStart, functionStart + 160));
    if (header) {
      const openBraceIndex = functionStart + header[0].length - 1;
      const end = findMatchingDelimiter(content, openBraceIndex, "{", "}");
      if (end >= anchorIndex) {
        return {
          start: functionStart,
          end: end + 1,
          name: header[1],
          params: header[2],
          source: content.slice(functionStart, end + 1),
        };
      }
    }

    searchIndex = functionStart - 1;
  }

  return null;
}

function pickLocalIdentifier(avoid: string[]): string {
  for (const candidate of ["R", "A", "L", "T", "r", "a", "l", "t", "_", "$"]) {
    if (!avoid.includes(candidate)) {
      return candidate;
    }
  }
  return "$$";
}

function createFactorydSkipLoginAuthReplacement(
  functionSource: string,
  functionName: string,
  params: string,
  tokenParam: string,
): string | null {
  const apiBaseMatch =
    /(?:let|var|const)\s+[A-Za-z$_][A-Za-z0-9$_]*=([^,;{}]+\.apiBaseUrl)/.exec(functionSource) ??
    /\$\{([^}`]+\.apiBaseUrl)\}\/api\/cli\/whoami/.exec(functionSource);
  const parseMatch = new RegExp(
    `(${JS_IDENTIFIER})\\((?:await\\s+)?${JS_IDENTIFIER}(?:\\.text\\(\\))?,(${JS_IDENTIFIER}),"whoami response"\\)`,
  ).exec(functionSource);
  const errorMatch = new RegExp(`new (${JS_IDENTIFIER})\\("API key verification failed"`).exec(
    functionSource,
  );

  if (!apiBaseMatch || !parseMatch) {
    return null;
  }

  const apiBaseExpression = apiBaseMatch[1];
  const parseFunction = parseMatch[1];
  const responseSchema = parseMatch[2];
  const errorConstructor = errorMatch?.[1] ?? "Error";
  if (!apiBaseExpression || /[`{}]/.test(apiBaseExpression)) {
    return null;
  }

  const responseVar = pickLocalIdentifier([
    functionName,
    tokenParam,
    ...params.split(",").map((param) => param.trim()),
    parseFunction,
    responseSchema,
    errorConstructor,
  ]);
  const throwExpression =
    errorConstructor === "Error"
      ? `Error("API key verification failed")`
      : `new ${errorConstructor}("API key verification failed")`;
  const replacement =
    `async function ${functionName}(${params}){` +
    `if(/^fk/.test(${tokenParam}))return{userId:"f",orgId:"f"};` +
    `let ${responseVar}=await fetch(\`${"${"}${apiBaseExpression}}/api/cli/whoami\`,` +
    `{headers:{Authorization:\`Bearer ${"${"}${tokenParam}}\`}});` +
    `if(!${responseVar}.ok)throw ${throwExpression};` +
    `${responseVar}=${parseFunction}(await ${responseVar}.text(),${responseSchema},"whoami response");` +
    `return{userId:${responseVar}.userId,email:"",orgId:${responseVar}.orgId}}`;

  if (Buffer.byteLength(replacement, "utf-8") > Buffer.byteLength(functionSource, "utf-8")) {
    throw new Error("factoryd skip-login auth semantic replacement is longer than matched helper");
  }

  return replacement;
}

function createFactorydSkipLoginAuthSemanticMatches(content: string): TextPatchMatch[] {
  const matches: TextPatchMatch[] = [];
  const seenFunctions = new Set<number>();
  let searchIndex = 0;

  while (true) {
    const whoamiIndex = content.indexOf("/api/cli/whoami", searchIndex);
    if (whoamiIndex === -1) {
      break;
    }
    searchIndex = whoamiIndex + 1;

    const fn = findEnclosingAsyncFunction(content, whoamiIndex);
    if (!fn || seenFunctions.has(fn.start)) {
      continue;
    }
    seenFunctions.add(fn.start);

    if (
      fn.source.includes("if(/^fk/.test(") ||
      !fn.source.includes('"API key verification failed"') ||
      !fn.source.includes('"whoami response"') ||
      !fn.source.includes("return{userId:")
    ) {
      continue;
    }

    const tokenParam = /Authorization:`Bearer \$\{([A-Za-z$_][A-Za-z0-9$_]*)\}`/.exec(
      fn.source,
    )?.[1];
    if (
      !tokenParam ||
      !fn.params
        .split(",")
        .map((param) => param.trim())
        .includes(tokenParam)
    ) {
      continue;
    }

    const replacement = createFactorydSkipLoginAuthReplacement(
      fn.source,
      fn.name,
      fn.params,
      tokenParam,
    );
    if (!replacement) {
      continue;
    }

    matches.push({
      charIndex: fn.start,
      match: fn.source,
      replacement,
    });
  }

  return matches;
}

function createMissionWorkerStayAliveSemanticMatches(content: string): TextPatchMatch[] {
  const matches: TextPatchMatch[] = [];
  const seenConditions = new Set<string>();

  for (const anchor of MISSION_WORKER_EXIT_ANCHORS) {
    let searchIndex = 0;
    while (true) {
      const anchorIndex = content.indexOf(anchor, searchIndex);
      if (anchorIndex === -1) {
        break;
      }
      searchIndex = anchorIndex + anchor.length;

      const searchStart = Math.max(0, anchorIndex - 1000);
      let ifIndex = content.lastIndexOf("if(", anchorIndex);
      while (ifIndex >= searchStart) {
        const conditionStart = ifIndex + "if(".length;
        const conditionEnd = findMatchingDelimiter(content, ifIndex + 2, "(", ")");
        if (conditionEnd !== -1 && conditionEnd < anchorIndex) {
          const key = `${conditionStart}:${conditionEnd}`;
          const condition = content.slice(conditionStart, conditionEnd);
          if (condition.trim() !== "0" && !seenConditions.has(key)) {
            seenConditions.add(key);
            matches.push({
              charIndex: conditionStart,
              match: condition,
              replacement: "0",
            });
          }
          break;
        }
        ifIndex = content.lastIndexOf("if(", ifIndex - 1);
      }
    }
  }

  return matches;
}

function createFactorydSelfPathPatch(): Patch {
  return {
    name: "factorydSelfPath",
    description:
      "Force factoryd auto-start to reuse the current executable instead of falling back to plain droid",
    pattern: Buffer.from(""),
    replacement: Buffer.from(""),
    regexPattern: FACTORYD_SELF_PATH_REGEX,
    regexReplacement: 'if((1||$1.basename(process.execPath).includes("")))',
    alreadyPatchedRegexPattern: FACTORYD_SELF_PATH_PATCHED_REGEX,
    suppressCheckUnlessFound: true,
  };
}

function createFactorydSkipLoginAuthPatch(): Patch {
  return {
    name: "factorydSkipLoginAuth",
    description:
      "Allow mission/factoryd auth to reuse fk- API key sessions via the shared /api/cli/whoami helper",
    pattern: Buffer.from(""),
    replacement: Buffer.from(""),
    semanticMatcher: createFactorydSkipLoginAuthSemanticMatches,
    alreadyPatchedRegexPattern: FACTORYD_SKIP_LOGIN_AUTH_PATCHED_REGEX,
  };
}

function createSkipLoginApiKeyPrioritySemanticMatches(content: string): TextPatchMatch[] {
  const matches: TextPatchMatch[] = [];
  const fnRegex =
    /async function ([A-Za-z$_][A-Za-z0-9$_]*)\(([A-Za-z$_][A-Za-z0-9$_]*)\)\{(?:(if\(\2\.airgapEnabled\)return [A-Za-z$_][A-Za-z0-9$_]*;))?let ([A-Za-z$_][A-Za-z0-9$_]*)=await ([A-Za-z$_][A-Za-z0-9$_]*)\(\{disableKeyring:\2\.disableKeyring\}\)\.load\(\);if\(\4\)return\{type:"workos",token:\4\.access_token\};let ([A-Za-z$_][A-Za-z0-9$_]*)=\2\.apiKey\?\.trim\(\);if\(\6\)return\{type:"api-key",token:\6\};return [A-Za-z$_][A-Za-z0-9$_]*\("[^"]*"\),null\}/g;
  let m;
  while ((m = fnRegex.exec(content)) !== null) {
    const [fullMatch, fnName, param, airgapGuard, keyringVar, cgFn, apiKeyVar] = m;
    const airgapPrefix = airgapGuard ? airgapGuard : "";
    const replacement =
      `async function ${fnName}(${param}){` +
      airgapPrefix +
      `let ${apiKeyVar}=${param}.apiKey?.trim();` +
      `if(${apiKeyVar}&&/^fk/.test(${apiKeyVar}))return{type:"api-key",token:${apiKeyVar}};` +
      `let ${keyringVar}=await ${cgFn}({disableKeyring:${param}.disableKeyring}).load();` +
      `if(${keyringVar})return{type:"workos",token:${keyringVar}.access_token};` +
      `if(${apiKeyVar})return{type:"api-key",token:${apiKeyVar}};return null}`;
    if (Buffer.byteLength(replacement, "utf-8") > Buffer.byteLength(fullMatch, "utf-8")) {
      continue;
    }
    matches.push({ charIndex: m.index, match: fullMatch, replacement });
  }
  return matches;
}

function createSkipLoginApiKeyPriorityPatch(): Patch {
  return {
    name: "skipLoginApiKeyPriority",
    description:
      "Prioritize fk- API key over stored keyring/file credentials to bypass stale WorkOS tokens",
    pattern: Buffer.from(""),
    replacement: Buffer.from(""),
    semanticMatcher: createSkipLoginApiKeyPrioritySemanticMatches,
    alreadyPatchedRegexPattern: SKIP_LOGIN_APIKEY_PRIORITY_PATCHED_REGEX,
  };
}

function createMissionWorkerStayAlivePatch(): Patch {
  return {
    name: "missionWorkerStayAlive",
    description:
      "Disable worker auto-exit after a completed turn so mission workers are not treated as crashed",
    pattern: Buffer.from(""),
    replacement: Buffer.from(""),
    semanticMatcher: createMissionWorkerStayAliveSemanticMatches,
    alreadyPatchedRegexPattern: MISSION_WORKER_EXIT_PATCHED_REGEX,
  };
}

type BinaryPatchConfig = {
  isCustom: boolean;
  skipLogin: boolean;
  apiBase: string | null | undefined;
  websearch: boolean;
  websearchProxy?: boolean;
  reasoningEffort: boolean;
  noTelemetry?: boolean;
};

function needsBinaryPatches(config: BinaryPatchConfig): boolean {
  return (
    config.isCustom ||
    config.skipLogin ||
    config.reasoningEffort ||
    !!config.noTelemetry ||
    (!!config.apiBase && !config.websearch && !config.websearchProxy)
  );
}

function createMissionFactorydPatches(config: Pick<BinaryPatchConfig, "skipLogin">): Patch[] {
  const patches = [createFactorydSelfPathPatch(), createMissionWorkerStayAlivePatch()];
  if (config.skipLogin) {
    patches.push(createFactorydSkipLoginAuthPatch());
    patches.push(createSkipLoginApiKeyPriorityPatch());
  }
  return patches;
}

function requiresRuntimeProxy(config: Pick<BinaryPatchConfig, "isCustom" | "skipLogin">): boolean {
  return config.isCustom || config.skipLogin;
}

function appendIsCustomPatches(patches: Patch[], droidPath: string | undefined): void {
  patches.push({
    name: "isCustom",
    description: "Change isCustom:!0 to isCustom:!1",
    pattern: Buffer.from("isCustom:!0"),
    replacement: Buffer.from("isCustom:!1"),
  });

  const inlineModelPickerPatch = resolveInlineModelPickerPatch(droidPath);
  if (inlineModelPickerPatch) {
    patches.push(inlineModelPickerPatch);
  }
}

function createReasoningEffortCustomModelsReplacement(match: string): string {
  const modelConfigVar =
    /defaultReasoningEffort:([A-Za-z$_][A-Za-z0-9$_]*)\.reasoningEffort\?\?/.exec(match)?.[1];
  if (!modelConfigVar) {
    throw new Error("Unable to identify custom model config variable for reasoning effort patch");
  }

  const replacement =
    `supportedReasoningEfforts:1?["high","medium","xhigh","max"]:["xx"],` +
    `defaultReasoningEffort:${modelConfigVar}.reasoningEffort??"high"`;
  if (Buffer.byteLength(replacement, "utf-8") !== Buffer.byteLength(match, "utf-8")) {
    throw new Error("reasoning effort replacement must exactly match custom model config length");
  }
  return replacement;
}

function createReasoningEffortCustomModelsHelperReplacement(match: string): string {
  const helperMatch =
    /function ([A-Za-z$_][A-Za-z0-9$_]*)\(([A-Za-z$_][A-Za-z0-9$_]*),([A-Za-z$_][A-Za-z0-9$_]*)\)\{/.exec(
      match,
    );
  const functionName = helperMatch?.[1];
  const reasoningVar = helperMatch?.[2];
  const modelVar = helperMatch?.[3];
  if (!functionName || !reasoningVar || !modelVar) {
    throw new Error("Unable to identify custom model reasoning helper signature");
  }

  const replacement = `function ${functionName}(${reasoningVar},${modelVar}){return["high","medium","xhigh","max"]}`;
  if (Buffer.byteLength(replacement, "utf-8") > Buffer.byteLength(match, "utf-8")) {
    throw new Error("reasoning effort helper replacement is longer than matched helper");
  }
  return replacement.padEnd(Buffer.byteLength(match, "utf-8"), " ");
}

function createReasoningEffortPatches(): Patch[] {
  return [
    {
      name: "reasoningEffortSupportedCustomModels",
      description: 'Enable ["high","medium","xhigh","max"] in UI for custom model reasoning effort',
      pattern: Buffer.from(""),
      replacement: Buffer.from(""),
      regexPattern: REASONING_EFFORT_CUSTOM_MODELS_REGEX,
      regexReplacement: createReasoningEffortCustomModelsReplacement,
      alreadyPatchedRegexPattern: REASONING_EFFORT_CUSTOM_MODELS_PATCHED_REGEX,
      suppressCheckUnlessFound: true,
    },
    {
      name: "reasoningEffortSupportedCustomModelsHelper",
      description: 'Enable ["high","medium","xhigh","max"] in UI for custom model reasoning helper',
      pattern: Buffer.from(""),
      replacement: Buffer.from(""),
      regexPattern: REASONING_EFFORT_CUSTOM_MODELS_HELPER_REGEX,
      regexReplacement: createReasoningEffortCustomModelsHelperReplacement,
      alreadyPatchedRegexPattern: REASONING_EFFORT_CUSTOM_MODELS_HELPER_PATCHED_REGEX,
      suppressCheckUnlessFound: true,
    },
    {
      name: "reasoningEffortDefaultFromConfig",
      description: 'Change defaultReasoningEffort:<var>.reasoningEffort??"none" to "high"',
      pattern: Buffer.from(""),
      replacement: Buffer.from(""),
      regexPattern: REASONING_EFFORT_DEFAULT_FROM_CONFIG_REGEX,
      regexReplacement: 'defaultReasoningEffort:$1.reasoningEffort??"high"',
      alreadyPatchedRegexPattern: REASONING_EFFORT_DEFAULT_FROM_CONFIG_PATCHED_REGEX,
      suppressCheckUnlessFound: true,
    },
    {
      name: "reasoningEffortSupported",
      description:
        'Fallback: Change supportedReasoningEfforts:["none"] to ["high"] (for legacy/custom: configs)',
      pattern: Buffer.from('supportedReasoningEfforts:["none"]'),
      replacement: Buffer.from('supportedReasoningEfforts:["high"]'),
    },
    {
      name: "reasoningEffortDefault",
      description: 'Fallback: Change defaultReasoningEffort:"none" to "high"',
      pattern: Buffer.from('defaultReasoningEffort:"none"'),
      replacement: Buffer.from('defaultReasoningEffort:"high"'),
    },
    {
      name: "reasoningEffortUIShow",
      description: "Change supportedReasoningEfforts.length>1 to length>0",
      pattern: Buffer.from("supportedReasoningEfforts.length>1"),
      replacement: Buffer.from("supportedReasoningEfforts.length>0"),
    },
    {
      name: "reasoningEffortUIEnable",
      description: "Change supportedReasoningEfforts.length<=1 to length<=0",
      pattern: Buffer.from("supportedReasoningEfforts.length<=1"),
      replacement: Buffer.from("supportedReasoningEfforts.length<=0"),
    },
    {
      name: "reasoningEffortValidationBypass",
      description: "Bypass reasoning effort validation (allows non-default settings.json values)",
      pattern: Buffer.from(""),
      replacement: Buffer.from(""),
      regexPattern:
        /([A-Za-z$_])!=="none"&&\1!=="off"&&!([A-Za-z$_])\.(supportedReasoningEfforts|reasoningEffort\.supported)\.includes\(\1\)/g,
      regexReplacement: '$1!="none"&&$1!="off"&&0&&$2.$3.includes($1)',
      alreadyPatchedRegexPattern:
        /([A-Za-z$_])!="none"&&\1!="off"&&0&&([A-Za-z$_])\.(supportedReasoningEfforts|reasoningEffort\.supported)\.includes\(\1\)/g,
    },
  ];
}

function findDefaultDroidPath(): string {
  const home = homedir();

  // Windows: use `where` command instead of `which`
  if (IS_WINDOWS) {
    try {
      const result = execSync("where droid", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      // `where` may return multiple lines, take the first one
      const firstResult = result.split(/\r?\n/)[0];
      if (firstResult && existsSync(firstResult)) {
        return firstResult;
      }
    } catch {
      // where command failed, continue with fallback paths
    }

    // Windows common installation paths
    const windowsPaths = [
      // Default install location
      join(home, ".droid", "bin", "droid.exe"),
      // AppData local
      join(home, "AppData", "Local", "Programs", "droid", "droid.exe"),
      // Scoop
      join(home, "scoop", "apps", "droid", "current", "droid.exe"),
      // Current directory
      "./droid.exe",
    ];

    for (const p of windowsPaths) {
      if (existsSync(p)) return p;
    }

    // Return default path even if not found (will error later with helpful message)
    return join(home, ".droid", "bin", "droid.exe");
  }

  // Unix: Try PATH lookups first.
  for (const lookupCommand of ["command -v droid", "which droid"]) {
    try {
      const result = execSync(lookupCommand, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const firstResult = result.split(/\r?\n/)[0];
      if (firstResult && existsSync(firstResult)) {
        return firstResult;
      }
    } catch {
      // Continue to the next lookup strategy.
    }
  }

  // Common installation paths (Unix)
  const paths = [
    // Default sh install location
    join(home, ".droid", "bin", "droid"),
    // Common user-local install location
    join(home, ".local", "bin", "droid"),
    // Homebrew on Apple Silicon
    "/opt/homebrew/bin/droid",
    // Homebrew on Intel Mac / Linux
    "/usr/local/bin/droid",
    // Linux system-wide
    "/usr/bin/droid",
    // Current directory
    "./droid",
  ];

  for (const p of paths) {
    if (existsSync(p)) return p;
  }

  // Return default path even if not found (will error later with helpful message)
  return join(home, ".droid", "bin", "droid");
}

bin("droid-patch", "CLI tool to patch droid binary with various modifications")
  .option(
    "--is-custom",
    "Patch isCustom:!0 to isCustom:!1 (enable context compression for custom models)",
  )
  .option(
    "--skip-login",
    "Inject a fake FACTORY_API_KEY to bypass login requirement (no real key needed)",
  )
  .option(
    "--api-base <url>",
    "Replace API URL (standalone: binary patch, max 22 chars; with --websearch: proxy forward target, no limit)",
  )
  .option(
    "--websearch",
    "Enable local WebSearch proxy with external providers (Smithery, Google PSE, etc.)",
  )
  .option(
    "--websearch-proxy",
    "Enable native provider websearch (requires proxy plugin, reads ~/.factory/settings.json)",
  )
  .option("--standalone", "Standalone mode: mock non-LLM Factory APIs (use with --websearch)")
  .option(
    "--reasoning-effort",
    'Enable reasoning effort for custom models (default high; UI options: "medium","high","xhigh","max")',
  )
  .option(
    "--disable-telemetry",
    "Disable telemetry and Sentry error reporting (block data uploads)",
  )
  .option("--dry-run", "Verify patches without actually modifying the binary")
  .option("-p, --path <path>", "Path to the droid binary")
  .option("-o, --output <dir>", "Output directory for patched binary")
  .option("--no-backup", "Do not create backup of original binary")
  .option("-v, --verbose", "Enable verbose output")
  .argument("[alias]", "Alias name for the patched binary")
  .action(async (options, args) => {
    const alias = args?.[0] as string | undefined;
    const isCustom = !!options.isCustom;
    const skipLogin = !!options.skipLogin;
    const apiBase = options.apiBase;
    const websearch = !!options.websearch;
    const websearchProxy = !!options.websearchProxy;
    const standalone = !!options.standalone;
    // When --websearch is used with --api-base, forward to custom URL
    // Otherwise forward to official Factory API
    const websearchTarget = websearch ? apiBase || "https://api.factory.ai" : undefined;
    const reasoningEffort = !!options.reasoningEffort;
    const noTelemetry = !!options.disableTelemetry;
    const dryRun = !!options.dryRun;
    const path = options.path || findDefaultDroidPath();
    const outputDir = options.output;
    const backup = options.backup !== false;
    const verbose = options.verbose as boolean;
    const droidVersion = getDroidVersion(path);

    // If -o is specified with alias, output to that directory with alias name
    const outputPath = outputDir && alias ? join(outputDir, alias) : undefined;

    const needsBinaryPatch = needsBinaryPatches({
      isCustom: !!isCustom,
      skipLogin: !!skipLogin,
      apiBase,
      websearch: !!websearch,
      websearchProxy: !!websearchProxy,
      reasoningEffort: !!reasoningEffort,
      noTelemetry: !!noTelemetry,
    });

    // Check for conflicting flags
    if (websearch && websearchProxy) {
      console.log(styleText("red", "Error: Cannot use --websearch and --websearch-proxy together"));
      console.log(styleText("gray", "Choose one:"));
      console.log(
        styleText("gray", "  --websearch        External providers (Smithery, Google PSE, etc.)"),
      );
      console.log(
        styleText("gray", "  --websearch-proxy  Native provider (requires proxy plugin)"),
      );
      process.exit(1);
    }

    // Wrapper-only mode (no binary patching needed):
    // - --websearch or --websearch-proxy (optional --standalone)
    const isWebsearchMode = websearch || websearchProxy;
    const useRuntimeProxy = isWebsearchMode || requiresRuntimeProxy({ isCustom, skipLogin });
    if (!needsBinaryPatch && isWebsearchMode) {
      if (!alias) {
        const flag = websearchProxy ? "--websearch-proxy" : "--websearch";
        console.log(styleText("red", `Error: Alias name required for ${flag}`));
        console.log(styleText("gray", `Usage: npx droid-patch ${flag} <alias>`));
        process.exit(1);
      }

      console.log(styleText("cyan", "═".repeat(60)));
      console.log(styleText(["cyan", "bold"], "  Droid Wrapper Setup"));
      console.log(styleText("cyan", "═".repeat(60)));
      console.log();
      if (websearchProxy) {
        console.log(styleText("white", `WebSearch: native provider mode`));
        console.log(styleText("gray", `  Requires proxy plugin (anthropic4droid)`));
        console.log(styleText("gray", `  Reads model config from ~/.factory/settings.json`));
      } else if (websearch) {
        console.log(styleText("white", `WebSearch: external providers mode`));
        console.log(styleText("white", `Forward target: ${websearchTarget}`));
      }
      if (standalone) {
        console.log(styleText("white", `Standalone mode: enabled`));
      }
      console.log();

      let execTargetPath = path;
      // Create websearch proxy files (proxy script + wrapper)
      const proxyDir = join(homedir(), ".droid-patch", "proxy");
      // For --websearch-proxy, apiBase comes from settings.json at runtime
      // For --websearch, use apiBase or default Factory API
      const forwardTarget = websearchProxy ? undefined : websearchTarget;
      const { wrapperScript } = await createWebSearchUnifiedFiles(
        proxyDir,
        execTargetPath,
        alias,
        forwardTarget,
        standalone,
        websearchProxy, // useNativeProvider flag
        skipLogin,
        false,
      );
      execTargetPath = wrapperScript;

      // Create alias pointing to outer wrapper
      const aliasResult = await createAliasForWrapper(execTargetPath, alias, verbose);

      // Save metadata for update command
      const metadata = createMetadata(
        alias,
        path,
        {
          isCustom: false,
          skipLogin: false,
          apiBase: apiBase || null,
          websearch: !!websearch,
          websearchProxy: !!websearchProxy,
          reasoningEffort: false,
          noTelemetry: false,
          standalone: standalone,
        },
        {
          droidPatchVersion: version,
          droidVersion,
          aliasPath: aliasResult.aliasPath,
        },
      );
      await saveAliasMetadata(metadata);

      console.log();
      console.log(styleText("green", "═".repeat(60)));
      console.log(styleText(["green", "bold"], "  Wrapper Ready!"));
      console.log(styleText("green", "═".repeat(60)));
      console.log();
      console.log("Run directly:");
      console.log(styleText("yellow", `  ${alias}`));
      console.log();
      if (websearchProxy) {
        console.log(styleText("cyan", "Native Provider WebSearch (--websearch-proxy):"));
        console.log(styleText("gray", "  Uses model's built-in websearch via proxy plugin"));
        console.log(styleText("gray", "  Reads model config from ~/.factory/settings.json"));
        console.log();
        console.log(styleText("yellow", "IMPORTANT: Requires proxy plugin (anthropic4droid)"));
        console.log();
        console.log("Supported providers:");
        console.log(styleText("yellow", "  - anthropic: Claude web_search_20250305 server tool"));
        console.log(styleText("yellow", "  - openai: OpenAI web_search tool"));
        console.log(styleText("gray", "  - generic-chat-completion-api: Not supported"));
        console.log();
        console.log("Debug mode:");
        console.log(styleText("gray", "  export DROID_SEARCH_DEBUG=1    # Basic logs"));
        console.log(styleText("gray", "  export DROID_SEARCH_VERBOSE=1  # Full request/response"));
      } else if (websearch) {
        console.log(styleText("cyan", "External Providers WebSearch (--websearch):"));
        console.log(
          styleText("gray", "  Uses external search providers (Smithery, Google PSE, etc.)"),
        );
        console.log();
        console.log("Search providers (in priority order):");
        console.log(styleText("yellow", "  1. Smithery Exa (best quality):"));
        console.log(styleText("gray", "     export SMITHERY_API_KEY=your_api_key"));
        console.log(styleText("gray", "     export SMITHERY_PROFILE=your_profile"));
        console.log(styleText("gray", "  2. Google PSE:"));
        console.log(styleText("gray", "     export GOOGLE_PSE_API_KEY=your_api_key"));
        console.log(styleText("gray", "     export GOOGLE_PSE_CX=your_search_engine_id"));
        console.log(styleText("gray", "  3. Tavily:"));
        console.log(styleText("gray", "     export TAVILY_API_KEY=your_api_key"));
        console.log(styleText("gray", "  4-7. Serper, Brave, SearXNG, DuckDuckGo (fallbacks)"));
        console.log();
        console.log("Debug mode:");
        console.log(styleText("gray", "  export DROID_SEARCH_DEBUG=1"));
      }
      return;
    }

    if (!isCustom && !skipLogin && !apiBase && !websearch && !reasoningEffort && !noTelemetry) {
      console.log(styleText("yellow", "No patch flags specified. Available patches:"));
      console.log(styleText("gray", "  --is-custom         Patch isCustom for custom models"));
      console.log(
        styleText("gray", "  --skip-login        Bypass login by injecting a fake API key"),
      );
      console.log(
        styleText(
          "gray",
          "  --api-base          Replace API URL (standalone: max 22 chars; with --websearch: no limit)",
        ),
      );
      console.log(styleText("gray", "  --websearch         Enable local WebSearch proxy"));
      console.log(
        styleText("gray", "  --reasoning-effort  Set reasoning effort level for custom models"),
      );
      console.log(
        styleText("gray", "  --disable-telemetry Disable telemetry and Sentry error reporting"),
      );
      console.log(
        styleText("gray", "  --standalone        Standalone mode: mock non-LLM Factory APIs"),
      );
      console.log();
      console.log("Usage examples:");
      console.log(styleText("cyan", "  npx droid-patch --is-custom droid-custom"));
      console.log(styleText("cyan", "  npx droid-patch --skip-login droid-nologin"));
      console.log(styleText("cyan", "  npx droid-patch --is-custom --skip-login droid-patched"));
      console.log(styleText("cyan", "  npx droid-patch --websearch droid-search"));
      console.log(styleText("cyan", "  npx droid-patch --websearch --standalone droid-local"));
      console.log(styleText("cyan", "  npx droid-patch --disable-telemetry droid-private"));
      console.log(
        styleText(
          "cyan",
          "  npx droid-patch --websearch --api-base=http://127.0.0.1:20002 my-droid",
        ),
      );
      process.exit(1);
    }

    if (!alias && !dryRun) {
      console.log(styleText("red", "Error: alias name is required"));
      console.log(
        styleText(
          "gray",
          "Usage: droid-patch [--is-custom] [--skip-login] [-o <dir>] <alias-name>",
        ),
      );
      process.exit(1);
    }

    console.log(styleText("cyan", "═".repeat(60)));
    console.log(styleText(["cyan", "bold"], "  Droid Binary Patcher"));
    console.log(styleText("cyan", "═".repeat(60)));
    console.log();

    const patches: Patch[] = createMissionFactorydPatches({ skipLogin });
    if (isCustom) {
      appendIsCustomPatches(patches, path);
    }

    // Add skip-login patch: replace process.env.FACTORY_API_KEY with a fixed fake key
    // "process.env.FACTORY_API_KEY" is 27 chars, we replace with "fk-droid-patch-skip-00000" (25 chars + quotes = 27)
    if (skipLogin) {
      try {
        patches.push(
          ...resolveVersionedPatches("--skip-login", droidVersion, SKIP_LOGIN_PATCH_RULES, path),
        );
      } catch (error) {
        console.log(styleText("red", `Error: ${(error as Error).message}`));
        if (!droidVersion) {
          console.log(styleText("gray", "Please use -p to point to a runnable droid binary."));
        }
        process.exit(1);
      }
    }

    // Add api-base patch: replace the Factory API base URL
    // Original: "https://api.factory.ai" (22 chars)
    // We need to pad the replacement URL to be exactly 22 chars
    // Note: When --websearch is used, --api-base sets the forward target instead of binary patching
    if (apiBase && !websearch) {
      const originalUrl = "https://api.factory.ai";
      const originalLength = originalUrl.length; // 22 chars

      // Validate and normalize the URL
      const normalizedUrl = apiBase.replace(/\/+$/, ""); // Remove trailing slashes

      if (normalizedUrl.length > originalLength) {
        console.log(
          styleText("red", `Error: API base URL must be ${originalLength} characters or less`),
        );
        console.log(
          styleText("gray", `  Your URL: "${normalizedUrl}" (${normalizedUrl.length} chars)`),
        );
        console.log(styleText("gray", `  Maximum:  ${originalLength} characters`));
        console.log();
        console.log(styleText("yellow", "Tip: Use a shorter URL or set up a local redirect."));
        console.log(styleText("gray", "  Examples:"));
        console.log(styleText("gray", "    http://127.0.0.1:3000 (19 chars)"));
        console.log(styleText("gray", "    http://localhost:80  (19 chars)"));
        process.exit(1);
      }

      // Pad the URL with spaces at the end to match original length
      // Note: trailing spaces in URL are generally ignored
      const paddedUrl = normalizedUrl.padEnd(originalLength, " ");

      patches.push({
        name: "apiBase",
        description: `Replace Factory API URL with "${normalizedUrl}"`,
        pattern: Buffer.from(originalUrl),
        replacement: Buffer.from(paddedUrl),
      });
    }

    if (reasoningEffort) {
      patches.push(...createReasoningEffortPatches());
    }

    // Add no-telemetry patches: disable telemetry uploads and Sentry error reporting
    // Strategy:
    // 1. Break environment variable names so Sentry is never initialized (Q1() returns false)
    // 2. Invert flushToWeb condition so it returns early without making any fetch request
    if (noTelemetry) {
      // Patch 1: Break Sentry environment variable checks
      // Q1() function checks: VITE_VERCEL_ENV, ENABLE_SENTRY, NEXT_PUBLIC_ENABLE_SENTRY, FACTORY_ENABLE_SENTRY
      // By changing first letter to X, the env vars will never match, so Q1() returns false
      // and Sentry is never initialized
      patches.push({
        name: "noTelemetrySentryEnv1",
        description: "Break ENABLE_SENTRY env var check (E->X)",
        pattern: Buffer.from("ENABLE_SENTRY"),
        replacement: Buffer.from("XNABLE_SENTRY"),
      });

      patches.push({
        name: "noTelemetrySentryEnv2",
        description: "Break VITE_VERCEL_ENV env var check (V->X)",
        pattern: Buffer.from("VITE_VERCEL_ENV"),
        replacement: Buffer.from("XITE_VERCEL_ENV"),
      });

      // Patch 2: Make flushToWeb always return early to prevent ANY fetch request
      // Original: if(this.webEvents.length===0)return; // returns only when empty
      // Changed:  if(!0||this.webEvents.length)return; // !0=true, ALWAYS returns
      // Result: Function always exits immediately, no telemetry is ever sent
      patches.push({
        name: "noTelemetryFlushBlock",
        description: "Make flushToWeb always return (!0|| = always true)",
        pattern: Buffer.from("this.webEvents.length===0"),
        replacement: Buffer.from("!0||this.webEvents.length"),
      });
    }

    try {
      const result = await patchDroid({
        inputPath: path,
        outputPath: outputPath,
        patches,
        dryRun,
        backup,
        verbose,
      });

      if (dryRun) {
        console.log();
        console.log(styleText("blue", "═".repeat(60)));
        console.log(styleText(["blue", "bold"], "  DRY RUN COMPLETE"));
        console.log(styleText("blue", "═".repeat(60)));
        console.log();
        console.log(
          styleText("gray", "To apply the patches, rerun the same command without --dry-run."),
        );
        process.exit(0);
      }

      // If -o is specified, just output the file without creating alias
      if (outputDir && result.success && result.outputPath) {
        console.log();
        console.log(styleText("green", "═".repeat(60)));
        console.log(styleText(["green", "bold"], "  PATCH SUCCESSFUL"));
        console.log(styleText("green", "═".repeat(60)));
        console.log();
        console.log(styleText("white", `Patched binary saved to: ${result.outputPath}`));
        process.exit(0);
      }

      if (result.success && result.outputPath && alias) {
        console.log();

        let execTargetPath = result.outputPath;

        if (useRuntimeProxy) {
          const proxyDir = join(homedir(), ".droid-patch", "proxy");
          const { wrapperScript } = await createWebSearchUnifiedFiles(
            proxyDir,
            execTargetPath,
            alias,
            websearchProxy ? undefined : websearchTarget, // websearchProxy reads from settings.json at runtime
            standalone,
            websearchProxy, // useNativeProvider flag
            skipLogin,
            requiresRuntimeProxy({ isCustom, skipLogin }),
          );
          execTargetPath = wrapperScript;

          console.log();
          if (websearchProxy) {
            console.log(styleText("cyan", "WebSearch enabled (native provider mode)"));
            console.log(styleText("gray", "  Requires proxy plugin (anthropic4droid)"));
            console.log(styleText("gray", "  Reads model config from ~/.factory/settings.json"));
          } else if (websearch) {
            console.log(styleText("cyan", "WebSearch enabled (external providers mode)"));
            console.log(styleText("white", `  Forward target: ${websearchTarget}`));
          } else {
            console.log(
              styleText("cyan", "Runtime proxy enabled for custom/skip-login session support"),
            );
            console.log(
              styleText(
                "gray",
                "  Adds local Factory API compatibility shims needed by custom and mission worker flows",
              ),
            );
          }
          if (standalone) {
            console.log(styleText("white", `  Standalone mode: enabled`));
          }
        }

        let aliasResult;
        if (useRuntimeProxy) {
          aliasResult = await createAliasForWrapper(execTargetPath, alias, verbose);
        } else {
          aliasResult = await createAlias(result.outputPath, alias, verbose);
        }

        // Save metadata for update command
        const metadata = createMetadata(
          alias,
          path,
          {
            isCustom: !!isCustom,
            skipLogin: !!skipLogin,
            apiBase: apiBase || null,
            websearch: !!websearch,
            websearchProxy: !!websearchProxy,
            reasoningEffort: !!reasoningEffort,
            noTelemetry: !!noTelemetry,
            standalone: !!standalone,
          },
          {
            droidPatchVersion: version,
            droidVersion,
            aliasPath: aliasResult.aliasPath,
          },
        );
        await saveAliasMetadata(metadata);
      }

      if (result.success) {
        console.log();
        console.log(styleText("green", "═".repeat(60)));
        console.log(styleText(["green", "bold"], "  PATCH SUCCESSFUL"));
        console.log(styleText("green", "═".repeat(60)));
      }

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(styleText("red", `Error: ${(error as Error).message}`));
      if (verbose) console.error((error as Error).stack);
      process.exit(1);
    }
  })
  .command("list", "List all droid-patch aliases")
  .action(async () => {
    await listAliases();
  })
  .command("remove", "Remove alias(es) by name or filter")
  .argument("[alias-or-path]", "Alias name or file path to remove")
  .option("--patch-version <version>", "Remove aliases created by this droid-patch version")
  .option("--droid-version <version>", "Remove aliases for this droid version")
  .option(
    "--flag <flag>",
    "Remove aliases with this flag (is-custom, skip-login, websearch, api-base, reasoning-effort, disable-telemetry, standalone)",
  )
  .action(async (options, args) => {
    const target = args?.[0] as string | undefined;
    const patchVersion = options.patchVersion;
    const droidVersion = options.droidVersion;
    const flagRaw = options.flag;
    let flag: FilterFlag | undefined;
    if (flagRaw) {
      const allowedFlags: FilterFlag[] = [
        "is-custom",
        "skip-login",
        "websearch",
        "api-base",
        "reasoning-effort",
        "disable-telemetry",
        "standalone",
      ];
      if (!allowedFlags.includes(flagRaw as FilterFlag)) {
        console.error(styleText("red", `Error: Invalid --flag value: ${flagRaw}`));
        console.error(styleText("gray", `Allowed: ${allowedFlags.join(", ")}`));
        process.exit(1);
      }
      flag = flagRaw as FilterFlag;
    }

    // If filter options are provided, use filter mode
    if (patchVersion || droidVersion || flag) {
      await removeAliasesByFilter({
        patchVersion,
        droidVersion,
        flags: flag ? [flag] : undefined,
      });
      return;
    }

    // If no target and no filter, show error
    if (!target) {
      console.error(
        styleText(
          "red",
          "Error: Provide an alias name or use filter options (--patch-version, --droid-version, --flag)",
        ),
      );
      process.exit(1);
    }

    // Check if it's a file path (contains / or .)
    if (target.includes("/") || existsSync(target)) {
      // It's a file path, delete directly
      const { unlink } = await import("node:fs/promises");
      try {
        await unlink(target);
        console.log(styleText("green", `[*] Removed: ${target}`));
      } catch (error) {
        console.error(styleText("red", `Error: ${(error as Error).message}`));
        process.exit(1);
      }
    } else {
      // It's an alias name
      await removeAlias(target);
    }
  })
  .command("version", "Print droid-patch version")
  .action(() => {
    console.log(`droid-patch v${version}`);
  })
  .command("clear", "Remove all droid-patch aliases and related files")
  .action(async () => {
    await clearAllAliases();
  })
  .command("update", "Update aliases with latest droid binary")
  .argument("[alias]", "Specific alias to update (optional, updates all if not specified)")
  .option("--dry-run", "Preview without making changes")
  .option("-p, --path <path>", "Path to new droid binary")
  .option("-v, --verbose", "Enable verbose output")
  .action(async (options, args) => {
    const aliasName = args?.[0] as string | undefined;
    const dryRun = !!options.dryRun;
    const newBinaryPath = options.path || findDefaultDroidPath();
    const verbose = !!options.verbose;

    console.log(styleText("cyan", "═".repeat(60)));
    console.log(styleText(["cyan", "bold"], "  Droid-Patch Update"));
    console.log(styleText("cyan", "═".repeat(60)));
    console.log();

    // Verify the new binary exists
    if (!existsSync(newBinaryPath)) {
      console.log(styleText("red", `Error: Droid binary not found at ${newBinaryPath}`));
      console.log(styleText("gray", "Use -p to specify a different path"));
      process.exit(1);
    }

    // Get aliases to update
    let metaList: Awaited<ReturnType<typeof loadAliasMetadata>>[];
    if (aliasName) {
      const meta = await loadAliasMetadata(aliasName);
      if (!meta) {
        console.log(styleText("red", `Error: No metadata found for alias "${aliasName}"`));
        console.log(
          styleText("gray", "This alias may have been created before update tracking was added."),
        );
        console.log(styleText("gray", "Remove and recreate the alias to enable update support."));
        process.exit(1);
      }
      metaList = [meta];
    } else {
      metaList = await listAllMetadata();
      if (metaList.length === 0) {
        console.log(styleText("yellow", "No aliases with metadata found."));
        console.log(styleText("gray", "Create aliases with droid-patch to enable update support."));
        process.exit(0);
      }
    }

    console.log(styleText("white", `Using droid binary: ${newBinaryPath}`));
    console.log(styleText("white", `Found ${metaList.length} alias(es) to update`));
    const newDroidVersion = getDroidVersion(newBinaryPath);
    if (!newDroidVersion) {
      console.log(
        styleText("yellow", "[!] Warning: Could not detect droid version from the new binary"),
      );
      console.log(styleText("gray", "    skip-login aliases may fail to update"));
    }
    if (dryRun) {
      console.log(styleText("blue", "(DRY RUN - no changes will be made)"));
    }
    console.log();

    let successCount = 0;
    let failCount = 0;
    const aliasesRequiringRestart = new Set<string>();

    for (const meta of metaList) {
      if (!meta) continue;

      console.log(styleText("cyan", `─`.repeat(40)));
      console.log(styleText("white", `Updating: ${styleText(["cyan", "bold"], meta.name)}`));
      console.log(styleText("gray", `  Patches: ${formatPatches(meta.patches)}`));

      if (dryRun) {
        console.log(styleText("blue", `  [DRY RUN] Would re-apply patches`));
        successCount++;
        continue;
      }

      try {
        // Build patch list based on metadata
        const patches: Patch[] = needsBinaryPatches(meta.patches)
          ? createMissionFactorydPatches({ skipLogin: meta.patches.skipLogin })
          : [];

        if (meta.patches.isCustom) {
          appendIsCustomPatches(patches, newBinaryPath);
        }

        if (meta.patches.skipLogin) {
          patches.push(
            ...resolveVersionedPatches(
              "skip-login",
              newDroidVersion,
              SKIP_LOGIN_PATCH_RULES,
              newBinaryPath,
            ),
          );
        }

        // Only apply apiBase binary patch when NOT using websearch
        // When websearch is enabled, apiBase is used as forward target, not binary patch
        if (meta.patches.apiBase && !meta.patches.websearch) {
          const originalUrl = "https://api.factory.ai";
          const paddedUrl = meta.patches.apiBase.padEnd(originalUrl.length, " ");
          patches.push({
            name: "apiBase",
            description: `Replace Factory API URL with "${meta.patches.apiBase}"`,
            pattern: Buffer.from(originalUrl),
            replacement: Buffer.from(paddedUrl),
          });
        }

        if (meta.patches.reasoningEffort) {
          patches.push(...createReasoningEffortPatches());
        }

        if (meta.patches.noTelemetry) {
          patches.push({
            name: "noTelemetrySentryEnv1",
            description: "Break ENABLE_SENTRY env var check (E->X)",
            pattern: Buffer.from("ENABLE_SENTRY"),
            replacement: Buffer.from("XNABLE_SENTRY"),
          });
          patches.push({
            name: "noTelemetrySentryEnv2",
            description: "Break VITE_VERCEL_ENV env var check (V->X)",
            pattern: Buffer.from("VITE_VERCEL_ENV"),
            replacement: Buffer.from("XITE_VERCEL_ENV"),
          });
          patches.push({
            name: "noTelemetryFlushBlock",
            description: "Make flushToWeb always return (!0|| = always true)",
            pattern: Buffer.from("this.webEvents.length===0"),
            replacement: Buffer.from("!0||this.webEvents.length"),
          });
        }

        // Determine output path based on whether this is a websearch alias
        const binsDir = join(homedir(), ".droid-patch", "bins");
        const outputPath = join(binsDir, `${meta.name}-patched`);

        // Apply patches (only if there are binary patches to apply)
        if (patches.length > 0) {
          const result = await patchDroid({
            inputPath: newBinaryPath,
            outputPath,
            patches,
            dryRun: false,
            backup: false,
            verbose,
          });

          if (!result.success) {
            console.log(styleText("red", `  ✗ Failed to apply patches`));
            failCount++;
            continue;
          }

          // Re-sign on macOS
          if (process.platform === "darwin") {
            try {
              const { execSync } = await import("node:child_process");
              execSync(`codesign --force --deep --sign - "${outputPath}"`, {
                stdio: "pipe",
              });
              if (verbose) {
                console.log(styleText("gray", `  Re-signed binary`));
              }
            } catch {
              console.log(styleText("yellow", `  [!] Could not re-sign binary`));
            }
          }
        }

        let execTargetPath = patches.length > 0 ? outputPath : newBinaryPath;

        // If websearch is enabled, regenerate wrapper files
        // Support both new 'websearch' field and old 'proxy' field for backward compatibility
        const hasWebsearch =
          meta.patches.websearch || !!meta.patches.websearchProxy || !!meta.patches.proxy;
        const needsRuntimeProxy = requiresRuntimeProxy({
          isCustom: meta.patches.isCustom,
          skipLogin: meta.patches.skipLogin,
        });
        if (hasWebsearch || needsRuntimeProxy) {
          // Determine forward target: apiBase > proxy (legacy) > default
          const forwardTarget =
            meta.patches.apiBase || meta.patches.proxy || "https://api.factory.ai";
          const proxyDir = join(homedir(), ".droid-patch", "proxy");
          const { wrapperScript } = await createWebSearchUnifiedFiles(
            proxyDir,
            execTargetPath,
            meta.name,
            forwardTarget,
            meta.patches.standalone || false,
            meta.patches.websearchProxy || false,
            meta.patches.skipLogin || false,
            needsRuntimeProxy,
          );
          execTargetPath = wrapperScript;
          if (verbose) {
            console.log(styleText("gray", `  Regenerated websearch wrapper`));
            if (meta.patches.standalone) {
              console.log(styleText("gray", `  Standalone mode: enabled`));
            }
          }
          // Migrate old proxy field to new websearch field
          if (meta.patches.proxy && !meta.patches.websearch) {
            meta.patches.websearch = true;
            meta.patches.apiBase = meta.patches.proxy;
            delete meta.patches.proxy;
          }

          // Existing alias sessions keep using the proxy process that was started
          // when the wrapper launched. Updating files on disk does not hot-reload
          // those already-running proxy instances.
          aliasesRequiringRestart.add(meta.name);
        }

        // If this alias previously used removed features (statusline/sessions), drop legacy flags
        // so the updated alias points directly to the new target wrapper/binary.
        delete (meta.patches as Record<string, unknown>).statusline;
        delete (meta.patches as Record<string, unknown>).sessions;

        // Update symlink - find existing or use stored aliasPath
        const { symlink, unlink, readlink, lstat } = await import("node:fs/promises");
        let aliasPath = meta.aliasPath;

        // If aliasPath not stored (old version), try to find existing symlink
        if (!aliasPath) {
          const commonPathDirs = [
            join(homedir(), ".local/bin"),
            join(homedir(), "bin"),
            join(homedir(), ".bin"),
            "/opt/homebrew/bin",
            "/usr/local/bin",
            join(homedir(), ".droid-patch", "aliases"),
          ];

          for (const dir of commonPathDirs) {
            const possiblePath = join(dir, meta.name);
            if (pathExistsWithLstat(possiblePath)) {
              try {
                const stats = await lstat(possiblePath);
                if (stats.isSymbolicLink()) {
                  const target = await readlink(possiblePath);
                  if (isManagedAliasTarget(target)) {
                    aliasPath = possiblePath;
                    if (verbose) {
                      console.log(styleText("gray", `  Found existing symlink: ${aliasPath}`));
                    }
                    break;
                  }
                }
              } catch {
                // Ignore errors, continue searching
              }
            }
          }
        }

        // Update symlink if we have a path
        if (aliasPath) {
          try {
            if (pathExistsWithLstat(aliasPath)) {
              const currentTarget = await readlink(aliasPath);
              if (currentTarget !== execTargetPath) {
                await unlink(aliasPath);
                await symlink(execTargetPath, aliasPath);
                if (verbose) {
                  console.log(styleText("gray", `  Updated symlink: ${aliasPath}`));
                }
              }
            } else {
              // Symlink doesn't exist, recreate it
              await symlink(execTargetPath, aliasPath);
              if (verbose) {
                console.log(styleText("gray", `  Recreated symlink: ${aliasPath}`));
              }
            }
            // Store aliasPath in metadata for future updates
            meta.aliasPath = aliasPath;
          } catch (symlinkError) {
            console.log(
              styleText(
                "yellow",
                `  [!] Could not update symlink: ${(symlinkError as Error).message}`,
              ),
            );
          }
        }

        // Update metadata
        meta.updatedAt = new Date().toISOString();
        meta.originalBinaryPath = newBinaryPath;
        meta.droidVersion = newDroidVersion;
        meta.droidPatchVersion = version;
        await saveAliasMetadata(meta);

        console.log(styleText("green", `  ✓ Updated successfully`));
        successCount++;
      } catch (error) {
        console.log(styleText("red", `  ✗ Error: ${(error as Error).message}`));
        if (verbose) {
          console.error((error as Error).stack);
        }
        failCount++;
      }
    }

    console.log();
    console.log(styleText("cyan", "═".repeat(60)));
    if (dryRun) {
      console.log(styleText(["blue", "bold"], "  DRY RUN COMPLETE"));
      console.log(styleText("gray", `  Would update ${successCount} alias(es)`));
    } else if (failCount === 0) {
      console.log(styleText(["green", "bold"], "  UPDATE COMPLETE"));
      console.log(styleText("gray", `  Updated ${successCount} alias(es)`));
    } else {
      console.log(styleText(["yellow", "bold"], "  UPDATE FINISHED WITH ERRORS"));
      console.log(styleText("gray", `  Success: ${successCount}, Failed: ${failCount}`));
    }
    console.log(styleText("cyan", "═".repeat(60)));
    if (!dryRun && aliasesRequiringRestart.size > 0) {
      const aliasList = [...aliasesRequiringRestart].join(", ");
      console.log();
      console.log(
        styleText("yellow", `[!] Restart required for active runtime-proxy aliases: ${aliasList}`),
      );
      console.log(
        styleText(
          "gray",
          "    Existing sessions keep the old proxy process until that alias exits.",
        ),
      );
      console.log(
        styleText(
          "gray",
          "    Exit and relaunch those aliases before retesting mission startup or skip-login behavior.",
        ),
      );
    }
  })
  .command("add-model", "Add a custom model to settings.json (interactive if no options)")
  .option("-m, --model <model>", "Model name (e.g., claude-sonnet-4-20250514)")
  .option("-n, --name <name>", "Display name (e.g., 'Opus [proxy]')")
  .option("-u, --url <url>", "Base URL (e.g., http://127.0.0.1:20002/droid)")
  .option("-k, --key <key>", "API key")
  .option(
    "-p, --provider <provider>",
    "Provider: anthropic, openai, or generic-chat-completion-api",
  )
  .option("-i, --index <index>", "Insert at index (auto-assigned if not specified)")
  .action(async (options) => {
    const model = options.model as string | undefined;
    const displayName = options.name as string | undefined;
    const baseUrl = options.url as string | undefined;
    const apiKey = options.key as string | undefined;
    const providerStr = options.provider as string | undefined;
    const indexStr = options.index as string | undefined;

    // If no options provided, enter interactive mode
    if (!model && !displayName && !baseUrl && !apiKey && !providerStr) {
      const index = indexStr ? parseInt(indexStr, 10) : undefined;
      await addModelInteractive(index);
      return;
    }

    // If some but not all options provided, show error with usage
    if (!model || !displayName || !baseUrl || !apiKey || !providerStr) {
      console.log(
        styleText(
          "yellow",
          "Missing required options. Enter interactive mode or provide all options.",
        ),
      );
      console.log();
      console.log(styleText("white", "Interactive mode:"));
      console.log(styleText("cyan", "  npx droid-patch add-model"));
      console.log();
      console.log(styleText("white", "Full command mode:"));
      console.log(styleText("cyan", "  npx droid-patch add-model \\"));
      console.log(styleText("cyan", '    -m "claude-sonnet-4-20250514" \\'));
      console.log(styleText("cyan", '    -n "Opus [proxy]" \\'));
      console.log(styleText("cyan", '    -u "http://127.0.0.1:20002/droid" \\'));
      console.log(styleText("cyan", '    -k "your-api-key" \\'));
      console.log(styleText("cyan", '    -p "anthropic"'));
      console.log();
      console.log(styleText("gray", "Providers: anthropic, openai, generic-chat-completion-api"));
      console.log(styleText("gray", "Optional: -i <index> to insert at specific position"));
      process.exit(1);
    }

    const validProviders: Provider[] = ["anthropic", "openai", "generic-chat-completion-api"];
    if (!validProviders.includes(providerStr as Provider)) {
      console.log(styleText("red", `Error: Invalid provider "${providerStr}"`));
      console.log(styleText("gray", `Valid providers: ${validProviders.join(", ")}`));
      process.exit(1);
    }

    const index = indexStr ? parseInt(indexStr, 10) : undefined;
    if (indexStr && (isNaN(index!) || index! < 0)) {
      console.log(styleText("red", "Error: Index must be a non-negative number"));
      process.exit(1);
    }

    const result = addModel(model, displayName, baseUrl, apiKey, providerStr as Provider, index);

    if (result.success) {
      console.log(styleText("green", `[+] ${result.message}`));
      console.log();
      console.log(styleText("white", "Model details:"));
      console.log(styleText("gray", `  ID: ${result.model.id}`));
      console.log(styleText("gray", `  Display Name: ${result.model.displayName}`));
      console.log(styleText("gray", `  Model: ${result.model.model}`));
      console.log(styleText("gray", `  Provider: ${result.model.provider}`));
      console.log(styleText("gray", `  Base URL: ${result.model.baseUrl}`));
    } else {
      console.log(styleText("red", `Error: ${result.message}`));
      process.exit(1);
    }
  })
  .command("remove-model", "Remove a custom model from settings.json")
  .argument("<identifier>", "Model index, ID, or display name to remove")
  .action((options, args) => {
    const identifier = args?.[0] as string;

    if (!identifier) {
      console.log(styleText("red", "Error: Model identifier required"));
      console.log();
      console.log(styleText("white", "Usage:"));
      console.log(styleText("cyan", "  npx droid-patch remove-model <identifier>"));
      console.log();
      console.log(styleText("gray", "Identifier can be:"));
      console.log(styleText("gray", "  - Index number (e.g., 0, 1, 2)"));
      console.log(styleText("gray", "  - Model ID (e.g., custom:Opus-[proxy]-0)"));
      console.log(styleText("gray", "  - Display name (e.g., 'Opus [proxy]')"));
      console.log();
      console.log(styleText("gray", "Use 'npx droid-patch list-models' to see all models"));
      process.exit(1);
    }

    const result = removeModel(identifier);

    if (result.success && result.removed) {
      console.log(styleText("green", `[+] ${result.message}`));
      console.log();
      console.log(styleText("white", "Removed model details:"));
      console.log(styleText("gray", `  ID: ${result.removed.id}`));
      console.log(styleText("gray", `  Display Name: ${result.removed.displayName}`));
      console.log(styleText("gray", `  Model: ${result.removed.model}`));
      console.log(styleText("gray", `  Provider: ${result.removed.provider}`));

      if (result.updatedModels && result.updatedModels.length > 0) {
        console.log();
        console.log(styleText("yellow", "Updated model IDs (due to index shift):"));
        for (const updated of result.updatedModels) {
          console.log(styleText("gray", `  ${updated.displayName}:`));
          console.log(styleText("gray", `    ${updated.oldId} → ${updated.newId}`));
        }
      }
      console.log();
      console.log(styleText("gray", "Use 'npx droid-patch list-models' to see current state."));
    } else {
      console.log(styleText("red", `Error: ${result.message}`));
      process.exit(1);
    }
  })
  .command("list-models", "List all custom models in settings.json")
  .action(() => {
    printModelsList();
  })
  .run()
  .catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
