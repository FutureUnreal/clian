import { PluginSettingTab, Setting } from 'obsidian';

import type ClianMobilePlugin from './main';

export class MobileSettingsTab extends PluginSettingTab {
  plugin: ClianMobilePlugin;

  constructor(plugin: ClianMobilePlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Clian (Mobile) - Remote Hub' });

    new Setting(containerEl)
      .setName('Hub URL')
      .setDesc('Example: http://192.168.1.10:3006')
      .addText((text) => {
        text
          .setPlaceholder('http://127.0.0.1:3006')
          .setValue(this.plugin.settings.hubUrl)
          .onChange(async (value) => {
            this.plugin.settings.hubUrl = value.trim();
            await this.plugin.saveSettings();
            this.plugin.getView()?.onSettingsChanged();
          });
      });

    new Setting(containerEl)
      .setName('Hub access token')
      .setDesc('Access token for your hub. Stored in the vault at .obsidian/plugins/clian/data.json.')
      .addText((text) => {
        text
          .setPlaceholder('token[:namespace]')
          .setValue(this.plugin.settings.accessToken)
          .onChange(async (value) => {
            this.plugin.settings.accessToken = value.trim();
            await this.plugin.saveSettings();
            this.plugin.getView()?.onSettingsChanged();
          });
        text.inputEl.type = 'password';
      });

    containerEl.createEl('p', {
      text: 'Mobile uses SSE (Server-Sent Events) for real-time updates (no polling). Use the Refresh button in the chat view to reconnect and resync.',
    }).style.color = 'var(--text-muted)';
  }
}
