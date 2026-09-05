'use strict';

const assert = require('assert');
const T = require('../resources/js/core.js');

assert.strictEqual(T.normalizeTopic('  email '), 'email');
assert.strictEqual(T.normalizeTopic(null), '');
assert.strictEqual(T.normalizeTopic(42), '42');

assert.ok(T.sameTopic('Email', 'email'));
assert.ok(T.sameTopic('Email ', '  EMAIL'));
assert.ok(!T.sameTopic('Email', 'inbox'));

assert.strictEqual(T.computeElapsed(10, 1000, 3000, true), 10);
assert.strictEqual(T.computeElapsed(10, 1000, 3000, false), 12);
assert.strictEqual(T.computeElapsed(10, 1000, 500, false), 10);

assert.strictEqual(T.fmtHMS(0), '00:00:00');
assert.strictEqual(T.fmtHMS(59), '00:00:59');
assert.strictEqual(T.fmtHMS(45296), '12:34:56');
assert.strictEqual(T.fmtHMS(12 * 3600), '12:00:00');

assert.ok(T.shouldAutoPause(T.CAP_SECONDS, false));
assert.ok(!T.shouldAutoPause(T.CAP_SECONDS - 1, false));
assert.ok(!T.shouldAutoPause(T.CAP_SECONDS + 1, true));
assert.ok(T.shouldAutoPause(100, false, 100));
assert.ok(!T.shouldAutoPause(99, false, 100));

const iso = T.localIso(new Date(2026, 8, 1, 10, 30, 5));
assert.ok(/^2026-09-01T10:30:05[+-]\d{2}:\d{2}$/.test(iso), iso);

assert.strictEqual(T.csvEscape('plain'), 'plain');
assert.strictEqual(T.csvEscape('a,b'), '"a,b"');
assert.strictEqual(T.csvEscape('say "hi"'), '"say ""hi"""');
assert.strictEqual(T.csvEscape('line\nbreak'), '"line\nbreak"');
assert.strictEqual(T.csvEscape(''), '');

const csv = T.sessionsToCsv([
  {
    topic: 'Email',
    start: '2026-09-01T09:00:00+05:30',
    end: '2026-09-01T10:30:00+05:30',
    elapsedSeconds: 5400
  },
  {
    topic: 'deep work, planning',
    start: '2026-09-02T22:00:00+05:30',
    end: '2026-09-03T01:00:00+05:30',
    elapsedSeconds: 10800
  }
]);
assert.ok(csv.startsWith('topic,start,end,elapsed_seconds,elapsed\r\n'), csv);
assert.ok(
  csv.includes('Email,2026-09-01T09:00:00+05:30,2026-09-01T10:30:00+05:30,5400,01:30:00'),
  csv
);
assert.ok(
  csv.includes('"deep work, planning",2026-09-02T22:00:00+05:30,2026-09-03T01:00:00+05:30,10800,03:00:00'),
  csv
);
assert.ok(csv.endsWith('\r\n'));

assert.strictEqual(T.parseManualDateTime('2026-09-01T10:30').getTime(), new Date(2026, 8, 1, 10, 30).getTime());
assert.strictEqual(T.parseManualDateTime('2026-09-01T10:30:15').getTime(), new Date(2026, 8, 1, 10, 30, 15).getTime());
assert.strictEqual(T.parseManualDateTime('not a date'), null);
assert.strictEqual(T.parseManualDateTime('2026-13-01T10:30'), null);
assert.strictEqual(T.parseManualDateTime(''), null);
assert.strictEqual(T.parseManualDateTime(null), null);

const NOW = new Date(2026, 8, 5, 12, 0, 0).getTime();
assert.strictEqual(T.manualSessionError('Email', '2026-09-05T10:00', '2026-09-05T11:00', T.CAP_SECONDS, NOW), null);
assert.ok(T.manualSessionError('', '2026-09-05T10:00', '2026-09-05T11:00', T.CAP_SECONDS, NOW).includes('topic'));
assert.ok(T.manualSessionError('Email', 'garbage', '2026-09-05T11:00', T.CAP_SECONDS, NOW).includes('start'));
assert.ok(T.manualSessionError('Email', '2026-09-05T10:00', 'nope', T.CAP_SECONDS, NOW).includes('end'));
assert.ok(T.manualSessionError('Email', '2026-09-05T11:00', '2026-09-05T10:00', T.CAP_SECONDS, NOW).includes('after'));
assert.ok(T.manualSessionError('Email', '2026-09-05T10:00', '2026-09-05T10:00', T.CAP_SECONDS, NOW).includes('after'));
assert.ok(T.manualSessionError('Email', '2026-09-04T10:00', '2026-09-05T11:00', T.CAP_SECONDS, NOW).includes('cap'));
assert.ok(T.manualSessionError('Email', '2026-09-05T10:00', '2026-09-05T13:00', T.CAP_SECONDS, NOW).includes('future'));
assert.strictEqual(T.manualSessionError('Email', '2026-09-05T11:59:30', '2026-09-05T12:00:30', T.CAP_SECONDS, NOW), null, '60s future grace');

assert.deepStrictEqual(T.mergeSessions([], []), [], 'merge of empty lists');
assert.deepStrictEqual(
  T.mergeSessions([{ topic: 'A' }], [{ topic: 'B' }]),
  [{ topic: 'A' }, { topic: 'B' }],
  'merge keeps both sides in order'
);
const dup = { topic: 'A', start: 'x', end: 'y', elapsedSeconds: 1 };
assert.deepStrictEqual(
  T.mergeSessions([dup], [dup, { topic: 'B' }]),
  [dup, { topic: 'B' }],
  'merge drops exact duplicates'
);
assert.deepStrictEqual(T.mergeSessions(null, [{ topic: 'B' }]), [{ topic: 'B' }], 'merge tolerates null');
assert.deepStrictEqual(T.mergeSessions([{ topic: 'A' }], 'garbage'), [{ topic: 'A' }], 'merge tolerates non-list');

console.log('core tests passed');
