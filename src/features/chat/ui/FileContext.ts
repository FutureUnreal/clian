import * as fs from 'fs';
import { fileURLToPath } from 'url';
import type { App, EventRef } from 'obsidian';
import { Notice, TFile } from 'obsidian';

import type { AgentManager } from '../../../core/agents';
import type { McpServerManager } from '../../../core/mcp';
import { MentionDropdownController } from '../../../shared/mention/MentionDropdownController';
import { getVaultPath, normalizePathForVault as normalizePathForVaultUtil } from '../../../utils/path';
import { FileContextState } from './file-context/state/FileContextState';
import { MarkdownFileCache } from './file-context/state/MarkdownFileCache';
import { VaultFolderCache } from './file-context/state/VaultFolderCache';
import { FileChipsView } from './file-context/view/FileChipsView';

export interface FileContextCallbacks {
  getExcludedTags: () => string[];
  onChipsChanged?: () => void;
  getExternalContexts?: () => string[];
  /** Called when an agent is selected from the @ mention dropdown. */
  onAgentMentionSelect?: (agentId: string) => void;
}

export class FileContextManager {
  private app: App;
  private callbacks: FileContextCallbacks;
  private chipsContainerEl: HTMLElement;
  private dropdownContainerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private state: FileContextState;
  private fileCache: MarkdownFileCache;
  private folderCache: VaultFolderCache;
  private chipsView: FileChipsView;
  private mentionDropdown: MentionDropdownController;
  private deleteEventRef: EventRef | null = null;
  private renameEventRef: EventRef | null = null;

  // Current note (shown as chip)
  private currentNotePath: string | null = null;
  private droppedFilePaths: Set<string> = new Set();

  // MCP server support
  private onMcpMentionChange: ((servers: Set<string>) => void) | null = null;

