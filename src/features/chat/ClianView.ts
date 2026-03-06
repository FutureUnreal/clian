import type { EventRef, WorkspaceLeaf } from 'obsidian';
import { ItemView, Notice, setIcon } from 'obsidian';

import { type ChatFlavor, type ClianViewType, VIEW_TYPE_CLIAN } from '../../core/types';
import type ClianPlugin from '../../main';
import { GEMINI_ICON_SVG, LOGO_SVG, OPENAI_LOGO_SVG } from './constants';
import { TabBar, TabManager, updatePlanModeUI } from './tabs';
import type { TabData, TabId } from './tabs/types';

const SVG_NS = 'http://www.w3.org/2000/svg';
let geminiGradientCounter = 0;

function clearChildren(el: HTMLElement): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

export class ClianView extends ItemView {
  private plugin: ClianPlugin;
  private viewType: ClianViewType;

  // Tab management
  private tabManager: TabManager | null = null;
  private tabBar: TabBar | null = null;
  private tabBarContainerEl: HTMLElement | null = null;
  private tabContentEl: HTMLElement | null = null;
  private navRowContent: HTMLElement | null = null;

  // DOM Elements
  private viewContainerEl: HTMLElement | null = null;
  private headerEl: HTMLElement | null = null;
  private titleSlotEl: HTMLElement | null = null;
  private logoEl: HTMLElement | null = null;
  private titleTextEl: HTMLElement | null = null;
  private headerActionsEl: HTMLElement | null = null;
  private headerActionsContent: HTMLElement | null = null;

  // Header elements
  private historyDropdown: HTMLElement | null = null;
  private engineSwitchButtons: Partial<Record<ChatFlavor, HTMLElement>> = {};

  // Event refs for cleanup
  private eventRefs: EventRef[] = [];

  // Debouncing for tab bar updates
  private pendingTabBarUpdate: number | null = null;

