import * as dynamodb from "@aws-sdk/client-dynamodb";
import * as ddb from "@aws-sdk/lib-dynamodb";
const docClient = new dynamodb.DynamoDBClient();
const ddbDocClient = ddb.DynamoDBDocumentClient.from(docClient, {
    marshallOptions: {
        removeUndefinedValues: true,
    },
});

import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
const snsClient = new SNSClient();

//=============================== SETTINGS =================================//

const SCREENS_TABLE = "PhotoFlixScreensTable";   // key: screen_code (String)
const PATIENTS_TABLE = "PhotoFlixPatientsTable"; // keys: screen_code (String) + patient_id (String), TTL attribute: expiresAt
const TIME_ZONE = "Asia/Kolkata";                // tokens start again from 1 at midnight here
const PLACE_NAME = "";                           // e.g. "City Hospital OPD", added to the SMS
const SMS_ON = false;                            // false = no SMS is sent (it is only logged)
const PATIENT_KEEP_HOURS = 36;                   // DynamoDB TTL removes patient rows (names, phones) after this
// SMS: sent only when a token is called ("Token 12 (Ravi): please go to Room 2 now.")

//=============================== DYNAMODB INBUILT FUNCTIONS=================================//

export const insert_dynamo = async (params) => {
    try {
        await ddbDocClient.send(new ddb.PutCommand({ ...params }));
        return "SUCCESS";
    }
    catch (err) {
        console.log(params, err);
        throw new Error(err);
    }
};

export const get_dynamo = async (params) => {
    try {
        const results = await ddbDocClient.send(new ddb.GetCommand(params));
        return results;
    }
    catch (err) {
        console.log(params, err);
        throw new Error(err);
    }
};

export const query_dynamo = async (params) => {
    try {
        const results = await ddbDocClient.send(new ddb.QueryCommand(params));
        return results;
    }
    catch (err) {
        console.log(params, err);
        throw new Error(err);
    }
};

export const update_dynamo = async (params) => {
    try {
        const results = await ddbDocClient.send(new ddb.UpdateCommand(params));
        return results;
    }
    catch (err) {
        console.log(params, err);
        throw new Error(err);
    }
};

export const delete_dynamo = async (params) => {
    try {
        await ddbDocClient.send(new ddb.DeleteCommand(params));
        return "SUCCESS";
    }
    catch (err) {
        console.log(params, err);
        throw new Error(err);
    }
};

//===================== Helper Functions =============================//

const isConditionFailed = (err) => String(err && err.message).includes("ConditionalCheckFailed");
const isValidScreenCode = (code) => /^[A-Z]{6}$/.test(code || "");
const isValidPhone = (phone) => /^\+[1-9]\d{7,14}$/.test(phone || ""); // with country code, e.g. +919876543210
const cleanText = (text, max) => String(text || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const cleanPhone = (phone) => String(phone || "").replace(/[\s()-]/g, "");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TIME_ZONE }); // "2026-10-15"
const patientId = (day, token) => `${day}#${String(token).padStart(6, "0")}`;      // "2026-10-15#000012"
const expiresAt = () => Math.floor(Date.now() / 1000) + PATIENT_KEEP_HOURS * 3600;

const checkScreenCode = (event) => {
    if (!event.screen_code) throw new Error("Screen code is mandatory.");
    event.screen_code = String(event.screen_code).toUpperCase().trim();
    if (!isValidScreenCode(event.screen_code)) throw new Error("Screen code must be 6 letters.");
};

const checkToken = (event) => {
    if (!event.token) throw new Error("Token is mandatory.");
    const token = Number(event.token);
    if (!Number.isInteger(token) || token < 1) throw new Error("Token is not valid.");
    return token;
};

const findScreen = async (screen_code) => {

    let findScreenParams = {
        TableName: SCREENS_TABLE,
        Key: { screen_code: screen_code }
    };

    let screen = await get_dynamo(findScreenParams);
    if (!screen.Item) throw new Error(`Screen ${screen_code} not found.`);
    return screen.Item;
};

// Today's patients for a screen, in line order.
const findTodayPatients = async (screen_code) => {

    let items = [];
    let lastKey;

    do {
        let todayPatientsParams = {
            TableName: PATIENTS_TABLE,
            KeyConditionExpression: "screen_code = :screen_code AND begins_with(patient_id, :day)",
            ExpressionAttributeValues: {
                ":screen_code": screen_code,
                ":day": today() + "#"
            },
            ExclusiveStartKey: lastKey
        };
        let patients = await query_dynamo(todayPatientsParams);
        items.push(...patients.Items);
        lastKey = patients.LastEvaluatedKey;
    } while (lastKey);

    return items.sort((a, b) => a.line_order - b.line_order || a.token - b.token);
};