  constructor(
    app: App,
    chipsContainerEl: HTMLElement,
    inputEl: HTMLTextAreaElement,
    callbacks: FileContextCallbacks,
    dropdownContainerEl?: HTMLElement
  ) {
    this.app = app;
    this.chipsContainerEl = chipsContainerEl;
    this.dropdownContainerEl = dropdownContainerEl ?? chipsContainerEl;
    this.inputEl = inputEl;
    this.callbacks = callbacks;

    this.state = new FileContextState();
    this.fileCache = new MarkdownFileCache(this.app);
    this.fileCache.initializeInBackground();
    this.folderCache = new VaultFolderCache(this.app);
    this.folderCache.initializeInBackground();

    this.chipsView = new FileChipsView(this.chipsContainerEl, {
      onRemoveAttachment: (filePath) => {
        if (filePath === this.currentNotePath) {
          this.currentNotePath = null;
          this.state.detachFile(filePath);
        } else {
          this.droppedFilePaths.delete(filePath);
        }
        this.refreshFileChips();
      },
      onOpenFile: async (filePath) => {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
          new Notice(`Could not open file: ${filePath}`);
          return;
        }
        try {
          await this.app.workspace.getLeaf().openFile(file);
        } catch (error) {
          new Notice(`Failed to open file: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });

    this.mentionDropdown = new MentionDropdownController(
      this.dropdownContainerEl,
      this.inputEl,
      {
        onAttachFile: (filePath) => this.state.attachFile(filePath),
        onAttachContextFile: (displayName, absolutePath) =>
          this.state.attachContextFile(displayName, absolutePath),
        onMcpMentionChange: (servers) => this.onMcpMentionChange?.(servers),
        onAgentMentionSelect: (agentId) => this.callbacks.onAgentMentionSelect?.(agentId),
        getMentionedMcpServers: () => this.state.getMentionedMcpServers(),
        setMentionedMcpServers: (mentions) => this.state.setMentionedMcpServers(mentions),
        addMentionedMcpServer: (name) => this.state.addMentionedMcpServer(name),
        getExternalContexts: () => this.callbacks.getExternalContexts?.() || [],
        getCachedVaultFolders: () =>
          this.folderCache.getFolders().map(folder => ({ name: folder.name, path: folder.path })),
        getCachedMarkdownFiles: () => this.fileCache.getFiles(),
        normalizePathForVault: (rawPath) => this.normalizePathForVault(rawPath),
      }
    );

    this.deleteEventRef = this.app.vault.on('delete', (file) => {
      if (file instanceof TFile) this.handleFileDeleted(file.path);
    });

    this.renameEventRef = this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile) this.handleFileRenamed(oldPath, file.path);
    });
  }

  /** Returns the current note path (shown as chip). */
  getCurrentNotePath(): string | null {
    return this.currentNotePath;
  }

  getAttachedFiles(): Set<string> {
    return this.state.getAttachedFiles();
  }

  /** Checks whether current note should be sent for this session. */
  shouldSendCurrentNote(notePath?: string | null): boolean {
    const resolvedPath = notePath ?? this.currentNotePath;
    return !!resolvedPath && !this.state.hasSentCurrentNote();
  }

  /** Marks current note as sent (call after sending a message). */
  markCurrentNoteSent() {
    this.state.markCurrentNoteSent();
  }

  isSessionStarted(): boolean {
    return this.state.isSessionStarted();
  }

  startSession() {
    this.state.startSession();
  }

  /** Resets state for a new conversation. */
  resetForNewConversation() {
    this.currentNotePath = null;
    this.droppedFilePaths.clear();
    this.state.resetForNewConversation();
    this.refreshFileChips();
  }

  /** Resets state for loading an existing conversation. */
  resetForLoadedConversation(hasMessages: boolean) {
    this.currentNotePath = null;
    this.droppedFilePaths.clear();
    this.state.resetForLoadedConversation(hasMessages);
    this.refreshFileChips();
  }

  /** Sets current note (for restoring persisted state). */
  setCurrentNote(notePath: string | null) {
    this.currentNotePath = notePath;
    if (notePath) {
      this.state.attachFile(notePath);
    }
    this.refreshFileChips();
  }

  /** Auto-attaches the currently focused file (for new sessions). */
  autoAttachActiveFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && !this.hasExcludedTag(activeFile)) {
      const normalizedPath = this.normalizePathForVault(activeFile.path);
      if (normalizedPath) {
        this.currentNotePath = normalizedPath;
        this.state.attachFile(normalizedPath);
        this.refreshFileChips();
      }
    }
  }

  /** Handles file open event. */
  handleFileOpen(file: TFile) {
    const normalizedPath = this.normalizePathForVault(file.path);
    if (!normalizedPath) return;

    if (!this.state.isSessionStarted()) {
      this.state.clearAttachments();
      if (!this.hasExcludedTag(file)) {
        this.currentNotePath = normalizedPath;
        this.state.attachFile(normalizedPath);
      } else {
        this.currentNotePath = null;
      }
      this.refreshFileChips();
    }
  }

  markFileCacheDirty() {
    this.fileCache.markDirty();
  }

  markFolderCacheDirty() {
    this.folderCache.markDirty();
  }

  /** Handles input changes to detect @ mentions. */
  handleInputChange() {
    this.mentionDropdown.handleInputChange();
  }

  /** Handles keyboard navigation in mention dropdown. Returns true if handled. */
  handleMentionKeydown(e: KeyboardEvent): boolean {
    return this.mentionDropdown.handleKeydown(e);
  }

  isMentionDropdownVisible(): boolean {
    return this.mentionDropdown.isVisible();
  }

  hideMentionDropdown() {
    this.mentionDropdown.hide();
  }

  containsElement(el: Node): boolean {
    return this.mentionDropdown.containsElement(el);
  }

  transformContextMentions(text: string): string {
    return this.state.transformContextMentions(text);
  }

  handleDroppedFiles(files: File[], event?: DragEvent): void {
    const references: string[] = [];
    let skippedDirectories = false;
    let missingPaths = false;

    const candidatePaths = new Set<string>();

    for (const file of files) {
      const droppedPath = this.getDroppedFilePath(file);
      if (!droppedPath) {
        missingPaths = true;
        continue;
      }

      candidatePaths.add(droppedPath);
    }

    if (event?.dataTransfer) {
      for (const droppedPath of this.getDroppedPathsFromDataTransfer(event.dataTransfer)) {
        candidatePaths.add(droppedPath);
      }
    }

    for (const droppedPath of candidatePaths) {

      if (this.isDirectoryPath(droppedPath)) {
        skippedDirectories = true;
        continue;
      }

      const normalizedPath = this.normalizePathForVault(droppedPath) ?? droppedPath;
      const reference = `@${normalizedPath}`;
      if (!references.includes(reference)) {
        references.push(reference);
      }
      this.droppedFilePaths.add(normalizedPath);
    }

    if (references.length > 0) {
      this.insertTextAtCursor(references.join(' '));
      this.refreshFileChips();
      new Notice(`Attached ${references.length} file${references.length === 1 ? '' : 's'}.`, 2500);
    }

    if (skippedDirectories) {
      new Notice('Dropped folders are not supported here. Use the folder button for external contexts.', 5000);
    }

    if (missingPaths) {
      new Notice('Unable to access one or more dropped file paths.', 5000);
    }
  }

  clearDroppedFiles(): void {
    if (this.droppedFilePaths.size === 0) return;
    this.droppedFilePaths.clear();
    this.refreshFileChips();
  }

  /** Cleans up event listeners (call on view close). */
  destroy() {
    if (this.deleteEventRef) this.app.vault.offref(this.deleteEventRef);
    if (this.renameEventRef) this.app.vault.offref(this.renameEventRef);
    this.mentionDropdown.destroy();
    this.chipsView.destroy();
  }

  /** Normalizes a file path to be vault-relative with forward slashes. */
  normalizePathForVault(rawPath: string | undefined | null): string | null {
    const vaultPath = getVaultPath(this.app);
    return normalizePathForVaultUtil(rawPath, vaultPath);
  }

  private refreshFileChips(): void {
    this.chipsView.renderFiles(this.currentNotePath, Array.from(this.droppedFilePaths));
    this.callbacks.onChipsChanged?.();
  }

  private getDroppedFilePath(file: File): string | null {
    try {
      // Electron 32+ removed File.path; use webUtils.getPathForFile(file) instead.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { webUtils } = require('electron') as { webUtils?: { getPathForFile?: (file: File) => string } };
      const resolvedPath = webUtils?.getPathForFile?.(file);
      if (typeof resolvedPath === 'string' && resolvedPath.trim().length > 0) {
        return resolvedPath;
      }
    } catch {
      // Fallback below for older Electron builds that still expose File.path.
    }

    const fileWithPath = file as File & { path?: string };
    if (typeof fileWithPath.path === 'string' && fileWithPath.path.trim().length > 0) {
      return fileWithPath.path;
    }
    return null;
  }

  private getDroppedPathsFromDataTransfer(dataTransfer: DataTransfer): string[] {
    const candidates = new Set<string>();
    const textTypes = ['text/uri-list', 'text/plain'];

    for (const type of textTypes) {
      let text = '';
      try {
        text = dataTransfer.getData(type);
      } catch {
        text = '';
      }

      for (const candidate of this.extractPathsFromDroppedText(text)) {
        candidates.add(candidate);
      }
    }

    return Array.from(candidates);
  }

  private extractPathsFromDroppedText(text: string): string[] {
    if (!text) return [];

    const candidates = new Set<string>();
    const lines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));

    for (const line of lines) {
      const candidate = this.resolveDroppedTextPath(line);
      if (candidate) {
        candidates.add(candidate);
      }
    }

    return Array.from(candidates);
  }

  private resolveDroppedTextPath(text: string): string | null {
    return this.resolveObsidianUri(text)
      ?? this.resolveFileUri(text)
      ?? this.resolveWikilinkPath(text)
      ?? this.resolveVaultFilePath(text);
  }

  private resolveObsidianUri(text: string): string | null {
    try {
      const url = new URL(text);
      if (url.protocol !== 'obsidian:') return null;

      const fileParam = url.searchParams.get('file');
      if (fileParam) {
        return this.resolveVaultFilePath(fileParam);
      }

      const pathParam = url.searchParams.get('path');
      if (pathParam && pathParam.trim().length > 0) {
        return pathParam;
      }
    } catch {
      return null;
    }

    return null;
  }

  private resolveFileUri(text: string): string | null {
    if (!text.startsWith('file://')) return null;

    try {
      return fileURLToPath(text);
    } catch {
      return null;
    }
  }

  private resolveWikilinkPath(text: string): string | null {
    const match = text.match(/^!?\[\[([^\]|#^]+)(?:#[^\]|]+)?(?:\^[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
    if (!match) return null;
    return this.resolveVaultFilePath(match[1]);
  }

  private resolveVaultFilePath(rawPath: string | null | undefined): string | null {
    const candidate = rawPath?.trim();
    if (!candidate) return null;

    const resolved = this.app.metadataCache.getFirstLinkpathDest(candidate, '')
      || this.app.vault.getFileByPath(candidate)
      || (!candidate.endsWith('.md') ? this.app.vault.getFileByPath(candidate + '.md') : null);

    if (resolved instanceof TFile) {
      return resolved.path;
    }

    return null;
  }

  private isDirectoryPath(filePath: string): boolean {
    try {
      return fs.statSync(filePath).isDirectory();
    } catch {
      return false;
    }
  }

  private insertTextAtCursor(text: string): void {
    const currentValue = this.inputEl.value ?? '';
    const selectionStart = this.inputEl.selectionStart ?? currentValue.length;
    const selectionEnd = this.inputEl.selectionEnd ?? selectionStart;
    const before = currentValue.slice(0, selectionStart);
    const after = currentValue.slice(selectionEnd);
    const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const suffix = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
    const insertion = `${prefix}${text}${suffix}`;

    this.inputEl.value = before + insertion + after;
    const nextCursor = before.length + insertion.length;
    this.inputEl.selectionStart = nextCursor;
    this.inputEl.selectionEnd = nextCursor;
    this.inputEl.focus();
  }

  private handleFileRenamed(oldPath: string, newPath: string) {
    const normalizedOld = this.normalizePathForVault(oldPath);
    const normalizedNew = this.normalizePathForVault(newPath);
    if (!normalizedOld) return;

    let needsUpdate = false;

    // Update current note path if renamed
    if (this.currentNotePath === normalizedOld) {
      this.currentNotePath = normalizedNew;
      needsUpdate = true;
    }

    if (this.droppedFilePaths.has(normalizedOld)) {
      this.droppedFilePaths.delete(normalizedOld);
      if (normalizedNew) {
        this.droppedFilePaths.add(normalizedNew);
      }
      needsUpdate = true;
    }

    // Update attached files
    if (this.state.getAttachedFiles().has(normalizedOld)) {
      this.state.detachFile(normalizedOld);
      if (normalizedNew) {
        this.state.attachFile(normalizedNew);
      }
      needsUpdate = true;
    }

    if (needsUpdate) {
      this.refreshFileChips();
    }
  }

  private handleFileDeleted(deletedPath: string): void {
    const normalized = this.normalizePathForVault(deletedPath);
    if (!normalized) return;

    let needsUpdate = false;

    // Clear current note if deleted
    if (this.currentNotePath === normalized) {
      this.currentNotePath = null;
      needsUpdate = true;
    }

    if (this.droppedFilePaths.has(normalized)) {
      this.droppedFilePaths.delete(normalized);
      needsUpdate = true;
    }

    // Remove from attached files
    if (this.state.getAttachedFiles().has(normalized)) {
      this.state.detachFile(normalized);
      needsUpdate = true;
    }

    if (needsUpdate) {
      this.refreshFileChips();
    }
  }

  // ========================================
  // MCP Server Support
  // ========================================

  setMcpManager(manager: McpServerManager | null): void {
    this.mentionDropdown.setMcpManager(manager);
  }

  setAgentService(agentManager: AgentManager | null): void {
    // AgentManager structurally satisfies AgentMentionProvider
    this.mentionDropdown.setAgentService(agentManager);
  }

  setOnMcpMentionChange(callback: (servers: Set<string>) => void): void {
    this.onMcpMentionChange = callback;
  }

  /**
   * Pre-scans external context paths in the background to warm the cache.
   * Should be called when external context paths are added/changed.
   */
  preScanExternalContexts(): void {
    this.mentionDropdown.preScanExternalContexts();
  }

  getMentionedMcpServers(): Set<string> {
    return this.state.getMentionedMcpServers();
  }

  clearMcpMentions(): void {
    this.state.clearMcpMentions();
  }

  updateMcpMentionsFromText(text: string): void {
    this.mentionDropdown.updateMcpMentionsFromText(text);
  }

  private hasExcludedTag(file: TFile): boolean {
    const excludedTags = this.callbacks.getExcludedTags();
    if (excludedTags.length === 0) return false;

    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return false;

    const fileTags: string[] = [];

    if (cache.frontmatter?.tags) {
      const fmTags = cache.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        fileTags.push(...fmTags.map((t: string) => t.replace(/^#/, '')));
      } else if (typeof fmTags === 'string') {
        fileTags.push(fmTags.replace(/^#/, ''));
      }
    }

    if (cache.tags) {
      fileTags.push(...cache.tags.map(t => t.tag.replace(/^#/, '')));
    }

    return fileTags.some(tag => excludedTags.includes(tag));
  }
}
