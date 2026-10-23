// PhotoFlix screens. A screen = one TV (e.g. "OPD waiting hall"): a photo slideshow plus a patient token queue.
// Staff phones join with the screen code (from the TV's QR) and a staff PIN; the first phone sets the PIN.
// Patients on the TV can see the QR, so nothing can be changed without the PIN.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { canShrink, shrinkVideo } from './video.js';
import { WebSocketServer } from 'ws';
import { createStore } from './store.js';
import { lambdaOn, lambdaName, queue } from './queue-lambda.js';
import { prepare } from './speech.js';

const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const MAX_PHOTOS = 100; // photos + videos together
const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // as sent by the phone, before shrinking
// Videos come in parts (phone.js is told the size): straight to S3 when there is a bucket (S3 needs >= 5 MB
// parts), else through this server, where small parts keep each request well under Cloudflare's 100 s limit
// even on a slow free link.
const PART_BYTES_S3 = 8 * 1024 * 1024;
const PART_BYTES_HERE = 2 * 1024 * 1024;
const UPLOAD_KEEP_MS = 60 * 60 * 1000; // an upload the phone gave up on is thrown away after this
const MAX_STAFF = 20;
const MAX_QUEUE = 500;
const QR_SHOW_MS = 2 * 60 * 1000; // "Show QR on TV" from a phone
const QR_TV_MS = 5 * 60 * 1000; // OK on the remote; Back hides it sooner
const PIN_TRIES = 5; // wrong PINs per connection before it is cut off

const screens = new Map();
const videoSizes = new Map(); // video id -> bytes (for streaming in parts)
let store = null;

const newId = (n = 10) => crypto.randomBytes(n).toString('base64url').slice(0, n);
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const PHONE_RE = /^\+[1-9]\d{7,14}$/; // patient mobile, with country code (+919876543210)
const cleanPhone = (v) => String(v || '').replace(/[\s()-]/g, '');
// A room number ("1", "2B", "room no 1") reads as "Room 1", as on the TV. "Counter 3" stays as typed.
const ROOM_NO = /^(?:room\s*(?:no\.?|number|#)?\s*)?(\d+[A-Za-z]?)$/i;
const roomText = (r) => { r = String(r || '').trim(); const m = ROOM_NO.exec(r); return m ? 'Room ' + m[1] : r; };
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

// Saved fields only (sockets and timers stay out of storage).
// The screen row; patients are saved one by one (only those in s.changed / s.removed).
const SAVED = ['code', 'name', 'city', 'videoSound', 'room', 'interval', 'voice', 'showNames', 'pin', 'salt', 'staff', 'photos', 'nextToken', 'day', 'created', 'touched'];
const saveTimers = new Map();
function persist(s) {
  s.touched = Date.now();
  if (saveTimers.has(s.code)) return;
  saveTimers.set(s.code, setTimeout(() => {
    saveTimers.delete(s.code);
    const meta = { current: s.current ? { token: s.current.token } : null };
    SAVED.forEach((k) => { meta[k] = s[k]; });
    const changed = [...s.changed];
    const removed = [...s.removed];
    s.changed.clear();
    s.removed.clear();
    store.save(s.code, meta, lambdaOn ? [] : s.queue, lambdaOn ? [] : changed, lambdaOn ? [] : removed).catch((e) => {
      console.error('photoflix: save ' + s.code + ' failed:', e.message);
      changed.forEach((t) => s.changed.add(t)); // try again with the next change
      removed.forEach((t) => s.removed.add(t));
    });
  }, 800));
}
const touch = (s, p) => s.changed.add(p.token);
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, this PC's time zone
// New day (midnight, or "Start new day"): the list is cleared so patient names are not kept, tokens restart at 1.
function newDay(s) {
  s.queue.forEach((p) => s.removed.add(p.token));
  s.queue = [];
  s.current = null;
  s.nextToken = 1;
  s.day = today();
}
function live(data) {
  const s = Object.assign({ name: '', city: '', room: '', interval: 8, voice: true, showNames: true, pin: '', salt: '', staff: [], photos: [], queue: [], nextToken: 1, current: null, day: today(), created: Date.now(), touched: Date.now() }, data, { tvs: new Set(), phones: new Set(), qrUntil: 0, changed: new Set(), removed: new Set() });
  if (s.name === 'Waiting hall') s.name = ''; // old default; the name is optional now
  if (s.current) s.current = s.queue.find((p) => p.token === s.current.token) || null; // same object as in the list
  return s;
}
function newCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += LETTERS[crypto.randomInt(LETTERS.length)];
    if (!screens.has(c)) return c;
  }
  return null;
}

