# droid-patch

[English](./README.md) | 简体中文

用于修补 droid 二进制文件的 CLI 工具。

## 安装

```bash
npm install -g droid-patch
# 或直接使用 npx
npx droid-patch --help
```

## 使用方法

### 修补并创建别名

```bash
# 使用 --is-custom 修补并创建别名
npx droid-patch --is-custom droid-custom

# 使用 --skip-login 跳过登录验证
npx droid-patch --skip-login droid-nologin

# 使用 --websearch 启用本地搜索代理
npx droid-patch --websearch droid-search

# 使用 --websearch --standalone 启用完全本地模式（mock 非 LLM API）
npx droid-patch --websearch --standalone droid-local

# 使用 --reasoning-effort 为自定义模型启用推理功能
npx droid-patch --reasoning-effort droid-reasoning

# 组合多个修补选项
npx droid-patch --is-custom --skip-login --websearch --reasoning-effort droid-full

# 指定 droid 二进制文件路径
npx droid-patch --skip-login -p /path/to/droid my-droid

# 试运行 - 验证修补但不实际修改文件
npx droid-patch --skip-login --dry-run droid

# 详细输出
npx droid-patch --skip-login -v droid
```

### 输出到指定目录

```bash
# 输出修补后的二进制文件到当前目录
npx droid-patch --skip-login -o . my-droid

# 输出到指定目录
npx droid-patch --skip-login -o /path/to/dir my-droid
```

### 可用选项

| 选项                  | 说明                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `--is-custom`         | 将 `isCustom:!0` 修改为 `isCustom:!1`（为自定义模型启用上下文压缩） |
| `--skip-login`        | 通过注入假的 `FACTORY_API_KEY` 跳过登录验证                         |
| `--api-base <url>`    | 将 Factory API URL 替换为自定义服务器（最多 22 个字符）             |
| `--websearch`         | 注入本地 WebSearch 代理，支持多个搜索提供商                         |
| `--standalone`        | 独立模式：mock 非 LLM 的 Factory API（与 `--websearch` 配合使用）   |
| `--reasoning-effort`  | 为自定义模型启用推理强度 UI 选择器（设置为 high）                   |
| `--disable-telemetry` | 禁用遥测数据上传和 Sentry 错误报告                                  |
| `--dry-run`           | 验证修补但不实际修改二进制文件                                      |
| `-p, --path <path>`   | droid 二进制文件路径（默认：`~/.droid/bin/droid`）                  |
| `-o, --output <dir>`  | 修补后二进制文件的输出目录（直接创建文件，不创建别名）              |
| `--no-backup`         | 跳过创建原始二进制文件的备份                                        |
| `-v, --verbose`       | 启用详细输出                                                        |

### 管理别名和文件

```bash
# 列出所有别名（显示版本、flags、创建时间）
npx droid-patch list

# 删除别名
npx droid-patch remove <alias-name>

# 通过路径删除修补后的二进制文件
npx droid-patch remove ./my-droid
npx droid-patch remove /path/to/patched-binary

# 按条件删除别名
npx droid-patch remove --patch-version=0.4.0     # 按 droid-patch 版本
npx droid-patch remove --droid-version=1.0.40    # 按 droid 版本
npx droid-patch remove --flag=websearch          # 按功能 flag

# 清除所有 droid-patch 数据（别名、二进制文件、元数据）
npx droid-patch clear
```

### 更新别名

当原始 droid 二进制文件更新后，可以重新为所有别名应用补丁：

```bash
# 更新所有别名
npx droid-patch update

# 更新指定别名
npx droid-patch update <alias-name>

# 预览（不实际更新）
npx droid-patch update --dry-run

# 使用不同的 droid 二进制文件
npx droid-patch update -p /path/to/new/droid
```

update 命令会读取创建别名时保存的元数据，自动重新应用相同的补丁。

### 检查版本

```bash
npx droid-patch version
```

## PATH 配置

