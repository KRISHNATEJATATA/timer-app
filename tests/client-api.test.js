'use strict';

/* Regression guard for the vendored Neutralino client: every native method
   app.js calls must actually exist. Catches the class of bug where the app
   calls an API the client version doesn't ship (e.g. filesystem.rename,
   window.drag) — those fail only at runtime, in production. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const clientSrc = fs.readFileSync(
  path.join(__dirname, '..', 'resources', 'js', 'neutralino.js'),
  'utf8'
);
const Neutralino = new Function(clientSrc + '\nreturn Neutralino;')();

const usedApis = [
  'init',
  'events.on',
  'app.getProcessId',
  'app.exit',
  'filesystem.access',
  'filesystem.createDirectory',
  'filesystem.readFile',
  'filesystem.writeFile',
  'filesystem.move',
  'filesystem.remove',
  'os.getPath',
  'os.execCommand',
  'os.showMessageBox',
  'os.showFolderDialog',
  'os.showSaveDialog',
  'window.beginDrag',
  'window.move',
  'window.getSize',
  'computer.getDisplays'
];

for (const api of usedApis) {
  const value = api.split('.').reduce((obj, key) => (obj ? obj[key] : undefined), Neutralino);
  assert.strictEqual(typeof value, 'function', api + ' missing from vendored Neutralino client 6.9.0');
}

// The client must NOT grow phantom APIs the app could accidentally rely on
// being absent (guards against re-introducing rename/drag style mistakes).
assert.strictEqual(Neutralino.filesystem.rename, undefined, 'filesystem.rename does not exist — use move()');
assert.strictEqual(Neutralino.window.drag, undefined, 'window.drag does not exist — use beginDrag()');

console.log('client API surface tests passed');
