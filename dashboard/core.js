/* Topic Timer Dashboard — pure logic. Loaded by the browser (global TimerCore)
   and by Node tests (module.exports). No DOM, no I/O. */
(function (root) {
  'use strict';

  const WORK_BLOCK_GAP_SECONDS = 15 * 60;

  function topicKey(topic) {
    return String(topic == null ? '' : topic).trim().toLowerCase();
  }

  /* Parse the raw log text. Returns
     { status: 'ok'|'empty', sessions: [...], open: {...}|null, invalid: n }
     or throws on unparseable JSON after the caller's retry. */
  function parseLog(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('corrupt');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('corrupt');
    }
    const out = { status: 'empty', sessions: [], open: null, invalid: 0 };
    const raw = Array.isArray(data.sessions) ? data.sessions : [];
    for (const s of raw) {
      if (!s || typeof s !== 'object') {
        out.invalid += 1;
        continue;
      }
      const start = Date.parse(s.start);
      const end = Date.parse(s.end);
      const elapsed = Number(s.elapsedSeconds);
      if (
        typeof s.topic === 'string' && s.topic.trim() !== '' &&
        Number.isFinite(start) && Number.isFinite(end) &&
        end >= start &&
        Number.isFinite(elapsed) && elapsed >= 0
      ) {
        out.sessions.push({
          topic: s.topic,
          topicKey: topicKey(s.topic),
          start: start,
          end: end,
          startISO: s.start,
          endISO: s.end,
          elapsedSeconds: Math.round(elapsed)
        });
      } else {
        out.invalid += 1;
      }
    }
    out.sessions.sort((a, b) => a.start - b.start);
    if (out.sessions.length > 0) out.status = 'ok';

    if (data.open && typeof data.open === 'object' && typeof data.open.topic === 'string') {
      const startedAt = Date.parse(data.open.startedAt);
      const openElapsed = Number(data.open.elapsedSeconds);
      out.open = {
        topic: data.open.topic,
        topicKey: topicKey(data.open.topic),
        startedAt: Number.isFinite(startedAt) ? startedAt : null,
        elapsedSeconds: Number.isFinite(openElapsed) && openElapsed >= 0 ? Math.round(openElapsed) : null,
        savedAt: Date.parse(data.open.savedAt) || null
      };
    }
    return out;
  }

  /* Canonical display casing per topic: the casing of the most recent
     session (latest start). key -> display string. */
  function topicDisplayNames(sessions) {
    const map = new Map();
    for (const s of sessions) {
      const prev = map.get(s.topicKey);
      if (!prev || s.start >= prev.start) map.set(s.topicKey, { start: s.start, display: s.topic.trim() });
    }
    const display = new Map();
    for (const [k, v] of map) display.set(k, v.display);
    return display;
  }

  /* Per-topic totals, ranked by total time. */
  function topicTotals(sessions) {
    const displays = topicDisplayNames(sessions);
    const map = new Map();
    for (const s of sessions) {
      let t = map.get(s.topicKey);
      if (!t) {
        t = { key: s.topicKey, display: displays.get(s.topicKey), totalSeconds: 0, sessionCount: 0 };
        map.set(s.topicKey, t);
      }
      t.totalSeconds += s.elapsedSeconds;
      t.sessionCount += 1;
    }
    const list = [...map.values()];
    for (const t of list) t.avgSeconds = t.sessionCount ? Math.round(t.totalSeconds / t.sessionCount) : 0;
    list.sort((a, b) => b.totalSeconds - a.totalSeconds || a.display.localeCompare(b.display));
    return list;
  }

  /* Split one session's elapsedSeconds across the LOCAL days it covers.
     Proportional to wall-clock overlap; the last day absorbs rounding so the
     sum is exactly elapsedSeconds (elapsedSeconds is authoritative). */
  function splitAcrossDays(start, end, elapsedSeconds) {
    const buckets = [];
    if (!(end > start)) {
      const d = localDayKey(new Date(start));
      buckets.push({ day: d, seconds: elapsedSeconds });
      return buckets;
    }
    const wall = end - start;
    const DAY = 86400000;
    // First day boundary after start, local midnight.
    const firstMid = new Date(start);
    firstMid.setHours(0, 0, 0, 0);
    firstMid.setDate(firstMid.getDate() + 1);
    const spans = [];
    let cursor = start;
    let boundary = firstMid.getTime();
    while (boundary < end) {
      spans.push([cursor, boundary]);
      cursor = boundary;
      boundary += DAY;
    }
    spans.push([cursor, end]);
    let used = 0;
    for (let i = 0; i < spans.length; i++) {
      const [s, e] = spans[i];
      const key = localDayKey(new Date(s));
      let secs;
      if (i === spans.length - 1) {
        secs = elapsedSeconds - used;
      } else {
        secs = Math.round(((e - s) / wall) * elapsedSeconds);
        used += secs;
      }
      const existing = buckets.find(b => b.day === key);
      if (existing) existing.seconds += secs;
      else buckets.push({ day: key, seconds: secs });
    }
    return buckets;
  }

  /* Local-day buckets: Map 'YYYY-MM-DD' -> seconds. */
  function dailyTotals(sessions) {
    const map = new Map();
    for (const s of sessions) {
      for (const b of splitAcrossDays(s.start, s.end, s.elapsedSeconds)) {
        map.set(b.day, (map.get(b.day) || 0) + b.seconds);
      }
    }
    return map;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function localDayKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  /* Group sessions into Work Blocks: consecutive sessions on the same topic
     separated only by gaps <= WORK_BLOCK_GAP_SECONDS. */
  function workBlocks(sessions) {
    const blocks = [];
    let cur = null;
    for (const s of sessions) {
      if (cur && cur.topicKey === s.topicKey && (s.start - cur.lastEnd) <= WORK_BLOCK_GAP_SECONDS * 1000) {
        cur.lastEnd = Math.max(cur.lastEnd, s.end);
        cur.totalSeconds += s.elapsedSeconds;
        cur.sessionCount += 1;
      } else {
        if (cur) blocks.push(cur);
        cur = {
          topicKey: s.topicKey,
          topic: s.topic.trim(),
          start: s.start,
          lastEnd: s.end,
          end: s.end,
          totalSeconds: s.elapsedSeconds,
          sessionCount: 1
        };
      }
    }
    if (cur) blocks.push(cur);
    return blocks;
  }

  /* ISO week (Monday-start) key + label for a date. */
  function isoWeek(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); // nearest Thursday
    const week1 = new Date(d.getFullYear(), 0, 4);
    const week = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
    return { year: d.getFullYear(), week: week };
  }

  function isoWeekKey(date) {
    const w = isoWeek(date);
    return w.year + '-W' + pad2(w.week);
  }

  /* Weekly totals from daily buckets: sorted [{key, label, seconds, days}]. */
  function weeklyTotals(daily) {
    const map = new Map();
    for (const [day, seconds] of daily) {
      const [y, m, d] = day.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      const key = isoWeekKey(date);
      let w = map.get(key);
      if (!w) {
        w = { key: key, seconds: 0, days: 0 };
        map.set(key, w);
      }
      w.seconds += seconds;
      w.days += 1;
    }
    return [...map.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([key, w]) => ({ key: key, seconds: w.seconds, days: w.days }));
  }

  /* Monthly totals: 'YYYY-MM'. */
  function monthlyTotals(daily) {
    const map = new Map();
    for (const [day, seconds] of daily) {
      const key = day.slice(0, 7);
      map.set(key, (map.get(key) || 0) + seconds);
    }
    return [...map.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([key, seconds]) => ({ key: key, seconds: seconds }));
  }

  function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h + ':' + pad2(m) + ':' + pad2(sec);
  }

  const TimerCore = {
    WORK_BLOCK_GAP_SECONDS: WORK_BLOCK_GAP_SECONDS,
    topicKey: topicKey,
    parseLog: parseLog,
    topicDisplayNames: topicDisplayNames,
    topicTotals: topicTotals,
    splitAcrossDays: splitAcrossDays,
    dailyTotals: dailyTotals,
    workBlocks: workBlocks,
    weeklyTotals: weeklyTotals,
    monthlyTotals: monthlyTotals,
    formatDuration: formatDuration,
    localDayKey: localDayKey,
    isoWeekKey: isoWeekKey
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = TimerCore;
  else root.TimerCore = TimerCore;
})(this);
