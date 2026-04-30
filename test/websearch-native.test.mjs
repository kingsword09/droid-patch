import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IS_WINDOWS = platform() === "win32";
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

async function createFakeDroidBinary(dir) {
  const binaryPath = join(dir, IS_WINDOWS ? "droid.cmd" : "droid");
  const script = IS_WINDOWS
    ? `@echo off
if "%~1"=="--version" (
  echo 0.90.0
  exit /b 0
)
echo noop
`
    : `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '0.90.0\\n'
  exit 0
fi
printf 'noop\\n'
`;

  await writeFile(binaryPath, script, "utf8");
  if (!IS_WINDOWS) {
    await chmod(binaryPath, 0o755);
  }
  return binaryPath;
}

async function createFakeMissionCapableDroidBinary(dir) {
  const binaryPath = join(dir, IS_WINDOWS ? "droid.cmd" : "droid");
  const script = IS_WINDOWS
    ? `@echo off
if "%~1"=="--version" (
  echo 0.111.0
  exit /b 0
)
rem if(a.basename(process.execPath).includes("droid"))
rem async function a(b){let c=d().apiBaseUrl,e=await fetch(\`\${c}/api/cli/whoami\`,{method:"GET",headers:{Authorization:\`Bearer \${b}\`}}),f=await e.text();if(!e.ok)throw new G("API key verification failed",{statusCode:e.status,body:f});let h=I(f,j,"whoami response");return{userId:h.userId,email:"",orgId:h.orgId}}
rem process.env[a.FACTORY_API_KEY]?.trim()
echo noop
`
    : `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '0.111.0\\n'
  exit 0
fi
# if(a.basename(process.execPath).includes("droid"))
# async function a(b){let c=d().apiBaseUrl,e=await fetch(\`\${c}/api/cli/whoami\`,{method:"GET",headers:{Authorization:\`Bearer \${b}\`}}),f=await e.text();if(!e.ok)throw new G("API key verification failed",{statusCode:e.status,body:f});let h=I(f,j,"whoami response");return{userId:h.userId,email:"",orgId:h.orgId}}
# process.env[a.FACTORY_API_KEY]?.trim()
printf 'noop\\n'
`;

  await writeFile(binaryPath, script, "utf8");
  if (!IS_WINDOWS) {
    await chmod(binaryPath, 0o755);
  }
  return binaryPath;
}

async function writeFactorySettings(homeDir, settings) {
  const factoryDir = join(homeDir, ".factory");
  await mkdir(factoryDir, { recursive: true });
  await writeFile(join(factoryDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
}

async function createNativeAlias(homeDir, droidPath, alias) {
  const binDir = join(homeDir, "bin");
  await mkdir(binDir, { recursive: true });
  await execFileAsync(process.execPath, [CLI_PATH, "--websearch-proxy", "-p", droidPath, alias], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, HOME: homeDir, PATH: `${binDir}:${process.env.PATH}` },
  });
}

