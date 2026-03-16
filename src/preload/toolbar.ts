import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('toolbarAPI', {
  onUpdate: (cb: (data: { timer: string; state: 'recording' | 'paused' }) => void) =>
    ipcRenderer.on('toolbar-update', (_event, data) => cb(data)),
  pause: () => ipcRenderer.send('toolbar-action', 'pause'),
  stop: () => ipcRenderer.send('toolbar-action', 'stop'),
});