// ------------------------------------------------------------- what each side sees
const waiting = (s) => s.queue.filter((p) => p.status === 'waiting');
function tvState(s) {
  const name = (p) => (p && s.showNames ? p.name : '');
  return {
    t: 'screen',
    code: s.code,
    name: s.name,
    city: s.city, // weather on the TV
    room: s.room, // default room / counter (TV settings box)
    interval: s.interval,
    voice: s.voice,
    paired: s.staff.length > 0,
    showQr: s.staff.length === 0 || s.qrUntil > Date.now(),
    photos: s.photos.map((p) => ({ id: p.id, kind: p.kind || 'image', url: '/media/' + s.code + '/' + p.id })),
    videoSound: !!s.videoSound,
    current: s.current ? { token: s.current.token, name: name(s.current), room: s.current.room, at: s.current.calledAt } : null,
    next: waiting(s).slice(0, 4).map((p) => ({ token: p.token, name: name(p) })),
    waitingCount: waiting(s).length,
  };
}
function staffState(s) {
  return {
    t: 'state',
    code: s.code,
    name: s.name,
    city: s.city,
    room: s.room,
    interval: s.interval,
    voice: s.voice,
    showNames: s.showNames,
    tvOn: s.tvs.size > 0,
    nextToken: s.nextToken,
    current: s.current,
    queue: s.queue,
    photos: s.photos.map((p) => ({ id: p.id, kind: p.kind || 'image', at: p.at, by: p.by, url: '/media/' + s.code + '/' + p.id })),
    videoSound: !!s.videoSound,
    preparing: s.preparing || 0, // videos still being shrunk
    staff: s.staff.map((m) => ({ name: m.name, on: Array.from(s.phones).some((w) => w.staffId === m.id) })),
  };
}
function sync(s) {
  persist(s);
  const tv = tvState(s);
  s.tvs.forEach((w) => send(w, tv));
  const st = staffState(s);
  s.phones.forEach((w) => send(w, st));
}
const toStaff = (s, obj) => s.phones.forEach((w) => send(w, obj));

// ------------------------------------------------------------- queue actions
function call(s, p, room, by) {
  if (s.current && s.current.status === 'called' && s.current.token !== p.token) {
    const prev = s.queue.find((x) => x.token === s.current.token);
    if (prev && prev.status === 'called') { prev.status = 'done'; prev.doneAt = Date.now(); touch(s, prev); }
  }
  touch(s, p);
  p.status = 'called';
  p.calledAt = Date.now();
  p.room = p.assignedRoom || room || s.room; // the patient's own room (chosen when added) comes first
  p.calledBy = by;
  p.calls = (p.calls || 0) + 1;
  s.current = p;
  announce(s, p);
}
// What the TV says: "Token number 12, Ravi Kumar. Please go to room number 2" (same words as tv.js speakCall).
function callSentence(token, name, room) {
  room = String(room || '').trim();
  const m = ROOM_NO.exec(room);
  const where = m ? 'room number ' + m[1] : room;
  return 'Token number ' + token + (name ? ', ' + name : '') + (where ? '. Please go to ' + where : '. Please come in');
}
function announce(s, p) {
  const name = s.showNames ? p.name : '';
  const audio = s.voice ? prepare(callSentence(p.token, name, p.room)) : ''; // made by Amazon Polly; the TV plays it
  s.tvs.forEach((w) => send(w, { t: 'call', token: p.token, name, room: p.room, audio }));
  toStaff(s, { t: 'toast', text: '🔔 Token ' + p.token + ' called' + (p.room ? ' to ' + roomText(p.room) : '') });
}