创建别名时（不使用 `-o`），工具会尝试安装到已在 PATH 中的目录（如 `~/.local/bin`）。如果不可用，需要将别名目录添加到 PATH：

```bash
# 添加到 shell 配置文件（~/.zshrc、~/.bashrc 等）
export PATH="$HOME/.droid-patch/aliases:$PATH"
```

## 工作原理

1. **修补**：工具在 droid 二进制文件中搜索特定的字节模式，并用等长的替换内容进行替换
2. **创建别名**（不使用 `-o`）：
   - 将修补后的二进制文件复制到 `~/.droid-patch/bins/`
   - 在 PATH 目录或 `~/.droid-patch/aliases/` 中创建符号链接
   - 在 macOS 上，自动使用 `codesign` 重新签名二进制文件
3. **直接输出**（使用 `-o`）：
   - 将修补后的二进制文件直接保存到指定目录
   - 在 macOS 上，自动使用 `codesign` 重新签名二进制文件

## 可用的修补选项

### `--is-custom`

将 `isCustom:!0`（true）改为 `isCustom:!1`（false）。

**用途**：为自定义模型启用上下文压缩（自动摘要）功能，该功能通常仅对官方模型可用。

**注意**：副作用未知 - 在生产环境使用前请充分测试。

### `--skip-login`

将二进制文件中所有 `process.env.FACTORY_API_KEY` 引用替换为硬编码的假密钥 `"fk-droid-patch-skip-00000"`。

**用途**：无需设置 `FACTORY_API_KEY` 环境变量即可跳过登录/认证要求。

**工作原理**：

- 原始代码通过检查 `process.env.FACTORY_API_KEY` 进行认证
- 修补后，代码直接使用假密钥字符串，绕过环境变量检查
- 这是二进制级别的修补，因此在所有终端会话中都有效，无需任何环境设置

### `--api-base <url>`

将 Factory API 基础 URL（`https://api.factory.ai`）替换为自定义 URL。

**用途**：将 API 请求重定向到自定义服务器（如本地代理）。

**限制**：URL 必须不超过 22 个字符（与原始 URL 长度相同）。

**示例**：

```bash
# 有效的 URL（<=22 个字符）
npx droid-patch --api-base "http://127.0.0.1:3000" droid-local
npx droid-patch --api-base "http://localhost:80" droid-local

# 无效（太长）
npx droid-patch --api-base "http://my-long-domain.com:3000" droid  # 错误！
```

### `--websearch`

通过本地代理服务器启用 WebSearch 功能，拦截 `/api/tools/exa/search` 请求。

**用途**：无需 Factory.ai 认证即可使用 WebSearch 功能。

**特性**：

- **多搜索提供商**：支持自动降级
- **每实例独立代理**：每个 droid 实例运行自己的代理，自动分配端口
- **自动清理**：droid 退出时代理自动停止
- **转发目标**：使用 `--api-base` 配合 `--websearch` 可将非搜索请求转发到自定义后端

**使用方法**：

```bash
# 创建带 websearch 的别名（使用官方 Factory API）
npx droid-patch --websearch droid-search

# 创建带 websearch + 自定义后端的别名
npx droid-patch --websearch --api-base=http://127.0.0.1:20002 droid-custom

# 直接运行 - 一切都是自动的！
droid-search
```

### `--reasoning-effort`

通过修补二进制文件为自定义模型启用推理强度控制：

1. 将 `supportedReasoningEfforts` 从 `["none"]` 改为 `["high"]`
2. 将 `defaultReasoningEffort` 从 `"none"` 改为 `"high"`
3. 启用推理强度 UI 选择器（通常对自定义模型隐藏）
4. 绕过验证以允许通过 settings.json 设置 `xhigh`

**用途**：允许自定义模型使用通常仅对官方模型可用的推理强度功能。

**工作原理**：

- 当 `supportedReasoningEfforts.length > 1` 时，droid UI 会显示推理强度选择器
- 自定义模型硬编码为 `["none"]`，隐藏了选择器
- 此补丁将值改为 `["high"]` 并修改 UI 条件以显示选择器
- 推理强度设置将发送到您的自定义模型 API

