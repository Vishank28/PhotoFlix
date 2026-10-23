// PhotoFlix staff phone (opened from the TV's QR, runs in the browser).
// Patients tab: add (token number is automatic), call next, list, edit, delete.
// Photos tab: add photos that loop on the TV, change a photo's number in the loop, delete.
// Settings (⚙️): screen name, room, voice, PIN, new day.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const saved = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

let ws = null;
// Arrived from the old link after the PC restarted (see followLink): stay signed in on the new link.
if (params.get('u') && params.get('s')) {
  saved.set('pf_staff', { code: params.get('s').toUpperCase(), id: params.get('u'), name: params.get('n') || '' });
  history.replaceState(null, '', location.pathname + '?s=' + encodeURIComponent(params.get('s')));
}
let me = saved.get('pf_staff'); // { code, id, name }
let st = null;
let room = saved.get('pf_room') || ''; // this phone's own room (tap "Calling to"); blank = the screen's room
let filter = 'all';
let editing = null; // patient open in the edit sheet
let pic = null; // photo open in the photo sheet
const urlCode = (params.get('s') || '').toUpperCase().slice(0, 6);
if (me && urlCode && me.code !== urlCode) me = null; // scanned a different screen's QR

// ------------------------------------------------------------- connection
function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/ws');
  ws.onopen = () => { downSince = 0; lost(false); if (me) send({ t: 'join', code: me.code, id: me.id }); else { checked = ''; checkCode(); } };
  ws.onmessage = (e) => {
    let m = null;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (on[m.t]) on[m.t](m);
  };
  ws.onclose = () => {
    $('tvDot').textContent = 'Reconnecting…';
    $('tvDot').classList.add('off');
    if (!downSince) downSince = Date.now();
    if (Date.now() - downSince > 8000) followLink();
    setTimeout(connect, 1500);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
}
function send(obj) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  toast('Not connected, try again in a moment', true);
  return false;
}
// The free Cloudflare link changes when the PC restarts, and the old one stops working. The server keeps its
// current link in S3 (a signed link to read it arrives on every connect): if this page cannot reach the server
// for a few seconds, it looks there and moves to the new link, still signed in.
let downSince = 0;
let looking = false;
function lost(show, text) {
  $('lost').classList.toggle('hidden', !show);
  if (text) $('lost').textContent = text;
}
async function followLink() {
  if (looking) return;
  looking = true;
  const link = saved.get('pf_link');
  const onTunnel = /\.trycloudflare\.com$/.test(location.hostname);
  try {
    if (link && me && onTunnel) {
      lost(true, '⏳ The PhotoFlix PC may have restarted. Looking for its new link…');
      const r = await fetch(link, { cache: 'no-store' });
      const cur = r.ok ? await r.json() : null;
      if (cur && cur.url && cur.url !== location.origin) {
        location.replace(cur.url + '/phone/?s=' + encodeURIComponent(me.code) + '&u=' + encodeURIComponent(me.id) + '&n=' + encodeURIComponent(me.name || ''));
        return;
      }
    }
    lost(true, '⚠️ Cannot reach PhotoFlix. Check that the PC is on. If it was restarted, scan the QR on the TV again (press OK on the TV remote to show it).');
  } catch (e) {
    lost(true, '⚠️ Cannot reach PhotoFlix. If the PC was restarted, scan the QR on the TV again (press OK on the TV remote to show it).');
  } finally {
    setTimeout(() => { looking = false; }, 10000);
  }
}

const on = {
  link(m) { saved.set('pf_link', m.url); },
  welcome(m) {
    me = { code: m.code, id: m.id, name: m.name };
    saved.set('pf_staff', me);
    $('join').classList.add('hidden');
    $('dash').classList.remove('hidden');
    $('tabs').classList.remove('hidden');
    $('joinBtn').disabled = false;
    $('pin').value = '';
    $('pin2').value = '';
  },
  check(m) { // does this screen have a staff PIN yet?
    if (m.code !== $('code').value.trim()) return;
    if (!m.found) { setPinMode(false, true); $('joinMsg').textContent = 'No screen with that code. Check the code on the TV.'; return; }
    $('joinMsg').textContent = '';
    setPinMode(!m.hasPin);
  },
  state(m) { st = m; render(); },
  toast(m) { toast(m.text, m.bad); },
  err(m) {
    $('joinBtn').disabled = false;
    if ((m.code === 'noscreen' || m.code === 'removed') && me) { me = null; saved.del('pf_staff'); showJoin(); }
    if (m.hasPin !== undefined) setPinMode(!m.hasPin);
    if (m.code === 'pin') $('pin').focus();
    $('joinMsg').textContent = m.msg;
  },
};

