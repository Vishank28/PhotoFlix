// Local test: runs the Lambda against an in-memory fake of DynamoDB + SNS (only the expressions index.mjs uses).
import * as ddb from '@aws-sdk/lib-dynamodb';
import { SNSClient } from '@aws-sdk/client-sns';

const tables = {};
const sms = [];
const keyOf = (T, k) => T + '|' + Object.keys(k).sort().map((n) => k[n]).join('|');
const condErr = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
function val(item, tok, v) { return tok.startsWith(':') ? v[tok] : item ? item[tok] : undefined; }
function cond(expr, item, v) {
  if (!expr) return true;
  return expr.split(' AND ').every((c) => {
    c = c.trim();
    let m = c.match(/^attribute_exists\((\w+)\)$/); if (m) return !!item && item[m[1]] !== undefined;
    m = c.match(/^attribute_not_exists\((\w+)\)$/); if (m) return !item || item[m[1]] === undefined;
    m = c.match(/^(\w+) (=|<>) (:\w+)$/); if (m) { const a = item ? item[m[1]] : undefined; return m[2] === '=' ? a === v[m[3]] : a !== v[m[3]]; }
    throw new Error('fake: unknown condition ' + c);
  });
}
function update(item, expr, v, names = {}) {
  const nm = (k) => (k.startsWith('#') ? names[k] : k);
  const [main, removePart] = expr.split(' REMOVE ');
  const [setPart, addPart] = main.split(' ADD ');
  if (setPart.startsWith('SET ')) setPart.slice(4).split(',').forEach((a) => { const [k, x] = a.split('=').map((t) => t.trim()); item[nm(k)] = val(item, x, v); });
  if (addPart || setPart.startsWith('ADD ')) (addPart || setPart.slice(4)).split(',').forEach((a) => { const [k, x] = a.trim().split(/\s+/); item[k] = (item[k] || 0) + v[x]; });
  if (removePart) removePart.split(',').forEach((k) => { delete item[nm(k.trim())]; });
}
ddb.DynamoDBDocumentClient.prototype.send = async function (cmd) {
  const i = cmd.input;
  const T = (tables[i.TableName] = tables[i.TableName] || new Map());
  const name = cmd.constructor.name;
  if (name === 'PutCommand') {
    const keyNames = i.TableName.includes('Patients') ? ['screen_code', 'patient_id'] : ['screen_code'];
    const k = Object.fromEntries(keyNames.map((n) => [n, i.Item[n]]));
    if (!cond(i.ConditionExpression, T.get(keyOf(i.TableName, k)), i.ExpressionAttributeValues || {})) throw condErr();
    T.set(keyOf(i.TableName, k), JSON.parse(JSON.stringify(i.Item)));
    return {};
  }
  if (name === 'GetCommand') { const it = T.get(keyOf(i.TableName, i.Key)); return { Item: it && { ...it } }; }
  if (name === 'UpdateCommand') {
    const k = keyOf(i.TableName, i.Key);
    const cur = T.get(k);
    if (!cond(i.ConditionExpression, cur, i.ExpressionAttributeValues)) throw condErr();
    const it = cur || { ...i.Key };
    update(it, i.UpdateExpression, i.ExpressionAttributeValues, i.ExpressionAttributeNames);
    T.set(k, it);
    return { Attributes: { ...it } };
  }
  if (name === 'DeleteCommand') {
    const k = keyOf(i.TableName, i.Key);
    if (!cond(i.ConditionExpression, T.get(k), {})) throw condErr();
    T.delete(k);
    return {};
  }
  if (name === 'QueryCommand') {
    const v = i.ExpressionAttributeValues;
    const Items = [...T.values()].filter((it) => it.screen_code === v[':screen_code'] && it.patient_id.startsWith(v[':day'])).map((it) => ({ ...it }));
    return { Items, Count: Items.length };
  }
  throw new Error('fake: ' + name);
};
SNSClient.prototype.send = async function (cmd) { sms.push(cmd.input.PhoneNumber + ' <- ' + cmd.input.Message); return {}; };

