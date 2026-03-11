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

async function runCliDryRunWithUndetectableVersion(binaryMarker) {
  const dir = await mkdtemp(join(tmpdir(), "droid-patch-cli-"));
  const fakeDroidPath = join(dir, IS_WINDOWS ? "droid.cmd" : "droid");
  const cliPath = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  const script = IS_WINDOWS
    ? `@echo off
if "%~1"=="--version" exit /b 1
echo noop
rem ${binaryMarker}
`
    : `#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 1
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

void test("skip-login uses fixed-length regex replacement for 0.68+", async () => {
  const src = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(src, /SKIP_LOGIN_V068_PLUS_REGEX/);
  assert.match(src, /createFixedLengthStringLiteral/);
  assert.match(src, /SKIP_LOGIN_V068_PLUS_REPLACEMENT_PREFIX = "fk-droid-patch-skip-"/);
});

void test("regex patcher supports function replacements with exact byte length", async () => {
  const { patchDroid } = await import(new URL("../dist/index.mjs", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "droid-patch-"));
  const inputPath = join(dir, "input.js");
  const outputPath = join(dir, "output.js");
  const originalExpr = "process.env[LongerName.FACTORY_API_KEY]?.trim()";
  const source = `const token = ${originalExpr};\n`;

  await writeFile(inputPath, source, "utf8");

  const result = await patchDroid({
    inputPath,
    outputPath,
    backup: false,
    patches: [
      {
        name: "skipLoginRegex",
        description: "test regex replacement",
        pattern: Buffer.from(""),
        replacement: Buffer.from(""),
        regexPattern: /process\.env\[[A-Za-z_$][A-Za-z0-9_$]*\.FACTORY_API_KEY\](?:\?\.trim\(\))?/g,
        regexReplacement: (match) => `"${"x".repeat(match.length - 2)}"`,
        alreadyPatchedRegexPattern: /"x+"/g,
      },
    ],
  });

  assert.equal(result.success, true);
  const patched = await readFile(outputPath, "utf8");
  assert.equal(Buffer.byteLength(patched), Buffer.byteLength(source));

  const literal = patched.slice("const token = ".length, -2);
  assert.equal(literal.length, originalExpr.length);
  assert.match(literal, /^"x+"$/);
  assert.doesNotMatch(patched, /"x+"\s+;/);
});

void test("skip-login falls back to binary inspection for 0.68+ binaries when version detection fails", async () => {
  const { stdout } = await runCliDryRunWithUndetectableVersion(
    "process.env[LongerName.FACTORY_API_KEY]?.trim()",
  );

  assert.match(stdout, /factoryApiKeyLookupV068/);
  assert.doesNotMatch(stdout, /Unable to detect droid version/);
});

void test("skip-login falls back to binary inspection for legacy binaries when version detection fails", async () => {
  const { stdout } = await runCliDryRunWithUndetectableVersion("process.env.FACTORY_API_KEY");

  assert.match(stdout, /\[\*\] Checking patch: skipLogin/);
  assert.doesNotMatch(stdout, /Unable to detect droid version/);
});