// ------------------------------------------------------------- join
// The server says if the screen already has a staff PIN: the first phone CHOOSES it (typed twice),
// every other phone ENTERS it. So nobody sets a PIN by accident thinking they are typing one in.
let pinIsNew = false;
let checked = ''; // screen code already asked about
function setPinMode(isNew, unknown) {
  pinIsNew = isNew;
  $('pinLbl').innerHTML = (isNew ? 'Choose a staff PIN' : 'Staff PIN') + ' <small>(4–6 digits)</small>';
  $('pin2Row').classList.toggle('hidden', !isNew);
  $('pinHelp').textContent = isNew
    ? 'New screen: the PIN you choose locks it. Share it only with staff; their phones will need it to join.'
    : 'Ask the person who set up this screen for the PIN.';
  $('pinHelp').classList.toggle('hidden', !!unknown);
  $('joinTxt').textContent = isNew ? 'Set PIN and join' : 'Join screen';
}
function checkCode() {
  const code = $('code').value.trim();
  if (code.length !== 6 || code === checked || !ws || ws.readyState !== 1) return;
  checked = code;
  ws.send(JSON.stringify({ t: 'check', code }));
}
function renderCode() {
  const v = $('code').value;
  const focused = document.activeElement === $('code');
  $('codeBoxes').querySelectorAll('b').forEach((b, i) => {
    b.textContent = v[i] || '';
    b.classList.toggle('cur', focused && i === Math.min(v.length, 5));
  });
}
function showJoin() {
  $('dash').classList.add('hidden');
  $('tabs').classList.add('hidden');
  $('join').classList.remove('hidden');
  $('code').value = urlCode;
  renderCode();
  checked = '';
  setPinMode(false, true);
  checkCode();
  if (urlCode) $('name').focus();
}
$('code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
  renderCode();
  if (e.target.value.length === 6) checkCode();
  else { checked = ''; setPinMode(false, true); $('joinMsg').textContent = ''; }
});
['focus', 'blur'].forEach((ev) => $('code').addEventListener(ev, renderCode));
$('code').addEventListener('click', (e) => { const n = e.target.value.length; e.target.setSelectionRange(n, n); });
$('codeInfo').addEventListener('click', () => $('codeHelp').classList.toggle('hidden'));
$('pinEye').addEventListener('click', () => {
  const show = $('pin').type === 'password';
  ['pin', 'pin2'].forEach((id) => { $(id).type = show ? 'text' : 'password'; });
  $('pinEye').classList.toggle('on', show);
  $('pinEye').setAttribute('aria-label', show ? 'Hide PIN' : 'Show PIN');
});
$('joinBtn').addEventListener('click', () => {
  const code = $('code').value.trim();
  const name = $('name').value.trim();
  const pin = $('pin').value.trim();
  if (code.length !== 6) { $('joinMsg').textContent = 'Enter the 6-letter code shown on the TV.'; return; }
  if (!name) { $('joinMsg').textContent = 'Please enter your name.'; return; }
  if (pinIsNew) {
    if (!/^\d{4,6}$/.test(pin)) { $('joinMsg').textContent = 'Choose a PIN of 4 to 6 digits.'; $('pin').focus(); return; }
    if (pin !== $('pin2').value.trim()) { $('joinMsg').textContent = 'The two PINs are not the same.'; $('pin2').focus(); return; }
  }
  $('joinMsg').textContent = '';
  if (send({ t: 'join', code, name, pin, newPin: pinIsNew })) $('joinBtn').disabled = true;
});

