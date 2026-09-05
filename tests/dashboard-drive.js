/* Drives headless Edge through the dashboard and reproduces the user's flow:
   click Open -> real FileSystemHandle -> readHandle -> loadText -> render.
   Diagnostic script; run: node tests/dashboard-drive.js */
'use strict';
const puppeteer = require('puppeteer-core');
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    args: ['--no-first-run', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => console.log('[console:' + m.type() + ']', m.text()));
  page.on('pageerror', e => { errors.push(e); console.log('[pageerror]', e.message); });
  page.on('pageerror', e => console.log('  [stack]', (e.stack || '').split('\n').slice(0, 3).join(' | ')));
  await page.evaluateOnNewDocument(() => {
    window.addEventListener('unhandledrejection', e => {
      console.log('[unhandledrejection]', e.reason && (e.reason.name + ': ' + e.reason.message));
    });
    window.addEventListener('error', e => {
      console.log('[error]', e.message);
    });
  });

  await page.setCacheEnabled(false);
  await page.goto('http://localhost:3177/', { waitUntil: 'networkidle2' });
  console.log('typeof showOpenFilePicker:', await page.evaluate(() => typeof window.showOpenFilePicker));
  console.log('typeof Chart:', await page.evaluate(() => typeof window.Chart));
  console.log('typeof TimerCore:', await page.evaluate(() => typeof window.TimerCore));

  // Build a REAL FileSystemFileHandle for the production log, then let the
  // real openPicker destructure it.
  const realText = fs.readFileSync('C:/Office/temp/timer/data/TopicTimer/log.json', 'utf8');
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'log.json', { type: 'application/json' }));
    return dt.items[0].getAsFileSystemHandle().then(h => {
      window.__mockHandle = h;
      // Simulate the pathological picker shape that breaks naive destructuring.
      window.showOpenFilePicker = async () => ({ 0: h, length: 1 });
    });
  }, realText);

  await page.click('#open-btn');
  await new Promise(r => setTimeout(r, 1500));

  const dbg = await page.evaluate(() => window.__dbg || null);
  console.log('debug pick result:', JSON.stringify(dbg, null, 2));

  // Then the real load path with actual log text, bypassing the picker.
  const parseOnly = await page.evaluate(async (t) => {
    try { window.TimerCore.parseLog(t); return 'ok'; }
    catch (e) { return e.name + ': ' + e.message; }
  }, realText);
  console.log('parse-only:', parseOnly);
  const stages = await page.evaluate((t) => {
    const core = window.TimerCore;
    const s = core.parseLog(t).sessions;
    const out = {};
    const probe = (name, fn) => { try { fn(); out[name] = 'ok'; } catch (e) { out[name] = e.name + ': ' + e.message; } };
    probe('topicTotals', () => core.topicTotals(s));
    probe('dailyTotals', () => core.dailyTotals(s));
    const daily = core.dailyTotals(s);
    probe('workBlocks', () => core.workBlocks(s));
    probe('weeklyTotals', () => core.weeklyTotals(daily));
    probe('monthlyTotals', () => core.monthlyTotals(daily));
    probe('topicDisplayNames', () => core.topicDisplayNames(s));
    probe('splitAcrossDays', () => core.splitAcrossDays(s[0].start, s[0].end, s[0].elapsedSeconds));
    probe('chart', () => new Chart(document.getElementById('trend-chart'), {
      type: 'bar',
      data: { labels: ['a', 'b'], datasets: [{ data: [1, 2] }] }
    }));
    probe('htmlCollectionForOf', () => { for (const x of document.querySelectorAll('table')) void x; });
    return out;
  }, realText);
  console.log('stages:', JSON.stringify(stages, null, 2));
  const realLoad = await page.evaluate((t) => window.__debugPick(t), realText);
  console.log('real-text load:', JSON.stringify(realLoad, null, 2));
  // Refresh path: second load must destroy and recreate the chart cleanly.
  const reload = await page.evaluate((t) => window.__debugPick(t), realText);
  console.log('second load (refresh):', JSON.stringify(reload, null, 2));

  // Calendar (shadcn port): switch to it, check structure, click a day with data.
  await page.click('[data-view="calendar"]');
  await new Promise(r => setTimeout(r, 200));
  const cal = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    return {
      hasRoot: !!q('.cal[data-slot="calendar"]'),
      chevrons: document.querySelectorAll('.cal-chevron').length,
      caption: q('.cal-caption-label') && q('.cal-caption-label').textContent,
      weekdays: [...document.querySelectorAll('.cal-weekday')].map(x => x.textContent).join(''),
      weekRows: document.querySelectorAll('.cal-week').length,
      dayButtons: document.querySelectorAll('.cal-day').length,
      outsideDays: document.querySelectorAll('.cal-day.outside').length,
      todayMarked: !!q('.cal-day.today'),
      weekNumbers: document.querySelectorAll('.cal-weeknum').length,
      daysWithSub: document.querySelectorAll('.cal-day .cal-day-sub').length
    };
  });
  console.log('calendar structure:', JSON.stringify(cal, null, 2));

  const clicked = await page.evaluate(() => {
    const day = document.querySelector('.cal-day .cal-day-sub');
    if (!day) return { skipped: true };
    day.closest('.cal-day').click();
    return {
      selectedNow: !!document.querySelector('.cal-day.selected'),
      detailVisible: !document.getElementById('cal-day-detail').classList.contains('hidden'),
      detailText: document.getElementById('cal-day-detail').textContent.slice(0, 60)
    };
  });
  console.log('day click:', JSON.stringify(clicked));

  // Donut chart: scope follows calendar (month default, day on click, week in week mode).
  const donutCheck = async () => page.evaluate(() => {
    const chart = window.Chart && document.querySelector('#donut-chart') ? Chart.getChart(document.querySelector('#donut-chart')) : null;
    return {
      title: document.getElementById('donut-title').textContent,
      slices: chart ? chart.data.datasets[0].data.length : 0,
      legend: [...document.querySelectorAll('#donut-legend .legend-row .legend-name')].map(x => x.textContent).join(', ')
    };
  });
  console.log('donut (month scope):', JSON.stringify(await donutCheck()));

  await page.evaluate(() => {
    // Normalize to September via the Today link (earlier steps may have navigated away).
    document.querySelector('.cal-today-link').click();
    if (document.querySelector('.cal-day.selected')) document.querySelector('.cal-day.selected').click();
  });
  console.log('month scope (Sep):', JSON.stringify(await donutCheck()));

  await page.evaluate(() => {
    // Deselect any selection from earlier steps, then click Sep 3 (two topics).
    if (document.querySelector('.cal-day.selected')) document.querySelector('.cal-day.selected').click();
    document.querySelector('.cal-day[data-day="2026-09-03"]').click();
  });
  console.log('day scope (Sep 3):', JSON.stringify(await donutCheck()));

  await page.evaluate(() => {
    document.querySelector('.cal-day.selected').click(); // deselect -> back to month
  });
  console.log('month scope again:', JSON.stringify(await donutCheck()));

  await page.evaluate(() => {
    document.querySelector('#cal-mode button[data-mode="week"]').click();
  });
  console.log('week scope (Sep 2026 wk):', JSON.stringify(await donutCheck()));

  await page.evaluate(() => {
    document.querySelector('.cal-day[data-day="2026-09-02"]').click(); // week mode day scope
  });
  console.log('week + day scope (Sep 2):', JSON.stringify(await donutCheck()));

  // Stacked per-topic trend: switch mode, verify datasets stack to day totals.
  await page.evaluate(() => {
    document.querySelector('[data-view="trend"]').click();
    document.querySelector('#trend-mode button[data-mode="stacked"]').click();
  });
  await new Promise(r => setTimeout(r, 300));
  const stacked = await page.evaluate(() => {
    const chart = Chart.getChart(document.getElementById('trend-chart'));
    const ds = chart.data.datasets;
    const sums = chart.data.labels.map((_, i) => ds.reduce((n, d) => n + (d.data[i] || 0), 0));
    return {
      datasets: ds.length,
      names: ds.map(d => d.label).join(', '),
      colorsUnique: new Set(ds.map(d => d.backgroundColor)).size,
      stackedX: chart.options.scales.x.stacked === true,
      stackedY: chart.options.scales.y.stacked === true,
      nonZeroDays: sums.filter(s => s > 0).length,
      maxStackTotal: Math.max(...sums).toFixed(2)
    };
  });
  console.log('stacked trend:', JSON.stringify(stacked, null, 2));

  const totalMode = await page.evaluate(() => {
    document.querySelector('#trend-mode button[data-mode="total"]').click();
    const chart = Chart.getChart(document.getElementById('trend-chart'));
    return { datasets: chart.data.datasets.length };
  });
  console.log('total trend back:', JSON.stringify(totalMode));

  // Trend day click -> calendar section for that day (real mouse click on a bar).
  await page.evaluate(() => {
    document.querySelector('#cal-mode button[data-mode="month"]').click(); // normalize to month mode
    if (document.querySelector('.cal-day.selected')) document.querySelector('.cal-day.selected').click(); // clear stale selection
    document.querySelector('[data-view="trend"]').click();
  });
  // Wait for Chart.js to finish its responsive resize/layout before clicking.
  await page.waitForFunction(() => {
    const c = Chart.getChart(document.getElementById('trend-chart'));
    return c && c.chartArea && c.chartArea.right - c.chartArea.left > 100;
  }, { timeout: 5000 });
  await new Promise(r => setTimeout(r, 400));
  const barPoint = await page.evaluate(() => {
    const canvas = document.getElementById('trend-chart');
    canvas.scrollIntoView({ block: 'center' });
    const chart = Chart.getChart(canvas);
    const meta = chart.getDatasetMeta(0);
    for (let i = 0; i < chart.data.datasets[0].data.length; i++) {
      if ((chart.data.datasets[0].data[i] || 0) > 0 && meta.data[i]) {
        const rect = canvas.getBoundingClientRect();
        // Base of the bar (x-axis line) is always safely inside the bar column.
        return { x: rect.left + meta.data[i].x, y: rect.top + meta.data[i].base - 4, idx: i, base: meta.data[i].base, top: meta.data[i].y };
      }
    }
    return null;
  });
  let trendToCal = { skipped: true };
  if (barPoint) {
    await page.mouse.click(barPoint.x, barPoint.y); // real click 4px above the x-axis: inside the bar
    await new Promise(r => setTimeout(r, 300)); // let Chart.js process the click
    trendToCal = await page.evaluate(() => ({
      calendarVisible: !document.getElementById('view-calendar').classList.contains('hidden'),
      donutTitle: document.getElementById('donut-title').textContent,
      selectedDay: document.querySelector('.cal-day.selected') ? document.querySelector('.cal-day.selected').dataset.day : null
    }));
  }
  console.log('trend->calendar:', JSON.stringify(trendToCal));

  // Topic detail: REAL click on a topic bar-name (the "Total time per topic" card).
  const topicDetail = await page.evaluate(() => {
    document.querySelector('[data-view="topics"]').click();
    return true;
  });
  await new Promise(r => setTimeout(r, 150));
  const barNamePoint = await page.evaluate(() => {
    const el = document.querySelector('.bar-name.topic-link');
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + 20, y: r.top + r.height / 2 };
  });
  await page.mouse.click(barNamePoint.x, barNamePoint.y);
  const topicDetailState = await page.evaluate(() => ({
    viewVisible: !document.getElementById('view-topic').classList.contains('hidden'),
    title: document.getElementById('topic-detail-title').textContent,
    sessionRows: document.querySelectorAll('#topic-sessions-table tbody tr').length
  }));
  console.log('bar-name -> topic detail:', JSON.stringify(topicDetailState));

  const back = await page.evaluate(() => {
    document.getElementById('topic-back').click();
    return {
      backTo: [...document.querySelectorAll('.tab')].find(t => t.classList.contains('active')).dataset.view,
      topicsVisible: !document.getElementById('view-topics').classList.contains('hidden')
    };
  });
  console.log('back:', JSON.stringify(back));

  // REAL click on the topics TABLE link too.
  const tableLinkPoint = await page.evaluate(() => {
    const el = document.querySelector('#topic-table .topic-link');
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + 10, y: r.top + r.height / 2 };
  });
  await page.mouse.click(tableLinkPoint.x, tableLinkPoint.y);
  const tableLinkState = await page.evaluate(() => ({
    viewVisible: !document.getElementById('view-topic').classList.contains('hidden')
  }));
  console.log('table link -> topic detail:', JSON.stringify(tableLinkState));
  await page.evaluate(() => document.getElementById('topic-back').click());

  // Stacked mode: click the "6177 pr review" SEGMENT on Sep 3's bar -> topic page.
  // (Compute coordinates AFTER the tab switch settles, to avoid stale-viewport clicks.)
  await page.evaluate(() => {
    document.querySelector('[data-view="trend"]').click();
    document.querySelector('#trend-mode button[data-mode="stacked"]').click();
  });
  await page.waitForFunction(() => {
    const c = Chart.getChart(document.getElementById('trend-chart'));
    return c && c.chartArea && c.chartArea.right - c.chartArea.left > 100;
  }, { timeout: 5000 });
  await new Promise(r => setTimeout(r, 300));
  const segmentPoint = await page.evaluate(() => {
    const canvas = document.getElementById('trend-chart');
    canvas.scrollIntoView({ block: 'center' });
    const chart = Chart.getChart(canvas);
    const dsi = chart.data.datasets.findIndex(d => d.label === '6177 pr review');
    if (dsi < 0) return null;
    const meta = chart.getDatasetMeta(dsi);
    const li = chart.data.labels.findIndex(l => /3\s+Sep|Sep\s+3/.test(l));
    if (li < 0 || !meta.data[li]) return null;
    const el = meta.data[li];
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + el.x, y: rect.top + (el.y + el.base) / 2 }; // middle of the segment
  });
  await page.mouse.click(segmentPoint.x, segmentPoint.y);
  await new Promise(r => setTimeout(r, 300));
  const segmentNav = await page.evaluate(() => ({
    topicPageVisible: !document.getElementById('view-topic').classList.contains('hidden'),
    title: document.getElementById('topic-detail-title').textContent.trim(),
    calendarHidden: document.getElementById('view-calendar').classList.contains('hidden'),
    trendHidden: document.getElementById('view-trend').classList.contains('hidden'),
    activeTab: (document.querySelector('.tab.active') || {}).dataset ? document.querySelector('.tab.active').dataset.view : null,
    allViews: [...document.querySelectorAll('.view')].map(v => v.id + '=' + (v.classList.contains('hidden') ? 'h' : 'V')).join(' ')
  }));
  console.log('segment -> topic page:', JSON.stringify(segmentNav));

  const outside = await page.evaluate(() => {
    const cell = document.querySelector('.cal-day.outside');
    if (!cell) return { skipped: true };
    const before = document.querySelector('.cal-caption-label').textContent;
    cell.click();
    return { before, after: document.querySelector('.cal-caption-label').textContent };
  });
  console.log('outside-day nav:', JSON.stringify(outside));

  const state = await page.evaluate(() => {
    const err = document.getElementById('error');
    return {
      errorVisible: !err.classList.contains('hidden'),
      errorTitle: document.getElementById('error-title').textContent,
      errorText: document.getElementById('error-text').textContent,
      viewsVisible: !document.getElementById('views').classList.contains('hidden'),
      statTotal: document.getElementById('stat-total').textContent,
      sessionRows: document.querySelectorAll('#session-table tbody tr').length,
      topicRows: document.querySelectorAll('#topic-table tbody tr').length
    };
  });
  console.log('after open+pick:', JSON.stringify(state, null, 2));
  console.log('pageerrors captured:', errors.length);
  for (const e of errors) console.log('  -', e.name + ':', e.message, '\n    ', (e.stack || '').split('\n')[1]);
  await browser.close();
})().catch(e => { console.error('driver failed:', e); process.exit(1); });
