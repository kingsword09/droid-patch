/**
 * WebSearch External Providers Mode (--websearch)
 *
 * Priority: Smithery Exa > Google PSE > Tavily > Serper > Brave > SearXNG > DuckDuckGo
 */

export function generateSearchProxyServerCode(): string {
  return `#!/usr/bin/env node
// Droid WebSearch Proxy Server (External Providers Mode)
// Priority: Smithery Exa > Google PSE > Tavily > Serper > Brave > SearXNG > DuckDuckGo

const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const fs = require('fs');

const DEBUG = process.env.DROID_SEARCH_DEBUG === '1';
const PORT = parseInt(process.env.SEARCH_PROXY_PORT || '0');
const FACTORY_API = 'https://api.factory.ai';

function log() { if (DEBUG) console.error.apply(console, ['[websearch]'].concat(Array.from(arguments))); }

// === External Search Providers ===

async function searchSmitheryExa(query, numResults) {
  const apiKey = process.env.SMITHERY_API_KEY;
  const profile = process.env.SMITHERY_PROFILE;
  if (!apiKey || !profile) return null;
  try {
    const serverUrl = 'https://server.smithery.ai/exa/mcp?api_key=' + encodeURIComponent(apiKey) + '&profile=' + encodeURIComponent(profile);
    const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query: query, numResults: numResults } } });
    const bodyStr = requestBody.replace(/'/g, "'\\\\''");
    const curlCmd = 'curl -s -X POST "' + serverUrl + '" -H "Content-Type: application/json" -d \\'' + bodyStr + "\\'";
    const response = JSON.parse(execSync(curlCmd, { encoding: 'utf-8', timeout: 30000 }));
    if (response.result && response.result.content) {
      const textContent = response.result.content.find(function(c) { return c.type === 'text'; });
      if (textContent && textContent.text) {
        const results = JSON.parse(textContent.text);
        if (Array.isArray(results) && results.length > 0) {
          return results.slice(0, numResults).map(function(item) {
            return {
              title: item.title || '', url: item.url || '',
              content: item.text || item.snippet || (item.highlights ? item.highlights.join(' ') : '') || ''
            };
          });
        }
      }
    }
  } catch (e) { log('Smithery failed:', e.message); }
  return null;
}

async function searchGooglePSE(query, numResults) {
  const apiKey = process.env.GOOGLE_PSE_API_KEY;
  const cx = process.env.GOOGLE_PSE_CX;
  if (!apiKey || !cx) return null;
  try {
    const url = 'https://www.googleapis.com/customsearch/v1?key=' + apiKey + '&cx=' + cx + '&q=' + encodeURIComponent(query) + '&num=' + Math.min(numResults, 10);
    const data = JSON.parse(execSync('curl -s "' + url + '"', { encoding: 'utf-8', timeout: 15000 }));
    if (data.error) return null;
    return (data.items || []).map(function(item) { return { title: item.title, url: item.link, content: item.snippet || '' }; });
  } catch (e) { log('Google PSE failed:', e.message); }
  return null;
}

async function searchTavily(query, numResults) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  try {
    const bodyStr = JSON.stringify({
      api_key: apiKey,
      query: query,
      max_results: numResults,
      search_depth: 'basic',
      include_answer: false,
      include_images: false,
      include_raw_content: false
    }).replace(/'/g, "'\\\\''");
    const curlCmd = 'curl -s "https://api.tavily.com/search" -H "Content-Type: application/json" -d \\'' + bodyStr + "\\'";
    const data = JSON.parse(execSync(curlCmd, { encoding: 'utf-8', timeout: 15000 }));
    if (data && Array.isArray(data.results) && data.results.length > 0) {
      return data.results.slice(0, numResults).map(function(item) {
        return { title: item.title || '', url: item.url || '', content: item.content || item.snippet || item.raw_content || '' };
      });
    }
  } catch (e) { log('Tavily failed:', e.message); }
  return null;
}

async function searchSerper(query, numResults) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;
  try {
    const bodyStr = JSON.stringify({ q: query, num: numResults }).replace(/'/g, "'\\\\''");
    const curlCmd = 'curl -s "https://google.serper.dev/search" -H "X-API-KEY: ' + apiKey + '" -H "Content-Type: application/json" -d \\'' + bodyStr + "\\'";
    const data = JSON.parse(execSync(curlCmd, { encoding: 'utf-8', timeout: 15000 }));
    if (data.organic && data.organic.length > 0) {
      return data.organic.slice(0, numResults).map(function(item) { return { title: item.title, url: item.link, content: item.snippet || '' }; });
    }
  } catch (e) { log('Serper failed:', e.message); }
  return null;
}

async function searchBrave(query, numResults) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return null;
  try {
    const url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + numResults;
    const curlCmd = 'curl -s "' + url + '" -H "Accept: application/json" -H "X-Subscription-Token: ' + apiKey + '"';
    const data = JSON.parse(execSync(curlCmd, { encoding: 'utf-8', timeout: 15000 }));
    if (data.web && data.web.results && data.web.results.length > 0) {
      return data.web.results.slice(0, numResults).map(function(item) { return { title: item.title, url: item.url, content: item.description || '' }; });
    }
  } catch (e) { log('Brave failed:', e.message); }
  return null;
}

async function searchSearXNG(query, numResults) {
  const searxngUrl = process.env.SEARXNG_URL;
  if (!searxngUrl) return null;
  try {
    const url = searxngUrl + '/search?q=' + encodeURIComponent(query) + '&format=json&engines=google,bing,duckduckgo';
    const data = JSON.parse(execSync('curl -s "' + url + '" -H "Accept: application/json"', { encoding: 'utf-8', timeout: 15000 }));
    if (data.results && data.results.length > 0) {
      return data.results.slice(0, numResults).map(function(item) { return { title: item.title, url: item.url, content: item.content || '' }; });
    }
  } catch (e) { log('SearXNG failed:', e.message); }
  return null;
}

async function searchDuckDuckGo(query, numResults) {
  try {
    const apiUrl = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1';
    const data = JSON.parse(execSync('curl -s "' + apiUrl + '" -H "User-Agent: Mozilla/5.0"', { encoding: 'utf-8', timeout: 15000 }));
    const results = [];
    if (data.Abstract && data.AbstractURL) {
      results.push({ title: data.Heading || query, url: data.AbstractURL, content: data.Abstract });
    }
    var topics = data.RelatedTopics || [];
    for (var i = 0; i < topics.length && results.length < numResults; i++) {
      var topic = topics[i];
      if (topic.Text && topic.FirstURL) results.push({ title: topic.Text.substring(0, 100), url: topic.FirstURL, content: topic.Text });
      if (topic.Topics) {
        for (var j = 0; j < topic.Topics.length && results.length < numResults; j++) {
          var st = topic.Topics[j];
          if (st.Text && st.FirstURL) results.push({ title: st.Text.substring(0, 100), url: st.FirstURL, content: st.Text });
        }
      }
    }
    return results.length > 0 ? results : null;
  } catch (e) { log('DuckDuckGo failed:', e.message); }
  return null;
}

async function search(query, numResults) {
  numResults = numResults || 10;
  log('Search:', query);
  
  // Priority: Smithery > Google PSE > Tavily > Serper > Brave > SearXNG > DuckDuckGo
  var results = await searchSmitheryExa(query, numResults);
  if (results && results.length > 0) return { results: results, source: 'smithery-exa' };
  
  results = await searchGooglePSE(query, numResults);
  if (results && results.length > 0) return { results: results, source: 'google-pse' };
  
  results = await searchTavily(query, numResults);
  if (results && results.length > 0) return { results: results, source: 'tavily' };
  
  results = await searchSerper(query, numResults);
  if (results && results.length > 0) return { results: results, source: 'serper' };
  
  results = await searchBrave(query, numResults);
  if (results && results.length > 0) return { results: results, source: 'brave' };
  
  results = await searchSearXNG(query, numResults);
  if (results && results.length > 0) return { results: results, source: 'searxng' };
  
  results = await searchDuckDuckGo(query, numResults);
  if (results && results.length > 0) return { results: results, source: 'duckduckgo' };
  
  return { results: [], source: 'none' };
}

// === HTTP Proxy Server ===

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mode: 'external-providers' }));
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

  // Proxy other requests
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
  log('External providers proxy on port', actualPort);
});

process.on('SIGTERM', function() { server.close(); process.exit(0); });
process.on('SIGINT', function() { server.close(); process.exit(0); });
`;
}

export function generateExternalSearchProxyServer(
  factoryApiUrl: string = "https://api.factory.ai",
): string {
  const code = generateSearchProxyServerCode();
  return code.replace(
    "const FACTORY_API = 'https://api.factory.ai';",
    `const FACTORY_API = '${factoryApiUrl}';`,
  );
}
