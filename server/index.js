// PhotoFlix server: TV page (/tv/), staff phone page (/phone/, opened from the QR; nothing to install), WebSocket (/ws).
// Screen logic lives in screens.js, storage in store.js, the public link in tunnel.js.
import './env.js'; // first: loads .env before other modules read process.env
import express from 'express';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import { attachScreens, publishLink, ready } from './screens.js';
import { startTunnel, tunnelUrl } from './tunnel.js';
import { speechFile } from './speech.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3200;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, file) => { if (/\.(html|js|css)$/.test(file)) res.set('Cache-Control', 'no-cache'); },
}));
app.get('/', (req, res) => res.redirect('/tv/'));

function lanIps() {
  return Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
}
// The TV builds its QR code from this: fixed PUBLIC_URL, else the Cloudflare link, else this PC on the Wi-Fi.
// app: 'photoflix' lets a new TV app recognise this PC when it looks for PhotoFlix on its Wi-Fi.
app.get('/api/info', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ app: 'photoflix', publicUrl: PUBLIC_URL || tunnelUrl() || null, ips: lanIps(), port: PORT });
});
app.get('/api/qr.svg', async (req, res) => {
  const data = String(req.query.data || '').slice(0, 300);
  if (!/^https?:\/\//.test(data)) return res.status(400).end();
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600');
  res.send(await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } }));
});

// A token announcement made by speech.js (the TV gets the address with the call).
app.get(/^\/api\/speech\/([0-9a-f]{20})\.mp3$/, async (req, res) => {
  const file = await speechFile(req.params[0]);
  if (!file) return res.status(404).end();
  res.type('audio/mpeg').set('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
});

const server = http.createServer(app);
const wss = attachScreens(app, express);
server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').split('?')[0] !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error('\n  PhotoFlix is already running on port ' + PORT + ' (another window?). Close it first, or use another port: set PORT=3201\n');
  else console.error('\n  PhotoFlix could not start: ' + e.message + '\n');
  process.exit(1);
});
ready.then(() => server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  PHOTOFLIX is running\n');
  console.log('  TV screen on this PC:   http://localhost:' + PORT + '/tv/');
  lanIps().forEach((ip) => console.log('  TV screen on Wi-Fi:     http://' + ip + ':' + PORT + '/tv/'));
  if (PUBLIC_URL) { console.log('  Public URL (QR codes):  ' + PUBLIC_URL + '/tv/'); publishLink(PUBLIC_URL); }
  else if (process.env.TUNNEL !== 'off') { console.log('  Starting the Cloudflare link so phones on any network can join...'); startTunnel(PORT, publishLink); }
  console.log('\n  Open the TV screen, then scan its QR code with the staff phone.\n');
})).catch((e) => {
  console.error('\n  PhotoFlix could not start: ' + e.message);
  console.error('  If you use S3: check "aws configure" and PF_BUCKET in photoflix/.env.\n');
  process.exit(1);
});
