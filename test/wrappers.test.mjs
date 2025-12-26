import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

void test("websearch wrapper includes passthrough logic", async () => {
  const src = await readFile(new URL("../src/websearch-patch.ts", import.meta.url), "utf8");
  assert.match(src, /should_passthrough\(\)/);
  assert.match(src, /help\|version\|completion\|completions\|exec/);
});

void test("dist bundle contains passthrough logic (published output)", async () => {
  const dist = await readFile(new URL("../dist/cli.mjs", import.meta.url), "utf8");
  assert.match(dist, /should_passthrough\(\)/);
  assert.doesNotMatch(dist, /--statusline/);
  assert.doesNotMatch(dist, /--sessions/);
});
