'use strict';

var els = {
  topicInput: document.getElementById('topicInput'),
  clock: document.getElementById('clock'),
  status: document.getElementById('status'),
  notice: document.getElementById('notice'),
  btnStart: document.getElementById('btnStart'),
  btnPause: document.getElementById('btnPause'),
  btnResume: document.getElementById('btnResume'),
  btnStop: document.getElementById('btnStop'),
  btnExport: document.getElementById('btnExport'),
  btnAdd: document.getElementById('btnAdd'),
  addForm: document.getElementById('addForm'),
  addTopic: document.getElementById('addTopic'),
  addStart: document.getElementById('addStart'),
  addEnd: document.getElementById('addEnd'),
  addError: document.getElementById('addError'),
  btnAddSave: document.getElementById('btnAddSave'),
  btnAddCancel: document.getElementById('btnAddCancel'),
  btnSettings: document.getElementById('btnSettings'),
  settingsPanel: document.getElementById('settingsPanel'),
  settingsPath: document.getElementById('settingsPath'),
  settingsVersion: document.getElementById('settingsVersion'),
  settingsError: document.getElementById('settingsError'),
  btnSettingsBrowse: document.getElementById('btnSettingsBrowse'),
  btnSettingsDone: document.getElementById('btnSettingsDone'),
  btnExit: document.getElementById('btnExit')
};

var DATA_DIR_NAME = 'TopicTimer';
var SETTINGS_FILE = 'settings.json';
var dataDir = null;
var dataFile = null;
var settingsFile = null;
var ticker = null;
var flashTimer = null;
var state = { open: null, sessions: [], pausedTopic: null, pausedElapsed: 0, capNoticed: false, lastPersistAt: 0 };
var lastSynced = [];

var PERSIST_INTERVAL_MS = 60000;
var SLEEP_GAP_MS = 120000;
var lockPath = null;
var writesBlocked = false;

function exeBaseName() {
  try {
    var args = (typeof window !== 'undefined' && window.NL_ARGS) || [];
    var parts = String(args[0] || '').split(/[\\/]/);
    return (parts[parts.length - 1] || '').replace(/^"+|"+$/g, '');
  } catch (error) {
    return '';
  }
}

/* Write to <path>.tmp then rename into place, so a crash mid-write can
   never leave a truncated log.json behind. */
async function atomicWrite(path, text) {
  var tmp = path + '.tmp';
  await Neutralino.filesystem.writeFile(tmp, text);
  try {
    await Neutralino.filesystem.move(tmp, path);
  } catch (error) {
    await Neutralino.filesystem.remove(path);
    await Neutralino.filesystem.move(tmp, path);
  }
}

async function acquireLock(dir) {
  var path = dir + '/app.lock';
  var pid = null;
  try {
    pid = await Neutralino.app.getProcessId();
    pid = Number(pid && pid.returnValue !== undefined ? pid.returnValue : pid) || null;
  } catch (error) {
    pid = null;
  }
  var existing = null;
  try {
    existing = await Neutralino.filesystem.readFile(path);
  } catch (error) {}
  if (existing !== null && existing !== undefined) {
    var existingPid = parseInt(String(existing).trim(), 10);
    var alive = null;
    if (isNaN(existingPid)) {
      alive = false; // lock without a usable PID — treat as stale
    } else {
      try {
        var res = await Neutralino.os.execCommand('tasklist /FI "PID eq ' + existingPid + '" /NH');
        var out = String((res && (res.output || res)) || '');
        var base = exeBaseName();
        if (out.trim() === '') {
          alive = null; // empty output: cannot verify
        } else if (out.indexOf(String(existingPid)) === -1) {
          alive = false; // no task with that PID exists (locale-proof: the INFO line never contains it)
        } else if (base !== '' && out.indexOf(base) !== -1) {
          alive = true; // the PID belongs to our exe: another instance is live
        } else if (base !== '') {
          alive = false; // PID reused by a different program: the lock holder is gone
        } else {
          alive = null; // cannot verify the image name
        }
      } catch (error) {
        alive = null; // tasklist unavailable: fail closed
      }
    }
    if (alive === null) return { acquired: false, path: path, unverified: true };
    if (alive) return { acquired: false, path: path };
  }
  try {
    await Neutralino.filesystem.writeFile(path, String(pid === null ? '' : pid));
  } catch (error) {}
  return { acquired: true, path: path };
}