// ------------------------------------------------------------- queue in the Lambda (PF_LAMBDA set)
async function refresh(s) {
  const r = await queue.list(s.code);
  s.queue = r.queue;
  s.current = r.current;
  s.nextToken = r.nextToken;
}
async function lambdaQueue(ws, s, me, m) {
  const room = clean(m.room, 30) || s.room;
  const token = Number(m.token);
  let called = null;
  switch (m.t) {
    case 'q:add': {
      const phone = cleanPhone(m.phone);
      if (phone && !PHONE_RE.test(phone)) return send(ws, { t: 'toast', text: 'Mobile needs the country code, like +919876543210', bad: true });
      const p = await queue.add(s.code, clean(m.name, 40), phone, me.name, clean(m.room, 30));
      send(ws, { t: 'toast', text: '➕ Token ' + p.token + (p.name ? ' · ' + p.name : '') + ' added' + (p.assignedRoom ? ' → ' + roomText(p.assignedRoom) : '') });
      break;
    }
    case 'q:edit': await queue.edit(s.code, token, clean(m.name, 40), cleanPhone(m.phone), m.room === undefined ? undefined : clean(m.room, 30)); break;
    case 'q:next':
      called = await queue.next(s.code, room, me.name);
      if (!called) send(ws, { t: 'toast', text: 'Nobody is waiting.' });
      break;
    case 'q:call': called = await queue.update(s.code, token, 'CALL', room, me.name); break;
    case 'q:recall': if (s.current) called = await queue.update(s.code, s.current.token, 'CALL', clean(m.room, 30) || s.current.room, me.name); break;
    case 'q:done': await queue.update(s.code, token, 'DONE', room, me.name); break;
    case 'q:skip': await queue.update(s.code, token, 'SKIP', room, me.name); break;
    case 'q:del': await queue.remove(s.code, token); break;
    case 'q:reset':
      await queue.remove(s.code, 'ALL');
      send(ws, { t: 'toast', text: '🌅 New day: tokens start from 1' });
      break;
    default: return;
  }
  await refresh(s);
  if (called) announce(s, called);
  sync(s);
}

