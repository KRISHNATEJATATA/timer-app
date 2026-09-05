/* Node test for the dashboard's pure logic. Run: node dashboard/test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('./core.js');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-fixture.json'), 'utf8'));
const parsed = core.parseLog(JSON.stringify(fixture));

// --- Fixture totals -------------------------------------------------------
// (The brief's spot-check of 58,320s across 6 topics contradicts its own
// fixture; the true sums are 59,520s across 4 topics. Tests assert the data.)
const total = parsed.sessions.reduce((n, s) => n + s.elapsedSeconds, 0);
assert.strictEqual(total, 59520, 'fixture all-time total');
assert.strictEqual(parsed.sessions.length, 9);

const topics = core.topicTotals(parsed.sessions);
assert.strictEqual(topics.length, 4, 'normalized topic count');
assert.deepStrictEqual(
  topics.map(t => [t.display, t.totalSeconds, t.sessionCount]),
  [
    ['Deep work', 41400, 3],
    ['Meetings', 10800, 2],
    ['Email', 4620, 3],
    ['Code review', 2700, 1]
  ]
);
// Display casing = most recent usage: the latest Deep work entry (Sep 4) typed "Deep work".
assert.strictEqual(topics[0].display, 'Deep work');

// --- Midnight split -------------------------------------------------------
// 22:00 -> 01:00 (+05:30), 10800s: 2h on Sep 1, 1h on Sep 2.
const midnight = parsed.sessions[2];
const split = core.splitAcrossDays(midnight.start, midnight.end, midnight.elapsedSeconds);
assert.deepStrictEqual(split, [
  { day: '2026-09-01', seconds: 7200 },
  { day: '2026-09-02', seconds: 3600 }
]);

// Long-gap session: elapsed is authoritative and fully distributed.
const gap = parsed.sessions[8];
const gapSplit = core.splitAcrossDays(gap.start, gap.end, gap.elapsedSeconds);
assert.strictEqual(gapSplit.reduce((n, b) => n + b.seconds, 0), 5400, 'gap session split sums to elapsed');

const daily = core.dailyTotals(parsed.sessions);
assert.strictEqual([...daily.values()].reduce((a, b) => a + b, 0), 59520, 'daily buckets sum to total');

// --- Work blocks ----------------------------------------------------------
// Email 09:10-09:55 and 14:00-14:20 same day: gap 4h05m > 15min -> separate.
// Deep work Sep 2 10:00 is >15min after Sep 1 01:00 -> separate. So 9 blocks.
const blocks = core.workBlocks(parsed.sessions);
assert.strictEqual(blocks.length, 9, 'no blocks merge across >15min gaps');
assert.strictEqual(blocks[0].topicKey, 'email');

// Merge behavior: 15min gap merges, 16min gap does not.
const sess = (startISO, elapsed) => ({
  topic: 'X', topicKey: 'x',
  start: new Date(startISO).getTime(),
  end: new Date(startISO).getTime() + elapsed * 1000,
  elapsedSeconds: elapsed
});
const boundary = core.workBlocks([sess('2026-09-01T10:00:00Z', 60), sess('2026-09-01T10:16:00Z', 60)]);
assert.strictEqual(boundary.length, 1, 'exact 15min gap merges');
const notMerged = core.workBlocks([sess('2026-09-01T10:00:00Z', 60), sess('2026-09-01T10:17:00Z', 60)]);
assert.strictEqual(notMerged.length, 2, '16min gap does not merge');

// --- Weekly / monthly -----------------------------------------------------
const weeks = core.weeklyTotals(daily);
assert.strictEqual(weeks.reduce((n, w) => n + w.seconds, 0), 59520, 'weekly sums to total');
// Shape contract app.js depends on: weekly rows are objects {key, days, seconds},
// monthly rows are objects {key, seconds} — NOT [key, value] tuples.
for (const w of weeks) {
  assert.ok(w && typeof w.key === 'string' && typeof w.days === 'number' && typeof w.seconds === 'number', 'weekly row shape');
}
const months = core.monthlyTotals(daily);
assert.strictEqual(months.length, 1, 'all fixture days in one month');
assert.strictEqual(months[0].key, '2026-09');
assert.strictEqual(months[0].seconds, 59520);
for (const mo of months) {
  assert.ok(mo && typeof mo.key === 'string' && typeof mo.seconds === 'number', 'monthly row shape');
}

// --- Formatting / robustness ---------------------------------------------
assert.strictEqual(core.formatDuration(2), '0:00:02');
assert.strictEqual(core.formatDuration(2700), '0:45:00');
assert.strictEqual(core.formatDuration(41400), '11:30:00');
assert.strictEqual(core.formatDuration(59520), '16:32:00');

const empty = core.parseLog('{"open":null,"sessions":[]}');
assert.strictEqual(empty.status, 'empty');
assert.strictEqual(empty.sessions.length, 0);

assert.throws(() => core.parseLog('{"open":null,"sessions":['), /corrupt/);

// Invalid entries are skipped and counted, not fatal.
const partial = core.parseLog(JSON.stringify({
  open: null,
  sessions: [
    { topic: 'Ok', start: '2026-09-01T09:00:00+05:30', end: '2026-09-01T09:10:00+05:30', elapsedSeconds: 600 },
    { topic: 'Bad', start: 'nope', end: '2026-09-01T09:10:00+05:30', elapsedSeconds: 600 }
  ]
}));
assert.strictEqual(partial.sessions.length, 1);
assert.strictEqual(partial.invalid, 1);

// null / non-object array entries are skipped, not fatal (hand-edited logs).
const withNulls = core.parseLog(JSON.stringify({
  open: null,
  sessions: [null, 42, 'oops', { topic: 'Ok', start: '2026-09-01T09:00:00+05:30', end: '2026-09-01T09:30:00+05:30', elapsedSeconds: 1800 }]
}));
assert.strictEqual(withNulls.sessions.length, 1, 'null entries skipped');
assert.strictEqual(withNulls.invalid, 3, 'each null/non-object entry counted invalid');

// end before start is data corruption, not a session.
const reversed = core.parseLog(JSON.stringify({
  open: null,
  sessions: [
    { topic: 'Backwards', start: '2026-09-01T10:00:00+05:30', end: '2026-09-01T09:00:00+05:30', elapsedSeconds: 3600 },
    { topic: 'Ok', start: '2026-09-01T09:00:00+05:30', end: '2026-09-01T09:30:00+05:30', elapsedSeconds: 1800 }
  ]
}));
assert.strictEqual(reversed.sessions.length, 1, 'end<start rejected');
assert.strictEqual(reversed.invalid, 1);

// Open snapshot becomes live data, excluded from sessions.
const withOpen = core.parseLog(JSON.stringify({
  open: { topic: 'Deep work', startedAt: '2026-09-09T10:00:00+05:30', elapsedSeconds: 300, savedAt: '2026-09-09T10:05:00+05:30' },
  sessions: []
}));
assert.strictEqual(withOpen.open.topicKey, 'deep work');
assert.strictEqual(withOpen.open.elapsedSeconds, 300);
assert.strictEqual(withOpen.sessions.length, 0);
assert.strictEqual(withOpen.status, 'empty', 'open snapshot is never counted as finalized');

console.log('dashboard/test.js — all assertions passed');
