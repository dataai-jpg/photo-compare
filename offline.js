/* On-device OCR, text comparison, saved records and a sync queue so the app works with no connection.
 * Requires vendor/tesseract.min.js for on-device OCR (see fetch-vendor.mjs). Records work without it.
 */
(function () {
  'use strict';

  var BASE = new URL('.', location.href).href;
  var CFG = window.APP_CONFIG || {};
  var LANG = 'eng';
  var workerPromise = null;
  var progressCb = null;

  function ready() { return typeof window.Tesseract !== 'undefined'; }

  // ================= on-device OCR =================
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

  // ================= text comparison (same logic as the server) =================
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

  // ================= records store (IndexedDB) =================
  // record: { clientId, payload, status: 'pending'|'synced'|'error', savedAt, syncedAt, error, thumbs }
  var DB_NAME = 'photo-compare', DB_VER = 2, STORE = 'records';

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result, t = req.transaction;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'clientId' });
        if (db.objectStoreNames.contains('queue')) {          // migrate v1 queue
          var rs = t.objectStore(STORE);
          t.objectStore('queue').openCursor().onsuccess = function (e) {
            var c = e.target.result;
            if (c) {
              rs.put({ clientId: c.value.clientId, payload: c.value.payload, status: 'pending', savedAt: c.value.queuedAt || Date.now() });
              c.continue();
            } else { db.deleteObjectStore('queue'); }
          };
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode), out = fn(t.objectStore(STORE));
        t.oncomplete = function () { db.close(); resolve(out && out.result); };
        t.onerror = t.onabort = function () { db.close(); reject(t.error); };
      });
    });
  }
  function listRecords() {
    return tx('readonly', function (s) { return s.getAll(); }).then(function (r) {
      return (r || []).sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
    });
  }
  function putRecord(rec) { return tx('readwrite', function (s) { return s.put(rec); }); }
  function removeRecord(id) { return tx('readwrite', function (s) { return s.delete(id); }); }

  function addRecord(payload, status, thumbs) {
    var rec = {
      clientId: payload.clientId, payload: payload, status: status,
      savedAt: Date.now(), syncedAt: status === 'synced' ? Date.now() : null, thumbs: thumbs || null
    };
    return putRecord(rec).then(refreshAll);
  }
  function enqueue(payload, thumbs) { return addRecord(payload, 'pending', thumbs); }

  // ================= sync =================
  var syncing = false;
  function sync() {
    if (syncing || !navigator.onLine || !CFG.apiUrl || !window.__callServer) return Promise.resolve();
    syncing = true;
    return listRecords().then(function (items) {
      var chain = Promise.resolve(), stop = false;
      items.filter(function (r) { return r.status !== 'synced'; }).reverse().forEach(function (rec) {
        chain = chain.then(function () {
          if (stop) return;
          return window.__callServer('saveComparisonToSheet', rec.payload).then(function (r) {
            if (r && r.success) { rec.status = 'synced'; rec.syncedAt = Date.now(); rec.error = null; }
            else { rec.status = 'error'; rec.error = (r && r.message) || 'Save failed.'; }
            return putRecord(rec);
          }, function () { stop = true; });
        });
      });
      return chain;
    }).catch(function () {}).then(function () { syncing = false; return refreshAll(); });
  }

  // ================= UI =================
  var STYLE = [
    '.tabs{display:flex;gap:6px;margin:0 0 16px;padding:4px;background:var(--surface);border:1px solid var(--border);border-radius:12px}',
    '.tabs button{flex:1;background:transparent;color:var(--muted);min-height:44px;padding:8px 12px;border-radius:9px}',
    '.tabs button[aria-selected="true"]{background:var(--primary);color:#fff}',
    '.badge{display:inline-block;min-width:20px;padding:0 6px;margin-left:6px;border-radius:10px;background:#e65100;color:#fff;font-size:.75rem;line-height:20px}',
    '.badge:empty,.badge[data-n="0"]{display:none}',
    '.rec-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:12px}',
    '.rec-head h2{margin:0}',
    '.chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}',
    '.chip{min-height:38px;padding:6px 14px;border-radius:999px;background:var(--surface2);color:var(--text);border:1px solid var(--border)}',
    '.chip[aria-pressed="true"]{background:var(--primary);color:#fff;border-color:var(--primary)}',
    '.rec{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;padding:14px;margin-bottom:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface2)}',
    '.rec-thumbs{display:flex;gap:6px;grid-row:span 3}',
    '.rec-thumbs img,.rec-thumbs i{width:56px;height:56px;border-radius:8px;object-fit:cover;background:var(--border);display:block}',
    '.rec-top{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}',
    '.rec-time{color:var(--muted);font-size:.8rem}',
    '.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.78rem;font-weight:700}',
    '.pill.pending{background:#fff3e0;color:#e65100}.pill.synced{background:var(--ok-bg);color:var(--ok)}.pill.error{background:var(--err-bg);color:var(--err)}',
    '.rec-scores{font-weight:600}',
    '.rec-names{color:var(--muted);font-size:.8rem;overflow-wrap:anywhere}',
    '.rec details{grid-column:1/-1;margin-top:4px}',
    '.rec summary{cursor:pointer;min-height:32px;color:var(--primary);font-weight:600}',
    '.rec .pre{margin-top:8px}',
    '.rec-del{grid-column:1/-1;justify-self:end;min-height:36px;padding:4px 12px;background:transparent;color:var(--err);border:1px solid var(--border)}',
    '.empty{padding:28px 10px;text-align:center;color:var(--muted)}',
    '@media (max-width:640px){.rec{grid-template-columns:1fr}.rec-thumbs{grid-row:auto}}'
  ].join('\n');

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] === null || attrs[k] === undefined) return;
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'class') el.className = attrs[k];
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }

  var ui = {}, filter = 'all', bar;

  function fmtDate(ms) {
    try { return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return new Date(ms).toLocaleString(); }
  }
  function pct(n) { return Number(n || 0).toFixed(1) + '%'; }

  function recordCard(r) {
    var p = r.payload || {};
    var label = r.status === 'synced' ? 'Synced' : (r.status === 'error' ? 'Sync error' : 'Not synced');
    var when = r.status === 'synced' && r.syncedAt ? 'Synced ' + fmtDate(r.syncedAt) : 'Saved ' + fmtDate(r.savedAt);

    var thumbs = h('div', { class: 'rec-thumbs' }, [0, 1].map(function (i) {
      var src = r.thumbs && r.thumbs[i];
      return src ? h('img', { src: src, alt: 'Photo ' + (i + 1) + ' thumbnail' }) : h('i', {});
    }));

    var diffText = 'Only in Photo 1: ' + ((p.onlyInPhoto1 || []).join(', ') || '-') +
                   '\nOnly in Photo 2: ' + ((p.onlyInPhoto2 || []).join(', ') || '-');
    var details = h('details', {}, [
      h('summary', { text: 'Details' }),
      h('div', { class: 'pre', text: 'Photo 1 text:\n' + ((p.photo1 && p.photo1.extractedText) || 'No text detected.') +
        '\n\nPhoto 2 text:\n' + ((p.photo2 && p.photo2.extractedText) || 'No text detected.') + '\n\n' + diffText }),
      r.error ? h('div', { class: 'status error', style: 'display:block', text: r.error }) : null
    ]);

    return h('article', { class: 'rec' }, [
      thumbs,
      h('div', { class: 'rec-top' }, [h('span', { class: 'pill ' + r.status, text: label }), h('span', { class: 'rec-time', text: when })]),
      h('div', { class: 'rec-scores', text: 'Overall ' + pct(p.overallSimilarity) + '  |  Text ' + pct(p.textSimilarity) + '  |  Color ' + pct(p.colorSimilarity) }),
      h('div', { class: 'rec-names', text: ((p.photo1 && p.photo1.fileName) || '?') + '  vs  ' + ((p.photo2 && p.photo2.fileName) || '?') }),
      details,
      h('button', { class: 'rec-del', type: 'button', text: 'Delete', onclick: function () {
        if (r.status !== 'synced' && !confirm('This record has not synced yet. Delete it anyway?')) return;
        removeRecord(r.clientId).then(refreshAll);
      } })
    ]);
  }

  function renderRecords(all) {
    var pending = all.filter(function (r) { return r.status !== 'synced'; });
    var synced = all.filter(function (r) { return r.status === 'synced'; });

    ui.badge.textContent = pending.length ? String(pending.length) : '';
    ui.badge.setAttribute('data-n', String(pending.length));

    var counts = { all: all.length, pending: pending.length, synced: synced.length };
    ui.chips.forEach(function (c) {
      var k = c.getAttribute('data-f');
      c.textContent = { all: 'All', pending: 'Not synced', synced: 'Synced' }[k] + ' (' + counts[k] + ')';
      c.setAttribute('aria-pressed', String(filter === k));
    });
    ui.syncBtn.disabled = !navigator.onLine || !CFG.apiUrl || !pending.length;
    ui.clearBtn.disabled = !synced.length;

    var shown = filter === 'pending' ? pending : (filter === 'synced' ? synced : all);
    ui.list.textContent = '';
    if (!shown.length) {
      ui.list.appendChild(h('div', { class: 'empty', text: all.length ? 'No records in this filter.' : 'No saved comparisons yet. Compare two photos and tap Save.' }));
    } else {
      shown.forEach(function (r) { ui.list.appendChild(recordCard(r)); });
    }
  }

  function renderBar(all) {
    var pending = all.filter(function (r) { return r.status !== 'synced'; });
    if (!pending.length) { bar.style.display = 'none'; return; }
    var failed = pending.filter(function (r) { return r.status === 'error'; }).length;
    bar.style.display = 'flex';
    bar.textContent = '';
    bar.appendChild(h('span', { text: pending.length + ' comparison' + (pending.length > 1 ? 's' : '') + ' waiting to sync' + (failed ? ' (' + failed + ' with errors, will retry)' : '') + '.' }));
    bar.appendChild(h('button', { type: 'button', text: 'Sync now', disabled: navigator.onLine ? null : 'disabled',
      style: 'min-height:36px;padding:6px 14px;background:#1565c0;color:#fff', onclick: sync }));
  }

  function refreshAll() {
    return listRecords().then(function (all) { renderRecords(all); renderBar(all); }).catch(function () {});
  }

  function show(view) {
    var rec = view === 'records';
    ui.compareView.hidden = rec;
    ui.recordsView.hidden = !rec;
    ui.tabCompare.setAttribute('aria-selected', String(!rec));
    ui.tabRecords.setAttribute('aria-selected', String(rec));
    if (rec) refreshAll();
    if (location.hash !== (rec ? '#records' : '')) {
      try { history.replaceState(null, '', rec ? '#records' : location.pathname + location.search); } catch (e) {}
    }
  }

  function buildUi() {
    var style = document.createElement('style'); style.textContent = STYLE; document.head.appendChild(style);

    var container = document.querySelector('.container');
    var header = container.querySelector('.header');

    // bar for pending count (visible on both tabs)
    bar = h('div', { role: 'status', style: 'display:none;margin-bottom:12px;padding:10px 14px;border-radius:10px;background:#e3f2fd;color:#0d47a1;font-size:.9rem;align-items:center;gap:12px;flex-wrap:wrap' });

    // move the existing compare UI into its own view
    ui.compareView = h('div', { id: 'compareView' });
    Array.prototype.slice.call(container.children).forEach(function (el) {
      if (el !== header && el.id !== 'offline') ui.compareView.appendChild(el);
    });

    ui.badge = h('span', { class: 'badge', 'data-n': '0' });
    ui.tabCompare = h('button', { type: 'button', role: 'tab', 'aria-selected': 'true', text: 'Compare', onclick: function () { show('compare'); } });
    ui.tabRecords = h('button', { type: 'button', role: 'tab', 'aria-selected': 'false', onclick: function () { show('records'); } },
      [document.createTextNode('Records'), ui.badge]);
    var tabs = h('nav', { class: 'tabs', role: 'tablist' }, [ui.tabCompare, ui.tabRecords]);

    ui.chips = ['all', 'pending', 'synced'].map(function (f) {
      return h('button', { type: 'button', class: 'chip', 'data-f': f, 'aria-pressed': 'false', onclick: function () { filter = f; refreshAll(); } });
    });
    ui.syncBtn = h('button', { type: 'button', class: 'primary', text: 'Sync now', onclick: sync });
    ui.clearBtn = h('button', { type: 'button', class: 'ghost', text: 'Clear synced', onclick: function () {
      if (!confirm('Remove all synced records from this device? They stay in Google Sheets.')) return;
      listRecords().then(function (all) {
        return Promise.all(all.filter(function (r) { return r.status === 'synced'; }).map(function (r) { return removeRecord(r.clientId); }));
      }).then(refreshAll);
    } });
    ui.list = h('div', {});
    ui.recordsView = h('div', { id: 'recordsView', hidden: 'hidden' }, [
      h('section', { class: 'card' }, [
        h('div', { class: 'rec-head' }, [h('h2', { class: 'section-title', text: 'Saved records' }), h('div', { class: 'row', style: 'margin:0' }, [ui.syncBtn, ui.clearBtn])]),
        h('div', { class: 'chips' }, ui.chips),
        ui.list,
        h('p', { class: 'note', text: 'Records are stored on this device. Synced records are also in your Google Sheet.' })
      ])
    ]);

    header.insertAdjacentElement('afterend', bar);
    bar.insertAdjacentElement('afterend', tabs);
    tabs.insertAdjacentElement('afterend', ui.compareView);
    ui.compareView.insertAdjacentElement('afterend', ui.recordsView);
  }

  function init() {
    buildUi();
    if (ready()) {
      var row = document.getElementById('engineRow');
      if (row && CFG.apiUrl) row.style.display = 'block';
      var off = document.getElementById('offline');
      if (off) off.textContent = 'You are offline. Photos are read on this device and saves are queued until you reconnect.';
    }
    if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) {} }
    if (location.hash === '#records') show('records');
    window.addEventListener('hashchange', function () { show(location.hash === '#records' ? 'records' : 'compare'); });
    refreshAll().then(sync);
    window.addEventListener('online', function () { refreshAll(); sync(); });
    window.addEventListener('offline', refreshAll);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.addEventListener('pagehide', function () {
    if (workerPromise) workerPromise.then(function (w) { return w.terminate(); }).catch(function () {});
  });

  window.Offline = {
    ready: ready, compare: compare, enqueue: enqueue, addRecord: addRecord, sync: sync,
    pending: function () { return listRecords().then(function (a) { return a.filter(function (r) { return r.status !== 'synced'; }).length; }); }
  };
})();