// Next token number. Starts from 1 every day. Safe when two nurses add at the same moment.
const nextToken = async (screen_code, isRetry) => {

    try {
        let sameDayParams = {
            TableName: SCREENS_TABLE,
            Key: { screen_code: screen_code },
            UpdateExpression: "ADD last_token :one",
            ConditionExpression: "attribute_exists(screen_code) AND token_day = :day",
            ExpressionAttributeValues: { ":one": 1, ":day": today() },
            ReturnValues: "UPDATED_NEW"
        };
        let result = await update_dynamo(sameDayParams);
        return result.Attributes.last_token;
    }
    catch (err) {
        if (!isConditionFailed(err)) throw err;
    }

    try {
        let newDayParams = {
            TableName: SCREENS_TABLE,
            Key: { screen_code: screen_code },
            UpdateExpression: "SET token_day = :day, last_token = :one",
            ConditionExpression: "attribute_exists(screen_code) AND token_day <> :day",
            ExpressionAttributeValues: { ":one": 1, ":day": today() }
        };
        await update_dynamo(newDayParams);
        return 1;
    }
    catch (err) {
        if (!isConditionFailed(err)) throw err;
    }

    await findScreen(screen_code); // throws "not found" when the screen does not exist
    if (isRetry) throw new Error("Busy, please try again.");
    return await nextToken(screen_code, true); // another nurse started the day a moment ago
};

// Marks a patient as called; whoever was being served before is finished first. Sends the "your turn" SMS.
// The patient's own room (chosen when added) wins over the room of the nurse who calls.
const callPatient = async (screen_code, patient, event, onlyIfWaiting) => {

    for (const other of await findTodayPatients(screen_code)) {
        if (other.patient_status === "CALLED" && other.patient_id !== patient.patient_id) {
            await update_dynamo({
                TableName: PATIENTS_TABLE,
                Key: { screen_code: screen_code, patient_id: other.patient_id },
                UpdateExpression: "SET patient_status = :done, done_on = :now",
                ExpressionAttributeValues: { ":done": "DONE", ":now": Date.now() }
            });
        }
    }

    let callPatientParams = {
        TableName: PATIENTS_TABLE,
        Key: { screen_code: screen_code, patient_id: patient.patient_id },
        UpdateExpression: "SET patient_status = :called, called_on = :now, room = :room, called_by = :called_by ADD calls :one",
        ConditionExpression: onlyIfWaiting ? "patient_status = :waiting" : "attribute_exists(patient_id)",
        ExpressionAttributeValues: {
            ":called": "CALLED",
            ":now": Date.now(),
            ":room": cleanText(patient.assigned_room || event.room, 30),
            ":called_by": cleanText(event.requested_by, 24),
            ":one": 1,
            ...(onlyIfWaiting ? { ":waiting": "WAITING" } : {})
        },
        ReturnValues: "ALL_NEW"
    };

    let result = await update_dynamo(callPatientParams);
    let called = result.Attributes;

    const where = called.room ? `please go to ${called.room} now.` : "please come in now.";
    called.sms_sent = await sendSms(called.phone, `Token ${called.token}${called.name ? " (" + called.name + ")" : ""}: ${where}${PLACE_NAME ? " - " + PLACE_NAME : ""}`);

    return called;
};

//===================== SNS (SMS) Functions =============================//

// Never throws: a failed SMS must not stop a patient being called.
const sendSms = async (phone, message) => {

    if (!isValidPhone(phone)) return false;
    if (!SMS_ON) {
        console.log(`[sms off] would text ${phone}: ${message}`);
        return false;
    }

    try {
        await snsClient.send(new PublishCommand({
            PhoneNumber: phone,
            Message: message.slice(0, 160),
            MessageAttributes: {
                "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" }
            }
        }));
        return true;
    }
    catch (err) {
        console.error(`SMS to ${phone.slice(0, -4)}**** failed`, err);
        return false;
    }
};

//===================== Screen Functions =============================//

