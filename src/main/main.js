'use strict';

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('node:path');

const settings = require('./settings');
const ai = require('./ai');

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i]?.content || '');
  }
  return '';
}
const memory = require('./memory');

let win = null;

function toggleDevTools() {
  if (!win) return;
  const wc = win.webContents;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' });
}

// Dev menus are handy for hacking on the UI live; the menubar stays hidden
// behind autoHideMenuBar (press Alt to see it), accelerators work regardless.
function setupMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { label: 'Developer tools', accelerator: 'F12', click: () => toggleDevTools() },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  win = new BrowserWindow({
    width: 430,
    height: 780,
    minWidth: 340,
    minHeight: 560,
    title: 'Kanna',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'assets', 'emotes', 'happy.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (event) => {
    console.log('[renderer]', event.message ?? '');
  });

  // Developer loop: plain Ctrl+R/F5 must always re-read renderer files from
  // disk — file:// stylesheets otherwise get served stale from the cache.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrlR = (input.control || input.meta) && !input.alt
      && input.key.toLowerCase() === 'r';
    if (ctrlR || input.key === 'F5') {
      event.preventDefault();
      win.webContents.reloadIgnoringCache();
    }
  });

  if (!app.isPackaged) win.webContents.session.clearCache();

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.on('closed', () => {
    ai.abortActive();
    win = null;
  });
}

app.whenReady().then(() => {
  ipcMain.handle('settings:get', () => settings.getSettings());

  ipcMain.handle('settings:save', (_e, patch) => settings.save(patch));

  ipcMain.handle('memory:get', () => memory.load());
  ipcMain.handle('memory:remove', (_e, key) => memory.removeEntry(String(key || '')));
  ipcMain.handle('memory:clear', () => memory.clearAll());

  ipcMain.handle('chat:send', (event, messages) => {
    const emit = (type, payload) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send(type, payload);
      } catch {
        // window gone mid-stream — nothing to do
      }
    };
    return ai.runChat(messages, emit).then((result) => {
      // Let the model decide, in the background, whether this turn taught
      // her something durable. Never blocks or fails the chat itself.
      if (!result.stopped) memory.scheduleRemember(lastUserText(messages), result.text);
      return result;
    });
  });

  ipcMain.on('chat:stop', () => ai.abortActive());

  // Borderless window controls.
  ipcMain.on('win:min', () => win?.minimize());
  ipcMain.on('win:toggleMax', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('win:close', () => win?.close());

  setupMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => ai.abortActive());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
