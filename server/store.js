// Storage for PhotoFlix screens.
//   Screens + patients: DynamoDB when PF_TABLE is set, one row per screen ("META") and one per patient token
//                       ("PAT#000012"); patient rows also carry a TTL (expiresAt) so names never linger.
//                       Without PF_TABLE: one state.json per screen (in S3 or the local data/ folder).
//   Photos / videos:    S3 when PF_BUCKET is set (photoflix/<code>/<id>.jpg or .mp4), else data/<code>/<id>.jpg / .mp4.
// AWS credentials come from the default chain: "aws configure" on a PC, the instance role on EC2.
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';

const BUCKET = process.env.PF_BUCKET || '';
const TABLE = process.env.PF_TABLE || '';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const PK = process.env.PF_TABLE_PK || 'couch_key'; // key names of the (shared) table
const SK = process.env.PF_TABLE_SK || 'couch_sort';
const PREFIX = 'photoflix/';
const UPLOAD_LINK_S = 6 * 3600; // signed links for a phone's video upload (a slow phone may need hours)
const FETCH_PARALLEL = 8; // pieces of an uploaded video fetched at once
const LINK_READ_S = 7 * 24 * 3600; // longest a signed link can last; phones get a fresh one each time they connect
const PATIENT_TTL_S = 36 * 3600; // backup only: the server also clears every list at midnight
const SCREEN_TTL_S = 365 * 86400; // a screen nobody has used for a year is removed
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

const screenKey = (code) => 'PF#' + code;
const patientKey = (token) => 'PAT#' + String(token).padStart(6, '0');

// Every store has: describe, loadAll() -> [{ ...meta, queue }], save(code, meta, queue, changedTokens, removedTokens),
// putPhoto, getPhoto, delPhoto, and for videos putVideo(code, id, file), videoSize(code, id), getVideo(code, id, start, end), delVideo.
// The S3 store also has direct uploads (the phone sends a video's original straight to S3, see screens.js):
// startUpload(code, id, parts) -> { uploadId, urls }, finishUpload(code, id, uploadId, etags), fetchUpload(code, id, file), dropUpload(code, id, uploadId),
// and the current public link for phones: putLink(url), linkReadUrl() -> a signed link to read it (see screens.js).
export async function createStore() {
  const photos = BUCKET ? await s3Photos() : localPhotos();
  const states = TABLE ? await dynamoStates(photos) : photos.files;
  return { ...photos, ...states, describe: states.describe + ' · photos in ' + photos.describe };
}

// ------------------------------------------------------------- photos (+ state.json files)
function localPhotos() {
  const dir = (code) => { const d = path.join(ROOT, code); fs.mkdirSync(d, { recursive: true }); return d; };
  fs.mkdirSync(ROOT, { recursive: true });
  return {
    describe: 'local folder ' + ROOT,
    async putPhoto(code, id, buf) { await fs.promises.writeFile(path.join(dir(code), id + '.jpg'), buf); },
    async getPhoto(code, id) { return fs.createReadStream(path.join(ROOT, code, id + '.jpg')); },
    async delPhoto(code, id) { await fs.promises.unlink(path.join(ROOT, code, id + '.jpg')).catch(() => {}); },
    async putVideo(code, id, file) { await fs.promises.copyFile(file, path.join(dir(code), id + '.mp4')); },
    async videoSize(code, id) { return (await fs.promises.stat(path.join(ROOT, code, id + '.mp4'))).size; },
    async getVideo(code, id, start, end) { return fs.createReadStream(path.join(ROOT, code, id + '.mp4'), { start, end }); },
    async delVideo(code, id) { await fs.promises.unlink(path.join(ROOT, code, id + '.mp4')).catch(() => {}); },
    files: {
      describe: 'screens in ' + ROOT,
      async loadAll() {
        return fs.readdirSync(ROOT).map((code) => {
          try { return JSON.parse(fs.readFileSync(path.join(ROOT, code, 'state.json'), 'utf8')); } catch (e) { return null; }
        }).filter(Boolean);
      },
      async save(code, meta, queue) { await fs.promises.writeFile(path.join(dir(code), 'state.json'), JSON.stringify({ ...meta, queue })); },
      async removeOld() {},
    },
  };
}

