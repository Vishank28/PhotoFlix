// Token announcements as sound files from Amazon Polly (Indian English), so every TV can play them: Fire TV's own
// speech engine has no voices for apps, and TV browsers often have no voice at all. Needs the polly:SynthesizeSpeech
// permission for this server's AWS user / role. PF_SPEECH=off turns it off (the TV then tries its own voice).
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ON = process.env.PF_SPEECH !== 'off';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const VOICE = process.env.PF_VOICE || 'Kajal'; // Indian English, natural ("neural") voice
const VOICE_STANDARD = 'Raveena'; // Indian English, if the natural voice is not available in this region
const DIR = path.join(os.tmpdir(), 'photoflix-speech'); // made once per sentence, kept for repeat calls
const KEEP = 300;
const made = new Map(); // id -> Promise<file or null>, oldest first
let polly = null;

const fileOf = (id) => path.join(DIR, id + '.mp3');

async function make(id, text) {
  const out = fileOf(id);
  if (fs.existsSync(out)) return out;
  polly = polly || new PollyClient({ region: REGION });
  let err = null;
  for (const [Engine, VoiceId] of [['neural', VOICE], ['standard', VOICE_STANDARD]]) {
    try {
      const r = await polly.send(new SynthesizeSpeechCommand({ Engine, VoiceId, LanguageCode: 'en-IN', OutputFormat: 'mp3', Text: text }));
      const bytes = await r.AudioStream.transformToByteArray();
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(out, bytes);
      return out;
    } catch (e) {
      err = e;
      if (e.name === 'AccessDeniedException' || e.name === 'UnrecognizedClientException') break; // no point trying again
    }
  }
  console.error('photoflix: Amazon Polly could not make the announcement (' + (err && (err.name + ': ' + err.message)) + ')' +
    (err && err.name === 'AccessDeniedException' ? ' - give this AWS user the polly:SynthesizeSpeech permission' : ''));
  return null;
}

/** Starts making the sound for [text]; returns its address for the TV ('' when speech is off). */
export function prepare(text) {
  if (!ON) return '';
  const id = crypto.createHash('sha1').update(VOICE + '|' + text).digest('hex').slice(0, 20);
  if (!made.has(id)) {
    made.set(id, make(id, text).then((f) => { if (!f) made.delete(id); return f; })); // a failure is tried again next time
    if (made.size > KEEP) { const [old] = made.keys(); made.delete(old); fs.rm(fileOf(old), { force: true }, () => {}); }
  }
  return '/api/speech/' + id + '.mp3';
}

/** The sound file for an id (waits while it is being made); null if unknown or it failed. */
export async function speechFile(id) {
  if (!/^[0-9a-f]{20}$/.test(id)) return null;
  if (made.has(id)) return made.get(id);
  return fs.existsSync(fileOf(id)) ? fileOf(id) : null; // made before a restart
}
