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
  assert.match(src, /const BYPASS_FLAGS = new Set/);
  assert.match(src, /function shouldPassthrough\(argv\)/);
  assert.match(src, /async function execPassthrough\(argv\)/);
  assert.match(src, /function includesScrollRegionCSI\(\)/);
});

void test("statusline monitor tracks modelId from log contexts", async () => {
  const src = await readFile(new URL("../src/statusline-patch.ts", import.meta.url), "utf8");
  assert.match(src, /function extractModelIdFromContext/);
  assert.match(src, /ctxApprox\s*\?\s*'~'\s*:\s*''/);
  assert.match(src, /ctxOverflow\s*\?\s*'\+'\s*:\s*''/);
  assert.match(src, /\?\s*'--'/);
});

void test("dist bundle contains passthrough logic (published output)", async () => {
  const dist = await readFile(new URL("../dist/cli.mjs", import.meta.url), "utf8");
  assert.match(dist, /should_passthrough\(\)/);
  assert.match(dist, /function shouldPassthrough\(argv\)/);
  assert.match(dist, /const BYPASS_FLAGS = new Set/);
});