async function s3Photos() {
  const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand,
    CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  // Checksums only when S3 requires them: otherwise signed upload links carry a checksum of an empty body
  // and the phone's real upload is refused.
  const s3 = new S3Client({ region: REGION, requestChecksumCalculation: 'WHEN_REQUIRED' });
  const key = (code, name) => PREFIX + code + '/' + name;
  const text = async (body) => Buffer.concat(await body.toArray()).toString('utf8');
  await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, MaxKeys: 1 })); // fail now if the bucket/login is wrong
  async function stateFiles() {
    const keys = [];
    let token;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }));
      (r.Contents || []).forEach((o) => { if (o.Key.endsWith('/state.json')) keys.push(o.Key); });
      token = r.NextContinuationToken;
    } while (token);
    return keys;
  }
  return {
    describe: 'S3 bucket ' + BUCKET + ' (' + PREFIX + ')',
    async putPhoto(code, id, buf) { await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key(code, id + '.jpg'), Body: buf, ContentType: 'image/jpeg' })); },
    async getPhoto(code, id) { return (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key(code, id + '.jpg') }))).Body; },
    async delPhoto(code, id) { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key(code, id + '.jpg') })); },
    async putVideo(code, id, file) {
      const size = (await fs.promises.stat(file)).size;
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key(code, id + '.mp4'), Body: fs.createReadStream(file), ContentLength: size, ContentType: 'video/mp4' }));
    },
    async videoSize(code, id) { return (await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key(code, id + '.mp4') }))).ContentLength; },
    async getVideo(code, id, start, end) {
      return (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key(code, id + '.mp4'), Range: 'bytes=' + start + '-' + end }))).Body;
    },
    async delVideo(code, id) { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key(code, id + '.mp4') })); },

    // A video's original goes from the phone straight to S3 in parts (signed links, valid for UPLOAD_LINK_S),
    // so it never passes through this PC or the Cloudflare link. The server fetches it once to shrink it.
    async startUpload(code, id, parts) {
      const Key = key(code, 'upload-' + id);
      const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key }));
      const urls = await Promise.all(Array.from({ length: parts }, (_, i) =>
        getSignedUrl(s3, new UploadPartCommand({ Bucket: BUCKET, Key, UploadId, PartNumber: i + 1 }), { expiresIn: UPLOAD_LINK_S })));
      return { uploadId: UploadId, urls };
    },
    async finishUpload(code, id, uploadId, etags) {
      await s3.send(new CompleteMultipartUploadCommand({ Bucket: BUCKET, Key: key(code, 'upload-' + id), UploadId: uploadId,
        MultipartUpload: { Parts: etags.map((ETag, i) => ({ ETag, PartNumber: i + 1 })) } }));
    },
    // In pieces, several at once: one connection from India to the bucket is slow (~0.4 MB/s).
    async fetchUpload(code, id, file) {
      const Key = key(code, 'upload-' + id);
      const size = (await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }))).ContentLength;
      const PIECE = 8 * 1024 * 1024;
      const pieces = Math.ceil(size / PIECE);
      await (await fs.promises.open(file, 'w')).close();
      let next = 0;
      const worker = async () => {
        while (next < pieces) {
          const n = next++;
          const start = n * PIECE;
          const end = Math.min(size, start + PIECE) - 1;
          const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key, Range: 'bytes=' + start + '-' + end }));
          await pipeline(r.Body, fs.createWriteStream(file, { flags: 'r+', start }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(FETCH_PARALLEL, pieces) }, worker));
    },
    async dropUpload(code, id, uploadId) {
      const Key = key(code, 'upload-' + id);
      if (uploadId) await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key, UploadId: uploadId })).catch(() => {});
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key })).catch(() => {});
    },
    // The free Cloudflare link changes when this PC restarts. It is kept in S3 so phones can find the new one.
    async putLink(url) {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: PREFIX + 'link.json', Body: JSON.stringify({ url, at: Date.now() }), ContentType: 'application/json', CacheControl: 'no-cache' }));
    },
    linkReadUrl: () => getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: PREFIX + 'link.json' }), { expiresIn: LINK_READ_S }),
    files: {
      describe: 'screens in S3 bucket ' + BUCKET,
      async loadAll() {
        const out = await Promise.all((await stateFiles()).map(async (k) => {
          try { return JSON.parse(await text((await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: k }))).Body)); } catch (e) { return null; }
        }));
        return out.filter(Boolean);
      },
      async save(code, meta, queue) {
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key(code, 'state.json'), Body: JSON.stringify({ ...meta, queue }), ContentType: 'application/json' }));
      },
      // After moving to DynamoDB: the old state.json (with patient names) is removed.
      async removeOld(code) { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key(code, 'state.json') })); },
    },
  };
}

