export type SaveResult = {
  success?: boolean;
  filePath?: string;
  canceled?: boolean;
  warning?: string;
  error?: string;
};

export type CaptureResult = {
  data?: ArrayBuffer;
  error?: string;
};

export type SelectionDataResult = {
  imageDataUrl?: string;
  error?: string;
};

export type ElectronAPI = {
  getSources: () => Promise<Array<{ id: string; name: string; thumbnail: string }>>;
  setSource: (sourceId: string) => Promise<void>;
  setAudioMode: (captureSystemAudio: boolean) => Promise<void>;
  captureScreenshot: () => Promise<CaptureResult>;
  startScreenshotSelection: () => Promise<SaveResult>;
  getScreenshotSelectionData: () => Promise<SelectionDataResult>;
  completeScreenshotSelection: (filename: string, data: ArrayBuffer) => Promise<SaveResult>;
  cancelScreenshotSelection: () => Promise<SaveResult>;
  saveScreenshot: (filename: string, data: ArrayBuffer) => Promise<SaveResult>;
  initRecording: () => Promise<void>;
  sendChunk: (buf: ArrayBuffer) => Promise<void>;
  saveRecording: (filename: string, durationSeconds: number) => Promise<SaveResult>;
  cancelRecording: () => void;
  setRecordingStatus: (status: string) => void;
  onToggleRecording: (callback: () => void) => void;
  onTogglePause: (callback: () => void) => void;
  showFloatingToolbar: () => void;
  hideFloatingToolbar: () => void;
  syncToolbar: (timer: string, state: 'recording' | 'paused') => void;
  onConversionStart: (cb: (opts?: { mode?: string }) => void) => void;
  onConversionProgress: (cb: (data: { percent: number; currentSecs: number; totalSecs: number }) => void) => void;
};