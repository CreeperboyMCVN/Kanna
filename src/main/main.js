'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, globalShortcut } = require('electron');
const path = require('node:path');

const settings = require('./settings');
const ai = require('./ai');
const tts = require('./tts');

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i]?.content || '');
  }
  return '';
}
const memory = require('./memory');

let win = null;
let tray = null;
let isQuitting = false;

function toggleDevTools() {
  if (!win) return;
  const wc = win.webContents;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' });
}

function kannaIconPath() {
  return path.join(__dirname, '..', '..', 'assets', 'icon.ico');
}

// Bring her up however she was last left (hidden to tray, minimized…).
function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Tray: a presence in the corner, the summon target, and the only Quit that
// means it — closing the window hides her here instead of exiting.
function setupTray() {
  try {
    tray = new Tray(kannaIconPath());
  } catch (err) {
    console.log('[tray]', 'could not load the tray icon:', err?.message || err);
    return;
  }
  tray.setToolTip('Kanna');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Kanna', click: showWindow },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// Global summon hotkey: Ctrl+Shift+K (Cmd+Shift+K on macOS builds).
function setupSummonHotkey() {
  const ok = globalShortcut.register('CommandOrControl+Shift+K', showWindow);
  if (!ok) console.log('[hotkey]', 'Ctrl+Shift+K is taken by another app — no summon shortcut');
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

// Restores a saved position only if the window would still sit fully on a
// connected screen — unplugged monitors must not strand her offscreen.
// { x: null } means "let the OS center it".
function sanePosition(saved) {
  const W = 340;
  const H = 400;
  const x = Number(saved?.x);
  const y = Number(saved?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: null, y: null };
  const { screen } = require('electron');
  for (const d of screen.getAllDisplays()) {
    const a = d.workArea;
    if (x >= a.x && x + W <= a.x + a.width && y >= a.y && y + H <= a.y + a.height) {
      return { x, y };
    }
  }
  return { x: null, y: null };
}

async function createWindow() {
  const pos = sanePosition((await settings.getSettings()).window);

  win = new BrowserWindow({
    width: 340,
    height: 400,
    resizable: false,
    title: 'Kanna',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    icon: kannaIconPath(),
    // Saved position wins when sane; otherwise the OS decides.
    ...(Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: pos.x, y: pos.y } : {}),
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

  // Persist where she ends up — debounced so a drag writes once, and a
  // final flush on close so a quick "drag then hide" keeps too.
  let moveTimer = null;
  const savePosition = () => {
    clearTimeout(moveTimer);
    moveTimer = null;
    if (!win || win.isDestroyed() || isQuitting) return;
    const [x, y] = win.getPosition();
    settings.save({ window: { x, y } })
      .catch((err) => console.log('[window]', 'position save failed:', err?.message || err));
  };
  win.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(savePosition, 500);
  });

  // The ✕ button hides her to the tray instead of exiting — she keeps
  // living there until the tray menu's Quit (or the summon hotkey).
  win.on('close', (event) => {
    if (!isQuitting) {
      savePosition();
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    ai.abortActive();
    win = null;
  });
}

app.whenReady().then(async () => {
  ipcMain.handle('settings:get', () => settings.getSettings());

  ipcMain.handle('settings:save', (_e, patch) => settings.save(patch));
  ipcMain.handle('models:list', (_e, provider) => ai.listModels(provider));

  ipcMain.handle('tts:speak', async (_e, payload) => tts.speak(payload));
  ipcMain.on('tts:cancel', () => { /* cloud audio cancelled in renderer by destroying <audio> */ });

  ipcMain.handle('memory:get', () => ({ entries: memory.load() }));
  ipcMain.handle('memory:remove', (_e, key) => ({ entries: memory.removeEntry(String(key || '')) }));
  ipcMain.handle('memory:clear', () => ({ entries: memory.clearAll() }));

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
  ipcMain.on('win:close', () => win?.close());

  setupMenu();
  await createWindow();
  setupTray();
  setupSummonHotkey();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  ai.abortActive();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
