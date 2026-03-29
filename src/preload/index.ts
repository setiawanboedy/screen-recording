import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  setSource: (sourceId: string) => ipcRenderer.invoke('set-source', sourceId),
  setAudioMode: (captureSystemAudio: boolean) => ipcRenderer.invoke('set-audio-mode', captureSystemAudio),
  // Streaming recording
  initRecording: () => ipcRenderer.invoke('recording-init'),
  sendChunk: (buf: ArrayBuffer) => ipcRenderer.invoke('recording-chunk', buf),
  saveRecording: (filename: string, durationSeconds: number) =>
    ipcRenderer.invoke('recording-save', { filename, durationSeconds }),
  cancelRecording: () => ipcRenderer.send('recording-cancel'),
  // Status & UI sync
  setRecordingStatus: (status: string) =>
    ipcRenderer.send('recording-status', status),
  onToggleRecording: (callback: () => void) =>
    ipcRenderer.on('toggle-recording', callback),
  onTogglePause: (callback: () => void) =>
    ipcRenderer.on('toggle-pause', callback),
  // Floating toolbar
  showFloatingToolbar: () => ipcRenderer.send('show-floating-toolbar'),
  hideFloatingToolbar: () => ipcRenderer.send('hide-floating-toolbar'),
  syncToolbar: (timer: string, state: 'recording' | 'paused') =>
    ipcRenderer.send('toolbar-sync', { timer, state }),
  // Conversion progress
  onConversionStart: (cb: (opts?: { mode?: string }) => void) =>
    ipcRenderer.on('conversion-start', (_event, data) => cb(data)),
  onConversionProgress: (cb: (data: { percent: number; currentSecs: number; totalSecs: number }) => void) =>
    ipcRenderer.on('conversion-progress', (_event, data) => cb(data)),
});
