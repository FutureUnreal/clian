/**
 * Engine-specific type definitions and defaults for non-Claude backends.
 */

export type CodexReasoningEffort =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export const CODEX_REASONING_EFFORT_OPTIONS: {
  value: CodexReasoningEffort;
  label: string;
  description: string;
}[] = [
  { value: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
  { value: 'medium', label: 'Med', description: 'Balances speed and reasoning depth for everyday tasks' },
  { value: 'high', label: 'High', description: 'Greater reasoning depth for complex problems' },
  { value: 'xhigh', label: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
];

export const DEFAULT_CODEX_MODELS: { value: string; label: string; description: string }[] = [
  { value: '', label: 'Default', description: 'Use Codex defaults (config.toml / server default)' },
  // Codex catalog (codex-rs/core/models.json)
  { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex', description: 'Latest frontier agentic coding model' },
  { value: 'gpt-5.2-codex', label: 'gpt-5.2-codex', description: 'Frontier agentic coding model' },
  { value: 'gpt-5.1-codex-max', label: 'gpt-5.1-codex-max', description: 'Codex-optimized flagship for deep and fast reasoning' },
  { value: 'gpt-5.1-codex', label: 'gpt-5.1-codex', description: 'Codex-optimized (legacy)' },
  { value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini', description: 'Cheaper, faster, but less capable' },
  { value: 'gpt-5.2', label: 'gpt-5.2', description: 'Latest frontier model with improved knowledge, reasoning, and coding' },
  { value: 'gpt-5.1', label: 'gpt-5.1', description: 'Broad world knowledge with strong general reasoning' },
  { value: 'gpt-5-codex', label: 'gpt-5-codex', description: 'Codex-optimized (legacy)' },
  { value: 'gpt-5-codex-mini', label: 'gpt-5-codex-mini', description: 'Cheaper, faster, but less capable' },
  { value: 'gpt-5', label: 'gpt-5', description: 'Broad world knowledge with strong general reasoning' },
  { value: 'gpt-oss-120b', label: 'gpt-oss-120b', description: 'OpenAI OSS model (120B parameters)' },
  { value: 'gpt-oss-20b', label: 'gpt-oss-20b', description: 'OpenAI OSS model (20B parameters)' },
  // Other OpenAI models (may work depending on your provider/router)
  { value: 'gpt-4.1', label: 'gpt-4.1', description: 'General-purpose' },
  { value: 'o4-mini', label: 'o4-mini', description: 'Fast reasoning' },
  { value: 'o3', label: 'o3', description: 'Reasoning' },
];

export type GeminiThinkingMode =
  | 'auto'
  | 'off'
  | 'lite'
  | 'default'
  | 'high'
  | 'unlimited';

export const GEMINI_THINKING_MODE_OPTIONS: {
  value: GeminiThinkingMode;
  label: string;
  budget: number | null;
}[] = [
  { value: 'auto', label: 'Auto', budget: null },
  { value: 'off', label: 'Off', budget: 0 },
  { value: 'lite', label: 'Lite', budget: 512 },
  { value: 'default', label: 'Default', budget: 8192 },
  { value: 'high', label: 'High', budget: 16384 },
  { value: 'unlimited', label: '∞', budget: -1 },
];

export function resolveGeminiThinkingBudget(mode: GeminiThinkingMode): number | null {
  const entry = GEMINI_THINKING_MODE_OPTIONS.find((m) => m.value === mode);
  return entry?.budget ?? null;
}

export const DEFAULT_GEMINI_MODELS: { value: string; label: string; description: string }[] = [
  { value: '', label: 'Default', description: 'Use Gemini CLI default model' },
  // Aliases
  { value: 'auto', label: 'auto', description: 'Alias: auto model selection' },
  { value: 'pro', label: 'pro', description: 'Alias: pro' },
  { value: 'flash', label: 'flash', description: 'Alias: flash' },
  { value: 'flash-lite', label: 'flash-lite', description: 'Alias: flash-lite' },
  // Concrete models (from gemini-cli repo defaults)
  { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro', description: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash', description: 'Gemini 2.5 Flash' },
  { value: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite', description: 'Gemini 2.5 Flash Lite' },
  // Preview models
  { value: 'gemini-3-pro-preview', label: 'gemini-3-pro-preview', description: 'Gemini 3 Pro (preview)' },
  { value: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview', description: 'Gemini 3 Flash (preview)' },
  { value: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview', description: 'Gemini 3.1 Pro (preview)' },
  { value: 'gemini-3.1-pro-preview-customtools', label: 'gemini-3.1-pro-preview-customtools', description: 'Gemini 3.1 Pro custom tools (preview)' },
  // Auto aliases
  { value: 'auto-gemini-2.5', label: 'auto-gemini-2.5', description: 'Alias: auto (Gemini 2.5)' },
  { value: 'auto-gemini-3', label: 'auto-gemini-3', description: 'Alias: auto (Gemini 3)' },
];

export function normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const allowed = new Set(CODEX_REASONING_EFFORT_OPTIONS.map((o) => o.value));
  if (allowed.has(raw as CodexReasoningEffort)) {
    return raw as CodexReasoningEffort;
  }
  return 'medium';
}

export function normalizeGeminiThinkingMode(value: unknown): GeminiThinkingMode {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const allowed = new Set(GEMINI_THINKING_MODE_OPTIONS.map((o) => o.value));
  if (allowed.has(raw as GeminiThinkingMode)) {
    return raw as GeminiThinkingMode;
  }
  return 'auto';
}

function getCustomContextLimit(model: string, customLimits?: Record<string, number>): number | null {
  if (!customLimits) return null;
  if (!(model in customLimits)) return null;
  const limit = customLimits[model];
  if (typeof limit !== 'number' || limit <= 0 || isNaN(limit) || !isFinite(limit)) {
    return null;
  }
  return limit;
}

export const DEFAULT_CODEX_CONTEXT_WINDOW = 272_000;

const CODEX_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5.3-codex': 272_000,
  'gpt-5.2-codex': 272_000,
  'gpt-5.1-codex-max': 272_000,
  'gpt-5.1-codex': 272_000,
  'gpt-5.1-codex-mini': 272_000,
  'gpt-5.2': 272_000,
};

export function getCodexContextWindowSize(model: string, customLimits?: Record<string, number>): number {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  const custom = trimmed ? getCustomContextLimit(trimmed, customLimits) : null;
  if (custom !== null) return custom;
  if (!trimmed) return DEFAULT_CODEX_CONTEXT_WINDOW;
  return CODEX_CONTEXT_WINDOWS[trimmed] ?? DEFAULT_CODEX_CONTEXT_WINDOW;
}

export const DEFAULT_GEMINI_CONTEXT_WINDOW = 1_048_576;

const GEMINI_CONTEXT_WINDOWS: Record<string, number> = {
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
  'gemini-3-pro-preview': 1_048_576,
  'gemini-3-flash-preview': 1_048_576,
  'gemini-3.1-pro-preview': 1_048_576,
  'gemini-3.1-pro-preview-customtools': 1_048_576,
};

export function getGeminiContextWindowSize(model: string, customLimits?: Record<string, number>): number {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  const custom = trimmed ? getCustomContextLimit(trimmed, customLimits) : null;
  if (custom !== null) return custom;

  if (!trimmed) return DEFAULT_GEMINI_CONTEXT_WINDOW;

  // Aliases and auto models (Gemini CLI resolves these internally)
  const normalized = trimmed.toLowerCase();
  if (
    normalized === 'auto' ||
    normalized === 'pro' ||
    normalized === 'flash' ||
    normalized === 'flash-lite' ||
    normalized === 'auto-gemini-2.5' ||
    normalized === 'auto-gemini-3'
  ) {
    return DEFAULT_GEMINI_CONTEXT_WINDOW;
  }

  return GEMINI_CONTEXT_WINDOWS[trimmed] ?? DEFAULT_GEMINI_CONTEXT_WINDOW;
}
