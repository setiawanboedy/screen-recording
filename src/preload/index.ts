import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  setSource: (sourceId: string) => ipcRenderer.invoke('set-source', sourceId),
  saveRecording: (buffer: ArrayBuffer, filename: string, durationSeconds: number) =>
    ipcRenderer.invoke('save-recording', { buffer, filename, durationSeconds }),
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
  onConversionProgress: (cb: (data: { percent: number; currentSecs: number; totalSecs: number }) => void) =>
    ipcRenderer.on('conversion-progress', (_event, data) => cb(data)),
});