// ------------------------------------------------------------- tabs + settings view
function setTab(tab) {
  $('dash').setAttribute('data-tab', tab);
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
  window.scrollTo(0, 0);
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('gear').addEventListener('click', () => {
  if (!st) return;
  $('sName').value = st.name;
  $('sCity').value = st.city || '';
  $('sRoom').value = st.room || '';
  $('sInterval').value = String(st.interval);
  $('sVoice').checked = st.voice;
  $('sNames').checked = st.showNames;
  $('sVideoSound').checked = !!st.videoSound;
  setTab('settings');
});
$('backBtn').addEventListener('click', () => setTab('patients'));

// ------------------------------------------------------------- render
const mins = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago'; };
const STATUS = { waiting: 'Waiting', called: 'Called', done: 'Done' };
function render() {
  if (!st) return;
  $('screenName').textContent = st.name || 'PhotoFlix';
  $('tvDot').textContent = st.tvOn ? 'TV on' : 'TV off';
  $('tvDot').classList.toggle('off', !st.tvOn);
  $('codeShow').textContent = st.code;
  $('roomBtn').textContent = roomText(room || st.room) || 'Set room';

  // Now serving + call next
  const cur = st.current && st.current.status === 'called' ? st.current : null;
  $('nowTok').textContent = cur ? cur.token : '—';
  $('nowName').textContent = cur ? (cur.name || 'Token ' + cur.token) + (cur.room ? ' → ' + roomText(cur.room) : '') : 'Nobody called yet';
  $('recall').classList.toggle('hidden', !cur);
  $('nextTok').textContent = st.nextToken;
  const wait = st.queue.filter((p) => p.status === 'waiting');
  $('nextBtn').textContent = wait.length ? 'Call next ▶  ' + wait[0].token + (wait[0].name ? ' · ' + wait[0].name : '') : (cur ? 'Finish ' + cur.token + ' ✓' : 'Nobody waiting');
  $('nextBtn').disabled = !wait.length && !cur;

  // Patient list: called first, then waiting in line order, then done (newest first)
  const list = [
    ...st.queue.filter((p) => p.status === 'called'),
    ...wait,
    ...st.queue.filter((p) => p.status === 'done').reverse(),
  ].filter((p) => filter === 'all' || p.status === filter || (filter === 'waiting' && p.status === 'called'));
  $('countAll').textContent = '(' + st.queue.length + ')';
  $('listCount').textContent = wait.length;
  $('listCount').classList.toggle('hidden', !wait.length);
  // Room shown: the patient's own room while waiting, the room they were called to after that.
  const where = (p) => roomText(p.status === 'waiting' ? p.assignedRoom : p.room);
  $('patientList').innerHTML = list.length ? list.map((p) => '<div class="pt ' + p.status + '" data-edit="' + p.token + '"><span class="tk">' + p.token + '</span>' +
    '<span class="nm"><b>' + esc(p.name || '—') + '</b><small>' + (p.phone ? '<b>' + esc(p.phone) + '</b> · ' : '') + (p.status === 'done' ? 'done' : 'added ' + mins(p.at)) + (where(p) ? ' · <b>' + esc(where(p)) + '</b>' : '') + (p.skipped ? ' · skipped ' + p.skipped + '×' : '') + '</small></span>' +
    '<span class="st ' + p.status + '">' + STATUS[p.status] + '</span>' +
    (p.status === 'waiting' ? '<button class="mini go" data-call="' + p.token + '">Call</button>' : '') + '</div>').join('')
    : '<div class="empty">' + (st.queue.length ? 'Nobody in this list.' : 'No patients yet. Add them in the Patients tab.') + '</div>';

  // Photos, numbered in loop order (rebuild only when the list changed)
  const sig = st.photos.map((p) => p.id).join();
  if (sig !== $('grid').getAttribute('data-sig')) {
    $('grid').setAttribute('data-sig', sig);
    $('grid').innerHTML = st.photos.map((p, i) => '<button data-photo="' + p.id + '">' + (p.kind === 'video'
      ? '<video src="' + p.url + '#t=0.5" preload="metadata" muted playsinline></video><span class="play">▶ video</span>'
      : '<img src="' + p.url + '" loading="lazy" alt="">') + '<span class="num">' + (i + 1) + '</span></button>').join('');
  }
  const prep = st.preparing ? ' 🎬 ' + st.preparing + (st.preparing > 1 ? ' videos are' : ' video is') + ' being prepared for the TV…' : '';
  $('photoHint').textContent = (st.photos.length ? st.photos.length + ' photos / videos loop on the TV in this order. Tap one to change its number or delete it.' : 'Nothing yet. Add photos or videos and they loop on the TV.') + prep;
  $('staffList').textContent = 'Staff phones: ' + st.staff.map((s) => s.name + (s.on ? ' ●' : '')).join(', ');
  if (editing) { const p = st.queue.find((x) => x.token === editing.token); if (!p) closeSheets(); else editing = p; }
}

// ------------------------------------------------------------- patients
const normPhone = (v) => v.replace(/[\s()-]/g, '');
// Indian 10-digit numbers get +91 added; anything else must start with + and the country code.
function phoneOk(v) {
  let p = normPhone(v);
  if (/^[6-9]\d{9}$/.test(p)) p = '+91' + p;
  return !p || /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}
function addPatient() {
  const phone = phoneOk($('patientPhone').value);
  if (phone === null) { toast('Mobile: 10 digits, or + and country code', true); $('patientPhone').focus(); return; }
  if (send({ t: 'q:add', name: $('patient').value.trim(), phone, room: $('patientRoom').value.trim() })) {
    $('patient').value = '';
    $('patientPhone').value = '';
    $('patientRoom').value = '';
    $('patient').focus();
  }
}
$('addBtn').addEventListener('click', addPatient);
$('patientPhone').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('patientRoom').focus(); });
$('patientRoom').addEventListener('keydown', (e) => { if (e.key === 'Enter') addPatient(); });
$('patient').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('patientPhone').focus(); });
$('nextBtn').addEventListener('click', () => { if (send({ t: 'q:next', room })) navigator.vibrate && navigator.vibrate(40); });
$('recall').addEventListener('click', () => send({ t: 'q:recall', room }));
$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll('#filters button').forEach((x) => x.classList.toggle('on', x === b));
  render();
});
$('patientList').addEventListener('click', (e) => {
  const call = e.target.closest('[data-call]');
  if (call) { send({ t: 'q:call', token: Number(call.dataset.call), room }); return; }
  const row = e.target.closest('[data-edit]');
  if (!row || !st) return;
  editing = st.queue.find((p) => p.token === Number(row.dataset.edit));
  if (!editing) return;
  $('editTok').textContent = editing.token + ' · ' + STATUS[editing.status];
  $('editName').value = editing.name || '';
  $('editPhone').value = editing.phone || '';
  $('editRoom').value = editing.assignedRoom || '';
  openSheet('editSheet');
});
$('editSave').addEventListener('click', () => {
  const phone = phoneOk($('editPhone').value);
  if (phone === null) { toast('Mobile: 10 digits, or + and country code', true); return; }
  const t = editing.token;
  if (send({ t: 'q:edit', token: t, name: $('editName').value.trim(), phone, room: $('editRoom').value.trim() })) { closeSheets(); toast('✅ Token ' + t + ' updated'); }
});
$('editCall').addEventListener('click', () => { if (send({ t: 'q:call', token: editing.token, room })) closeSheets(); });
$('editDone').addEventListener('click', () => { if (send({ t: 'q:done', token: editing.token })) closeSheets(); });
$('editSkip').addEventListener('click', () => { if (send({ t: 'q:skip', token: editing.token })) closeSheets(); });
$('editDel').addEventListener('click', () => {
  const t = editing.token;
  if (confirm('Delete token ' + t + '?') && send({ t: 'q:del', token: t })) { closeSheets(); toast('🗑️ Token ' + t + ' deleted'); }
});
function askRoom() {
  const r = prompt('Room for THIS phone only (e.g. Room 2, Counter 1).\nLeave blank to use the screen\'s room' + (st && st.room ? ' (' + st.room + ')' : '') + '.', room);
  if (r === null) return;
  room = r.trim().slice(0, 30);
  saved.set('pf_room', room);
  render();
}
$('roomBtn').addEventListener('click', askRoom);

