'use strict';
/* Build the CUDA-GPU installer.
 *
 * Both installers ship identical app code; the only difference is which frozen
 * Piper server exe sits in resources/piper/kanna-piper-server.exe when
 * electron-builder runs. This script:
 *   1. backs up the normal (CPU) exe,
 *   2. copies the CUDA build (.opencode/cuda/kanna-piper-server-cuda.exe,
 *      produced by `npm run piper:build:cuda`) into the slot,
 *   3. runs electron-builder with a -cuda artifact name,
 *   4. restores the normal exe no matter what (try/finally).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const slot = path.join(root, 'resources', 'piper', 'kanna-piper-server.exe');
const backup = path.join(root, '.opencode', 'piper-server-normal.exe.bak');
const cudaExe = path.join(root, '.opencode', 'cuda', 'kanna-piper-server-cuda.exe');

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!fs.existsSync(slot)) die(`missing ${path.relative(root, slot)} — run "npm run piper:build" first`);
if (!fs.existsSync(cudaExe)) die(`missing ${path.relative(root, cudaExe)} — run "npm run piper:build:cuda" first`);

fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.copyFileSync(slot, backup);
fs.copyFileSync(cudaExe, slot);
console.log('piper exe swapped to CUDA build — building installer...');

let status = 1;
try {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const r = spawnSync(npx, [
    'electron-builder',
    '-c.artifactName=Kanna-Setup-${version}-cuda.${ext}',
  ], { stdio: 'inherit', cwd: root });
  status = r.status ?? 1;
} finally {
  fs.copyFileSync(backup, slot);
  fs.rmSync(backup, { force: true });
  console.log('normal (CPU) piper exe restored');
}

process.exit(status);
