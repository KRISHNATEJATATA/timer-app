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
  btnExit: document.getElementById('btnExit')
};

var DATA_DIR_NAME = 'TopicTimer';
var PREFERRED_DATA_DIR = 'C:/Office/temp/timer/data/TopicTimer';
var dataDir = null;
var dataFile = null;
var ticker = null;
var flashTimer = null;
var state = { open: null, sessions: [], pausedTopic: null, pausedElapsed: 0, capNoticed: false, lastPersistAt: 0 };
var lastSynced = [];

var PERSIST_INTERVAL_MS = 60000;
var SLEEP_GAP_MS = 120000;
var lockPath = null;

function exeBaseName() {
  try {
    var args = (typeof window !== 'undefined' && window.NL_ARGS) || [];
    var parts = String(args[0] || '').split(/[\\/]/);
    return parts[parts.length - 1] || '';
  } catch (error) {
    return '';
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
    var alive = false;
    if (!isNaN(existingPid)) {
      try {
        var res = await Neutralino.os.execCommand('tasklist /FI "PID eq ' + existingPid + '" /NH');
        var out = res && (res.output || res);
        var base = exeBaseName();
        alive = base !== '' && String(out).indexOf(base) !== -1 && String(out).indexOf(String(existingPid)) !== -1;
      } catch (error) {
        alive = false;
      }
    }
    if (alive) return { acquired: false, path: path };
  }
  try {
    await Neutralino.filesystem.writeFile(path, String(pid === null ? '' : pid));
  } catch (error) {}
  return { acquired: true, path: path };
}

async function releaseLock() {
  if (!lockPath) return;
  try {
    await Neutralino.filesystem.remove(lockPath);
  } catch (error) {}
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

async function resolveDataDir() {
  var candidates = [PREFERRED_DATA_DIR];
  try {
    var documents = await Neutralino.os.getPath('documents');
    if (typeof documents === 'string' && documents.trim() !== '') {
      candidates.push(documents.replace(/[\\/]+$/, '') + '/' + DATA_DIR_NAME);
    }
  } catch (error) {}
  try {
    var appData = await Neutralino.os.getPath('data');
    if (typeof appData === 'string' && appData.trim() !== '') {
      candidates.push(appData.replace(/[\\/]+$/, '') + '/' + DATA_DIR_NAME);
    }
  } catch (error) {}
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i].replace(/[\\/]+$/, '');
    try {
      await createDirectoryDeep(candidate);
      await Neutralino.filesystem.access(candidate);
      return candidate;
    } catch (error) {}
  }
  return PREFERRED_DATA_DIR;
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
    writeLog().catch(function () {});
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
  await Neutralino.filesystem.writeFile(dataFile, JSON.stringify(payload, null, 2));
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
  var chosen = await Neutralino.os.showSaveDialog('Export sessions to CSV', defaultPath);
  var path = typeof chosen === 'string' ? chosen : (chosen && chosen.path);
  if (!path) return;
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
    try {
      await Neutralino.filesystem.rename(dataFile, dataDir + '/log.corrupt.bak');
      flash('Log file was unreadable; started fresh (bad file kept as log.corrupt.bak)');
    } catch (renameError) {
      flash('Log file was unreadable; started fresh');
    }
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
  dataDir = await resolveDataDir();
  dataFile = dataDir + '/log.json';
  await ensureDataDir(dataDir);
  var lock = await acquireLock(dataDir);
  if (!lock.acquired) {
    try {
      await Neutralino.os.showMessageBox(
        'Topic Timer',
        'Topic Timer is already running (another instance holds the lock). This window will close.'
      );
    } catch (error) {}
    Neutralino.app.exit();
    return;
  }
  lockPath = lock.path;
  await loadLog();
  render();
  writeLog().catch(function () {});
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

els.btnExit.addEventListener('click', function () {
  var pending = Promise.resolve();
  if (state.open) {
    finalizeSession();
    pending = writeLog().catch(function () {});
  }
  pending.then(function () {
    releaseLock().finally(function () {
      Neutralino.app.exit();
    });
  });
});

document.addEventListener('mousedown', function (event) {
  if (event.button !== 0) return;
  if (event.target.closest('button, input')) return;
  Neutralino.window.drag();
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
    writeLog: writeLog
  };
}