// ------------------------------------------------------------- photos
$('grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-photo]');
  if (!b || !st) return;
  const i = st.photos.findIndex((p) => p.id === b.dataset.photo);
  if (i < 0) return;
  pic = st.photos[i];
  const vid = pic.kind === 'video';
  $('picPrev').classList.toggle('hidden', vid);
  $('picVid').classList.toggle('hidden', !vid);
  if (vid) { $('picVid').src = pic.url; $('picPrev').removeAttribute('src'); } else { $('picPrev').src = pic.url; $('picVid').removeAttribute('src'); $('picVid').load(); }
  $('picPos').value = i + 1;
  $('picPos').max = st.photos.length;
  $('picInfo').textContent = 'Number ' + (i + 1) + ' of ' + st.photos.length + ' · added by ' + (pic.by || 'staff');
  openSheet('picSheet');
});
const clampPos = (n) => Math.max(1, Math.min(st.photos.length, Math.round(Number(n) || 1)));
$('picEarlier').addEventListener('click', () => { $('picPos').value = clampPos(Number($('picPos').value) - 1); });
$('picLater').addEventListener('click', () => { $('picPos').value = clampPos(Number($('picPos').value) + 1); });
$('picSave').addEventListener('click', () => {
  const to = clampPos($('picPos').value);
  if (send({ t: 'photo:move', id: pic.id, to: to - 1 })) { closeSheets(); toast('🔢 Now number ' + to + ' in the loop'); }
});
$('picDel').addEventListener('click', () => {
  if (confirm('Delete this ' + (pic.kind === 'video' ? 'video' : 'photo') + ' from the TV?') && send({ t: 'photo:del', id: pic.id })) { closeSheets(); toast('🗑️ Deleted'); }
});
$('photoIn').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []).slice(0, 30);
  e.target.value = '';
  if (!files.length || !me) return;
  $('upBar').classList.remove('hidden');
  // Keep the phone awake: a locked screen pauses the upload.
  let lock = null;
  try { lock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (e) { /* not allowed: fine */ }
  let pics = 0;
  let vids = 0;
  const who = '?s=' + me.code + '&u=' + encodeURIComponent(me.id);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const isVideo = (f.type || '').startsWith('video/') || /\.(mp4|mov|m4v|webm|3gp|mkv)$/i.test(f.name);
    const show = (frac) => {
      $('upFill').style.width = Math.round(((i + frac) / files.length) * 100) + '%';
      $('upTxt').textContent = (files.length > 1 ? (i + 1) + ' of ' + files.length + ' · ' : '') + (isVideo ? 'video ' : '') + Math.round(frac * 100) + '%';
    };
    show(0);
    try {
      if (isVideo) {
        if (f.size > MAX_VIDEO_MB * 1024 * 1024) throw new Error('over ' + MAX_VIDEO_MB + ' MB, too big');
        await uploadVideo(who, f, (frac) => { show(frac); $('upTxt').textContent += ' · ' + Math.round((frac * f.size) / 1048576) + ' of ' + Math.round(f.size / 1048576) + ' MB'; });
        vids++;
      } else {
        const blob = await shrink(f, 1920, 1080, 0.88);
        await sendBytes('POST', '/api/photos' + who, 'image/jpeg', blob, show);
        pics++;
      }
    } catch (err) {
      toast(f.name + ': ' + err.message, true);
    }
  }
  if (lock) lock.release().catch(() => {});
  $('upFill').style.width = '100%';
  setTimeout(() => $('upBar').classList.add('hidden'), 800);
  if (pics && !vids) toast('✅ ' + pics + (pics > 1 ? ' photos are' : ' photo is') + ' on the TV');
  if (vids) toast('🎬 Uploaded. ' + (vids > 1 ? 'The videos are' : 'The video is') + ' being prepared for the TV (about a minute)…');
});
// Upload with progress (XHR: fetch has no upload progress). Resolves with the JSON answer.
const MAX_VIDEO_MB = 300;
function sendBytes(method, url, type, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', type);
    xhr.timeout = 3 * 60 * 1000; // one 8 MB part even on a slow connection
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let out = null;
      try { out = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) { if (onProgress) onProgress(1); resolve(Object.assign(out || {}, { etag: xhr.getResponseHeader('ETag') })); return; }
      reject(Object.assign(new Error((out && out.error) || 'Upload failed (' + xhr.status + ')'), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Network error, check your connection'));
    xhr.ontimeout = () => reject(new Error('The connection is too slow, try again on Wi-Fi'));
    xhr.send(body);
  });
}
// Videos go as they are (the server shrinks them for the TV), in parts of a few MB, 3 at a time: straight
// to S3 when the server gives signed links (fast, skips the PC and the Cloudflare link), else to the server.
// One big upload failed on weak connections; here a part that fails is sent again (up to 4 tries).
const PART_TRIES = 4;
const PARALLEL_PARTS = 3;
async function uploadVideo(who, f, onProgress) {
  const up = await sendBytes('POST', '/api/videos/start' + who, 'application/json', JSON.stringify({ size: f.size }));
  const total = Math.ceil(f.size / up.partBytes);
  const sent = new Array(total).fill(0); // bytes of each part that have arrived
  const etags = new Array(total); // S3 only: proof of each part, checked when the upload is finished
  const report = () => onProgress(sent.reduce((a, b) => a + b, 0) / f.size);
  let next = 0;
  let failed = null;
  const worker = async () => {
    while (next < total && !failed) {
      const n = next++;
      const part = f.slice(n * up.partBytes, Math.min(f.size, (n + 1) * up.partBytes));
      for (let tries = 1; !failed; tries++) {
        try {
          const url = up.urls ? up.urls[n] : '/api/videos/part' + who + '&id=' + up.id + '&n=' + n;
          const r = await sendBytes('PUT', url, 'application/octet-stream', part, (frac) => { sent[n] = frac * part.size; report(); });
          if (up.urls) { if (!r.etag) throw new Error('S3 did not confirm part ' + (n + 1)); etags[n] = r.etag; }
          sent[n] = part.size;
          report();
          break;
        } catch (err) {
          sent[n] = 0;
          report();
          const final = tries >= PART_TRIES || [400, 404, 413].includes(err.status) || (err.status === 403 && !up.urls);
          if (final) { failed = err; break; }
          await new Promise((r) => setTimeout(r, 2000 * tries)); // the connection may come back
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, total) }, worker));
  if (failed) throw failed;
  await sendBytes('POST', '/api/videos/finish' + who + '&id=' + up.id, 'application/json', JSON.stringify({ etags: up.urls ? etags : [] }));
}
// Phone photos are 3-12 MB; they are made just big enough for the TV (about 0.5-1.5 MB JPEG) before upload.
// The TV (1920x1080) shows a wide photo filling the screen, so it is shrunk only so far that it still covers
// the screen and never has to be stretched. A tall photo is shown whole at full height: 1920 px tall is plenty.
function shrink(file, w, h, q) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const tall = img.width / img.height < 1.2;
      const k = Math.min(1, tall ? w / img.height : Math.max(w / img.width, h / img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read photo'))), 'image/jpeg', q);
    };
    img.onerror = () => reject(new Error('Could not read photo'));
    img.src = URL.createObjectURL(file);
  });
}

