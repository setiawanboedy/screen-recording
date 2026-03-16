import { app, BrowserWindow, ipcMain, desktopCapturer, dialog, Tray, Menu, globalShortcut, nativeImage, session, screen as electronScreen } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegStaticPath: string = require('ffmpeg-static');

function getFfmpegPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  }
  return ffmpegStaticPath;
}

let mainWindow: BrowserWindow | null = null;
let floatingToolbar: BrowserWindow | null = null;
let tray: Tray | null = null;
let selectedSourceId: string | null = null;
let recordingState: 'idle' | 'recording' | 'paused' = 'idle';

// Streaming recording state
let recordingStream: ReturnType<typeof fs.createWriteStream> | null = null;
let recordingTempPath: string | null = null;

const appRoot = () => app.getAppPath();

const getIconPath = () => {
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', iconFile)
    : path.join(appRoot(), 'assets', iconFile);
};

// ── Tray ──────────────────────────────────────────────────────────────────
const updateTrayMenu = () => {
  if (!tray) return;
  const isRec = recordingState !== 'idle';
  const isPaused = recordingState === 'paused';

  tray.setToolTip(
    isRec
      ? `Screen Recorder — ${isPaused ? '⏸ PAUSED' : '⏺ RECORDING'}`
      : 'Screen Recorder'
  );

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Window', click: () => mainWindow?.show() },
    { type: 'separator' },
    ...(isRec
      ? [
          {
            label: isPaused ? '▶ Resume' : '⏸ Pause',
            click: () => mainWindow?.webContents.send('toggle-pause'),
          },
          {
            label: '⏹ Stop Recording',
            click: () => mainWindow?.webContents.send('toggle-recording'),
          },
        ]
      : [
          {
            label: '⏺ Start Recording',
            click: () => { mainWindow?.show(); mainWindow?.webContents.send('toggle-recording'); },
          },
        ]),
    { type: 'separator' },
    { label: 'Quit', click: () => { tray?.destroy(); tray = null; app.quit(); } },
  ]));
};

// ── Floating Toolbar ──────────────────────────────────────────────────────
const showFloatingToolbar = () => {
  if (floatingToolbar && !floatingToolbar.isDestroyed()) {
    floatingToolbar.show();
    return;
  }

  const { width: sw, height: sh } = electronScreen.getPrimaryDisplay().workAreaSize;
  const W = 360, H = 56;

  floatingToolbar = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round((sw - W) / 2),
    y: sh - H - 24,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(appRoot(), 'dist', 'preload', 'toolbar.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  floatingToolbar.setAlwaysOnTop(true, 'floating');
  floatingToolbar.loadFile(path.join(appRoot(), 'dist', 'renderer', 'toolbar.html'));

  floatingToolbar.on('closed', () => { floatingToolbar = null; });
};

const hideFloatingToolbar = () => {
  if (floatingToolbar && !floatingToolbar.isDestroyed()) {
    floatingToolbar.hide();
  }
};

const createWindow = () => {
  const icon = nativeImage.createFromPath(getIconPath());

  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    backgroundColor: '#1a1a2e',
    icon,
    webPreferences: {
      preload: path.join(appRoot(), 'dist', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(true);
  });

  session.defaultSession.setPermissionCheckHandler(() => true);

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const selected = selectedSourceId
      ? sources.find(s => s.id === selectedSourceId)
      : sources[0];

    if (selected) {
      console.log('[main] Display media: using source', selected.name);
      callback({ video: selected, audio: 'loopback' });
    } else {
      console.log('[main] Display media: no source found');
      callback({});
    }
  });

  mainWindow.loadFile(path.join(appRoot(), 'dist', 'renderer', 'index.html'));

  mainWindow.on('close', (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
};

const createTray = () => {
  const icon = nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on('click', () => mainWindow?.show());
  updateTrayMenu(); // build initial menu
};

const registerShortcuts = () => {
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    mainWindow?.webContents.send('toggle-recording');
  });
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    mainWindow?.webContents.send('toggle-pause');
  });
};

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// IPC: Get sources — serialize to plain objects
ipcMain.handle('get-sources', async () => {
  try {
    const inputSources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 150, height: 150 },
    });
    return inputSources.map(source => ({
      id: source.id,
      name: source.name,
      display_id: source.display_id,
      thumbnail: source.thumbnail.toDataURL(),
    }));
  } catch (err) {
    console.error('[main] get-sources error:', err);
    return [];
  }
});

// IPC: Set selected source for getDisplayMedia
ipcMain.handle('set-source', (_event, sourceId: string) => {
  selectedSourceId = sourceId;
  console.log('[main] Selected source:', sourceId);
});

