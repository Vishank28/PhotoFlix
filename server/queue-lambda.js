// Patient queue in AWS: the PhotoFlix Lambda (PF_LAMBDA, e.g. "patientopd") keeps tokens and patients in DynamoDB.
// On when PF_LAMBDA is set in .env; otherwise the queue stays in this server (screens.js).
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const FN = process.env.PF_LAMBDA || '';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
export const lambdaOn = !!FN;
export const lambdaName = FN;
const client = FN ? new LambdaClient({ region: REGION }) : null;

// Calls the Lambda with { command, ...fields } and returns its "data"; throws its status_message on ERROR.
async function run(command, fields) {
  const r = await client.send(new InvokeCommand({ FunctionName: FN, Payload: Buffer.from(JSON.stringify({ command, ...fields })) }));
  const text = Buffer.from(r.Payload || []).toString('utf8');
  if (r.FunctionError) throw new Error('Lambda error: ' + text.slice(0, 200));
  const out = text ? JSON.parse(text) : null;
  if (!out || out.status !== 'SUCCESS') throw new Error((out && out.status_message) || 'Lambda: ' + text.slice(0, 200));
  return out.data;
}

// Lambda patient -> the shape the phone page and TV use.
const STATUS = { WAITING: 'waiting', CALLED: 'called', DONE: 'done' };
const toPatient = (p) => ({
  token: Number(p.token), name: p.name || '', phone: p.phone || '', status: STATUS[p.patient_status] || 'waiting',
  at: p.created_on, by: p.added_by, order: p.line_order, room: p.room || '', assignedRoom: p.assigned_room || '', calledAt: p.called_on,
  calledBy: p.called_by, calls: p.calls, skipped: p.skipped, smsSent: !!p.sms_sent,
});

export const queue = {
  async createScreen(code, name) {
    try { await run('createScreen', { screen_code: code, screen_name: name }); } catch (e) { if (!/already exists/.test(e.message)) throw e; }
  },
  async list(code) {
    const d = await run('listPatients', { screen_code: code });
    return { queue: d.patients.map(toPatient), current: d.current ? toPatient(d.current) : null, nextToken: Number(d.next_token) };
  },
  // room = the patient's own room (empty = the calling nurse's room); on edit, undefined leaves it as it is.
  add: (code, name, phone, by, room) => run('addPatient', { screen_code: code, name, phone, room, requested_by: by }).then(toPatient),
  edit: (code, token, name, phone, room) => run('editPatient', { screen_code: code, token, name, phone, room }).then(toPatient),
  async next(code, room, by) { const p = await run('callNext', { screen_code: code, room, requested_by: by }); return p ? toPatient(p) : null; },
  update: (code, token, action, room, by) => run('updatePatient', { screen_code: code, token, action, room, requested_by: by }).then(toPatient),
  remove: (code, token) => run('deletePatient', { screen_code: code, token }),
};
