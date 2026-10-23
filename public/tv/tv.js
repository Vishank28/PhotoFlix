// PhotoFlix TV screen: full-screen photo slideshow with clock and weather; a token appears only when it is called.
// The screen code is kept in this browser, so a reload keeps the same screen.
const $ = (id) => document.getElementById(id);
const KEY = 'pf_screen';
const read = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
const write = (v) => { try { localStorage.setItem(KEY, v); } catch (e) { /* ignore */ } };
// Arrived from the old link after the PC restarted (see followLink): keep the same screen on the new link.
const fromLink = new URLSearchParams(location.search).get('s');
if (/^[A-Z]{6}$/i.test(fromLink || '')) { write(fromLink.toUpperCase()); history.replaceState(null, '', location.pathname); }

let ws = null;
let st = null; // latest screen state
let info = null; // { publicUrl, ips, port }

// ------------------------------------------------------------- connection
function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/ws');
  ws.onopen = () => {
    downSince = 0;
    $('offline').classList.add('hidden');
    ws.send(JSON.stringify({ t: 'tv', code: read() }));
    if (app && app.setServer) app.setServer(location.origin); // the Fire TV app opens this address next time
  };
  ws.onmessage = (e) => {
    let m = null;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.t === 'screen') { st = m; write(m.code); render(); if (app && app.setScreen) app.setScreen(m.code); }
    if (m.t === 'call') announce(m);
    if (m.t === 'link') { try { localStorage.setItem('pf_link', m.url); } catch (err) { /* ignore */ } if (app && app.setLink) app.setLink(m.url, read()); }
  };
  ws.onclose = () => {
    $('offline').classList.remove('hidden');
    if (!downSince) downSince = Date.now();
    if (Date.now() - downSince > 8000) followLink();
    // In the Fire TV app, after a minute without the server: reload, so the app looks for the PC on the Wi-Fi
    // (or its new link) if the page cannot load any more.
    if (app && Date.now() - downSince > 60000) { location.reload(); return; }
    setTimeout(connect, 2000);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
}
// The free Cloudflare link changes when the PC restarts, and the old one stops working. The server keeps its
// current link in S3 (a signed link to read it arrives on every connect): if the TV cannot reach the server for
// a few seconds, it looks there and moves to the new link, keeping its screen code (as the staff phones do).
let downSince = 0;
let looking = false;
async function followLink() {
  let link = '';
  try { link = localStorage.getItem('pf_link') || ''; } catch (e) { /* ignore */ }
  if (looking || !link || !read() || !/\.trycloudflare\.com$/.test(location.hostname)) return;
  looking = true;
  try {
    const r = await fetch(link, { cache: 'no-store' });
    const cur = r.ok ? await r.json() : null;
    if (cur && cur.url && cur.url !== location.origin) location.replace(cur.url + '/tv/?s=' + encodeURIComponent(read()));
  } catch (e) { /* not there yet: tried again on the next reconnect */ }
  setTimeout(() => { looking = false; }, 8000);
}

// ------------------------------------------------------------- QR link for staff phones
function joinBase() {
  if (info && info.publicUrl) return info.publicUrl;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (local && info && info.ips && info.ips.length) return 'http://' + info.ips[0] + ':' + info.port;
  return location.origin;
}
function loadInfo() { fetch('/api/info').then((r) => r.json()).then((i) => { info = i; render(); }).catch(() => {}); }
loadInfo();
setInterval(loadInfo, 20000); // the free Cloudflare link changes when it restarts

function setQr(img, url) {
  if (img.getAttribute('data-u') === url) return;
  img.setAttribute('data-u', url);
  img.src = '/api/qr.svg?data=' + encodeURIComponent(url);
}

// ------------------------------------------------------------- render
function render() {
  if (!st) return;
  const url = joinBase() + '/phone/?s=' + st.code;
  $('screenName').textContent = st.name || '';
  $('setup').classList.toggle('hidden', st.paired);
  document.body.classList.toggle('setup-on', !st.paired);
  setQr($('qrBig'), url);
  $('urlBig').textContent = joinBase() + '/phone/';
  $('codeBig').textContent = st.code;
  const showCorner = st.paired && st.showQr; // OK on the remote / "Show QR on TV" on a phone; Back hides it
  $('qrCorner').classList.toggle('hidden', !showCorner);
  if (showCorner) setQr($('qrSmall'), url);
  $('codeSmall').textContent = st.code;

  // Photos fill the screen; a token shows only while it is being called (big card).
  slides();
  updateWeather();
}

