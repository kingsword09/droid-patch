import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

void test("websearch wrapper includes passthrough logic", async () => {
  const src = await readFile(new URL("../src/websearch-patch.ts", import.meta.url), "utf8");
  assert.match(src, /should_passthrough\(\)/);
  assert.match(src, /help\|version\|completion\|completions\|exec/);
});

void test("statusline wrapper includes passthrough logic", async () => {
  const src = await readFile(new URL("../src/statusline-patch.ts", import.meta.url), "utf8");
  assert.match(src, /BYPASS_FLAGS/);
  assert.match(src, /def _should_passthrough\(argv\):/);
  assert.match(src, /def _exec_passthrough\(\):/);
  assert.ok(
    src.includes('re.search(b"\\\\x1b\\\\\\\\[[0-9]*;?[0-9]*r"'),
    "scroll-region regex should escape \\[ to avoid Python SyntaxWarning",
  );
});

void test("dist bundle contains passthrough logic (published output)", async () => {
  const dist = await readFile(new URL("../dist/cli.mjs", import.meta.url), "utf8");
  assert.match(dist, /should_passthrough\(\)/);
  assert.match(dist, /BYPASS_FLAGS = \{"--help"/);
});
