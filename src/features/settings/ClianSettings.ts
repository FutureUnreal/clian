import * as fs from 'fs';
import type { App } from 'obsidian';
import { Notice, PluginSettingTab, Setting } from 'obsidian';

import {
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_CODEX_MODELS,
  DEFAULT_GEMINI_MODELS,
  GEMINI_THINKING_MODE_OPTIONS,
  getCurrentPlatformKey,
  getHostnameKey,
  normalizeCodexReasoningEffort,
  normalizeGeminiThinkingMode,
  type ThinkingBudget,
  type TitleGenerationEngine,
} from '../../core/types';
import { DEFAULT_CLAUDE_MODELS, DEFAULT_THINKING_BUDGET, THINKING_BUDGETS } from '../../core/types/models';
import { getAvailableLocales, getLocaleDisplayName, setLocale, t } from '../../i18n';
import type { Locale, TranslationKey } from '../../i18n/types';
import type ClianPlugin from '../../main';
import { findNodeExecutable, formatContextLimit, getCustomModelIds, getEnhancedPath, getModelsFromEnvironment, parseContextLimit, parseEnvironmentVariables } from '../../utils/env';
import { expandHomePath } from '../../utils/path';
import { buildNavMappingText, parseNavMappings } from './keyboardNavigation';
import { DEFAULT_MAX_TABS, MIN_TABS } from '../chat/tabs/types';
import { AgentSettings } from './ui/AgentSettings';
import { EnvSnippetManager } from './ui/EnvSnippetManager';
import { McpSettingsManager } from './ui/McpSettingsManager';
import { PluginSettingsManager } from './ui/PluginSettingsManager';
import { SlashCommandSettings } from './ui/SlashCommandSettings';

function formatHotkey(hotkey: { modifiers: string[]; key: string }): string {
  const isMac = navigator.platform.includes('Mac');
  const modMap: Record<string, string> = isMac
    ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
    : { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };

  const mods = hotkey.modifiers.map((m) => modMap[m] || m);
  const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;

  return isMac ? [...mods, key].join('') : [...mods, key].join('+');
}

function openHotkeySettings(app: App): void {
  const setting = (app as any).setting;
  setting.open();
  setting.openTabById('hotkeys');
  setTimeout(() => {
    const tab = setting.activeTab;
    if (tab) {
      // Handle both old and new Obsidian versions
      const searchEl = tab.searchInputEl ?? tab.searchComponent?.inputEl;
      if (searchEl) {
        searchEl.value = 'Clian';
        tab.updateHotkeyVisibility?.();
      }
    }
  }, 100);
}

function getHotkeyForCommand(app: App, commandId: string): string | null {
  const hotkeyManager = (app as any).hotkeyManager;
  if (!hotkeyManager) return null;

  const customHotkeys = hotkeyManager.customKeys?.[commandId];
  const defaultHotkeys = hotkeyManager.defaultKeys?.[commandId];
  const hotkeys = customHotkeys?.length > 0 ? customHotkeys : defaultHotkeys;

  if (!hotkeys || hotkeys.length === 0) return null;

  return hotkeys.map(formatHotkey).join(', ');
}

function addHotkeySettingRow(
  containerEl: HTMLElement,
  app: App,
  commandId: string,
  translationPrefix: string
): void {
  const hotkey = getHotkeyForCommand(app, commandId);
  const item = containerEl.createDiv({ cls: 'clian-hotkey-item' });
  item.createSpan({ cls: 'clian-hotkey-name', text: t(`${translationPrefix}.name` as TranslationKey) });
  if (hotkey) {
    item.createSpan({ cls: 'clian-hotkey-badge', text: hotkey });
  }
  item.addEventListener('click', () => openHotkeySettings(app));
}

export class ClianSettingTab extends PluginSettingTab {
  plugin: ClianPlugin;
  private contextLimitsContainer: HTMLElement | null = null;