// IPC: Open a write stream for streaming chunks during recording
ipcMain.handle('recording-init', () => {
  if (recordingStream) {
    recordingStream.destroy();
    if (recordingTempPath && fs.existsSync(recordingTempPath)) fs.unlinkSync(recordingTempPath);
  }
  recordingTempPath = path.join(os.tmpdir(), `rec-${Date.now()}.webm`);
  recordingStream = fs.createWriteStream(recordingTempPath);
  console.log('[main] Recording stream opened:', recordingTempPath);
});

// IPC: Stream each chunk directly to temp file (fire-and-forget, ordered by IPC)
ipcMain.on('recording-chunk', (_event, data: Buffer) => {
  if (recordingStream && !recordingStream.destroyed) {
    recordingStream.write(Buffer.from(data));
  }
});

// IPC: Close stream, show save dialog, convert if needed
ipcMain.handle('recording-save', async (event, { filename, durationSeconds = 0 }) => {
  // Close write stream first
  await new Promise<void>((resolve) => {
    if (!recordingStream || recordingStream.destroyed) return resolve();
    recordingStream.end(() => resolve());
  });
  recordingStream = null;

  const tempPath = recordingTempPath;
  recordingTempPath = null;

  if (!tempPath || !fs.existsSync(tempPath)) {
    return { error: 'No recording data found' };
  }

  const videosDir = path.join(app.getPath('videos'), 'Screen Recorder');
  if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

  const isMP4 = (filename as string).endsWith('.mp4');
  const { filePath } = await dialog.showSaveDialog({
    buttonLabel: 'Save video',
    defaultPath: path.join(videosDir, filename as string),
    filters: isMP4
      ? [{ name: 'MP4 Video', extensions: ['mp4'] }, { name: 'WebM Video', extensions: ['webm'] }]
      : [{ name: 'WebM Video', extensions: ['webm'] }, { name: 'MP4 Video', extensions: ['mp4'] }],
  });

  if (!filePath) {
    fs.unlinkSync(tempPath);
    return { canceled: true };
  }

  if (filePath.endsWith('.webm')) {
    fs.copyFileSync(tempPath, filePath);
    fs.unlinkSync(tempPath);
    return { success: true, filePath };
  }

  // MP4 conversion with live progress
  event.sender.send('conversion-start');
  try {
    const ffmpegBin = getFfmpegPath();
    const totalSecs = durationSeconds as number;

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegBin, [
        '-i', tempPath,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        '-nostats',
        '-y', filePath,
      ]);

      let buf = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('out_time=')) continue;
          const timeStr = line.substring('out_time='.length).trim();
          if (timeStr === 'N/A') continue;
          const parts = timeStr.split(':');
          const outSecs = parseFloat(parts[0] ?? '0') * 3600
            + parseFloat(parts[1] ?? '0') * 60
            + parseFloat(parts[2] ?? '0');
          const percent = totalSecs > 0
            ? Math.min(99, Math.round((outSecs / totalSecs) * 100))
            : -1;
          event.sender.send('conversion-progress', { percent, currentSecs: Math.round(outSecs), totalSecs });
        }
      });

      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
      proc.on('error', reject);
    });

    console.log('[main] Converted to MP4:', filePath);
    return { success: true, filePath };
  } catch (err) {
    console.error('[main] ffmpeg conversion failed:', err);
    const fallbackPath = filePath.replace(/\.mp4$/, '.webm');
    fs.copyFileSync(tempPath, fallbackPath);
    return { success: true, filePath: fallbackPath, warning: 'MP4 conversion failed, saved as WebM' };
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
});

// IPC: Cancel recording — discard temp file
ipcMain.on('recording-cancel', () => {
  recordingStream?.destroy();
  recordingStream = null;
  if (recordingTempPath && fs.existsSync(recordingTempPath)) {
    fs.unlinkSync(recordingTempPath);
  }
  recordingTempPath = null;
  console.log('[main] Recording cancelled, temp file discarded');
});

// IPC: Update tray tooltip + menu based on recording state
ipcMain.on('recording-status', (_event, status: 'idle' | 'recording' | 'paused') => {
  recordingState = status;
  updateTrayMenu();
});

// IPC: Floating toolbar visibility
ipcMain.on('show-floating-toolbar', () => showFloatingToolbar());
ipcMain.on('hide-floating-toolbar', () => hideFloatingToolbar());

// IPC: Sync timer + state from renderer → toolbar
ipcMain.on('toolbar-sync', (_event, data: { timer: string; state: 'recording' | 'paused' }) => {
  floatingToolbar?.webContents.send('toolbar-update', data);
});

// IPC: Toolbar buttons → relay to main window
ipcMain.on('toolbar-action', (_event, action: 'pause' | 'stop') => {
  if (action === 'pause') {
    mainWindow?.webContents.send('toggle-pause');
  } else if (action === 'stop') {
    mainWindow?.webContents.send('toggle-recording');
  }
});
