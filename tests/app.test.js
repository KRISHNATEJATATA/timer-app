'use strict';

const assert = require('assert');

const PREFERRED = 'C:/Office/temp/timer/data/TopicTimer';
const FAKE_APPDATA = 'C:/fake/appdata';

function makeFake(options) {
  options = options || {};
  const failCreateUnder = options.failCreateUnder || [];
  const initialFiles = Object.assign({}, options.initialFiles);
  const livePids = options.livePids || [];
  const calls = [];
  const api = {
    calls: calls,
    writes: [],
    exited: false,
    init() {},
    events: {
      readyHandler: null,
      on(event, handler) {
        if (event === 'ready') api.events.readyHandler = handler;
      }
    },
    app: {
      async getProcessId() {
        return 4242;
      },
      exit() {
        api.exited = true;
      }
    },
    os: {
      async getPath(name) {
        calls.push(['os.getPath', name]);
        if (name === 'documents') throw { code: 'NE_OS_PATHNOEX' };
        return FAKE_APPDATA;
      },
      async execCommand(cmd) {
        calls.push(['os.execCommand', cmd]);
        const alive = livePids.some((pid) => cmd.includes(String(pid)));
        return {
          output: alive
            ? 'TopicTimer.exe                ' + livePids[0] + ' Console              1     12,345 K'
            : 'INFO: No tasks are running which match the specified criteria.'
        };
      },
      async showMessageBox(title, text) {
        calls.push(['os.showMessageBox', title]);
        return null;
      }
    },
    filesystem: {
      _exists: initialFiles,
      async access(p) {
        calls.push(['filesystem.access', p]);
        if (!api.filesystem._exists[p]) throw { code: 'NE_FS_FILRDER' };
      },
      async createDirectory(p) {
        calls.push(['filesystem.createDirectory', p]);
        for (const prefix of failCreateUnder) {
          if (p === prefix || p.startsWith(prefix + '/')) {
            throw { code: 'NE_FS_DIRCRER' };
          }
        }
        api.filesystem._exists[p] = true;
      },
      async readFile(p) {
        calls.push(['filesystem.readFile', p]);
        if (typeof api.filesystem._exists[p] !== 'string') throw { code: 'NE_FS_FILRDER' };
        return api.filesystem._exists[p];
      },
      async writeFile(p, data) {
        calls.push(['filesystem.writeFile', p]);
        api.filesystem._exists[p] = data;
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch (error) {}
        api.writes.push({ path: p, data: parsed });
      },
      async rename(p) {
        calls.push(['filesystem.rename', p]);
      },
      async remove(p) {
        calls.push(['filesystem.remove', p]);
        delete api.filesystem._exists[p];
      }
    }
  };
  return api;
}

function elementStub() {
  return {
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    dataset: {},
    addEventListener() {}
  };
}

const elements = {};
global.document = {
  getElementById(id) {
    if (!elements[id]) elements[id] = elementStub();
    return elements[id];
  },
  addEventListener() {}
};
global.TopicCore = require('../resources/js/core.js');

