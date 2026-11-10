'use strict';

// Moon-vision async adapter v1.0
// Entry point: index.handler
// Core implementation: moon-vision v4.1.14 (see VERSION).
// Normal HTTPS calls are passed straight through to the core.
// Async HTTPS calls (?integration=async) are delivered as a raw body; this
// adapter converts that body into the HTTP event expected by the existing core.

const core = require('./moon-vision-core.js');

const MAX_ASYNC_WORK_MS = 110000;
const POLL_INTERVAL_MS = 900;
const VERSION = 'mv-async-adapter-1.0';

function rawToText(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (typeof value === 'string') return value;
  return '';
}

function readAsyncPayload(event) {
  // A normal HTTPS invocation has httpMethod and must use the original route.
  if (event && typeof event === 'object' &&
      typeof event.httpMethod === 'string') {
    return null;
  }

  let source = event;
  if (source && typeof source === 'object' && !Buffer.isBuffer(source) &&
      !(source instanceof Uint8Array)) {
    if (source.body !== undefined) source = source.body;
    else if (source.data !== undefined) source = source.data;
    else if (typeof source.token === 'string') return source;

    if (source && typeof source === 'object' &&
        !Buffer.isBuffer(source) && !(source instanceof Uint8Array) &&
        typeof source.token === 'string') {
      return source;
    }
  }

  const text = rawToText(source);
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Async invocation body is not valid JSON');
  }
}

function parseCoreBody(result) {
  if (!result || typeof result !== 'object') return null;
  let body = result.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch (e) { return null; }
  }
  return body && typeof body === 'object' ? body : null;
}

function makePostEvent(payload) {
  const body = {
    q: String(payload.q || ''),
    cid: String(payload.cid || ''),
    uid: String(payload.uid || '')
  };
  if (payload.game) body.game = String(payload.game);
  if (payload.supersede) body.supersede = String(payload.supersede);

  return {
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    queryStringParameters: { token: String(payload.token || '') },
    body: JSON.stringify(body),
    isBase64Encoded: false
  };
}

function makeAnswerEvent(payload, qid) {
  return {
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: {
      token: String(payload.token || ''),
      answer: '1',
      qid: String(qid),
      cid: String(payload.cid || ''),
      uid: String(payload.uid || '')
    }
  };
}

function isTerminal(status) {
  return status === 'done' || status === 'clarify' ||
    status === 'expired' || status === 'superseded' ||
    status === 'cancelled' || status === 'none' ||
    status === 'bad_request' || status === 'forbidden';
}

async function runCore(event, context) {
  const result = await core.handler(event, context);
  const data = parseCoreBody(result);

  if (!data) {
    throw new Error('Moon-vision core returned an unreadable response');
  }

  if ((result && result.statusCode >= 500) ||
      data.status === 'server_error' || data.status === 'wait') {
    throw new Error('Moon-vision core temporary failure: ' + data.status);
  }

  return { result, data };
}

module.exports.handler = async function (event, context) {
  // Keep every existing synchronous endpoint operational.
  if (event && typeof event === 'object' &&
      typeof event.httpMethod === 'string') {
    return core.handler(event, context);
  }

  const payload = readAsyncPayload(event);
  if (!payload) {
    throw new Error('Unknown asynchronous invocation format');
  }

  if (payload.action !== 'ask' ||
      typeof payload.token !== 'string' || !payload.token ||
      typeof payload.q !== 'string' || !payload.q.trim() ||
      typeof payload.cid !== 'string' || !payload.cid) {
    throw new Error('Invalid asynchronous ask payload');
  }

  const startedAt = Date.now();
  const first = await runCore(makePostEvent(payload), context);
  let data = first.data;

  if (isTerminal(data.status)) {
    console.log(JSON.stringify({
      component: 'moon-vision-async', version: VERSION,
      status: data.status, qid: data.qid || null
    }));
    return { status: data.status, qid: data.qid || null };
  }

  // The core normally completes the work during the POST itself. If it reports
  // query, poll the existing synchronous answer endpoint from this same async
  // execution. Pending records can also be resumed by that endpoint.
  const qid = Number(data.qid);
  if (!Number.isSafeInteger(qid) || qid <= 0) {
    throw new Error('Moon-vision did not return a valid qid');
  }

  while (Date.now() - startedAt < MAX_ASYNC_WORK_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const polled = await runCore(makeAnswerEvent(payload, qid), context);
    data = polled.data;

    if (isTerminal(data.status)) {
      console.log(JSON.stringify({
        component: 'moon-vision-async', version: VERSION,
        status: data.status, qid: qid,
        elapsedMs: Date.now() - startedAt
      }));
      return { status: data.status, qid: qid };
    }
  }

  // Throw so the platform can apply the configured asynchronous retry policy.
  // The existing core's CID check prevents creation of a second logical query.
  throw new Error('Moon-vision async work did not finish within the execution budget');
};
