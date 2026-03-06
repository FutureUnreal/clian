export function updateContextRowHasContent(contextRowEl: HTMLElement): void {
  const editorIndicator = contextRowEl.querySelector('.clian-selection-indicator') as HTMLElement | null;
  const canvasIndicator = contextRowEl.querySelector('.clian-canvas-indicator') as HTMLElement | null;
  const fileIndicator = contextRowEl.querySelector('.clian-file-indicator') as HTMLElement | null;
  const imagePreview = contextRowEl.querySelector('.clian-image-preview') as HTMLElement | null;

  const hasEditorSelection = editorIndicator?.style.display === 'block';
  const hasCanvasSelection = canvasIndicator?.style.display === 'block';
  const hasFileChips = fileIndicator?.style.display === 'flex';
  const hasImageChips = imagePreview?.style.display === 'flex';

  contextRowEl.classList.toggle(
    'has-content',
    hasEditorSelection || hasCanvasSelection || hasFileChips || hasImageChips
  );
}