// ------------------------------------------------------------- DynamoDB
async function dynamoStates(photos) {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand, PutCommand, BatchWriteCommand } = await import('@aws-sdk/lib-dynamodb');
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const now = () => Math.floor(Date.now() / 1000);
  const strip = (item) => { const o = { ...item }; delete o[PK]; delete o[SK]; delete o.expiresAt; return o; };
  async function batch(requests) {
    for (let i = 0; i < requests.length; i += 25) {
      let items = { [TABLE]: requests.slice(i, i + 25) };
      for (let tries = 0; tries < 5 && items && items[TABLE] && items[TABLE].length; tries++) {
        const r = await db.send(new BatchWriteCommand({ RequestItems: items }));
        items = r.UnprocessedItems;
        if (items && items[TABLE]) await new Promise((res) => setTimeout(res, 200 * (tries + 1)));
      }
    }
  }
  const putPatient = (code, p) => ({ PutRequest: { Item: { [PK]: screenKey(code), [SK]: patientKey(p.token), ...p, expiresAt: now() + PATIENT_TTL_S } } });
  const delPatient = (code, token) => ({ DeleteRequest: { Key: { [PK]: screenKey(code), [SK]: patientKey(token) } } });

  const api = {
    describe: 'DynamoDB table ' + TABLE + ' (' + REGION + ')',
    async loadAll() {
      const byScreen = new Map();
      let start;
      do {
        const r = await db.send(new ScanCommand({ TableName: TABLE, FilterExpression: 'begins_with(#pk, :pf)', ExpressionAttributeNames: { '#pk': PK }, ExpressionAttributeValues: { ':pf': 'PF#' }, ExclusiveStartKey: start }));
        (r.Items || []).forEach((it) => {
          const code = it[PK].slice(3);
          if (!byScreen.has(code)) byScreen.set(code, { meta: null, queue: [] });
          const s = byScreen.get(code);
          if (it[SK] === 'META') s.meta = strip(it);
          else if (String(it[SK]).startsWith('PAT#') && !(it.expiresAt && it.expiresAt < now())) s.queue.push(strip(it));
        });
        start = r.LastEvaluatedKey;
      } while (start);
      const screens = Array.from(byScreen.values()).filter((s) => s.meta).map((s) => ({ ...s.meta, queue: s.queue.sort((a, b) => a.order - b.order || a.token - b.token) }));
      // One-time move: screens that only exist as state.json (S3/local) are copied in, then the file is removed.
      const known = new Set(screens.map((s) => s.code));
      for (const old of await photos.files.loadAll()) {
        if (known.has(old.code)) continue;
        const queue = (old.queue || []).map((p, i) => ({ ...p, order: i }));
        const meta = { ...old };
        delete meta.queue;
        await api.save(old.code, meta, queue, queue.map((p) => p.token), []);
        await photos.files.removeOld(old.code).catch(() => {});
        screens.push({ ...meta, queue });
        console.log('  PhotoFlix: moved screen ' + old.code + ' into DynamoDB');
      }
      return screens;
    },
    // Writes the screen row, plus only the patients that changed (not the whole list every time).
    async save(code, meta, queue, changed, removed) {
      await db.send(new PutCommand({ TableName: TABLE, Item: { [PK]: screenKey(code), [SK]: 'META', ...meta, expiresAt: now() + SCREEN_TTL_S } }));
      const ch = new Set(changed);
      await batch([
        ...queue.filter((p) => ch.has(p.token)).map((p) => putPatient(code, p)),
        ...removed.filter((t) => !queue.some((p) => p.token === t)).map((t) => delPatient(code, t)),
      ]);
    },
  };
  await db.send(new ScanCommand({ TableName: TABLE, Limit: 1 })); // fail now if the table/login is wrong
  return api;
}
