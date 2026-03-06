import type { WorkspaceLeaf } from 'obsidian';
import { Notice, Plugin } from 'obsidian';

import { VIEW_TYPE_CLIAN } from '../core/types/chat';
import { MobileSettingsTab } from './MobileSettingsTab';
import { ClianMobileView } from './MobileView';
import { DEFAULT_MOBILE_SETTINGS, type MobileSettings } from './types';

export default class ClianMobilePlugin extends Plugin {
  settings: MobileSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_CLIAN, (leaf: WorkspaceLeaf) => new ClianMobileView(leaf, this, VIEW_TYPE_CLIAN));

    this.addRibbonIcon('bot', 'Open Clian', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-view',
      name: 'Open chat view',
      callback: () => void this.activateView(),
    });

    this.addSettingTab(new MobileSettingsTab(this));
  }

  onunload(): void {
    // View cleanup is handled by Obsidian.
  }

  private getChatLeaves(): WorkspaceLeaf[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_CLIAN);
  }

  getView(): ClianMobileView | null {
    const leaves = this.getChatLeaves();
    if (leaves.length > 0) {
      return leaves[0].view as ClianMobileView;
    }
    return null;
  }

  async activateView(): Promise<void> {
    // Reuse existing leaf if present
    const leaves = this.getChatLeaves();
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf =
      this.app.workspace.getLeaf('tab') ??
      this.app.workspace.getRightLeaf(false) ??
      this.app.workspace.getLeaf(false);
    if (!leaf) {
      new Notice('Failed to open Clian view.');
      return;
    }

    await leaf.setViewState({ type: VIEW_TYPE_CLIAN, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    const mobile = typeof data.mobile === 'object' && data.mobile ? (data.mobile as Partial<MobileSettings>) : {};
    this.settings = { ...DEFAULT_MOBILE_SETTINGS, ...mobile };
  }

  async saveSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    data.mobile = this.settings;
    await this.saveData(data);
  }
}
