import { app, BrowserWindow, ipcMain, desktopCapturer, dialog, Tray, Menu, globalShortcut, nativeImage, session } from 'electron';
import path from 'path';
import fs from 'fs';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let selectedSourceId: string | null = null;

const appRoot = () => app.getAppPath();

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(appRoot(), 'dist', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Grant all media permissions
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(true);
  });

  session.defaultSession.setPermissionCheckHandler(() => true);

  // Handle getDisplayMedia — use selected source or first screen
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
  // mainWindow.webContents.openDevTools();

  mainWindow.on('close', (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
};

const createTray = () => {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Screen Recorder');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow?.show() },
    { label: 'Toggle Recording', click: () => mainWindow?.webContents.send('toggle-recording') },
    { type: 'separator' },
    { label: 'Quit', click: () => { tray?.destroy(); tray = null; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => mainWindow?.show());
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

// IPC: Save recorded video
ipcMain.handle('save-recording', async (_event, { buffer, filename }) => {
  const videosDir = path.join(app.getPath('videos'), 'Screen Recorder');
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }

  const { filePath } = await dialog.showSaveDialog({
    buttonLabel: 'Save video',
    defaultPath: path.join(videosDir, filename || `recording-${Date.now()}.webm`),
  });

  if (filePath) {
    fs.writeFileSync(filePath, Buffer.from(buffer));
    return { success: true, filePath };
  }
  return { canceled: true };
});

// IPC: Update tray tooltip
ipcMain.on('recording-status', (_event, status: string) => {
  if (tray) {
    tray.setToolTip(`Screen Recorder - ${status}`);
  }
});
