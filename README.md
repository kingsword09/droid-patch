# droid-patch

English | [简体中文](./README.zh-CN.md)

CLI tool to patch the droid binary with various modifications.

## Installation

```bash
npm install -g droid-patch
# or use directly with npx
npx droid-patch --help
```

## Usage

### Patch and Create an Alias

```bash
# Patch with --is-custom and create an alias
npx droid-patch --is-custom droid-custom

# Patch with --skip-login to bypass login requirement
npx droid-patch --skip-login droid-nologin

# Patch with --websearch to enable local search proxy
npx droid-patch --websearch droid-search

# Patch with --websearch --standalone for fully local mode (mock non-LLM APIs)
npx droid-patch --websearch --standalone droid-local

# Patch with --reasoning-effort to enable reasoning for custom models
npx droid-patch --reasoning-effort droid-reasoning

# Combine multiple patches
npx droid-patch --is-custom --skip-login --websearch --reasoning-effort droid-full

# Specify a custom path to the droid binary
npx droid-patch --skip-login -p /path/to/droid my-droid

# Dry run - verify patches without actually applying them
npx droid-patch --skip-login --dry-run droid

# Verbose output
npx droid-patch --skip-login -v droid
```

### Output to a Specific Directory

```bash
# Output patched binary to current directory
npx droid-patch --skip-login -o . my-droid

# Output to a specific directory
npx droid-patch --skip-login -o /path/to/dir my-droid
```

### Available Options

| Option                | Description                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--is-custom`         | Patch `isCustom:!0` to `isCustom:!1` (enables context compression for custom models)                         |
| `--skip-login`        | Bypass login by injecting a fake `FACTORY_API_KEY` into the binary                                           |
| `--api-base <url>`    | Replace API URL (standalone: binary patch, max 22 chars; with `--websearch`: proxy forward target, no limit) |
| `--websearch`         | Inject local WebSearch proxy with multiple search providers                                                  |
| `--standalone`        | Standalone mode: mock non-LLM Factory APIs (use with `--websearch`)                                          |
| `--reasoning-effort`  | Enable reasoning effort UI selector for custom models (set to high)                                          |
| `--disable-telemetry` | Disable telemetry and Sentry error reporting                                                                 |
| `--dry-run`           | Verify patches without actually modifying the binary                                                         |
| `-p, --path <path>`   | Path to the droid binary (default: `~/.droid/bin/droid`)                                                     |
| `-o, --output <dir>`  | Output directory for patched binary (creates file without alias)                                             |
| `--no-backup`         | Skip creating backup of original binary                                                                      |
| `-v, --verbose`       | Enable verbose output                                                                                        |

### Manage Aliases and Files

```bash
# List all aliases (shows versions, flags, creation time)
npx droid-patch list

# Remove an alias
npx droid-patch remove <alias-name>

# Remove a patched binary file by path
npx droid-patch remove ./my-droid
npx droid-patch remove /path/to/patched-binary

# Remove aliases by filter
npx droid-patch remove --patch-version=0.4.0     # by droid-patch version
npx droid-patch remove --droid-version=1.0.40    # by droid version
npx droid-patch remove --flag=websearch          # by feature flag

# Clear all droid-patch data (aliases, binaries, metadata)
npx droid-patch clear
```

### Update Aliases

When the original droid binary is updated, you can re-apply patches to all aliases:

```bash
# Update all aliases with new droid binary
npx droid-patch update

# Update a specific alias
npx droid-patch update <alias-name>

# Preview without making changes
npx droid-patch update --dry-run

# Use a different droid binary
npx droid-patch update -p /path/to/new/droid
```

The update command reads metadata stored when aliases were created and re-applies the same patches automatically.

### Check Version

```bash
npx droid-patch version
```

## PATH Configuration

When creating an alias (without `-o`), the tool will try to install to a directory already in your PATH (like `~/.local/bin`). If not available, you need to add the aliases directory to your PATH:

```bash
# Add to your shell config (~/.zshrc, ~/.bashrc, etc.)
export PATH="$HOME/.droid-patch/aliases:$PATH"
```

## How It Works

1. **Patching**: The tool searches for specific byte patterns in the droid binary and replaces them with equal-length replacements
2. **Alias Creation** (without `-o`):
   - Copies the patched binary to `~/.droid-patch/bins/`
   - Creates a symlink in a PATH directory or `~/.droid-patch/aliases/`
   - On macOS, automatically re-signs the binary with `codesign`
3. **Direct Output** (with `-o`):
   - Saves the patched binary directly to the specified directory
   - On macOS, automatically re-signs the binary with `codesign`

## Available Patches

### `--is-custom`

Changes `isCustom:!0` (true) to `isCustom:!1` (false) for custom models.

**Purpose**: This may enable context compression (auto-summarization) for custom models, which is normally only available for official models.

**Note**: Side effects are unknown - test thoroughly before production use.

### `--skip-login`

Replaces all `process.env.FACTORY_API_KEY` references in the binary with a hardcoded fake key `"fk-droid-patch-skip-00000"`.

**Purpose**: Bypass the login/authentication requirement without needing to set the `FACTORY_API_KEY` environment variable.

**How it works**:

- The original code checks `process.env.FACTORY_API_KEY` to authenticate
- After patching, the code directly uses the fake key string, bypassing the env check
- This is a binary-level patch, so it works across all terminal sessions without any environment setup

### `--api-base <url>`

Replace the Factory API base URL. Has different behavior depending on usage:

**1. Standalone (without `--websearch`)**

Binary patch to replace `https://api.factory.ai` with your custom URL.