  // Debouncing for tab state persistence
  private pendingPersist: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClianPlugin, viewType: ClianViewType = VIEW_TYPE_CLIAN) {
    super(leaf);
    this.plugin = plugin;
    this.viewType = viewType;

    // Hover Editor compatibility: Define load as an instance method that can't be
    // overwritten by prototype patching. Hover Editor patches ClianView.prototype.load
    // after our class is defined, but instance methods take precedence over prototype methods.
    const originalLoad = Object.getPrototypeOf(this).load.bind(this);
    Object.defineProperty(this, 'load', {
      value: async () => {
        // Ensure containerEl exists before any patched load code tries to use it
        if (!this.containerEl) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this as any).containerEl = createDiv({ cls: 'view-content' });
        }
        // Wrap in try-catch to prevent Hover Editor errors from breaking our view
        try {
          return await originalLoad();
        } catch {
          // Hover Editor may throw if its DOM setup fails - continue anyway
        }
      },
      writable: false,
      configurable: false,
    });
  }

  getViewType(): string {
    return this.viewType;
  }

  getDisplayText(): string {
    return 'Clian';
  }

  getIcon(): string {
    return 'bot';
  }

  /** Refreshes the model selector display (used after env var changes). */
  refreshModelSelector(): void {
    const activeTab = this.tabManager?.getActiveTab();
    activeTab?.ui.modelSelector?.updateDisplay();
    activeTab?.ui.modelSelector?.renderOptions();
  }

  /** Updates hidden slash commands on all tabs (used after settings change). */
  updateHiddenSlashCommands(): void {
    const hiddenCommands = new Set(
      (this.plugin.settings.hiddenSlashCommands || []).map(c => c.toLowerCase())
    );
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      tab.ui.slashCommandDropdown?.setHiddenCommands(hiddenCommands);
    }
  }

  async onOpen() {
    // Guard: Hover Editor and similar plugins may call onOpen before DOM is ready.
    // containerEl must exist before we can access contentEl or create elements.
    if (!this.containerEl) {
      return;
    }

    // Use contentEl (standard Obsidian API) as primary target.
    // Hover Editor and other plugins may modify the DOM structure,
    // so we need fallbacks to handle non-standard scenarios.
    let container: HTMLElement | null =
      this.contentEl ?? (this.containerEl.children[1] as HTMLElement | null);

    if (!container) {
      // Last resort: create our own container inside containerEl
      container = this.containerEl.createDiv();
    }

    this.viewContainerEl = container;
    this.viewContainerEl.empty();
    this.viewContainerEl.addClass('clian-container');

    // Build header (logo only, tab bar and actions moved to nav row)
    const header = this.viewContainerEl.createDiv({ cls: 'clian-header' });
    this.buildHeader(header);

    // Build nav row content (tab badges + header actions)
    this.navRowContent = this.buildNavRowContent();

    // Tab content container (TabManager will populate this)
    this.tabContentEl = this.viewContainerEl.createDiv({ cls: 'clian-tab-content-container' });

    // Initialize TabManager
    this.tabManager = new TabManager(
      this.plugin,
      this.plugin.mcpManager,
      this.tabContentEl,
      this,
      {
        onTabCreated: () => {
          this.updateTabBar();
          this.updateNavRowLocation();
          this.persistTabState();
        },
        onTabSwitched: () => {
          this.updateTabBar();
          this.updateActiveEngineUI();
          this.updateHistoryDropdown();
          this.updateNavRowLocation();
          this.persistTabState();
        },
        onTabClosed: () => {
          this.updateTabBar();
          this.persistTabState();
        },
        onTabStreamingChanged: () => this.updateTabBar(),
        onTabTitleChanged: () => this.updateTabBar(),
        onTabAttentionChanged: () => this.updateTabBar(),
        onTabConversationChanged: () => {
          this.persistTabState();
        },
      }
    );

    // Wire up view-level event handlers
    this.wireEventHandlers();

    // Restore tabs from persisted state or create default tab
    await this.restoreOrCreateTabs();

    // Apply initial layout based on tabBarPosition setting
    this.updateLayoutForPosition();
  }

  async onClose() {
    // Cancel any pending tab bar update
    if (this.pendingTabBarUpdate !== null) {
      cancelAnimationFrame(this.pendingTabBarUpdate);
      this.pendingTabBarUpdate = null;
    }

    // Cleanup event refs
    for (const ref of this.eventRefs) {
      this.plugin.app.vault.offref(ref);
    }
    this.eventRefs = [];

    // Persist tab state before cleanup (immediate, not debounced)
    await this.persistTabStateImmediate();

    // Destroy tab manager and all tabs
    await this.tabManager?.destroy();
    this.tabManager = null;

    // Cleanup tab bar
    this.tabBar?.destroy();
    this.tabBar = null;
  }

  // ============================================
  // UI Building
  // ============================================

  private buildHeader(header: HTMLElement) {
    this.headerEl = header;

    // Title slot container (logo + title or tabs)
    this.titleSlotEl = header.createDiv({ cls: 'clian-title-slot' });

    // Logo (hidden when 2+ tabs) - icon follows active engine
    this.logoEl = this.titleSlotEl.createSpan({ cls: 'clian-logo' });
    this.renderEngineLogo(this.logoEl, 'claude', 18);

    // Title text (hidden in header mode when 2+ tabs)
    this.titleTextEl = this.titleSlotEl.createEl('h4', { text: 'Clian', cls: 'clian-title-text' });

    // Header actions container (for header mode - initially hidden)
    this.headerActionsEl = header.createDiv({ cls: 'clian-header-actions clian-header-actions-slot' });
    this.headerActionsEl.style.display = 'none';
  }

  /**
   * Builds the nav row content (tab badges + header actions).
   * This is called once and the content is moved between locations.
   */
  private buildNavRowContent(): HTMLElement {
    // Create a fragment to hold nav row content
    const fragment = document.createDocumentFragment();

    // Tab badges (left side in nav row, or in title slot for header mode)
    this.tabBarContainerEl = document.createElement('div');
    this.tabBarContainerEl.className = 'clian-tab-bar-container';
    this.tabBar = new TabBar(this.tabBarContainerEl, {
      onTabClick: (tabId) => this.handleTabClick(tabId),
      onTabClose: (tabId) => this.handleTabClose(tabId),
      onNewTab: () => this.handleNewTab(),
    });
    fragment.appendChild(this.tabBarContainerEl);

    // Header actions (right side)
    this.headerActionsContent = document.createElement('div');
    this.headerActionsContent.className = 'clian-header-actions';

    // Engine switcher (direct - not hidden behind "+")
    const engineSwitch = this.headerActionsContent.createDiv({ cls: 'clian-engine-switch' });
    const addEngineSwitchBtn = (label: string, flavor: ChatFlavor): void => {
      const btn = engineSwitch.createDiv({ cls: 'clian-engine-switch-btn' });
      btn.setAttribute('aria-label', `Switch to ${label}`);
      btn.setAttribute('title', label);
      this.renderEngineLogo(btn, flavor, 16);
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.switchToFlavor(flavor);
      });
      this.engineSwitchButtons[flavor] = btn;
    };

    addEngineSwitchBtn('Claude', 'claude');
    addEngineSwitchBtn('Codex', 'codex');
    addEngineSwitchBtn('Gemini', 'gemini');

    // New tab button (plus icon) - creates a new tab in the currently active engine
    const newTabBtn = this.headerActionsContent.createDiv({ cls: 'clian-header-btn clian-new-tab-btn' });
    setIcon(newTabBtn, 'square-plus');
    newTabBtn.setAttribute('aria-label', 'New tab');
    newTabBtn.addEventListener('click', async () => {
      await this.handleNewTab();
    });

    // New conversation button (square-pen icon - new conversation in current tab)
    const newBtn = this.headerActionsContent.createDiv({ cls: 'clian-header-btn' });
    setIcon(newBtn, 'square-pen');
    newBtn.setAttribute('aria-label', 'New conversation');
    newBtn.addEventListener('click', async () => {
      await this.tabManager?.createNewConversation();
      this.updateHistoryDropdown();
    });

    // History dropdown
    const historyContainer = this.headerActionsContent.createDiv({ cls: 'clian-history-container' });
    const historyBtn = historyContainer.createDiv({ cls: 'clian-header-btn' });
    setIcon(historyBtn, 'history');
    historyBtn.setAttribute('aria-label', 'Chat history');

    this.historyDropdown = historyContainer.createDiv({ cls: 'clian-history-menu' });

    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHistoryDropdown();
    });

    fragment.appendChild(this.headerActionsContent);

    // Create a wrapper div to hold the fragment (for input mode nav row)
    const wrapper = document.createElement('div');
    wrapper.style.display = 'contents';
    wrapper.appendChild(fragment);
    return wrapper;
  }

  /**
   * Moves nav row content based on tabBarPosition setting.
   * - 'input' mode: Both tab badges and actions go to active tab's navRowEl
   * - 'header' mode: Tab badges go to title slot (after logo), actions go to header right side
   */
  private updateNavRowLocation(): void {
    if (!this.tabBarContainerEl || !this.headerActionsContent) return;

    const isHeaderMode = this.plugin.settings.tabBarPosition === 'header';

    if (isHeaderMode) {
      // Header mode: Tab badges go to title slot, actions go to header right side
      if (this.titleSlotEl) {
        this.titleSlotEl.appendChild(this.tabBarContainerEl);
      }
      if (this.headerActionsEl) {
        this.headerActionsEl.appendChild(this.headerActionsContent);
        this.headerActionsEl.style.display = 'flex';
      }
    } else {
      // Input mode: Both go to active tab's navRowEl via the wrapper
      const activeTab = this.tabManager?.getActiveTab();
      if (activeTab && this.navRowContent) {
        // Re-assemble the nav row content wrapper
        this.navRowContent.appendChild(this.tabBarContainerEl);
        this.navRowContent.appendChild(this.headerActionsContent);
        activeTab.dom.navRowEl.appendChild(this.navRowContent);
      }
      // Hide header actions slot when in input mode
      if (this.headerActionsEl) {
        this.headerActionsEl.style.display = 'none';
      }
    }
  }

  /**
   * Updates layout when tabBarPosition setting changes.
   * Called from settings when user changes the tab bar position.
   */
  updateLayoutForPosition(): void {
    if (!this.viewContainerEl) return;

    const isHeaderMode = this.plugin.settings.tabBarPosition === 'header';

    // Update container class for CSS styling
    this.viewContainerEl.toggleClass('clian-container--header-mode', isHeaderMode);

    // Move nav content to appropriate location
    this.updateNavRowLocation();

    // Update tab bar and title visibility
    this.updateTabBarVisibility();
  }

  // ============================================
  // Tab Management
  // ============================================

  private handleTabClick(tabId: TabId): void {
    this.tabManager?.switchToTab(tabId);
  }

  private async handleTabClose(tabId: TabId): Promise<void> {
    const tab = this.tabManager?.getTab(tabId);
    // If streaming, treat close like user interrupt (force close cancels the stream)
    const force = tab?.state.isStreaming ?? false;
    await this.tabManager?.closeTab(tabId, force);
    this.updateTabBarVisibility();
  }

  private async switchToFlavor(flavor: ChatFlavor): Promise<void> {
    if (!this.tabManager) return;

    const activeTab = this.tabManager.getActiveTab();
    if (activeTab?.flavor === flavor) {
      return;
    }

    const existing = this.tabManager.getAllTabs().find(t => t.flavor === flavor) ?? null;
    if (existing) {
      await this.tabManager.switchToTab(existing.id);
      return;
    }

    const tab = await this.tabManager.createTab(null, undefined, flavor);
    if (!tab) {
      const maxTabs = this.plugin.settings.maxTabs ?? 3;
      new Notice(`Maximum ${maxTabs} tabs allowed`);
    }
  }

  private async handleNewTab(flavor?: ChatFlavor): Promise<void> {
    const tab = flavor
      ? await this.tabManager?.createTab(null, undefined, flavor)
      : await this.tabManager?.createTab();
    if (!tab) {
      const maxTabs = this.plugin.settings.maxTabs ?? 3;
      new Notice(`Maximum ${maxTabs} tabs allowed`);
      return;
    }
    this.updateTabBarVisibility();
  }

  private updateTabBar(): void {
    if (!this.tabManager || !this.tabBar) return;

    // Debounce tab bar updates using requestAnimationFrame
    if (this.pendingTabBarUpdate !== null) {
      cancelAnimationFrame(this.pendingTabBarUpdate);
    }

    this.pendingTabBarUpdate = requestAnimationFrame(() => {
      this.pendingTabBarUpdate = null;
      if (!this.tabManager || !this.tabBar) return;

      const items = this.tabManager.getTabBarItems();
      this.tabBar.update(items);
      this.updateTabBarVisibility();
    });
  }

  private updateTabBarVisibility(): void {
    if (!this.tabBarContainerEl || !this.tabManager) return;

    const tabCount = this.tabManager.getTabCount();
    const showTabBar = tabCount >= 2;
    const isHeaderMode = this.plugin.settings.tabBarPosition === 'header';

    // Hide tab badges when only 1 tab, show when 2+
    this.tabBarContainerEl.style.display = showTabBar ? 'flex' : 'none';

    // In header mode, badges replace logo/title in the same location
    // In input mode, keep logo/title visible (badges are in nav row)
    const hideBranding = showTabBar && isHeaderMode;
    if (this.logoEl) {
      this.logoEl.style.display = hideBranding ? 'none' : '';
    }
    if (this.titleTextEl) {
      this.titleTextEl.style.display = hideBranding ? 'none' : '';
    }
  }

  private updateActiveEngineUI(): void {
    const flavor = this.tabManager?.getActiveTab()?.flavor ?? 'claude';

    if (this.logoEl) {
      this.renderEngineLogo(this.logoEl, flavor, 18);
    }

    for (const key of Object.keys(this.engineSwitchButtons) as ChatFlavor[]) {
      const btn = this.engineSwitchButtons[key];
      btn?.classList.toggle('is-active', key === flavor);
    }
  }

  private renderEngineLogo(targetEl: HTMLElement, flavor: ChatFlavor, sizePx: number): void {
    clearChildren(targetEl);

    const svg = document.createElementNS(SVG_NS, 'svg');

    if (flavor === 'gemini') {
      const gradId = `clian-gemini-grad-${geminiGradientCounter++}`;
      svg.setAttribute('viewBox', GEMINI_ICON_SVG.viewBox);
      svg.setAttribute('width', String(sizePx));
      svg.setAttribute('height', String(sizePx));

      const defs = document.createElementNS(SVG_NS, 'defs');
      const linear = document.createElementNS(SVG_NS, 'linearGradient');
      linear.setAttribute('id', gradId);
      linear.setAttribute('x1', GEMINI_ICON_SVG.gradient.x1);
      linear.setAttribute('y1', GEMINI_ICON_SVG.gradient.y1);
      linear.setAttribute('x2', GEMINI_ICON_SVG.gradient.x2);
      linear.setAttribute('y2', GEMINI_ICON_SVG.gradient.y2);
      linear.setAttribute('gradientUnits', 'userSpaceOnUse');

      for (const stop of GEMINI_ICON_SVG.gradient.stops) {
        const stopEl = document.createElementNS(SVG_NS, 'stop');
        if ('offset' in stop && stop.offset) {
          stopEl.setAttribute('offset', stop.offset);
        }
        stopEl.setAttribute('stop-color', stop.color);
        linear.appendChild(stopEl);
      }

      defs.appendChild(linear);
      svg.appendChild(defs);

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', GEMINI_ICON_SVG.path);
      path.setAttribute('fill', `url(#${gradId})`);
      svg.appendChild(path);
    } else if (flavor === 'codex') {
      svg.setAttribute('viewBox', OPENAI_LOGO_SVG.viewBox);
      svg.setAttribute('width', String(sizePx));
      svg.setAttribute('height', String(sizePx));
      svg.setAttribute('fill', 'none');

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', OPENAI_LOGO_SVG.path);
      path.setAttribute('fill', 'currentColor');
      svg.appendChild(path);
    } else {
      // Default: Clian/Claude mark
      svg.setAttribute('viewBox', LOGO_SVG.viewBox);
      svg.setAttribute('width', String(sizePx));
      svg.setAttribute('height', String(sizePx));
      svg.setAttribute('fill', 'none');

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', LOGO_SVG.path);
      path.setAttribute('fill', LOGO_SVG.fill);
      svg.appendChild(path);
    }

    targetEl.appendChild(svg);
  }

  // ============================================
  // History Dropdown
  // ============================================

  private toggleHistoryDropdown(): void {
    if (!this.historyDropdown) return;

    const isVisible = this.historyDropdown.hasClass('visible');
    if (isVisible) {
      this.historyDropdown.removeClass('visible');
    } else {
      this.updateHistoryDropdown();
      this.historyDropdown.addClass('visible');
    }
  }

  private updateHistoryDropdown(): void {
    if (!this.historyDropdown) return;
    this.historyDropdown.empty();

    const activeTab = this.tabManager?.getActiveTab();
    const conversationController = activeTab?.controllers.conversationController;

    if (conversationController) {
      conversationController.renderHistoryDropdown(this.historyDropdown, {
        onSelectConversation: async (conversationId) => {
          // Check if conversation is already open in this view's tabs
          const existingTab = this.findTabWithConversation(conversationId);
          if (existingTab) {
            // Switch to existing tab instead of opening in current tab
            await this.tabManager?.switchToTab(existingTab.id);
            this.historyDropdown?.removeClass('visible');
            return;
          }

          // Check if conversation is open in another view (split workspace scenario)
          const crossViewResult = this.plugin.findConversationAcrossViews(conversationId);
          if (crossViewResult && crossViewResult.view !== this) {
            // Focus the other view's leaf and switch to the tab
            this.plugin.app.workspace.revealLeaf(crossViewResult.view.leaf);
            await crossViewResult.view.getTabManager()?.switchToTab(crossViewResult.tabId);
            this.historyDropdown?.removeClass('visible');
            return;
          }

          // Open in current tab
          await this.tabManager?.openConversation(conversationId);
          this.historyDropdown?.removeClass('visible');
        },
      });
    }
  }

  private findTabWithConversation(conversationId: string): TabData | null {
    const tabs = this.tabManager?.getAllTabs() ?? [];
    return tabs.find(tab => tab.conversationId === conversationId) ?? null;
  }

  // ============================================
  // Event Wiring
  // ============================================

  private wireEventHandlers(): void {
    // Document-level click to close dropdowns
    this.registerDomEvent(document, 'click', () => {
      this.historyDropdown?.removeClass('visible');
    });

    // View-level Shift+Tab to toggle plan mode (works from any focused element)
    this.registerDomEvent(this.containerEl, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const activeTab = this.tabManager?.getActiveTab();
        if (!activeTab) return;
        const current = this.plugin.settings.permissionMode;
        if (current === 'plan') {
          const restoreMode = activeTab.state.prePlanPermissionMode ?? 'normal';
          activeTab.state.prePlanPermissionMode = null;
          updatePlanModeUI(activeTab, this.plugin, restoreMode);
        } else {
          activeTab.state.prePlanPermissionMode = current;
          updatePlanModeUI(activeTab, this.plugin, 'plan');
        }
      }
    });

    // View-scoped escape to cancel streaming (only when Clian has focus)
    this.registerDomEvent(this.containerEl, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        const activeTab = this.tabManager?.getActiveTab();
        if (activeTab?.state.isStreaming) {
          e.preventDefault();
          activeTab.controllers.inputController?.cancelStreaming();
        }
      }
    });

    // Vault events - forward to active tab's file context manager
    const markCacheDirty = (includesFolders: boolean): void => {
      const mgr = this.tabManager?.getActiveTab()?.ui.fileContextManager;
      if (!mgr) return;
      mgr.markFileCacheDirty();
      if (includesFolders) mgr.markFolderCacheDirty();
    };
    this.eventRefs.push(
      this.plugin.app.vault.on('create', () => markCacheDirty(true)),
      this.plugin.app.vault.on('delete', () => markCacheDirty(true)),
      this.plugin.app.vault.on('rename', () => markCacheDirty(true)),
      this.plugin.app.vault.on('modify', () => markCacheDirty(false))
    );

    // File open event
    this.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file) {
          this.tabManager?.getActiveTab()?.ui.fileContextManager?.handleFileOpen(file);
        }
      })
    );

    // Click outside to close mention dropdown
    this.registerDomEvent(document, 'click', (e) => {
      const activeTab = this.tabManager?.getActiveTab();
      if (activeTab) {
        const fcm = activeTab.ui.fileContextManager;
        if (fcm && !fcm.containsElement(e.target as Node) && e.target !== activeTab.dom.inputEl) {
          fcm.hideMentionDropdown();
        }
      }
    });
  }

  // ============================================
  // Persistence
  // ============================================

  private async restoreOrCreateTabs(): Promise<void> {
    if (!this.tabManager) return;

    // Try to restore from persisted state
    const persistedState = await this.plugin.storage.getTabManagerState();
    if (persistedState && persistedState.openTabs.length > 0) {
      await this.tabManager.restoreState(persistedState);
      await this.plugin.storage.clearLegacyActiveConversationId();
      return;
    }

    // No persisted state - migrate legacy activeConversationId if present
    const legacyActiveId = await this.plugin.storage.getLegacyActiveConversationId();
    if (legacyActiveId) {
      const conversation = await this.plugin.getConversationById(legacyActiveId);
      if (conversation) {
        await this.tabManager.createTab(conversation.id);
      } else {
        await this.tabManager.createTab();
      }
      await this.plugin.storage.clearLegacyActiveConversationId();
      return;
    }

    // Fallback: create a new empty tab
    await this.tabManager.createTab();
    await this.plugin.storage.clearLegacyActiveConversationId();
  }

  private persistTabState(): void {
    // Debounce persistence to avoid rapid writes (300ms delay)
    if (this.pendingPersist !== null) {
      clearTimeout(this.pendingPersist);
    }
    this.pendingPersist = setTimeout(() => {
      this.pendingPersist = null;
      if (!this.tabManager) return;
      const state = this.tabManager.getPersistedState();
      this.plugin.storage.setTabManagerState(state).catch(() => {
        // Silently ignore persistence errors
      });
    }, 300);
  }

  /** Force immediate persistence (for onClose/onunload). */
  private async persistTabStateImmediate(): Promise<void> {
    // Cancel any pending debounced persist
    if (this.pendingPersist !== null) {
      clearTimeout(this.pendingPersist);
      this.pendingPersist = null;
    }
    if (!this.tabManager) return;
    const state = this.tabManager.getPersistedState();
    await this.plugin.storage.setTabManagerState(state);
  }

  // ============================================
  // Public API
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): TabData | null {
    return this.tabManager?.getActiveTab() ?? null;
  }

  /** Gets the tab manager. */
  getTabManager(): TabManager | null {
    return this.tabManager;
  }
}