function handle(ws, m) {
  if (!m || typeof m.t !== 'string') return;

  if (m.t === 'tv') {
    let s = m.code && screens.get(String(m.code).toUpperCase());
    if (!s) {
      const code = newCode();
      if (!code) return;
      s = live({ code });
      screens.set(code, s);
      persist(s);
      if (lambdaOn) queue.createScreen(code, s.name).catch((e) => console.error('photoflix lambda:', e.message));
    }
    ws.role = 'tv';
    ws.screen = s;
    s.tvs.add(ws);
    // Where to look for the server's new link after this PC restarts (as for phones): the TV moves there by itself.
    if (store.linkReadUrl) store.linkReadUrl().then((url) => send(ws, { t: 'link', url })).catch(() => {});
    sync(s);
    return;
  }

  // Screen name and room typed on the TV itself (remote Menu button). Only these two, nothing else.
  if (m.t === 'tv:settings') {
    const s = ws.role === 'tv' && ws.screen;
    if (!s) return;
    if (m.name !== undefined) s.name = clean(m.name, 40);
    if (m.room !== undefined) s.room = clean(m.room, 30);
    toStaff(s, { t: 'toast', text: '📺 Screen name / room changed on the TV' });
    sync(s);
    return;
  }

  // OK on the remote shows the staff QR, Back hides it (also one shown from a phone).
  // If nobody presses Back, it hides by itself after a few minutes: the TV is in a public room.
  if (m.t === 'tv:qr') {
    const s = ws.role === 'tv' && ws.screen;
    if (!s) return;
    s.qrUntil = m.show ? Date.now() + QR_TV_MS : 0;
    if (m.show) setTimeout(() => sync(s), QR_TV_MS + 500);
    sync(s);
    return;
  }

  // The join page asks first, so it can say "Choose a staff PIN" (new screen) or "Enter the staff PIN".
  if (m.t === 'check') {
    const code = String(m.code || '').toUpperCase().trim();
    const s = screens.get(code);
    return send(ws, { t: 'check', code, found: !!s, hasPin: !!(s && s.pin) });
  }

  if (m.t === 'join') {
    const s = screens.get(String(m.code || '').toUpperCase().trim());
    if (!s) return send(ws, { t: 'err', code: 'noscreen', msg: 'No screen with that code. Check the code on the TV.' });
    let member = m.id && s.staff.find((x) => x.id === String(m.id));
    if (!member) {
      const pin = String(m.pin || '').trim();
      const name = clean(m.name, 24);
      if (!name) return send(ws, { t: 'err', code: 'name', msg: 'Please enter your name.' });
      // A PIN is only ever set on purpose (newPin), never by typing into what looked like a "enter PIN" box.
      if (!s.pin && !m.newPin) return send(ws, { t: 'err', code: 'pin', hasPin: false, msg: 'This is a new screen. Choose a staff PIN for your team.' });
      if (!/^\d{4,6}$/.test(pin)) return send(ws, { t: 'err', code: 'pin', hasPin: !!s.pin, msg: s.pin ? 'Enter the staff PIN (4-6 digits).' : 'Choose a staff PIN (4-6 digits). Other staff will need it to join.' });
      if (s.pin) {
        if (hashPin(pin, s.salt) !== s.pin) {
          ws.badPins = (ws.badPins || 0) + 1;
          if (ws.badPins >= PIN_TRIES) { send(ws, { t: 'err', code: 'pin', msg: 'Too many wrong PINs.' }); return ws.close(); }
          return send(ws, { t: 'err', code: 'pin', hasPin: true, msg: m.newPin ? 'This screen already has a staff PIN. Ask the person who set it up.' : 'Wrong PIN. Ask the person who set up this screen.' });
        }
      } else { // first phone: sets the PIN
        s.salt = newId(16);
        s.pin = hashPin(pin, s.salt);
      }
      if (s.staff.length >= MAX_STAFF) return send(ws, { t: 'err', msg: 'This screen already has ' + MAX_STAFF + ' staff phones.' });
      member = { id: newId(16), name, joined: Date.now() };
      s.staff.push(member);
    }
    ws.role = 'staff';
    ws.screen = s;
    ws.staffId = member.id;
    s.phones.add(ws);
    send(ws, { t: 'welcome', id: member.id, name: member.name, code: s.code });
    // Where to look for the server's new link after this PC restarts (S3 only; phones refresh it on every connect).
    if (store.linkReadUrl) store.linkReadUrl().then((url) => send(ws, { t: 'link', url })).catch(() => {});
    sync(s);
    return;
  }

  const s = ws.screen;
  if (!s || ws.role !== 'staff') return;
  const me = s.staff.find((x) => x.id === ws.staffId);
  if (!me) return send(ws, { t: 'err', code: 'removed', msg: 'This phone was removed from the screen.' });
  const byToken = (t) => s.queue.find((p) => p.token === Number(t));
  if (lambdaOn && m.t.startsWith('q:')) {
    lambdaQueue(ws, s, me, m).catch((e) => {
      console.error('photoflix lambda:', e.message);
      send(ws, { t: 'toast', text: '⚠️ ' + e.message, bad: true });
    });
    return;
  }

  switch (m.t) {
    case 'q:add': { // new patient; the token number is given automatically
      if (s.queue.length >= MAX_QUEUE) return send(ws, { t: 'toast', text: 'The list is full. Start a new day in Settings.', bad: true });
      const phone = cleanPhone(m.phone);
      if (phone && !PHONE_RE.test(phone)) return send(ws, { t: 'toast', text: 'Mobile needs the country code, like +919876543210', bad: true });
      const p = { token: s.nextToken++, name: clean(m.name, 40), phone, assignedRoom: clean(m.room, 30), status: 'waiting', at: Date.now(), by: me.name, order: Date.now() };
      s.queue.push(p);
      touch(s, p);
      send(ws, { t: 'toast', text: '➕ Token ' + p.token + (p.name ? ' · ' + p.name : '') + ' added' + (p.assignedRoom ? ' → ' + roomText(p.assignedRoom) : '') });
      break;
    }
    case 'q:next': { // finish the current patient and call the next one in line
      const p = waiting(s)[0];
      if (!p) {
        if (s.current && s.current.status === 'called') { s.current.status = 'done'; s.current.doneAt = Date.now(); touch(s, s.current); }
        send(ws, { t: 'toast', text: 'Nobody is waiting.' });
        break;
      }
      call(s, p, clean(m.room, 30), me.name);
      break;
    }
    case 'q:call': { const p = byToken(m.token); if (p && p.status !== 'done') call(s, p, clean(m.room, 30), me.name); break; }
    case 'q:recall': // announce the current token again
      if (s.current) call(s, s.current, clean(m.room, 30) || s.current.room, me.name);
      break;
    case 'q:edit': { // change a patient's name / mobile / own room
      const p = byToken(m.token);
      if (!p) break;
      const phone = cleanPhone(m.phone);
      if (phone && !PHONE_RE.test(phone)) return send(ws, { t: 'toast', text: 'Mobile needs the country code, like +919876543210', bad: true });
      p.name = clean(m.name, 40);
      p.phone = phone;
      if (m.room !== undefined) p.assignedRoom = clean(m.room, 30);
      touch(s, p);
      break;
    }
    case 'q:done': { const p = byToken(m.token); if (p) { p.status = 'done'; p.doneAt = Date.now(); touch(s, p); } break; }
    case 'q:skip': { // not here: move to the end of the line
      const p = byToken(m.token);
      if (!p) break;
      s.queue.splice(s.queue.indexOf(p), 1);
      p.status = 'waiting';
      p.skipped = (p.skipped || 0) + 1;
      p.order = Date.now();
      s.queue.push(p);
      touch(s, p);
      if (s.current && s.current.token === p.token) s.current = null;
      break;
    }
    case 'q:del': {
      const i = s.queue.findIndex((p) => p.token === Number(m.token));
      if (i >= 0) { s.queue.splice(i, 1); s.removed.add(Number(m.token)); }
      if (s.current && s.current.token === Number(m.token)) s.current = null;
      break;
    }
    case 'q:reset': // new day: tokens start again at 1
      newDay(s);
      send(ws, { t: 'toast', text: '🌅 New day: tokens start from 1' });
      break;
    case 'photo:del': {
      const i = s.photos.findIndex((p) => p.id === m.id);
      if (i < 0) break;
      const [p] = s.photos.splice(i, 1);
      (p.kind === 'video' ? store.delVideo(s.code, p.id) : store.delPhoto(s.code, p.id)).catch((e) => console.error('photoflix: delete failed:', e.message));
      videoSizes.delete(p.id);
      break;
    }
    case 'photo:move': { // change a photo's number in the loop
      const i = s.photos.findIndex((p) => p.id === m.id);
      if (i < 0) break;
      const to = Math.max(0, Math.min(s.photos.length - 1, Math.round(Number(m.to) || 0)));
      const [p] = s.photos.splice(i, 1);
      s.photos.splice(to, 0, p);
      break;
    }
    case 'settings':
      if (m.name !== undefined) s.name = clean(m.name, 40); // optional, may be blank
      if (m.room !== undefined) s.room = clean(m.room, 30);
      if (m.city !== undefined) s.city = clean(m.city, 40);
      if (m.interval !== undefined) s.interval = Math.max(3, Math.min(60, Number(m.interval) || 8));
      if (m.voice !== undefined) s.voice = !!m.voice;
      if (m.showNames !== undefined) s.showNames = !!m.showNames;
      if (m.videoSound !== undefined) s.videoSound = !!m.videoSound;
      break;
    case 'qr:show':
      s.qrUntil = Date.now() + QR_SHOW_MS;
      setTimeout(() => sync(s), QR_SHOW_MS + 500);
      break;
    case 'pin:change': {
      const pin = String(m.pin || '');
      if (!/^\d{4,6}$/.test(pin)) return send(ws, { t: 'toast', text: 'PIN must be 4-6 digits', bad: true });
      s.salt = newId(16);
      s.pin = hashPin(pin, s.salt);
      send(ws, { t: 'toast', text: '🔒 Staff PIN changed' });
      break;
    }
    case 'leave':
      s.staff = s.staff.filter((x) => x.id !== me.id);
      s.phones.delete(ws);
      break;
    default:
      return;
  }
  sync(s);
}