**使用方法**：

```bash
# 为自定义模型启用推理强度
npx droid-patch --reasoning-effort droid-reasoning

# 与其他补丁组合使用
npx droid-patch --is-custom --reasoning-effort droid-full
```

**配置 `xhigh` 推理强度**：

默认推理强度为 `high`。要使用 `xhigh`（超高），请编辑设置文件：

```bash
# 编辑 ~/.factory/settings.json
{
  "model": "custom:Your-Model-0",
  "reasoningEffort": "xhigh",
  // ... 其他设置
}
```

可用的值：
| 值 | 描述 |
|-------|-------------|
| `high` | 高推理强度（补丁后的默认值） |
| `xhigh` | 超高推理强度 |
| `medium` | 中等推理强度 |
| `low` | 低推理强度 |

**注意**：`xhigh` 值会绕过验证直接发送到 API。请确保您的自定义模型/代理支持此参数。

### `--standalone`

与 `--websearch` 配合使用时启用独立模式。在此模式下，非 LLM 的 Factory API 会在本地 mock，而不是转发到 Factory 服务器。

**用途**：减少不必要的网络请求，实现完全本地化运行（LLM API 调用除外）。

**工作原理**：

- **白名单方式**：只有 `/api/llm/a/*`（Anthropic）和 `/api/llm/o/*`（OpenAI）会转发到上游
- 其他所有 Factory API 都会被 mock：
  - `/api/sessions/create` → 返回唯一的本地 session ID
  - `/api/cli/whoami` → 返回 401（触发本地 token 回退）
  - `/api/tools/get-url-contents` → 返回 404（触发本地 URL 获取）
  - 其他 API → 返回空 `{}` 响应

**使用方法**：

```bash
# 独立模式 + websearch
npx droid-patch --websearch --standalone droid-local

# 与其他补丁组合实现完全本地化
npx droid-patch --is-custom --skip-login --websearch --standalone droid-full-local
```

### `--disable-telemetry`

禁用遥测数据上传和 Sentry 错误报告。

**用途**：阻止 droid 向 Factory 服务器发送使用数据和错误报告。

**工作原理**：

- 破坏 Sentry 环境变量检查（`ENABLE_SENTRY`、`VITE_VERCEL_ENV`）
- 使 `flushToWeb()` 始终提前返回，阻止任何遥测 fetch 请求

**使用方法**：

```bash
# 仅禁用遥测
npx droid-patch --disable-telemetry droid-private

# 与其他补丁组合
npx droid-patch --is-custom --skip-login --disable-telemetry droid-private
```

---

## WebSearch 配置指南

`--websearch` 功能支持多个搜索提供商。通过 shell 配置文件（`~/.zshrc`、`~/.bashrc` 等）中的环境变量进行配置。

### 搜索提供商优先级

代理按以下顺序尝试提供商，使用第一个成功的：

| 优先级 | 提供商       | 质量 | 免费额度              | 设置难度 |
| ------ | ------------ | ---- | --------------------- | -------- |
| 1      | Smithery Exa | 优秀 | 免费（通过 Smithery） | 简单     |
| 2      | Google PSE   | 很好 | 10,000 次/天          | 中等     |
| 3      | Serper       | 很好 | 2,500 免费额度        | 简单     |
| 4      | Brave Search | 好   | 2,000 次/月           | 简单     |
| 5      | SearXNG      | 好   | 无限（自托管）        | 较难     |
| 6      | DuckDuckGo   | 基本 | 无限                  | 无需配置 |

---

## 1. Smithery Exa（推荐）

