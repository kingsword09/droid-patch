import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IS_WINDOWS = platform() === "win32";
const FACTORYD_PATH_SOURCE =
  'function $QH(H){if(path.basename(process.execPath).includes("droid"))return process.execPath;return H?"droid-dev":"droid"}';
const FACTORYD_PATH_REGEX =
  /function ([A-Za-z$_][A-Za-z0-9$_]*)\(([A-Za-z$_][A-Za-z0-9$_]*)\)\{if\(([A-Za-z$_][A-Za-z0-9$_]*)\.basename\(process\.execPath\)\.includes\("droid"\)\)return process\.execPath;return \2\?"droid-dev":"droid"\}/g;
const FACTORYD_SKIP_LOGIN_AUTH_SOURCE =
  'let D=await VX();if(!D||!D.orgId)throw new LT("Daemon not authenticated");let C=await AyH(L);if(!C.orgId)throw new LT("Client not affiliated with an organization");if(SH("Client credential verified"),C.userId!==D.userId||C.orgId!==D.orgId)throw new LT("Client identity does not match daemon identity");';
const FACTORYD_SKIP_LOGIN_AUTH_REGEX =
  /let ([A-Za-z$_][A-Za-z0-9$_]*)=await VX\(\);if\(!\1\|\|!\1\.orgId\)throw new LT\("Daemon not authenticated"\);let ([A-Za-z$_][A-Za-z0-9$_]*)=await AyH\(([A-Za-z$_][A-Za-z0-9$_]*)\);if\(!\2\.orgId\)throw new LT\("Client not affiliated with an organization"\);if\(SH\("Client credential verified"\),\2\.userId!==\1\.userId\|\|\2\.orgId!==\1\.orgId\)throw new LT\("Client identity does not match daemon identity"\);/g;
const SKIP_LOGIN_V068_SOURCE = "process.env[LongerName.FACTORY_API_KEY]?.trim()";

async function runCliDryRunWithFactorydPatch(binaryMarker) {
  const dir = await mkdtemp(join(tmpdir(), "droid-patch-cli-"));
  const fakeDroidPath = join(dir, IS_WINDOWS ? "droid.cmd" : "droid");
  const cliPath = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  const script = IS_WINDOWS
    ? `@echo off
if "%~1"=="--version" (
  echo 0.90.0
  exit /b 0
)
echo noop
rem ${binaryMarker}
`
    : `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '0.90.0\\n'
  exit 0
fi
printf 'noop\\n'
# ${binaryMarker}
`;

  await writeFile(fakeDroidPath, script, "utf8");
  if (!IS_WINDOWS) {
    await chmod(fakeDroidPath, 0o755);
  }

  return execFileAsync(
    process.execPath,
    [cliPath, "--is-custom", "-p", fakeDroidPath, "--dry-run", "droid-test"],
    { cwd: join(fileURLToPath(new URL("..", import.meta.url))) },
  );
}

async function runCliDryRunWithSkipLogin(binaryMarker) {
  const dir = await mkdtemp(join(tmpdir(), "droid-patch-cli-"));
  const fakeDroidPath = join(dir, IS_WINDOWS ? "droid.cmd" : "droid");
  const cliPath = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  const script = IS_WINDOWS
    ? `@echo off
if "%~1"=="--version" (
  echo 0.90.0
  exit /b 0
)
echo noop
rem ${binaryMarker}
`
    : `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '0.90.0\\n'
  exit 0
fi
printf 'noop\\n'
# ${binaryMarker}
`;

  await writeFile(fakeDroidPath, script, "utf8");
  if (!IS_WINDOWS) {
    await chmod(fakeDroidPath, 0o755);
  }

  return execFileAsync(
    process.execPath,
    [cliPath, "--skip-login", "-p", fakeDroidPath, "--dry-run", "droid-test"],
    { cwd: join(fileURLToPath(new URL("..", import.meta.url))) },
  );
}

void test("factoryd self-path patch stays internal", async () => {
  const src = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const metadataSrc = await readFile(new URL("../src/metadata.ts", import.meta.url), "utf8");
  assert.match(src, /FACTORYD_SELF_PATH_REGEX/);
  assert.match(src, /FACTORYD_SKIP_LOGIN_AUTH_REGEX/);
  assert.doesNotMatch(src, /--factoryd-self-path/);
  assert.doesNotMatch(src, /meta\.patches\.factorydSelfPath/);
  assert.doesNotMatch(metadataSrc, /factorydSelfPath/);
});

