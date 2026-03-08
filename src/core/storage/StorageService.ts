/**
 * StorageService - Main coordinator for distributed storage system.
 *
 * Manages:
 * - CC settings in .claude/settings.json (CC-compatible, shareable)
 * - Plugin settings in .clian/settings.json (vault-local)
 * - Slash commands in .clian/commands/*.md (shared layer)
 * - Chat sessions in .claude/sessions/*.jsonl
 * - MCP configs in .clian/mcp.json (shared layer)
 *
 * Handles migration from legacy formats:
 * - Old settings.json with Clian fields → split into CC + Clian files
 * - Old permissions array → CC permissions object
 * - data.json state → .clian/settings.json
 */

import * as fs from 'fs';
import type { App, Plugin } from 'obsidian';
import { Notice } from 'obsidian';
import * as os from 'os';
import * as path from 'path';

import type {
  CCPermissions,
  CCSettings,
  ChatFlavor,
  ClaudeModel,
  Conversation,
  LegacyPermission,
  SlashCommand,
  TitleGenerationEngine,
} from '../types';
import {
  createPermissionRule,
  DEFAULT_CC_PERMISSIONS,
  DEFAULT_SETTINGS,
  legacyPermissionsToCCPermissions,
} from '../types';
import { AGENTS_PATH, AgentVaultStorage } from './AgentVaultStorage';
import { CC_SETTINGS_PATH, CCSettingsStorage, isLegacyPermissionsFormat } from './CCSettingsStorage';
import {
  ClianSettingsStorage,
  normalizeBlockedCommands,
  type StoredClianSettings,
} from './ClianSettingsStorage';
import { McpStorage } from './McpStorage';
import { McpSyncService } from './McpSyncService';
import {
  CLIAN_ONLY_FIELDS,
  convertEnvObjectToString,
  mergeEnvironmentVariables,
} from './migrationConstants';
import { SESSIONS_PATH, SessionStorage } from './SessionStorage';
import { SKILLS_PATH, SkillStorage } from './SkillStorage';
import { COMMANDS_PATH, SlashCommandStorage } from './SlashCommandStorage';
import { VaultFileAdapter } from './VaultFileAdapter';

/** Base path for all Clian storage. */
export const CLAUDE_PATH = '.claude';

/** Shared layer root (commands/skills/MCP and other cross-CLI data). */
export const CLIAN_PATH = '.clian';

/** Shared sessions folder relative to vault root (non-Claude engines). */
export const CLIAN_SESSIONS_PATH = `${CLIAN_PATH}/sessions`;

/** Legacy settings path (now CC settings). */
export const SETTINGS_PATH = CC_SETTINGS_PATH;

const CLIAN_SYNC_STATE_PATH = `${CLIAN_PATH}/sync-state.json`;

/**
 * Combined settings for the application.
 * Merges CC settings (permissions) with Clian settings.
 */
export interface CombinedSettings {
  /** CC-compatible settings (permissions, etc.) */
  cc: CCSettings;
  /** Clian settings */
  clian: StoredClianSettings;
}

/** Legacy data format (pre-split migration). */
interface LegacySettingsJson {
  // Legacy plugin fields that used to live in settings.json
  userName?: string;
  enableBlocklist?: boolean;
  blockedCommands?: unknown;
  model?: string;
  thinkingBudget?: string;
  permissionMode?: string;
  lastNonPlanPermissionMode?: string;
  permissions?: LegacyPermission[];
  excludedTags?: string[];
  mediaFolder?: string;
  environmentVariables?: string;
  envSnippets?: unknown[];
  systemPrompt?: string;
  allowedExportPaths?: string[];
  keyboardNavigation?: unknown;
  claudeCliPath?: string;
  claudeCliPaths?: unknown;
  loadUserClaudeSettings?: boolean;
  enableAutoTitleGeneration?: boolean;
  titleGenerationEngine?: string;
  titleGenerationModel?: string;

  // CC fields
  $schema?: string;
  env?: Record<string, string>;
}

function normalizeTitleGenerationEngine(
  value: unknown,
  fallback: TitleGenerationEngine
): TitleGenerationEngine {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  if (normalized === 'claude') return 'claude';
  if (normalized === 'codex') return 'codex';
  if (normalized === 'gemini') return 'gemini';
  return fallback;
}