const createScreen = async (event) => {

    checkScreenCode(event);

    let createScreenParams = {
        TableName: SCREENS_TABLE,
        Item: {
            screen_code: event.screen_code,
            screen_name: cleanText(event.screen_name, 40),
            last_token: 0,
            token_day: today(),
            created_on: Date.now(),
            entity: "SCREEN"
        },
        ConditionExpression: "attribute_not_exists(screen_code)"
    };

    try {
        await insert_dynamo(createScreenParams);
    }
    catch (err) {
        if (!isConditionFailed(err)) throw err;
        throw new Error(`Screen ${event.screen_code} already exists.`);
    }

    return {
        status: "SUCCESS",
        status_message: `Screen ${event.screen_code} created successfully.`,
        data: createScreenParams.Item
    };
};

//===================== Patient Functions =============================//

const addPatient = async (event) => {

    checkScreenCode(event);
    const phone = cleanPhone(event.phone);
    if (phone && !isValidPhone(phone)) throw new Error("Phone must have the country code, like +919876543210.");

    const token = await nextToken(event.screen_code);
    const day = today();

    let addPatientParams = {
        TableName: PATIENTS_TABLE,
        Item: {
            screen_code: event.screen_code,
            patient_id: patientId(day, token),
            token: token,
            token_day: day,
            name: cleanText(event.name, 40),
            phone: phone || undefined,
            assigned_room: cleanText(event.room, 30) || undefined, // the patient's own room; empty = the calling nurse's room
            patient_status: "WAITING",
            line_order: Date.now(),
            calls: 0,
            skipped: 0,
            added_by: cleanText(event.requested_by, 24),
            created_on: Date.now(),
            entity: "PATIENT",
            expiresAt: expiresAt()
        }
    };

    let result = await insert_dynamo(addPatientParams);
    if (result !== "SUCCESS") throw new Error("Unable to add patient.");

    return {
        status: "SUCCESS",
        status_message: `Token ${token} added successfully.`,
        data: addPatientParams.Item
    };
};

// Today's list. Includes phone numbers: for staff only, do not show them on the TV.
const listPatients = async (event) => {

    checkScreenCode(event);
    const screen = await findScreen(event.screen_code);
    let items = await findTodayPatients(event.screen_code);

    if (event.patient_status) {
        items = items.filter((p) => p.patient_status === event.patient_status);
    }

    const called = items.filter((p) => p.patient_status === "CALLED").sort((a, b) => b.called_on - a.called_on);

    return {
        status: "SUCCESS",
        status_message: "Patients listed successfully.",
        data: {
            screen_code: screen.screen_code,
            screen_name: screen.screen_name,
            day: today(),
            next_token: screen.token_day === today() ? screen.last_token + 1 : 1,
            current: called[0] || null,
            patients: items
        }
    };
};

// action: "CALL" (call / call again), "DONE", "SKIP" (back to waiting, end of the line)
const updatePatient = async (event) => {

    checkScreenCode(event);
    const token = checkToken(event);
    if (!event.action) throw new Error("Action is mandatory (CALL, DONE or SKIP).");

    let getPatientParams = {
        TableName: PATIENTS_TABLE,
        Key: { screen_code: event.screen_code, patient_id: patientId(today(), token) }
    };

    let patient = await get_dynamo(getPatientParams);
    if (!patient.Item) throw new Error(`Token ${token} not found today.`);

    let updated;
    switch (String(event.action).toUpperCase()) {
        case "CALL":
            updated = await callPatient(event.screen_code, patient.Item, event, false);
            break;

        case "DONE":
            updated = (await update_dynamo({
                TableName: PATIENTS_TABLE,
                Key: getPatientParams.Key,
                UpdateExpression: "SET patient_status = :done, done_on = :now",
                ExpressionAttributeValues: { ":done": "DONE", ":now": Date.now() },
                ReturnValues: "ALL_NEW"
            })).Attributes;
            break;

        case "SKIP":
            updated = (await update_dynamo({
                TableName: PATIENTS_TABLE,
                Key: getPatientParams.Key,
                UpdateExpression: "SET patient_status = :waiting, line_order = :now ADD skipped :one",
                ExpressionAttributeValues: { ":waiting": "WAITING", ":now": Date.now(), ":one": 1 },
                ReturnValues: "ALL_NEW"
            })).Attributes;
            break;

        default:
            throw new Error("Action must be CALL, DONE or SKIP.");
    }

    return {
        status: "SUCCESS",
        status_message: `Token ${token} updated successfully.`,
        data: updated
    };
};