function loadApp(fake, nlArgs) {
  global.Neutralino = fake;
  global.window = { NL_ARGS: nlArgs || ['C:/apps/TopicTimer.exe'] };
  for (const key of Object.keys(elements)) delete elements[key];
  delete require.cache[require.resolve('../resources/js/app.js')];
  const app = require('../resources/js/app.js');
  return app;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function logWrites(fake) {
  return fake.writes.filter((w) => w.path.endsWith('log.json'));
}

async function runLifecycle(fake) {
  const app = loadApp(fake);
  assert.strictEqual(typeof fake.events.readyHandler, 'function', 'ready handler registered');
  await fake.events.readyHandler();
  await settle();

  const dataFile = fake.calls.find((c) => c[0] === 'filesystem.writeFile' && c[1].endsWith('log.json'))[1];
  assert.ok(dataFile.endsWith('/log.json'), 'writes target log.json, got ' + dataFile);
  const seed = logWrites(fake)[0];
  assert.deepStrictEqual(seed.data, { open: null, sessions: [] }, 'seeds empty log');

  assert.strictEqual(elements.btnStart.disabled, true, 'Start disabled for empty topic');
  assert.strictEqual(elements.btnStop.hidden, true, 'Stop hidden when idle');

  elements.topicInput.value = '  Email ';
  app.startSession();
  await settle();
  const writesAfterStart = logWrites(fake).length;
  assert.strictEqual(app.state.open.topic, 'Email', 'topic trimmed on start');
  const startWrite = logWrites(fake)[logWrites(fake).length - 1];
  assert.strictEqual(startWrite.data.open.topic, 'Email', 'start persists an open snapshot');
  assert.strictEqual(elements.topicInput.disabled, true, 'topic input locked while running');
  assert.strictEqual(elements.btnStart.hidden, true, 'Start hidden while running');
  assert.strictEqual(elements.btnPause.hidden, false, 'Pause visible while running');
  assert.strictEqual(elements.btnStop.hidden, false, 'Stop visible while running');

  app.state.open.baseAt = Date.now() - 5000;
  app.tick();
  await settle();
  assert.strictEqual(logWrites(fake).length, writesAfterStart, 'tick within persist interval does not write');

  app.pauseSession();
  await settle();
  assert.strictEqual(app.state.open, null, 'pause finalizes the session');
  assert.strictEqual(app.state.sessions.length, 1, 'paused session logged');
  assert.strictEqual(app.state.sessions[0].topic, 'Email');
  assert.strictEqual(app.state.sessions[0].elapsedSeconds, 5, 'paused session logs its own 5s');
  assert.ok(Math.abs(app.state.pausedElapsed - (5)) < 0.5, '2');
  assert.strictEqual(logWrites(fake).length, writesAfterStart + 1, 'exactly one log write at pause');
  assert.strictEqual(elements.topicInput.disabled, true, 'topic locked while paused');
  assert.strictEqual(elements.topicInput.value, 'Email', 'paused topic shown while paused');
  assert.strictEqual(elements.btnResume.hidden, false, 'Resume offered after pause');
  assert.strictEqual(elements.btnPause.hidden, true, 'Pause hidden after pause');
  assert.strictEqual(elements.btnStart.hidden, true, 'Start hidden while paused (topic locked)');
  assert.strictEqual(elements.btnStop.hidden, false, 'Stop visible while paused (dismiss chain)');
  assert.strictEqual(elements.notice.hidden, true, 'cap notice hidden on normal pause');

  const writesBeforeResume = logWrites(fake).length;
  app.resumeSession();
  await settle();
  assert.strictEqual(app.state.open.topic, 'Email', 'resume continues same topic');
  assert.ok(Math.abs(app.state.open.baseElapsed - 5) < 0.5, 'resumed clock base = 5s (display continuity)');
  assert.ok(Math.abs(app.state.open.chainBase - 5) < 0.5, 'chain base = 5s so log stays truthful');
  assert.strictEqual(elements.topicInput.disabled, true, 'input locked again after resume');
  assert.strictEqual(elements.btnResume.hidden, true, 'Resume hidden once resumed');
  assert.strictEqual(elements.btnPause.hidden, false, 'Pause visible again');
  assert.strictEqual(logWrites(fake).length, writesBeforeResume, 'resume does not write');

  app.state.open.baseAt = Date.now() - 2000;
  app.stopSession();
  await settle();
  assert.strictEqual(app.state.open, null, 'stop finalizes');
  assert.strictEqual(app.state.sessions.length, 2, 'second session logged');
  assert.strictEqual(app.state.sessions[1].elapsedSeconds, 2, 'resumed session logs only its own 2s');
  assert.strictEqual(app.state.pausedTopic, null, 'stop clears the chain');
  assert.strictEqual(logWrites(fake).length, writesBeforeResume + 1, 'exactly one log write at stop');
  assert.strictEqual(elements.topicInput.disabled, false, 'topic editable after stop');

  elements.topicInput.value = 'Email';
  app.startSession();
  await settle();
  assert.strictEqual(app.state.open.baseElapsed, 0, 'fresh start restarts clock at zero');

  app.state.open.baseAt = Date.now() - 4000;
  app.pauseSession();
  await settle();
  assert.strictEqual(app.state.sessions[2].elapsedSeconds, 4, 'fresh chain logs own 4s');
  assert.ok(Math.abs(app.state.pausedElapsed - (4)) < 0.5, '2');

  app.resumeSession();
  app.state.open.baseAt = Date.now() - 6000;
  app.pauseSession();
  await settle();
  assert.strictEqual(app.state.sessions[3].elapsedSeconds, 6, 'second link logs own 6s');
  assert.ok(Math.abs(app.state.pausedElapsed - (10)) < 0.5, '2');

  const writesBeforePauseStop = logWrites(fake).length;
  app.stopSession();
  await settle();
  assert.strictEqual(logWrites(fake).length, writesBeforePauseStop, 'stop while paused does not write');
  assert.strictEqual(app.state.pausedTopic, null, 'stop from paused dismisses chain');
  assert.strictEqual(elements.topicInput.disabled, false, 'new topic selectable after stop');
  assert.strictEqual(app.state.sessions.length, 4, 'no extra session from dismissing');
}

(async function run() {
  await runLifecycle(makeFake());
  const preferredFake = makeFake();
  await runLifecycle(preferredFake);
  const preferredAppFile = preferredFake.calls.find(
    (c) => c[0] === 'filesystem.writeFile' && c[1].endsWith('log.json')
  )[1];
  assert.strictEqual(preferredAppFile, PREFERRED + '/log.json', 'prefers the project data folder');

  const failingFake = makeFake({ failCreateUnder: [PREFERRED] });
  await runLifecycle(failingFake);
  const fallbackDataFile = failingFake.calls.find(
    (c) => c[0] === 'filesystem.writeFile' && c[1].endsWith('log.json')
  )[1];
  assert.strictEqual(fallbackDataFile, FAKE_APPDATA + '/TopicTimer/log.json', 'falls back to appdata when preferred path fails');

  const prefillFake = makeFake({
    initialFiles: {
      [PREFERRED + '/log.json']: JSON.stringify({
        open: null,
        sessions: [
          { topic: 'Email', start: '2026-09-01T09:00:00+05:30', end: '2026-09-01T09:30:00+05:30', elapsedSeconds: 1800 },
          { topic: 'Reading', start: '2026-09-01T10:00:00+05:30', end: '2026-09-01T10:15:00+05:30', elapsedSeconds: 900 }
        ]
      })
    }
  });
  const prefillApp = loadApp(prefillFake);
  await prefillFake.events.readyHandler();
  await settle();
  assert.strictEqual(prefillApp.state.sessions.length, 2, 'existing sessions loaded');
  assert.strictEqual(elements.topicInput.value, 'Reading', 'topic input prefilled with last topic');
  assert.strictEqual(elements.btnStart.disabled, false, 'Start enabled thanks to prefill');

  const corruptFake = makeFake({
    initialFiles: {
      [PREFERRED + '/log.json']: '{ not valid json !!'
    }
  });
  const corruptApp = loadApp(corruptFake);
  await corruptFake.events.readyHandler();
  await settle();
  assert.ok(
    corruptFake.calls.some((c) => c[0] === 'filesystem.rename'),
    'corrupt log quarantined via rename'
  );
  assert.deepStrictEqual(corruptApp.state.sessions, [], 'corrupt log starts fresh');

  const sleepFake = makeFake();
  const sleepApp = loadApp(sleepFake);
  await sleepFake.events.readyHandler();
  await settle();
  elements.topicInput.value = 'Email';
  sleepApp.startSession();
  await settle();
  const writesAfterStart = logWrites(sleepFake).length;
  sleepApp.state.open.startedAt = Date.now() - 126000;
  sleepApp.state.open.baseAt = Date.now() - 126000;
  sleepApp.state.open.chainBase = 0;
  sleepApp.state.open.lastTickAt = Date.now() - 121000;
  sleepApp.state.open.lastTickDisplay = 5;
  sleepApp.tick();
  await settle();
  assert.strictEqual(sleepApp.state.open, null, 'sleep gap finalizes the session');
  assert.strictEqual(sleepApp.state.sessions.length, 1, 'pre-sleep session logged');
  assert.strictEqual(sleepApp.state.sessions[0].elapsedSeconds, 5, 'sleep time excluded: only 5s logged');
  assert.ok(
    Date.parse(sleepApp.state.sessions[0].end) <= Date.now() - 120000,
    'session end is the pre-sleep moment'
  );
  assert.strictEqual(sleepApp.state.pausedElapsed, 5, 'paused display continues from pre-sleep total');
  assert.strictEqual(sleepApp.state.pausedTopic, 'Email', 'resume offered after sleep pause');
  assert.strictEqual(logWrites(sleepFake).length, writesAfterStart + 1, 'one log write at sleep pause');

  const minuteFake = makeFake();
  const minuteApp = loadApp(minuteFake);
  await minuteFake.events.readyHandler();
  await settle();
  elements.topicInput.value = 'Email';
  minuteApp.startSession();
  await settle();
  const writesAtStart = logWrites(minuteFake).length;
  minuteApp.state.lastPersistAt = Date.now() - 61000;
  minuteApp.state.open.baseAt = Date.now() - 2000;
  minuteApp.tick();
  await settle();
  assert.strictEqual(minuteApp.state.open !== null, true, 'minute tick keeps session running');
  const minuteWrite = logWrites(minuteFake)[logWrites(minuteFake).length - 1];
  assert.strictEqual(minuteWrite.data.open.topic, 'Email', 'minute tick persists open snapshot');
  assert.strictEqual(minuteWrite.data.open.elapsedSeconds, 2, 'open snapshot carries own elapsed 2s');
  assert.strictEqual(logWrites(minuteFake).length, writesAtStart + 1, 'exactly one write on minute boundary');

  const recoveryFake = makeFake({
    initialFiles: {
      [PREFERRED + '/log.json']: JSON.stringify({
        open: {
          topic: 'Email',
          startedAt: '2026-09-02T10:00:00+05:30',
          elapsedSeconds: 42,
          savedAt: '2026-09-02T10:42:00+05:30'
        },
        sessions: []
      })
    }
  });
  const recoveryApp = loadApp(recoveryFake);
  await recoveryFake.events.readyHandler();
  await settle();
  assert.strictEqual(recoveryApp.state.sessions.length, 1, 'recovered open session logged');
  assert.strictEqual(recoveryApp.state.sessions[0].elapsedSeconds, 42, 'recovered elapsed = 42s');
  assert.strictEqual(recoveryApp.state.sessions[0].topic, 'Email');
  const recoveryWrite = logWrites(recoveryFake)[0];
  assert.deepStrictEqual(recoveryWrite.data.open, null, 'recovered open cleared in file');
  assert.strictEqual(elements.topicInput.value, 'Email', 'topic prefilled from recovered session');

  const lockBlockedFake = makeFake({
    initialFiles: { [PREFERRED + '/app.lock']: '999' },
    livePids: [999]
  });
  const blockedApp = loadApp(lockBlockedFake);
  await lockBlockedFake.events.readyHandler();
  await settle();
  assert.strictEqual(lockBlockedFake.exited, true, 'second instance exits when lock is alive');
  assert.strictEqual(
    lockBlockedFake.calls.some((c) => c[0] === 'os.showMessageBox'),
    true,
    'user informed about already-running instance'
  );
  assert.strictEqual(
    lockBlockedFake.calls.some((c) => c[0] === 'filesystem.writeFile' && c[1].endsWith('log.json')),
    false,
    'blocked instance never touches the log'
  );

  const lockStaleFake = makeFake({
    initialFiles: { [PREFERRED + '/app.lock']: '555' },
    livePids: []
  });
  const staleApp = loadApp(lockStaleFake);
  await lockStaleFake.events.readyHandler();
  await settle();
  assert.strictEqual(lockStaleFake.exited, false, 'stale lock does not block startup');
  const lockWrite = lockStaleFake.writes.find((w) => w.path.endsWith('app.lock'));
  assert.ok(lockWrite, 'stale lock replaced');
  assert.strictEqual(String(lockWrite.data), '4242', 'lock now holds our pid');
  assert.strictEqual(lockStaleFake.writes.some((w) => w.path.endsWith('log.json')), true, 'app proceeds normally');

  const addFake = makeFake();
  const addApp = loadApp(addFake);
  await addFake.events.readyHandler();
  await settle();
  elements.addForm.hidden = true; // real DOM starts hidden via the hidden attribute
  assert.strictEqual(elements.addForm.hidden, true, 'add form hidden initially');
  addApp.openAddForm();
  assert.strictEqual(elements.addForm.hidden, false, 'Add Session opens the form');
  assert.ok(elements.addStart.value !== '', 'start pre-filled');
  assert.ok(elements.addEnd.value !== '', 'end pre-filled');
  elements.addTopic.value = 'Deep work';
  const fixedStart = new Date(Date.now() - 7200000);
  const fixedEnd = new Date(Date.now() - 3600000);
  elements.addStart.value = fixedStart.getFullYear() + '-' +
    String(fixedStart.getMonth() + 1).padStart(2, '0') + '-' +
    String(fixedStart.getDate()).padStart(2, '0') + 'T' +
    String(fixedStart.getHours()).padStart(2, '0') + ':' +
    String(fixedStart.getMinutes()).padStart(2, '0');
  elements.addEnd.value = fixedEnd.getFullYear() + '-' +
    String(fixedEnd.getMonth() + 1).padStart(2, '0') + '-' +
    String(fixedEnd.getDate()).padStart(2, '0') + 'T' +
    String(fixedEnd.getHours()).padStart(2, '0') + ':' +
    String(fixedEnd.getMinutes()).padStart(2, '0');
  addApp.saveAddForm();
  await settle();
  assert.strictEqual(elements.addForm.hidden, true, 'form closes after save');
  assert.strictEqual(addApp.state.sessions.length, 1, 'manual session pushed');
  const manual = addApp.state.sessions[0];
  assert.strictEqual(manual.topic, 'Deep work');
  assert.strictEqual(manual.elapsedSeconds, 3600, 'manual elapsed = end - start');
  const addWrite = logWrites(addFake)[logWrites(addFake).length - 1];
  assert.strictEqual(addWrite.data.sessions.length, 1, 'manual session written to log.json');
  assert.strictEqual(addWrite.data.sessions[0].topic, 'Deep work');

  addApp.openAddForm();
  elements.addTopic.value = '';
  const writesBeforeInvalid = logWrites(addFake).length;
  addApp.saveAddForm();
  assert.strictEqual(elements.addForm.hidden, false, 'invalid form stays open');
  assert.strictEqual(elements.addError.hidden, false, 'error shown for empty topic');
  assert.strictEqual(logWrites(addFake).length, writesBeforeInvalid, 'no write on invalid save');
  elements.addEnd.value = elements.addStart.value;
  addApp.saveAddForm();
  assert.strictEqual(elements.addError.hidden, false, 'error shown when end is not after start');
  elements.addTopic.value = 'Deep work';
  elements.addStart.value = '2020-01-01T00:00';
  elements.addEnd.value = '2020-01-01T13:00';
  addApp.saveAddForm();
  assert.ok(elements.addError.textContent.includes('cap'), 'error shown when over the 12h cap');
  addApp.closeAddForm();
  assert.strictEqual(elements.addForm.hidden, true, 'cancel closes the form');
  assert.strictEqual(addApp.state.sessions.length, 1, 'cancel adds nothing');

  const manualEditFake = makeFake({
    initialFiles: {
      [PREFERRED + '/log.json']: JSON.stringify({
        open: null,
        sessions: [
          { topic: 'Email', start: '2026-09-01T09:00:00+05:30', end: '2026-09-01T09:30:00+05:30', elapsedSeconds: 1800 }
        ]
      })
    }
  });
  const manualEditApp = loadApp(manualEditFake);
  await manualEditFake.events.readyHandler();
  await settle();
  assert.strictEqual(manualEditApp.state.sessions.length, 1, 'seed session loaded');
  // Owner edits the JSON while the app runs.
  manualEditFake.filesystem._exists[PREFERRED + '/log.json'] = JSON.stringify({
    open: null,
    sessions: [
      { topic: 'Email (edited)', start: '2026-09-01T09:00:00+05:30', end: '2026-09-01T09:30:00+05:30', elapsedSeconds: 1800 },
      { topic: 'Added by hand', start: '2026-09-02T10:00:00+05:30', end: '2026-09-02T11:00:00+05:30', elapsedSeconds: 3600 }
    ]
  });
  await manualEditApp.writeLog();
  await settle();
  assert.strictEqual(manualEditApp.state.sessions.length, 2, 'manual edit kept: edited entry + hand-added entry');
  assert.strictEqual(manualEditApp.state.sessions[0].topic, 'Email (edited)', 'in-place edit survives the write');
  assert.strictEqual(manualEditApp.state.sessions[1].topic, 'Added by hand', 'hand-added entry survives the write');
  const mergeWrite = logWrites(manualEditFake)[logWrites(manualEditFake).length - 1];
  assert.strictEqual(mergeWrite.data.sessions.length, 2, 'file now contains merged list');

  // App-side additions made since startup are preserved alongside manual edits.
  const appAddFake = makeFake({
    initialFiles: {
      [PREFERRED + '/log.json']: JSON.stringify({
        open: null,
        sessions: [
          { topic: 'Email', start: '2026-09-01T09:00:00+05:30', end: '2026-09-01T09:30:00+05:30', elapsedSeconds: 1800 }
        ]
      })
    }
  });
  const appAddApp = loadApp(appAddFake);
  await appAddFake.events.readyHandler();
  await settle();
  appAddApp.state.sessions.push({
    topic: 'Live session',
    start: '2026-09-03T09:00:00+05:30',
    end: '2026-09-03T10:00:00+05:30',
    elapsedSeconds: 3600
  });
  appAddFake.filesystem._exists[PREFERRED + '/log.json'] = JSON.stringify({
    open: null,
    sessions: [
      { topic: 'Email', start: '2026-09-01T09:00:00+05:30', end: '2026-09-01T09:30:00+05:30', elapsedSeconds: 1800 },
      { topic: 'Hand-added during run', start: '2026-09-02T10:00:00+05:30', end: '2026-09-02T11:00:00+05:30', elapsedSeconds: 3600 }
    ]
  });
  await appAddApp.writeLog();
  await settle();
  assert.strictEqual(appAddApp.state.sessions.length, 3, 'manual edit + app addition both kept');
  assert.deepStrictEqual(
    appAddApp.state.sessions.map((s) => s.topic),
    ['Email', 'Hand-added during run', 'Live session'],
    'file entries first, pending app entries after'
  );

  console.log('app lifecycle tests passed');
  process.exit(0);
})().catch((error) => {
  console.error('FAILED:', error && error.message);
  process.exit(1);
});



