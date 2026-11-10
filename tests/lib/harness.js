'use strict';

// Тестовый стенд Moon. Никакой сети: Object Storage, Knowledge Engine,
// модель и фоновые вызовы функции эмулируются в памяти.
// Это позволяет проверять реальный код навыка и ядра Vision без облака.

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILL_PATH = process.env.MOON_SKILL_PATH
  ? path.resolve(process.env.MOON_SKILL_PATH)
  : path.join(ROOT, 'work', 'skill', 'index.js');
// MOON_CORE_PATH позволяет прогнать те же тесты на старой версии ядра
// (например, на audit/raw/vision/moon-vision-core.js) и увидеть разницу.
const CORE_PATH = process.env.MOON_CORE_PATH
  ? path.resolve(process.env.MOON_CORE_PATH)
  : path.join(ROOT, 'work', 'vision', 'moon-vision-core.js');

const ENV_KEYS = [
  'AUTH_TOKEN', 'MODEL_URI', 'YC_API_KEY', 'BUCKET', 'ACCESS_KEY_ID',
  'SECRET_ACCESS_KEY', 'KB_URL', 'KB_TOKEN', 'SELF_URL', 'MOON_DEEP',
  'MOON_REASONING', 'MOON_DEEP_BUDGET_MS', 'MOON_FAST_BUDGET_MS',
  'MOON_TOKEN', 'MOON_UID_SALT'
];

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      return reject(e);
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      }, { once: true });
    }
  });
}

function jsonResponse(status, value, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {})
  });
}

function parseJson(text) {
  if (!text) return null;
  if (typeof text !== 'string') text = String(text);
  try { return JSON.parse(text); } catch (e) { return null; }
}

function createWorld(options) {
  const o = options || {};
  const bucket = o.bucket || 'moon-test';

  const s3 = new Map();
  const calls = {
    s3: [],
    kb: [],
    model: [],
    self: [],
    cloud: [],
    other: []
  };

  let etagSeq = 0;
  const nextEtag = () => '"etag-' + (++etagSeq) + '"';

  const kbHandler = o.kb || (() => ({
    status: 'ok',
    game: 'Cyberpunk 2077',
    results: []
  }));
  const modelHandler = o.model || (() => ({
    speech: 'Проверенный ответ', unk: false, conf: 0.9,
    clarify: null, marker: null
  }));
  const cloudHandler = o.cloud || (() => ({ status: 200, body: { status: 'ok' } }));

  async function s3Fetch(url, init) {
    const u = new URL(url);
    const prefix = '/' + bucket + '/';
    if (!u.pathname.startsWith(prefix)) {
      throw new Error('unknown bucket path ' + u.pathname);
    }
    const key = u.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
    const method = String((init && init.method) || 'GET').toUpperCase();
    calls.s3.push({ method, key });

    if (method === 'GET') {
      const hit = s3.get(key);
      if (!hit) return new Response('', { status: 404 });
      return new Response(hit.body, { status: 200, headers: { etag: hit.etag } });
    }

    if (method === 'PUT') {
      const headers = (init && init.headers) || {};
      const ifMatch = headers['If-Match'] || headers['if-match'] || '';
      const ifNone = headers['If-None-Match'] || headers['if-none-match'] || '';
      const cur = s3.get(key);

      if (ifMatch && (!cur || cur.etag !== ifMatch)) {
        return new Response('', { status: 412 });
      }
      if (ifNone === '*' && cur) {
        return new Response('', { status: 412 });
      }

      const body = Buffer.isBuffer(init.body)
        ? init.body
        : Buffer.from(String(init.body || ''), 'utf8');
      const etag = nextEtag();
      s3.set(key, { body, etag });
      return new Response('', { status: 200, headers: { etag } });
    }

    throw new Error('unsupported s3 method ' + method);
  }

  async function kbFetch(url, init) {
    const payload = parseJson(init && init.body);
    calls.kb.push({ payload, headers: (init && init.headers) || {} });
    const out = await kbHandler(payload, calls);
    if (out instanceof Response) return out;
    return jsonResponse(200, out);
  }

  async function modelFetch(url, init) {
    const payload = parseJson(init && init.body);
    calls.model.push(payload);
    const out = await modelHandler(payload, { init, calls });

    if (init && init.signal && init.signal.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }

    if (out instanceof Response) return out;
    if (out && out.delayMs) await delay(out.delayMs, init && init.signal);

    const content = out && typeof out.content === 'string'
      ? out.content
      : JSON.stringify({
        speech: (out && out.speech) || 'Проверенный ответ',
        unk: !!(out && out.unk),
        conf: typeof (out && out.conf) === 'number' ? out.conf : 0.9,
        clarify: (out && out.clarify) || null,
        marker: (out && out.marker) || null
      });

    return jsonResponse(200, {
      model: 'test-model',
      choices: [{
        message: { content },
        finish_reason: (out && out.finishReason) || 'stop'
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 10,
        completion_tokens_details: { reasoning_tokens: 0 }
      }
    });
  }

  async function selfFetch(url, init) {
    calls.self.push({ url, headers: (init && init.headers) || {} });
    if (o.onSelf) {
      const r = await o.onSelf(url, init, calls);
      if (r instanceof Response) return r;
    }
    return jsonResponse(200, { status: 'accepted' });
  }

  async function cloudFetch(url) {
    const u = new URL(url);
    const qp = {};
    for (const [k, v] of u.searchParams.entries()) qp[k] = v;
    calls.cloud.push({ url, qp, ...(arguments[1] === undefined ? {} : { init: arguments[1] }) });
    const r = await cloudHandler(u, arguments[1], calls);
    if (r instanceof Response) return r;
    return jsonResponse(r.status || 200, r.body === undefined ? {} : r.body);
  }

  async function fetch(url, init) {
    const href = typeof url === 'string' ? url : String(url && url.url);
    const u = new URL(href);
    const host = u.hostname.toLowerCase();

    if (host === 'storage.yandexcloud.net') return s3Fetch(href, init || {});
    if (host === 'kb.test') return kbFetch(href, init || {});
    if (host === 'ai.api.cloud.yandex.net') return modelFetch(href, init || {});
    if (host === 'self.test') return selfFetch(href, init || {});
    if (host === 'functions.yandexcloud.net') return cloudFetch(href, init || {});

    calls.other.push({ href });
    throw new Error('unexpected network call to ' + href);
  }

  return {
    bucket,
    s3,
    calls,
    fetch,
    seed(key, value) {
      s3.set(key, { body: Buffer.from(JSON.stringify(value), 'utf8'), etag: nextEtag() });
    },
    read(key) {
      const hit = s3.get(key);
      return hit ? parseJson(hit.body.toString('utf8')) : null;
    }
  };
}

function resetEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function loadVision(world, env, corePath) {
  resetEnv();
  process.env.AUTH_TOKEN = 'test-token';
  process.env.MODEL_URI = 'gpt://test-folder/test-model';
  process.env.YC_API_KEY = 'test-key';
  process.env.BUCKET = world.bucket;
  process.env.ACCESS_KEY_ID = 'test-id';
  process.env.SECRET_ACCESS_KEY = 'test-secret';
  process.env.KB_URL = 'https://kb.test/';
  process.env.KB_TOKEN = 'kb-token';
  process.env.SELF_URL = 'https://self.test/fn';

  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }

  global.fetch = world.fetch;
  const target = corePath || CORE_PATH;
  delete require.cache[target];
  return require(target);
}