async function releasePath(path) {
  if (!path) return;
  try {
    await Neutralino.filesystem.remove(path);
  } catch (error) {}
}

async function releaseLock() {
  return releasePath(lockPath);
}

async function createDirectoryDeep(path) {
  var normalized = path.replace(/[\\/]+$/, '');
  var parts = normalized.split(/[\\/]/);
  var current = parts[0];
  for (var i = 1; i < parts.length; i++) {
    current += '/' + parts[i];
    try {
      await Neutralino.filesystem.createDirectory(current);
    } catch (error) {}
  }
}

/* Settings live next to the fallback default (AppData) so they survive
   the log folder being moved. Custom dir wins; default is resolved lazily. */
async function readSettings(defaultDir) {
  try {
    var raw = await Neutralino.filesystem.readFile(settingsFile);
    var data = JSON.parse(raw);
    if (data && typeof data.dataDir === 'string' && data.dataDir.trim() !== '') {
      return data.dataDir.replace(/[\\/]+$/, '');
    }
  } catch (error) {}
  return defaultDir;
}

async function writeSettings(dataDirPath) {
  await atomicWrite(
    settingsFile,
    JSON.stringify({ dataDir: dataDirPath }, null, 2)
  );
}

async function defaultDataDir() {
  try {
    var appData = await Neutralino.os.getPath('data');
    if (typeof appData === 'string' && appData.trim() !== '') {
      return appData.replace(/[\\/]+$/, '') + '/' + DATA_DIR_NAME;
    }
  } catch (error) {}
  try {
    var documents = await Neutralino.os.getPath('documents');
    if (typeof documents === 'string' && documents.trim() !== '') {
      return documents.replace(/[\\/]+$/, '') + '/' + DATA_DIR_NAME;
    }
  } catch (error) {}
  return DATA_DIR_NAME;
}

async function readSessionsFrom(file) {
  try {
    var raw = await Neutralino.filesystem.readFile(file);
    var data = JSON.parse(raw);
    if (data && Array.isArray(data.sessions)) return data.sessions;
  } catch (error) {}
  return null;
}

/* Point the app at a new folder. Order matters: validate the folder, take
   its lock, merge + write the log there, snapshot the old folder, and only
   then persist the choice. If anything fails, nothing points at the new
   folder and the old history stays untouched. */
async function changeDataDir(newDir) {
  var target = String(newDir).replace(/[\\/]+$/, '');
  if (target === dataDir) return target;
  await createDirectoryDeep(target);
  await Neutralino.filesystem.access(target);
  var targetSessions = await readSessionsFrom(target + '/log.json');
  if (targetSessions === null) {
    var targetFile = target + '/log.json';
    var corruptThere = false;
    try {
      await Neutralino.filesystem.access(targetFile);
      corruptThere = true;
    } catch (error) {}
    if (corruptThere) {
      await Neutralino.filesystem.move(targetFile, target + '/log.corrupt-' + Date.now() + '.bak');
    }
  }
  var lock = await acquireLock(target);
  if (!lock.acquired) {
    throw new Error(lock.unverified
      ? 'Another Topic Timer may be using that folder (could not verify).'
      : 'Another Topic Timer instance is using that folder.');
  }
  var oldDir = dataDir;
  var oldFile = dataFile;
  var oldLock = lockPath;
  if (targetSessions !== null) {
    var merged = TopicCore.mergeSessions(targetSessions, state.sessions);
    state.sessions = merged;
    lastSynced = deepCopy(merged);
  }
  dataDir = target;
  dataFile = target + '/log.json';
  try {
    await writeLog();
    if (oldFile && oldFile !== dataFile) {
      await atomicWrite(oldFile, JSON.stringify({ open: null, sessions: state.sessions }, null, 2));
    }
    await writeSettings(target);
  } catch (error) {
    dataDir = oldDir;
    dataFile = oldFile;
    await releasePath(lock.path);
    throw error;
  }
  await releasePath(oldLock);
  lockPath = lock.path;
  return target;
}

async function ensureDataDir(dir) {
  await createDirectoryDeep(dir);
  try {
    await Neutralino.filesystem.access(dir);
  } catch (error) {
    await Neutralino.filesystem.createDirectory(dir);
  }
}