- **Limitation**: URL must be 22 characters or less (same length as original URL)
- **Use case**: Direct API URL replacement without proxy

```bash
# Valid URLs (<=22 chars)
npx droid-patch --api-base "http://127.0.0.1:3000" droid-local
npx droid-patch --api-base "http://localhost:80" droid-local

# Invalid (too long)
npx droid-patch --api-base "http://my-long-domain.com:3000" droid  # Error!
```

**2. With `--websearch`**

Sets the forward target URL for the WebSearch proxy by configuring the `FACTORY_API` variable in the proxy script.

- **No length limitation**: Any valid URL can be used
- **Use case**: Forward non-search requests to your custom LLM backend

```bash
# Forward to custom backend (no length limit)
npx droid-patch --websearch --api-base "http://127.0.0.1:20002" droid-custom
npx droid-patch --websearch --api-base "http://my-proxy.example.com:3000" droid-custom
```

### `--websearch`

Enables WebSearch functionality through a local proxy server that intercepts `/api/tools/exa/search` requests.

**Purpose**: Enable WebSearch functionality without Factory.ai authentication.

**Features**:

- **Multiple search providers** with automatic fallback
- **Per-instance proxy**: Each droid instance runs its own proxy on an auto-assigned port
- **Auto-cleanup**: Proxy automatically stops when droid exits
- **Forward target**: Use `--api-base` with `--websearch` to forward non-search requests to a custom backend

**Usage**:

```bash
# Create alias with websearch (uses official Factory API)
npx droid-patch --websearch droid-search

# Create alias with websearch + custom backend
npx droid-patch --websearch --api-base=http://127.0.0.1:20002 droid-custom

# Just run it - everything is automatic!
droid-search
```

### `--reasoning-effort`

Enables reasoning effort control for custom models by patching the binary to:

1. Set `supportedReasoningEfforts` from `["none"]` to `["high"]`
2. Set `defaultReasoningEffort` from `"none"` to `"high"`
3. Enable the reasoning effort UI selector (normally hidden for custom models)
4. Bypass validation to allow `xhigh` via settings.json

**Purpose**: Allow custom models to use reasoning effort features that are normally only available for official models.

**How it works**:

- The droid UI shows a reasoning effort selector when `supportedReasoningEfforts.length > 1`
- Custom models are hardcoded with `["none"]`, hiding the selector
- This patch changes the value to `["high"]` and modifies the UI condition to show the selector
- The reasoning effort setting will be sent to your custom model's API

**Usage**:

```bash
# Enable reasoning effort for custom models
npx droid-patch --reasoning-effort droid-reasoning

# Combine with other patches
npx droid-patch --is-custom --reasoning-effort droid-full
```

**Configuring `xhigh` Reasoning Effort**:

The default reasoning effort is `high`. To use `xhigh` (extra high), edit your settings file:

```bash
# Edit ~/.factory/settings.json
{
  "model": "custom:Your-Model-0",
  "reasoningEffort": "xhigh",
  // ... other settings
}
```

Available values:
| Value | Description |
|-------|-------------|
| `high` | High reasoning effort (default after patching) |
| `xhigh` | Extra high reasoning effort |
| `medium` | Medium reasoning effort |
| `low` | Low reasoning effort |

**Note**: The `xhigh` value bypasses validation and is sent directly to your API. Make sure your custom model/proxy supports this parameter.

### `--standalone`

Enables standalone mode when used with `--websearch`. In this mode, non-LLM Factory APIs are mocked locally instead of being forwarded to Factory servers.

**Purpose**: Reduce unnecessary network requests and enable fully local operation (except for LLM API calls).

**How it works**:

- **Whitelist approach**: Only `/api/llm/a/*` (Anthropic) and `/api/llm/o/*` (OpenAI) are forwarded to upstream
- All other Factory APIs are mocked:
  - `/api/sessions/create` → Returns unique local session ID
  - `/api/cli/whoami` → Returns 401 (triggers local token fallback)
  - `/api/tools/get-url-contents` → Returns 404 (triggers local URL fetch)
  - Other APIs → Returns empty `{}` response

