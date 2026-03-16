import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  setSource: (sourceId: string) => ipcRenderer.invoke('set-source', sourceId),
  saveRecording: (buffer: ArrayBuffer, filename: string) =>
    ipcRenderer.invoke('save-recording', { buffer, filename }),
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
});