async function positionBottomRight() {
  try {
    if (!Neutralino.computer || !Neutralino.window || !Neutralino.window.move) return;
    var displays = await Neutralino.computer.getDisplays();
    var list = Array.isArray(displays) ? displays : displays.returnValue || [];
    var display = list && list[0];
    if (!display) return;
    var resolution = display.resolution || display.size;
    if (!resolution || typeof resolution.width !== 'number') return;
    var size = await Neutralino.window.getSize();
    var win = size && size.returnValue ? size.returnValue : size;
    if (!win || typeof win.width !== 'number') return;
    var origin = display.position || { x: 0, y: 0 };
    var margin = 12;
    var taskbar = 60;
    var x = Math.round(origin.x + resolution.width - win.width - margin);
    var y = Math.round(origin.y + resolution.height - win.height - taskbar);
    await Neutralino.window.move(x, y);
  } catch (error) {}
}

function displaySeconds() {
  if (state.open) {
    return TopicCore.computeElapsed(state.open.baseElapsed, state.open.baseAt, Date.now(), false);
  }
  if (state.pausedTopic !== null) return state.pausedElapsed;
  return 0;
}

function renderClock() {
  els.clock.textContent = TopicCore.fmtHMS(displaySeconds());
}

function flash(message) {
  clearTimeout(flashTimer);
  els.status.textContent = message;
  flashTimer = setTimeout(render, 2500);
}

function render() {
  var open = state.open;
  var paused = !open && state.pausedTopic !== null;
  clearTimeout(flashTimer);
  els.topicInput.disabled = !!open || paused;
  if (open) els.topicInput.value = open.topic;
  else if (paused) els.topicInput.value = state.pausedTopic;
  renderClock();
  els.btnStart.hidden = !!open || paused;
  els.btnStart.disabled = !open && TopicCore.normalizeTopic(els.topicInput.value) === '';
  els.btnPause.hidden = !open;
  els.btnResume.hidden = !paused;
  els.btnStop.hidden = !open && !paused;
  els.notice.hidden = !(paused && state.capNoticed);
  if (open) {
    els.status.textContent = 'Running';
  } else if (paused) {
    els.status.textContent = state.capNoticed
      ? '12h cap reached \u2014 session logged'
      : 'Paused \u2014 session logged';
  } else {
    els.status.textContent = 'Idle \u2014 type a topic and press Start';
  }
}

function startTicker() {
  stopTicker();
  ticker = setInterval(tick, 1000);
}

