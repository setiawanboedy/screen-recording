import { app, BrowserWindow, ipcMain, desktopCapturer, dialog, Tray, Menu, globalShortcut, nativeImage, session, screen as electronScreen } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

// IPC: Save recorded video — convert WebM → MP4 via ffmpeg
ipcMain.handle('save-recording', async (_event, { buffer, filename }) => {
  const videosDir = path.join(app.getPath('videos'), 'Screen Recorder');
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }

  const mp4Filename = (filename as string).replace(/\.webm$/, '.mp4');
  const { filePath } = await dialog.showSaveDialog({
    buttonLabel: 'Save video',
    defaultPath: path.join(videosDir, mp4Filename),
    filters: [
      { name: 'MP4 Video', extensions: ['mp4'] },
      { name: 'WebM Video', extensions: ['webm'] },
    ],
  });

  if (!filePath) return { canceled: true };

  // Write input as temp .webm
  const tempWebm = path.join(os.tmpdir(), `rec-tmp-${Date.now()}.webm`);
  fs.writeFileSync(tempWebm, Buffer.from(buffer as ArrayBuffer));

  const isWebmOutput = filePath.endsWith('.webm');

  if (isWebmOutput) {
    // No conversion needed
    fs.renameSync(tempWebm, filePath);
    return { success: true, filePath };
  }

  // Convert to MP4 with ffmpeg
  try {
    const ffmpeg = getFfmpegPath();
    await execFileAsync(ffmpeg, [
      '-i', tempWebm,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '22',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', filePath,
    ]);
    console.log('[main] Converted to MP4:', filePath);
    return { success: true, filePath };
  } catch (err) {
    // Fallback: save as .webm if conversion fails
    console.error('[main] ffmpeg conversion failed, saving as webm:', err);
    const fallbackPath = filePath.replace(/\.mp4$/, '.webm');
    fs.copyFileSync(tempWebm, fallbackPath);
    return { success: true, filePath: fallbackPath, warning: 'MP4 conversion failed, saved as WebM' };
  } finally {
    if (fs.existsSync(tempWebm)) fs.unlinkSync(tempWebm);
  }
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
