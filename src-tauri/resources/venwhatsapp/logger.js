/* Venwhatsapp — runs in the page (MAIN world) next to wa-js (WPP).
 * Everything is stored locally in this browser's IndexedDB. Nothing is sent anywhere. */
(() => {
  'use strict';
  if (window.__waDeletedLogger) return;
  window.__waDeletedLogger = true;

  const DB_NAME = 'wa-deleted-logger';
  const STORE = 'messages';
  const MEDIA_TYPES = new Set(['image', 'video', 'ptt', 'audio', 'document', 'sticker']);
  const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
  const SETTINGS_KEY = 'wadl-settings';

  const readSettings = () => { try { return localStorage.getItem(SETTINGS_KEY); } catch { return null; } };
  const settings = Object.assign({ saveMedia: true, lastSeen: 0 }, safeJSON(readSettings()));
  const deletedIds = new Set();
  const cache = new Map(); // id -> record, only deleted or edited ones (used for in-chat rendering)
  const lastMessageByChat = new Map();
  const T0 = Date.now();
  let db;
  let dbError = null;
  /* Everything that touches the log goes through one queue, so e.g. "message arrived" is always saved
     before "message was deleted" is applied, even when both come in the same batch. */
  const dbReady = openDB().then((d) => { db = d; }).catch((e) => { dbError = e; log('database unavailable', e); });
  let chain = dbReady.catch(() => {});
  const enqueue = (fn) => (chain = chain.then(fn).catch((e) => log('queued task failed', e)));
  /* Small in-memory event log for debugging reconnect behaviour: venwhatsapp.timeline() */
  const timelineBuf = [];
  const tl = (kind, info) => { timelineBuf.push(Object.assign({ at: new Date().toISOString().slice(11, 23), kind }, info)); if (timelineBuf.length > 500) timelineBuf.shift(); };

  function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
  const log = (...a) => console.log('%c[Venwhatsapp]', 'color:#25d366;font-weight:bold', ...a);

  /* ---------- IndexedDB helpers ---------- */
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      let settled = false;
      const fail = (error) => { if (!settled) { settled = true; reject(error); } };
      req.onupgradeneeded = (ev) => {
        const d = req.result;
        let store;
        if (ev.oldVersion < 1) {
          store = d.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('deleted', 'deleted');
          store.createIndex('t', 't');
        } else {
          store = req.transaction.objectStore(STORE);
        }
        if (!store.indexNames.contains('mid')) store.createIndex('mid', 'mid');
      };
      req.onblocked = () => fail(new Error('The local database upgrade is blocked by another WhatsApp Web tab. Close the other tab and reload Venwhatsapp.'));
      req.onsuccess = () => {
        const connection = req.result;
        if (settled) { connection.close(); return; }
        settled = true;
        connection.onversionchange = () => connection.close();
        resolve(connection);
      };
      req.onerror = () => fail(req.error || new Error('Could not open the local database.'));
    });
  }
  const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE);
  const p = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const dbGet = (id) => p(tx('readonly').get(id));
  const dbPut = (rec) => p(tx('readwrite').put(rec));
  const dbAll = () => p(tx('readonly').getAll());
  const dbByMid = (mid) => p(tx('readonly').index('mid').getAll(mid));

  /* WhatsApp ids look like  false_<chat>_<MSGID>[_<participant>]. The chat part can change format
     (phone number vs LID) between sessions, so match on the bare MSGID instead of the whole string. */
  const midOf = (id) => { const parts = String(id).split('_'); return parts.length >= 3 ? parts[2] : String(id); };
  const chatPartOfId = (id) => { const parts = String(id).split('_'); return parts.length >= 3 ? parts[1] : null; };
  const findRec = async (id) => {
    const exact = await dbGet(id);
    if (exact) return exact;
    const matches = await dbByMid(midOf(id));
    if (!Array.isArray(matches) || !matches.length) return null;
    const chatId = chatPartOfId(id);
    const sameChat = chatId && matches.filter((rec) => rec.chatId === chatId);
    if (sameChat && sameChat.length === 1) return sameChat[0];
    return matches.length === 1 ? matches[0] : null;
  };
  const cacheMid = new Map();
  const cachePut = (rec) => {
    cache.set(rec.id, rec);
    for (const mid of [rec.mid || midOf(rec.id), rec.revokeMid]) {
      if (!mid) continue;
      let ids = cacheMid.get(mid);
      if (!ids) cacheMid.set(mid, ids = new Set());
      ids.add(rec.id);
    }
  };
  const cacheGet = (domId, activeChatId, activeMids) => {
    const exact = cache.get(String(domId));
    if (exact) {
      const domChatId = chatPartOfId(domId);
      if (activeChatId && exact.chatId !== activeChatId && exact.chatId !== domChatId && !(activeMids && activeMids.has(midOf(domId)))) return null;
      return exact;
    }
    const ids = cacheMid.get(midOf(domId));
    if (!ids) return null;
    const candidates = [...ids].map((id) => cache.get(id)).filter(Boolean);
    const domChatId = chatPartOfId(domId);
    const sameLiveMessage = activeMids && activeMids.has(midOf(domId));
    const inChat = candidates.filter((rec) => (activeChatId && rec.chatId === activeChatId) || (domChatId && rec.chatId === domChatId) || sameLiveMessage);
    if (inChat.length === 1) return inChat[0];
    if (activeChatId || domChatId || inChat.length > 1) return null;
    return candidates.length === 1 ? candidates[0] : null;
  };
  const dbClear = () => p(tx('readwrite').clear());

  /* ---------- message helpers ---------- */
  /* Turns a message key into its string id. Keys normally have _serialized, but raw ones from an incoming
     batch can be plain {fromMe, remote, id, participant} objects; stringifying those gives "[object Object]",
     which would make every such message look like the same one. */
  const serial = (k) => {
    if (!k) return null;
    if (typeof k === 'string') return k;
    if (k._serialized) return k._serialized;
    if (typeof k.id === 'string') {
      if (k.remote === undefined) return k.id;
      const rem = k.remote && (k.remote._serialized || String(k.remote)) || '';
      const part = k.participant && (k.participant._serialized || String(k.participant));
      return `${k.fromMe ? 'true' : 'false'}_${rem}_${k.id}` + (part ? `_${part}` : '');
    }
    const str = k.toString && k.toString();
    return str && str !== '[object Object]' ? str : null;
  };

  const looksLikeThumb = (t) => typeof t === 'string' && t.length > 100 && !/\s/.test(t) && /^[A-Za-z0-9+\/=]+$/.test(t);
  /* For text messages `body` is the text. For media messages `body` is a base64 thumbnail, so only the caption counts. */
  function textOf(msg) {
    if (!msg) return '';
    if (msg.type === 'chat') return typeof msg.body === 'string' ? msg.body : '';
    return (typeof msg.caption === 'string' && !looksLikeThumb(msg.caption)) ? msg.caption : '';
  }

  function chatName(chatWid) {
    try {
      const chat = WPP.chat.get(chatWid);
      return (chat && (chat.formattedTitle || chat.name)) || serial(chatWid) || 'unknown chat';
    } catch { return serial(chatWid) || 'unknown chat'; }
  }

  function senderName(msg) {
    try {
      if (msg.id && msg.id.fromMe) return 'You';
      const wid = msg.author || msg.from;
      const c = WPP.whatsapp.ContactStore.get(wid);
      return (c && (c.name || c.pushname || c.formattedName)) || msg.notifyName || serial(wid) || 'unknown';
    } catch { return msg.notifyName || 'unknown'; }
  }

  function snapshotRecord(msg) {
    const id = serial(msg.id);
    if (!id) return null;
    const fromMe = !!(msg.id && msg.id.fromMe);
    const chatId = serial(msg.id.remote) || serial(msg.from);
    const senderId = serial(msg.author) || (fromMe ? null : serial(msg.from));
    return {
      id,
      mid: midOf(id),
      senderId,
      chatId,
      chat: chatId || 'unknown chat',
      sender: fromMe ? 'You' : (msg.notifyName || senderId || 'unknown'),
      fromMe,
      type: msg.type || 'unknown',
      body: textOf(msg),
      filename: msg.filename || '',
      t: (msg.t || Math.floor(Date.now() / 1000)) * 1000,
      edits: [],
      deleted: 0,            // 0/1 so it can be indexed
      deletedAt: null,
      revokeType: null,
      media: null            // { blob, mime, name }
    };
  }

  function toRecord(msg) {
    const rec = snapshotRecord(msg);
    if (!rec) return null;
    rec.chat = chatName(msg.id.remote || msg.from);
    rec.sender = senderName(msg);
    return rec;
  }

  let mediaBusy = 0; const mediaWait = []; const mediaSaving = new Set();
  async function withMediaSlot(fn) {
    if (mediaBusy >= 2) await new Promise((r) => mediaWait.push(r));
    mediaBusy++;
    try { return await fn(); } finally { mediaBusy--; const n = mediaWait.shift(); if (n) n(); }
  }

  async function maybeSaveMedia(rec) {
    if (!settings.saveMedia || !MEDIA_TYPES.has(rec.type) || mediaSaving.has(rec.id)) return;
    if (Date.now() - (Number(rec.t) || 0) > 3 * 86400 * 1000) return; // don't bulk-download old history when a chat loads
    mediaSaving.add(rec.id);
    try {
      const blob = await withMediaSlot(() => WPP.chat.downloadMedia(rec.id));
      if (blob && blob.size <= MAX_MEDIA_BYTES) {
        const cur = (await dbGet(rec.id)) || rec;                       // re-read: it may have been marked deleted meanwhile
        cur.media = { blob, mime: blob.type, name: rec.filename || '' };
        await dbPut(cur);
        if (cache.has(cur.id)) cachePut(cur);
      }
    } catch (e) { /* media may be unavailable (expired / not downloaded) */ }
    finally { mediaSaving.delete(rec.id); }
  }

  async function logMessage(msg, source, snapshot) {
    try {
      if (!msg || (!snapshot && (msg.type === 'revoked' || msg.type === 'protocol'))) return;
      const rec = snapshot || toRecord(msg);
      if (!rec) return;
      if (rec.chatId && rec.chat === rec.chatId) rec.chat = chatName(rec.chatId);
      if (rec.sender !== 'You' && rec.sender === rec.senderId && rec.senderId) {
        rec.sender = senderName({ id: { fromMe: false }, author: rec.senderId, from: rec.chatId });
      }
      const existing = await findRec(rec.id);
      if (existing) {
        // Fill in what wasn't available the first time (text of a message that arrived still encrypted,
        // or the original of a delete we heard about first).
        let dirty = false;
        if (existing.unknownContent && (rec.body || MEDIA_TYPES.has(rec.type))) {
          Object.assign(existing, { sender: rec.sender, chat: rec.chat, chatId: rec.chatId || existing.chatId, senderId: rec.senderId, fromMe: rec.fromMe, type: rec.type, body: rec.body, t: rec.t, filename: rec.filename, prevId: rec.prevId || existing.prevId, prevT: rec.prevT || existing.prevT });
          existing.unknownContent = false; dirty = true;
        } else if (!existing.body && rec.body && !existing.deleted) { existing.body = rec.body; dirty = true; }
        if ((existing.type === 'ciphertext' || existing.type === 'unknown') && rec.type && rec.type !== 'ciphertext') { existing.type = rec.type; dirty = true; }
        if (!existing.senderId && rec.senderId) { existing.senderId = rec.senderId; dirty = true; }
        if (dirty) { await dbPut(existing); if (cache.has(existing.id)) cachePut(existing); tl('updated', { id: rec.mid, src: source, hasBody: !!existing.body }); decorate(); }
        if (source !== 'sweep' && !existing.media) maybeSaveMedia(existing);
        return;
      }
      await dbPut(rec);
      tl('logged', { id: rec.mid, src: source, type: rec.type, hasBody: !!rec.body });
      if (source !== 'sweep') maybeSaveMedia(rec);
    } catch (e) { log('logMessage failed', e); }
  }

  // Freeze the message's original fields synchronously in the event callback. WhatsApp can
  // mutate the same model into a revoked placeholder before the IndexedDB queue runs.
  function queueMessage(msg, source) {
    let snapshot = null;
    try {
      if (msg && msg.type !== 'revoked' && msg.type !== 'protocol') {
        snapshot = snapshotRecord(msg);
        if (snapshot && snapshot.chatId) {
          const previous = lastMessageByChat.get(snapshot.chatId);
          if (previous && previous.id !== snapshot.id && previous.t <= snapshot.t) {
            snapshot.prevId = previous.id;
            snapshot.prevT = previous.t;
          }
          if (!previous || snapshot.t >= previous.t) lastMessageByChat.set(snapshot.chatId, { id: snapshot.id, t: snapshot.t });
        }
      }
    } catch (e) { tl('snapshot-error', { src: source, err: String(e) }); }
    enqueue(() => logMessage(msg, source, snapshot));
  }

  /* ---------- event handlers ---------- */
  const timestampMs = (value) => {
    const t = Number(value) || 0;
    return t && t < 1e12 ? t * 1000 : t;
  };

  function notifyDesktop(kind, title, body) {
    try {
      const native = window.__TAURI__ && window.__TAURI__.core;
      if (native && typeof native.invoke === 'function') {
        native.invoke('notify', {
          title: String(title || ''),
          body: String(body || ''),
          epoch: window.__whatrustNotificationEpoch
        }).catch((e) => log('native notification failed', e));
        return;
      }
      const bridge = window.chrome && window.chrome.webview;
      if (!bridge || typeof bridge.postMessage !== 'function') return;
      bridge.postMessage({ type: 'venwhatsapp-alert', kind, title: String(title || ''), body: String(body || '') });
    } catch (e) { log('desktop notification bridge failed', e); }
  }

  function liveMessageContext(id, chatId) {
    try {
      const models = WPP.whatsapp.MsgStore.getModelsArray();
      let index = models.findIndex((m) => m && serial(m.id) === id);
      if (index < 0) index = models.findIndex((m) => m && midOf(serial(m.id)) === midOf(id) && (!chatId || serial(m.id.remote) === chatId));
      const live = index >= 0 ? models[index] : null;
      let prev = null;
      for (let i = index - 1; i >= 0; i--) {
        const m = models[i];
        if (!m || m.type === 'revoked' || m.type === 'protocol') continue;
        if (chatId && serial(m.id && m.id.remote) !== chatId) continue;
        prev = m;
        break;
      }
      return {
        live,
        anchor: prev ? { prevId: serial(prev.id), prevT: timestampMs(prev.t) } : {}
      };
    } catch { return { live: null, anchor: {} }; }
  }

  async function onRevoke(ev, opts) {
    opts = opts || {};
    try {
      const id = serial(ev.refId);
      if (!id) return;
      const context = liveMessageContext(id, serial(ev.from));
      let rec = await findRec(id);
      let known = !!rec;
      tl('revoke', { src: opts.src || 'event', id: midOf(id), known, already: !!(rec && rec.deleted) });
      if (rec && rec.deleted) return;                  // several hooks can report the same delete
      if (!rec) {
        const live = context.live && context.live.type !== 'revoked' && context.live.type !== 'protocol' ? context.live : null;
        rec = live ? toRecord(live) : null;
        if (!rec || (!rec.body && !MEDIA_TYPES.has(rec.type))) {
          tl('revoke-skipped-unlogged', { src: opts.src || 'event', id: midOf(id) });
          return;
        }
        known = true;
      }
      if (!rec.prevId && context.anchor.prevId) Object.assign(rec, context.anchor);
      if ((!rec.t || rec.unknownContent) && context.live && timestampMs(context.live.t)) rec.t = timestampMs(context.live.t);
      rec.deleted = 1;
      rec.deletedAt = Date.now();
      rec.revokeType = ev.type || 'revoke';
      if (ev.id) rec.revokeMid = midOf(serial(ev.id));     // WhatsApp may label the "deleted" row with the notice's id instead of the original's
      if (known && rec.body) rec.unknownContent = false;
      await dbPut(rec);
      deletedIds.add(rec.id);
      cachePut(rec);
      if (!rec.unknownContent && (opts.live || opts.src === 'wa-js')) {
        toast(`🗑 ${rec.sender} deleted a message ${inWhere(rec)}`, rec.body || `[${rec.type}]`);
        notifyDesktop('delete', `${rec.sender} deleted a message`, rec.body || `[${rec.type}]`);
      }
      refreshBadge();
      decorate();
    } catch (e) { log('onRevoke failed', e); }
  }

  async function onEdit(ev) {
    try {
      const msg = ev.msg;
      const id = serial(msg && msg.id) || ev.id;
      let rec = await findRec(id);
      if (!rec) { rec = toRecord(msg); if (!rec) return; }
      const newBody = textOf(msg);
      if (rec.body && newBody && rec.body !== newBody) {
        rec.edits.push({ body: rec.body, at: Date.now() });
        rec.body = newBody;
        await dbPut(rec);
        cachePut(rec);
        decorate();
        const oldBody = rec.edits[rec.edits.length - 1].body;
        toast(`✏️ ${rec.sender} edited a message ${inWhere(rec)}`, `Before: ${oldBody}`, 'edit');
        notifyDesktop('edit', `${rec.sender} edited a message`, `Before: ${oldBody}`);
        refreshBadge();
      }
    } catch (e) { log('onEdit failed', e); }
  }

  /* Capture ordinary messages loaded from history for later context. Historical revoke notices are
     deliberately ignored: they happened while Venwhatsapp was not observing the session. */
  const sweepDone = new Set();
  let sweepRunning = false, sweepRequested = false;
  function sweep() {
    if (sweepRunning) { sweepRequested = true; return; }
    let models;
    try { models = WPP.whatsapp.MsgStore.getModelsArray(); }
    catch { return; /* store not ready */ }
    if (!models || !models.length) return;
    sweepRunning = true;
    const limit = models.length;
    let index = 0;
    const finish = () => {
      sweepRunning = false;
      if (sweepRequested) { sweepRequested = false; setTimeout(sweep, 1000); }
    };
    const processChunk = () => {
      try {
        const end = Math.min(index + 25, limit);
        for (; index < end; index++) {
          const m = models[index];
          if (!m) continue;
          if (m.type === 'protocol' && REVOKE_SUBTYPES.has(m.subtype) && m.protocolMessageKey) {
            const revokeKey = 'protocol-revoke:' + (serial(m.id) || serial(m.protocolMessageKey));
            sweepDone.add(revokeKey);
            continue;
          }
          const k = serial(m.id);
          if (!k) continue;
          if (m.type === 'revoked') {
            sweepDone.add('revoked:' + k);
            continue;
          }
          if (sweepDone.has(k)) continue;
          const complete = m.type !== 'ciphertext' && (m.type !== 'chat' || !!m.body);
          if (complete) sweepDone.add(k);
          queueMessage(m, 'sweep');
        }
        if (index < limit) {
          // Let queued captures and live events drain before adding more background history work.
          const chunkTail = chain;
          chunkTail.then(() => setTimeout(processChunk, 0), () => setTimeout(processChunk, 0));
        } else finish();
      } catch (e) {
        log('history sweep failed', e);
        finish();
      }
    };
    setTimeout(processChunk, 0);
  }

  /* ---------- early hooks ----------
     wa-js reports live revokes. A store batch can provide an earlier snapshot of the original, but
     only when WhatsApp marks the revoke notice as new; reconnect/history batches stay out of the log. */
  const REVOKE_SUBTYPES = new Set(['revoke', 'sender_revoke', 'admin_revoke']);
  const freshDeleteIds = new Set();
  let hooksInstalled = false;

  function markFreshDelete(id) {
    if (!id) return;
    freshDeleteIds.add(id);
    setTimeout(() => freshDeleteIds.delete(id), 60000);
  }

  function onBatch(msgs) {
    const list = Array.isArray(msgs) ? msgs : (msgs && typeof msgs[Symbol.iterator] === 'function' ? Array.from(msgs) : []);
    const revokes = [];
    for (const m of list) {
      if (!m) continue;
      if (!m.isNewMsg) continue;
      if (m.type === 'protocol') { if (REVOKE_SUBTYPES.has(m.subtype) && m.protocolMessageKey) revokes.push(m); continue; }
      if (m.type === 'revoked') { revokes.push({ protocolMessageKey: m.id, id: m.id, from: m.id && m.id.remote, subtype: 'store', isNewMsg: true }); continue; }
    }
    if (!revokes.length) return; // ordinary messages are captured by the store and live-message events

    // Only snapshot a matching original before WhatsApp mutates it into a revoked placeholder.
    // Walking and serializing a full history-sync batch here used to delay the app's own startup.
    const referenced = new Set(revokes.map((m) => serial(m.protocolMessageKey || m.id)).filter(Boolean));
    for (const m of list) {
      if (!m || m.type === 'protocol' || m.type === 'revoked') continue;
      const id = serial(m.id);
      if (id && referenced.has(id)) queueMessage(m, 'batch');
    }
    tl('batch-revoke', { n: list.length, revokes: revokes.length });
    for (const m of revokes) {                                       // originals first, then live deletes that refer to them
      const id = serial(m.protocolMessageKey || m.id);
      markFreshDelete(id);
      enqueue(() => onRevoke({ refId: m.protocolMessageKey, id: m.id, from: m.from, author: m.author, type: m.subtype }, { src: 'batch', live: true }));
    }
  }

  function installHooks() {
    if (hooksInstalled) return;
    try {
      const S = WPP.whatsapp && WPP.whatsapp.MsgStore;
      if (!S) return;
      hooksInstalled = true;
      if (typeof S.processMultipleMessages === 'function' && !S.processMultipleMessages.__wadl) {
        const orig = S.processMultipleMessages;
        const wrapped = function (chat, msgs, ...rest) {
          try { onBatch(msgs); } catch (e) { tl('batch-error', { err: String(e) }); }
          return orig.call(this, chat, msgs, ...rest);
        };
        wrapped.__wadl = true;
        S.processMultipleMessages = wrapped;
      }
      S.on('add', (m) => {
        try { tl('add', { id: midOf(serial(m.id)), type: m.type, isNew: !!m.isNewMsg, hasBody: !!m.body }); } catch {}
        queueMessage(m, 'add');                                       // no "is new" filter: also history and offline catch-up
      });
      S.on('change:type', (m) => {                                    // decrypted later, or flipped to "deleted"
        try {
          if (m.type === 'revoked') {
            const id = serial(m.id);
            if (m.isNewMsg || freshDeleteIds.has(id)) {
              markFreshDelete(id);
              enqueue(() => onRevoke({ refId: m.id, from: m.id && m.id.remote, type: 'store' }, { src: 'store', live: true }));
            }
          }
          else if (m.type !== 'ciphertext' && m.type !== 'protocol') queueMessage(m, 'type');
        } catch {}
      });
      tl('hooks', { installed: true });
    } catch (e) { hooksInstalled = false; log('installHooks failed', e); }
  }

  /* ---------- UI ---------- */
  const css = `
  :root[data-wadl-theme=dark]{--wadl-in:#1d1f1f;--wadl-out:#005c4b;--wadl-text:#e9edef;--wadl-time:#ffffff99;--wadl-del:#ff7b7b;--wadl-grey:#8696a0;--wadl-name:#53bdeb;
    --wadl-bg:#161717;--wadl-head:#1d1f1f;--wadl-border:#222d34;--wadl-hover:rgba(255,255,255,.08);--wadl-icon:#aebac1;--wadl-accent:#21c063;--wadl-card:#1c1e1e;--wadl-input:#1d1f1f;
    --wadl-sw-off:#3b4a54;--wadl-chip-del:rgba(255,123,123,.16);--wadl-chip-edit:rgba(134,150,160,.2)}
  :root[data-wadl-theme=light]{--wadl-in:#ffffff;--wadl-out:#d9fdd3;--wadl-text:#161717;--wadl-time:#667781;--wadl-del:#d32f2f;--wadl-grey:#667781;--wadl-name:#027eb5;
    --wadl-bg:#ffffff;--wadl-head:#f0f2f5;--wadl-border:#e9edef;--wadl-hover:rgba(0,0,0,.06);--wadl-icon:#54656f;--wadl-accent:#21c063;--wadl-card:#f7f8fa;--wadl-input:#f0f2f5;
    --wadl-sw-off:#c5ccd0;--wadl-chip-del:rgba(211,47,47,.12);--wadl-chip-edit:rgba(102,119,129,.16)}

  /* in-chat bubbles */
  .wadl-hide > :not(.wadl-row){display:none !important}
  .wadl-row{display:flex;padding:2px clamp(12px,6vw,63px);box-sizing:border-box;width:100%}
  .wadl-row.out{justify-content:flex-end}
  .wadl-row.in{justify-content:flex-start}
  .wadl-bubble{box-sizing:border-box;max-width:min(65%,720px);min-width:60px;border-radius:7.5px;padding:6px 7px 8px 9px;box-shadow:0 1px .5px rgba(11,20,26,.13);overflow-wrap:anywhere;
    font:14.2px/19px "Segoe UI","Helvetica Neue",Helvetica,"Lucida Grande",Arial,sans-serif;color:var(--wadl-text);position:relative}
  .wadl-bubble.in{background:var(--wadl-in)}
  .wadl-bubble.out{background:var(--wadl-out)}
  .wadl-name{font-size:12.8px;font-weight:500;color:var(--wadl-name);margin-bottom:2px}
  .wadl-del{display:block;color:var(--wadl-del);white-space:pre-wrap;overflow-wrap:anywhere;border-left:2px solid var(--wadl-del);padding-left:7px}
  .wadl-prev{color:var(--wadl-grey);white-space:pre-wrap;word-break:break-word;font-size:inherit;line-height:inherit}
  .wadl-bubble .wadl-prev{margin-bottom:2px}
  .wadl-message-head{display:block;margin:0 0 4px;padding-right:34px;user-select:none}
  .wadl-status-row{display:flex;align-items:center;gap:6px;min-height:22px;font-size:12.5px;line-height:1.2;white-space:nowrap}
  .wadl-status-row+.wadl-status-row{margin-top:3px}
  .wadl-status-row .wadl-ico{width:14px;height:14px;flex:none}
  .wadl-status-row b{font-weight:600}
  .wadl-status-del{color:var(--wadl-del)}
  .wadl-status-edit{color:var(--wadl-grey)}
  .wadl-status-count{font-size:12px;color:var(--wadl-grey)}
  .wadl-history-toggle{display:inline-flex;align-items:center;gap:3px;margin-left:auto;padding:3px 7px 3px 10px;border:0;border-radius:12px;background:var(--wadl-chip-edit);color:var(--wadl-grey);font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s}
  .wadl-history-toggle:hover{background:var(--wadl-hover)}
  .wadl-history-toggle:focus-visible{outline:2px solid var(--wadl-accent);outline-offset:1px}
  .wadl-history-toggle .wadl-ico{width:14px;height:14px;transition:transform .2s}
  .wadl-history-toggle[aria-expanded="true"] .wadl-ico{transform:rotate(180deg)}
  .wadl-history{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .22s ease,opacity .18s ease}
  .wadl-history.open{grid-template-rows:1fr;opacity:1}
  .wadl-history-inner{min-height:0;overflow:hidden}
  .wadl-history.open .wadl-history-inner{padding:7px 0 3px}
  .wadl-history-item{position:relative;padding:0 0 8px 18px;min-width:0}
  .wadl-history-item:before{content:"";position:absolute;left:3px;top:5px;width:7px;height:7px;border-radius:50%;background:var(--wadl-grey)}
  .wadl-history-item:not(:last-child):after{content:"";position:absolute;left:6px;top:15px;bottom:0;width:1px;background:var(--wadl-border)}
  .wadl-history-tag{display:block;color:var(--wadl-grey);font-size:11.5px;font-weight:600;line-height:17px}
  .wadl-history-text{color:var(--wadl-grey);white-space:pre-wrap;overflow-wrap:anywhere}
  .wadl-history-current{padding-bottom:0}
  .wadl-history-current:before{background:var(--wadl-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--wadl-accent) 25%,transparent)}
  .wadl-history-current .wadl-history-tag{color:var(--wadl-accent)}
  .wadl-meta-row{display:flex;justify-content:flex-end;gap:6px;font-size:11px;line-height:15px;color:var(--wadl-time);margin-top:2px}
  .wadl-bubble img,.wadl-bubble video{max-width:100%;max-height:260px;border-radius:6px;display:block;margin-bottom:3px}
  .wadl-bubble audio{width:240px;max-width:100%}
  .wadl-bubble a{color:var(--wadl-name)}

  [data-wadl-hid]{display:none !important}
  [data-wadl-red],[data-wadl-red] *{color:var(--wadl-del) !important}
  .wadl-inline{color:var(--wadl-del);white-space:pre-wrap;word-break:break-word;font-style:normal;font-size:14.2px;line-height:19px}
  .wadl-inline .wadl-prev{margin-bottom:2px}
  .wadl-inline img,.wadl-inline video{max-width:100%;max-height:260px;border-radius:6px;display:block;margin-bottom:3px}
  .wadl-inline audio{width:240px;max-width:100%}
  .wadl-inline a{color:var(--wadl-name)}
  .wadl-ghost{display:block;width:100%}

  /* nav rail button + fallback */
  .wadl-ico{fill:currentColor;display:block}
  .wadl-nav-wrap{display:flex;justify-content:center;align-items:center;padding:6px 0;width:100%}
  .wadl-nav{position:relative;width:40px;height:40px;border:0;border-radius:50%;background:transparent;color:var(--wadl-icon);cursor:pointer;display:flex;align-items:center;justify-content:center}
  .wadl-nav:hover{background:var(--wadl-hover)}
  .wadl-nav.on{background:var(--wadl-hover);color:var(--wadl-text)}
  .wadl-badge{position:absolute;top:-2px;right:-2px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:#e53935;color:#fff;
    font:600 10px/16px "Segoe UI",Arial,sans-serif;text-align:center;display:none}
  .wadl-fab{position:fixed;left:12px;bottom:12px;z-index:99997;display:none;width:36px;height:36px;border-radius:50%;border:1px solid var(--wadl-border);
    background:var(--wadl-head);color:var(--wadl-icon);opacity:.6;cursor:pointer;align-items:center;justify-content:center}
  .wadl-fab:hover{opacity:1}
  .wadl-fab .wadl-badge{top:-4px;right:-4px}

  /* side drawer */
  #wadl-panel{position:fixed;top:0;right:0;bottom:0;width:min(400px,100vw);z-index:99998;display:flex;flex-direction:column;background:var(--wadl-bg);color:var(--wadl-text);
    border-left:1px solid var(--wadl-border);box-shadow:-8px 0 30px rgba(0,0,0,.35);font:14px/20px "Segoe UI","Helvetica Neue",Helvetica,Arial,sans-serif;
    transform:translateX(105%);visibility:hidden;transition:transform .22s ease,visibility 0s .22s}
  #wadl-panel.open{transform:none;visibility:visible;transition:transform .22s ease,visibility 0s}
  .wadl-ph{display:flex;align-items:center;gap:8px;padding:0 10px 0 16px;height:59px;background:var(--wadl-head);flex:none}
  .wadl-ph .grow{flex:1;min-width:0}
  .wadl-ph h2{margin:0;font-size:17px;font-weight:500;line-height:20px}
  .wadl-ph p{margin:0;font-size:12.5px;line-height:16px;color:var(--wadl-grey)}
  .wadl-ib{width:36px;height:36px;border:0;border-radius:50%;background:transparent;color:var(--wadl-icon);cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none}
  .wadl-ib:hover{background:var(--wadl-hover)}
  .wadl-ib.sm{width:26px;height:26px}
  .wadl-search{display:flex;align-items:center;gap:10px;margin:10px 12px 4px;padding:0 12px;height:35px;border-radius:8px;background:var(--wadl-input);color:var(--wadl-icon);flex:none}
  .wadl-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--wadl-text);font:inherit;font-size:14px}
  .wadl-search input::placeholder{color:var(--wadl-grey)}
  .wadl-tabs{display:flex;gap:6px;padding:8px 12px 10px;flex:none}
  .wadl-tab{border:0;border-radius:16px;padding:4px 12px;background:var(--wadl-input);color:var(--wadl-grey);font:inherit;font-size:13.5px;cursor:pointer;display:flex;gap:6px;align-items:center}
  .wadl-tab:hover{filter:brightness(1.1)}
  .wadl-tab.on{background:rgba(0,168,132,.2);color:var(--wadl-accent)}
  .wadl-tab span{font-size:12px;opacity:.85}
  #wadl-list{flex:1;overflow:auto;padding:0 8px 8px}
  .wadl-day{position:sticky;top:0;z-index:1;margin:2px 0;padding:6px 8px 4px;font-size:12px;font-weight:500;color:var(--wadl-grey);background:var(--wadl-bg)}
  .wadl-card{display:flex;gap:12px;padding:10px;margin:4px 0;border-radius:10px;background:var(--wadl-card);cursor:pointer;transition:background .12s}
  .wadl-card:hover{background:var(--wadl-hover)}
  .wadl-card:focus-visible{outline:2px solid var(--wadl-accent);outline-offset:-2px}
  .wadl-card.busy{opacity:.78}
  .wadl-jump-progress{display:flex;align-items:center;gap:8px;margin-top:7px;color:var(--wadl-grey);font-size:12px}
  .wadl-jump-progress span{flex:1;min-width:0}
  .wadl-jump-cancel{border:0;border-radius:6px;padding:3px 8px;background:var(--wadl-input);color:var(--wadl-text);font:inherit;cursor:pointer}
  .wadl-jump-cancel:hover{background:var(--wadl-hover)}
  .wadl-flash{animation:wadl-flash 1.8s ease-out}
  @keyframes wadl-flash{0%,35%{box-shadow:0 0 0 3px rgba(33,192,99,.35)}100%{box-shadow:0 0 0 0 rgba(33,192,99,0)}}
  .wadl-av{flex:none;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;font-size:16px;position:relative;overflow:hidden}
  .wadl-card .wadl-av img{position:absolute;inset:0;width:100%;height:100%;max-width:none;max-height:none;object-fit:cover;border-radius:50%;margin:0;display:block}
  .wadl-cb{flex:1;min-width:0}
  .wadl-r1{display:flex;align-items:center;gap:6px;min-width:0}
  .wadl-sender{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .wadl-when{margin-left:auto;font-size:12px;color:var(--wadl-grey);white-space:nowrap;flex:none}
  .wadl-chat{font-size:12.5px;color:var(--wadl-grey);margin:0 0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .wadl-chip{flex:none;font-size:10.5px;font-weight:600;line-height:16px;padding:0 7px;border-radius:8px;letter-spacing:.03em}
  .wadl-chip.del{background:var(--wadl-chip-del);color:var(--wadl-del)}
  .wadl-chip.edit{background:var(--wadl-chip-edit);color:var(--wadl-grey)}
  .wadl-text{white-space:pre-wrap;word-break:break-word;font-size:14.2px;line-height:19px}
  .wadl-text.del{color:var(--wadl-del)}
  .wadl-text.none{color:var(--wadl-grey);font-style:italic}
  .wadl-hist{margin:0 0 6px;padding-left:10px;border-left:2px solid var(--wadl-border)}
  .wadl-hist div{color:var(--wadl-grey);white-space:pre-wrap;word-break:break-word;font-size:13.5px;line-height:18px}
  .wadl-hist small{display:block;font-size:11px;opacity:.8;margin-bottom:2px}
  .wadl-card-history-row{display:flex;align-items:center;margin:0 0 2px}
  .wadl-card-history-row .wadl-history-toggle{margin-left:0}
  .wadl-card img,.wadl-card video{max-width:100%;max-height:200px;border-radius:8px;display:block;margin:2px 0 6px}
  .wadl-card audio{width:100%;margin:2px 0 6px}
  .wadl-card a.file{color:var(--wadl-name)}
  .wadl-empty{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;color:var(--wadl-grey);padding:56px 28px;font-size:13.5px}
  .wadl-empty .wadl-ico{width:44px;height:44px;opacity:.5}
  .wadl-pf{display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--wadl-head);flex:none}
  .wadl-sw{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--wadl-grey);cursor:pointer;flex:1}
  .wadl-sw input{display:none}
  .wadl-sw i{width:32px;height:18px;border-radius:9px;background:var(--wadl-sw-off);position:relative;transition:background .15s;flex:none}
  .wadl-sw i::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}
  .wadl-sw input:checked + i{background:var(--wadl-accent)}
  .wadl-sw input:checked + i::after{transform:translateX(14px)}
  .wadl-btn{border:1px solid var(--wadl-border);border-radius:18px;padding:5px 14px;font:inherit;font-size:13.5px;font-weight:500;cursor:pointer;background:transparent;color:var(--wadl-icon)}
  .wadl-btn:hover{background:var(--wadl-hover)}
  .wadl-btn.danger{color:var(--wadl-del)}

  /* toasts */
  #wadl-toast{position:fixed;left:76px;bottom:18px;z-index:99999;display:flex;flex-direction:column-reverse;gap:8px;pointer-events:none}
  .wadl-t{pointer-events:auto;cursor:pointer;background:var(--wadl-head);color:var(--wadl-text);border-left:4px solid #e53935;border-radius:8px;padding:8px 12px;max-width:320px;
    font:13.5px/18px "Segoe UI","Helvetica Neue",Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)}
  .wadl-t.edit{border-left-color:var(--wadl-grey)}
  .wadl-t small{display:block;color:var(--wadl-grey);margin-top:2px;white-space:pre-wrap;word-break:break-word}
  `;

  let fab, navWrap, navBtn, navBadge, fabBadge, panel, listEl, subEl, searchEl, toastBox;
  const tabEls = {};
  const view = { tab: 'all', q: '' };
  const expandedHistory = new Set();
  let panelOpen = false, objectUrls = [], lastNavTry = 0;
  let lastJump = null;
  let activeJump = null;
  const bootAt = Date.now();

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
    edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z',
    chevron: 'M7 10l5 5 5-5z'
  };
  function icon(name, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 24));
    svg.setAttribute('height', String(size || 24));
    svg.setAttribute('class', 'wadl-ico');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDateTime = (ms) => new Date(ms).toLocaleString();
  const hash = (str) => { let h = 0; for (const c of String(str || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  const isDM = (r) => /@(c\.us|lid|s\.whatsapp\.net)$/.test(r.chatId || '');
  const inWhere = (r) => (isDM(r) ? 'in DMs' : 'in ' + (r.chat || 'unknown chat'));
  const eventTime = (r) => r.deleted ? (r.deletedAt || 0) : ((r.edits && r.edits.length) ? r.edits[r.edits.length - 1].at : 0);

  function dayLabel(ms) {
    const d = new Date(ms), now = new Date();
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(now) - start(d)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }

  /* ----- left nav rail button (with floating fallback) ----- */
  const NAV_TOP = ['chats', 'calls', 'status', 'channels', 'communities', 'updates'];

  function commonAncestor(nodes) {
    let anc = nodes[0].parentElement;
    while (anc && !nodes.every((n) => anc.contains(n))) anc = anc.parentElement;
    return anc;
  }

  /* Finds WhatsApp's left rail by its accessible labels (Chats / Status / Channels ...) instead of
     its obfuscated class names, then inserts our button after the last of those items. */
  function mountNav() {
    const found = [];
    for (const n of document.querySelectorAll('[aria-label]')) {
      if (!(n.tagName === 'BUTTON' || n.tagName === 'A' || n.getAttribute('role') === 'button' || n.getAttribute('role') === 'tab')) continue;
      const label = (n.getAttribute('aria-label') || '').split(/[,:(]/)[0].trim().toLowerCase();
      if (NAV_TOP.includes(label) && !found.some((f) => f.label === label)) found.push({ label, node: n });
    }
    if (found.length < 2) return false;
    const container = commonAncestor(found.map((f) => f.node));
    if (!container || container === document.body || container === document.documentElement) return false;
    if (container.getBoundingClientRect().width > 140) return false;      // the rail is a narrow strip; anything wider is something else

    let last = null, lastIdx = -1;
    for (const f of found) {
      let item = f.node;
      while (item && item.parentElement !== container) item = item.parentElement;
      if (!item) continue;
      const idx = Array.prototype.indexOf.call(container.children, item);
      if (idx > lastIdx) { lastIdx = idx; last = item; }
    }
    if (!last) return false;
    container.insertBefore(navWrap, last.nextSibling);
    return true;
  }

  function ensureNav() {
    if (!fab) return;
    let mounted = !!(navWrap && navWrap.isConnected);
    if (!mounted && Date.now() - lastNavTry > 1000) {
      lastNavTry = Date.now();
      try { mounted = mountNav(); } catch { mounted = false; }
    }
    fab.style.display = (!mounted && Date.now() - bootAt > 6000) ? 'flex' : 'none';
  }

  /* ----- panel ----- */
  function buildPanel() {
    const p = el('aside'); p.id = 'wadl-panel'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Venwhatsapp');

    const head = el('div', 'wadl-ph');
    const titles = el('div', 'grow');
    titles.appendChild(el('h2', null, 'Venwhatsapp'));
    subEl = el('p', null, ''); titles.appendChild(subEl);
    const closeBtn = el('button', 'wadl-ib'); closeBtn.title = 'Close (Esc)'; closeBtn.appendChild(icon('close', 22)); closeBtn.onclick = closePanel;
    head.append(titles, closeBtn);

    const search = el('div', 'wadl-search');
    search.appendChild(icon('search', 18));
    searchEl = el('input'); searchEl.type = 'text'; searchEl.placeholder = 'Search deleted & edited messages';
    let t; searchEl.oninput = () => { clearTimeout(t); t = setTimeout(() => { view.q = searchEl.value.trim().toLowerCase(); renderList(); }, 150); };
    search.appendChild(searchEl);

    const tabs = el('div', 'wadl-tabs');
    for (const [key, label] of [['all', 'All'], ['deleted', 'Deleted'], ['edited', 'Edited']]) {
      const b = el('button', 'wadl-tab' + (key === view.tab ? ' on' : ''));
      b.appendChild(el('b', null, label)); b.firstChild.style.fontWeight = '500';
      const c = el('span', null, '0'); b.appendChild(c);
      b.onclick = () => { view.tab = key; for (const k in tabEls) tabEls[k].b.classList.toggle('on', k === key); renderList(); };
      tabEls[key] = { b, c }; tabs.appendChild(b);
    }

    listEl = el('div'); listEl.id = 'wadl-list';

    const foot = el('div', 'wadl-pf');
    const sw = el('label', 'wadl-sw');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!settings.saveMedia;
    cb.onchange = () => { settings.saveMedia = cb.checked; saveSettings(); };
    sw.append(cb, el('i'), el('span', null, 'Save media'));
    const exp = el('button', 'wadl-btn', 'Export'); exp.onclick = exportJSON;
    const clr = el('button', 'wadl-btn danger', 'Clear'); clr.onclick = clearLog;
    foot.append(sw, exp, clr);

    p.append(head, search, tabs, listEl, foot);
    return p;
  }

  function buildUI() {
    const style = el('style'); style.textContent = css; document.head.appendChild(style);

    navBtn = el('button', 'wadl-nav');
    navBtn.title = 'Venwhatsapp: deleted & edited messages (Ctrl+Shift+L)';
    navBtn.setAttribute('aria-label', 'Venwhatsapp');
    navBtn.appendChild(icon('trash', 24));
    navBadge = el('span', 'wadl-badge'); navBtn.appendChild(navBadge);
    navBtn.onclick = togglePanel;
    navWrap = el('div', 'wadl-nav-wrap'); navWrap.appendChild(navBtn);

    fab = el('button', 'wadl-fab');
    fab.title = 'Venwhatsapp: deleted & edited messages (Ctrl+Shift+L)';
    fab.appendChild(icon('trash', 20));
    fabBadge = el('span', 'wadl-badge'); fab.appendChild(fabBadge);
    fab.onclick = togglePanel;

    panel = buildPanel();
    toastBox = el('div'); toastBox.id = 'wadl-toast';
    document.body.append(fab, panel, toastBox);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panelOpen) { e.preventDefault(); e.stopPropagation(); closePanel(); }
      else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') { e.preventDefault(); togglePanel(); }
    }, true);
  }

  function openPanel() {
    panelOpen = true;
    panel.classList.add('open');
    navBtn.classList.add('on');
    settings.lastSeen = Date.now(); saveSettings();
    updateBadge();
    renderList();
  }
  function closePanel() { panelOpen = false; panel.classList.remove('open'); navBtn.classList.remove('on'); }
  function togglePanel() { panelOpen ? closePanel() : openPanel(); }

  function makeToast(title, sub, kind) {
    const t = el('div', 'wadl-t' + (kind === 'edit' ? ' edit' : ''), title);
    if (sub) t.appendChild(el('small', null, sub.slice(0, 300)));
    t.onclick = () => { t.remove(); openPanel(); };
    toastBox.appendChild(t);
    setTimeout(() => t.remove(), 9000);
    return t;
  }
  const burst = { n: 0, at: 0, summary: null };
  function toast(title, sub, kind) {
    if (!toastBox) return;
    const now = Date.now();
    if (now - burst.at > 4000) { burst.n = 0; burst.summary = null; }
    burst.at = now; burst.n++;
    if (burst.n > 3) {                       // e.g. a pile of deletes synced after being offline: one summary, not a wall of toasts
      const text = `+${burst.n - 3} more deleted/edited messages`;
      if (burst.summary && burst.summary.isConnected) burst.summary.firstChild.textContent = text;
      else burst.summary = makeToast(text, 'Click to open Venwhatsapp', kind);
      return;
    }
    makeToast(title, sub, kind);
  }

  function updateBadge() {
    try {
      let n = 0;
        for (const r of cache.values()) if (!r.unknownContent && eventTime(r) > (settings.lastSeen || 0)) n++;
      for (const b of [navBadge, fabBadge]) if (b) { b.textContent = n > 99 ? '99+' : String(n); b.style.display = n && !panelOpen ? 'block' : 'none'; }
    } catch {}
  }
  function refreshBadge() { updateBadge(); if (panelOpen) renderList(); }

  async function clearLog() {
    if (!db) { toast('Local log unavailable', 'Close other WhatsApp Web tabs and reload Venwhatsapp before clearing the log.', 'edit'); return; }
    if (!confirm('Delete the entire Venwhatsapp log? This cannot be undone.')) return;
    await dbClear(); deletedIds.clear(); cache.clear(); cacheMid.clear(); expandedHistory.clear();
    document.querySelectorAll('.wadl-row,.wadl-prev,.wadl-inline,.wadl-message-head,.wadl-ghost').forEach((n) => n.remove());
    ghosts.clear(); placement.clear();
    document.querySelectorAll('[data-wadl-hid]').forEach((n) => n.removeAttribute('data-wadl-hid'));
    document.querySelectorAll('[data-wadl-red]').forEach((n) => n.removeAttribute('data-wadl-red'));
    document.querySelectorAll('[data-wadl-history]').forEach((n) => n.removeAttribute('data-wadl-history'));
    document.querySelectorAll('.wadl-hide').forEach((n) => n.classList.remove('wadl-hide'));
    settings.lastSeen = Date.now(); saveSettings();
    renderList(); updateBadge();
  }

  /* ----- profile pictures (looked up live from WhatsApp, cached for a few minutes) ----- */
  const pfpCache = new Map();               // key -> { url, at, ttl }
  const pfpPending = new Map();
  const PFP_TTL = 10 * 60 * 1000, PFP_MISS_TTL = 60 * 1000;
  const pfpStats = { requested: 0, found: 0, none: 0, errors: 0, imgFailed: 0, via: {}, lastError: null, lastUrl: null };
  let pfpQueue = [], pfpRunning = 0;

  function pfpCandidates(r) {
    const out = [];
    const add = (w) => { if (w && !out.includes(w)) out.push(w); };
    if (r.fromMe) { try { add(serial(WPP.conn.getMyUserId())); } catch {} return out; }
    if (/@g\.us$/.test(r.chatId || '')) { add(r.senderId); return out; }   // group message: the person, not the group
    add(r.senderId); add(r.chatId);
    return out;
  }

  /* wa-js's getProfilePictureUrl returns the FULL-size picture by default, which WhatsApp often hasn't loaded.
     The small thumbnail is what the chat list uses, so ask for that first. */
  async function lookupPfp(wids) {
    for (const wid of wids) {
      const steps = [
        ['thumb', () => WPP.contact.getProfilePictureUrl(wid, false)],
        ['store', async () => { const m = await WPP.whatsapp.ProfilePicThumbStore.find(WPP.whatsapp.WidFactory.createWid(wid)); return m && (m.img || m.imgFull || m.eurl); }],
        ['full',  () => WPP.contact.getProfilePictureUrl(wid, true)]
      ];
      for (const [name, fn] of steps) {
        try {
          const u = await fn();
          if (u && typeof u === 'string') { pfpStats.via[name] = (pfpStats.via[name] || 0) + 1; return u; }
        } catch (e) { pfpStats.errors++; pfpStats.lastError = `${name}: ${(e && e.message) || e}`; }
      }
    }
    return null;
  }

  function fetchPfp(r) {
    const wids = pfpCandidates(r);
    if (!wids.length) return Promise.resolve(null);
    const key = wids.join('|');
    const hit = pfpCache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return Promise.resolve(hit.url);
    if (pfpPending.has(key)) return pfpPending.get(key);
    const pr = new Promise((resolve) => {
      pfpQueue.push(async () => {
        pfpStats.requested++;
        let url = null;
        try { url = await lookupPfp(wids); } catch { url = null; }
        if (url) { pfpStats.found++; pfpStats.lastUrl = url.slice(0, 90); } else pfpStats.none++;
        pfpCache.set(key, { url, at: Date.now(), ttl: url ? PFP_TTL : PFP_MISS_TTL });
        pfpPending.delete(key);
        resolve(url);
      });
      pumpPfp();
    });
    pfpPending.set(key, pr);
    return pr;
  }
  function pumpPfp() {                       // at most 3 lookups at a time so we don't hammer WhatsApp
    while (pfpRunning < 3 && pfpQueue.length) {
      const job = pfpQueue.shift(); pfpRunning++;
      job().finally(() => { pfpRunning--; pumpPfp(); });
    }
  }

  function loadAvatar(av, r) {
    const key = pfpCandidates(r).join('|');
    fetchPfp(r).then((url) => {
      if (!url || !av.isConnected) return;
      const failed = () => { pfpStats.imgFailed++; pfpCache.set(key, { url: null, at: Date.now(), ttl: PFP_MISS_TTL }); };
      const show = (src, isBlob) => {
        const img = document.createElement('img');
        img.alt = '';
        img.onload = () => { if (av.isConnected) { av.textContent = ''; av.appendChild(img); } };   // swap only once it has loaded
        img.onerror = () => { if (isBlob) failed(); else viaBlob(); };
        img.src = src;
      };
      const viaBlob = () => { try { fetch(url).then((res) => res.blob()).then((b) => { const u = URL.createObjectURL(b); objectUrls.push(u); show(u, true); }).catch(failed); } catch { failed(); } };
      show(url, false);
    });
  }

  /* ----- click a card -> open that chat at that message ----- */
  function findLiveMsgId(r) {
    try {
      const matches = WPP.whatsapp.MsgStore.getModelsArray().filter((x) => x && midOf(serial(x.id)) === r.mid);
      const m = matches.find((x) => serial(x.id) === r.id)
        || matches.find((x) => serial(x.id && x.id.remote) === r.chatId)
        || (matches.length === 1 ? matches[0] : null);
      return m ? { id: serial(m.id), chat: serial(m.id.remote) } : null;
    } catch { return null; }
  }

  const msgTimestamp = (m) => timestampMs(m && m.t);

  function chatCandidates(r) {
    const out = new Set([r.chatId].filter(Boolean));
    const live = findLiveMsgId(r);
    if (live && live.chat) out.add(live.chat);
    try {
      const factory = WPP.whatsapp.WidFactory;
      const cache = WPP.whatsapp.lidPnCache;
      const wid = factory && factory.createWid(r.chatId);
      if (wid && cache) {
        const isLid = typeof wid.isLid === 'function' ? wid.isLid() : /@lid$/.test(String(r.chatId));
        const alt = isLid && typeof cache.getPhoneNumber === 'function'
          ? cache.getPhoneNumber(wid)
          : (!isLid && typeof cache.getCurrentLid === 'function' ? cache.getCurrentLid(wid) : null);
        if (alt && typeof alt.then !== 'function') out.add(serial(alt));
      }
    } catch {}
    return [...out].filter(Boolean);
  }

  function closestMsgByTime(messages, target) {
    const sameDay = (t) => {
      const a = new Date(t), b = new Date(target);
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    };
    const sameDayMessages = messages.filter((m) => sameDay(msgTimestamp(m)));
    const pool = sameDayMessages.length ? sameDayMessages : messages;
    const before = pool.filter((m) => msgTimestamp(m) <= target).sort((a, b) => msgTimestamp(b) - msgTimestamp(a));
    const after = pool.filter((m) => msgTimestamp(m) > target).sort((a, b) => msgTimestamp(a) - msgTimestamp(b));
    const m = before[0] || after[0];
    return m ? { id: serial(m.id), chat: serial(m.id.remote), t: msgTimestamp(m) } : null;
  }

  async function nearestLiveMsgId(r, requestedChatId, onProgress, isCancelled) {
    try {
      const chatId = String(requestedChatId || r.chatId || '');
      const allMessages = WPP.whatsapp.MsgStore.getModelsArray();
      const candidates = allMessages.filter((m) => {
        const remote = serial(m.id && m.id.remote);
        return remote === chatId && m.type !== 'revoked' && serial(m.id);
      });
      if (!candidates.length) return null;
      const target = Number(r.t) || 0;
      let oldest = candidates.reduce((a, b) => msgTimestamp(a) < msgTimestamp(b) ? a : b);
      let oldestTime = msgTimestamp(oldest);
      let cursorId = serial(oldest.id);
      const seenIds = new Set(candidates.map((m) => serial(m.id)));

      // If this target predates the messages currently in memory, page backward in
      // chunks. WA-JS returns older messages and openChatAt can then load around the
      // closest result, even when that message was not in the original message store.
      for (let pageNo = 0; oldestTime > target && pageNo < 80; pageNo++) {
        if (isCancelled && isCancelled()) return null;
        if (onProgress) onProgress(pageNo + 1);
        const page = await WPP.chat.getMessages(chatId, { count: 100, direction: 'before', id: cursorId });
        if (isCancelled && isCancelled()) return null;
        if (!Array.isArray(page) || !page.length) break;
        const pageMessages = page.filter((m) => m && m.type !== 'revoked' && serial(m.id));
        if (!pageMessages.length) break;
        for (const m of pageMessages) {
          const id = serial(m.id);
          if (serial(m.id.remote) === chatId && !seenIds.has(id)) { candidates.push(m); seenIds.add(id); }
        }
        const pageOldest = pageMessages.reduce((a, b) => msgTimestamp(a) < msgTimestamp(b) ? a : b);
        const nextTime = msgTimestamp(pageOldest), nextId = serial(pageOldest.id);
        if (!nextId || nextId === cursorId || nextTime >= oldestTime) break;
        oldest = pageOldest; oldestTime = nextTime; cursorId = nextId;
        const sameDayFound = candidates.some((m) => {
          const a = new Date(msgTimestamp(m)), b = new Date(target);
          return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
        });
        if (sameDayFound && nextTime < target - 86400000) break;
        if (pageNo % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return closestMsgByTime(candidates, target);
    } catch { return null; }
  }

  async function verifyJumpTarget(r, run) {
    for (let i = 0; i < 25; i++) {
      if (run.cancelled) return false;
      decorate();
      const main = document.querySelector('#main') || document;
      const ctx = chatContext();
      let target = null;
      for (const row of main.querySelectorAll('[data-id]')) {
        const rec = cacheGet(row.getAttribute('data-id'), ctx && ctx.chatId, ctx && ctx.times);
        if (rec && rec.id === r.id) { target = row.closest('[role="row"]') || row; break; }
      }
      const ghost = ghosts.get(r.id);
      if (!target && ghost && ghost.isConnected) target = ghost;
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.remove('wadl-flash');
        void target.offsetWidth;
        target.classList.add('wadl-flash');
        setTimeout(() => target.classList.remove('wadl-flash'), 1900);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  async function jumpTo(r, card) {
    if (card.classList.contains('busy')) return;
    if (activeJump) { toast('Jump already running', 'Cancel the current search before starting another one.', 'edit'); return; }
    const run = { cancelled: false };
    activeJump = run;
    card.classList.add('busy');
    const progress = el('div', 'wadl-jump-progress');
    const label = el('span', null, 'Opening message…');
    const cancel = el('button', 'wadl-jump-cancel', 'Cancel');
    cancel.onclick = (e) => { e.stopPropagation(); run.cancelled = true; label.textContent = 'Cancelling…'; };
    progress.append(label, cancel);
    card.appendChild(progress);
    const report = (text) => { label.textContent = text; };
    const recordResult = (step, chat, verified) => {
      lastJump = { id: r.mid, step, chat: chat || null, verified, at: new Date().toISOString() };
    };
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
      const chats = chatCandidates(r);
      const live = findLiveMsgId(r);
      const ids = [{ id: r.id, step: 'exact-id' }];
      if (live && live.id && live.id !== r.id) ids.push({ id: live.id, step: 'live-id' });
      const attempted = new Set();

      // 1–2. Try the stored id, then WhatsApp's current live id, with each known chat id form.
      for (const chat of chats) for (const item of ids) {
        if (run.cancelled) break;
        const key = `${chat}|${item.id}`;
        if (attempted.has(key)) continue;
        attempted.add(key);
        report(item.step === 'exact-id' ? 'Opening the original message…' : 'Trying WhatsApp’s current message ID…');
        try {
          if (await WPP.chat.openChatAt(chat, item.id)) {
            report('Checking the message…');
            if (await verifyJumpTarget(r, run)) { recordResult(item.step, chat, true); closePanel(); return; }
          }
        } catch {}
      }

      if (run.cancelled) { recordResult('cancelled', null, false); return; }

      // 3. A saved previous-message anchor is more precise than guessing from time.
      if (r.prevId) for (const chat of chats) {
        if (run.cancelled) break;
        report('Opening the nearby saved message…');
        try {
          if (await WPP.chat.openChatAt(chat, r.prevId)) {
            report('Checking the deleted message…');
            if (await verifyJumpTarget(r, run)) { recordResult('previous-message-anchor', chat, true); closePanel(); return; }
          }
        } catch {}
      }

      if (run.cancelled) { recordResult('cancelled', null, false); return; }

      // 4. Page history and choose the last message before the target, preferably on its day.
      let near = null;
      for (const chat of chats) {
        if (run.cancelled) break;
        report('Finding the closest message…');
        near = await nearestLiveMsgId(r, chat, (page) => report(`Searching chat history… ${page}/80`), () => run.cancelled);
        if (!near) continue;
        report('Opening the closest earlier message…');
        try {
          if (await WPP.chat.openChatAt(near.chat, near.id)) {
            report('Checking the deleted message…');
            if (await verifyJumpTarget(r, run)) { recordResult('time-neighbor', near.chat, true); closePanel(); return; }
          }
        } catch {}
      }

      if (run.cancelled) { recordResult('cancelled', null, false); return; }

      // 5. Load the latest window first, then make one final time-based attempt.
      let openedChat = null;
      for (const chat of chats) {
        if (run.cancelled) break;
        report('Opening the chat…');
        try {
          await WPP.chat.openChatBottom(chat);
          openedChat = chat;
          await pause(450);
          near = await nearestLiveMsgId(r, chat, (page) => report(`Searching chat history… ${page}/80`), () => run.cancelled);
          if (near && await WPP.chat.openChatAt(near.chat, near.id)) {
            report('Checking the deleted message…');
            if (await verifyJumpTarget(r, run)) { recordResult('time-neighbor-after-loading-chat', near.chat, true); closePanel(); return; }
          }
        } catch {}
      }

      if (run.cancelled) { recordResult('cancelled', null, false); return; }
      if (openedChat) {
        recordResult('chat-bottom', openedChat, false);
        closePanel();
        toast('Opened the chat', 'I opened the chat, but could not verify the message location.', 'edit');
      } else {
        recordResult('failed', null, false);
        toast("Couldn't open that chat", 'It may have been deleted or archived on this device.', 'edit');
      }
    } catch (e) {
      recordResult('error', null, false);
      log('jumpTo failed', e);
      toast("Couldn't open that message", 'Venwhatsapp hit an error while searching this chat.', 'edit');
    } finally {
      progress.remove();
      card.classList.remove('busy');
      if (activeJump === run) activeJump = null;
    }
  }

  function cardFor(r) {
    const card = el('div', 'wadl-card');
    const who = (r.sender && r.sender !== 'unknown') ? r.sender : (r.chat || '?');
    const av = el('div', 'wadl-av', (who.trim().charAt(0) || '?').toUpperCase());
    av.style.background = `hsl(${hash(who) % 360} 42% 40%)`;
    card.appendChild(av);
    loadAvatar(av, r);

    const cb = el('div', 'wadl-cb');
    const r1 = el('div', 'wadl-r1');
    r1.appendChild(el('span', 'wadl-sender', r.sender || 'unknown'));
    if (r.deleted) r1.appendChild(el('span', 'wadl-chip del', 'DELETED'));
    if (r.edits && r.edits.length) r1.appendChild(el('span', 'wadl-chip edit', `EDITED ×${r.edits.length + 1}`));
    const when = el('span', 'wadl-when', fmtTime(eventTime(r)));
    when.title = `Sent ${fmtDateTime(r.t)}` + (r.deleted ? `\nDeleted ${fmtDateTime(r.deletedAt)}` : '');
    r1.appendChild(when);
    if (r.body) {
      const cp = el('button', 'wadl-ib sm'); cp.title = 'Copy text'; cp.appendChild(icon('copy', 16));
      cp.onclick = () => { try { navigator.clipboard.writeText(r.body); cp.title = 'Copied!'; setTimeout(() => { cp.title = 'Copy text'; }, 1500); } catch {} };
      r1.appendChild(cp);
    }
    cb.appendChild(r1);
    cb.appendChild(el('div', 'wadl-chat', inWhere(r)));

    if (r.edits && r.edits.length) {
      const parts = buildHistoryParts(r, r.id);
      const historyRow = el('div', 'wadl-card-history-row');
      historyRow.appendChild(parts.button);
      cb.append(historyRow, parts.history);
    }

    if (r.media && r.media.blob) {
      const url = URL.createObjectURL(r.media.blob); objectUrls.push(url);
      const mt = r.media.mime || '';
      let m = null;
      if (mt.startsWith('image')) m = el('img');
      else if (mt.startsWith('video')) { m = el('video'); m.controls = true; }
      else if (mt.startsWith('audio')) { m = el('audio'); m.controls = true; }
      if (m) { m.src = url; cb.appendChild(m); }
      else { const a = el('a', 'file', '⬇ ' + (r.media.name || 'download file')); a.href = url; a.download = r.media.name || 'file'; cb.appendChild(a); }
    }

    if (r.unknownContent) cb.appendChild(el('div', 'wadl-text none', "Content wasn't logged: this message arrived before Venwhatsapp was running."));
    else if (r.body || !(r.media && r.media.blob)) cb.appendChild(el('div', 'wadl-text' + (r.deleted ? ' del' : ''), r.body || `[${r.type}]`));

    card.appendChild(cb);

    card.tabIndex = 0;
    card.title = 'Open this chat at the message';
    card.onclick = (e) => { if (e.target.closest('button,a,video,audio')) return; jumpTo(r, card); };
    card.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); jumpTo(r, card); } };
    return card;
  }

  function emptyState(msg) {
    const d = el('div', 'wadl-empty');
    d.appendChild(icon('trash', 44));
    d.appendChild(el('div', null, msg));
    return d;
  }

  async function renderList() {
    if (!panel) return;
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls = [];
    if (!db) {
      listEl.replaceChildren(emptyState(dbError ? 'The local log is unavailable. Close other WhatsApp Web tabs and reload Venwhatsapp.' : 'Opening the local log…'));
      subEl.textContent = dbError ? 'Local log unavailable' : 'Starting…';
      return;
    }

    const all = (await dbAll()).filter((r) => !r.unknownContent && (r.deleted || (r.edits && r.edits.length)));
    const nDel = all.filter((r) => r.deleted).length;
    const nEdit = all.filter((r) => r.edits && r.edits.length).length;
    tabEls.all.c.textContent = String(all.length);
    tabEls.deleted.c.textContent = String(nDel);
    tabEls.edited.c.textContent = String(nEdit);
    subEl.textContent = `${nDel} deleted · ${nEdit} edited`;

    let rows = all.filter((r) => view.tab === 'all' || (view.tab === 'deleted' ? r.deleted : (r.edits && r.edits.length)));
    if (view.q) {
      rows = rows.filter((r) => [r.body, r.sender, r.chat, ...(r.edits || []).map((e) => e.body)].some((x) => x && String(x).toLowerCase().includes(view.q)));
    }
    rows.sort((a, b) => eventTime(b) - eventTime(a));

    listEl.textContent = '';
    if (!rows.length) {
      listEl.appendChild(emptyState(all.length
        ? 'No matches.'
        : 'Nothing here yet. Messages deleted or edited while Venwhatsapp is running will show up here.'));
      return;
    }
    let lastDay = '';
    for (const r of rows) {
      const day = dayLabel(eventTime(r));
      if (day !== lastDay) { listEl.appendChild(el('div', 'wadl-day', day)); lastDay = day; }
      listEl.appendChild(cardFor(r));
    }
  }

  async function exportJSON() {
    if (!db) { toast('Local log unavailable', 'The local database could not be opened.', 'edit'); return; }
    const all = await dbAll();
    const out = [];
    for (const r of all) {
      out.push({ ...r, media: r.media ? { mime: r.media.mime, name: r.media.name, dataUrl: await blobToDataURL(r.media.blob) } : null });
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    a.download = `venwhatsapp-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }
  const blobToDataURL = (b) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });

  /* ---------- in-chat rendering (Vencord MessageLogger style) ---------- */
  function isDark() {
    const h = document.documentElement.classList, b = document.body.classList;
    if (h.contains('dark') || b.contains('dark')) return true;
    if (h.contains('light') || b.contains('light')) return false;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor || '');
    return m ? (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) < 128 : true;
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function editBodies(rec) {
    return (rec.edits || []).map((edit) => typeof edit === 'string' ? edit : (edit && typeof edit.body === 'string' ? edit.body : ''));
  }

  function historySignature(rec) {
    const bodies = editBodies(rec);
    bodies.push(rec.body || '');
    return bodies.map((body) => `${body.length}:${hash(body)}`).join('|');
  }

  function buildHistoryParts(rec, id) {
    if (!rec.edits || !rec.edits.length) return null;
    const open = expandedHistory.has(id);
    const button = el('button', 'wadl-history-toggle');
    button.type = 'button';
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Hide edit history' : 'Show edit history');
    const label = el('span', null, open ? 'Hide' : 'History');
    button.append(label, icon('chevron', 14));

    const history = el('div', 'wadl-history' + (open ? ' open' : ''));
    const inner = el('div', 'wadl-history-inner');
    for (const [index, body] of editBodies(rec).entries()) {
      const item = el('div', 'wadl-history-item');
      item.appendChild(el('span', 'wadl-history-tag', index === 0 ? 'Original' : `Version ${index + 1}`));
      item.appendChild(el('div', 'wadl-history-text', body));
      inner.appendChild(item);
    }
    const current = el('div', 'wadl-history-item wadl-history-current');
    current.appendChild(el('span', 'wadl-history-tag', 'Current ↓'));
    inner.appendChild(current);
    history.appendChild(inner);

    button.onclick = (event) => {
      event.stopPropagation();
      const nextOpen = !expandedHistory.has(id);
      if (nextOpen) expandedHistory.add(id); else expandedHistory.delete(id);
      button.setAttribute('aria-expanded', String(nextOpen));
      button.setAttribute('aria-label', nextOpen ? 'Hide edit history' : 'Show edit history');
      label.textContent = nextOpen ? 'Hide' : 'History';
      history.classList.toggle('open', nextOpen);
    };
    return { button, history };
  }

  function buildMessageHead(rec, id) {
    const edits = rec.edits || [];
    if (!rec.deleted && !edits.length) return null;
    const head = el('div', 'wadl-message-head');
    head.dataset.wadlKey = historySignature(rec);
    if (rec.deleted) {
      const row = el('div', 'wadl-status-row wadl-status-del');
      row.append(icon('trash', 14), el('b', null, 'Deleted message'));
      head.appendChild(row);
    }
    if (edits.length) {
      const row = el('div', 'wadl-status-row wadl-status-edit');
      const parts = buildHistoryParts(rec, id);
      row.append(icon('edit', 14), el('b', null, 'Edited'), el('span', 'wadl-status-count', `· ${edits.length + 1} versions`));
      if (parts) row.appendChild(parts.button);
      head.appendChild(row);
      if (parts) head.appendChild(parts.history);
    }
    for (const eventName of ['click', 'pointerdown', 'mousedown', 'dblclick']) {
      head.addEventListener(eventName, (event) => event.stopPropagation());
    }
    return head;
  }

  /* Deleted: hide WhatsApp's "This message was deleted" placeholder and draw our own bubble with the
     original content in red. Edited: put the previous versions in grey above the current text. */
  const PLACEHOLDER_RE = /(this message was deleted|you deleted this message|message was deleted|deleted this message|se elimin[oó] este mensaje|este mensaje fue eliminado|eliminaste este mensaje|esta mensagem foi apagada|esta mensagem foi eliminada|voc[eê] apagou esta mensagem|vous avez supprim[eé] ce message|ce message a [eé]t[eé] supprim[eé]|diese nachricht wurde gel[oö]scht|du hast diese nachricht gel[oö]scht|questo messaggio [eè] stato eliminato|hai eliminato questo messaggio)/i;

  /* WhatsApp swaps a deleted message's content for an italic "This message was deleted". Find that text. */
  function findPlaceholder(row) {
    let found = null;
    for (const n of row.querySelectorAll('span,div')) {
      if (n.closest('.wadl-inline,.wadl-row')) continue;
      let own = '';
      for (const c of n.childNodes) if (c.nodeType === 3) own += c.textContent;
      own = own.trim();
      if (!own && n.childElementCount === 0) own = (n.textContent || '').trim();
      if (own && own.length < 80 && PLACEHOLDER_RE.test(own)) found = n;    // last match: the bubble's own text comes after any quoted preview
    }
    return found;
  }

  const hideNode = (n) => n.setAttribute('data-wadl-hid', '1');
  function cleanupBubble(row) { row.querySelectorAll(':scope > .wadl-row').forEach((n) => n.remove()); row.classList.remove('wadl-hide'); }

  function mediaEl(rec) {
    if (!(rec.media && rec.media.blob)) return null;
    const url = URL.createObjectURL(rec.media.blob), mt = rec.media.mime || '';
    let m = null;
    if (mt.startsWith('image')) m = el('img');
    else if (mt.startsWith('video')) { m = el('video'); m.controls = true; }
    else if (mt.startsWith('audio')) { m = el('audio'); m.controls = true; }
    if (m) { m.src = url; return m; }
    const a = el('a', null, '⬇ ' + (rec.media.name || 'file')); a.href = url; a.download = rec.media.name || 'file';
    return a;
  }

  function buildInline(rec) {
    const box = el('div', 'wadl-inline');
    box.dataset.wadlKey = historySignature(rec);
    const head = buildMessageHead(rec, rec.id);
    if (head) box.appendChild(head);
    const m = mediaEl(rec);
    if (m) box.appendChild(m);
    if (rec.body || !m) box.appendChild(el('div', null, rec.body || `[${rec.type}]`));
    return box;
  }

  /* Preferred: keep WhatsApp's own bubble (shape, time, ticks, reply preview) and swap only the
     "deleted" text for the original, in red. Returns what it did (shown in venwhatsapp.debug()). */
  function renderDeleted(row, rec) {
    const ph = findPlaceholder(row);
    if (rec.unknownContent) {                              // we never saw the original: at least turn WhatsApp's own text red
      if (ph && !ph.hasAttribute('data-wadl-red')) ph.setAttribute('data-wadl-red', '1');
      return ph ? 'red-placeholder' : 'row-found-but-no-placeholder-text';
    }
    if (ph) {
      if (row.classList.contains('wadl-hide') || row.querySelector(':scope > .wadl-row')) cleanupBubble(row);
      const current = row.querySelector('.wadl-inline');
      if (current && current.dataset.wadlKey !== historySignature(rec)) current.replaceWith(buildInline(rec));
      else if (!current) {
        hideNode(ph);
        row.querySelectorAll('[data-icon*="recall"],[data-icon*="deleted"]').forEach(hideNode);
        ph.parentNode.insertBefore(buildInline(rec), ph.nextSibling);
      }
      return 'inline';
    }
    if (row.querySelector('.wadl-inline')) return 'inline';  // our text is still in place
    if (Date.now() - (rec.deletedAt || 0) < 2500) return 'waiting';  // WhatsApp hasn't swapped in its placeholder yet
    renderDeletedBubble(row, rec);                         // last resort: draw our own bubble in the row
    return 'bubble';
  }

  function buildBubbleWrap(rec) {
    const wrap = el('div', 'wadl-row ' + (rec.fromMe ? 'out' : 'in'));
    wrap.dataset.wadlKey = historySignature(rec);
    const bub = el('div', 'wadl-bubble ' + (rec.fromMe ? 'out' : 'in'));
    if (!rec.fromMe && /@g\.us$/.test(rec.chatId || '')) bub.appendChild(el('div', 'wadl-name', rec.sender));
    const head = buildMessageHead(rec, rec.id);
    if (head) bub.appendChild(head);
    const m = mediaEl(rec);
    if (m) bub.appendChild(m);
    if (rec.unknownContent) bub.appendChild(el('div', 'wadl-prev', "Deleted message (content wasn't logged)"));
    else if (rec.body || !m) bub.appendChild(el('div', 'wadl-del', rec.body || `[${rec.type}]`));
    const meta = el('div', 'wadl-meta-row');
    meta.appendChild(el('span', null, 'deleted'));
    meta.appendChild(el('span', null, new Date(rec.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
    bub.appendChild(meta);
    wrap.appendChild(bub);
    return wrap;
  }

  function renderDeletedBubble(row, rec) {
    if (!row.classList.contains('wadl-hide')) row.classList.add('wadl-hide');
    const current = row.querySelector(':scope > .wadl-row');
    if (current) {
      if (current.dataset.wadlKey !== historySignature(rec)) current.replaceWith(buildBubbleWrap(rec));
      return;
    }
    row.appendChild(buildBubbleWrap(rec));
  }

  /* ---------- deleted messages whose row WhatsApp doesn't label with the original id ----------
     Maybe the "deleted" row carries a different id, or there is no row at all. Work out where the message
     belongs from its position/time among the messages WhatsApp has loaded for the open chat, then either
     take over the stray "deleted" row sitting there, or insert our own row. */
  const ghosts = new Map();        // rec.id -> inserted element
  const placement = new Map();     // rec.id -> what happened (venwhatsapp.debug())
  let ctxCache = { at: 0, val: null };

  function chatContext() {
    if (Date.now() - ctxCache.at < 700) return ctxCache.val;
    let val = null;
    try {
      const c = WPP.chat.getActiveChat();
      if (c && c.msgs) {
        const arr = c.msgs.getModelsArray ? c.msgs.getModelsArray() : (c.msgs.models || []);
        const times = new Map(); let maxLive = 0;
        for (const m of arr) {
          const t = m.t || 0;
          times.set(midOf(serial(m.id)), t);
          if (m.type !== 'revoked' && t > maxLive) maxLive = t;
        }
        const first = arr[0];
        const chatId = serial(c.id) || serial(c.wid) || (first && serial(first.id && first.id.remote)) || null;
        val = { chatId, times, maxLive };
      }
    } catch { val = null; }
    ctxCache = { at: Date.now(), val };
    return val;
  }

  function listRows(main) {
    const seen = new Set(), out = [];
    for (const n of main.querySelectorAll('[data-id], [role="row"]')) {
      const wrap = n.closest('[role="row"]') || n;
      if (seen.has(wrap)) continue;
      seen.add(wrap);
      const idEl = wrap.hasAttribute('data-id') ? wrap : wrap.querySelector('[data-id]');
      out.push({ wrap, idEl, mid: idEl ? midOf(idEl.getAttribute('data-id')) : null });
    }
    return out;
  }

  function ghostFor(rec) {
    let g = ghosts.get(rec.id);
    if (!g) { g = el('div', 'wadl-ghost'); g.setAttribute('data-wadl-ghost', rec.id); g.appendChild(buildBubbleWrap(rec)); ghosts.set(rec.id, g); }
    return g;
  }

  function dropGhosts(keep) {
    for (const [id, g] of ghosts) if (!keep.has(id)) { g.remove(); ghosts.delete(id); }
  }

  function placeUnmatched(unmatched) {
    const keep = new Set();
    const ctx = unmatched.length ? chatContext() : null;
    const main = document.querySelector('#main');
    if (ctx && main) {
      const rows = listRows(main).map((r) => Object.assign(r, { t: r.mid && ctx.times.has(r.mid) ? ctx.times.get(r.mid) : null }));
      const wanted = unmatched
        .filter((r) => {
          const anchorMid = r.prevId && midOf(r.prevId);
          const hasAnchor = anchorMid && ctx.times.has(anchorMid);
          const hasLiveTarget = ctx.times.has(r.mid);
          const sameChat = !ctx.chatId || r.chatId === ctx.chatId || hasLiveTarget || hasAnchor;
          return sameChat && (hasLiveTarget || hasAnchor || (!!ctx.chatId && Number(r.t) > 0 && r.chatId === ctx.chatId));
        })
        .map((rec) => ({ rec, t: ctx.times.has(rec.mid) ? ctx.times.get(rec.mid) : (Number(rec.t) || 0) / 1000 }))
        .sort((x, y) => x.t - y.t || String(x.rec.id).localeCompare(String(y.rec.id)));
      const claimed = new Set(), gapTail = new Map();
      for (const { rec, t } of wanted) {
        let prev = -1, next = -1;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].t == null) continue;
          if (rows[i].t <= t) prev = i; else { next = i; break; }
        }
        const anchorMid = rec.prevId && midOf(rec.prevId);
        const anchorIndex = anchorMid ? rows.findIndex((row) => row.mid === anchorMid) : -1;
        if (anchorIndex >= 0) {
          prev = anchorIndex;
          if (next <= prev) next = rows.findIndex((row, i) => i > prev && row.t != null && row.t > t);
        }
        if (prev === -1) { placement.set(rec.id, 'not-in-view (older than the loaded messages)'); continue; }
        if (next === -1 && rows[prev].t < ctx.maxLive) { placement.set(rec.id, 'not-in-view (newer messages are not loaded)'); continue; }

        const gap = rows.slice(prev + 1, next === -1 ? rows.length : next);
        const stray = gap.find((r) => !claimed.has(r.wrap) && findPlaceholder(r.wrap));
        if (stray) {                                                  // WhatsApp did draw a "deleted" row, just under another id
          claimed.add(stray.wrap);
          placement.set(rec.id, 'paired-with-stray-row:' + renderDeleted(stray.wrap, rec));
          continue;
        }
        const g = ghostFor(rec);
        const anchor = gapTail.get(prev) || rows[prev].wrap;
        if (!g.isConnected || g.previousElementSibling !== anchor) anchor.after(g);
        gapTail.set(prev, g);
        keep.add(rec.id);
        placement.set(rec.id, 'inserted-row');
      }
    }
    dropGhosts(keep);
  }

  const topChild = (host, node) => { let n = node; while (n.parentElement && n.parentElement !== host) n = n.parentElement; return n; };

  /* Where the message's OWN text is. In a reply, the quoted preview also contains selectable text and comes
     first, so the first match is the wrong one; the element carrying data-pre-plain-text is the real message. */
  function mainTextSpot(row) {
    const pre = row.querySelector('[data-pre-plain-text]');
    if (pre) {
      const t = pre.querySelector('.selectable-text');
      if (t) return { host: pre, anchor: topChild(pre, t) };
    }
    const all = row.querySelectorAll('span.selectable-text.copyable-text, .selectable-text');
    const last = all[all.length - 1];                       // quote text is earlier in the DOM, the message's own text last
    if (last && last.parentElement) return { host: last.parentElement, anchor: last };
    return null;
  }

  function renderEdits(row, rec) {
    if (!rec.edits || !rec.edits.length) return;
    const spot = mainTextSpot(row);
    if (!spot) return;
    const { host, anchor } = spot;
    const key = historySignature(rec);
    const current = host.querySelector(':scope > .wadl-message-head');
    if (current && current.dataset.wadlKey === key) return;
    row.querySelectorAll('.wadl-message-head,.wadl-prev').forEach((x) => x.remove());
    const head = buildMessageHead(rec, rec.id);
    if (head) host.insertBefore(head, anchor);
    host.setAttribute('data-wadl-history', key);
  }

  function decorate() {
    try {
      document.documentElement.setAttribute('data-wadl-theme', isDark() ? 'dark' : 'light');
      ensureNav();
      if (!cache.size) return;
      const main = document.querySelector('#main');
      const ctx = chatContext();
      const activeChatId = ctx && ctx.chatId;
      const matched = new Set();
      for (const row of (main || document).querySelectorAll('[data-id]')) {
        const rec = cacheGet(row.getAttribute('data-id'), activeChatId, ctx && ctx.times);
        if (!rec) continue;
        if (rec.deleted) { placement.set(rec.id, 'row:' + renderDeleted(row, rec)); matched.add(rec.id); } else renderEdits(row, rec);
      }
      const unmatched = [];
      for (const r of cache.values()) {
        if (!r.deleted || matched.has(r.id)) continue;
        const inCurrentContext = ctx && (ctx.times.has(r.mid) || (r.prevId && ctx.times.has(midOf(r.prevId))));
        if (activeChatId && r.chatId !== activeChatId && !inCurrentContext) continue;
        unmatched.push(r);
      }
      placeUnmatched(unmatched);
    } catch (e) { log('decorate failed', e); }
  }

  let decoTimer = null;
  const scheduleDecorate = () => { if (decoTimer) return; decoTimer = setTimeout(() => { decoTimer = null; decorate(); }, 120); };

  /* Fix entries saved by v0.2.0/0.2.1 where a media thumbnail was mistaken for text. */
  function repairRecord(r) {
    let changed = false;
    if (r.type !== 'chat' && looksLikeThumb(r.body)) {
      const last = (r.edits || []).pop();           // that "edit" was bogus: the last saved text was the real body
      r.body = last && !looksLikeThumb(last.body) ? last.body : '';
      changed = true;
    }
    const clean = (r.edits || []).filter((e) => !looksLikeThumb(e.body));
    if (clean.length !== (r.edits || []).length) { r.edits = clean; changed = true; }
    return changed;
  }

  /* ---------- boot ----------
     Phase 1 (startCapture): only the log pipeline. Runs the moment WhatsApp's internals exist, before any
     UI work, so the burst of messages WhatsApp processes on reconnect is caught.
     Phase 2 (init): load the log, build the UI, start decorating chats. */
  let captureStarted = false;
  function startCapture() {
    if (captureStarted) return true;
    try {
      if (!(window.WPP && WPP.whatsapp && WPP.whatsapp.MsgStore)) return false;
      installHooks();
      if (!hooksInstalled) return false;
      captureStarted = true;
      WPP.on('chat.new_message', (m) => queueMessage(m, 'live'));
      WPP.on('chat.msg_revoke', (ev) => enqueue(() => onRevoke(ev, { src: 'wa-js' })));
      WPP.on('chat.msg_edited', (ev) => enqueue(() => onEdit(ev)));
      sweep();                                   // anything WhatsApp had already loaded before our hooks existed
      tl('capture', { started: true, afterMs: Date.now() - T0 });
    } catch (e) { log('startCapture failed', e); }
    return captureStarted;
  }

  function waitForDocumentElements() {
    if (document.head && document.body) return Promise.resolve();
    return new Promise((resolve) => {
      let observer = null, done = false;
      const check = () => {
        if (done || !document.head || !document.body) return;
        done = true;
        if (observer) observer.disconnect();
        document.removeEventListener('DOMContentLoaded', check);
        resolve();
      };
      document.addEventListener('DOMContentLoaded', check, { once: true });
      observer = new MutationObserver(check);
      observer.observe(document, { childList: true, subtree: true });
      if (document.readyState !== 'loading') setTimeout(check, 0);
    });
  }

  async function init() {
    await waitForDocumentElements();
    startCapture();                              // no-op if phase 1 already ran
    buildUI();
    refreshBadge();

    setInterval(sweep, 10000);
    new MutationObserver(scheduleDecorate).observe(document.body, { childList: true, subtree: true });
    setInterval(decorate, 1500);   // fallback in case React resets things
    try { WPP.on('chat.active_chat', () => { ctxCache.at = 0; for (const ms of [150, 700, 1800]) setTimeout(decorate, ms); }); } catch {}

    await dbReady;
    let nDel = 0, nEdit = 0;
    if (db) await enqueue(async () => {           // same queue as capture, so repairs can't overwrite a fresh save
      for (const r of await dbAll()) {
        let dirty = repairRecord(r);
        if (!r.mid) { r.mid = midOf(r.id); dirty = true; }
        if (dirty) await dbPut(r);
        if (r.deleted) { deletedIds.add(r.id); if (!r.unknownContent) nDel++; }
        if (r.edits && r.edits.length) nEdit++;
        if (r.deleted || (r.edits && r.edits.length)) cachePut(r);
      }
    });
    else {
      subEl.textContent = 'Local log unavailable';
      toast('Venwhatsapp storage unavailable', dbError && dbError.message || 'The local database could not be opened.', 'edit');
    }
    refreshBadge();

    decorate();                    // apply everything already in the log to whatever is on screen

    const skeleton = (node) => {
      const c = node.cloneNode(true);
      const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) n.textContent = n.textContent.trim() ? `[${n.textContent.trim().length} chars]` : '';
      const keepAttrs = ['class', 'data-icon', 'role', 'aria-label', 'data-wadl-hid', 'data-wadl-red', 'data-wadl-n'];
      c.querySelectorAll('*').forEach((e) => { for (const a of [...e.attributes]) if (!keepAttrs.includes(a.name)) e.removeAttribute(a.name); });
      return c.outerHTML.slice(0, 4000);
    };
    const shape = (id) => String(id).replace(/\d{6,}/g, '<num>').replace(/[0-9A-F]{16,}/gi, '<hex>');

    window.venwhatsapp = {
      rescan: decorate,
      timeline(n) { const rows = timelineBuf.slice(-(n || 80)); console.table(rows); return timelineBuf.slice(); },
      /* Structure of on-screen deleted/edited rows, and of any "deleted" row we could NOT match to the log,
         with all message text blanked out: safe to paste when reporting a layout problem. */
      inspect() {
        const out = [];
        for (const row of document.querySelectorAll('[data-id]')) {
          const rec = cacheGet(row.getAttribute('data-id'));
          if (rec && out.length < 2) out.push({ kind: rec.deleted ? (rec.unknownContent ? 'deleted (content not logged)' : 'deleted') : 'edited', dataId: shape(row.getAttribute('data-id')), html: skeleton(row) });
        }
        const main = document.querySelector('#main') || document.body;
        let extra = 0;
        for (const r of listRows(main)) {
          if (extra >= 2) break;
          if ((!r.mid || !cacheMid.has(r.mid)) && findPlaceholder(r.wrap)) {
            out.push({ kind: 'WhatsApp "deleted" row NOT matched to the log', dataId: r.idEl ? shape(r.idEl.getAttribute('data-id')) : '(no data-id)', html: skeleton(r.wrap) });
            extra++;
          }
        }
        console.log('[Venwhatsapp] inspect', out);
        return out;
      },
      debug() {
        const rows = [...document.querySelectorAll('[data-id]')];
        const matched = rows.filter((r) => cacheGet(r.getAttribute('data-id')));
        const ctx = chatContext();
        const out = {
          restoredFromLog: { deleted: nDel, edited: nEdit },
          captureStarted, hooksInstalled, databaseReady: !!db, databaseError: dbError && dbError.message,
          lastJump,
          navButtonMounted: !!(navWrap && navWrap.isConnected),
          fallbackButtonShown: !!(fab && fab.style.display === 'flex'),
          rowsOnScreen: rows.length,
          rowsMatchedToLog: matched.length,
          openChatKnown: !!ctx,
          deletedMessages: [...cache.values()].filter((r) => r.deleted).slice(-8).map((r) => ({
            id: r.mid, contentSaved: !r.unknownContent,
            status: placement.get(r.id) || (ctx ? (ctx.times.has(r.mid) ? 'in-open-chat, not placed yet' : 'not in the open chat') : 'no chat open / chat info unavailable')
          })),
          sampleDomIds: rows.slice(0, 3).map((r) => shape(r.getAttribute('data-id'))),
          sampleLoggedIds: [...cache.keys()].slice(0, 3).map(shape),
          profilePictures: pfpStats
        };
        console.log('[Venwhatsapp] debug', out);
        return out;
      }
    };
    log(db ? `ready — restored ${nDel} deleted and ${nEdit} edited messages from the log` : 'UI ready, but the local database is unavailable');
  }

  let booted = false;
  const boot = () => { if (booted) return; booted = true; init().catch((e) => log('init failed', e)); };

  // Don't make the UI depend on wa-js exposing its ready callback. Capture keeps polling
  // independently, while the DOM-ready path guarantees the drawer can still mount.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else setTimeout(boot, 0);

  // Phase 1: as early as possible. WhatsApp's own "injected" signal plus a fast poll, whichever comes first.
  if (window.WPP && WPP.loader && typeof WPP.loader.onInjected === 'function') { try { WPP.loader.onInjected(startCapture); } catch {} }
  const fastPoll = setInterval(() => { if (startCapture()) clearInterval(fastPoll); }, 15);
  setTimeout(() => clearInterval(fastPoll), 5 * 60 * 1000);

  // Phase 2: once WhatsApp has finished loading.
  const bootPoll = setInterval(() => {
    if (booted) { clearInterval(bootPoll); return; }
    if (window.WPP && WPP.loader && typeof WPP.loader.onReady === 'function') {
      clearInterval(bootPoll);
      try { WPP.loader.onReady(boot); } catch (e) { log('wa-js ready hook failed; using DOM startup', e); boot(); }
    }
  }, 50);
})();