// ------------------------------------------------------------- slideshow (photos + videos)
// A photo stays for the chosen number of seconds; a video plays to the end, then the loop moves on.
let order = []; // [{ url, kind }]
let pos = -1;
let front = 'slideA';
let timer = 0;
let playing = ''; // url of the video on screen
let shown = ''; // url of the photo on screen
let coming = ''; // url of the photo being loaded to go on screen next
const vid = $('vid');
const MAX_VIDEO_MS = 10 * 60 * 1000; // a stuck video never blocks the loop for long
function slides() {
  const items = st.photos.map((p) => ({ url: p.url, kind: p.kind || 'image' }));
  const changed = items.map((p) => p.url).join() !== order.map((p) => p.url).join();
  order = items;
  if (!items.length) {
    homeIn(); // fades in over the last photo
    setTimeout(() => { if (!order.length) ['slideA', 'slideB'].forEach((id) => { $(id).classList.remove('on', 'has'); $(id).querySelector('.pic').removeAttribute('src'); }); }, 1300);
    stopVideo();
    shown = ''; coming = '';
    clearTimeout(timer); timer = 0;
    return;
  }
  vid.muted = !(st.videoSound && soundOn);
  if (!changed && timer) return;
  // The list changed (photo added, deleted or moved): what is on screen (or about to be) stays if it is still in
  // the list, and the loop carries on from it. So photos uploaded one after another don't flip the TV forward.
  const cur = playing || coming || shown;
  const keep = cur ? order.findIndex((p) => p.url === cur) : -1;
  if (keep >= 0) { pos = keep; return; }
  clearTimeout(timer);
  show();
}
// The home screen (no photos yet) stays until the first photo or video is ready underneath it, then fades away.
const homeOn = () => !$('empty').classList.contains('hidden') && !$('empty').classList.contains('gone');
function homeIn() {
  const e = $('empty');
  fanRun(true);
  if (homeOn()) return;
  e.classList.remove('hidden');
  void e.offsetWidth;
  e.classList.remove('gone');
}
function homeOut() {
  const e = $('empty');
  if (!homeOn()) return;
  e.classList.add('gone');
  setTimeout(() => { if (e.classList.contains('gone')) { e.classList.add('hidden'); fanRun(false); } }, 1300);
}
// No photos yet: the example cards turn slowly and their clips play (muted). Each card moves one place left;
// the leftmost fades out and comes back on the right. Stops as soon as real photos arrive.
const fanCards = Array.from(document.querySelectorAll('#fan .c'));
let fanSlots = fanCards.map((_, i) => i);
let fanTimer = 0;
function turnFan() {
  const last = fanCards.length - 1;
  fanCards.forEach((c, i) => {
    const to = (fanSlots[i] + last) % fanCards.length;
    fanSlots[i] = to;
    if (to !== last) { c.className = 'c s' + to; return; }
    c.classList.add('out'); // fade out on the left…
    setTimeout(() => {
      c.className = 'c jump out s' + to; // …move to the right while invisible…
      void c.offsetWidth;
      c.className = 'c s' + to; // …and fade back in
    }, 650);
  });
}
// The two moving cards are animated pictures (img/fan-*.webp), not videos: the page draws them itself, so they
// play on the tilted cards on every TV (Fire TV draws real videos on a layer behind the page).
function fanRun(on) {
  if (on && !fanTimer) fanTimer = setInterval(turnFan, 4000);
  if (!on && fanTimer) { clearInterval(fanTimer); fanTimer = 0; }
}

