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
  /(function ([A-Za-z$_][A-Za-z0-9$_]*)\(([A-Za-z$_][A-Za-z0-9$_]*)\)\{if\()([A-Za-z$_][A-Za-z0-9$_]*)\.basename\(process\.execPath\)\.includes\("droid"\)(\)return process\.execPath;return \3\?"droid-dev":"droid"\})/g;
const FACTORYD_PATH_PATCHED_REGEX =
  /function ([A-Za-z$_][A-Za-z0-9$_]*)\(([A-Za-z$_][A-Za-z0-9$_]*)\)\{if\(\(1\|\|([A-Za-z$_][A-Za-z0-9$_]*)\.basename\(process\.execPath\)\.includes\(""\)\)\)return process\.execPath;return \2\?"droid-dev":"droid"\}/g;
const FACTORYD_SKIP_LOGIN_AUTH_SOURCE =
  'async function LXT(H){let T=N8().apiBaseUrl,R=await fetch(`${T}/api/cli/whoami`,{method:"GET",headers:{Authorization:`Bearer ${H}`}}),A=await R.text();if(!R.ok)throw new LT("API key verification failed",{statusCode:R.status,body:A});let L=Nd(A,JL9,"whoami response");return{userId:L.userId,email:"",orgId:L.orgId}}';
const FACTORYD_SKIP_LOGIN_AUTH_VARIANTS = [
  FACTORYD_SKIP_LOGIN_AUTH_SOURCE,
  'async function UyH(H){let A=w0().apiBaseUrl,T=await fetch(`${A}/api/cli/whoami`,{method:"GET",headers:{Authorization:`Bearer ${H}`}}),R=await T.text();if(!T.ok)throw new SH("API key verification failed",{statusCode:T.status,body:R});let L=wj(R,eET,"whoami response");return{userId:L.userId,email:"",orgId:L.orgId}}',
  'async function KkH(H){let A=f0().apiBaseUrl,T=await fetch(`${A}/api/cli/whoami`,{method:"GET",headers:{Authorization:`Bearer ${H}`}}),R=await T.text();if(!T.ok)throw new bH("API key verification failed",{statusCode:T.status,body:R});let L=uj(R,gOT,"whoami response");return{userId:L.userId,email:"",orgId:L.orgId}}',
  'async function QMH(H){let A=t9().apiBaseUrl,T=await fetch(`${A}/api/cli/whoami`,{method:"GET",headers:{Authorization:`Bearer ${H}`}}),R=await T.text();if(!T.ok)throw new zH("API key verification failed",{statusCode:T.status,body:R});let L=xV(R,QtA,"whoami response");return{userId:L.userId,email:"",orgId:L.orgId}}',
];
const FACTORYD_SKIP_LOGIN_AUTH_REGEX =
  /async function ([A-Za-z$_][A-Za-z0-9$_]*)\(([A-Za-z$_][A-Za-z0-9$_]*)\)\{let ([A-Za-z$_][A-Za-z0-9$_]*)=([A-Za-z$_][A-Za-z0-9$_]*)\(\)\.apiBaseUrl,([A-Za-z$_][A-Za-z0-9$_]*)=await fetch\(`\$\{\3\}\/api\/cli\/whoami`,\{method:"GET",headers:\{Authorization:`Bearer \$\{\2\}`\}\}\),([A-Za-z$_][A-Za-z0-9$_]*)=await \5\.text\(\);if\(!\5\.ok\)throw new ([A-Za-z$_][A-Za-z0-9$_]*)\("API key verification failed",\{statusCode:\5\.status,body:\6\}\);let ([A-Za-z$_][A-Za-z0-9$_]*)=([A-Za-z$_][A-Za-z0-9$_]*)\(\6,([A-Za-z$_][A-Za-z0-9$_]*),"whoami response"\);return\{userId:\8\.userId,email:"",orgId:\8\.orgId\}\}/g;
const FACTORYD_SKIP_LOGIN_AUTH_PATCHED_REGEX =
  /async function [A-Za-z$_][A-Za-z0-9$_]*\(([A-Za-z$_][A-Za-z0-9$_]*)\)\{if\(\/\^fk\/\.test\(\1\)\)return\{userId:"f",orgId:"f"\};let ([A-Za-z$_][A-Za-z0-9$_]*)=await fetch\(`\$\{([A-Za-z$_][A-Za-z0-9$_]*)\(\)\.apiBaseUrl\}\/api\/cli\/whoami`,\{headers:\{Authorization:`Bearer \$\{\1\}`\}\}\);if\(!\2\.ok\)throw new [A-Za-z$_][A-Za-z0-9$_]*\("API key verification failed"\);\2=[A-Za-z$_][A-Za-z0-9$_]*\(await \2\.text\(\),([A-Za-z$_][A-Za-z0-9$_]*),"whoami response"\);return\{userId:\2\.userId,email:"",orgId:\2\.orgId\}\s+\}/g;
