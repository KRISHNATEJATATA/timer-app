(function (global) {
  'use strict';

  var CAP_SECONDS = 12 * 60 * 60;

  function normalizeTopic(raw) {
    return String(raw == null ? '' : raw).trim();
  }

  function sameTopic(a, b) {
    return normalizeTopic(a).toLowerCase() === normalizeTopic(b).toLowerCase();
  }

  function computeElapsed(baseElapsedSec, baseAtMs, nowMs, paused) {
    if (paused) return baseElapsedSec;
    if (nowMs <= baseAtMs) return baseElapsedSec;
    return baseElapsedSec + (nowMs - baseAtMs) / 1000;
  }

  function fmtHMS(totalSeconds) {
    var s = Math.max(0, Math.floor(totalSeconds));
    var h = Math.floor(s / 3600);
    s -= h * 3600;
    var m = Math.floor(s / 60);
    s -= m * 60;
    function pad(n) { return String(n).padStart(2, '0'); }
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }

  function shouldAutoPause(elapsedSec, capTriggered, capSeconds) {
    var cap = capSeconds == null ? CAP_SECONDS : capSeconds;
    return !capTriggered && elapsedSec >= cap;
  }

  function localIso(date) {
    var d = date instanceof Date ? date : new Date(date);
    function pad(n) { return String(Math.abs(n)).padStart(2, '0'); }
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    var offH = Math.floor(Math.abs(off) / 60);
    var offM = Math.abs(off) % 60;
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
      sign + pad(offH) + ':' + pad(offM)
    );
  }

  function parseManualDateTime(value) {
    var s = String(value == null ? '' : value).trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
    var ms = Date.parse(s);
    if (isNaN(ms)) return null;
    var d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  function manualSessionError(topic, startValue, endValue, capSeconds, nowMs) {
    if (normalizeTopic(topic) === '') return 'Enter a topic name.';
    var start = parseManualDateTime(startValue);
    if (!start) return 'Pick a valid start date and time.';
    var end = parseManualDateTime(endValue);
    if (!end) return 'Pick a valid end date and time.';
    if (end.getTime() <= start.getTime()) return 'End must be after the start.';
    var now = nowMs == null ? Date.now() : nowMs;
    if (end.getTime() > now + 60000) return 'End cannot be in the future.';
    var cap = capSeconds == null ? CAP_SECONDS : capSeconds;
    if ((end.getTime() - start.getTime()) / 1000 > cap) {
      return 'Longer than the 12h cap \u2014 split it into sessions.';
    }
    return null;
  }

  function csvEscape(value) {
    var s = String(value == null ? '' : value);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function sessionsToCsv(sessions) {
    var lines = ['topic,start,end,elapsed_seconds,elapsed'];
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      lines.push([
        csvEscape(s.topic),
        csvEscape(s.start),
        csvEscape(s.end),
        String(s.elapsedSeconds),
        csvEscape(fmtHMS(s.elapsedSeconds))
      ].join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  var TopicCore = {
    CAP_SECONDS: CAP_SECONDS,
    normalizeTopic: normalizeTopic,
    sameTopic: sameTopic,
    computeElapsed: computeElapsed,
    fmtHMS: fmtHMS,
    shouldAutoPause: shouldAutoPause,
    localIso: localIso,
    parseManualDateTime: parseManualDateTime,
    manualSessionError: manualSessionError,
    csvEscape: csvEscape,
    sessionsToCsv: sessionsToCsv
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TopicCore;
  } else {
    global.TopicCore = TopicCore;
  }
})(typeof window !== 'undefined' ? window : this);