**Usage**:

```bash
# Standalone mode with websearch
npx droid-patch --websearch --standalone droid-local

# Combine with other patches for fully local setup
npx droid-patch --is-custom --skip-login --websearch --standalone droid-full-local
```

### `--disable-telemetry`

Disables telemetry data uploads and Sentry error reporting.

**Purpose**: Prevent droid from sending usage data and error reports to Factory servers.

**How it works**:

- Breaks Sentry environment variable checks (`ENABLE_SENTRY`, `VITE_VERCEL_ENV`)
- Makes `flushToWeb()` always return early, preventing any telemetry fetch requests

**Usage**:

```bash
# Disable telemetry only
npx droid-patch --disable-telemetry droid-private

# Combine with other patches
npx droid-patch --is-custom --skip-login --disable-telemetry droid-private
```

---

## WebSearch Configuration Guide

The `--websearch` feature supports multiple search providers. Configure them using environment variables in your shell config (`~/.zshrc`, `~/.bashrc`, etc.).

### Search Provider Priority

The proxy tries providers in this order and uses the first one that succeeds:

| Priority | Provider     | Quality   | Free Tier             | Setup Difficulty |
| -------- | ------------ | --------- | --------------------- | ---------------- |
| 1        | Smithery Exa | Excellent | Free (via Smithery)   | Easy             |
| 2        | Google PSE   | Very Good | 10,000/day            | Medium           |
| 3        | Serper       | Very Good | 2,500 free credits    | Easy             |
| 4        | Brave Search | Good      | 2,000/month           | Easy             |
| 5        | SearXNG      | Good      | Unlimited (self-host) | Hard             |
| 6        | DuckDuckGo   | Basic     | Unlimited             | None             |

---

## 1. Smithery Exa (Recommended)

