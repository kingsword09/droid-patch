/**
 * WebSearch Native Provider Mode (--websearch-proxy)
 *
 * Uses model's native websearch based on ~/.factory/settings.json configuration
 * Requires proxy plugin to handle format conversion:
 * - Anthropic provider: anthropic4droid plugin
 * - OpenAI provider: openai4droid plugin (adds CODEX_INSTRUCTIONS)
 *
 * Supported providers:
 * - Anthropic: web_search_20250305 server tool, results in web_search_tool_result
 * - OpenAI: web_search tool, results in message.content[].annotations[] as url_citation
 */

export function generateNativeSearchProxyServer(
  factoryApiUrl: string = "https://api.factory.ai",
): string {
  return `#!/usr/bin/env node
// Droid WebSearch Proxy Server (Native Provider Mode)
// Reads ~/.factory/settings.json for model configuration
// Requires proxy plugin (anthropic4droid) to handle format conversion

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEBUG = process.env.DROID_SEARCH_DEBUG === '1';
const PORT = parseInt(process.env.SEARCH_PROXY_PORT || '0');
const FACTORY_API = '${factoryApiUrl}';
const SEARCH_ROUTE_ALIASES = new Set(['/api/tools/web-search', '/api/tools/exa/search']);
const SUPPORTED_PROVIDERS = new Set(['anthropic', 'openai']);
const MOCK_USER_ID = 'f';
const MOCK_ORG_ID = 'f';
const SKIP_LOGIN_PATCHED = process.env.DROID_SKIP_LOGIN === '1';

function log(...args) { if (DEBUG) console.error('[websearch]', ...args); }

function isSearchRequest(url, method) {
  return method === 'POST' && SEARCH_ROUTE_ALIASES.has(url.pathname);
}

function getBearerToken(headers) {
  const auth = headers && headers.authorization;
  if (typeof auth !== 'string') return null;
  const match = auth.match(/^Bearer\\s+(.+)$/i);
  return match ? match[1] : null;
}

function isPatchedFactoryKey(token) {
  return typeof token === 'string' && /^fk/i.test(token);
}

function createMockBillingLimits(overagePreference) {
  return {
    usesTokenRateLimitsBilling: false,
    overagePreference: overagePreference || null,
    extraUsageAllowed: false,
    extraUsageBalanceCents: 0,
    limits: {
      standard: {
        fiveHour: { usedPercent: 0 },
        weekly: { usedPercent: 0 },
        monthly: { usedPercent: 0 },
      },
    },
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

let cachedSettings = null;
let settingsLastModified = 0;
let lastObservedProvider = null;
let mockedOveragePreference = null;

function getFactorySettings() {
  const settingsPath = path.join(os.homedir(), '.factory', 'settings.json');
  try {
    const stats = fs.statSync(settingsPath);
    if (cachedSettings && stats.mtimeMs === settingsLastModified) return cachedSettings;
    cachedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    settingsLastModified = stats.mtimeMs;
    return cachedSettings;
  } catch (e) {
    log('Failed to load settings.json:', e.message);
    return null;
  }
}

function listCustomModels(settings) {
  return Array.isArray(settings && settings.customModels) ? settings.customModels : [];
}

function isSupportedModel(modelConfig, preferredProvider) {
  return !!(
    modelConfig &&
    SUPPORTED_PROVIDERS.has(modelConfig.provider) &&
    (!preferredProvider || modelConfig.provider === preferredProvider) &&
    modelConfig.id &&
    modelConfig.baseUrl &&
    modelConfig.apiKey &&
    modelConfig.model
  );
}

function buildCandidateModelIds(settings) {
  const candidates = [
    process.env.DROID_SEARCH_MODEL_ID,
    settings && settings.sessionDefaultSettings && settings.sessionDefaultSettings.model,
    settings && settings.missionModelSettings && settings.missionModelSettings.workerModel,
    settings && settings.missionModelSettings && settings.missionModelSettings.validationWorkerModel,
    settings && settings.missionModelSettings && settings.missionModelSettings.orchestratorModel,
  ];
  const unique = [];
  for (const candidate of candidates) {
    if (candidate && !unique.includes(candidate)) unique.push(candidate);
  }
  return unique;
}

function summarizeSupportedModels(settings, preferredProvider) {
  return listCustomModels(settings)
    .filter(function(modelConfig) { return isSupportedModel(modelConfig, preferredProvider); })
    .map(function(modelConfig) { return modelConfig.id + ' [' + modelConfig.provider + ']'; })
    .join(', ');
}

function getCurrentModelConfig(preferredProvider) {
  const settings = getFactorySettings();
  if (!settings) {
    return {
      error: 'Failed to load ~/.factory/settings.json for native websearch',
      statusCode: 500,
    };
  }

  const customModels = listCustomModels(settings);
  const candidateIds = buildCandidateModelIds(settings);
  for (const candidateId of candidateIds) {
    const modelConfig = customModels.find(function(model) {
      return model.id === candidateId && isSupportedModel(model, preferredProvider);
    });
    if (modelConfig) {
      lastObservedProvider = modelConfig.provider;
      log('Resolved model:', modelConfig.id, '| Provider:', modelConfig.provider);
      return { modelConfig: modelConfig, source: candidateId };
    }
  }

  const fallbackModels = customModels.filter(function(modelConfig) {
    return isSupportedModel(modelConfig, preferredProvider);
  });
  if (fallbackModels.length === 1) {
    lastObservedProvider = fallbackModels[0].provider;
    log('Falling back to only supported model:', fallbackModels[0].id);
    return { modelConfig: fallbackModels[0], source: 'single-supported-model' };
  }

  const providerLabel = preferredProvider || 'anthropic/openai';
  const supported = summarizeSupportedModels(settings, preferredProvider);
  const message = supported
    ? 'Could not resolve an active ' + providerLabel + ' custom model for native websearch. Available models: ' + supported
    : 'No supported ' + providerLabel + ' custom models found in ~/.factory/settings.json';

  return { error: message, statusCode: 400 };
}

function normalizeEndpoint(baseUrl, suffix) {
  return baseUrl.endsWith(suffix) ? baseUrl : baseUrl.replace(/\\/$/, '') + suffix;
}

function extractErrorMessage(value) {
  if (!value) return 'Unknown upstream error';
  if (typeof value === 'string') return value;
  if (typeof value.message === 'string') return value.message;
  return JSON.stringify(value);
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function getRetryDelayMs(attempt) {
  return Math.min(250 * Math.pow(2, attempt - 1), 2000);
}

function isRetryableSearchFailure(statusCode, message) {
  if (statusCode === 408 || statusCode === 425 || statusCode === 429) return true;
  if (statusCode >= 500 && statusCode <= 599) return true;

  const normalized = String(message || '').toLowerCase();
  return normalized.includes('proxy failed:') ||
    normalized.includes('client network socket disconnected before secure tls connection was established') ||
    normalized.includes('fetch failed') ||
    normalized.includes('socket hang up') ||
    normalized.includes('request timed out') ||
    normalized.includes('timed out') ||
    normalized.includes('econnreset') ||
    normalized.includes('ecconnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('ehostunreach') ||
    normalized.includes('enotfound') ||
    normalized.includes('eai_again');
}

function pushUniqueResult(results, result) {
  if (!result || !result.url) return;
  if (results.some(function(existing) { return existing.url === result.url; })) return;
  results.push({
    title: result.title || result.url,
    url: result.url,
    content: result.content || '',
  });
}

function parseOpenAITextResults(text, numResults) {
  const results = [];
  const lines = String(text || '').split(/\\r?\\n/);
  let current = null;

  function flushCurrent() {
    if (!current || !current.url) {
      current = null;
      return;
    }
    pushUniqueResult(results, {
      title: current.title,
      url: current.url,
      content: current.content.join(' ').trim(),
    });
    current = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const titleMatch = line.match(/^\\d+\\.\\s+(?:\\*\\*(.+?)\\*\\*|(.+))$/);
    if (titleMatch) {
      flushCurrent();
      current = {
        title: (titleMatch[1] || titleMatch[2] || '').trim(),
        url: '',
        content: [],
      };
      continue;
    }

    const urlMatch = line.match(/^(?:[-*]\\s+)?(https?:\\/\\/\\S+)/);
    if (urlMatch) {
      if (!current) {
        current = { title: urlMatch[1], url: '', content: [] };
      }
      current.url = urlMatch[1].replace(/[),.;]+$/, '');
      continue;
    }

    const bulletTextMatch = line.match(/^[-*]\\s+(.+)/);
    const contentText = (bulletTextMatch ? bulletTextMatch[1] : line).trim();
    if (!current) {
      continue;
    }
    if (contentText) {
      current.content.push(contentText);
    }
  }

  flushCurrent();
  return results.slice(0, numResults);
}

async function postJson(endpoint, headers, requestBody) {
  const maxAttempts = 5;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(function() { controller.abort(); }, 60000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const responseText = await response.text();
      let payload = {};
      if (responseText) {
        try {
          payload = JSON.parse(responseText);
        } catch {
          throw new Error('Invalid JSON response from ' + endpoint);
        }
      }

      if (!response.ok) {
        const message = extractErrorMessage(payload && payload.error) || ('HTTP ' + response.status);
        if (attempt < maxAttempts && isRetryableSearchFailure(response.status, message)) {
          lastError = new Error(message);
          const delayMs = getRetryDelayMs(attempt);
          log('Retrying request after upstream error:', response.status, message, '| next attempt', attempt + 1, 'of', maxAttempts);
          await sleep(delayMs);
          continue;
        }
        throw new Error(message);
      }

      if (payload && payload.error) {
        const message = extractErrorMessage(payload.error);
        if (attempt < maxAttempts && isRetryableSearchFailure(undefined, message)) {
          lastError = new Error(message);
          const delayMs = getRetryDelayMs(attempt);
          log('Retrying request after payload error:', message, '| next attempt', attempt + 1, 'of', maxAttempts);
          await sleep(delayMs);
          continue;
        }
        throw new Error(message);
      }

      return payload;
    } catch (e) {
      const message = e && e.name === 'AbortError' ? 'Request timed out' : (e && e.message ? e.message : String(e));
      if (attempt < maxAttempts && isRetryableSearchFailure(undefined, message)) {
        lastError = new Error(message);
        const delayMs = getRetryDelayMs(attempt);
        log('Retrying request after transport error:', message, '| next attempt', attempt + 1, 'of', maxAttempts);
        await sleep(delayMs);
        continue;
      }
      throw new Error(message);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error('Request failed');
}

async function searchAnthropicNative(query, numResults, modelConfig) {
  const endpoint = normalizeEndpoint(modelConfig.baseUrl, '/v1/messages');
  const requestBody = {
    model: modelConfig.model,
    max_tokens: 4096,
    stream: false,
    system: 'You are a web search assistant. Use the web_search tool to find relevant information and return the results.',
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    tool_choice: { type: 'tool', name: 'web_search' },
    messages: [{ role: 'user', content: 'Search the web for: ' + query + '\\n\\nReturn up to ' + numResults + ' relevant results.' }],
  };

  log('Anthropic search:', query, '→', endpoint);
  const response = await postJson(endpoint, {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': modelConfig.apiKey,
  }, requestBody);

  const results = [];
  for (const block of (response.content || [])) {
    if (block.type !== 'web_search_tool_result') continue;
    for (const result of (block.content || [])) {
      if (result.type !== 'web_search_result') continue;
      results.push({
        title: result.title || '',
        url: result.url || '',
        content: result.snippet || result.page_content || '',
      });
    }
  }

  log('Anthropic results:', results.length);
  return results.slice(0, numResults);
}

async function searchOpenAINative(query, numResults, modelConfig) {
  const endpoint = normalizeEndpoint(modelConfig.baseUrl, '/responses');
  const input = 'Search the web for: ' + query + '\\n\\nReturn up to ' + numResults + ' relevant results.';
  const requestVariants = [
    {
      label: 'web_search',
      body: {
        model: modelConfig.model,
        stream: false,
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        input: input,
      },
    },
    {
      label: 'web_search_preview',
      body: {
        model: modelConfig.model,
        stream: false,
        tools: [{ type: 'web_search_preview' }],
        input: input,
      },
    },
  ];

  let lastError = null;
  for (const variant of requestVariants) {
    try {
      log('OpenAI search:', query, '→', endpoint, '(' + variant.label + ')');
      const response = await postJson(endpoint, {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + modelConfig.apiKey,
      }, variant.body);

      const results = [];
      const textBlocks = [];
      for (const item of (response.output || [])) {
        if (item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const content of item.content) {
          if (content.type !== 'output_text') continue;
          if (content.text) {
            textBlocks.push(content.text);
          }
          if (!Array.isArray(content.annotations)) continue;
          for (const annotation of content.annotations) {
            if (annotation.type !== 'url_citation' || !annotation.url) continue;
            pushUniqueResult(results, {
              title: annotation.title || '',
              url: annotation.url || '',
              content: annotation.title || '',
            });
          }
        }
      }

      if (results.length === 0) {
        for (const textBlock of textBlocks) {
          for (const parsedResult of parseOpenAITextResults(textBlock, numResults)) {
            pushUniqueResult(results, parsedResult);
          }
          if (results.length >= numResults) break;
        }
      }

      log('OpenAI results:', results.length, 'via', variant.label);
      return results.slice(0, numResults);
    } catch (e) {
      lastError = e;
      log('OpenAI variant failed:', variant.label, '-', e.message);
    }
  }

  throw lastError || new Error('OpenAI web search failed');
}

async function search(query, numResults) {
  numResults = numResults || 10;
  log('Search:', query);

  const resolved = getCurrentModelConfig(lastObservedProvider);
  if (!resolved.modelConfig) {
    return {
      results: [],
      source: 'none',
      error: resolved.error,
      statusCode: resolved.statusCode || 400,
    };
  }

  try {
    let results = [];
    if (resolved.modelConfig.provider === 'anthropic') {
      results = await searchAnthropicNative(query, numResults, resolved.modelConfig);
    } else if (resolved.modelConfig.provider === 'openai') {
      results = await searchOpenAINative(query, numResults, resolved.modelConfig);
    } else {
      return {
        results: [],
        source: 'none',
        error: 'Unsupported provider: ' + resolved.modelConfig.provider,
        statusCode: 400,
      };
    }

    return {
      results: results,
      source: 'native-' + resolved.modelConfig.provider,
      modelId: resolved.modelConfig.id,
    };
  } catch (e) {
    return {
      results: [],
      source: 'none',
      error: e && e.message ? e.message : String(e),
      statusCode: 502,
    };
  }
}

// === HTTP Proxy Server ===

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const pathname = url.pathname;
  const bearerToken = getBearerToken(req.headers);
  const isPatchedAuthRequest = SKIP_LOGIN_PATCHED || isPatchedFactoryKey(bearerToken);

  if (pathname === '/health') {
    writeJson(res, 200, { status: 'ok', mode: 'native-provider' });
    return;
  }

  if (isSearchRequest(url, req.method)) {
    let body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', async function() {
      try {
        const parsed = JSON.parse(body);
        const result = await search(parsed.query, parsed.numResults || 10);
        if (result.error) {
          log('Search failed:', result.error);
          res.writeHead(result.statusCode || 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.error, results: [] }));
          return;
        }
        log('Results:', result.results.length, 'from', result.source, 'model', result.modelId || 'unknown');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: result.results }));
      } catch (e) {
        log('Search error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e), results: [] }));
      }
    });
    return;
  }

  // Patched fk- sessions do not have a real Factory organization. Mission mode in
  // newer Droid versions probes billing/overage endpoints before launching worker
  // flows; returning a local synthetic response keeps the probe from failing.
  if (isPatchedAuthRequest) {
    if (pathname === '/api/cli/whoami') {
      writeJson(res, 200, { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID });
      return;
    }

    if (pathname === '/api/billing/limits' && req.method === 'GET') {
      writeJson(res, 200, createMockBillingLimits(mockedOveragePreference));
      return;
    }

    if (pathname === '/api/organization/subscription/set-overage-preference' && req.method === 'POST') {
      let body = '';
      req.on('data', function(c) { body += c; });
      req.on('end', function() {
        let requestedPreference = null;
        if (body) {
          try {
            const parsed = JSON.parse(body);
            if (typeof parsed.overagePreference === 'string') {
              requestedPreference = parsed.overagePreference;
            }
          } catch {}
        }

        mockedOveragePreference = requestedPreference;
        writeJson(res, 200, {
          ok: true,
          overagePreference: mockedOveragePreference,
        });
      });
      return;
    }
  }

  // Standalone mode: mock non-LLM APIs
  if (process.env.STANDALONE_MODE === '1') {
    const isCoreLLMApi = pathname.startsWith('/api/llm/a/') || pathname.startsWith('/api/llm/o/');

    if (!isCoreLLMApi) {
      if (pathname === '/api/sessions/create') {
        writeJson(res, 200, { id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) });
        return;
      }
      if (pathname === '/api/cli/whoami') {
        writeJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      writeJson(res, 200, {});
      return;
    }
  }

  // Simple proxy - no SSE transformation (handled by proxy plugin)
  if (url.pathname.startsWith('/api/llm/a/')) lastObservedProvider = 'anthropic';
  if (url.pathname.startsWith('/api/llm/o/')) lastObservedProvider = 'openai';
  log('Proxy:', req.method, url.pathname);
  const proxyUrl = new URL(FACTORY_API + url.pathname + url.search);
  const proxyModule = proxyUrl.protocol === 'https:' ? https : http;
  const proxyReq = proxyModule.request(proxyUrl, {
    method: req.method,
    headers: Object.assign({}, req.headers, { host: proxyUrl.host })
  }, function(proxyRes) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', function(e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy failed: ' + e.message }));
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(proxyReq);
  else proxyReq.end();
});

server.listen(PORT, '127.0.0.1', function() {
  const actualPort = server.address().port;
  const portFile = process.env.SEARCH_PROXY_PORT_FILE;
  if (portFile) fs.writeFileSync(portFile, String(actualPort));
  console.log('PORT=' + actualPort);
  log('Native provider proxy on port', actualPort);
});

process.on('SIGTERM', function() { server.close(); process.exit(0); });
process.on('SIGINT', function() { server.close(); process.exit(0); });
`;
}