  constructor(app: App, plugin: ClianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('clian-settings');

    setLocale(this.plugin.settings.locale);

    new Setting(containerEl)
      .setName(t('settings.language.name'))
      .setDesc(t('settings.language.desc'))
      .addDropdown((dropdown) => {
        const locales = getAvailableLocales();
        for (const locale of locales) {
          dropdown.addOption(locale, getLocaleDisplayName(locale));
        }
        dropdown
          .setValue(this.plugin.settings.locale)
          .onChange(async (value: Locale) => {
            if (!setLocale(value)) {
              // Invalid locale - reset dropdown to current value
              dropdown.setValue(this.plugin.settings.locale);
              return;
            }
            this.plugin.settings.locale = value;
            await this.plugin.saveSettings();
            // Re-render the entire settings page with new language
            this.display();
          });
      });

    new Setting(containerEl).setName(t('settings.customization')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.userName.name'))
      .setDesc(t('settings.userName.desc'))
      .addText((text) => {
        text
          .setPlaceholder(t('settings.userName.name'))
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            this.plugin.settings.userName = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.excludedTags.name'))
      .setDesc(t('settings.excludedTags.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder('system\nprivate\ndraft')
          .setValue(this.plugin.settings.excludedTags.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.excludedTags = value
              .split(/\r?\n/)
              .map((s) => s.trim().replace(/^#/, ''))
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(containerEl)
      .setName(t('settings.mediaFolder.name'))
      .setDesc(t('settings.mediaFolder.desc'))
      .addText((text) => {
        text
          .setPlaceholder('attachments')
          .setValue(this.plugin.settings.mediaFolder)
          .onChange(async (value) => {
            this.plugin.settings.mediaFolder = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass('clian-settings-media-input');
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.systemPrompt.name'))
      .setDesc(t('settings.systemPrompt.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.systemPrompt.name'))
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.enableAutoScroll.name'))
      .setDesc(t('settings.enableAutoScroll.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoScroll ?? true)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoScroll = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.autoTitle.name'))
      .setDesc(t('settings.autoTitle.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoTitleGeneration)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoTitleGeneration = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.enableAutoTitleGeneration) {
      new Setting(containerEl)
        .setName(t('settings.titleEngine.name'))
        .setDesc(t('settings.titleEngine.desc'))
        .addDropdown((dropdown) => {
          dropdown.addOption('auto', t('settings.titleEngine.auto'));
          dropdown.addOption('claude', t('settings.titleEngine.claude'));

          dropdown
            .setValue(this.plugin.settings.titleGenerationEngine ?? 'auto')
            .onChange(async (value: TitleGenerationEngine) => {
              this.plugin.settings.titleGenerationEngine = value;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName(t('settings.titleModel.name'))
        .setDesc(t('settings.titleModel.desc'))
        .addDropdown((dropdown) => {
          // Add "Auto" option (empty string = use default logic)
          dropdown.addOption('', t('settings.titleModel.auto'));

          // Get available models from environment or defaults
          const envVars = parseEnvironmentVariables(this.plugin.settings.environmentVariables);
          const customModels = getModelsFromEnvironment(envVars);
          const models = [...DEFAULT_CLAUDE_MODELS];
          for (const model of customModels) {
            if (!models.some((m) => m.value === model.value)) {
              models.push(model);
            }
          }
          for (const modelId of this.plugin.settings.extraClaudeModels || []) {
            const trimmed = modelId.trim();
            if (!trimmed) continue;
            if (!models.some((m) => m.value === trimmed)) {
              models.push({ value: trimmed, label: trimmed, description: 'Custom (from settings)' });
            }
          }

          for (const model of models) {
            dropdown.addOption(model.value, model.label);
          }

          dropdown
            .setValue(this.plugin.settings.titleGenerationModel || '')
            .onChange(async (value) => {
              this.plugin.settings.titleGenerationModel = value;
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName(t('settings.navMappings.name'))
      .setDesc(t('settings.navMappings.desc'))
      .addTextArea((text) => {
        let pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
        let saveTimeout: number | null = null;

        const commitValue = async (showError: boolean): Promise<void> => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
            saveTimeout = null;
          }

          const result = parseNavMappings(pendingValue);
          if (!result.settings) {
            if (showError) {
              new Notice(`${t('common.error')}: ${result.error}`);
              pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
              text.setValue(pendingValue);
            }
            return;
          }

          this.plugin.settings.keyboardNavigation.scrollUpKey = result.settings.scrollUp;
          this.plugin.settings.keyboardNavigation.scrollDownKey = result.settings.scrollDown;
          this.plugin.settings.keyboardNavigation.focusInputKey = result.settings.focusInput;
          await this.plugin.saveSettings();
          pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
          text.setValue(pendingValue);
        };

        const scheduleSave = (): void => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
          }
          saveTimeout = window.setTimeout(() => {
            void commitValue(false);
          }, 500);
        };

        text
          .setPlaceholder('map w scrollUp\nmap s scrollDown\nmap i focusInput')
          .setValue(pendingValue)
          .onChange((value) => {
            pendingValue = value;
            scheduleSave();
          });

        text.inputEl.rows = 3;
        text.inputEl.addEventListener('blur', async () => {
          await commitValue(true);
        });
      });

    // Tab bar position setting
    new Setting(containerEl)
      .setName(t('settings.tabBarPosition.name'))
      .setDesc(t('settings.tabBarPosition.desc'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('input', t('settings.tabBarPosition.input'))
          .addOption('header', t('settings.tabBarPosition.header'))
          .setValue(this.plugin.settings.tabBarPosition ?? 'input')
          .onChange(async (value: 'input' | 'header') => {
            this.plugin.settings.tabBarPosition = value;
            await this.plugin.saveSettings();

            // Update all views' layouts immediately
            for (const view of this.plugin.getAllViews()) {
              view.updateLayoutForPosition();
            }
          });
      });

    // Open in main tab setting
    new Setting(containerEl)
      .setName(t('settings.openInMainTab.name'))
      .setDesc(t('settings.openInMainTab.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openInMainTab)
          .onChange(async (value) => {
            this.plugin.settings.openInMainTab = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName(t('settings.hotkeys')).setHeading();

    const hotkeyGrid = containerEl.createDiv({ cls: 'clian-hotkey-grid' });
    addHotkeySettingRow(hotkeyGrid, this.app, 'clian:inline-edit', 'settings.inlineEditHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'clian:open-view', 'settings.openChatHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'clian:new-session', 'settings.newSessionHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'clian:new-tab', 'settings.newTabHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'clian:close-current-tab', 'settings.closeTabHotkey');

    let commandsSettings: SlashCommandSettings | null = null;
    let skillsSettings: SlashCommandSettings | null = null;

    const onSlashCommandsChanged = () => {
      commandsSettings?.refresh();
      skillsSettings?.refresh();
    };

    new Setting(containerEl).setName(t('settings.slashCommands.name')).setHeading();

    const slashCommandsDesc = containerEl.createDiv({ cls: 'clian-sp-settings-desc' });
    slashCommandsDesc.createEl('p', { cls: 'setting-item-description', text: t('settings.slashCommands.desc') });

    const slashCommandsContainer = containerEl.createDiv({ cls: 'clian-slash-commands-container' });
    commandsSettings = new SlashCommandSettings(slashCommandsContainer, this.plugin, {
      kind: 'command',
      onDidChange: onSlashCommandsChanged,
    });

    new Setting(containerEl)
      .setName(t('settings.hiddenSlashCommands.name'))
      .setDesc(t('settings.hiddenSlashCommands.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.hiddenSlashCommands.placeholder'))
          .setValue((this.plugin.settings.hiddenSlashCommands || []).join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.hiddenSlashCommands = value
              .split(/\r?\n/)
              .map((s) => s.trim().replace(/^\//, ''))
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
            this.plugin.getView()?.updateHiddenSlashCommands();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(containerEl).setName(t('settings.skills.name')).setHeading();

    const skillsDesc = containerEl.createDiv({ cls: 'clian-sp-settings-desc' });
    const skillsDescP = skillsDesc.createEl('p', { cls: 'setting-item-description' });
    skillsDescP.appendText(t('settings.skills.desc') + ' ');
    skillsDescP.createEl('a', {
      text: 'Learn more',
      href: 'https://code.claude.com/docs/en/skills',
    });

    const skillsContainer = containerEl.createDiv({ cls: 'clian-skills-container' });
    skillsSettings = new SlashCommandSettings(skillsContainer, this.plugin, {
      kind: 'skill',
      onDidChange: onSlashCommandsChanged,
    });

    new Setting(containerEl).setName(t('settings.subagents.name')).setHeading();

    const agentsDesc = containerEl.createDiv({ cls: 'clian-sp-settings-desc' });
    agentsDesc.createEl('p', {
      text: t('settings.subagents.desc'),
      cls: 'setting-item-description',
    });

    const agentsContainer = containerEl.createDiv({ cls: 'clian-agents-container' });
    new AgentSettings(agentsContainer, this.plugin);

    new Setting(containerEl).setName(t('settings.mcpServers.name')).setHeading();

    const mcpDesc = containerEl.createDiv({ cls: 'clian-mcp-settings-desc' });
    mcpDesc.createEl('p', {
      text: t('settings.mcpServers.desc'),
      cls: 'setting-item-description',
    });

    const mcpContainer = containerEl.createDiv({ cls: 'clian-mcp-container' });
    new McpSettingsManager(mcpContainer, this.plugin);

    new Setting(containerEl).setName(t('settings.plugins.name')).setHeading();

    const pluginsDesc = containerEl.createDiv({ cls: 'clian-plugin-settings-desc' });
    pluginsDesc.createEl('p', {
      text: t('settings.plugins.desc'),
      cls: 'setting-item-description',
    });

    const pluginsContainer = containerEl.createDiv({ cls: 'clian-plugins-container' });
    new PluginSettingsManager(pluginsContainer, this.plugin);

    new Setting(containerEl).setName(t('settings.safety')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.loadUserSettings.name'))
      .setDesc(t('settings.loadUserSettings.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.loadUserClaudeSettings)
          .onChange(async (value) => {
            this.plugin.settings.loadUserClaudeSettings = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.enableBlocklist.name'))
      .setDesc(t('settings.enableBlocklist.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableBlocklist)
          .onChange(async (value) => {
            this.plugin.settings.enableBlocklist = value;
            await this.plugin.saveSettings();
          })
      );

    const platformKey = getCurrentPlatformKey();
    const isWindows = platformKey === 'windows';
    const platformLabel = isWindows ? 'Windows' : 'Unix';

    new Setting(containerEl)
      .setName(t('settings.blockedCommands.name', { platform: platformLabel }))
      .setDesc(t('settings.blockedCommands.desc', { platform: platformLabel }))
      .addTextArea((text) => {
        const placeholder = isWindows
          ? 'del /s /q\nrd /s /q\nRemove-Item -Recurse -Force'
          : 'rm -rf\nchmod 777\nmkfs';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.blockedCommands[platformKey].join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.blockedCommands[platformKey] = value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
      });

    // On Windows, show Unix blocklist too since Git Bash can run Unix commands
    if (isWindows) {
      new Setting(containerEl)
        .setName(t('settings.blockedCommands.unixName'))
        .setDesc(t('settings.blockedCommands.unixDesc'))
        .addTextArea((text) => {
          text
            .setPlaceholder('rm -rf\nchmod 777\nmkfs')
            .setValue(this.plugin.settings.blockedCommands.unix.join('\n'))
            .onChange(async (value) => {
              this.plugin.settings.blockedCommands.unix = value
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              await this.plugin.saveSettings();
            });
          text.inputEl.rows = 4;
          text.inputEl.cols = 40;
        });
    }

    new Setting(containerEl)
      .setName(t('settings.exportPaths.name'))
      .setDesc(t('settings.exportPaths.desc'))
      .addTextArea((text) => {
        const placeholder = process.platform === 'win32'
          ? '~/Desktop\n~/Downloads\n%TEMP%'
          : '~/Desktop\n~/Downloads\n/tmp';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.allowedExportPaths.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.allowedExportPaths = value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl).setName(t('settings.environment')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.customVariables.name'))
      .setDesc(t('settings.customVariables.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder('ANTHROPIC_API_KEY=your-key\nANTHROPIC_BASE_URL=https://api.example.com\nANTHROPIC_MODEL=custom-model')
          .setValue(this.plugin.settings.environmentVariables);
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addClass('clian-settings-env-textarea');
        text.inputEl.addEventListener('blur', async () => {
          await this.plugin.applyEnvironmentVariables(text.inputEl.value);
          this.renderContextLimitsSection();
        });
      });

    this.contextLimitsContainer = containerEl.createDiv({ cls: 'clian-context-limits-container' });
    this.renderContextLimitsSection();

    const envSnippetsContainer = containerEl.createDiv({ cls: 'clian-env-snippets-container' });
    new EnvSnippetManager(envSnippetsContainer, this.plugin, () => {
      this.renderContextLimitsSection();
    });

    new Setting(containerEl).setName(t('settings.advanced')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.show1MModel.name'))
      .setDesc(t('settings.show1MModel.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.show1MModel ?? false)
          .onChange(async (value) => {
            this.plugin.settings.show1MModel = value;
            await this.plugin.saveSettings();

            this.plugin.getView()?.refreshModelSelector();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.extraClaudeModels.name'))
      .setDesc(t('settings.extraClaudeModels.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder('claude-sonnet-4-5-YYYYMMDD\nclaude-opus-4-6-YYYYMMDD')
          .setValue((this.plugin.settings.extraClaudeModels || []).join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.extraClaudeModels = value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
            this.plugin.getView()?.refreshModelSelector();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 50;
      });

    new Setting(containerEl)
      .setName(t('settings.enableChrome.name'))
      .setDesc(t('settings.enableChrome.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableChrome ?? false)
          .onChange(async (value) => {
            this.plugin.settings.enableChrome = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.enableBangBash.name'))
      .setDesc(t('settings.enableBangBash.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableBangBash ?? false)
          .onChange(async (value) => {
            bangBashValidationEl.style.display = 'none';
            if (value) {
              const enhancedPath = getEnhancedPath();
              const nodePath = findNodeExecutable(enhancedPath);
              if (!nodePath) {
                bangBashValidationEl.setText(t('settings.enableBangBash.validation.noNode'));
                bangBashValidationEl.style.display = 'block';
                toggle.setValue(false);
                return;
              }
            }
            this.plugin.settings.enableBangBash = value;
            await this.plugin.saveSettings();
          })
      );

    const bangBashValidationEl = containerEl.createDiv({ cls: 'clian-bang-bash-validation' });
    bangBashValidationEl.style.color = 'var(--text-error)';
    bangBashValidationEl.style.fontSize = '0.85em';
    bangBashValidationEl.style.marginTop = '-0.5em';
    bangBashValidationEl.style.marginBottom = '0.5em';
    bangBashValidationEl.style.display = 'none';

    const maxTabsSetting = new Setting(containerEl)
      .setName(t('settings.maxTabs.name'))
      .setDesc(t('settings.maxTabs.desc'));

    const maxTabsWarningEl = containerEl.createDiv({ cls: 'clian-max-tabs-warning' });
    maxTabsWarningEl.style.color = 'var(--text-warning)';
    maxTabsWarningEl.style.fontSize = '0.85em';
    maxTabsWarningEl.style.marginTop = '-0.5em';
    maxTabsWarningEl.style.marginBottom = '0.5em';
    maxTabsWarningEl.style.display = 'none';
    maxTabsWarningEl.setText(t('settings.maxTabs.warning'));

    const normalizeMaxTabs = (value: number): number => {
      if (!Number.isFinite(value)) {
        return DEFAULT_MAX_TABS;
      }

      return Math.max(MIN_TABS, Math.floor(value));
    };

    const updateMaxTabsWarning = (value: number): void => {
      maxTabsWarningEl.style.display = value > 5 ? 'block' : 'none';
    };

    maxTabsSetting.addText((text) => {
      const savedValue = normalizeMaxTabs(this.plugin.settings.maxTabs ?? DEFAULT_MAX_TABS);
      text
        .setPlaceholder(String(DEFAULT_MAX_TABS))
        .setValue(String(savedValue))
        .onChange(async (value) => {
          const trimmed = value.trim();
          if (!trimmed) {
            return;
          }

          const parsed = Number(trimmed);
          if (!Number.isFinite(parsed)) {
            return;
          }

          const normalized = normalizeMaxTabs(parsed);
          this.plugin.settings.maxTabs = normalized;
          await this.plugin.saveSettings();
          updateMaxTabsWarning(normalized);
        });

      text.inputEl.type = 'number';
      text.inputEl.min = String(MIN_TABS);
      text.inputEl.step = '1';
      text.inputEl.addEventListener('blur', async () => {
        const normalized = normalizeMaxTabs(Number(text.inputEl.value.trim()));
        text.setValue(String(normalized));
        if (this.plugin.settings.maxTabs !== normalized) {
          this.plugin.settings.maxTabs = normalized;
          await this.plugin.saveSettings();
          updateMaxTabsWarning(normalized);
        }
      });

      updateMaxTabsWarning(savedValue);
    });

    const hostnameKey = getHostnameKey();

    new Setting(containerEl).setName(t('settings.claude.name')).setHeading();

    const claudeDesc = containerEl.createDiv({ cls: 'clian-sp-settings-desc' });
    claudeDesc.createEl('p', { text: t('settings.claude.desc'), cls: 'setting-item-description' });

    new Setting(containerEl)
      .setName(t('settings.claude.model.name'))
      .setDesc(t('settings.claude.model.desc'))
      .addDropdown((dropdown) => {
        const envVars = parseEnvironmentVariables(this.plugin.settings.environmentVariables);
        const customModels = getModelsFromEnvironment(envVars);

        const models = [...DEFAULT_CLAUDE_MODELS];
        for (const model of customModels) {
          if (!models.some((m) => m.value === model.value)) {
            models.push(model);
          }
        }
        for (const modelId of this.plugin.settings.extraClaudeModels || []) {
          const trimmed = modelId.trim();
          if (!trimmed) continue;
          if (!models.some((m) => m.value === trimmed)) {
            models.push({ value: trimmed, label: trimmed, description: 'Custom (from settings)' });
          }
        }

        for (const model of models) {
          dropdown.addOption(model.value, model.label);
        }

        dropdown
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            const model = String(value || '').trim();
            if (!model) return;

            this.plugin.settings.model = model;
            const isDefaultModel = DEFAULT_CLAUDE_MODELS.some((m) => m.value === model);
            if (isDefaultModel) {
              this.plugin.settings.thinkingBudget = DEFAULT_THINKING_BUDGET[model];
              this.plugin.settings.lastClaudeModel = model;
            } else {
              this.plugin.settings.lastCustomModel = model;
            }

            await this.plugin.saveSettings();

            const view = this.plugin.getView();
            const tabs = view?.getTabManager()?.getAllTabs() ?? [];
            for (const tab of tabs) {
              tab.ui.modelSelector?.updateDisplay();
              tab.ui.modelSelector?.renderOptions();
              tab.ui.thinkingBudgetSelector?.updateDisplay();
            }
          });
      });

    new Setting(containerEl)
      .setName(t('settings.claude.thinking.name'))
      .setDesc(t('settings.claude.thinking.desc'))
      .addDropdown((dropdown) => {
        for (const budget of THINKING_BUDGETS) {
          dropdown.addOption(budget.value, budget.label);
        }

        dropdown
          .setValue(this.plugin.settings.thinkingBudget)
          .onChange(async (value) => {
            this.plugin.settings.thinkingBudget = value as ThinkingBudget;
            await this.plugin.saveSettings();

            const view = this.plugin.getView();
            const tabs = view?.getTabManager()?.getAllTabs() ?? [];
            for (const tab of tabs) {
              tab.ui.thinkingBudgetSelector?.updateDisplay();
            }
          });
      });

    const platformDesc = process.platform === 'win32'
      ? t('settings.cliPath.descWindows')
      : t('settings.cliPath.descUnix');
    const cliPathDescription = `${t('settings.cliPath.desc')} ${platformDesc}`;

    const cliPathSetting = new Setting(containerEl)
      .setName(`${t('settings.cliPath.name')} (${hostnameKey})`)
      .setDesc(cliPathDescription);

    const validationEl = containerEl.createDiv({ cls: 'clian-cli-path-validation' });
    validationEl.style.color = 'var(--text-error)';
    validationEl.style.fontSize = '0.85em';
    validationEl.style.marginTop = '-0.5em';
    validationEl.style.marginBottom = '0.5em';
    validationEl.style.display = 'none';

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null; // Empty is valid (auto-detect)

      const expandedPath = expandHomePath(trimmed);

      if (!fs.existsSync(expandedPath)) {
        return t('settings.cliPath.validation.notExist');
      }
      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
        return t('settings.cliPath.validation.isDirectory');
      }
      return null;
    };

    cliPathSetting.addText((text) => {
      const placeholder = process.platform === 'win32'
        ? 'D:\\nodejs\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
        : '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';

      const currentValue = this.plugin.settings.claudeCliPathsByHost?.[hostnameKey] || '';

      text
        .setPlaceholder(placeholder)
        .setValue(currentValue)
        .onChange(async (value) => {
          const error = validatePath(value);
          if (error) {
            validationEl.setText(error);
            validationEl.style.display = 'block';
            text.inputEl.style.borderColor = 'var(--text-error)';
          } else {
            validationEl.style.display = 'none';
            text.inputEl.style.borderColor = '';
          }

          const trimmed = value.trim();
          if (!this.plugin.settings.claudeCliPathsByHost) {
            this.plugin.settings.claudeCliPathsByHost = {};
          }
          this.plugin.settings.claudeCliPathsByHost[hostnameKey] = trimmed;
          await this.plugin.saveSettings();
          this.plugin.cliResolver?.reset();
          const view = this.plugin.getView();
          await view?.getTabManager()?.broadcastToAllTabs(
            (service) => Promise.resolve(service.cleanup())
          );
        });
      text.inputEl.addClass('clian-settings-cli-path-input');
      text.inputEl.style.width = '100%';

      const initialError = validatePath(currentValue);
      if (initialError) {
        validationEl.setText(initialError);
        validationEl.style.display = 'block';
        text.inputEl.style.borderColor = 'var(--text-error)';
      }
    });

    new Setting(containerEl).setName(t('settings.codex.name')).setHeading();

    const codexDesc = containerEl.createDiv({ cls: 'clian-sp-settings-desc' });
    codexDesc.createEl('p', { text: t('settings.codex.desc'), cls: 'setting-item-description' });

    new Setting(containerEl)
      .setName(`${t('settings.codex.command.name')} (${hostnameKey})`)
      .setDesc(t('settings.codex.command.desc'))
      .addText((text) => {
        const placeholder = process.platform === 'win32' ? '%APPDATA%\\npm\\codex.cmd' : 'codex';
        const currentValue = this.plugin.settings.codexCliCommandsByHost?.[hostnameKey] || '';

        text
          .setPlaceholder(placeholder)
          .setValue(currentValue)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!this.plugin.settings.codexCliCommandsByHost) {
              this.plugin.settings.codexCliCommandsByHost = {};
            }
            this.plugin.settings.codexCliCommandsByHost[hostnameKey] = trimmed;
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName(t('settings.codex.model.name'))
      .setDesc(t('settings.codex.model.desc'))
      .addDropdown((dropdown) => {
        const base = [...DEFAULT_CODEX_MODELS];
        const current = (this.plugin.settings.codexModel || '').trim();
        if (current && !base.some((m) => m.value === current)) {
          base.splice(1, 0, { value: current, label: current, description: 'Custom (from settings)' });
        }

        for (const model of base) {
          dropdown.addOption(model.value, model.label);
        }

        dropdown
          .setValue(current)
          .onChange(async (value) => {
            this.plugin.settings.codexModel = String(value || '').trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t('settings.codex.thinking.name'))
      .setDesc(t('settings.codex.thinking.desc'))
      .addDropdown((dropdown) => {
        for (const opt of CODEX_REASONING_EFFORT_OPTIONS) {
          dropdown.addOption(opt.value, opt.label);
        }

        dropdown
          .setValue(normalizeCodexReasoningEffort(this.plugin.settings.codexReasoningEffort))
          .onChange(async (value) => {
            this.plugin.settings.codexReasoningEffort = normalizeCodexReasoningEffort(value);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName(t('settings.gemini.name')).setHeading();

    const geminiDesc = containerEl.createDiv({ cls: 'clian-sp-settings-desc' });
    geminiDesc.createEl('p', { text: t('settings.gemini.desc'), cls: 'setting-item-description' });

    new Setting(containerEl)
      .setName(`${t('settings.gemini.command.name')} (${hostnameKey})`)
      .setDesc(t('settings.gemini.command.desc'))
      .addText((text) => {
        const placeholder = process.platform === 'win32' ? '%APPDATA%\\npm\\gemini.cmd' : 'gemini';
        const currentValue = this.plugin.settings.geminiCliCommandsByHost?.[hostnameKey] || '';

        text
          .setPlaceholder(placeholder)
          .setValue(currentValue)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!this.plugin.settings.geminiCliCommandsByHost) {
              this.plugin.settings.geminiCliCommandsByHost = {};
            }
            this.plugin.settings.geminiCliCommandsByHost[hostnameKey] = trimmed;
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName(t('settings.gemini.model.name'))
      .setDesc(t('settings.gemini.model.desc'))
      .addDropdown((dropdown) => {
        const base = [...DEFAULT_GEMINI_MODELS];
        const current = (this.plugin.settings.geminiModel || '').trim();
        if (current && !base.some((m) => m.value === current)) {
          base.splice(1, 0, { value: current, label: current, description: 'Custom (from settings)' });
        }

        for (const model of base) {
          dropdown.addOption(model.value, model.label);
        }

        dropdown
          .setValue(current)
          .onChange(async (value) => {
            this.plugin.settings.geminiModel = String(value || '').trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t('settings.gemini.thinking.name'))
      .setDesc(t('settings.gemini.thinking.desc'))
      .addDropdown((dropdown) => {
        for (const opt of GEMINI_THINKING_MODE_OPTIONS) {
          dropdown.addOption(opt.value, opt.label);
        }

        dropdown
          .setValue(normalizeGeminiThinkingMode(this.plugin.settings.geminiThinkingMode))
          .onChange(async (value) => {
            this.plugin.settings.geminiThinkingMode = normalizeGeminiThinkingMode(value);
            await this.plugin.saveSettings();
          });
      });
  }

  private renderContextLimitsSection(): void {
    const container = this.contextLimitsContainer;
    if (!container) return;

    container.empty();

    const envVars = parseEnvironmentVariables(this.plugin.settings.environmentVariables);
    const uniqueModelIds = getCustomModelIds(envVars);

    if (uniqueModelIds.size === 0) {
      return;
    }

    const headerEl = container.createDiv({ cls: 'clian-context-limits-header' });
    headerEl.createSpan({ text: t('settings.customContextLimits.name'), cls: 'clian-context-limits-label' });

    const descEl = container.createDiv({ cls: 'clian-context-limits-desc' });
    descEl.setText(t('settings.customContextLimits.desc'));

    const listEl = container.createDiv({ cls: 'clian-context-limits-list' });

    for (const modelId of uniqueModelIds) {
      const currentValue = this.plugin.settings.customContextLimits?.[modelId];

      const itemEl = listEl.createDiv({ cls: 'clian-context-limits-item' });

      const nameEl = itemEl.createDiv({ cls: 'clian-context-limits-model' });
      nameEl.setText(modelId);

      const inputWrapper = itemEl.createDiv({ cls: 'clian-context-limits-input-wrapper' });

      const inputEl = inputWrapper.createEl('input', {
        type: 'text',
        placeholder: '200k',
        cls: 'clian-context-limits-input',
        value: currentValue ? formatContextLimit(currentValue) : '',
      });

      // Validation element
      const validationEl = inputWrapper.createDiv({ cls: 'clian-context-limit-validation' });

      inputEl.addEventListener('input', async () => {
        const trimmed = inputEl.value.trim();

        if (!this.plugin.settings.customContextLimits) {
          this.plugin.settings.customContextLimits = {};
        }

        if (!trimmed) {
          // Empty = use default (remove from custom limits)
          delete this.plugin.settings.customContextLimits[modelId];
          validationEl.style.display = 'none';
          inputEl.classList.remove('clian-input-error');
        } else {
          const parsed = parseContextLimit(trimmed);
          if (parsed === null) {
            validationEl.setText(t('settings.customContextLimits.invalid'));
            validationEl.style.display = 'block';
            inputEl.classList.add('clian-input-error');
            return; // Don't save invalid value
          }

          this.plugin.settings.customContextLimits[modelId] = parsed;
          validationEl.style.display = 'none';
          inputEl.classList.remove('clian-input-error');
        }

        await this.plugin.saveSettings();
      });
    }
  }

  private async restartServiceForPromptChange(): Promise<void> {
    const view = this.plugin.getView();
    const tabManager = view?.getTabManager();
    if (!tabManager) return;

    try {
      await tabManager.broadcastToAllTabs(
        async (service) => { await service.ensureReady({ force: true }); }
      );
    } catch {
      // Silently ignore restart failures - changes will apply on next conversation
    }
  }

}
