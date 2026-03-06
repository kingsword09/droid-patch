import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