// ------------------------------------------------------------- HTTP + WebSocket
// The server's public link (fixed, or the free Cloudflare one that changes on restart), saved for phones to find.
export function publishLink(url) {
  ready.then(() => store.putLink && store.putLink(url))
    .then(() => { if (store.putLink) console.log('  Phones will follow this link by themselves.'); })
    .catch((e) => console.error('photoflix: could not save the link for phones:', e.message));
}

export const ready = createStore().then(async (st) => {
  store = st;
  (await st.loadAll()).forEach((d) => screens.set(d.code, live(d)));
  console.log('  PhotoFlix storage: ' + st.describe + ', ' + screens.size + ' screen(s) loaded');
  if (lambdaOn) {
    for (const s of screens.values()) {
      await queue.createScreen(s.code, s.name).catch((e) => console.error('photoflix lambda:', e.message));
      await refresh(s).catch((e) => console.error('photoflix lambda:', e.message));
    }
    console.log('  Patient queue: AWS Lambda ' + lambdaName + ' (DynamoDB)');
  }
  midnight();
  setInterval(midnight, 60000);
});
function midnight() {
  screens.forEach((s) => {
    if (s.day === today()) return;
    if (lambdaOn) { s.day = today(); refresh(s).then(() => sync(s), () => {}); return; } // the Lambda starts each day at token 1
    const had = s.queue.length;
    newDay(s);
    if (had) toStaff(s, { t: 'toast', text: '🌅 New day: the list was cleared, tokens start from 1' });
    sync(s);
  });
}

