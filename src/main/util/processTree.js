'use strict';

// Helpers for shutting down the frozen (PyInstaller --onefile) Python helper
// servers. Kanna spawned them as children; killing only the direct PID
// orphans the bootloader's child, and killing it first wins the race against
// taskkill's own tree walk — so order and fallbacks matter.

const { spawn } = require('node:child_process');

// Tree kill on Windows; plain hard kill elsewhere (python has no bootloader).
function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* fall through to plain kill */ }
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

// Second-chance hard kill if something survived the graceful+tree sequence.
function killReplicaIfStillAlive(pid) {
  if (!pid) return;
  setTimeout(() => {
    try {
      process.kill(pid, 0);      // throws ESRCH when gone
      process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }, 2500);
}

module.exports = { killProcessTree, killReplicaIfStillAlive };