function loadSkill(world, env) {
  resetEnv();
  process.env.MOON_TOKEN = 'test-token';
  process.env.MOON_UID_SALT = 'moon:';
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  global.fetch = world.fetch;
  delete require.cache[SKILL_PATH];
  return require(SKILL_PATH);
}

function httpEvent(method, qp, body, headers) {
  return {
    httpMethod: method,
    headers: headers || {},
    queryStringParameters: qp || {},
    body: body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body)),
    isBase64Encoded: false
  };
}

function visionCall(core, qp, body, headers) {
  return core.handler(httpEvent(body ? 'POST' : 'GET', qp, body, headers)).then(res => {
    const parsed = parseJson(res.body);
    return { code: res.statusCode, body: parsed, raw: res };
  });
}

function aliceEvent(opts) {
  const o = opts || {};
  const session = {
    new: !!o.new,
    session_id: o.session_id || 'session-1',
    message_id: o.message_id || 1,
    skill_id: 'skill-1',
    user: { user_id: o.user_id || 'user-1' },
    application: { application_id: 'app-1' }
  };
  const state = {};
  if (o.state) {
    state.session = o.state;
    state.application = o.state;
    state.user = o.state;
  }
  return {
    meta: {},
    session,
    request: {
      command: o.command === undefined ? (o.original || '') : o.command,
      original_utterance: o.original === undefined ? (o.command || '') : o.original,
      type: 'SimpleUtterance',
      nlu: { tokens: [], entities: [] }
    },
    state,
    version: '1.0'
  };
}

async function aliceCall(skill, opts) {
  const res = await skill.handler(aliceEvent(opts));
  let text = '';
  try {
    text = JSON.parse(JSON.stringify(res)).response.text;
  } catch (e) { text = ''; }
  return { res, text };
}

function ufrom(uid) {
  return 'u-' + String(uid).padEnd(24, '0').slice(0, 24);
}

module.exports = {
  ROOT,
  SKILL_PATH,
  CORE_PATH,
  createWorld,
  loadVision,
  loadSkill,
  httpEvent,
  visionCall,
  aliceEvent,
  aliceCall,
  resetEnv,
  delay,
  ufrom
};