const FACTORYD_SKIP_LOGIN_AUTH_REPLACEMENT =
  'async function $1($2){if(/^fk/.test($2))return{userId:"f",orgId:"f"};let $3=await fetch(`${$4().apiBaseUrl}/api/cli/whoami`,{headers:{Authorization:`Bearer ${$2}`}});if(!$3.ok)throw new $7("API key verification failed");$3=$9(await $3.text(),$10,"whoami response");return{userId:$3.userId,email:"",orgId:$3.orgId}        }';
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
        regexReplacement: '$1(1||$4.basename(process.execPath).includes(""))$5',
        alreadyPatchedRegexPattern: FACTORYD_PATH_PATCHED_REGEX,
      },
    ],
  });

  assert.equal(result.success, true);
  const patched = await readFile(outputPath, "utf8");
  assert.equal(Buffer.byteLength(patched), Buffer.byteLength(source));
  assert.match(
    patched,
    /function \$QH\(H\)\{if\(\(1\|\|path\.basename\(process\.execPath\)\.includes\(""\)\)\)return process\.execPath;return H\?"droid-dev":"droid"\}/,
  );
  assert.match(patched, /"droid-dev":"droid"/);
  assert.doesNotMatch(patched, /\.includes\("droid"\)/);
});

void test("factoryd self-path patch still applies for non-skip-login binary patches", async () => {
  const { stdout } = await runCliDryRunWithFactorydPatch(
    `${FACTORYD_PATH_SOURCE}\n${FACTORYD_SKIP_LOGIN_AUTH_SOURCE}\nisCustom:!0`,
  );
  assert.match(stdout, /\[\*\] Checking patch: factorydSelfPath/);
  assert.doesNotMatch(stdout, /\[\*\] Checking patch: factorydSkipLoginAuth/);
  assert.match(stdout, /\[\*\] Checking patch: isCustom/);
});

void test("factoryd skip-login auth patch preserves byte length across whoami helpers", async () => {
  const { patchDroid } = await import(new URL("../dist/index.mjs", import.meta.url));
  for (const source of FACTORYD_SKIP_LOGIN_AUTH_VARIANTS) {
    const dir = await mkdtemp(join(tmpdir(), "droid-patch-"));
    const inputPath = join(dir, "input.js");
    const outputPath = join(dir, "output.js");
    const input = `${source}\n`;

    await writeFile(inputPath, input, "utf8");

    const result = await patchDroid({
      inputPath,
      outputPath,
      backup: false,
      patches: [
        {
          name: "factorydSkipLoginAuth",
          description: "test skip-login whoami helper replacement",
          pattern: Buffer.from(""),
          replacement: Buffer.from(""),
          regexPattern: FACTORYD_SKIP_LOGIN_AUTH_REGEX,
          regexReplacement: FACTORYD_SKIP_LOGIN_AUTH_REPLACEMENT,
          alreadyPatchedRegexPattern: FACTORYD_SKIP_LOGIN_AUTH_PATCHED_REGEX,
        },
      ],
    });

    assert.equal(result.success, true, source);
    const patched = await readFile(outputPath, "utf8");
    assert.equal(Buffer.byteLength(patched), Buffer.byteLength(input), source);
    assert.match(patched, new RegExp(FACTORYD_SKIP_LOGIN_AUTH_PATCHED_REGEX.source), source);
    assert.match(
      patched,
      /if\(\/\^fk\/\.test\([A-Za-z$_][A-Za-z0-9$_]*\)\)return\{userId:"f",orgId:"f"\}/,
      source,
    );
    assert.doesNotMatch(patched, /method:"GET"/, source);
  }
});

void test("skip-login dry-run also finds the factoryd auth bypass patch", async () => {
  const { stdout } = await runCliDryRunWithSkipLogin(
    `${SKIP_LOGIN_V068_SOURCE}\n${FACTORYD_SKIP_LOGIN_AUTH_SOURCE}`,
  );
  assert.match(stdout, /\[\*\] Checking patch: factoryApiKeyLookupV068/);
  assert.match(stdout, /\[\*\] Checking patch: factorydSkipLoginAuth/);
});
