# Clian Remote Hub (Standalone)

This is a lightweight hub server for Clian mobile.

It runs an agent on a desktop/server machine and exposes a small HTTP API that the Obsidian **mobile** plugin can talk to.

Supported session flavors:

- `claude`: Claude Code via `@anthropic-ai/claude-agent-sdk`
- `codex`: OpenAI Codex CLI via `codex exec --json`
- `gemini`: Gemini CLI via `gemini --output-format stream-json`

## Requirements

- Node.js 18+
- Run `npm install` in this plugin folder (installs `@anthropic-ai/claude-agent-sdk`)
- Install and configure the CLIs you plan to use on the hub machine:
  - Claude Code (subscription/API key, etc.)
  - Codex CLI (`codex`) + `OPENAI_API_KEY`
  - Gemini CLI (`gemini`) + its auth/credentials

## Config (env vars)

- Config file (optional):
  - Default: `.clian-hub/config.json` (next to `state.json`)
  - Override path: `CLIAN_HUB_CONFIG`
  - Env vars always override config file values.
  - Quick start: copy `hub/config.example.json` → `.clian-hub/config.json` and edit `token` + `cwd`.
  - If the config file does not exist and `CLIAN_HUB_TOKEN` is not set, the hub will create a default config file and print a generated token on startup.

- Required:
  - `CLIAN_HUB_TOKEN` (or `token` in config file) — shared secret; mobile uses `Hub access token`
- Common:
  - `CLIAN_HUB_CWD` (default working directory for new sessions)
  - `CLIAN_HUB_HOST`, `CLIAN_HUB_PORT`
  - `CLIAN_HUB_DATA_DIR` (default: `.clian-hub` under the hub process working directory)
    - Stores `config.json` and `state.json` for the hub.
  - `CLIAN_HUB_DEBUG=1` (enables debug logging; set `0` to disable)
- Optional (Uploads):
  - `CLIAN_HUB_MAX_UPLOAD_BYTES` (default: `20971520`)
    - Used by the mobile plugin when uploading vault files to the hub.
    - Uploaded files are written under `.clian/hub_uploads/<namespace>/<sessionId>/...` inside the session `cwd`.
- Optional (SSE):
  - `CLIAN_HUB_SSE_FLUSH_MS` (default: `0`)
    - Buffers and flushes SSE writes on an interval to reduce `res.write()` overhead.
  - `CLIAN_HUB_SSE_PATCH_FLUSH_MS` (default: `25`)
    - Debounces `message_patch` events to reduce event frequency (improves mobile rendering performance).
  - `CLIAN_HUB_SSE_MAX_BUFFER_BYTES` (default: `2097152`)
    - Per-connection SSE buffer limit; slow clients will be disconnected once exceeded.
- Optional (Claude):
  - `CLIAN_HUB_CLAUDE_CODE_PATH` (or `CLAUDE_CODE_PATH`)
    - Windows: prefer pointing to `...\\node_modules\\@anthropic-ai\\claude-code\\cli.js` (or `claude.exe` if you installed the native build).
    - If you point at `claude.cmd` / `claude.ps1`, the hub will try to resolve the real `cli.js` next to it.
    - If unset, the SDK will try to resolve `claude` from your system `PATH` (the hub startup banner may still print `not found`).
  - `CLIAN_HUB_MODEL`
  - `CLIAN_HUB_CLAUDE_SETTING_SOURCES` (default: `user,project`)
    - Useful when you rely on `~/.claude/settings.json` for proxies/auth (e.g. cc-switch).
    - Set to `project` to disable loading user settings.
- Optional (Codex):
  - `CLIAN_HUB_CODEX_COMMAND` (default: `codex`)
  - `CLIAN_HUB_CODEX_APPROVAL_MODE` (default: `yolo`; `yolo` maps to Codex full access, non-`yolo` maps to `--ask-for-approval on-request`)
  - `CLIAN_HUB_CODEX_SANDBOX` (used for non-`yolo` Codex sessions via `--sandbox`, e.g. `read-only` or `workspace-write`)
- Optional (Gemini):
  - `CLIAN_HUB_GEMINI_COMMAND` (default: `gemini`)
  - `CLIAN_HUB_GEMINI_APPROVAL_MODE` (default: `yolo`)
  - `CLIAN_HUB_GEMINI_SANDBOX=1` (enables `--sandbox`)

## Quick start

From this plugin folder:

Option A (config file; no env vars needed):

- Copy `hub/config.example.json` → `.clian-hub/config.json`
- Edit `token` and `cwd`
- Run `npm run hub`

Option B (environment variables):

PowerShell (Windows):

```powershell
$env:CLIAN_HUB_TOKEN="your-secret-token"
$env:CLIAN_HUB_CWD="C:\path\to\your\vault"
$env:CLIAN_HUB_HOST="0.0.0.0"
$env:CLIAN_HUB_PORT="3006"
npm run hub
```

cmd.exe (Windows):

```bat
set CLIAN_HUB_TOKEN=your-secret-token
set CLIAN_HUB_CWD=C:\path\to\your\vault
set CLIAN_HUB_HOST=0.0.0.0
set CLIAN_HUB_PORT=3006
npm run hub
```

macOS / Linux:

```bash
export CLIAN_HUB_TOKEN=your-secret-token
export CLIAN_HUB_CWD=/path/to/your/vault
export CLIAN_HUB_HOST=0.0.0.0
export CLIAN_HUB_PORT=3006
npm run hub
```

Then in Obsidian mobile:

- Settings → Clian → `Hub URL`: `http://<your-lan-ip>:3006`
- Settings → Clian → `Hub access token`: `your-secret-token`

You can create sessions from the mobile view (tap **New**) and choose a flavor (`claude` / `codex` / `gemini`).

## Notes

- This hub is intentionally minimal: it supports sessions, messages, and tool approvals.
- It is powerful (the agent can run tools and commands on the hub machine). Protect it with a strong token and keep it on a trusted network.
- Tool approvals are only implemented for `claude` sessions. For `codex` and `gemini` headless runs, use their sandbox/approval settings to control risk.
- For `claude` sessions, assistant messages include a `blocks` array (`text` / `thinking` / `tool_use` / `tool_result`) so the mobile UI can show tool calls and inline approvals.
