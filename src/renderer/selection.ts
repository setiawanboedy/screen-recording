import type { ElectronAPI } from './electron-api';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

type SelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const stage = document.getElementById('stage') as HTMLDivElement;
const selectionImage = document.getElementById('selectionImage') as HTMLImageElement;
const selectionBox = document.getElementById('selectionBox') as HTMLDivElement;
const selectionStats = document.getElementById('selectionStats') as HTMLDivElement;
const hudSub = document.getElementById('hudSub') as HTMLDivElement;
const cancelBtn = document.getElementById('cancelBtn') as HTMLButtonElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;

let dragStart: { x: number; y: number } | null = null;
let selectionRect: SelectionRect | null = null;
let isSaving = false;
let selectionArmed = false;

function getStagePoint(event: PointerEvent): { x: number; y: number } {
  const rect = stage.getBoundingClientRect();
  return {
    x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
    y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
  };
}

function updateSelectionBox() {
  if (!selectionRect) {
    selectionBox.style.display = 'none';
    selectionStats.textContent = 'No area selected';
    saveBtn.disabled = true;
    return;
  }

  selectionBox.style.display = 'block';
  selectionBox.style.left = `${selectionRect.x}px`;
  selectionBox.style.top = `${selectionRect.y}px`;
  selectionBox.style.width = `${selectionRect.width}px`;
  selectionBox.style.height = `${selectionRect.height}px`;
  selectionStats.textContent = `${Math.round(selectionRect.width)} × ${Math.round(selectionRect.height)} px`;
  saveBtn.disabled = selectionRect.width < 8 || selectionRect.height < 8 || isSaving;
}

async function waitForImageLoad(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Failed to load screenshot selection background'));
    };
    const cleanup = () => {
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
    };

    image.addEventListener('load', onLoad, { once: true });
    image.addEventListener('error', onError, { once: true });
  });
}

async function cropSelectionToPng(): Promise<ArrayBuffer> {
  if (!selectionRect) {
    throw new Error('No selection area found');
  }

  const rect = selectionImage.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || selectionImage.naturalWidth <= 0 || selectionImage.naturalHeight <= 0) {
    throw new Error('Selection image is not ready');
  }

  const scaleX = selectionImage.naturalWidth / rect.width;
  const scaleY = selectionImage.naturalHeight / rect.height;
  const sx = Math.round(selectionRect.x * scaleX);
  const sy = Math.round(selectionRect.y * scaleY);
  const sw = Math.max(1, Math.round(selectionRect.width * scaleX));
  const sh = Math.max(1, Math.round(selectionRect.height * scaleY));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas context is not available');
  }

  ctx.drawImage(selectionImage, sx, sy, sw, sh, 0, 0, sw, sh);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (!value) {
        reject(new Error('Failed to encode selected screenshot'));
        return;
      }
      resolve(value);
    }, 'image/png');
  });

  return blob.arrayBuffer();
}

async function initialize() {
  const result = await window.electronAPI.getScreenshotSelectionData();
  if (result.error || !result.imageDataUrl) {
    throw new Error(result.error ?? 'No screenshot selection data found');
  }

  selectionImage.src = result.imageDataUrl;
  await waitForImageLoad(selectionImage);
  hudSub.textContent = 'Release mouse button, lalu drag untuk mulai select.';

  window.setTimeout(() => {
    selectionArmed = true;
    if (!isSaving && !dragStart) {
      hudSub.textContent = 'Drag anywhere on screen. Press Esc to cancel.';
    }
  }, 180);
}

async function cancelSelection() {
  if (isSaving) return;
  await window.electronAPI.cancelScreenshotSelection();
}

async function saveSelection() {
  if (!selectionRect || isSaving) {
    return;
  }

  isSaving = true;
  saveBtn.disabled = true;
  cancelBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  hudSub.textContent = 'Saving screenshot to Pictures/Screen Recorder...';

  try {
    const data = await cropSelectionToPng();
    const result = await window.electronAPI.completeScreenshotSelection(
      `screenshot-selection-${Date.now()}.png`,
      data
    );

    if (result.error) {
      throw new Error(result.error);
    }
  } catch (err) {
    isSaving = false;
    saveBtn.textContent = 'Save Selection';
    cancelBtn.disabled = false;
    hudSub.textContent = 'Drag anywhere on screen. Press Esc to cancel.';
    updateSelectionBox();
    alert(`Save selection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

stage.addEventListener('pointerdown', (event) => {
  if (isSaving || !selectionArmed) return;

  const point = getStagePoint(event);
  dragStart = point;
  selectionRect = { x: point.x, y: point.y, width: 0, height: 0 };
  stage.setPointerCapture(event.pointerId);
  hudSub.textContent = 'Release pointer to finish selecting.';
  updateSelectionBox();
});

stage.addEventListener('pointermove', (event) => {
  if (!dragStart) return;

  const point = getStagePoint(event);
  const x = Math.min(dragStart.x, point.x);
  const y = Math.min(dragStart.y, point.y);
  const width = Math.abs(point.x - dragStart.x);
  const height = Math.abs(point.y - dragStart.y);
  selectionRect = { x, y, width, height };
  updateSelectionBox();
});

stage.addEventListener('pointerup', (event) => {
  if (stage.hasPointerCapture(event.pointerId)) {
    stage.releasePointerCapture(event.pointerId);
  }

  dragStart = null;
  if (selectionRect && (selectionRect.width < 8 || selectionRect.height < 8)) {
    selectionRect = null;
  }

  hudSub.textContent = 'Drag again to adjust, or save the current selection.';
  updateSelectionBox();
});

stage.addEventListener('pointercancel', () => {
  dragStart = null;
  hudSub.textContent = 'Drag anywhere on screen. Press Esc to cancel.';
  updateSelectionBox();
});

cancelBtn.onclick = cancelSelection;
saveBtn.onclick = saveSelection;

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    void cancelSelection();
  }

  if (event.key === 'Enter' && selectionRect && !isSaving) {
    void saveSelection();
  }
});

void initialize().catch(async (err) => {
  alert(`Screenshot selection failed: ${err instanceof Error ? err.message : String(err)}`);
  await window.electronAPI.cancelScreenshotSelection();
});