function stopVideo() {
  document.documentElement.classList.remove('video-on');
  vid.classList.remove('on');
  vid.pause();
  playing = '';
  setTimeout(() => { if (!playing) { vid.removeAttribute('src'); vid.load(); } }, 900); // after the fade
}
function show() {
  if (!order.length) return;
  clearTimeout(timer);
  pos = (pos + 1) % order.length;
  const item = order[pos];
  if (item.kind === 'video') return showVideo(item.url);
  coming = item.url;
  const img = new Image();
  img.onload = img.onerror = () => {
    const back = front === 'slideA' ? 'slideB' : 'slideA';
    const el = $(back);
    const pic = el.querySelector('.pic');
    // A wide photo fills the screen; a tall one (phone held upright) or a banner much wider than the TV is shown
    // whole over a blurred copy of itself.
    const whole = showWhole(img.naturalWidth, img.naturalHeight);
    const ms = stayMs();
    el.classList.add('now'); // the spare layer goes off at once (it is under the photo on screen) before it changes
    el.classList.remove('on');
    pic.src = item.url;
    // Wait (briefly) until the photo is decoded so the fade starts with it; decode() can hang, so never more than 0.3 s.
    const decoded = pic.decode ? pic.decode().catch(() => {}) : Promise.resolve();
    Promise.race([decoded, new Promise((r) => setTimeout(r, 300))]).then(() => {
      if (!order[pos] || order[pos].url !== item.url) return; // the loop moved on meanwhile
      const old = front;
      // Under the home screen or a video the new photo goes on at once, and that layer above fades away; otherwise
      // it fades in on top of the old photo, which stays fully on until covered (no dark dip half way).
      const covered = homeOn() || !!playing;
      $('stage').insertBefore(el, vid);
      void el.offsetWidth;
      el.classList.toggle('now', covered);
      el.classList.toggle('whole', whole);
      el.style.setProperty('--photo', whole ? 'url("' + item.url + '")' : 'none');
      el.classList.add('has', 'on');
      front = back;
      shown = item.url;
      coming = '';
      if (playing) stopVideo();
      homeOut();
      setTimeout(() => { if (front !== old) $(old).classList.remove('on'); el.classList.remove('now'); }, 1500);
      clearTimeout(timer);
      timer = setTimeout(show, ms);
    });
    // Preload the next photo so the change is instant.
    const next = order[(pos + 1) % order.length];
    if (order.length > 1 && next.kind !== 'video') new Image().src = next.url;
  };
  img.src = item.url;
  timer = setTimeout(show, stayMs() + 10000); // only if the photo never loads
}
const stayMs = () => Math.max(3, (st && st.interval) || 8) * 1000; // "Photo changes every" in phone Settings
function showVideo(url) {
  playing = url;
  coming = '';
  vid.muted = !(st && st.videoSound && soundOn);
  vid.src = url;
  vid.currentTime = 0;
  const go = vid.play();
  // Sound may be blocked until a button press: then play without sound.
  if (go && go.catch) go.catch(() => { vid.muted = true; playSafe(vid).catch(() => { timer = setTimeout(show, 3000); }); });
  const covered = homeOn();
  vid.classList.toggle('now', covered);
  vid.classList.add('on');
  document.documentElement.classList.add('video-on'); // Fire TV app: page see-through over the video (tv.css)
  homeOut();
  if (covered) setTimeout(() => vid.classList.remove('now'), 100);
  timer = setTimeout(show, MAX_VIDEO_MS);
}
vid.addEventListener('ended', () => { if (playing) show(); });
vid.addEventListener('loadedmetadata', () => vid.classList.toggle('whole', showWhole(vid.videoWidth, vid.videoHeight)));
// Tall (width under 1.2 x height), or much wider than a TV (over 1.95 x height; a TV is 1.78): filling the screen
// would cut off too much, so it is shown whole.
function showWhole(w, h) { return w > 0 && h > 0 && (w / h < 1.2 || w / h > 1.95); }
vid.addEventListener('error', () => { if (playing) { clearTimeout(timer); timer = setTimeout(show, 1500); } });