[Smithery Exa](https://smithery.ai/server/exa) 通过 MCP 协议提供高质量的语义搜索结果。Smithery 作为 Exa 搜索 API 的免费代理。

### 设置步骤

1. **创建 Smithery 账号**
   - 访问 [smithery.ai](https://smithery.ai)
   - 注册免费账号

2. **获取 API Key**
   - 进入账号设置
   - 复制 API key

3. **获取 Profile ID**
   - 访问 [smithery.ai/server/exa](https://smithery.ai/server/exa)
   - Profile ID 显示在连接 URL 或设置中

4. **配置环境变量**
   ```bash
   # 添加到 ~/.zshrc 或 ~/.bashrc
   export SMITHERY_API_KEY="your_api_key_here"
   export SMITHERY_PROFILE="your_profile_id"
   ```

### 价格

- 通过 Smithery **免费**（Smithery 免费代理 Exa API）
- 注意：官方 Exa API (exa.ai) 是收费的，但通过 Smithery 可以免费使用

---

## 2. Google 可编程搜索引擎 (PSE)

Google PSE 提供高质量的搜索结果，免费额度充足。

### 设置步骤

#### 第一步：创建可编程搜索引擎

1. 访问 [Google 可编程搜索引擎控制台](https://cse.google.com/all)
2. 点击 **"添加"** 创建新的搜索引擎
3. 配置：
   - **要搜索的网站**：输入 `*` 以搜索整个网络
   - **名称**：给它一个描述性的名称（如 "Web Search"）
4. 点击 **"创建"**
5. 点击新搜索引擎的 **"控制面板"**
6. 复制 **搜索引擎 ID (cx)** - 格式类似 `017576662512468239146:omuauf_lfve`

#### 第二步：获取 API Key

1. 访问 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建新项目或选择现有项目
3. 启用 **Custom Search API**：
   - 进入 **"API 和服务"** > **"库"**
   - 搜索 **"Custom Search API"**
   - 点击 **"启用"**
4. 创建凭据：
   - 进入 **"API 和服务"** > **"凭据"**
   - 点击 **"创建凭据"** > **"API 密钥"**
   - 复制 API 密钥

#### 第三步：配置环境变量

```bash
# 添加到 ~/.zshrc 或 ~/.bashrc
export GOOGLE_PSE_API_KEY="AIzaSy..."        # 你的 API 密钥
export GOOGLE_PSE_CX="017576662512468239146:omuauf_lfve"  # 你的搜索引擎 ID
```

### 免费额度限制

- 每天 **10,000 次查询** 免费
- 每次查询最多 10 个结果
- 超出后：每 1,000 次查询 $5

---

## 3. Serper

[Serper](https://serper.dev) 通过易用的 API 提供 Google 搜索结果。

### 设置步骤

1. **创建账号**
   - 访问 [serper.dev](https://serper.dev)
   - 注册免费账号

2. **获取 API Key**
   - 登录后，API key 显示在仪表板上
   - 复制 API key

3. **配置环境变量**
   ```bash
   # 添加到 ~/.zshrc 或 ~/.bashrc
   export SERPER_API_KEY="your_api_key_here"
   ```

### 免费额度

- 注册时获得 **2,500 免费额度**
- 1 额度 = 1 次搜索查询
- 可购买付费计划获得更多用量

---

## 4. Brave Search

[Brave Search API](https://brave.com/search/api/) 提供注重隐私的搜索结果。

### 设置步骤

1. **创建账号**
   - 访问 [brave.com/search/api](https://brave.com/search/api/)
   - 点击 **"开始使用"**

2. **订阅计划**
   - 选择 **免费** 计划（每月 2,000 次查询）
   - 或付费计划以获得更多查询次数

3. **获取 API Key**
   - 进入 API 仪表板
   - 复制 API key

4. **配置环境变量**
   ```bash
   # 添加到 ~/.zshrc 或 ~/.bashrc
   export BRAVE_API_KEY="BSA..."
   ```

### 免费额度

- 每月 **2,000 次查询** 免费
- 速率限制：每秒 1 次查询
- 付费计划起价 $5/月，20,000 次查询

---

## 5. SearXNG（自托管）

[SearXNG](https://github.com/searxng/searxng) 是一个免费、注重隐私的元搜索引擎，可以自托管。

### 设置步骤

#### 选项 A：使用公共实例

可以使用公共 SearXNG 实例，但可用性和可靠性不稳定。

```bash
# 公共实例示例（请检查是否可用）
export SEARXNG_URL="https://searx.be"
```

在 [searx.space](https://searx.space/) 查找公共实例

#### 选项 B：使用 Docker 自托管

1. **使用 Docker 运行 SearXNG**

   ```bash
   docker run -d \
     --name searxng \
     -p 8080:8080 \
     -e SEARXNG_BASE_URL=http://localhost:8080 \
     searxng/searxng
   ```

2. **配置环境变量**
   ```bash
   # 添加到 ~/.zshrc 或 ~/.bashrc
   export SEARXNG_URL="http://localhost:8080"
   ```

### 优点

- 无限搜索
- 不需要 API 密钥
- 注重隐私
- 聚合多个搜索引擎的结果

### 缺点

- 需要自托管才能保证可靠性
- 公共实例可能较慢或不可用

---

## 6. DuckDuckGo（默认备用）

当没有配置其他提供商或其他提供商不可用时，自动使用 DuckDuckGo 作为最终备用。

### 配置

**无需配置！** DuckDuckGo 开箱即用。

### 限制

- HTML 抓取（不如 API 可靠）
- 与其他提供商相比结果较基础
- 大量使用可能被限速

---

## 快速配置示例

### 最简设置（免费，无需 API Key）

直接使用 DuckDuckGo 备用：

```bash
npx droid-patch --websearch droid-search
droid-search  # 立即使用 DuckDuckGo 工作
```

### 推荐设置（最佳质量）

```bash
# 添加到 ~/.zshrc 或 ~/.bashrc
export SMITHERY_API_KEY="your_smithery_key"
export SMITHERY_PROFILE="your_profile_id"

# 备用：Google PSE
export GOOGLE_PSE_API_KEY="your_google_key"
export GOOGLE_PSE_CX="your_search_engine_id"
```

### 经济实惠设置（全免费）

```bash
# 添加到 ~/.zshrc 或 ~/.bashrc

# 选项 1：Google PSE（每天 10,000 次免费）
export GOOGLE_PSE_API_KEY="your_google_key"
export GOOGLE_PSE_CX="your_search_engine_id"

# 选项 2：Serper（2,500 免费额度）
export SERPER_API_KEY="your_serper_key"

# 选项 3：Brave（每月 2,000 次免费）
export BRAVE_API_KEY="your_brave_key"

# DuckDuckGo 始终作为最终备用可用
```

---

## 调试模式

启用详细日志以排查搜索问题：

```bash
export DROID_SEARCH_DEBUG=1
droid-search
```

---

## 示例

```bash
# 快速开始：创建带 websearch 的 droid
npx droid-patch --websearch droid-search
droid-search  # 直接使用！

# 全功能 droid
npx droid-patch --is-custom --skip-login --websearch --reasoning-effort droid-full

# 独立模式：websearch + mock 非 LLM API
npx droid-patch --websearch --standalone droid-local

# 隐私模式：禁用遥测
npx droid-patch --disable-telemetry droid-private

# 完全本地化：所有功能组合
npx droid-patch --is-custom --skip-login --websearch --standalone --disable-telemetry droid-full-local

# websearch + 自定义后端
npx droid-patch --websearch --api-base=http://127.0.0.1:20002 droid-custom

# 在当前目录创建独立的修补后二进制文件
npx droid-patch --skip-login -o . my-droid
./my-droid --version

# 列出所有别名及版本信息
npx droid-patch list

# 清理
npx droid-patch remove droid-search              # 删除单个别名
npx droid-patch remove --flag=websearch          # 删除所有 websearch 别名
npx droid-patch remove --flag=standalone         # 删除所有 standalone 别名
npx droid-patch remove --patch-version=0.4.0     # 按 droid-patch 版本删除
npx droid-patch clear                            # 删除所有
```

## 许可证

MIT