// Video uploads in progress: id -> { s, by, dir, file, size, partBytes, s3 (multipart upload id, direct to S3)
// or parts (Set of part numbers received here), at }
const uploads = new Map();
function dropUpload(id) {
  const u = uploads.get(id);
  if (!u) return;
  uploads.delete(id);
  if (u.s3) store.dropUpload(u.s.code, id, u.s3).catch(() => {});
  fs.promises.rm(u.dir, { recursive: true, force: true }).catch(() => {});
}
setInterval(() => uploads.forEach((u, id) => { if (Date.now() - u.at > UPLOAD_KEEP_MS) dropUpload(id); }), 10 * 60 * 1000);

export function attachScreens(app, express) {
  const staffOf = (req) => {
    const s = screens.get(String(req.query.s || '').toUpperCase());
    const member = s && s.staff.find((x) => x.id === String(req.query.u || ''));
    return member ? { s, member } : null;
  };
  const wrap = (fn) => (req, res) => ready.then(() => fn(req, res)).catch((e) => {
    console.error('photoflix:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  });

  // Phones shrink photos to ~1920 px JPEG first, so they are small; they go through this server to S3.
  app.post('/api/photos', express.raw({ type: 'image/jpeg', limit: '8mb' }), wrap(async (req, res) => {
    const who = staffOf(req);
    if (!who) return res.status(403).json({ error: 'Join the screen first' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 100 || req.body[0] !== 0xff || req.body[1] !== 0xd8) return res.status(400).json({ error: 'Not a JPEG photo' });
    if (who.s.photos.length >= MAX_PHOTOS) return res.status(400).json({ error: 'This screen already has ' + MAX_PHOTOS + ' photos. Delete some first.' });
    const id = newId(12);
    await store.putPhoto(who.s.code, id, req.body);
    who.s.photos.push({ id, at: Date.now(), by: who.member.name });
    sync(who.s);
    res.json({ id });
  }));

  // Videos: the phone sends the original file in parts, a few at a time, and a part that fails is simply sent
  // again. One big upload broke on slow phone connections (this server drops a request after 5 minutes) and on
  // slow free Cloudflare links (100 s per request). With a bucket the parts go straight to S3 (signed links);
  // without one they come here. Then the video is shrunk to 1080p H.264 (Fire TV plays that smoothly) and
  // stored next to the photos. The phone gets an answer at once; a toast says when it is on the TV.
  // 1. start: the phone says how big the video is and gets an upload id (and, with S3, a link per part)
  app.post('/api/videos/start', express.json(), wrap(async (req, res) => {
    const who = staffOf(req);
    if (!who) return res.status(403).json({ error: 'Join the screen first' });
    if (!canShrink) return res.status(500).json({ error: 'Video support is not installed on the server (ffmpeg-static)' });
    const size = Number(req.body && req.body.size);
    if (!(size > 0)) return res.status(400).json({ error: 'Empty video' });
    if (size > MAX_VIDEO_BYTES) return res.status(413).json({ error: 'Video too big (max ' + (MAX_VIDEO_BYTES >> 20) + ' MB)' });
    if (who.s.photos.length + (who.s.preparing || 0) >= MAX_PHOTOS) return res.status(400).json({ error: 'This screen already has ' + MAX_PHOTOS + ' photos and videos. Delete some first.' });
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflix-video-'));
    const file = path.join(dir, 'in');
    const id = newId(16);
    const u = { s: who.s, by: who.member.name, dir, file, size, at: Date.now() };
    if (store.startUpload) {
      u.partBytes = PART_BYTES_S3;
      const { uploadId, urls } = await store.startUpload(who.s.code, id, Math.ceil(size / u.partBytes));
      u.s3 = uploadId;
      uploads.set(id, u);
      return res.json({ id, partBytes: u.partBytes, urls });
    }
    u.partBytes = PART_BYTES_HERE;
    u.parts = new Set();
    await (await fs.promises.open(file, 'w')).close();
    uploads.set(id, u);
    res.json({ id, partBytes: u.partBytes });
  }));
  // 2. parts that come here (no bucket), in any order; a part sent again just overwrites itself
  app.put('/api/videos/part', express.raw({ type: () => true, limit: PART_BYTES_HERE + 1024 }), wrap(async (req, res) => {
    const who = staffOf(req);
    const u = uploads.get(String(req.query.id || ''));
    if (!who || !u || u.s !== who.s || !u.parts) return res.status(404).json({ error: 'Upload not found. Please add the video again.' });
    const n = Number(req.query.n);
    const total = Math.ceil(u.size / u.partBytes);
    const expect = n === total - 1 ? u.size - n * u.partBytes : u.partBytes;
    if (!Number.isInteger(n) || n < 0 || n >= total || !Buffer.isBuffer(req.body) || req.body.length !== expect) return res.status(400).json({ error: 'Part ' + n + ' arrived broken' });
    const fh = await fs.promises.open(u.file, 'r+');
    try { await fh.write(req.body, 0, req.body.length, n * u.partBytes); } finally { await fh.close(); }
    u.parts.add(n);
    u.at = Date.now();
    res.json({ ok: true });
  }));
  // 3. finish: every part has arrived (with S3 the phone sends each part's ETag), so shrink it for the TV
  app.post('/api/videos/finish', express.json(), wrap(async (req, res) => {
    const who = staffOf(req);
    const upId = String(req.query.id || '');
    const u = uploads.get(upId);
    if (!who || !u || u.s !== who.s) return res.status(404).json({ error: 'Upload not found. Please add the video again.' });
    const total = Math.ceil(u.size / u.partBytes);
    if (u.s3) {
      const etags = req.body && req.body.etags;
      if (!Array.isArray(etags) || etags.length !== total || !etags.every((e) => typeof e === 'string' && e)) return res.status(400).json({ error: 'Some parts of the video are missing. Please add it again.' });
      try {
        await store.finishUpload(u.s.code, upId, u.s3, etags);
      } catch (e) {
        console.error('photoflix: video upload could not be completed:', e.message);
        dropUpload(upId);
        return res.status(400).json({ error: 'The video did not arrive complete. Please add it again.' });
      }
    } else if (u.parts.size !== total) return res.status(400).json({ error: 'Some parts of the video are missing. Please add it again.' });
    uploads.delete(upId); // from here on the video is "being prepared"
    const { s, by, dir } = u;
    const input = u.file;
    const output = path.join(dir, 'out.mp4');
    const cleanup = () => {
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (u.s3) store.dropUpload(s.code, upId).catch(() => {}); // the original in S3 is not needed any more
    };
    s.preparing = (s.preparing || 0) + 1;
    sync(s);
    res.json({ processing: true });
    const started = Date.now();
    (u.s3 ? store.fetchUpload(s.code, upId, input) : Promise.resolve())
      .then(() => shrinkVideo(input, output))
      .then(async () => {
        const id = newId(12);
        await store.putVideo(s.code, id, output);
        s.photos.push({ id, kind: 'video', at: Date.now(), by });
        console.log('  photoflix video ' + id + ': ' + Math.round((await fs.promises.stat(output)).size / 1024) + ' KB after shrinking, ' + Math.round((Date.now() - started) / 1000) + ' s');
        toStaff(s, { t: 'toast', text: '🎬 Video from ' + by + ' is now on the TV' });
      })
      .catch((e) => {
        console.error('photoflix: video failed:', e.message);
        toStaff(s, { t: 'toast', text: '⚠️ The video could not be prepared. Try another video.', bad: true });
      })
      .finally(() => { s.preparing = Math.max(0, (s.preparing || 1) - 1); cleanup(); sync(s); });
  }));

  // Photos in one go; videos in parts (Range), so the TV can start playing and skip without downloading everything.
  app.get('/media/:code/:id', wrap(async (req, res) => {
    const s = screens.get(req.params.code);
    const item = s && s.photos.find((p) => p.id === req.params.id);
    if (!item) return res.status(404).end();
    if (item.kind === 'video') {
      if (!videoSizes.has(item.id)) videoSizes.set(item.id, await store.videoSize(s.code, item.id));
      const size = videoSizes.get(item.id);
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.get('Range') || '');
      let start = 0;
      let end = size - 1;
      if (m) {
        if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); } // last N bytes
        else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
        if (start > end || start >= size) return res.status(416).set('Content-Range', 'bytes */' + size).end();
      }
      res.status(m ? 206 : 200).set({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'public, max-age=604800, immutable' });
      if (m) res.set('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
      const body = await store.getVideo(s.code, item.id, start, end);
      body.on('error', () => res.destroy());
      return body.pipe(res);
    }
    const body = await store.getPhoto(s.code, req.params.id);
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800, immutable' });
    body.on('error', () => res.destroy());
    body.pipe(res);
  }));

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let m = null;
      try { m = JSON.parse(raw); } catch (e) { return; }
      ready.then(() => handle(ws, m)).catch(() => {});
    });
    ws.on('close', () => {
      const s = ws.screen;
      if (!s) return;
      s.tvs.delete(ws);
      s.phones.delete(ws);
      sync(s);
    });
  });
  setInterval(() => wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 30000);
  return wss;
}