/** Legacy data.json format. */
interface LegacyDataJson {
  activeConversationId?: string | null;
  lastEnvHash?: string;
  lastClaudeModel?: ClaudeModel;
  lastCustomModel?: ClaudeModel;
  conversations?: Conversation[];
  slashCommands?: SlashCommand[];
  migrationVersion?: number;
  // May also contain old settings if not yet migrated
  [key: string]: unknown;
}

// CLIAN_ONLY_FIELDS is imported from ./migrationConstants

export class StorageService {
  readonly ccSettings: CCSettingsStorage;
  readonly clianSettings: ClianSettingsStorage;
  readonly commands: SlashCommandStorage;
  readonly skills: SkillStorage;
  readonly sessions: SessionStorage;
  readonly sharedSessions: SessionStorage;
  readonly mcp: McpStorage;
  readonly agents: AgentVaultStorage;

  private adapter: VaultFileAdapter;
  private mcpSync: McpSyncService;
  private plugin: Plugin;
  private app: App;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.adapter = new VaultFileAdapter(this.app);
    this.ccSettings = new CCSettingsStorage(this.adapter);
    this.clianSettings = new ClianSettingsStorage(this.adapter);
    this.commands = new SlashCommandStorage(this.adapter);
    this.skills = new SkillStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter);
    this.sharedSessions = new SessionStorage(this.adapter, CLIAN_SESSIONS_PATH);
    this.mcp = new McpStorage(this.adapter);
    this.mcpSync = new McpSyncService(this.adapter);
    this.agents = new AgentVaultStorage(this.adapter);
  }

  async initialize(): Promise<CombinedSettings> {
    await this.ensureDirectories();
    await this.seedSharedLayerFromClaude();
    await this.seedGeminiConfigFromUserHome();
    await this.runMigrations();
    await this.syncMcpToCliConfigs();
    await this.syncCommandsAndSkillsToCliDirs();

    const cc = await this.ccSettings.load();
    const clian = await this.clianSettings.load();

    return { cc, clian };
  }

  async syncMcpToCliConfigs(): Promise<void> {
    try {
      const servers = await this.mcp.load();
      await this.mcpSync.syncFromSharedLayer(servers);
    } catch {
      // Best-effort; ignore sync failures.
    }
  }

  async syncCommandsAndSkillsToCliDirs(): Promise<void> {
    try {
      await this.adapter.ensureFolder('.claude/commands');
      await this.adapter.ensureFolder('.claude/skills');
      await this.adapter.ensureFolder('.codex/skills');

      await this.syncFolderToWithState('.clian/commands', '.claude/commands', (p) => p.endsWith('.md'), 'claude.commands');
      await this.syncFolderToWithState('.clian/skills', '.claude/skills', (p) => p.endsWith('SKILL.md'), 'claude.skills');
      await this.syncFolderToWithState('.clian/skills', '.codex/skills', (p) => p.endsWith('SKILL.md'), 'codex.skills');
    } catch {
      // Best-effort; ignore sync failures.
    }
  }

  private async syncFolderToWithState(
    sourceRoot: string,
    destRoot: string,
    isRelevantFile: (path: string) => boolean,
    stateKey: string,
  ): Promise<void> {
    const state = await this.loadClianSyncState();
    const previous = Array.isArray(state[stateKey])
      ? (state[stateKey] as string[]).filter((p) => typeof p === 'string')
      : [];

    const current = new Set<string>();

    const files = await this.adapter.listFilesRecursive(sourceRoot);
    for (const sourcePath of files) {
      if (!isRelevantFile(sourcePath)) continue;

      const rel = sourcePath.startsWith(`${sourceRoot}/`)
        ? sourcePath.slice(sourceRoot.length + 1)
        : sourcePath;
      const destPath = `${destRoot}/${rel}`;
      try {
        const content = await this.adapter.read(sourcePath);
        await this.writeIfChanged(destPath, content);
        current.add(rel);
      } catch {
        // Best-effort; skip unreadable files.
      }
    }

    // Delete previously-synced files that no longer exist in the shared layer.
    for (const rel of previous) {
      if (!rel || current.has(rel)) continue;
      const destPath = `${destRoot}/${rel}`;
      try {
        if (isRelevantFile(destPath)) {
          await this.adapter.delete(destPath);
        }
      } catch {
        // Best-effort.
      }
    }

    state[stateKey] = Array.from(current).sort((a, b) => a.localeCompare(b));
    await this.saveClianSyncState(state);
  }

  private async writeIfChanged(filePath: string, nextContent: string): Promise<void> {
    const normalizedNext = nextContent.endsWith('\n') ? nextContent : `${nextContent}\n`;
    const exists = await this.adapter.exists(filePath);
    if (!exists) {
      await this.adapter.write(filePath, normalizedNext);
      return;
    }

    try {
      const current = await this.adapter.read(filePath);
      if (current === normalizedNext) {
        return;
      }
    } catch {
      // If read fails, still try to write.
    }

    await this.adapter.write(filePath, normalizedNext);
  }

  private async loadClianSyncState(): Promise<Record<string, unknown>> {
    try {
      if (!(await this.adapter.exists(CLIAN_SYNC_STATE_PATH))) {
        return {};
      }
      const raw = await this.adapter.read(CLIAN_SYNC_STATE_PATH);
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return {};
      }
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async saveClianSyncState(state: Record<string, unknown>): Promise<void> {
    try {
      const content = JSON.stringify(state, null, 2);
      await this.writeIfChanged(CLIAN_SYNC_STATE_PATH, content);
    } catch {
      // Best-effort.
    }
  }

  private async runMigrations(): Promise<void> {
    const ccExists = await this.ccSettings.exists();
    const clianExists = await this.clianSettings.exists();
    const dataJson = await this.loadDataJson();

    // Check if old settings.json has Clian fields that need migration
    if (ccExists && !clianExists) {
      await this.migrateFromOldSettingsJson();
    }

    if (dataJson) {
      const hasState = this.hasStateToMigrate(dataJson);
      const hasLegacyContent = this.hasLegacyContentToMigrate(dataJson);

      // Migrate data.json state to .clian/settings.json
      if (hasState) {
        await this.migrateFromDataJson(dataJson);
      }

      // Migrate slash commands and conversations from data.json
      let legacyContentHadErrors = false;
      if (hasLegacyContent) {
        const result = await this.migrateLegacyDataJsonContent(dataJson);
        legacyContentHadErrors = result.hadErrors;
      }

      // Clear legacy data.json only after successful migrations
      if ((hasState || hasLegacyContent) && !legacyContentHadErrors) {
        await this.clearLegacyDataJson();
      }
    }
  }

  private hasStateToMigrate(data: LegacyDataJson): boolean {
    return (
      data.lastEnvHash !== undefined ||
      data.lastClaudeModel !== undefined ||
      data.lastCustomModel !== undefined
    );
  }

  private hasLegacyContentToMigrate(data: LegacyDataJson): boolean {
    return (
      (data.slashCommands?.length ?? 0) > 0 ||
      (data.conversations?.length ?? 0) > 0
    );
  }

  /**
   * Migrate from old settings.json (with legacy plugin fields) to split format.
   *
   * Handles:
   * - Legacy Clian fields (userName, model, etc.) → .clian/settings.json
   * - Legacy permissions array → CC permissions object
   * - CC env object → Clian environmentVariables string
   * - Preserves existing CC permissions if already in CC format
   */
  private async migrateFromOldSettingsJson(): Promise<void> {
    const content = await this.adapter.read(CC_SETTINGS_PATH);
    const oldSettings = JSON.parse(content) as LegacySettingsJson;

    const hasClianFields = Array.from(CLIAN_ONLY_FIELDS).some(
      field => (oldSettings as Record<string, unknown>)[field] !== undefined
    );

    if (!hasClianFields) {
      return;
    }

    // Handle environment variables: merge Clian string format with CC object format
    let environmentVariables = oldSettings.environmentVariables ?? '';
    if (oldSettings.env && typeof oldSettings.env === 'object') {
      const envFromCC = convertEnvObjectToString(oldSettings.env);
      if (envFromCC) {
        environmentVariables = mergeEnvironmentVariables(environmentVariables, envFromCC);
      }
    }

    const clianFields: Partial<StoredClianSettings> = {
      userName: oldSettings.userName ?? DEFAULT_SETTINGS.userName,
      enableBlocklist: oldSettings.enableBlocklist ?? DEFAULT_SETTINGS.enableBlocklist,
      blockedCommands: normalizeBlockedCommands(oldSettings.blockedCommands),
      model: (oldSettings.model as ClaudeModel) ?? DEFAULT_SETTINGS.model,
      thinkingBudget: (oldSettings.thinkingBudget as StoredClianSettings['thinkingBudget']) ?? DEFAULT_SETTINGS.thinkingBudget,
      permissionMode: (oldSettings.permissionMode as StoredClianSettings['permissionMode']) ?? DEFAULT_SETTINGS.permissionMode,
      excludedTags: oldSettings.excludedTags ?? DEFAULT_SETTINGS.excludedTags,
      mediaFolder: oldSettings.mediaFolder ?? DEFAULT_SETTINGS.mediaFolder,
      environmentVariables, // Merged from both sources
      envSnippets: oldSettings.envSnippets as StoredClianSettings['envSnippets'] ?? DEFAULT_SETTINGS.envSnippets,
      systemPrompt: oldSettings.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
      allowedExportPaths: oldSettings.allowedExportPaths ?? DEFAULT_SETTINGS.allowedExportPaths,
      persistentExternalContextPaths: DEFAULT_SETTINGS.persistentExternalContextPaths,
      keyboardNavigation: oldSettings.keyboardNavigation as StoredClianSettings['keyboardNavigation'] ?? DEFAULT_SETTINGS.keyboardNavigation,
      claudeCliPath: oldSettings.claudeCliPath ?? DEFAULT_SETTINGS.claudeCliPath,
      claudeCliPathsByHost: DEFAULT_SETTINGS.claudeCliPathsByHost,  // Migration to hostname-based handled in main.ts
      loadUserClaudeSettings: oldSettings.loadUserClaudeSettings ?? DEFAULT_SETTINGS.loadUserClaudeSettings,
      enableAutoTitleGeneration: oldSettings.enableAutoTitleGeneration ?? DEFAULT_SETTINGS.enableAutoTitleGeneration,
      titleGenerationEngine: normalizeTitleGenerationEngine(
        oldSettings.titleGenerationEngine,
        DEFAULT_SETTINGS.titleGenerationEngine
      ),
      titleGenerationModel: oldSettings.titleGenerationModel ?? DEFAULT_SETTINGS.titleGenerationModel,
      lastClaudeModel: DEFAULT_SETTINGS.lastClaudeModel,
      lastCustomModel: DEFAULT_SETTINGS.lastCustomModel,
      lastEnvHash: DEFAULT_SETTINGS.lastEnvHash,
    };

    // Save Clian settings FIRST (before stripping from settings.json)
    await this.clianSettings.save(clianFields as StoredClianSettings);

    // Verify Clian settings were saved
    const savedClian = await this.clianSettings.load();
    if (!savedClian || savedClian.userName === undefined) {
      throw new Error('Failed to verify .clian/settings.json was saved correctly');
    }

    // Handle permissions: convert legacy format OR preserve existing CC format
    let ccPermissions: CCPermissions;
    if (isLegacyPermissionsFormat(oldSettings)) {
      ccPermissions = legacyPermissionsToCCPermissions(oldSettings.permissions);
    } else if (oldSettings.permissions && typeof oldSettings.permissions === 'object' && !Array.isArray(oldSettings.permissions)) {
      // Already in CC format - preserve it including defaultMode and additionalDirectories
      const existingPerms = oldSettings.permissions as unknown as CCPermissions;
      ccPermissions = {
        allow: existingPerms.allow ?? [],
        deny: existingPerms.deny ?? [],
        ask: existingPerms.ask ?? [],
        defaultMode: existingPerms.defaultMode,
        additionalDirectories: existingPerms.additionalDirectories,
      };
    } else {
      ccPermissions = { ...DEFAULT_CC_PERMISSIONS };
    }

    // Rewrite settings.json with only CC fields
    const ccSettings: CCSettings = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      permissions: ccPermissions,
    };

    // Pass true to strip Clian-only fields during migration
    await this.ccSettings.save(ccSettings, true);
  }

  private async migrateFromDataJson(dataJson: LegacyDataJson): Promise<void> {
    const clian = await this.clianSettings.load();

    // Only migrate if not already set (.clian/settings.json takes precedence)
    if (dataJson.lastEnvHash !== undefined && !clian.lastEnvHash) {
      clian.lastEnvHash = dataJson.lastEnvHash;
    }
    if (dataJson.lastClaudeModel !== undefined && !clian.lastClaudeModel) {
      clian.lastClaudeModel = dataJson.lastClaudeModel;
    }
    if (dataJson.lastCustomModel !== undefined && !clian.lastCustomModel) {
      clian.lastCustomModel = dataJson.lastCustomModel;
    }

    await this.clianSettings.save(clian);
  }

  private async migrateLegacyDataJsonContent(dataJson: LegacyDataJson): Promise<{ hadErrors: boolean }> {
    let hadErrors = false;

    if (dataJson.slashCommands && dataJson.slashCommands.length > 0) {
      for (const command of dataJson.slashCommands) {
        try {
          const filePath = this.commands.getFilePath(command);
          if (await this.adapter.exists(filePath)) {
            continue;
          }
          await this.commands.save(command);
        } catch {
          hadErrors = true;
        }
      }
    }

    if (dataJson.conversations && dataJson.conversations.length > 0) {
      for (const conversation of dataJson.conversations) {
        try {
          const filePath = this.sessions.getFilePath(conversation.id);
          if (await this.adapter.exists(filePath)) {
            continue;
          }
          await this.sessions.saveConversation(conversation);
        } catch {
          hadErrors = true;
        }
      }
    }

    return { hadErrors };
  }

  private async clearLegacyDataJson(): Promise<void> {
    const dataJson = await this.loadDataJson();
    if (!dataJson) {
      return;
    }

    const cleaned: Record<string, unknown> = { ...dataJson };
    delete cleaned.lastEnvHash;
    delete cleaned.lastClaudeModel;
    delete cleaned.lastCustomModel;
    delete cleaned.conversations;
    delete cleaned.slashCommands;
    delete cleaned.migrationVersion;

    if (Object.keys(cleaned).length === 0) {
      await this.plugin.saveData({});
      return;
    }

    await this.plugin.saveData(cleaned);
  }

  private async loadDataJson(): Promise<LegacyDataJson | null> {
    try {
      const data = await this.plugin.loadData();
      return data || null;
    } catch {
      // data.json may not exist on fresh installs
      return null;
    }
  }

  async ensureDirectories(): Promise<void> {
    await this.adapter.ensureFolder(CLAUDE_PATH);
    await this.adapter.ensureFolder(COMMANDS_PATH);
    await this.adapter.ensureFolder(SKILLS_PATH);
    await this.adapter.ensureFolder(SESSIONS_PATH);
    await this.adapter.ensureFolder(AGENTS_PATH);

    // Claude Code reads commands/skills from .claude/. Keep these folders present
    // even if the shared layer lives under .clian/.
    await this.adapter.ensureFolder('.claude/commands');
    await this.adapter.ensureFolder('.claude/skills');

    // Non-Claude engines (Codex/Gemini) store their JSONL conversations here.
    await this.adapter.ensureFolder(CLIAN_SESSIONS_PATH);
  }

  /**
   * Seeds the shared layer (.clian/) from an existing Claude layer (.claude/) once.
   *
   * Direction B: treat `.clian/` as the new shared default, but initialize it by
   * copying any existing user content from `.claude/` to avoid losing settings
   * when migrating.
   */
  private async seedSharedLayerFromClaude(): Promise<void> {
    // MCP
    await this.seedFileFromClaudeIfMissing('.claude/mcp.json', '.clian/mcp.json');

    // Commands
    await this.seedFolderFromClaudeIfEmpty(
      '.claude/commands',
      '.clian/commands',
      (filePath) => filePath.endsWith('.md'),
    );

    // Skills
    await this.seedFolderFromClaudeIfEmpty(
      '.claude/skills',
      '.clian/skills',
      (filePath) => filePath.endsWith('SKILL.md'),
    );
  }

  /**
   * Seeds Gemini CLI config in the vault from the user's home directory once.
   *
   * Codex is intentionally excluded here: Codex natively merges the user layer
   * (`~/.codex/config.toml`) with the project layer (`<cwd>/.codex/config.toml`).
   * Copying the home config into the vault-local `.codex/config.toml` collapses
   * those layers and makes project-specific overrides behave incorrectly.
   *
   * Notes:
   * - Best-effort: failures are ignored.
   * - Skipped under Jest to avoid importing the developer machine's real CLI configs into tests.
   */
  private async seedGeminiConfigFromUserHome(): Promise<void> {
    if (process.env.CLIAN_DISABLE_HOME_SEED === '1') {
      return;
    }

    if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
      return;
    }

    const home = os.homedir();
    if (!home) return;

    await this.seedGeminiFromUserHome(home);
  }

  private async seedGeminiFromUserHome(homeDir: string): Promise<void> {
    try {
      const sourceDir = path.join(homeDir, '.gemini');
      const sourceSettings = path.join(sourceDir, 'settings.json');
      const sourceEnv = path.join(sourceDir, '.env');

      const hasSettings = fs.existsSync(sourceSettings);
      const hasEnv = fs.existsSync(sourceEnv);
      if (!hasSettings && !hasEnv) {
        return;
      }

      await this.adapter.ensureFolder('.gemini');

      // .env (API key, base url, etc.)
      try {
        if (!(await this.adapter.exists('.gemini/.env')) && hasEnv) {
          const content = await fs.promises.readFile(sourceEnv, 'utf8');
          await this.adapter.write('.gemini/.env', content);
        }
      } catch {
        // ignore
      }

      // settings.json (auth mode selection, etc.)
      try {
        if (!hasSettings) return;

        const destPath = '.gemini/settings.json';
        const destExists = await this.adapter.exists(destPath);

        if (!destExists) {
          const content = await fs.promises.readFile(sourceSettings, 'utf8');
          await this.adapter.write(destPath, content);
          return;
        }

        // If we only have an MCP-only stub (no auth selection), overwrite with user's settings.json.
        const existingText = await this.adapter.read(destPath);
        let hasAuth = false;
        try {
          const parsed = JSON.parse(existingText) as unknown;
          if (parsed && typeof parsed === 'object') {
            const security = (parsed as any).security;
            const auth = security?.auth;
            hasAuth = typeof auth?.selectedType === 'string' && auth.selectedType.length > 0;
          }
        } catch {
          // invalid JSON -> treat as missing
          hasAuth = false;
        }

        if (!hasAuth) {
          const content = await fs.promises.readFile(sourceSettings, 'utf8');
          await this.adapter.write(destPath, content);
        }
      } catch {
        // ignore
      }

      // Optional prompt file (Gemini CLI reads ~/.gemini/GEMINI.md). Copy if present.
      try {
        const sourcePrompt = path.join(sourceDir, 'GEMINI.md');
        if (fs.existsSync(sourcePrompt) && !(await this.adapter.exists('.gemini/GEMINI.md'))) {
          const content = await fs.promises.readFile(sourcePrompt, 'utf8');
          await this.adapter.write('.gemini/GEMINI.md', content);
        }
      } catch {
        // ignore
      }
    } catch {
      // Best-effort seed; ignore failures.
    }
  }

  private async seedFileFromClaudeIfMissing(sourcePath: string, destPath: string): Promise<void> {
    try {
      if (await this.adapter.exists(destPath)) {
        return;
      }
      if (!(await this.adapter.exists(sourcePath))) {
        return;
      }
      const content = await this.adapter.read(sourcePath);
      await this.adapter.write(destPath, content);
    } catch {
      // Best-effort seed; ignore failures.
    }
  }

  private async seedFolderFromClaudeIfEmpty(
    sourceRoot: string,
    destRoot: string,
    isRelevantFile: (path: string) => boolean,
  ): Promise<void> {
    try {
      const destFiles = await this.adapter.listFilesRecursive(destRoot);
      const hasAnyRelevant = destFiles.some(isRelevantFile);
      if (hasAnyRelevant) {
        return;
      }

      const sourceFiles = await this.adapter.listFilesRecursive(sourceRoot);
      const relevantSourceFiles = sourceFiles.filter(isRelevantFile);
      if (relevantSourceFiles.length === 0) {
        return;
      }

      for (const sourcePath of sourceFiles) {
        // Preserve relative paths under the root.
        const rel = sourcePath.startsWith(`${sourceRoot}/`)
          ? sourcePath.slice(sourceRoot.length + 1)
          : sourcePath;
        const destPath = `${destRoot}/${rel}`;
        try {
          const content = await this.adapter.read(sourcePath);
          await this.adapter.write(destPath, content);
        } catch {
          // Best-effort; skip unreadable files.
        }
      }
    } catch {
      // Best-effort seed; ignore failures.
    }
  }

  async loadAllSlashCommands(): Promise<SlashCommand[]> {
    const commands = await this.commands.loadAll();
    const skills = await this.skills.loadAll();
    return [...commands, ...skills];
  }

  getAdapter(): VaultFileAdapter {
    return this.adapter;
  }

  async getPermissions(): Promise<CCPermissions> {
    return this.ccSettings.getPermissions();
  }

  async updatePermissions(permissions: CCPermissions): Promise<void> {
    return this.ccSettings.updatePermissions(permissions);
  }

  async addAllowRule(rule: string): Promise<void> {
    return this.ccSettings.addAllowRule(createPermissionRule(rule));
  }

  async addDenyRule(rule: string): Promise<void> {
    return this.ccSettings.addDenyRule(createPermissionRule(rule));
  }

  /**
   * Remove a permission rule from all lists.
   */
  async removePermissionRule(rule: string): Promise<void> {
    return this.ccSettings.removeRule(createPermissionRule(rule));
  }

  async updateClianSettings(updates: Partial<StoredClianSettings>): Promise<void> {
    return this.clianSettings.update(updates);
  }

  async saveClianSettings(settings: StoredClianSettings): Promise<void> {
    return this.clianSettings.save(settings);
  }

  async loadClianSettings(): Promise<StoredClianSettings> {
    return this.clianSettings.load();
  }

  /**
  * Get legacy activeConversationId from storage (.clian/settings.json or data.json).
  */
  async getLegacyActiveConversationId(): Promise<string | null> {
    const fromSettings = await this.clianSettings.getLegacyActiveConversationId();
    if (fromSettings) {
      return fromSettings;
    }

    const dataJson = await this.loadDataJson();
    if (dataJson && typeof dataJson.activeConversationId === 'string') {
      return dataJson.activeConversationId;
    }

    return null;
  }

  /**
  * Remove legacy activeConversationId from storage after migration.
  */
  async clearLegacyActiveConversationId(): Promise<void> {
    await this.clianSettings.clearLegacyActiveConversationId();

    const dataJson = await this.loadDataJson();
    if (!dataJson || !('activeConversationId' in dataJson)) {
      return;
    }

    const cleaned: Record<string, unknown> = { ...dataJson };
    delete cleaned.activeConversationId;
    await this.plugin.saveData(cleaned);
  }

  /**
   * Get tab manager state from data.json with runtime validation.
   */
  async getTabManagerState(): Promise<TabManagerPersistedState | null> {
    try {
      const data = await this.plugin.loadData();
      if (data?.tabManagerState) {
        return this.validateTabManagerState(data.tabManagerState);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Validates and sanitizes tab manager state from storage.
   * Returns null if the data is invalid or corrupted.
   */
  private validateTabManagerState(data: unknown): TabManagerPersistedState | null {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const state = data as Record<string, unknown>;

    if (!Array.isArray(state.openTabs)) {
      return null;
    }

    const validatedTabs: Array<{ tabId: string; conversationId: string | null; flavor?: ChatFlavor }> = [];
    for (const tab of state.openTabs) {
      if (!tab || typeof tab !== 'object') {
        continue; // Skip invalid entries
      }
      const tabObj = tab as Record<string, unknown>;
      if (typeof tabObj.tabId !== 'string') {
        continue; // Skip entries without valid tabId
      }
      const rawFlavor = typeof tabObj.flavor === 'string' ? tabObj.flavor : null;
      const flavor: ChatFlavor | undefined = rawFlavor === 'claude' || rawFlavor === 'codex' || rawFlavor === 'gemini'
        ? (rawFlavor as ChatFlavor)
        : undefined;
      validatedTabs.push({
        tabId: tabObj.tabId,
        conversationId:
          typeof tabObj.conversationId === 'string' ? tabObj.conversationId : null,
        ...(flavor ? { flavor } : {}),
      });
    }

    const activeTabId =
      typeof state.activeTabId === 'string' ? state.activeTabId : null;

    return {
      openTabs: validatedTabs,
      activeTabId,
    };
  }

  async setTabManagerState(state: TabManagerPersistedState): Promise<void> {
    try {
      const data = (await this.plugin.loadData()) || {};
      data.tabManagerState = state;
      await this.plugin.saveData(data);
    } catch {
      new Notice('Failed to save tab layout');
    }
  }
}

/**
 * Persisted state for the tab manager.
 * Stored in data.json (machine-specific, not shared).
 */
export interface TabManagerPersistedState {
  openTabs: Array<{ tabId: string; conversationId: string | null; flavor?: ChatFlavor }>;
  activeTabId: string | null;
}
