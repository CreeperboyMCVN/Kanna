'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, globalShortcut } = require('electron');
const path = require('node:path');

const settings = require('./settings');
const ai = require('./ai');
const tts = require('./tts');
const stt = require('./stt');
const log = require('./log');
const affect = require('./affect');
const welcome = require('./welcome');

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

  // --- shake detector -------------------------------------------------------
  // Grabbing and rattling the window (rapid back-and-forth drags) is its own
  // kind of user attention: 1–3 direction reversals in one burst leave her
  // dizzy, more than 3 makes her properly angry. A burst ends after a short
  // stillness; cooldown keeps repeated rattling from spamming reactions.
  const SHAKE_AMP = 14;      // px swing per sample that counts as a fling
  const SHAKE_QUIET = 600;   // ms of stillness that ends a shake burst
  const SHAKE_MIN = 1;       // below this: Dragging the window around is not Abuse
  const SHAKE_COOLDOWN = 6000; // ms after a reaction before the next one fires
  const shake = { x: null, y: null, dirX: 0, dirY: 0, count: 0, lastAt: 0, quietTimer: null, cooldownUntil: 0 };

  const shakeLines = {
    dizzy: [
      'wh-whoa…! The room is spinning… s-stop it…',
      'kyaa—! My head… everything\'s all wobbly now…',
      'waaah— I can\'t see straight…! Why would you DO that?!',
      'so dizzy… the desk just… left… and came back… twice…',
    ],
    angry: [
      'HEY! Enough shaking! That actually hurts, you know!',
      'Grr— I said stop shaking the window! You\'re rattling my brains loose!',
      'That\'s it! One more shake and I\'m hiding in the tray for an hour.',
      'Quit. Rattling. Me. Around. I get dizzy VERY easily, in case you hadn\'t noticed.',
    ],
  };
  let lastLineIdx = { dizzy: -1, angry: -1 };

  function shakeSample(x, y) {
    const now = Date.now();
    if (shake.x !== null) {
      if (now - shake.lastAt > SHAKE_QUIET) {
        // Fresh burst: re-anchor direction, forget the old count.
        shake.count = 0;
        shake.dirX = 0;
        shake.dirY = 0;
      } else {
        const dx = x - shake.x;
        const dy = y - shake.y;
        if (Math.abs(dx) >= SHAKE_AMP) {
          const s = Math.sign(dx);
          if (shake.dirX !== 0 && s !== shake.dirX) shake.count++;
          shake.dirX = s;
        }
        if (Math.abs(dy) >= SHAKE_AMP) {
          const s = Math.sign(dy);
          if (shake.dirY !== 0 && s !== shake.dirY) shake.count++;
          shake.dirY = s;
        }
      }
    }
    shake.x = x;
    shake.y = y;
    shake.lastAt = now;
    clearTimeout(shake.quietTimer);
    shake.quietTimer = setTimeout(shakeBurstEnd, SHAKE_QUIET);
  }

  // Burst is over: 1–3 shakes → dizzy + a line, >3 → angry. Ghosts the line
  // through the renderer's canned-speech path (no model), cooldown-gated.
  function shakeBurstEnd() {
    const count = shake.count;
    shake.count = 0;
    shake.x = null;
    shake.y = null;
    shake.dirX = 0;
    shake.dirY = 0;
    if (count < SHAKE_MIN || Date.now() < shake.cooldownUntil) return;
    const mood = count > 3 ? 'angry' : 'dizzy';
    const pool = shakeLines[mood];
    let idx = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && idx === lastLineIdx[mood]) idx = (idx + 1) % pool.length;
    lastLineIdx[mood] = idx;
    const g = { text: pool[idx], mood, speed: mood === 'angry' ? 1.25 : 1.05, shakes: count };
    shake.cooldownUntil = Date.now() + SHAKE_COOLDOWN;
    log.info('[shake]', `${count} shakes → ${mood}`);
    affect.observe({ mood, speed: g.speed, hold: false }, 'shake');
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.webContents.send('kanna:shake', g);
    }
  }

  win.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(savePosition, 500);
    const [x, y] = win.getPosition();
    shakeSample(x, y);
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
  // Startup snapshot — the single most useful block when reading logs from a
  // user's machine: which build, which paths, which providers are configured.
  log.info('app starting', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    electron: process.versions?.electron,
    resourcesPath: process.resourcesPath,
    appPath: (() => { try { return app.getAppPath(); } catch { return ''; } })(),
    userData: (() => { try { return app.getPath('userData'); } catch { return ''; } })(),
    log: log.logFilePath(),
  });
  ipcMain.handle('settings:get', () => settings.getSettings());

  ipcMain.handle('settings:save', async (_e, patch) => {
    const before = await settings.getSettings();
    const saved = await settings.save(patch);
    const wasPiper = before?.tts?.provider === 'piper';
    const isPiper = saved?.tts?.provider === 'piper';
    if (wasPiper || isPiper) {
      // Piper options (command/model/GPU/data dir) only bind when the server
      // starts. Spawning here races PyInstaller's onefile bootloader: the
      // serving child appears a few seconds after the parent, so killing
      // "now" then spawning can orphan the not-yet-born child. Instead only
      // stop the old instance — the next spoken message restarts it with
      // the fresh flags the renderer sends along.
      tts.stopPiperServer();
    }
    return saved;
  });
  ipcMain.handle('models:list', (_e, provider) => ai.listModels(provider));

  ipcMain.handle('tts:speak', async (_e, payload) => {
    try {
      return await tts.speak(payload);
    } catch (err) {
      log.error('[tts:speak] failed:', err);
      throw err;
    }
  });
  ipcMain.on('tts:cancel', () => { /* cloud audio cancelled in renderer by destroying <audio> */ });

  ipcMain.handle('stt:start', async () => {
    const s = await settings.getSettings();
    return stt.sttStart({ command: s?.stt?.command, model: s?.stt?.model, lang: s?.stt?.lang });
  });
  ipcMain.handle('stt:audio', async (_e, pcm) => stt.sttAudio(pcm));
  ipcMain.handle('stt:finish', async () => stt.sttFinish());
  ipcMain.on('stt:cancel', () => { stt.sttCancel().catch(() => {}); });

  ipcMain.handle('memory:get', () => ({ entries: memory.load() }));
  ipcMain.handle('memory:remove', (_e, key) => ({ entries: memory.removeEntry(String(key || '')) }));
  ipcMain.handle('memory:clear', () => ({ entries: memory.clearAll() }));

  // Welcome-back: the renderer pings main when the user becomes active
  // again after ≥5 min away. Main picks a tier-matched canned line (no
  // model call) and lets the affect engine feel it too, so the next
  // model turn inherits the reunion mood.
  ipcMain.handle('kanna:back', (_e, awayMs) => {
    const g = welcome.greet(awayMs);
    affect.observe({ mood: g.mood, speed: g.speed, hold: false }, 'back');
    return g;
  });

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
    }).catch((err) => {
      log.error('[chat:send] failed:', err);
      throw err;
    });
  });

  ipcMain.on('chat:stop', () => ai.abortActive());

  // Borderless window controls.
  ipcMain.on('win:min', () => win?.minimize());
  ipcMain.on('win:close', () => win?.close());

  setupMenu();
  await createWindow();
  try {
    const initial = await settings.getSettings();
    if (initial?.tts?.provider === 'piper') {
      tts.startPiperServer({
        piperCommand: initial.tts.piperCommand,
        piperModel: initial.tts.piperModel,
        piperDataDir: initial.tts.piperDataDir,
        piperUseGpu: !!initial.tts.piperUseGpu,
      }).catch((err) => { log.warn('[tts piper]', 'server failed to start:', err?.message || err); });
    }
  } catch (err) {
    log.warn('[tts piper]', 'could not read settings:', err?.message || err);
  }
  setupTray();
  setupSummonHotkey();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  ai.abortActive();
  try { tts.stopPiperServer(); } catch { /* ignore */ }
  try { stt.stopSttServer(); } catch { /* ignore */ }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  log.info('app quitting (isQuitting=' + isQuitting + ')');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Main-process diagnostics to the log file: the packaged app has no console,
// so without this a crash is entirely silent for a user reporting an issue.
process.on('uncaughtException', (err) => log.error('uncaughtException:', err));
process.on('unhandledRejection', (reason) => log.error('unhandledRejection:', reason));