void test("factoryd-self-path regex patch preserves byte length", async () => {
  const { patchDroid } = await import(new URL("../dist/index.mjs", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "droid-patch-"));
  const inputPath = join(dir, "input.js");
  const outputPath = join(dir, "output.js");
  const source = `${FACTORYD_PATH_SOURCE}\nconst daemonPath = $QH(false);\n`;

  await writeFile(inputPath, source, "utf8");

  const result = await patchDroid({
    inputPath,
    outputPath,
    backup: false,
    patches: [
      {
        name: "factorydSelfPath",
        description: "test factoryd self-path replacement",
        pattern: Buffer.from(""),
        replacement: Buffer.from(""),
        regexPattern: FACTORYD_PATH_REGEX,
        regexReplacement: "function $1($2){return process.execPath}",
        alreadyPatchedRegexPattern:
          /function ([A-Za-z$_][A-Za-z0-9$_]*)\(([A-Za-z$_][A-Za-z0-9$_]*)\)\{return process\.execPath\}/g,
      },
    ],
  });

  assert.equal(result.success, true);
  const patched = await readFile(outputPath, "utf8");
  assert.equal(Buffer.byteLength(patched), Buffer.byteLength(source));
  assert.match(patched, /function \$QH\(H\)\{return process\.execPath\}/);
  assert.doesNotMatch(patched, /"droid-dev":"droid"/);
});

void test("factoryd core patches apply without an extra flag", async () => {
  const { stdout } = await runCliDryRunWithFactorydPatch(
    `${FACTORYD_PATH_SOURCE}\n${FACTORYD_SKIP_LOGIN_AUTH_SOURCE}\nisCustom:!0`,
  );
  assert.match(stdout, /\[\*\] Checking patch: factorydSelfPath/);
  assert.match(stdout, /\[\*\] Checking patch: factorydSkipLoginAuth/);
  assert.match(stdout, /\[\*\] Checking patch: isCustom/);
});

void test("factoryd skip-login auth patch preserves byte length", async () => {
  const { patchDroid } = await import(new URL("../dist/index.mjs", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "droid-patch-"));
  const inputPath = join(dir, "input.js");
  const outputPath = join(dir, "output.js");
  const source = `${FACTORYD_SKIP_LOGIN_AUTH_SOURCE}\n`;

  await writeFile(inputPath, source, "utf8");

  const result = await patchDroid({
    inputPath,
    outputPath,
    backup: false,
    patches: [
      {
        name: "factorydSkipLoginAuth",
        description: "test skip-login daemon auth replacement",
        pattern: Buffer.from(""),
        replacement: Buffer.from(""),
        regexPattern: FACTORYD_SKIP_LOGIN_AUTH_REGEX,
        regexReplacement:
          'let $1=$3[0]=="f"&&$3[1]=="k"?{orgId:"f",userId:"f"}:await VX(),$2=$3[0]=="f"&&$3[1]=="k"?$1:await AyH($3);if(!$1||!$1.orgId)throw new LT("Daemon not authenticated");if(!$2.orgId||!($3[0]=="f"&&$3[1]=="k")&&($2.userId!==$1.userId||$2.orgId!==$1.orgId))throw new LT("Client identity does not match daemon identity");',
        alreadyPatchedRegexPattern:
          /[A-Za-z$_][A-Za-z0-9$_]*\[0\]=="f"&&[A-Za-z$_][A-Za-z0-9$_]*\[1\]=="k"\?\{orgId:"f",userId:"f"\}:await VX\(\),/g,
      },
    ],
  });

  assert.equal(result.success, true);
  const patched = await readFile(outputPath, "utf8");
  assert.equal(Buffer.byteLength(patched), Buffer.byteLength(source));
  assert.match(patched, /\[0\]=="f"&&L\[1\]=="k"\?\{orgId:"f",userId:"f"\}/);
  assert.doesNotMatch(patched, /await VX\(\);if\(!D\|\|!D\.orgId\)/);
});

void test("skip-login dry-run also finds the factoryd auth bypass patch", async () => {
  const { stdout } = await runCliDryRunWithSkipLogin(
    `${SKIP_LOGIN_V068_SOURCE}\n${FACTORYD_SKIP_LOGIN_AUTH_SOURCE}`,
  );
  assert.match(stdout, /\[\*\] Checking patch: factoryApiKeyLookupV068/);
  assert.match(stdout, /\[\*\] Checking patch: factorydSkipLoginAuth/);
});