function stopTicker() {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

function startSession() {
  if (state.open) return;
  var topic = TopicCore.normalizeTopic(els.topicInput.value);
  if (!topic) return;
  var now = Date.now();
  state.open = {
    topic: topic,
    startedAt: now,
    baseElapsed: 0,
    baseAt: now,
    chainBase: 0,
    lastTickAt: now,
    lastTickDisplay: 0
  };
  state.pausedTopic = null;
  state.pausedElapsed = 0;
  state.capNoticed = false;
  state.lastPersistAt = now;
  render();
  startTicker();
  writeLog().catch(function () {
    flash('Warning: could not write the log file');
  });
}

function finalizeSession() {
  var end = Date.now();
  var display = TopicCore.computeElapsed(state.open.baseElapsed, state.open.baseAt, end, false);
  var entry = {
    topic: state.open.topic,
    start: TopicCore.localIso(new Date(state.open.startedAt)),
    end: TopicCore.localIso(new Date(end)),
    elapsedSeconds: Math.round(display - state.open.chainBase)
  };
  state.sessions.push(entry);
  state.open = null;
  stopTicker();
  return { entry: entry, display: display };
}

function pauseSession() {
  if (!state.open) return;
  var result = finalizeSession();
  state.pausedTopic = result.entry.topic;
  state.pausedElapsed = result.display;
  render();
  writeLog().catch(function () {
    flash('Warning: could not write the log file');
  });
}

function resumeSession() {
  if (state.open || state.pausedTopic === null) return;
  var now = Date.now();
  state.open = {
    topic: state.pausedTopic,
    startedAt: now,
    baseElapsed: state.pausedElapsed,
    baseAt: now,
    chainBase: state.pausedElapsed,
    lastTickAt: now,
    lastTickDisplay: state.pausedElapsed
  };
  render();
  startTicker();
}

function stopSession() {
  if (state.open) {
    finalizeSession();
    state.pausedTopic = null;
    state.pausedElapsed = 0;
    state.capNoticed = false;
    render();
    writeLog().catch(function () {
      flash('Warning: could not write the log file');
    });
    return;
  }
  if (state.pausedTopic !== null) {
    state.pausedTopic = null;
    state.pausedElapsed = 0;
    state.capNoticed = false;
    render();
  }
}

function tick() {
  if (!state.open) return;
  var now = Date.now();
  var lastTickAt = state.open.lastTickAt || state.open.startedAt;
  var lastTickDisplay = state.open.lastTickDisplay || 0;
  if (now - lastTickAt > SLEEP_GAP_MS) {
    var entry = {
      topic: state.open.topic,
      start: TopicCore.localIso(new Date(state.open.startedAt)),
      end: TopicCore.localIso(new Date(lastTickAt)),
      elapsedSeconds: Math.max(0, Math.round(lastTickDisplay - state.open.chainBase))
    };
    state.sessions.push(entry);
    state.open = null;
    stopTicker();
    state.pausedTopic = entry.topic;
    state.pausedElapsed = lastTickDisplay;
    state.capNoticed = lastTickDisplay >= TopicCore.CAP_SECONDS;
    render();
    writeLog().catch(function () {
      flash('Warning: could not write the log file');
    });
    return;
  }
  var seconds = displaySeconds();
  if (TopicCore.shouldAutoPause(seconds, false, TopicCore.CAP_SECONDS)) {
    var result = finalizeSession();
    state.pausedTopic = result.entry.topic;
    state.pausedElapsed = result.display;
    state.capNoticed = true;
    render();
    writeLog().catch(function () {
      flash('Warning: could not write the log file');
    });
    return;
  }
  state.open.lastTickAt = now;
  state.open.lastTickDisplay = seconds;
  renderClock();
  if (now - state.lastPersistAt >= PERSIST_INTERVAL_MS) {
    state.lastPersistAt = now;
    writeLog().catch(function () {
      flash('Warning: could not write the log file');
    });
  }
}

async function writeLog() {
  var fileSessions = null;
  try {
    var raw = await Neutralino.filesystem.readFile(dataFile);
    var data = JSON.parse(raw);
    if (data && Array.isArray(data.sessions)) fileSessions = data.sessions;
  } catch (error) {
    fileSessions = null;
  }
  if (fileSessions !== null && reconcileSessions(fileSessions)) {
    flash('Manual edits to the log file were kept');
  }
  var open = null;
  if (state.open) {
    open = {
      topic: state.open.topic,
      startedAt: TopicCore.localIso(new Date(state.open.startedAt)),
      elapsedSeconds: Math.max(0, Math.round(displaySeconds() - state.open.chainBase)),
      savedAt: TopicCore.localIso(new Date())
    };
  }
  var payload = { open: open, sessions: state.sessions };
  if (writesBlocked) {
    throw new Error('The existing log file is unreadable and could not be backed up; writes are blocked to protect it.');
  }
  await atomicWrite(dataFile, JSON.stringify(payload, null, 2));
  lastSynced = deepCopy(state.sessions);
}

function deepCopy(list) {
  return list.map(function (entry) { return JSON.parse(JSON.stringify(entry)); });
}

function countByKey(list) {
  var map = {};
  for (var i = 0; i < list.length; i++) {
    var key = JSON.stringify(list[i]);
    map[key] = (map[key] || 0) + 1;
  }
  return map;
}

function reconcileSessions(fileSessions) {
  var fileEntries = [];
  for (var i = 0; i < fileSessions.length; i++) {
    if (fileSessions[i] && typeof fileSessions[i] === 'object') fileEntries.push(fileSessions[i]);
  }
  var fileChanged = JSON.stringify(fileEntries) !== JSON.stringify(lastSynced);
  var syncedCounts = countByKey(lastSynced);
  var seen = {};
  var pending = [];
  for (var j = 0; j < state.sessions.length; j++) {
    var key = JSON.stringify(state.sessions[j]);
    seen[key] = (seen[key] || 0) + 1;
    if (seen[key] > (syncedCounts[key] || 0)) pending.push(state.sessions[j]);
  }
  state.sessions = fileEntries.concat(pending);
  return fileChanged;
}

function padDate(d) {
  function pad(n) { return String(n).padStart(2, '0'); }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function openAddForm() {
  var now = new Date();
  var hourAgo = new Date(now.getTime() - 3600000);
  els.addTopic.value = '';
  els.addStart.value = padDate(hourAgo) + 'T' + String(hourAgo.getHours()).padStart(2, '0') + ':' + String(hourAgo.getMinutes()).padStart(2, '0');
  els.addEnd.value = padDate(now) + 'T' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  els.addError.hidden = true;
  els.addForm.hidden = false;
  if (typeof els.addTopic.focus === 'function') els.addTopic.focus();
}

function closeAddForm() {
  els.addForm.hidden = true;
  els.addError.hidden = true;
}

function openSettings() {
  els.settingsPath.value = dataDir;
  els.settingsError.hidden = true;
  els.settingsVersion.textContent = (typeof window !== 'undefined' && window.NL_APPVERSION)
    ? 'v' + window.NL_APPVERSION
    : '';
  els.settingsPanel.hidden = false;
  els.addForm.hidden = true;
}

function closeSettings() {
  els.settingsPanel.hidden = true;
  els.settingsError.hidden = true;
}

async function browseForDataDir() {
  var chosen = await Neutralino.os.showFolderDialog('Choose the folder for log.json', { defaultPath: dataDir });
  var path = typeof chosen === 'string' ? chosen : (chosen && chosen.path);
  if (!path) return;
  els.settingsPath.value = path;
}

async function applySettings() {
  var target = String(els.settingsPath.value).trim();
  if (target === '') {
    els.settingsError.textContent = 'Pick a folder for the log file.';
    els.settingsError.hidden = false;
    return;
  }
  var normalized = target.replace(/[\\/]+$/, '');
  if (normalized === dataDir) {
    closeSettings();
    return;
  }
  try {
    await changeDataDir(normalized);
  } catch (error) {
    els.settingsError.textContent = 'Cannot use that folder \u2014 check the path and permissions.';
    els.settingsError.hidden = false;
    return;
  }
  closeSettings();
  flash('Log file saved to ' + dataDir);
}

function saveAddForm() {
  var error = TopicCore.manualSessionError(els.addTopic.value, els.addStart.value, els.addEnd.value, TopicCore.CAP_SECONDS);
  if (error) {
    els.addError.textContent = error;
    els.addError.hidden = false;
    return;
  }
  var start = TopicCore.parseManualDateTime(els.addStart.value);
  var end = TopicCore.parseManualDateTime(els.addEnd.value);
  state.sessions.push({
    topic: TopicCore.normalizeTopic(els.addTopic.value),
    start: TopicCore.localIso(start),
    end: TopicCore.localIso(end),
    elapsedSeconds: Math.round((end.getTime() - start.getTime()) / 1000)
  });
  closeAddForm();
  render();
  writeLog().catch(function () {
    flash('Warning: could not write the log file');
  });
  flash('Session added to the log');
}

async function exportCsv() {
  if (state.sessions.length === 0) {
    flash('Nothing to export yet');
    return;
  }
  var defaultPath = dataDir + '/topic-timer-export.csv';
  var chosen = await Neutralino.os.showSaveDialog('Export sessions to CSV', {
    defaultPath: defaultPath,
    filters: [{ name: 'CSV files', extensions: ['csv'] }]
  });
  var path = typeof chosen === 'string' ? chosen : (chosen && chosen.path);
  if (!path) return;
  if (!/\.csv$/i.test(path)) path += '.csv';
  await Neutralino.filesystem.writeFile(path, TopicCore.sessionsToCsv(state.sessions));
  flash('Exported to ' + path);
}

async function loadLog() {
  var raw = null;
  try {
    raw = await Neutralino.filesystem.readFile(dataFile);
  } catch (error) {
    return;
  }
  var data = null;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    var bak = dataDir + '/log.corrupt-' + Date.now() + '.bak';
    var quarantined = false;
    try {
      await Neutralino.filesystem.move(dataFile, bak);
      quarantined = true;
    } catch (moveError) {}
    if (quarantined) {
      flash('Log file was unreadable; started fresh (bad file kept as ' + bak.split('/').pop() + ')');
      lastSynced = [];
      return;
    }
    writesBlocked = true;
    flash('WARNING: log file unreadable and could not be backed up \u2014 not touching it. Choose a new log folder in Settings.');
    lastSynced = [];
    return;
  }
  state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  lastSynced = deepCopy(state.sessions);
  var open = data.open;
  if (
    open &&
    typeof open.topic === 'string' &&
    TopicCore.normalizeTopic(open.topic) !== ''
  ) {
    var recovered = Number(open.elapsedSeconds) || 0;
    state.sessions.push({
      topic: open.topic,
      start: String(open.startedAt || ''),
      end: String(open.savedAt || open.startedAt || ''),
      elapsedSeconds: Math.max(0, Math.round(recovered))
    });
    flash('Recovered ' + TopicCore.fmtHMS(recovered) + ' on "' + open.topic + '" after an unclean exit');
  }
  var last = state.sessions.length > 0 ? state.sessions[state.sessions.length - 1] : null;
  if (
    last &&
    typeof last.topic === 'string' &&
    TopicCore.normalizeTopic(els.topicInput.value) === ''
  ) {
    els.topicInput.value = last.topic;
  }
}

async function main() {
  var fallback = await defaultDataDir();
  settingsFile = fallback + '/' + SETTINGS_FILE;
  dataDir = await readSettings(fallback);
  dataFile = dataDir + '/log.json';
  try {
    await ensureDataDir(dataDir);
  } catch (error) {
    flash('WARNING: cannot access the log folder (' + dataDir + '). Sessions will not be saved until you pick a folder in Settings.');
  }
  var lock = await acquireLock(dataDir);
  if (!lock.acquired) {
    try {
      await Neutralino.os.showMessageBox(
        'Topic Timer',
        lock.unverified
          ? 'Topic Timer may already be running (the check could not be verified). This window will close to protect the log.'
          : 'Topic Timer is already running (another instance holds the lock). This window will close.'
      );
    } catch (error) {}
    Neutralino.app.exit();
    return;
  }
  lockPath = lock.path;
  await loadLog();
  render();
  writeLog().catch(function () {}); // first write; loadLog already surfaced any real problem
  positionBottomRight();
}

Neutralino.init();

Neutralino.events.on('ready', main);

els.topicInput.addEventListener('input', function () {
  if (!state.open) {
    els.btnStart.disabled = TopicCore.normalizeTopic(els.topicInput.value) === '';
  }
});

els.topicInput.addEventListener('keydown', function (event) {
  if (event.key === 'Enter') startSession();
});

els.btnStart.addEventListener('click', startSession);
els.btnPause.addEventListener('click', pauseSession);
els.btnResume.addEventListener('click', resumeSession);
els.btnStop.addEventListener('click', stopSession);

els.btnExport.addEventListener('click', function () {
  exportCsv().catch(function () {
    flash('Export failed');
  });
});

els.btnAdd.addEventListener('click', openAddForm);
els.btnAddCancel.addEventListener('click', closeAddForm);
els.btnAddSave.addEventListener('click', saveAddForm);
els.addForm.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') closeAddForm();
  if (event.key === 'Enter') saveAddForm();
});

