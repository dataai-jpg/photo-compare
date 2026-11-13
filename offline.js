/* On-device OCR, text comparison and a save queue so the app works with no connection.
 * Requires vendor/tesseract.min.js (see fetch-vendor.mjs). If it is missing, Offline.ready() is false
 * and the app falls back to Google Drive OCR when online.
 */
(function () {
  'use strict';

  var BASE = new URL('.', location.href).href;
  var CFG = window.APP_CONFIG || {};
  var LANG = 'eng';
  var workerPromise = null;
  var progressCb = null;

  function ready() { return typeof window.Tesseract !== 'undefined'; }

  // ---------- on-device OCR ----------
  var STATUS_TEXT = {
    'loading tesseract core': 'Loading OCR engine',
    'initializing tesseract': 'Starting OCR engine',
    'initializing api': 'Starting OCR engine',
    'loading language traineddata': 'Loading language data',
    'initialized api': 'OCR engine ready',
    'recognizing text': 'Reading text'
  };

  function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = Tesseract.createWorker(LANG, 1, {
      workerPath: BASE + 'vendor/worker.min.js',
      corePath: BASE + 'vendor/',
      langPath: BASE + 'vendor/lang/',
      gzip: true,
      logger: function (m) {
        if (!progressCb || !m || !m.status) return;
        var label = STATUS_TEXT[m.status] || m.status;
        var pct = typeof m.progress === 'number' && m.progress > 0 && m.progress < 1 ? ' ' + Math.round(m.progress * 100) + '%' : '';
        progressCb(label + pct + '...');
      }
    }).catch(function (e) { workerPromise = null; throw e; });
    return workerPromise;
  }

  function recognize(blob) {
    return getWorker().then(function (w) { return w.recognize(blob); })
      .then(function (r) { return (r && r.data && r.data.text) || ''; });
  }

  // ---------- text comparison (same logic as the server) ----------
  function normalize(t) { return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  function levenshtein(a, b) {
    var start = 0, endA = a.length, endB = b.length;
    while (start < endA && start < endB && a[start] === b[start]) start++;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    var lenA = endA - start, lenB = endB - start;
    if (!lenA) return lenB;
    if (!lenB) return lenA;
    var longer = lenA >= lenB ? a : b, shorter = lenA >= lenB ? b : a;
    var n = Math.max(lenA, lenB), m = Math.min(lenA, lenB);
    var prev = new Uint32Array(m + 1), curr = new Uint32Array(m + 1), i, j;
    for (j = 0; j <= m; j++) prev[j] = j;
    for (i = 1; i <= n; i++) {
      curr[0] = i;
      var ci = longer[start + i - 1];
      for (j = 1; j <= m; j++) {
        var cost = ci === shorter[start + j - 1] ? 0 : 1;
        var del = prev[j] + 1, ins = curr[j - 1] + 1, sub = prev[j - 1] + cost;
        curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
      }
      var t = prev; prev = curr; curr = t;
    }
    return prev[m];
  }

  function similarity(a, b) {
    if (!a && !b) return 100;
    if (!a || !b) return 0;
    if (a === b) return 100;
    var sa = a, sb = b;
    if (Math.max(a.length, b.length) > 3000) { sa = a.split(' '); sb = b.split(' '); }
    return Math.max(0, (1 - levenshtein(sa, sb) / Math.max(sa.length, sb.length)) * 100);
  }

  function differences(a, b) {
    var s1 = new Set(a.split(' ').filter(Boolean)), s2 = new Set(b.split(' ').filter(Boolean));
    return {
      onlyInPhoto1: Array.from(s1).filter(function (w) { return !s2.has(w); }),
      onlyInPhoto2: Array.from(s2).filter(function (w) { return !s1.has(w); })
    };
  }

  // prep: [{photo:{fileName}, blob}, {photo:{fileName}, blob}]
  function compare(prep, onProgress) {
    progressCb = onProgress || null;
    var t1;
    return recognize(prep[0].blob).then(function (text) {
      t1 = text;
      if (progressCb) progressCb('Reading second photo...');
      return recognize(prep[1].blob);
    }).then(function (t2) {
      var n1 = normalize(t1), n2 = normalize(t2);
      function info(p, text) {
        var name = p.photo.fileName;
        return { fileId: 'offline', fileName: name, filePath: 'offline/' + name, url: '', extractedText: text };
      }
      return {
        success: true,
        photo1: info(prep[0], t1), photo2: info(prep[1], t2),
        textSimilarity: Number(similarity(n1, n2).toFixed(2)),
        textDifferences: differences(n1, n2),
        message: 'Photos processed on this device.'
      };
    }).then(function (r) { progressCb = null; return r; },
            function (e) { progressCb = null; throw e; });
  }

  // ---------- save queue (IndexedDB) ----------
  var DB_NAME = 'photo-compare', STORE = 'queue';

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE, { keyPath: 'clientId' }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode), store = t.objectStore(STORE), out = fn(store);
        t.oncomplete = function () { db.close(); resolve(out && out.result); };
        t.onerror = t.onabort = function () { db.close(); reject(t.error); };
      });
    });
  }
  function enqueue(payload) {
    return tx('readwrite', function (s) { return s.put({ clientId: payload.clientId, payload: payload, queuedAt: Date.now() }); })
      .then(function () { return refreshBar(); });
  }
  function listQueue() { return tx('readonly', function (s) { return s.getAll(); }).then(function (r) { return r || []; }); }
  function removeItem(id) { return tx('readwrite', function (s) { return s.delete(id); }); }
  function putItem(item) { return tx('readwrite', function (s) { return s.put(item); }); }

  var syncing = false;
  function sync() {
    if (syncing || !navigator.onLine || !CFG.apiUrl || !window.__callServer) return Promise.resolve();
    syncing = true;
    return listQueue().then(function (items) {
      var chain = Promise.resolve(), stop = false;
      items.forEach(function (item) {
        chain = chain.then(function () {
          if (stop) return;
          return window.__callServer('saveComparisonToSheet', item.payload).then(function (r) {
            if (r && r.success) return removeItem(item.clientId);
            item.error = (r && r.message) || 'Save failed.';
            return putItem(item);
          }, function () { stop = true; });
        });
      });
      return chain;
    }).catch(function () {}).then(function () { syncing = false; return refreshBar(); });
  }

  // ---------- UI ----------
  var bar;
  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'display:none;margin-bottom:12px;padding:10px 14px;border-radius:10px;background:#e3f2fd;color:#0d47a1;font-size:.9rem;align-items:center;gap:12px;flex-wrap:wrap';
    var c = document.querySelector('.container');
    c.insertBefore(bar, c.firstChild);
    return bar;
  }
  function refreshBar() {
    return listQueue().then(function (items) {
      var b = ensureBar();
      if (!items.length) { b.style.display = 'none'; return; }
      var failed = items.filter(function (i) { return i.error; }).length;
      b.style.display = 'flex';
      b.textContent = '';
      var span = document.createElement('span');
      span.textContent = items.length + ' comparison' + (items.length > 1 ? 's' : '') + ' waiting to sync' + (failed ? ' (' + failed + ' with errors, will retry)' : '') + '.';
      b.appendChild(span);
      var btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = 'Sync now';
      btn.style.cssText = 'min-height:36px;padding:6px 14px;background:#1565c0;color:#fff';
      btn.disabled = !navigator.onLine;
      btn.onclick = function () { sync(); };
      b.appendChild(btn);
    }).catch(function () {});
  }

  function init() {
    if (ready()) {
      var row = document.getElementById('engineRow');
      if (row && CFG.apiUrl) row.style.display = 'block';
      var off = document.getElementById('offline');
      if (off) off.textContent = 'You are offline. Photos are read on this device and saves are queued until you reconnect.';
    }
    if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) {} }
    refreshBar().then(sync);
    window.addEventListener('online', function () { refreshBar(); sync(); });
    window.addEventListener('offline', refreshBar);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.addEventListener('pagehide', function () {
    if (workerPromise) workerPromise.then(function (w) { return w.terminate(); }).catch(function () {});
  });

  window.Offline = { ready: ready, compare: compare, enqueue: enqueue, sync: sync, pending: function () { return listQueue().then(function (i) { return i.length; }); } };
})();