// ------------------------------------------------------------- settings
$('saveSet').addEventListener('click', () => {
  if (send({ t: 'settings', name: $('sName').value, room: $('sRoom').value, city: $('sCity').value, interval: Number($('sInterval').value), voice: $('sVoice').checked, showNames: $('sNames').checked, videoSound: $('sVideoSound').checked })) { toast('✅ Saved'); render(); }
});
$('qrShow').addEventListener('click', () => { if (send({ t: 'qr:show' })) toast('📱 QR is on the TV for 2 minutes'); });
$('pinBtn').addEventListener('click', () => {
  const pin = prompt('New staff PIN (4-6 digits). Phones already linked stay linked.');
  if (pin !== null) send({ t: 'pin:change', pin: pin.trim() });
});
$('resetBtn').addEventListener('click', () => { if (confirm('Clear the whole list and start tokens from 1?')) send({ t: 'q:reset' }); });
$('leave').addEventListener('click', () => {
  if (!confirm('Unlink this phone from the screen?')) return;
  send({ t: 'leave' });
  me = null;
  saved.del('pf_staff');
  showJoin();
});

// ------------------------------------------------------------- sheets + misc
function openSheet(id) { document.querySelectorAll('.sheet').forEach((s) => s.classList.toggle('hidden', s.id !== id)); }
function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => s.classList.add('hidden')); editing = null; }
document.querySelectorAll('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s || e.target.hasAttribute('data-close')) closeSheets(); }));
let toastTimer = 0;
function toast(text, bad) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('bad', !!bad);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}
// A room number ("1", "2B", "room no 1") is shown as "Room 1", as on the TV. "Counter 3" stays as typed.
const ROOM_NO = /^(?:room\s*(?:no\.?|number|#)?\s*)?(\d+[A-Za-z]?)$/i;
function roomText(r) { r = String(r || '').trim(); const m = ROOM_NO.exec(r); return m ? 'Room ' + m[1] : r; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
setInterval(render, 30000); // "added x min ago"
if (me) { $('join').classList.add('hidden'); $('dash').classList.remove('hidden'); $('tabs').classList.remove('hidden'); } else showJoin();
connect();
