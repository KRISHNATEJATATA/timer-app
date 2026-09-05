/* Topic Timer Dashboard — UI layer. All data math lives in core.js. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const core = window.TimerCore;

  // ---- State ---------------------------------------------------------------
  const state = {
    fileHandle: null,
    fileName: '',
    sessions: [],
    open: null,
    invalidCount: 0,
    trendDays: 14,
    trendMode: 'total',
    trendChart: null,
    donutChart: null,
    lastTab: 'topics',
    topicChart: null,
    topicViewKey: null,
    calMode: 'month',
    calAnchor: new Date(),
    calSelected: null,
    // sort state per table: {key, dir}
    sorts: { session: { key: 'start', dir: 1 }, block: { key: 'start', dir: 1 }, topic: { key: 'totalSeconds', dir: -1 } },
    filters: { topic: '', from: '', to: '' }
  };

  // ---- Format helpers ------------------------------------------------------
  const fmtDuration = core.formatDuration;
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDateTime = (ms) => new Date(ms).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const fmtDayLong = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  };

  // ---- Show/hide plumbing --------------------------------------------------
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }

  function showError(title, text) {
    $('error-title').textContent = title;
    $('error-text').textContent = text;
    show('error');
    hide('welcome');
    hide('views');
    hide('stats-cards');
    hide('live-banner');
  }

  function clearError() { hide('error'); }

  // ---- Log loading ---------------------------------------------------------
  async function openPicker() {
    if (!window.showOpenFilePicker) {
      // Firefox/Safari: fall back to a hidden <input type=file>.
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = () => input.files[0] && loadFileObject(input.files[0]);
      input.click();
      return;
    }
    try {
      const picked = await window.showOpenFilePicker({ types: [{ description: 'Topic Timer log', accept: { 'application/json': ['.json'] } }] });
      // Some environments/extensions resolve with a non-array; accept both shapes.
      const handle = Array.isArray(picked) ? picked[0] : (picked && typeof picked.getFile === 'function' ? picked : null);
      if (!handle || typeof handle.getFile !== 'function') {
        throw new Error('The browser did not return a usable file handle. Try dragging the file onto the page instead.');
      }
      state.fileHandle = handle;
      await rememberHandle(handle);
      await readHandle();
    } catch (e) {
      if (e && e.name !== 'AbortError') showError('Could not open file', String(e.message || e));
    }
  }

  // Diagnostic hook (also usable from the console): pass text to skip the picker.
  window.__debugPick = async function (textOverride) {
    const t0 = performance.now();
    try {
      let text;
      if (textOverride != null) {
        text = textOverride;
      } else {
        const [handle] = await window.showOpenFilePicker();
        const file = await handle.getFile();
        text = await file.text();
      }
      window.__dbg = { step: 'gotText', len: text.length, ms: Math.round(performance.now() - t0) };
      await loadText(text);
      window.__dbg = { step: 'loaded', len: text.length, ms: Math.round(performance.now() - t0), sessions: state.sessions.length };
    } catch (e) {
      window.__dbg = { step: 'threw', name: e && e.name, msg: e && e.message, ms: Math.round(performance.now() - t0) };
    }
    return window.__dbg;
  };

  async function readHandle() {
    if (!state.fileHandle) return;
    try {
      const file = await state.fileHandle.getFile();
      state.fileName = file.name;
      await loadText(await file.text());
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        showError('Browser blocked file access',
          'Access to the remembered file was refused — this happens after reopening the browser or when the "Allow" prompt is dismissed. Click "Open log.json…" and pick the file again; Refresh will work from then on.');
      } else {
        showError('Could not read file', String(e.message || e));
      }
    }
  }

  function loadFileObject(file) {
    state.fileHandle = null;
    state.fileName = file.name;
    file.text().then(loadText, (e) => showError('Could not read file', String(e.message || e)));
  }

  async function loadText(text) {
    clearError();
    let parsed;
    try {
      parsed = core.parseLog(text);
    } catch (firstErr) {
      // Retry once (the widget rewrites the file at finalize; a torn read is possible).
      try {
        if (state.fileHandle) {
          const file = await state.fileHandle.getFile();
          parsed = core.parseLog(await file.text());
        } else {
          throw firstErr;
        }
      } catch (secondErr) {
        showError('Log file looks corrupt', 'log.json could not be parsed after a retry. The widget quarantines unparseable logs as log.corrupt.bak and starts fresh — if you just finalized a session, click Refresh.');
        return;
      }
    }
    state.sessions = parsed.sessions;
    state.open = parsed.open;
    state.invalidCount = parsed.invalid;
    $('refresh-btn').disabled = !state.fileHandle;
    $('export-btn').disabled = state.sessions.length === 0;
    $('loaded-from').textContent = state.fileName ? 'Loaded: ' + state.fileName : '';
    render();
  }

  // ---- IndexedDB: remember the file handle ---------------------------------
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('topic-timer-dashboard', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function rememberHandle(handle) {
    try {
      const db = await idb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(handle, 'log');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { /* remembering is best-effort */ }
  }

  async function restoreHandle() {
    if (!window.showOpenFilePicker || !('indexedDB' in window)) return;
    try {
      const db = await idb();
      const handle = await new Promise((resolve, reject) => {
        const tx = db.transaction('handles', 'readonly');
        const req = tx.objectStore('handles').get('log');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (handle) {
        state.fileHandle = handle;
        $('refresh-btn').disabled = false;
        let name = '';
        try { name = (await handle.getFile()).name; } catch (e) { /* permission not granted yet */ }
        $('loaded-from').textContent = name
          ? 'Remembered: ' + name + ' — click Refresh (or Allow) to load'
          : 'Remembered log — click Refresh and allow access to load';
      }
    } catch (e) { /* no stored handle */ }
  }

  async function reverifyHandle() {
    // Chrome ≥122 requires a user gesture to re-acquire a persisted handle.
    if (!state.fileHandle) return false;
    try {
      if ((await state.fileHandle.queryPermission({ mode: 'read' })) !== 'granted') {
        if ((await state.fileHandle.requestPermission({ mode: 'read' })) !== 'granted') return false;
      }
      // Even with permission granted, getFile can throw NotAllowedError on a
      // stale handle; probing it here lets the caller show a useful message.
      await state.fileHandle.getFile();
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- Rendering -----------------------------------------------------------
  function switchView(name) {
    for (const t of $('tabs').children) t.classList.toggle('active', t.dataset.view === name);
    for (const v of document.querySelectorAll('.view')) v.classList.add('hidden');
    show('view-' + name);
    if (name === 'trend') renderTrend();
    if (name === 'calendar') { renderCalendar(); renderDonut(); }
  }

  function render() {
    hide('welcome');
    clearError();
    renderLive();
    renderStats();
    renderTopicViews();
    renderTrend();
    renderCalendar();
    renderDonut();
    renderSessionTable();
    renderBlockTable();
    renderSummaries();
    renderTopicFilter();
    show('views');
    show('stats-cards');
  }

  function renderLive() {
    if (state.open && state.open.topicKey) {
      const name = state.open.topic;
      const mins = state.open.startedAt ? Math.round((Date.now() - state.open.startedAt) / 60000) : null;
      const saved = state.open.elapsedSeconds != null ? ' (' + fmtDuration(state.open.elapsedSeconds) + ' at last save)' : '';
      $('live-text').textContent = 'In progress: ' + name + ' — started ' + (state.open.startedAt ? fmtDateTime(state.open.startedAt) : '?') +
        (mins != null ? ', ~' + mins + ' min ago' : '') + saved + '. Excluded from totals until finalized.';
      show('live-banner');
    } else {
      hide('live-banner');
    }
  }

  function renderStats() {
    const total = state.sessions.reduce((n, s) => n + s.elapsedSeconds, 0);
    const count = state.sessions.length;
    const topics = new Set(state.sessions.map(s => s.topicKey)).size;
    $('stat-total').textContent = fmtDuration(total);
    $('stat-count').textContent = String(count);
    $('stat-avg').textContent = count ? fmtDuration(Math.round(total / count)) : '0:00:00';
    $('stat-topics').textContent = String(topics);
  }

  function renderTopicViews() {
    const topics = core.topicTotals(state.sessions);
    const max = topics.length ? topics[0].totalSeconds : 0;
    const palette = topicColors(state.sessions);
    $('topic-bars').innerHTML = topics.map(t =>
      '<div class="bar-row" data-key="' + esc(t.key) + '" title="View topic detail">' +
      '<div class="bar-name topic-link" data-key="' + esc(t.key) + '" title="' + esc(t.display) + '"><span class="legend-swatch" style="background:' + (palette.get(t.key) || '#4f8cff') + '; display:inline-block; margin-right:6px;"></span>' + esc(t.display) + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + (max ? Math.max(1.5, (t.totalSeconds / max) * 100) : 0) + '%"></div></div>' +
      '<div class="bar-val">' + fmtDuration(t.totalSeconds) + '</div>' +
      '</div>'
    ).join('') || '<p class="hint">No sessions yet.</p>';

    fillTable('topic-table', sortFor('topic', topics), t => [
      '<span class="topic-link" data-key="' + esc(t.key) + '">' + esc(t.display) + '</span>',
      fmtDuration(t.totalSeconds), String(t.sessionCount), fmtDuration(t.avgSeconds)
    ], ['num', 'num', 'num']);
  }

  function renderTopicFilter() {
    const sel = $('filter-topic');
    const current = state.filters.topic;
    const names = core.topicDisplayNames(state.sessions);
    const keys = [...new Set(state.sessions.map(s => s.topicKey))].sort((a, b) =>
      (names.get(a) || a).localeCompare(names.get(b) || b));
    sel.innerHTML = '<option value="">All topics</option>' +
      keys.map(k => '<option value="' + esc(k) + '"' + (k === current ? ' selected' : '') + '>' + esc(names.get(k) || k) + '</option>').join('');
  }

  function filteredSessions() {
    const f = state.filters;
    const from = f.from ? new Date(f.from + 'T00:00:00').getTime() : null;
    const to = f.to ? new Date(f.to + 'T23:59:59.999').getTime() : null;
    return state.sessions.filter(s =>
      (!f.topic || s.topicKey === f.topic) &&
      (from == null || s.end >= from) &&
      (to == null || s.start <= to));
  }

  function renderSessionTable() {
    const rows = sortFor('session', filteredSessions());
    fillTable('session-table', rows, s => [
      fmtDateTime(s.start), fmtTime(s.end), esc(s.topic.trim()), fmtDuration(s.elapsedSeconds)
    ], ['num']);
    const shown = rows.length;
    const totalAll = state.sessions.length;
    $('session-count').textContent = 'Showing ' + shown + ' of ' + totalAll + ' sessions' +
      (state.invalidCount ? ' (' + state.invalidCount + ' malformed skipped)' : '');
  }

  function renderBlockTable() {
    const rows = sortFor('block', core.workBlocks(filteredSessions()));
    fillTable('block-table', rows, b => [
      fmtDateTime(b.start), fmtDateTime(b.end), esc(b.topic), fmtDuration(b.totalSeconds), String(b.sessionCount)
    ], ['num', 'num']);
  }

  function renderSummaries() {
    const daily = core.dailyTotals(state.sessions);
    fillRows('day-table', [...daily.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).reverse(),
      ([day, secs]) => [fmtDayLong(day), fmtDuration(secs)], ['num']);

    const weeks = core.weeklyTotals(daily);
    fillRows('week-table', weeks.slice().reverse(),
      (w) => [w.key, String(w.days), fmtDuration(w.seconds)], ['num', 'num']);

    const months = core.monthlyTotals(daily);
    fillRows('month-table', months.slice().reverse(),
      (mo) => { const [y, m] = mo.key.split('-').map(Number); return [new Date(y, m - 1, 1).toLocaleDateString([], { year: 'numeric', month: 'long' }), fmtDuration(mo.seconds)]; },
      ['num']);
  }

  // ---- Stable topic colors -------------------------------------------------
  // Same topic key → same color, always. First 12 topics draw from a fixed
  // visually-distinct palette (assigned by sorted key order, so assignment is
  // deterministic); anything beyond gets a hash-derived hue.
  const TOPIC_PALETTE = [
    '#4f8cff', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa', '#06b6d4',
    '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#eab308', '#8b5cf6'
  ];

  function hashHue(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return Math.round((h * 137.508) % 360);
  }

  function topicColors(sessions) {
    const keys = [...new Set(sessions.map(s => s.topicKey))].sort();
    const map = new Map();
    keys.forEach((k, i) => {
      map.set(k, i < TOPIC_PALETTE.length ? TOPIC_PALETTE[i] : 'hsl(' + hashHue(k) + ' 62% 62%)');
    });
    return map;
  }

  // ---- Donut chart (Calendar side panel) ------------------------------------
  // Scope follows the calendar: a selected day's topics, else the visible
  // week's (week mode) or month's (month mode). Colors stay global per topic.
  function donutScope() {
    if (state.calSelected) {
      const dayStart = new Date(state.calSelected + 'T00:00:00').getTime();
      return {
        label: fmtDayLong(state.calSelected),
        sessions: state.sessions.filter(s => s.start < dayStart + 86400000 && s.end > dayStart)
      };
    }
    const a = state.calAnchor;
    if (state.calMode === 'week') {
      const ws = new Date(a); ws.setHours(0, 0, 0, 0);
      ws.setDate(ws.getDate() - ((ws.getDay() + 6) % 7));
      const we = ws.getTime() + 7 * 86400000;
      return {
        label: 'Week of ' + ws.toLocaleDateString([], { month: 'short', day: 'numeric' }),
        sessions: state.sessions.filter(s => s.start < we && s.end > ws.getTime())
      };
    }
    const ms = new Date(a.getFullYear(), a.getMonth(), 1).getTime();
    const me = new Date(a.getFullYear(), a.getMonth() + 1, 1).getTime();
    return {
      label: a.toLocaleDateString([], { year: 'numeric', month: 'long' }),
      sessions: state.sessions.filter(s => s.start < me && s.end > ms)
    };
  }

  function renderDonut() {
    const ctx = $('donut-chart');
    if (!ctx) return;
    if (state.donutChart) {
      try { state.donutChart.destroy(); } catch (e) { /* stale instance */ }
      state.donutChart = null;
    }
    if (Chart.getChart(ctx)) Chart.getChart(ctx).destroy();

    const scope = donutScope();
    $('donut-title').textContent = 'By topic — ' + scope.label;

    const topics = core.topicTotals(scope.sessions);
    const legendEl = $('donut-legend');
    if (!topics.length) {
      legendEl.innerHTML = '<p class="hint">No topics tracked in this ' + (state.calSelected ? 'day' : state.calMode) + '.</p>';
      return;
    }
    const palette = topicColors(state.sessions);
    const labels = topics.map(t => t.display);
    const values = topics.map(t => t.totalSeconds);
    const colors = topics.map(t => palette.get(t.key));

    state.donutChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderColor: '#171a21',
          borderWidth: 2,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => ' ' + item.label + ' — ' + fmtDuration(item.parsed)
            }
          }
        }
      }
    });

    const total = values.reduce((a, b) => a + b, 0);
    legendEl.innerHTML = topics.map(t =>
      '<div class="legend-row" style="cursor:pointer" data-key="' + esc(t.key) + '" title="View topic detail">' +
      '<span class="legend-swatch" style="background:' + palette.get(t.key) + '"></span>' +
      '<span class="legend-name">' + esc(t.display) + '</span>' +
      '<span class="legend-val">' + fmtDuration(t.totalSeconds) + ' · ' + Math.round((t.totalSeconds / total) * 100) + '%</span>' +
      '</div>'
    ).join('');
  }

  // ---- Topic detail page ----------------------------------------------------
  function showTopicDetail(key) {
    state.topicViewKey = key;
    renderTopicDetail();
    switchView('topic');
  }

  function renderTopicDetail() {
    const key = state.topicViewKey;
    if (key == null) return;
    const displays = core.topicDisplayNames(state.sessions);
    const display = displays.get(key) || key;
    const color = topicColors(state.sessions).get(key) || '#4f8cff';
    const sessions = state.sessions.filter(s => s.topicKey === key);
    const total = sessions.reduce((n, s) => n + s.elapsedSeconds, 0);
    const allTotal = state.sessions.reduce((n, s) => n + s.elapsedSeconds, 0);
    const longest = sessions.reduce((m, s) => (!m || s.elapsedSeconds > m.elapsedSeconds ? s : m), null);

    $('topic-detail-title').innerHTML =
      '<span class="legend-swatch" style="background:' + color + '; display:inline-block; margin-right:8px;"></span>' + esc(display);

    const stat = (label, value) =>
      '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-value">' + value + '</div></div>';
    $('topic-stat-cards').innerHTML =
      stat('Total time', fmtDuration(total)) +
      stat('Sessions', String(sessions.length)) +
      stat('Avg session', sessions.length ? fmtDuration(Math.round(total / sessions.length)) : '0:00:00') +
      stat('Share of all time', allTotal ? Math.round((total / allTotal) * 100) + '%' : '0%') +
      stat('First activity', sessions.length ? fmtDateTime(Math.min(...sessions.map(s => s.start))) : '—') +
      stat('Last activity', sessions.length ? fmtDateTime(Math.max(...sessions.map(s => s.start))) : '—') +
      stat('Longest session', longest ? fmtDuration(longest.elapsedSeconds) : '0:00:00');

    fillRows('topic-sessions-table', sessions.slice().sort((a, b) => b.start - a.start), s =>
      [fmtDateTime(s.start), fmtTime(s.end), fmtDuration(s.elapsedSeconds)], [2]);

    // Per-topic daily bars for the last 30 days.
    const ctx = $('topic-trend-chart');
    if (state.topicChart) {
      try { state.topicChart.destroy(); } catch (e) { /* stale */ }
      state.topicChart = null;
    }
    if (Chart.getChart(ctx)) Chart.getChart(ctx).destroy();
    const daily = core.dailyTotals(sessions);
    const labels = [];
    const values = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      labels.push(d.toLocaleDateString([], { month: 'short', day: 'numeric' }));
      values.push((daily.get(core.localDayKey(d)) || 0) / 3600);
    }
    state.topicChart = new Chart(ctx, {
      type: 'bar',
      data: { labels: labels, datasets: [{ label: display, data: values, backgroundColor: color, borderRadius: 4 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, ticks: { color: '#8b91a0' }, grid: { color: '#262b36' }, title: { display: true, text: 'hours', color: '#8b91a0' } },
          x: { ticks: { color: '#8b91a0', maxRotation: 0, autoSkip: true }, grid: { display: false } }
        },
        plugins: { legend: { display: false } }
      }
    });
  }

  // Clicking a trend bar (Total mode) jumps to the Calendar section for that day.
  function gotoCalendarDay(key) {
    const [y, m, d] = key.split('-').map(Number);
    if (state.calMode === 'week') state.calAnchor = new Date(y, m - 1, d);
    else state.calAnchor = new Date(y, m - 1, 1);
    state.calSelected = key;
    switchView('calendar');
  }

  const trendClick = {
    // Total mode: the bar has no topic identity, so navigate to that day.
    total: {
      onClick: (e, elements, chart) => {
        // Chart.js can pass an empty elements array on real clicks (hit-test
        // misses on thin bars), so derive the day from the click's position
        // against the category axis — the same data the tooltip uses.
        // Only clicks INSIDE the plot area count.
        const chartArea = chart.chartArea;
        const x = typeof e.x === 'number' ? e.x : (e.native ? e.native.offsetX : null);
        const y = typeof e.y === 'number' ? e.y : (e.native ? e.native.offsetY : null);
        if (x == null || y == null || !state.trendDayKeys || !chart.scales.x || !chartArea) return;
        const width = chartArea.right - chartArea.left;
        if (width <= 0 || x < chartArea.left || x > chartArea.right) return;
        if (y < chartArea.top || y > chartArea.bottom) return;
        const i = Math.min(state.trendDayKeys.length - 1,
          Math.max(0, Math.floor((x - chartArea.left) / (width / state.trendDayKeys.length))));
        gotoCalendarDay(state.trendDayKeys[i]);
      },
      onHover: (e, els) => {
        const chart = e.chart;
        const inside = e.x != null && e.y != null &&
          e.x >= chart.chartArea.left && e.x <= chart.chartArea.right &&
          e.y >= chart.chartArea.top && e.y <= chart.chartArea.bottom;
        e.native.target.style.cursor = inside ? 'pointer' : 'default';
      }
    },
    // Stacked mode: each segment IS a topic, so open that topic's page.
    // Chart.js's own hit-test can return empty on real clicks, so resolve the
    // clicked topic geometrically: column by x, segment by y-span.
    stacked: {
      onClick: (e, elements, chart) => {
        const area = chart.chartArea;
        const x = typeof e.x === 'number' ? e.x : (e.native ? e.native.offsetX : null);
        const y = typeof e.y === 'number' ? e.y : (e.native ? e.native.offsetY : null);
        if (x == null || y == null || !area || !chart.scales.x) return;
        if (y < area.top || y > area.bottom || x < area.left || x > area.right) return;
        const width = area.right - area.left;
        if (width <= 0) return;
        const col = Math.min(chart.data.datasets.length ? state.trendDayKeys.length - 1 : 0,
          Math.max(0, Math.floor((x - area.left) / (width / state.trendDayKeys.length))));
        let topic = null;
        let stackTop = Infinity;
        let stackBottom = -Infinity;
        for (let dsi = 0; dsi < chart.data.datasets.length; dsi++) {
          const el = chart.getDatasetMeta(dsi).data[col];
          if (!el || !(el.base - el.y > 0)) continue;
          stackTop = Math.min(stackTop, el.y);
          stackBottom = Math.max(stackBottom, el.base);
          if (y >= el.y && y <= el.base) topic = chart.data.datasets[dsi].label;
        }
        if (topic == null) {
          if (y < stackTop - 4 || y > stackBottom + 4) return;
          // Empty space within the column's stack: treat as the topmost topic.
          for (let dsi = 0; dsi < chart.data.datasets.length; dsi++) {
            const el = chart.getDatasetMeta(dsi).data[col];
            if (el && el.base - el.y > 0 && Math.abs(el.y - stackTop) < 0.5) { topic = chart.data.datasets[dsi].label; break; }
          }
        }
        if (topic != null) showTopicDetail(topic);
      },
      onHover: (e, els) => {
        const chart = e.chart;
        const inside = e.x != null && e.y != null &&
          e.x >= chart.chartArea.left && e.x <= chart.chartArea.right &&
          e.y >= chart.chartArea.top && e.y <= chart.chartArea.bottom;
        e.native.target.style.cursor = inside ? 'pointer' : 'default';
      }
    }
  };

  // ---- Trend chart ---------------------------------------------------------
  function buildTrendDays(days) {
    const labels = [];
    const keys = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      labels.push(d.toLocaleDateString([], { month: 'short', day: 'numeric' }));
      keys.push(core.localDayKey(d));
    }
    return { labels: labels, keys: keys, today: new Date(today) };
  }

  function renderTrend() {
    const { labels, keys, today } = buildTrendDays(state.trendDays);
    state.trendDayKeys = keys;
    const days = state.trendDays;
    const daily = core.dailyTotals(state.sessions);
    const values = keys.map(k => (daily.get(k) || 0) / 3600);
    const ctx = $('trend-chart');
    if (state.trendChart) {
      try { state.trendChart.destroy(); } catch (e) { /* stale instance */ }
      state.trendChart = null;
    }
    if (Chart.getChart(ctx)) Chart.getChart(ctx).destroy();

    if (state.trendMode === 'stacked') {
      renderTrendStacked(ctx, labels, keys);
      return;
    }

    state.trendChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Hours tracked',
          data: values,
          backgroundColor: 'rgba(79, 140, 255, 0.6)',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, ticks: { color: '#8b91a0' }, grid: { color: '#262b36' }, title: { display: true, text: 'hours', color: '#8b91a0' } },
          x: { ticks: { color: '#8b91a0', maxRotation: 0, autoSkip: true }, grid: { display: false } }
        },
        plugins: { legend: { display: false } },
        onClick: trendClick.total.onClick,
        onHover: trendClick.total.onHover
      }
    });
  }

  /* Stacked per-topic bars: each topic is its own dataset in a fixed color
     (same palette as the donut), so the total bar height still equals the
     day total while showing which topics filled it. */
  function renderTrendStacked(ctx, labels, keys) {
    const days = state.trendDays;
    const palette = topicColors(state.sessions);
    // Topics present in the window, sorted by window total desc (biggest at the base).
    const keysSorted = [...new Set(state.sessions.map(s => s.topicKey))];
    const totalsByKey = new Map();
    const perTopicPerDay = new Map();
    for (const key of keys) {
      for (const k of keysSorted) perTopicPerDay.set(k + '|' + key, 0);
    }
    for (const s of state.sessions) {
      for (const b of core.splitAcrossDays(s.start, s.end, s.elapsedSeconds)) {
        if (!perTopicPerDay.has(s.topicKey + '|' + b.day)) continue;
        perTopicPerDay.set(s.topicKey + '|' + b.day, (perTopicPerDay.get(s.topicKey + '|' + b.day) || 0) + b.seconds);
      }
    }
    for (const k of keysSorted) {
      let total = 0;
      for (const [combo, secs] of perTopicPerDay) if (combo.startsWith(k + '|')) total += secs;
      totalsByKey.set(k, total);
    }
    keysSorted.sort((a, b) => totalsByKey.get(b) - totalsByKey.get(a));

    const datasets = keysSorted.map(k => ({
      label: k,
      data: keys.map(key => (perTopicPerDay.get(k + '|' + key) || 0) / 3600),
      backgroundColor: palette.get(k),
      stack: 'topics',
      borderRadius: 3
    }));

    state.trendChart = new Chart(ctx, {
      type: 'bar',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', axis: 'xy', intersect: true },
        scales: {
          x: { stacked: true, ticks: { color: '#8b91a0', maxRotation: 0, autoSkip: true }, grid: { display: false } },
          y: {
            stacked: true,
            beginAtZero: true,
            ticks: { color: '#8b91a0' },
            grid: { color: '#262b36' },
            title: { display: true, text: 'hours', color: '#8b91a0' }
          }
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#8b91a0', boxWidth: 10, boxHeight: 10 },
            // dataset.label is the topic key — click the legend name for details.
            onClick: (e, item) => { if (item) showTopicDetail(item.text); }
          },
          tooltip: {
            callbacks: {
              label: (item) => ' ' + item.dataset.label + ' — ' + fmtDuration(item.parsed.y * 3600)
            }
          }
        },
        onClick: trendClick.stacked.onClick,
        onHover: trendClick.stacked.onHover
      }
    });
  }

  // ---- Calendar (shadcn/ui calendar port) ----------------------------------
  const CHEVRON_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
  const CHEVRON_RIGHT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

  const DOW_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  function renderCalendar() {
    const daily = core.dailyTotals(state.sessions);
    const anchor = state.calAnchor;
    const wrap = $('calendar');
    const detail = $('cal-day-detail');

    const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const gridStart = new Date(monthStart);
    gridStart.setDate(1 - ((monthStart.getDay() + 6) % 7)); // Monday-start, like the dashboard's ISO weeks

    let weeks;
    let caption;
    if (state.calMode === 'month') {
      caption = anchor.toLocaleDateString([], { year: 'numeric', month: 'long' });
      const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      weeks = [];
      const cursor = new Date(gridStart);
      while (cursor <= monthEnd) {
        weeks.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + 7);
      }
    } else {
      const weekStart = new Date(anchor); weekStart.setHours(0, 0, 0, 0);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
      caption = 'Week ' + core.isoWeekKey(weekStart).split('W')[1] + ' — ' +
        weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' – ' +
        new Date(weekStart.getTime() + 6 * 86400000).toLocaleDateString([], { month: 'short', day: 'numeric' });
      weeks = [weekStart];
    }

    const todayKey = core.localDayKey(new Date());
    const isOutside = (d) => d.getMonth() !== anchor.getMonth() || d.getFullYear() !== anchor.getFullYear();

    const dayCell = (d) => {
      const key = core.localDayKey(d);
      const secs = daily.get(key) || 0;
      const cls = ['cal-day'];
      if (isOutside(d)) cls.push('outside');
      if (key === todayKey) cls.push('today');
      if (state.calSelected === key) cls.push('selected');
      const sub = secs ? '<span class="cal-day-sub">' + esc(fmtDuration(secs).replace(/:00$/, '')) + '</span>' : '';
      return '<button type="button" class="' + cls.join(' ') + '" data-day="' + key + '"' +
        ' data-selected-single="' + (state.calSelected === key) + '"' +
        ' title="' + esc(fmtDayLong(key) + ' — ' + fmtDuration(secs)) + '">' +
        '<span>' + d.getDate() + '</span>' + sub + '</button>';
    };

    const weekRow = (weekStartDate) => {
      const days = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(weekStartDate); d.setDate(weekStartDate.getDate() + i);
        days.push(dayCell(d));
      }
      const wk = state.calMode === 'week'
        ? ''
        : '<div class="cal-weeknum" title="ISO week">' + core.isoWeekKey(weekStartDate).split('W')[1] + '</div>';
      return '<div class="cal-week">' + wk + days.join('') + '</div>';
    };

    wrap.innerHTML =
      '<div class="cal" data-slot="calendar">' +
        '<div class="cal-months">' +
          '<div class="cal-month">' +
            '<div class="cal-nav">' +
              '<button type="button" class="cal-chevron" data-cal="prev" aria-label="Previous">' + CHEVRON_LEFT + '</button>' +
              '<div class="cal-caption"><span class="cal-caption-label">' + esc(caption) + '</span>' +
                '<button type="button" class="cal-today-link" data-cal="today">Today</button></div>' +
              '<button type="button" class="cal-chevron" data-cal="next" aria-label="Next">' + CHEVRON_RIGHT + '</button>' +
            '</div>' +
            '<div class="cal-grid" role="grid">' +
              '<div class="cal-weekdays">' + DOW_LABELS.map(d => '<div class="cal-weekday">' + d + '</div>').join('') + '</div>' +
              weeks.map(weekRow).join('') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    if (state.calSelected) renderDayDetail(state.calSelected);
    else detail.classList.add('hidden');
  }

  function renderDayDetail(key) {
    const dayStart = new Date(key + 'T00:00:00').getTime();
    const dayEnd = dayStart + 86400000;
    const rows = state.sessions
      .filter(s => s.start < dayEnd && s.end > dayStart)
      .sort((a, b) => a.start - b.start);
    const detail = $('cal-day-detail');
    detail.innerHTML = '<h3>' + fmtDayLong(key) + ' — ' + fmtDuration(core.dailyTotals(state.sessions).get(key) || 0) + '</h3>' +
      (rows.length
        ? '<table class="tbl"><tbody>' + rows.map(s =>
            '<tr><td>' + esc(s.topic.trim()) + '</td><td class="muted">' + fmtTime(s.start) + ' – ' + fmtTime(s.end) + '</td><td class="num">' + fmtDuration(s.elapsedSeconds) + '</td></tr>'
          ).join('') + '</tbody></table>'
        : '<p class="hint">No sessions touch this day.</p>');
    detail.classList.remove('hidden');
  }

  // ---- Table plumbing ------------------------------------------------------
  function sortFor(name, rows) {
    const s = state.sorts[name];
    const copy = rows.slice();
    copy.sort((a, b) => {
      let av = a[s.key], bv = b[s.key];
      if (typeof av === 'string' || typeof bv === 'string') {
        av = String(av); bv = String(bv);
        return av.localeCompare(bv) * s.dir;
      }
      return (av - bv) * s.dir;
    });
    return copy;
  }

  function fillTable(tableId, rows, cellFns, numericCols) {
    const table = $(tableId);
    const tbody = table.tBodies[0];
    const nums = new Set(numericCols || []);
    tbody.innerHTML = rows.map(r => {
      const cells = cellFns(r);
      return '<tr>' + cells.map((c, i) => '<td class="' + (nums.has(i) ? 'num' : '') + '">' + c + '</td>').join('') + '</tr>';
    }).join('');
    for (const th of table.tHead.rows[0].cells) {
      const key = th.dataset.sort;
      if (!key) continue;
      const s = state.sorts[tableId.includes('session') ? 'session' : tableId.includes('block') ? 'block' : 'topic'];
      th.textContent = th.textContent.replace(/[▲▼]\s*$/, '').trim() + (s.key === key ? (s.dir > 0 ? ' ▲' : ' ▼') : '');
    }
  }

  function fillRows(tableId, rows, cellFns, numericCols) {
    const table = $(tableId);
    table.tBodies[0].innerHTML = rows.map(r => {
      const cells = cellFns(r);
      return '<tr>' + cells.map((c, i) => '<td class="' + ((numericCols || []).includes(i) ? 'num' : '') + '">' + c + '</td>').join('') + '</tr>';
    }).join('') || '<tr><td colspan="9" class="muted">Nothing tracked yet.</td></tr>';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  // ---- CSV export ----------------------------------------------------------
  function exportCsv() {
    const rows = [['topic', 'start', 'end', 'elapsed_seconds', 'elapsed']];
    const q = (v) => {
      v = String(v);
      return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    for (const s of state.sessions.slice().sort((a, b) => a.start - b.start)) {
      const secs = s.elapsedSeconds;
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), ss = secs % 60;
      rows.push([q(s.topic.trim()), s.startISO, s.endISO, secs, h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0')]);
    }
    const csv = rows.map(r => r.join(',')).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'topic-timer-export.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- Events --------------------------------------------------------------
  $('open-btn').addEventListener('click', openPicker);
  $('export-btn').addEventListener('click', exportCsv);
  $('refresh-btn').addEventListener('click', async () => {
    if (!(await reverifyHandle())) {
      showError('Browser blocked file access',
        'Access to the remembered file needs your approval each browsing session. Click "Open log.json…" and pick the file again (one click — the picker opens in the same folder), then Refresh works normally.');
      return;
    }
    await readHandle();
  });

  document.body.addEventListener('dragover', (e) => e.preventDefault());
  document.body.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadFileObject(file);
  });

  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    if (btn.dataset.view !== 'topic') state.lastTab = btn.dataset.view;
    switchView(btn.dataset.view);
  });

  // Topic links everywhere: topics table/bars, donut legend.
  document.addEventListener('click', (e) => {
    const holder = e.target.closest('.topic-link[data-key], .bar-row[data-key], .legend-row[data-key]');
    if (holder) showTopicDetail(holder.dataset.key);
  });

  $('topic-back').addEventListener('click', () => switchView(state.lastTab));

  $('trend-range').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.trendDays = Number(btn.dataset.days);
    for (const b of $('trend-range').children) b.classList.toggle('active', b === btn);
    renderTrend();
  });

  $('trend-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.trendMode = btn.dataset.mode;
    for (const b of $('trend-mode').children) b.classList.toggle('active', b === btn);
    renderTrend();
  });

  $('cal-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.calMode = btn.dataset.mode;
    for (const b of $('cal-mode').children) b.classList.toggle('active', b === btn);
    renderCalendar();
    renderDonut();
  });

  $('calendar').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-cal]');
    if (nav) {
      const what = nav.dataset.cal;
      if (what === 'prev') {
        if (state.calMode === 'month') state.calAnchor = new Date(state.calAnchor.getFullYear(), state.calAnchor.getMonth() - 1, 1);
        else state.calAnchor = new Date(state.calAnchor.getTime() - 7 * 86400000);
      } else if (what === 'next') {
        if (state.calMode === 'month') state.calAnchor = new Date(state.calAnchor.getFullYear(), state.calAnchor.getMonth() + 1, 1);
        else state.calAnchor = new Date(state.calAnchor.getTime() + 7 * 86400000);
      } else if (what === 'today') {
        state.calAnchor = new Date();
      }
      renderCalendar();
      renderDonut();
      return;
    }
    const cell = e.target.closest('.cal-day[data-day]');
    if (!cell) return;
    const day = cell.dataset.day;
    // Outside days navigate to their month/week (DayPicker behavior); in-month days toggle selection.
    const [y, m, dd] = day.split('-').map(Number);
    if (y !== state.calAnchor.getFullYear() || m - 1 !== state.calAnchor.getMonth() ||
        (state.calMode === 'week' && dd !== state.calAnchor.getDate())) {
      state.calAnchor = state.calMode === 'week' ? new Date(y, m - 1, dd) : new Date(y, m - 1, 1);
      state.calSelected = day;
    } else {
      state.calSelected = state.calSelected === day ? null : day;
    }
    renderCalendar();
    renderDonut();
  });

  for (const [tableId, name] of [['session-table', 'session'], ['block-table', 'block'], ['topic-table', 'topic']]) {
    $(tableId).tHead.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const s = state.sorts[name];
      if (s.key === th.dataset.sort) s.dir = -s.dir;
      else { s.key = th.dataset.sort; s.dir = th.dataset.sort === 'topicDisplay' || th.dataset.sort === 'display' ? 1 : -1; }
      render();
    });
  }

  $('filter-topic').addEventListener('change', (e) => { state.filters.topic = e.target.value; render(); });
  $('filter-from').addEventListener('change', (e) => { state.filters.from = e.target.value; render(); });
  $('filter-to').addEventListener('change', (e) => { state.filters.to = e.target.value; render(); });
  $('filter-clear').addEventListener('click', () => {
    state.filters = { topic: '', from: '', to: '' };
    $('filter-from').value = '';
    $('filter-to').value = '';
    renderTopicFilter();
    render();
  });

  // ---- Boot ----------------------------------------------------------------
  restoreHandle();
})();