// ------------------------------------------------------------- token called: big card, chime, voice
// Inside the PhotoFlix Fire TV app, sound needs no button press and the app speaks with Android's own voice.
const app = window.PhotoFlixTV || null;
if (app) document.documentElement.classList.add('pf-app'); // see tv.css: videos show through the page
let soundOn = !!app;
let audio = null;
let callTimer = 0;
let lastCall = null; // said again if sound is turned on while its card is still showing
// A room number ("1", "2B", "Room 1", "room no 1") is shown as "Room 1" and said as "room number 1".
// Anything else ("Counter 3", "Dr. Rao cabin") stays as typed.
const ROOM_NO = /^(?:room\s*(?:no\.?|number|#)?\s*)?(\d+[A-Za-z]?)$/i;
function roomText(r) { r = String(r || '').trim(); const m = ROOM_NO.exec(r); return m ? 'Room ' + m[1] : r; }
function roomSpeech(r) { r = String(r || '').trim(); const m = ROOM_NO.exec(r); return m ? 'room number ' + m[1] : r; }
function announce(m) {
  const room = roomText(m.room);
  $('callTok').textContent = m.token;
  $('callName').textContent = m.name || '';
  $('callRoom').innerHTML = room ? '<b>' + esc(room) + '</b>' : ''; // just "Room 1" here; the voice says the full sentence
  $('callRoom').parentNode.classList.toggle('none', !room); // no room set: no box (the voice says "please come in")
  $('call').classList.remove('hidden');
  const resume = playing && !vid.muted && !vid.paused;
  if (resume) vid.pause(); // the announcement must be heard
  clearTimeout(callTimer);
  const shownAt = Date.now();
  const hide = () => {
    // A slow TV may still be saying it: keep the card up until the voice is done, but never past 25 s.
    if (speaking && Date.now() - shownAt < 25000) { callTimer = setTimeout(hide, 800); return; }
    $('call').classList.add('hidden');
    lastCall = null;
    if (resume && playing) playSafe(vid).catch(() => {});
  };
  callTimer = setTimeout(hide, 12000);
  lastCall = m;
  if (!soundOn) { soundHint(true); return; }
  speakCall(m);
}
let callTurn = 0; // a newer call stops an older one from still speaking
let speaking = false; // the recorded voice is playing (or about to play its second time)
function speakCall(m) {
  const room = roomSpeech(m.room);
  const turn = ++callTurn;
  stopVoice();
  const chimed = chime();
  if (!st || !st.voice) return;
  const text = 'Token number ' + m.token + (m.name ? ', ' + m.name : '') + (room ? '. Please go to ' + room : '. Please come in');
  chimed.then(() => { // the voice starts when the chime has finished
    if (turn !== callTurn) return;
    // The server's recording of the sentence (Amazon Polly) plays on any TV; Fire TV's own speech engine has no
    // voices for apps. Without a recording, or if it can't play, the TV's own voice says it.
    // Said twice, like a hospital announcement.
    if (!m.audio) { console.info('PhotoFlix: token ' + m.token + ' announced with the TV\'s own voice (no recording)'); return ownVoice(text); }
    let fell = false;
    const fall = (why) => {
      if (fell) return;
      fell = true;
      voiceAudio = null;
      speaking = false;
      console.info('PhotoFlix: recording could not play (' + (why && (why.name || why.type) || 'error') + '), using the TV\'s own voice');
      ownVoice(text);
    };
    const a = new Audio(m.audio);
    let plays = 1;
    let logged = false;
    a.onended = () => {
      if (plays++ >= 2) { speaking = false; return; } // said twice: done
      setTimeout(() => { if (voiceAudio === a) { a.currentTime = 0; playSafe(a).catch(() => { speaking = false; }); } }, 700);
    };
    a.onerror = fall;
    a.onplaying = () => { if (!logged) { logged = true; console.info('PhotoFlix: token ' + m.token + ' announced with the recorded voice'); } };
    voiceAudio = a;
    speaking = true;
    playSafe(a).catch(fall);
  });
}
let voiceAudio = null;
function ownVoice(text) {
  if (app && app.canSpeak()) { app.speak(text); app.speak(text); } // queued: one after the other
  else if ('speechSynthesis' in window) { say(text); say(text); }
}
function stopVoice() {
  speaking = false;
  if (voiceAudio) { voiceAudio.onerror = null; voiceAudio.onended = null; voiceAudio.pause(); voiceAudio = null; }
  if (app) app.stop();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
function say(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.9;
  const v = speechSynthesis.getVoices().find((x) => /en[-_]IN/i.test(x.lang)) || speechSynthesis.getVoices().find((x) => /^en/i.test(x.lang));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
// "Ding-dong" before the voice: a sound file plays on every TV; if it can't, the browser makes the tones itself.
// Loaded once when the page opens, so it starts at once on every call.
const chimeSound = new Audio('chime.mp3');
chimeSound.preload = 'auto';
// Resolves when the chime is over. If it does not start within 3 s, the announcement goes on without waiting.
function chime() {
  return new Promise((done) => {
    let over = false;
    const end = () => { if (!over) { over = true; clearTimeout(cap); done(); } };
    const tones = () => { toneChime(); setTimeout(end, 1600); };
    let cap = setTimeout(end, 3000); // never started
    const c = chimeSound;
    c.onplaying = () => { clearTimeout(cap); cap = setTimeout(end, 3000); }; // started: wait for its end (2 s)
    c.onended = end;
    c.onerror = tones;
    c.pause();
    try { c.currentTime = 0; } catch (e) { /* not loaded yet */ }
    playSafe(c).catch(tones);
  });
}
// Old TV browsers return nothing from play(); newer ones return a promise that fails when sound is not allowed.
function playSafe(el) {
  try { const p = el.play(); return p && p.then ? p : Promise.resolve(); } catch (e) { return Promise.reject(e); }
}
function toneChime() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    [[880, 0], [660, 0.45]].forEach(([f, t]) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, audio.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.5, audio.currentTime + t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + 1.2);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + t);
      o.stop(audio.currentTime + t + 1.3);
    });
  } catch (e) { /* no audio */ }
}

