import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

void test("websearch wrapper includes passthrough logic", async () => {
  const src = await readFile(new URL("../src/websearch-patch.ts", import.meta.url), "utf8");
  assert.match(src, /should_passthrough\(\)/);
  assert.match(src, /start_proxy_supervisor\(\)/);
  assert.match(src, /Proxy exited \(code: \$exit_code\); restarting/);
  assert.match(src, /help\|version\|completion\|completions\|plugin/);
  assert.doesNotMatch(src, /help\|version\|completion\|completions\|exec\|plugin/);
  assert.match(
    src,
    /SEARCH_ROUTE_ALIASES = new Set\(\['\/api\/tools\/web-search', '\/api\/tools\/exa\/search'\]\)/,
  );
  assert.match(src, /function isSearchRequest\(url, method\)/);
  assert.match(src, /FACTORY_APP_BASE_URL_OVERRIDE/);
  assert.match(src, /TOOLS_WEBSEARCH_BASE_URL/);
});

void test("dist bundle contains passthrough logic (published output)", async () => {
  const dist = await readFile(new URL("../dist/cli.mjs", import.meta.url), "utf8");
  assert.match(dist, /should_passthrough\(\)/);
  assert.match(dist, /start_proxy_supervisor\(\)/);
  assert.doesNotMatch(dist, /help\|version\|completion\|completions\|exec\|plugin/);
  assert.match(
    dist,
    /SEARCH_ROUTE_ALIASES = new Set\(\['\/api\/tools\/web-search', '\/api\/tools\/exa\/search'\]\)/,
  );
  assert.match(dist, /function isSearchRequest\(url, method\)/);
  assert.match(dist, /FACTORY_APP_BASE_URL_OVERRIDE/);
  assert.match(dist, /TOOLS_WEBSEARCH_BASE_URL/);
  assert.doesNotMatch(dist, /--statusline/);
  assert.doesNotMatch(dist, /--sessions/);
});
