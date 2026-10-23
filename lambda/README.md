# PhotoFlix patient-queue Lambda

One Lambda (`index.mjs`, Node.js 20.x or 22.x, no npm install: the AWS SDK is built in). Call it with `event.command`, the same structure as your users Lambda. Every reply is `{ status, status_message, data }`; errors come back as `status: "ERROR"`.

## 1. DynamoDB tables

| Table | Partition key | Sort key | Extra |
|---|---|---|---|
| `PhotoFlixScreensTable` | `screen_code` (String) | none | |
| `PhotoFlixPatientsTable` | `screen_code` (String) | `patient_id` (String) | Turn on **TTL** with attribute `expiresAt` |

Capacity: on-demand. `patient_id` looks like `2026-10-15#000012` (day + token), so each day starts fresh and TTL deletes names and phones after 36 hours. Table names and settings are at the top of `index.mjs`.

## 2. Lambda

* Runtime **Node.js 22.x**, handler `index.handler`. Paste `index.mjs` (not `_localtest.mjs`, that is only for testing on the PC).
* The execution role needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"],
      "Resource": ["arn:aws:dynamodb:us-east-1:*:table/PhotoFlixScreensTable", "arn:aws:dynamodb:us-east-1:*:table/PhotoFlixPatientsTable"] },
    { "Effect": "Allow", "Action": "sns:Publish", "Resource": "*" }
  ]
}
```

* SMS: SNS starts in the **SMS sandbox**, where it only texts numbers you verify in *SNS → Text messaging (SMS) → Sandbox destination phone numbers*. Request production access to text any patient. Indian numbers may also need a registered Sender ID / DLT template for delivery. Set `SMS_ON = false` at the top to only log SMS.

## 3. Commands (test events)

```json
{ "command": "createScreen", "screen_code": "OPDHAL", "screen_name": "OPD waiting hall" }
```
```json
{ "command": "addPatient", "screen_code": "OPDHAL", "name": "Ravi Kumar", "phone": "+919876543210", "requested_by": "Sister Mary" }
```
Token number is automatic (1, 2, 3… from 1 again every day). `name` and `phone` are optional; no SMS is sent when adding.
```json
{ "command": "callNext", "screen_code": "OPDHAL", "room": "Room 2", "requested_by": "Sister Mary" }
```
Finishes the current patient, calls the first waiting one, and **sends the SMS**: "Token 1 (Ravi Kumar): please go to Room 2 now." Two nurses pressing at once never get the same patient.
```json
{ "command": "updatePatient", "screen_code": "OPDHAL", "token": 3, "action": "CALL", "room": "Room 5" }
```
`action`: `CALL` (call this token, or call again; sends the SMS), `DONE`, `SKIP` (back to waiting, end of the line).
```json
{ "command": "listPatients", "screen_code": "OPDHAL" }
```
Returns `next_token`, `current` (being served) and today's `patients` in line order. Optional `"patient_status": "WAITING"`. Contains phone numbers: do not show them on the TV.
```json
{ "command": "deletePatient", "screen_code": "OPDHAL", "token": 2 }
```
`"token": "ALL"` clears today's list and restarts tokens from 1.

## Local test

```bash
node _localtest.mjs
```
Runs every command against an in-memory fake of DynamoDB and SNS (from the `photoflix` folder's `node_modules`).