// Some screens allow sound without any button press: the PhotoFlix TV app, a monitor's browser started with
// tv-screen-kiosk.bat (or --autoplay-policy=no-user-gesture-required), or a browser that knows this page well.
// A silent sound tells: if it plays, announcements are on straight away and the "press OK" hint never shows.
if (!soundOn) {
  playSafe(new Audio('silence.mp3')).then(() => {
    if (soundOn) return;
    soundOn = true;
    soundHint(false);
    console.info('PhotoFlix: sound allowed without a button press');
  }).catch(() => {});
}
// Other browsers only allow sound after a button press: the first OK on the remote (or click) turns it on.
// After that, OK shows the staff QR and Back hides it. Once staff have joined, the QR only shows when asked
// (OK here, or "Show QR on TV" on a phone).
function unlock() {
  if (!soundOn) {
    soundOn = true;
    soundHint(false);
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (e) { /* ignore */ }
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(' '));
    if (lastCall) speakCall(lastCall); // a token is on screen right now: say it
    return;
  }
  setQrShown(true);
}
const qrShown = () => !$('qrCorner').classList.contains('hidden');
function setQrShown(show) {
  if (!st || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ t: 'tv:qr', show }));
  st.showQr = show; // at once; the server confirms
  render();
}
// Back on the remote: hides the QR. Returns false when there was nothing to hide (the Fire TV app then goes home).
window.pfBack = () => { if (!qrShown()) return false; setQrShown(false); return true; };
// ------------------------------------------------------------- screen name + room from the TV
// Menu (≡) on the remote opens the box (in a browser); the Fire TV app shows its own box and calls pfApplySettings.
const tvSetOpen = () => !$('tvSet').classList.contains('hidden');
function openTvSettings() {
  if (!st) return;
  $('tvName').value = st.name || '';
  $('tvRoom').value = st.room || '';
  $('tvSet').classList.remove('hidden');
  setTimeout(() => $('tvName').focus(), 50);
}
function closeTvSettings() { $('tvSet').classList.add('hidden'); }
function applyTvSettings(name, room) {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify({ t: 'tv:settings', name: String(name || ''), room: String(room || '') }));
  return true;
}
window.pfSettings = () => JSON.stringify({ name: (st && st.name) || '', room: (st && st.room) || '' });
window.pfApplySettings = (name, room) => applyTvSettings(name, room);
$('tvSave').addEventListener('click', () => { applyTvSettings($('tvName').value.trim(), $('tvRoom').value.trim()); closeTvSettings(); });
$('tvCancel').addEventListener('click', closeTvSettings);
// Up / down moves between the fields and buttons with the remote.
$('tvSet').addEventListener('keydown', (e) => {
  const order = ['tvName', 'tvRoom', 'tvSave', 'tvCancel'];
  const i = order.indexOf(document.activeElement && document.activeElement.id);
  if (e.key === 'ArrowDown' || (e.key === 'Enter' && i >= 0 && i < 2)) { e.preventDefault(); $(order[Math.min(order.length - 1, i + 1)]).focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); $(order[Math.max(0, i - 1)]).focus(); }
  else if (e.key === 'ArrowRight' && i === 2) { e.preventDefault(); $('tvCancel').focus(); }
  else if (e.key === 'ArrowLeft' && i === 3) { e.preventDefault(); $('tvSave').focus(); }
  else if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') { e.preventDefault(); closeTvSettings(); }
  e.stopPropagation();
});
document.addEventListener('keydown', (e) => {
  if (tvSetOpen()) return;
  if (e.key === 'ContextMenu' || e.key === 'Menu' || e.keyCode === 82 || e.key === 'm' || e.key === 'M') { e.preventDefault(); openTvSettings(); return; }
  if (['Enter', ' ', 'NumpadEnter', 'Select'].includes(e.key) || e.keyCode === 23) unlock();
  else if (['Escape', 'Backspace', 'GoBack', 'BrowserBack'].includes(e.key) || e.keyCode === 4) { if (window.pfBack()) e.preventDefault(); }
});
document.addEventListener('click', unlock);
// The hint sits inside the setup card while it shows, else at the bottom of the screen.
function soundHint(show) { $('sound').classList.toggle('hidden', !show); $('setupSound').classList.toggle('hidden', !show); }
setTimeout(() => { if (!soundOn) soundHint(true); }, 3000);

