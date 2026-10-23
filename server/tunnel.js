// Public link for phones on any network: runs "cloudflared tunnel --url http://localhost:<port>" next to the
// server and restarts it if it stops or Cloudflare drops it. The free link changes on every restart;
// the TV re-reads it from /api/info, so its QR code follows. Off when PUBLIC_URL is set or TUNNEL=off.
import fs from 'fs';
import { spawn } from 'child_process';

const WINDOWS_EXE = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
let url = null;
let child = null;
let stopping = false;

export const tunnelUrl = () => url;

export function startTunnel(port, onUrl) {
  const exe = process.platform === 'win32' && fs.existsSync(WINDOWS_EXE) ? WINDOWS_EXE : 'cloudflared';
  let notFound = 0;
  const run = () => {
    url = null;
    notFound = 0;
    child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', 'http://localhost:' + port], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const read = (buf) => {
      const text = buf.toString();
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && m[0] !== url) {
        url = m[0];
        console.log('\n  Cloudflare link (QR codes): ' + url + '/tv/   (phones on any network can join)\n');
        if (onUrl) onUrl(url);
      }
      // The link was dropped on Cloudflare's side (e.g. after the PC slept): get a fresh one.
      if (/Tunnel not found/.test(text) && ++notFound >= 3) { console.log('  Cloudflare link expired, getting a new one...'); child.kill(); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (e) => {
      child = null;
      console.log(e.code === 'ENOENT'
        ? '  Tip: install cloudflared so phones on any network can join (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).'
        : '  cloudflared could not start: ' + e.message);
    });
    child.on('exit', () => {
      const wasRunning = !!child;
      child = null;
      url = null;
      if (!stopping && wasRunning) setTimeout(run, 3000);
    });
  };
  run();
  const stop = () => { stopping = true; if (child) child.kill(); };
  process.on('exit', stop);
  ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => { stop(); process.exit(0); }));
}