async function waitForPortFile(portFile) {
  for (let index = 0; index < 50; index++) {
    try {
      const value = (await readFile(portFile, "utf8")).trim();
      if (value) return Number(value);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for proxy port file: ${portFile}`);
}

async function waitForHealthyPort(port) {
  for (let index = 0; index < 50; index++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for proxy health on port ${port}`);
}

async function stopChild(child) {
  if (child.killed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function startNativeProxy(homeDir, alias) {
  const proxyScriptPath = join(homeDir, ".droid-patch", "proxy", `${alias}-proxy.js`);
  const portFile = join(homeDir, `${alias}.port`);
  const child = spawn(process.execPath, [proxyScriptPath], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      SEARCH_PROXY_PORT: "0",
      SEARCH_PROXY_PORT_FILE: portFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const port = await waitForPortFile(portFile);
    await waitForHealthyPort(port);
    return { child, port };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function requestSearch(port, payload, pathname = "/api/tools/web-search") {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function requestJson(port, pathname, options = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

async function startOpenAIStubServer(mode = "annotations") {
  let attempts = 0;
  const server = createServer((req, res) => {
    if (req.url !== "/responses" || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      attempts += 1;
      const parsed = JSON.parse(body);
      assert.ok(parsed.tools?.length);
      if (mode === "retry-once" && attempts === 1) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "Proxy failed: Client network socket disconnected before secure TLS connection was established",
          }),
        );
        return;
      }
      if (mode === "retry-thrice" && attempts <= 3) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "Proxy failed: Client network socket disconnected before secure TLS connection was established",
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      const content =
        mode === "text-only"
          ? [
              {
                type: "output_text",
                annotations: [],
                text: [
                  "Here are up to 3 relevant results:",
                  "",
                  "1. **React Activity**",
                  "   - https://www.npmjs.com/package/react-activity",
                  "   - Official npm package page with install details.",
                  "",
                  "2. **React Activity GitHub**",
                  "   - https://github.com/example/react-activity",
                  "   - Source repository with usage examples.",
                ].join("\n"),
              },
            ]
          : [
              {
                type: "output_text",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.com/result",
                    title: "Example Result",
                  },
                ],
              },
            ];
      res.end(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: content,
            },
          ],
        }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    getAttempts() {
      return attempts;
    },
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

void test("native websearch proxy falls back to mission model settings", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "droid-patch-native-"));
  const upstream = await startOpenAIStubServer();

  try {
    await writeFactorySettings(homeDir, {
      customModels: [
        {
          id: "custom:gpt-5-4-test",
          model: "gpt-5.4",
          baseUrl: upstream.baseUrl,
          apiKey: "test-key",
          displayName: "GPT 5.4 test",
          provider: "openai",
        },
      ],
      missionModelSettings: {
        workerModel: "custom:gpt-5-4-test",
      },
    });

    const droidPath = await createFakeDroidBinary(homeDir);
    await createNativeAlias(homeDir, droidPath, "droid-native");

    const { child, port } = await startNativeProxy(homeDir, "droid-native");
    try {
      const response = await requestSearch(port, { query: "factory ai", numResults: 3 });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.results.length, 1);
      assert.equal(payload.results[0].url, "https://example.com/result");
    } finally {
      await stopChild(child);
    }
  } finally {
    await upstream.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

void test("native websearch proxy parses text-only OpenAI search results", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "droid-patch-native-"));
  const upstream = await startOpenAIStubServer("text-only");

  try {
    await writeFactorySettings(homeDir, {
      customModels: [
        {
          id: "custom:gpt-5-4-text",
          model: "gpt-5.4",
          baseUrl: upstream.baseUrl,
          apiKey: "test-key",
          displayName: "GPT 5.4 text",
          provider: "openai",
        },
      ],
      sessionDefaultSettings: {
        model: "custom:gpt-5-4-text",
      },
    });

    const droidPath = await createFakeDroidBinary(homeDir);
    await createNativeAlias(homeDir, droidPath, "droid-native-text");

    const { child, port } = await startNativeProxy(homeDir, "droid-native-text");
    try {
      const response = await requestSearch(port, { query: "factory ai", numResults: 3 });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.results.length, 2);
      assert.equal(payload.results[0].url, "https://www.npmjs.com/package/react-activity");
      assert.equal(payload.results[1].url, "https://github.com/example/react-activity");
    } finally {
      await stopChild(child);
    }
  } finally {
    await upstream.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

void test("native websearch proxy retries transient OpenAI upstream failures", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "droid-patch-native-"));
  const upstream = await startOpenAIStubServer("retry-once");

  try {
    await writeFactorySettings(homeDir, {
      customModels: [
        {
          id: "custom:gpt-5-4-retry",
          model: "gpt-5.4",
          baseUrl: upstream.baseUrl,
          apiKey: "test-key",
          displayName: "GPT 5.4 retry",
          provider: "openai",
        },
      ],
      sessionDefaultSettings: {
        model: "custom:gpt-5-4-retry",
      },
    });

    const droidPath = await createFakeDroidBinary(homeDir);
    await createNativeAlias(homeDir, droidPath, "droid-native-retry");

    const { child, port } = await startNativeProxy(homeDir, "droid-native-retry");
    try {
      const response = await requestSearch(port, { query: "factory ai", numResults: 3 });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.results.length, 1);
      assert.equal(upstream.getAttempts(), 2);
    } finally {
      await stopChild(child);
    }
  } finally {
    await upstream.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

void test("native websearch proxy mocks mission billing endpoints for patched fk auth", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "droid-patch-native-"));

  try {
    await writeFactorySettings(homeDir, {
      customModels: [],
    });

    const droidPath = await createFakeDroidBinary(homeDir);
    await createNativeAlias(homeDir, droidPath, "droid-native-billing");

    const { child, port } = await startNativeProxy(homeDir, "droid-native-billing");
    try {
      const authHeaders = {
        Authorization: "Bearer fk-droid-patch-skip-00000",
      };

      const whoamiResponse = await requestJson(port, "/api/cli/whoami", {
        method: "GET",
        headers: authHeaders,
      });
      assert.equal(whoamiResponse.status, 200);
      assert.deepEqual(await whoamiResponse.json(), { userId: "f", orgId: "f" });

      const billingResponse = await requestJson(port, "/api/billing/limits", {
        method: "GET",
        headers: authHeaders,
      });
      assert.equal(billingResponse.status, 200);
      const billingPayload = await billingResponse.json();
      assert.equal(billingPayload.usesTokenRateLimitsBilling, false);
      assert.equal(billingPayload.overagePreference, null);

      const managedSettingsResponse = await requestJson(
        port,
        "/api/organization/managed-settings",
        {
          method: "GET",
          headers: authHeaders,
        },
      );
      assert.equal(managedSettingsResponse.status, 200);
      assert.deepEqual(await managedSettingsResponse.json(), {
        success: true,
        factoryTier: "team",
        settings: {},
      });

      const featureFlagsResponse = await requestJson(port, "/api/feature-flags", {
        method: "GET",
        headers: authHeaders,
      });
      assert.equal(featureFlagsResponse.status, 200);
      assert.deepEqual(await featureFlagsResponse.json(), {
        flags: {},
        configs: {},
      });

      const updateResponse = await requestJson(
        port,
        "/api/organization/subscription/set-overage-preference",
        {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ overagePreference: "droidCore" }),
        },
      );
      assert.equal(updateResponse.status, 200);
      assert.deepEqual(await updateResponse.json(), {
        ok: true,
        overagePreference: "droidCore",
      });

      const billingAfterUpdate = await requestJson(port, "/api/billing/limits", {
        method: "GET",
        headers: authHeaders,
      });
      const updatedPayload = await billingAfterUpdate.json();
      assert.equal(updatedPayload.overagePreference, "droidCore");
    } finally {
      await stopChild(child);
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

void test("native websearch proxy wrapper exports skip-login marker for patched aliases", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "droid-patch-native-"));

  try {
    await writeFactorySettings(homeDir, {
      customModels: [],
    });

    const droidPath = await createFakeMissionCapableDroidBinary(homeDir);
    await execFileAsync(
      process.execPath,
      [CLI_PATH, "--skip-login", "--websearch-proxy", "-p", droidPath, "droid-native-skip-login"],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, HOME: homeDir, PATH: process.env.PATH },
      },
    );

    const wrapperPath = join(homeDir, ".droid-patch", "proxy", "droid-native-skip-login");
    const proxyPath = join(homeDir, ".droid-patch", "proxy", "droid-native-skip-login-proxy.js");
    const wrapperText = await readFile(wrapperPath, "utf8");
    const proxyText = await readFile(proxyPath, "utf8");
    assert.match(wrapperText, /DROID_SKIP_LOGIN=1/);
    assert.match(wrapperText, /DROID_FACTORY_COMPAT=1/);
    assert.match(proxyText, /const SKIP_LOGIN_PATCHED = process\.env\.DROID_SKIP_LOGIN === '1';/);
    assert.match(
      proxyText,
      /const FACTORY_COMPAT_PATCHED = process\.env\.DROID_FACTORY_COMPAT === '1';/,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

void test("is-custom aliases also opt into Factory compat wrapper without explicit websearch flags", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "droid-patch-native-"));

  try {
    const droidPath = await createFakeMissionCapableDroidBinary(homeDir);
    const binDir = join(homeDir, "bin");
    await mkdir(binDir, { recursive: true });

    await execFileAsync(
      process.execPath,
      [CLI_PATH, "--is-custom", "-p", droidPath, "droid-custom"],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, HOME: homeDir, PATH: `${binDir}:${process.env.PATH}` },
      },
    );

    const wrapperPath = join(homeDir, ".droid-patch", "proxy", "droid-custom");
    const proxyPath = join(homeDir, ".droid-patch", "proxy", "droid-custom-proxy.js");
    const wrapperText = await readFile(wrapperPath, "utf8");
    const proxyText = await readFile(proxyPath, "utf8");

    assert.match(wrapperText, /DROID_FACTORY_COMPAT=1/);
    assert.doesNotMatch(wrapperText, /DROID_SKIP_LOGIN=1/);
    assert.match(
      proxyText,
      /const FACTORY_COMPAT_PATCHED = process\.env\.DROID_FACTORY_COMPAT === '1';/,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

void test("native websearch proxy survives repeated transient OpenAI upstream failures", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "droid-patch-native-"));
  const upstream = await startOpenAIStubServer("retry-thrice");

  try {
    await writeFactorySettings(homeDir, {
      customModels: [
        {
          id: "custom:gpt-5-4-retry-many",
          model: "gpt-5.4",
          baseUrl: upstream.baseUrl,
          apiKey: "test-key",
          displayName: "GPT 5.4 retry many",
          provider: "openai",
        },
      ],
      sessionDefaultSettings: {
        model: "custom:gpt-5-4-retry-many",
      },
    });

    const droidPath = await createFakeDroidBinary(homeDir);
    await createNativeAlias(homeDir, droidPath, "droid-native-retry-many");

    const { child, port } = await startNativeProxy(homeDir, "droid-native-retry-many");
    try {
      const response = await requestSearch(port, { query: "factory ai", numResults: 3 });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.results.length, 1);
      assert.equal(upstream.getAttempts(), 4);
    } finally {
      await stopChild(child);
    }
  } finally {
    await upstream.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

void test("native websearch proxy returns explicit errors for unsupported models", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "droid-patch-native-"));

  try {
    await writeFactorySettings(homeDir, {
      customModels: [
        {
          id: "custom:generic-test",
          model: "generic-model",
          baseUrl: "http://127.0.0.1:1/generic",
          apiKey: "test-key",
          displayName: "Generic test",
          provider: "generic-chat-completion-api",
        },
      ],
      sessionDefaultSettings: {
        model: "custom:generic-test",
      },
    });

    const droidPath = await createFakeDroidBinary(homeDir);
    await createNativeAlias(homeDir, droidPath, "droid-native-error");

    const { child, port } = await startNativeProxy(homeDir, "droid-native-error");
    try {
      const response = await requestSearch(port, { query: "factory ai", numResults: 3 });
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.match(payload.error, /No supported/);
    } finally {
      await stopChild(child);
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

void test("native websearch proxy still supports legacy /api/tools/exa/search", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "droid-patch-native-"));
  const upstream = await startOpenAIStubServer();

  try {
    await writeFactorySettings(homeDir, {
      customModels: [
        {
          id: "custom:gpt-5-4-legacy-endpoint",
          model: "gpt-5.4",
          baseUrl: upstream.baseUrl,
          apiKey: "test-key",
          displayName: "GPT 5.4 legacy endpoint",
          provider: "openai",
        },
      ],
      sessionDefaultSettings: {
        model: "custom:gpt-5-4-legacy-endpoint",
      },
    });

    const droidPath = await createFakeDroidBinary(homeDir);
    await createNativeAlias(homeDir, droidPath, "droid-native-legacy-endpoint");

    const { child, port } = await startNativeProxy(homeDir, "droid-native-legacy-endpoint");
    try {
      const response = await requestSearch(
        port,
        { query: "factory ai", numResults: 3 },
        "/api/tools/exa/search",
      );
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.results.length, 1);
      assert.equal(payload.results[0].url, "https://example.com/result");
    } finally {
      await stopChild(child);
    }
  } finally {
    await upstream.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

void test("websearch-proxy update path regenerates native wrappers", async () => {
  const src = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(src, /meta\.patches\.websearchProxy/);
  assert.match(src, /createWebSearchUnifiedFiles\([\s\S]*meta\.patches\.websearchProxy \|\| false/);
});

void test("is-custom and skip-login aliases opt into runtime Factory compat proxy", async () => {
  const src = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /function requiresRuntimeProxy\(config: Pick<BinaryPatchConfig, "isCustom" \| "skipLogin">\)/,
  );
  assert.match(src, /requiresRuntimeProxy\(\{ isCustom, skipLogin \}\)/);
  assert.match(
    src,
    /requiresRuntimeProxy\(\{\s*isCustom: meta\.patches\.isCustom,\s*skipLogin: meta\.patches\.skipLogin,\s*\}\)/,
  );
});

void test("factory compat proxy logic is centralized in a dedicated module", async () => {
  const nativeSrc = await readFile(new URL("../src/websearch-native.ts", import.meta.url), "utf8");
  const externalSrc = await readFile(
    new URL("../src/websearch-external.ts", import.meta.url),
    "utf8",
  );
  const compatSrc = await readFile(
    new URL("../src/runtime-proxy-factory-compat.ts", import.meta.url),
    "utf8",
  );

  assert.match(nativeSrc, /from "\.\/runtime-proxy-factory-compat\.ts"/);
  assert.match(externalSrc, /from "\.\/runtime-proxy-factory-compat\.ts"/);
  assert.match(nativeSrc, /generateFactoryCompatPrelude\(\)/);
  assert.match(nativeSrc, /generateFactoryCompatRoutes\(\)/);
  assert.match(externalSrc, /generateFactoryCompatPrelude\(\)/);
  assert.match(externalSrc, /generateFactoryCompatRoutes\(\)/);
  assert.match(compatSrc, /export function generateFactoryCompatPrelude/);
  assert.match(compatSrc, /export function generateFactoryCompatRoutes/);
});