[Smithery Exa](https://smithery.ai/server/exa) provides high-quality semantic search results through the MCP protocol. Smithery acts as a free proxy to the Exa search API.

### Setup Steps

1. **Create a Smithery Account**
   - Go to [smithery.ai](https://smithery.ai)
   - Sign up for a free account

2. **Get Your API Key**
   - Navigate to your account settings
   - Copy your API key

3. **Get Your Profile ID**
   - Go to [smithery.ai/server/exa](https://smithery.ai/server/exa)
   - Your profile ID is shown in the connection URL or settings

4. **Configure Environment Variables**
   ```bash
   # Add to ~/.zshrc or ~/.bashrc
   export SMITHERY_API_KEY="your_api_key_here"
   export SMITHERY_PROFILE="your_profile_id"
   ```

### Pricing

- **Free** through Smithery (Smithery proxies the Exa API at no cost)
- Note: The official Exa API (exa.ai) is paid, but Smithery provides free access

---

## 2. Google Programmable Search Engine (PSE)

Google PSE provides high-quality search results with a generous free tier.

### Setup Steps

#### Step 1: Create a Programmable Search Engine

1. Go to [Google Programmable Search Engine Console](https://cse.google.com/all)
2. Click **"Add"** to create a new search engine
3. Configure:
   - **Sites to search**: Enter `*` to search the entire web
   - **Name**: Give it a descriptive name (e.g., "Web Search")
4. Click **"Create"**
5. Click **"Control Panel"** for your new search engine
6. Copy the **Search engine ID (cx)** - looks like `017576662512468239146:omuauf_lfve`

#### Step 2: Get an API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the **Custom Search API**:
   - Go to **"APIs & Services"** > **"Library"**
   - Search for **"Custom Search API"**
   - Click **"Enable"**
4. Create credentials:
   - Go to **"APIs & Services"** > **"Credentials"**
   - Click **"Create Credentials"** > **"API Key"**
   - Copy the API key

#### Step 3: Configure Environment Variables

```bash
# Add to ~/.zshrc or ~/.bashrc
export GOOGLE_PSE_API_KEY="AIzaSy..."        # Your API key
export GOOGLE_PSE_CX="017576662512468239146:omuauf_lfve"  # Your Search engine ID
```

### Free Tier Limits

- **10,000 queries/day** free
- Max 10 results per query
- After limit: $5 per 1,000 queries

---

## 3. Serper

[Serper](https://serper.dev) provides Google search results through an easy-to-use API.

### Setup Steps

1. **Create an Account**
   - Go to [serper.dev](https://serper.dev)
   - Sign up for a free account

2. **Get Your API Key**
   - After signing in, your API key is displayed on the dashboard
   - Copy the API key

3. **Configure Environment Variable**
   ```bash
   # Add to ~/.zshrc or ~/.bashrc
   export SERPER_API_KEY="your_api_key_here"
   ```

### Free Tier

- **2,500 free credits** on signup
- 1 credit = 1 search query
- Paid plans available for more usage

---

## 4. Brave Search

[Brave Search API](https://brave.com/search/api/) provides privacy-focused search results.

### Setup Steps

1. **Create an Account**
   - Go to [brave.com/search/api](https://brave.com/search/api/)
   - Click **"Get Started"**

2. **Subscribe to a Plan**
   - Choose the **Free** plan (2,000 queries/month)
   - Or a paid plan for more queries

3. **Get Your API Key**
   - Go to your API dashboard
   - Copy your API key

4. **Configure Environment Variable**
   ```bash
   # Add to ~/.zshrc or ~/.bashrc
   export BRAVE_API_KEY="BSA..."
   ```

### Free Tier

- **2,000 queries/month** free
- Rate limit: 1 query/second
- Paid plans start at $5/month for 20,000 queries

---

## 5. SearXNG (Self-Hosted)

[SearXNG](https://github.com/searxng/searxng) is a free, privacy-respecting metasearch engine you can self-host.

### Setup Steps

#### Option A: Use a Public Instance

You can use a public SearXNG instance, but availability and reliability vary.

```bash
# Example public instance (check if it's available)
export SEARXNG_URL="https://searx.be"
```

Find public instances at [searx.space](https://searx.space/)

#### Option B: Self-Host with Docker

1. **Run SearXNG with Docker**

   ```bash
   docker run -d \
     --name searxng \
     -p 8080:8080 \
     -e SEARXNG_BASE_URL=http://localhost:8080 \
     searxng/searxng
   ```

2. **Configure Environment Variable**
   ```bash
   # Add to ~/.zshrc or ~/.bashrc
   export SEARXNG_URL="http://localhost:8080"
   ```

### Advantages

- Unlimited searches
- No API key required
- Privacy-focused
- Aggregates results from multiple search engines

### Disadvantages

- Requires self-hosting for reliability
- Public instances may be slow or unavailable

---

## 6. DuckDuckGo (Default Fallback)

DuckDuckGo is used automatically as the final fallback when no other providers are configured or available.

### Configuration

**No configuration required!** DuckDuckGo works out of the box.

### Limitations

- HTML scraping (less reliable than API)
- Basic results compared to other providers
- May be rate-limited with heavy use

---

## Quick Configuration Examples

### Minimal Setup (Free, No API Keys)

Just use DuckDuckGo fallback:

```bash
npx droid-patch --websearch droid-search
droid-search  # Works immediately with DuckDuckGo
```

### Recommended Setup (Best Quality)

```bash
# Add to ~/.zshrc or ~/.bashrc
export SMITHERY_API_KEY="your_smithery_key"
export SMITHERY_PROFILE="your_profile_id"

# Fallback: Google PSE
export GOOGLE_PSE_API_KEY="your_google_key"
export GOOGLE_PSE_CX="your_search_engine_id"
```

### Budget-Friendly Setup (All Free)

```bash
# Add to ~/.zshrc or ~/.bashrc

# Option 1: Google PSE (10,000/day free)
export GOOGLE_PSE_API_KEY="your_google_key"
export GOOGLE_PSE_CX="your_search_engine_id"

# Option 2: Serper (2,500 free credits)
export SERPER_API_KEY="your_serper_key"

# Option 3: Brave (2,000/month free)
export BRAVE_API_KEY="your_brave_key"

# DuckDuckGo is always available as final fallback
```

---

## Debug Mode

Enable detailed logging to troubleshoot search issues:

```bash
export DROID_SEARCH_DEBUG=1
droid-search
```

---

## Examples

```bash
# Quick start: create droid with websearch
npx droid-patch --websearch droid-search
droid-search  # Just works!

# Full-featured droid
npx droid-patch --is-custom --skip-login --websearch --reasoning-effort droid-full

# Standalone mode: websearch + mock non-LLM APIs
npx droid-patch --websearch --standalone droid-local

# Privacy mode: disable telemetry
npx droid-patch --disable-telemetry droid-private

# Full local setup: all features combined
npx droid-patch --is-custom --skip-login --websearch --standalone --disable-telemetry droid-full-local

# Websearch with custom backend
npx droid-patch --websearch --api-base=http://127.0.0.1:20002 droid-custom

# Create a standalone patched binary in current directory
npx droid-patch --skip-login -o . my-droid
./my-droid --version

# List all aliases with version info
npx droid-patch list

# Clean up
npx droid-patch remove droid-search              # remove single alias
npx droid-patch remove --flag=websearch          # remove all websearch aliases
npx droid-patch remove --flag=standalone         # remove all standalone aliases
npx droid-patch remove --patch-version=0.4.0     # remove by droid-patch version
npx droid-patch clear                            # remove everything
```

## License

MIT