// Finishes whoever is being served and calls the first waiting patient.
// Two nurses pressing at the same time never get the same patient.
const callNext = async (event) => {

    checkScreenCode(event);
    await findScreen(event.screen_code);

    for (let tries = 0; tries < 5; tries++) {

        const patients = await findTodayPatients(event.screen_code);
        const next = patients.find((p) => p.patient_status === "WAITING");

        if (!next) {
            for (const p of patients) {
                if (p.patient_status === "CALLED") {
                    await update_dynamo({
                        TableName: PATIENTS_TABLE,
                        Key: { screen_code: event.screen_code, patient_id: p.patient_id },
                        UpdateExpression: "SET patient_status = :done, done_on = :now",
                        ExpressionAttributeValues: { ":done": "DONE", ":now": Date.now() }
                    });
                }
            }
            return {
                status: "SUCCESS",
                status_message: "Nobody is waiting.",
                data: null
            };
        }

        try {
            const called = await callPatient(event.screen_code, next, event, true);
            return {
                status: "SUCCESS",
                status_message: `Token ${called.token} called.`,
                data: called
            };
        }
        catch (err) {
            if (!isConditionFailed(err)) throw err; // another nurse took this patient: try the next one
        }
    }

    throw new Error("Busy, please try again.");
};

// Change a patient's name / mobile, and their own room when "room" is sent (empty = none).
const editPatient = async (event) => {

    checkScreenCode(event);
    const token = checkToken(event);
    const phone = cleanPhone(event.phone);
    if (phone && !isValidPhone(phone)) throw new Error("Phone must have the country code, like +919876543210.");
    const room = event.room === undefined ? undefined : cleanText(event.room, 30);

    let editPatientParams = {
        TableName: PATIENTS_TABLE,
        Key: { screen_code: event.screen_code, patient_id: patientId(today(), token) },
        UpdateExpression: "SET #name = :name, phone = :phone, updated_on = :now" + (room ? ", assigned_room = :room" : "") + (room === "" ? " REMOVE assigned_room" : ""),
        ConditionExpression: "attribute_exists(patient_id)",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: { ":name": cleanText(event.name, 40), ":phone": phone, ":now": Date.now(), ...(room ? { ":room": room } : {}) },
        ReturnValues: "ALL_NEW"
    };

    let result;
    try {
        result = await update_dynamo(editPatientParams);
    }
    catch (err) {
        if (isConditionFailed(err)) throw new Error(`Token ${token} not found today.`);
        throw err;
    }

    return {
        status: "SUCCESS",
        status_message: `Token ${token} updated successfully.`,
        data: result.Attributes
    };
};

const deletePatient = async (event) => {

    checkScreenCode(event);
    await findScreen(event.screen_code);

    if (String(event.token).toUpperCase() === "ALL") {

        const patients = await findTodayPatients(event.screen_code);
        for (const p of patients) {
            await delete_dynamo({
                TableName: PATIENTS_TABLE,
                Key: { screen_code: event.screen_code, patient_id: p.patient_id }
            });
        }

        await update_dynamo({
            TableName: SCREENS_TABLE,
            Key: { screen_code: event.screen_code },
            UpdateExpression: "SET last_token = :zero, token_day = :day",
            ExpressionAttributeValues: { ":zero": 0, ":day": today() }
        });

        return {
            status: "SUCCESS",
            status_message: "Today's list cleared. Tokens start from 1.",
            data: { deleted_count: patients.length }
        };
    }

    const token = checkToken(event);

    let deletePatientParams = {
        TableName: PATIENTS_TABLE,
        Key: { screen_code: event.screen_code, patient_id: patientId(today(), token) },
        ConditionExpression: "attribute_exists(patient_id)"
    };

    try {
        await delete_dynamo(deletePatientParams);
    }
    catch (err) {
        if (isConditionFailed(err)) throw new Error(`Token ${token} not found today.`);
        throw err;
    }

    return {
        status: "SUCCESS",
        status_message: `Token ${token} deleted successfully.`,
        data: { token: token }
    };
};

export const handler = async (event) => {
    console.log(JSON.stringify({ ...event, phone: event.phone ? "****" : undefined }));

    try {
        switch (event.command) {

            case 'createScreen':
                return await createScreen(event);

            case 'addPatient':
                return await addPatient(event);

            case 'listPatients':
                return await listPatients(event);

            case 'updatePatient':
                return await updatePatient(event);

            case 'editPatient':
                return await editPatient(event);

            case 'callNext':
                return await callNext(event);

            case 'deletePatient':
                return await deletePatient(event);

            default:
                return 'command not found';
        }
    }
    catch (err) {
        return {
            status: "ERROR",
            status_message: err.message,
            data: null
        };
    }
};