// ------------------------------------------------------------- weather (city set in the phone's Settings)
// Open-Meteo is free and needs no key.
const WX = [[0, '☀️', 'Clear Sky'], [1, '🌤️', 'Mainly Clear'], [2, '⛅', 'Partly Cloudy'], [3, '☁️', 'Cloudy'], [48, '🌫️', 'Foggy'], [57, '🌦️', 'Drizzle'],
  [67, '🌧️', 'Rain'], [77, '🌨️', 'Snow'], [82, '🌧️', 'Rain Showers'], [86, '🌨️', 'Snow Showers'], [99, '⛈️', 'Thunderstorm']];
let wxCity = '';
let wxAt = 0;
async function updateWeather(force) {
  const city = (st && st.city) || '';
  if (!city) { $('weather').classList.add('hidden'); wxCity = ''; return; }
  if (!force && city === wxCity && Date.now() - wxAt < 30 * 60000) return;
  wxCity = city;
  wxAt = Date.now();
  try {
    const geo = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(city))).json();
    const g = geo.results && geo.results[0];
    if (!g) throw new Error('city not found');
    const w = await (await fetch('https://api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code&latitude=' + g.latitude + '&longitude=' + g.longitude)).json();
    const code = w.current.weather_code;
    const wx = WX.find(([max]) => code <= max) || WX[WX.length - 1];
    $('wxIco').textContent = wx[1];
    $('wxDesc').textContent = wx[2];
    $('wxTemp').textContent = Math.round(w.current.temperature_2m) + '°C';
    $('wxCity').textContent = g.name;
    $('weather').classList.remove('hidden');
  } catch (e) {
    $('weather').classList.add('hidden');
    wxAt = Date.now() - 25 * 60000; // try again in about 5 minutes
  }
}
setInterval(() => updateWeather(), 5 * 60000);

// ------------------------------------------------------------- clock
function tick() {
  const d = new Date();
  $('time').textContent = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }); // "9:15 am"
  $('date').textContent = d.toLocaleDateString('en-IN', { weekday: 'long' }) + ', ' + d.getDate() + ' ' + d.toLocaleDateString('en-IN', { month: 'long' }); // "Tuesday, 20 October"
}
setInterval(tick, 1000);
tick();

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
connect();