els.btnSettings.addEventListener('click', openSettings);
els.btnSettingsBrowse.addEventListener('click', function () {
  browseForDataDir().catch(function () {
    els.settingsError.textContent = 'Could not open the folder picker.';
    els.settingsError.hidden = false;
  });
});
els.btnSettingsDone.addEventListener('click', function () {
  applySettings().catch(function () {
    els.settingsError.textContent = 'Could not save the log to that folder.';
    els.settingsError.hidden = false;
  });
});
els.settingsPanel.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') closeSettings();
});

els.btnExit.addEventListener('click', function () {
  var pending = Promise.resolve(true);
  if (state.open) {
    finalizeSession();
    pending = writeLog().then(function () { return true; }, function () { return false; });
  }
  pending.then(function (saved) {
    var proceed = saved
      ? Promise.resolve()
      : Neutralino.os.showMessageBox(
          'Topic Timer',
          'The final session could not be written to the log file (disk full or file locked?). It will be lost when the app exits.'
        ).catch(function () {});
    proceed.then(function () {
      releaseLock().finally(function () {
        Neutralino.app.exit();
      });
    });
  });
});

document.addEventListener('mousedown', function (event) {
  if (event.button !== 0) return;
  if (event.target.closest('button, input')) return;
  Neutralino.window.beginDrag(event.screenX, event.screenY);
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    state: state,
    startSession: startSession,
    pauseSession: pauseSession,
    resumeSession: resumeSession,
    stopSession: stopSession,
    tick: tick,
    openAddForm: openAddForm,
    closeAddForm: closeAddForm,
    saveAddForm: saveAddForm,
    openSettings: openSettings,
    closeSettings: closeSettings,
    browseForDataDir: browseForDataDir,
    applySettings: applySettings,
    changeDataDir: changeDataDir,
    writeLog: writeLog
  };
}