const { handler } = await import('./index.mjs');
const run = async (e) => { const r = await handler(e); const d = r.data; return r.status + ' | ' + r.status_message + (d && d.token ? ' | token ' + d.token + ' ' + (d.patient_status || '') : ''); };
const log = console.log;
console.log = () => {}; // hide the handler's own event logging
const out = [];
const S = 'OPDHAL';
out.push(['createScreen', await run({ command: 'createScreen', screen_code: S, screen_name: 'OPD' })]);
out.push(['createScreen again', await run({ command: 'createScreen', screen_code: S })]);
out.push(['addPatient Ravi', await run({ command: 'addPatient', screen_code: S, name: 'Ravi Kumar', phone: '+91 98765 43210', requested_by: 'Mary' })]);
out.push(['addPatient no phone', await run({ command: 'addPatient', screen_code: S, name: 'Priya' })]);
out.push(['addPatient bad phone', await run({ command: 'addPatient', screen_code: S, name: 'X', phone: '98765' })]);
out.push(['addPatient Abdul', await run({ command: 'addPatient', screen_code: S, name: 'Abdul', phone: '+919999988888' })]);
out.push(['callNext room 2', await run({ command: 'callNext', screen_code: S, room: 'Room 2', requested_by: 'Mary' })]);
out.push(['callNext again', await run({ command: 'callNext', screen_code: S, room: 'Room 2' })]);
out.push(['skip token 3', await run({ command: 'updatePatient', screen_code: S, token: 3, action: 'SKIP' })]);
out.push(['call token 3', await run({ command: 'updatePatient', screen_code: S, token: 3, action: 'CALL', room: 'Room 5' })]);
out.push(['delete token 2', await run({ command: 'deletePatient', screen_code: S, token: 2 })]);
out.push(['delete token 2 again', await run({ command: 'deletePatient', screen_code: S, token: 2 })]);
const list = await handler({ command: 'listPatients', screen_code: S });
out.push(['listPatients', list.status + ' | next_token ' + list.data.next_token + ' | current ' + (list.data.current && list.data.current.token) + ' | ' + list.data.patients.map((p) => p.token + ':' + p.patient_status).join(', ')]);
out.push(['delete ALL', await run({ command: 'deletePatient', screen_code: S, token: 'ALL' })]);
out.push(['addPatient after clear', await run({ command: 'addPatient', screen_code: S, name: 'New day' })]);
// A patient's own room wins over the calling nurse's room; editPatient changes / clears it.
const roomOf = async (e) => { const r = await handler(e); return r.status + ' | ' + r.status_message + (r.data ? ' | room "' + (r.data.room || '') + '" own "' + (r.data.assigned_room || '') + '"' : ''); };
out.push(['add Meena room 7', await roomOf({ command: 'addPatient', screen_code: S, name: 'Meena', room: 'Room 7' })]);
out.push(['callNext from Room 2', await roomOf({ command: 'callNext', screen_code: S, room: 'Room 2' })]);
out.push(['add Arjun no room', await roomOf({ command: 'addPatient', screen_code: S, name: 'Arjun' })]);
out.push(['edit Arjun room 4', await roomOf({ command: 'editPatient', screen_code: S, token: 3, name: 'Arjun K', phone: '+919811122233', room: '4' })]);
out.push(['callNext from Room 2', await roomOf({ command: 'callNext', screen_code: S, room: 'Room 2' })]);
out.push(['edit Arjun clear', await roomOf({ command: 'editPatient', screen_code: S, token: 3, name: 'Arjun K', phone: '', room: '' })]);
out.push(['edit name only', await roomOf({ command: 'editPatient', screen_code: S, token: 2, name: 'Meena S' })]);
out.push(['edit unknown token', await run({ command: 'editPatient', screen_code: S, token: 99, name: 'Z' })]);
out.push(['unknown screen', await run({ command: 'addPatient', screen_code: 'NOPENO', name: 'Y' })]);
out.push(['unknown command', JSON.stringify(await handler({ command: 'nope' }))]);
console.log = log;
out.forEach(([a, b]) => console.log(a.padEnd(22), b));
console.log('\nSMS sent:\n  ' + sms.join('\n  '));
