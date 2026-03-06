[English](README.md) | 中文

# Clian

[![GitHub stars](https://img.shields.io/github/stars/FutureUnreal/clian?style=social)](https://github.com/FutureUnreal/clian)
[![GitHub release](https://img.shields.io/github/v/release/FutureUnreal/clian)](https://github.com/FutureUnreal/clian/releases/latest)
[![License](https://img.shields.io/github/license/FutureUnreal/clian)](LICENSE)


本项目基于 [Claudian](https://github.com/YishenTu/claudian) 进行二次开发，感谢 [YishenTu](https://github.com/YishenTu) 和 Claudian 项目提供的原始基础与灵感，并在此基础上额外支持了 Codex、Gemini 和安卓端。

## 功能特性

- **完整代理能力**：充分发挥 Claude Code 的能力，在 Obsidian Vault 中读取、写入和编辑文件，执行搜索与 Bash 命令。
- **多引擎支持**：在 Claude、Codex 和 Gemini 之间切换——每个引擎拥有独立标签页、模型选择器和专属设置（思考预算、推理力度等）。
- **多标签界面**：并行运行多个对话标签（3–10 个，可配置）。通过命令面板或工具栏打开引擎专属标签。
- **上下文感知**：自动附加当前聚焦的笔记，通过 `@` 提及其他文件，自动包含编辑器或 Canvas 选中内容，按标签排除笔记，挂载外部目录作为额外上下文。
- **视觉支持**：通过拖放、粘贴或输入路径的方式发送图片并进行分析。
- **内联编辑**：直接在笔记中编辑选中文字或在光标处插入内容，支持词级差异预览。
- **指令模式（`#`）**：在聊天输入框中直接向系统提示词添加自定义精细指令。
- **斜杠命令**：创建可复用的提示词模板，通过 `/命令` 触发，支持参数占位符、`@文件` 引用以及可选的内联 Bash 替换。
- **内置命令**：`/clear`（别名 `/new`）、`/add-dir [路径]`、`/resume`、`/fork` — 内置于斜杠命令下拉菜单中。
- **Bang-Bash 模式（`!`）**：在空输入框输入 `!` 可直接执行 bash 命令，绕过 AI（需在设置中开启）。
- **技能（Skills）**：通过可复用的能力模块扩展 Clian，与 Claude Code 的技能格式兼容。
- **自定义代理**：定义可供 Claude 调用的自定义子代理，支持工具限制和模型覆盖；通过 `@Agents/` 提及调用。
- **Claude Code 插件**：自动从 `~/.claude/plugins` 发现并启用插件，支持按 Vault 配置。
- **MCP 支持**：通过模型上下文协议（MCP）服务器（支持 stdio、SSE、HTTP）连接外部工具，支持上下文保存模式。
- **计划模式**：按 Shift+Tab 切换——Clian 先探索再实施，提交计划供审批（批准 / 继续 / 反馈 / 新会话）。
- **安全性**：权限模式（YOLO/安全/计划），安全指令黑名单，以及基于 `realpath` 的 Vault 隔离。
- **国际化**：插件 UI 支持 10 种语言（English, 中文简体, 中文繁體, 日本語, 한국어, Deutsch, Français, Español, Русский, Português）。
- **Chrome 中的 Claude**：允许 Claude 通过 `claude-in-chrome` 扩展与 Chrome 交互。

## 系统要求

- 已安装 [Claude Code CLI](https://code.claude.com/docs/en/overview)（强烈建议通过原生安装方式安装）
- Obsidian v1.8.9+（最低支持：v1.4.5）
- Claude 订阅/API，或支持 Anthropic API 格式的自定义模型提供商（[Openrouter](https://openrouter.ai/docs/guides/guides/claude-code-integration)、[Kimi](https://platform.moonshot.ai/docs/guide/agent-support)、[智谱 GLM](https://docs.z.ai/devpack/tool/claude)、[DeepSeek](https://api-docs.deepseek.com/guides/anthropic_api) 等）
- **使用 Codex**：需安装 `codex` CLI + `OPENAI_API_KEY`
- **使用 Gemini**：需安装 `gemini` CLI 并完成认证
- **桌面端（macOS、Linux、Windows）**：完整的本地 Claude Code 集成（CLI + 代理工具）。
- **移动端（Android/iOS）**：独立的移动端插件 + Hub 服务器 — 详见 [移动端与 Hub](#移动端与-hub)。

## 安装方式

### 从 GitHub Release 下载（推荐）

1. 从 [最新版本页面](https://github.com/FutureUnreal/clian/releases/latest) 下载 `main.js`、`manifest.json` 和 `styles.css`
2. 在你的 Vault 插件文件夹中创建 `clian` 目录：
   ```
   /path/to/vault/.obsidian/plugins/clian/
   ```
3. 将下载的文件复制到该目录中
4. 在 Obsidian 中启用插件：
   - 设置 → 社区插件 → 启用"Clian"

### 通过 BRAT 安装

[BRAT](https://github.com/TfTHacker/obsidian42-brat) 允许你直接从 GitHub 安装并自动更新插件。

1. 从 Obsidian 社区插件市场安装 BRAT 插件
2. 在设置 → 社区插件中启用 BRAT
3. 打开 BRAT 设置，点击"Add Beta plugin"
4. 输入：`https://github.com/FutureUnreal/clian`
5. 点击"Add Plugin"，BRAT 将自动安装 Clian
6. 在设置 → 社区插件中启用 Clian

> **提示**：BRAT 会自动检查更新，并在新版本发布时通知你。

### 开发者安装

1. 将此仓库克隆到你的 Vault 插件文件夹中（需要 Node.js 22）：
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/FutureUnreal/clian.git clian
   cd clian
   ```

2. 安装依赖并构建：
   ```bash
   npm install
   npm run build
   ```

3. 在 Obsidian 中启用插件：
   - 设置 → 社区插件 → 启用"Clian"

```bash
# 监听模式（保存后自动重新构建）
npm run dev

# 生产构建
npm run build
```

> **提示**：将 `.env.local.example` 复制为 `.env.local`，设置你的 Vault 路径，开发时可自动复制文件。

## 使用方法

**两种模式：**
1. 点击侧边栏的机器人图标、使用命令面板，或按配置的快捷键打开聊天窗口
2. 选中文字（或放置光标）+ 快捷键进行内联编辑

像使用 Claude Code 一样——在 Vault 中读取、写入、编辑和搜索文件。

### 命令面板

所有 Clian 命令均可通过 Obsidian 命令面板（`Ctrl/Cmd+P`）访问：

| 命令 | 描述 |
|------|------|
| `Clian: Open chat view` | 打开聊天侧边栏 |
| `Clian: Inline edit` | 编辑选中文字或在光标处插入内容 |
| `Clian: New tab` | 新建 Claude 标签页 |
| `Clian: New Codex tab` | 新建 Codex 标签页 |
| `Clian: New Gemini tab` | 新建 Gemini 标签页 |
| `Clian: New session (in current tab)` | 在当前标签页开始新会话 |
| `Clian: Close current tab` | 关闭当前标签页 |

### 上下文管理

- **文件**：自动附加当前聚焦的笔记；输入 `@` 可附加其他文件
- **@提及下拉菜单**：输入 `@` 查看 MCP 服务器、代理、外部上下文和 Vault 文件
  - `@Agents/` 显示自定义代理供选择
  - `@mcp-server` 启用支持上下文保存的 MCP 服务器
  - `@folder/` 筛选来自特定外部上下文的文件
- **编辑器选中**：在 Markdown 笔记中选中文字后发起聊天，选中内容会自动包含
- **Canvas 选中**：在 Obsidian Canvas 中选中节点，节点内容会自动包含为上下文
- **图片**：拖放、粘贴或输入路径；配置媒体文件夹以支持 `![[image]]` 嵌入语法
- **外部上下文**：点击工具栏的文件夹图标，访问 Vault 以外的目录；可在设置中配置持久化路径

### 内置斜杠命令

输入 `/` 可查看用户自定义命令和以下内置命令：

| 命令 | 描述 |
|------|------|
| `/clear`（或 `/new`） | 开始新对话 |
| `/add-dir [路径]` | 添加外部目录作为上下文 |
| `/resume` | 恢复之前的对话 |
| `/fork` | 将整个对话分叉到新会话 |

### 功能操作

- **内联编辑**：选中文字 + 快捷键直接在笔记中编辑；或放置光标 + 快捷键在光标处插入。支持词级差异预览（接受/拒绝）。
- **指令模式**：输入 `#` 向系统提示词添加精细指令
- **斜杠命令**：输入 `/` 使用自定义提示词模板或技能（支持参数占位符）
- **Bang-Bash 模式**：在空输入框输入 `!` 可直接运行 bash（绕过 AI）。需在 设置 → 高级 → 启用 Bang-Bash 模式 中开启。输出显示在命令面板中。
- **计划模式**：按 Shift+Tab 切换。Clian 先探索再提交计划，然后你选择：批准、在当前会话继续、提供反馈、或在新会话中批准。
- **分叉对话**：点击任意用户消息上的分叉按钮，或使用 `/fork` 分叉整个对话。可选择在当前或新标签页中打开。
- **技能**：将 `skill/SKILL.md` 文件添加到 `~/.claude/skills/` 或 `{vault}/.claude/skills/`
- **自定义代理**：将 `agent.md` 文件添加到 `~/.claude/agents/`（全局）或 `{vault}/.claude/agents/`（Vault 专属）
- **Claude Code 插件**：通过 设置 → Claude Code 插件 启用
- **MCP**：通过 设置 → MCP 服务器 添加外部工具；在聊天中使用 `@mcp-server` 激活

### 键盘快捷键

| 按键 | 操作 |
|------|------|
| Shift+Tab | 切换计划模式 |
| `i` | 聚焦聊天输入框（当消息区域获得焦点时） |
| `w` | 向上滚动消息（当消息区域获得焦点时） |
| `s` | 向下滚动消息（当消息区域获得焦点时） |
| Esc | 取消流式输出 / 退出 Bang-Bash 模式 / 关闭下拉菜单 |

> `w`/`s`/`i` 是默认按键，可在 设置 → Vim 风格导航映射 中重新配置（如 `map j scrollUp`、`map k scrollDown`）。

## 配置说明

### 设置选项

**个性化**
- **用户名**：用于个性化问候的你的名字
- **排除标签**：阻止笔记自动加载的标签（如 `sensitive`、`private`）
- **媒体文件夹**：配置 Vault 存储附件的位置，用于嵌入图片支持（如 `attachments`）
- **自定义系统提示词**：附加到默认系统提示词末尾的额外指令
- **启用自动滚动**：切换流式输出时是否自动滚动到底部（默认：开启）
- **自动生成对话标题**：在第一条用户消息发送后由 AI 自动生成标题
- **标题生成模型**：用于自动生成对话标题的模型（默认：Auto/Haiku）
- **Vim 风格导航映射**：配置按键绑定，格式如 `map j scrollUp`、`map k scrollDown`、`map i focusInput`
- **语言**：UI 语言；自动跟随 Obsidian 语言设置，或手动选择

**快捷键**
- **内联编辑快捷键**：触发对选中文字进行内联编辑（或光标处插入）的快捷键
- **打开聊天快捷键**：打开聊天侧边栏的快捷键

**斜杠命令**
- 创建/编辑/导入/导出自定义 `/命令`（可选择覆盖模型和允许的工具）
- **隐藏的命令**：填写要从斜杠命令下拉菜单中隐藏的命令名称

**技能 / 自定义代理 / Claude Code 插件**
- 查看和管理已发现的技能、代理和插件

**MCP 服务器**
- 添加/编辑/验证/删除 MCP 服务器配置，支持上下文保存模式

**安全**
- **加载用户 Claude 设置**：加载 `~/.claude/settings.json`
- **启用命令黑名单**：阻止危险的 Bash 命令（默认：开启）
- **被阻止的命令**：要阻止的模式（支持正则表达式，支持平台特定配置）
- **允许的导出路径**：Vault 以外允许导出文件的路径（默认：`~/Desktop`、`~/Downloads`）

**环境变量**
- **自定义变量**：用于 Claude SDK 的环境变量（KEY=VALUE 格式，支持 `export ` 前缀）
- **环境变量片段**：保存和恢复环境变量配置

**高级**
- **启用 1M 上下文窗口**：在模型选择器中显示 Sonnet (1M) 选项（需要 Max 订阅）
- **额外 Claude 模型 ID**：在模型选择器中添加指定的 Claude 模型版本 ID
- **启用 Bang-Bash 模式**：允许 `!` 前缀直接运行 bash（默认禁用；需要 Node.js 在 PATH 中）
- **启用 Chrome 支持**：启用 `claude-in-chrome` 扩展支持（默认禁用）
- **最大标签数**：最多可开启的聊天标签数量（3–10，默认 3）
- **标签栏位置**：标签栏显示在输入框上方（`input`）还是标题栏（`header`）
- **在主编辑区打开聊天**：将聊天面板作为主编辑器标签页打开，而非侧边栏
- **Claude CLI 路径**：每设备的 Claude Code CLI 路径（留空则自动检测）
- **Codex CLI 命令**：每设备的 Codex CLI 命令（默认：`codex`）
- **Gemini CLI 命令**：每设备的 Gemini CLI 命令（默认：`gemini`）

### Claude 设置

- **模型**：从 Haiku、Sonnet、Opus 以及通过环境变量或额外模型 ID 定义的自定义模型中选择
- **思考预算**：关闭 / 低 / 中 / 高 / 最大（扩展思考 token）

### Codex 设置

- **模型**：默认，或选择 gpt-5-codex、gpt-5.1-codex、gpt-5.2-codex 等
- **推理力度**：Low / Med / High / xhigh

### Gemini 设置

- **模型**：默认，或选择 gemini-2.5-pro、gemini-2.5-flash、gemini-3-pro-preview 等
- **思考模式**：Auto / Off / Lite（512 token）/ Default（8k）/ High（16k）/ Unlimited

## 安全与权限

| 作用范围 | 访问权限 |
|---------|---------|
| **Vault** | 完整读写（通过 `realpath` 确保符号链接安全） |
| **导出路径** | 仅写入（如 `~/Desktop`、`~/Downloads`） |
| **外部上下文** | 完整读写（会话级或持久化，通过设置配置） |

- **YOLO 模式**：无审批提示；所有工具调用自动执行（默认）
- **安全模式**：每次工具调用都有审批提示；Bash 需要精确匹配，文件工具允许前缀匹配
- **计划模式**：在实施前先探索并设计方案。在聊天输入框中按 Shift+Tab 切换

## 移动端与 Hub

移动端支持使用**独立的移动端插件**（`src/mobile/`）配合运行在桌面端或服务器上的 **Hub 服务器**。移动端插件通过 HTTP + SSE（Server-Sent Events）实时流式连接 Hub。

### Hub 服务器配置

Hub 支持三种引擎：`claude`、`codex`、`gemini`。

**快速开始**（在插件目录下）：

方案 A — 配置文件：
```bash
cp hub/config.example.json .clian-hub/config.json
# 编辑 token 和 cwd
npm run hub
```

方案 B — 环境变量：

```bash
# macOS / Linux
export CLIAN_HUB_TOKEN=your-secret-token
export CLIAN_HUB_CWD=/path/to/your/vault
export CLIAN_HUB_PORT=3006
npm run hub

# Windows (PowerShell)
$env:CLIAN_HUB_TOKEN="your-secret-token"
$env:CLIAN_HUB_CWD="C:\path\to\vault"
npm run hub
```

> 若未设置 token 且不存在配置文件，Hub 会在**首次启动时自动生成 token** 并打印到控制台。

**在 Obsidian 移动端设置：**
- 设置 → Clian → Hub URL：`http://<你的局域网IP>:3006`
- 设置 → Clian → Hub access token：`your-secret-token`

### Hub 配置参考

**必需：**
| 变量 | 配置键 | 说明 |
|------|--------|------|
| `CLIAN_HUB_TOKEN` | `token` | 共享密钥（Hub 访问令牌） |

**常用：**
| 变量 | 配置键 | 默认值 | 说明 |
|------|--------|--------|------|
| `CLIAN_HUB_CWD` | `cwd` | 进程工作目录 | 新会话的默认工作目录 |
| `CLIAN_HUB_HOST` | `host` | `0.0.0.0` | 监听地址 |
| `CLIAN_HUB_PORT` | `port` | `3006` | 监听端口 |
| `CLIAN_HUB_DATA_DIR` | — | `.clian-hub/` | 存储 `config.json` 和 `state.json` |
| `CLIAN_HUB_DEBUG` | `debug` | `false` | 启用调试日志 |

**文件上传：**
| 变量 | 配置键 | 默认值 | 说明 |
|------|--------|--------|------|
| `CLIAN_HUB_MAX_UPLOAD_BYTES` | — | `20971520`（20MB）| 最大上传文件大小；存储在 `.clian/hub_uploads/` |

**Claude 专属：**
| 变量 | 配置键 | 说明 |
|------|--------|------|
| `CLIAN_HUB_CLAUDE_CODE_PATH` | `claudeCodePath` | Claude Code CLI 路径 |
| `CLIAN_HUB_MODEL` | `model` | 默认 Claude 模型 |
| `CLIAN_HUB_CLAUDE_SETTING_SOURCES` | `claudeSettingSources` | `user,project` — 设为 `project` 可跳过 `~/.claude/settings.json` |

**Codex 专属：**
| 变量 | 配置键 | 默认值 | 说明 |
|------|--------|--------|------|
| `CLIAN_HUB_CODEX_COMMAND` | `codexCommand` | `codex` | Codex CLI 命令 |
| `CLIAN_HUB_CODEX_SANDBOX` | `codexSandbox` | — | 沙箱模式（`read-only`、`workspace-write`） |

**Gemini 专属：**
| 变量 | 配置键 | 默认值 | 说明 |
|------|--------|--------|------|
| `CLIAN_HUB_GEMINI_COMMAND` | `geminiCommand` | `gemini` | Gemini CLI 命令 |
| `CLIAN_HUB_GEMINI_APPROVAL_MODE` | `geminiApprovalMode` | `yolo` | 审批模式 |
| `CLIAN_HUB_GEMINI_SANDBOX` | `geminiSandbox` | `false` | 启用 `--sandbox` |

> **注意**：工具审批（逐工具调用审批/拒绝）仅支持 `claude` 会话。对于 `codex` 和 `gemini`，请使用其沙箱设置控制权限。

> **环境要求**：Node.js 18+。完整开发环境需要 Node.js 22。

详细文档请参阅 [`hub/README.md`](hub/README.md)。

## 隐私与数据使用

- **发送至 API**：你的输入、附加的文件、图片和工具调用输出。默认为 Anthropic；可通过 `ANTHROPIC_BASE_URL` 配置自定义端点。
- **本地存储**：设置、会话元数据和命令存储在 `vault/.claude/` 中；会话消息存储在 `~/.claude/projects/`（SDK 原生）；旧版会话存储在 `vault/.claude/sessions/` 中。
- **无遥测**：除你配置的 API 提供商外，不进行任何追踪。

## 故障排查

### Claude CLI 未找到

如果遇到 `spawn claude ENOENT` 或 `Claude CLI not found` 错误，说明插件无法自动检测到你的 Claude 安装。这在使用 Node 版本管理器（nvm、fnm、volta）时很常见。

**解决方案**：找到你的 CLI 路径，在 设置 → 高级 → Claude CLI 路径 中设置。

| 平台 | 命令 | 示例路径 |
|------|------|---------|
| macOS/Linux | `which claude` | `/Users/you/.volta/bin/claude` |
| Windows（原生） | `where.exe claude` | `C:\Users\you\AppData\Local\Claude\claude.exe` |
| Windows（npm） | `npm root -g` | `{root}\@anthropic-ai\claude-code\cli.js` |

> **注意**：在 Windows 上，避免使用 `.cmd` 包装器。请使用 `claude.exe` 或 `cli.js`。

**替代方案**：在 设置 → 环境变量 → 自定义变量 中将你的 Node.js bin 目录添加到 PATH。

### npm CLI 与 Node.js 不在同一目录

如果使用 npm 安装的 CLI，请检查 `claude` 和 `node` 是否在同一目录中：
```bash
dirname $(which claude)
dirname $(which node)
```

如果不同，Obsidian 等 GUI 应用可能找不到 Node.js。

**解决方案**：
1. 安装原生二进制文件（推荐）
2. 在 设置 → 环境变量 中添加 Node.js 路径：`PATH=/path/to/node/bin`

**问题仍未解决？** [提交 GitHub Issue](https://github.com/FutureUnreal/clian/issues)，请附上你的平台、CLI 路径和错误信息。

## 项目架构

```
src/
├── main.ts                      # 插件入口
├── core/                        # 核心基础设施
│   ├── agent/                   # Claude Agent SDK 封装
│   ├── agents/                  # 自定义代理管理（AgentManager）
│   ├── commands/                # 斜杠命令管理（SlashCommandManager）
│   ├── hooks/                   # PreToolUse/PostToolUse 钩子
│   ├── images/                  # 图片缓存与加载
│   ├── mcp/                     # MCP 服务器配置、服务与测试
│   ├── plugins/                 # Claude Code 插件发现与管理
│   ├── prompts/                 # 代理系统提示词
│   ├── sdk/                     # SDK 消息转换
│   ├── security/                # 审批、黑名单、路径验证
│   ├── storage/                 # 分布式存储系统
│   ├── tools/                   # 工具常量与工具函数
│   └── types/                   # 类型定义
├── features/                    # 功能模块
│   ├── chat/                    # 主聊天视图 + UI、渲染、控制器、标签页
│   ├── inline-edit/             # 内联编辑服务 + UI
│   └── settings/                # 设置面板 UI
├── mobile/                      # 移动端插件（独立插件入口）
├── shared/                      # 共享 UI 组件与弹窗
│   ├── components/              # 输入工具栏、下拉菜单、选中高亮
│   ├── mention/                 # @提及下拉控制器
│   ├── modals/                  # 指令弹窗
│   └── icons.ts                 # 共享 SVG 图标
├── i18n/                        # 国际化（10 种语言）
├── utils/                       # 模块化工具函数
└── style/                       # 模块化 CSS（→ styles.css）
hub/                             # 远程 Hub 服务器（用于移动端）
├── server.mjs                   # Hub 服务器（Node.js 18+）
├── config.example.json          # Hub 配置模板
└── README.md                    # Hub 详细文档
```

## 开发路线图

- [x] Claude Code 插件支持
- [x] 自定义代理（子代理）支持
- [x] Chrome 中的 Claude 支持
- [x] `/compact` 命令
- [x] 计划模式
- [x] `rewind` 和 `fork` 支持（包括 `/fork` 命令）
- [x] `!command` 支持
- [x] Codex 和 Gemini 引擎支持
- [x] 多标签界面
- [x] 移动端插件 + Hub 服务器
- [ ] 工具渲染器优化
- [ ] Hooks 和其他高级功能
- [ ] 更多功能即将到来！

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=FutureUnreal/clian&type=Date)](https://www.star-history.com/#FutureUnreal/clian&Date)

## 许可证

基于 [MIT 许可证](LICENSE) 授权。

## 致谢

- [Claudian](https://github.com/YishenTu/claudian) —— 本项目基于其进行二次开发
- [Obsidian](https://obsidian.md) 提供了插件 API
- [Anthropic](https://anthropic.com) 提供了 Claude 和 [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)

