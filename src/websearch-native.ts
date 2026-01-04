/**
 * WebSearch Native Provider Mode (--websearch-proxy)
 *
 * Uses model's native websearch based on ~/.factory/settings.json configuration
 * Requires proxy plugin (anthropic4droid) to handle format conversion
 *
 * Supported providers: Anthropic, OpenAI (extensible)
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
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEBUG = process.env.DROID_SEARCH_DEBUG === '1';
const PORT = parseInt(process.env.SEARCH_PROXY_PORT || '0');
const FACTORY_API = '${factoryApiUrl}';

function log(...args) { if (DEBUG) console.error('[websearch]', ...args); }

// === Settings Configuration ===

let cachedSettings = null;
let settingsLastModified = 0;

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

function getCurrentModelConfig() {
  const settings = getFactorySettings();
  if (!settings) return null;
  
  const currentModelId = settings.sessionDefaultSettings?.model;
  if (!currentModelId) return null;
  
  const customModels = settings.customModels || [];
  const modelConfig = customModels.find(m => m.id === currentModelId);
  
  if (modelConfig) {
    log('Model:', modelConfig.displayName, '| Provider:', modelConfig.provider);
    return modelConfig;
  }
  
  if (!currentModelId.startsWith('custom:')) return null;
  log('Model not found:', currentModelId);
  return null;
}

// === Native Provider WebSearch ===

async function searchAnthropicNative(query, numResults, modelConfig) {
  const { baseUrl, apiKey, model } = modelConfig;
  
  try {
    const requestBody = {
      model: model,
      max_tokens: 4096,
      stream: false,
      system: 'You are a web search assistant. Use the web_search tool to find relevant information and return the results.',
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      tool_choice: { type: 'tool', name: 'web_search' },
      messages: [{ role: 'user', content: 'Search the web for: ' + query + '\\n\\nReturn up to ' + numResults + ' relevant results.' }]
    };
    
    let endpoint = baseUrl;
    if (!endpoint.endsWith('/v1/messages')) endpoint = endpoint.replace(/\\/$/, '') + '/v1/messages';
    
    log('Anthropic search:', query, '→', endpoint);
    
    const bodyStr = JSON.stringify(requestBody).replace(/'/g, "'\\\\''");
    const curlCmd = 'curl -s -X POST "' + endpoint + '" -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" -H "x-api-key: ' + apiKey + '" -d \\'' + bodyStr + "\\'";
    const responseStr = execSync(curlCmd, { encoding: 'utf-8', timeout: 60000 });
    
    let response;
    try { response = JSON.parse(responseStr); } catch { return null; }
    if (response.error) { log('API error:', response.error.message); return null; }
    
    const results = [];
    for (const block of (response.content || [])) {
      if (block.type === 'web_search_tool_result') {
        for (const result of (block.content || [])) {
          if (result.type === 'web_search_result') {
            results.push({
              title: result.title || '',
              url: result.url || '',
              content: result.snippet || result.page_content || ''
            });
          }
        }
      }
    }
    
    log('Results:', results.length);
    return results.length > 0 ? results.slice(0, numResults) : null;
  } catch (e) {
    log('Anthropic error:', e.message);
    return null;
  }
}

async function searchOpenAINative(query, numResults, modelConfig) {
  const { baseUrl, apiKey, model } = modelConfig;
  
  try {
    const requestBody = {
      model: model,
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
      input: 'Search the web for: ' + query + '\\n\\nReturn up to ' + numResults + ' relevant results.'
    };
    
    let endpoint = baseUrl;
    if (!endpoint.endsWith('/responses')) endpoint = endpoint.replace(/\\/$/, '') + '/responses';
    
    log('OpenAI search:', query, '→', endpoint);
    
    const bodyStr = JSON.stringify(requestBody).replace(/'/g, "'\\\\''");
    const curlCmd = 'curl -s -X POST "' + endpoint + '" -H "Content-Type: application/json" -H "Authorization: Bearer ' + apiKey + '" -d \\'' + bodyStr + "\\'";
    const responseStr = execSync(curlCmd, { encoding: 'utf-8', timeout: 60000 });
    
    let response;
    try { response = JSON.parse(responseStr); } catch { return null; }
    if (response.error) { log('API error:', response.error.message); return null; }
    
    const results = [];
    for (const item of (response.output || [])) {
      if (item.type === 'web_search_call' && item.status === 'completed') {
        for (const result of (item.results || [])) {
          results.push({
            title: result.title || '',
            url: result.url || '',
            content: result.snippet || result.content || ''
          });
        }
      }
    }
    
    log('Results:', results.length);
    return results.length > 0 ? results.slice(0, numResults) : null;
  } catch (e) {
    log('OpenAI error:', e.message);
    return null;
  }
}

async function search(query, numResults) {
  numResults = numResults || 10;
  log('Search:', query);
  
  const modelConfig = getCurrentModelConfig();
  if (!modelConfig) {
    log('No custom model configured');
    return { results: [], source: 'none' };
  }
  
  const provider = modelConfig.provider;
  let results = null;
  
  if (provider === 'anthropic') results = await searchAnthropicNative(query, numResults, modelConfig);
  else if (provider === 'openai') results = await searchOpenAINative(query, numResults, modelConfig);
  else log('Unsupported provider:', provider);
  
  if (results && results.length > 0) return { results: results, source: 'native-' + provider };
  return { results: [], source: 'none' };
}

// === HTTP Proxy Server ===

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mode: 'native-provider' }));
    return;
  }

  if (url.pathname === '/api/tools/exa/search' && req.method === 'POST') {
    let body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', async function() {
      try {
        const parsed = JSON.parse(body);
        const result = await search(parsed.query, parsed.numResults || 10);
        log('Results:', result.results.length, 'from', result.source);
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

  // Standalone mode: mock non-LLM APIs
  if (process.env.STANDALONE_MODE === '1') {
    const pathname = url.pathname;
    const isCoreLLMApi = pathname.startsWith('/api/llm/a/') || pathname.startsWith('/api/llm/o/');

    if (!isCoreLLMApi) {
      if (pathname === '/api/sessions/create') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) }));
        return;
      }
      if (pathname === '/api/cli/whoami') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
      return;
    }
  }

  // Simple proxy - no SSE transformation (handled by proxy plugin)
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
