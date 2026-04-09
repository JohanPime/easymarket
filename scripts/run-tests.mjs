import assert from 'node:assert/strict';
import worker, {
  getTenantPrompt,
  getTenantApiKey,
  incrementRateLimit,
  putLastChatAt
} from '../src/index.ts';
import { parseWhatsAppInboundMessages, sendWhatsAppText } from '../src/lib/whatsapp.ts';

const run = async (name, fn) => {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
};

const loadGenerateReply = async () => {
  const mod = await import(`../src/lib/gemini.ts?ts=${Date.now()}-${Math.random()}`);
  return mod.generateReply;
};

await run('rota entre keys y modelos ante 429 y 402', async () => {
  const generateReply = await loadGenerateReply();

  const fetchMock = [
    { ok: false, status: 429, json: async () => ({}) },
    { ok: false, status: 402, json: async () => ({}) },
    { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'hola' }] } }] }) },
    { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'adios' }] } }] }) }
  ];

  let idx = 0;
  globalThis.fetch = async () => fetchMock[idx++];

  const env = { GEMINI_API_1: 'k1', GEMINI_API_2: 'k2' };
  const messages = [{ role: 'user', content: 'hola' }];

  const reply1 = await generateReply(messages, env);
  assert.equal(reply1, 'hola');

  const reply2 = await generateReply(messages, env);
  assert.equal(reply2, 'adios');
});

await run('no rota en error no recuperable 400', async () => {
  const generateReply = await loadGenerateReply();

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 400, json: async () => ({ error: { message: 'bad request' } }) };
  };

  await assert.rejects(
    () => generateReply([{ role: 'user', content: 'hola' }], { GEMINI_API_1: 'k1' }),
    /bad request/
  );
  assert.equal(calls, 1);
});

await run('reintenta en errores 500', async () => {
  const generateReply = await loadGenerateReply();

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) };
  };

  const reply = await generateReply([{ role: 'user', content: 'hola' }], { GEMINI_API_1: 'k1' });
  assert.equal(reply, 'ok');
  assert.equal(calls, 2);
});

await run('falla tras agotar combinaciones', async () => {
  const generateReply = await loadGenerateReply();

  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });

  await assert.rejects(
    () => generateReply([{ role: 'user', content: 'hola' }], { GEMINI_API_1: 'k1', GEMINI_API_2: 'k2' })
  );
});

const makeEnv = () => {
  const kv = new Map();
  const rows = [];

  return {
    env: {
      EASYMARKET_DB: {
        prepare(query) {
          return {
            bind(...vals) {
              return {
                async first() {
                  if (query.includes('from tenants')) return null;
                  if (query.includes('from conversations')) return null;
                  if (query.includes('where tenant_id = ? and message_id = ? and role = ?')) {
                    const row = rows.find((r) => r.tenant_id === vals[0] && r.message_id === vals[1] && r.role === vals[2]);
                    return row ? { content: row.content } : null;
                  }
                  return null;
                },
                async run() {
                  if (query.includes('insert into chat_messages')) {
                    const role = vals[1];
                    const messageId = vals[7];
                    if (rows.some((r) => r.tenant_id === vals[0] && r.message_id === messageId && r.role === role)) {
                      throw new Error('UNIQUE constraint failed');
                    }
                    rows.push({ tenant_id: vals[0], role, content: vals[2], message_id: messageId });
                  }
                  return {};
                }
              };
            }
          };
        }
      },
      EASYMARKET_KV: {
        async get(key) {
          return kv.has(key) ? kv.get(key) : null;
        },
        async put(key, value) {
          kv.set(key, value);
        }
      },
      EASYMARKET_DOCS: {},
      GEMINI_API_1: 'g1'
    },
    kv,
    rows
  };
};

await run('putLastChatAt devuelve true y readback', async () => {
  const { env } = makeEnv();
  const ts = new Date().toISOString();
  const result = await putLastChatAt(env, 'demo', ts);
  assert.equal(result.ok, true);
  assert.equal(result.readBack, ts);
});

await run('getTenantPrompt y getTenantApiKey no exponen api key real en debug', async () => {
  const { env, kv } = makeEnv();
  kv.set('tenant:demo:system_prompt', 'hola prompt');
  kv.set('tenant:demo:api_key', 'secret');

  const prompt = await getTenantPrompt(env, 'demo');
  const api = await getTenantApiKey(env, 'demo');

  assert.equal(prompt.value, 'hola prompt');
  assert.equal(api.exists, true);
  assert.equal(api.value, 'secret');
});

await run('incrementRateLimit devuelve metadata util', async () => {
  const { env } = makeEnv();
  const result = await incrementRateLimit(env, { tenant: 'demo', channel: 'web', userId: 'u1', maxPerMinute: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.limited, false);
  assert.equal(Boolean(result.key), true);
});

await run('GET /debug/kv/:tenant lee datos sin exponer api key', async () => {
  const { env, kv } = makeEnv();
  kv.set('tenant:demo:system_prompt', 'prompt demo');
  kv.set('tenant:demo:api_key', 'my-secret');
  kv.set('tenant:demo:last_chat_at', '2026-04-07T00:00:00.000Z');

  const res = await worker.fetch(new Request('https://x/debug/kv/demo'), env, {});
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.tenantApiKeyExists, true);
  assert.equal(typeof body.tenantSystemPrompt, 'string');
  assert.equal(body.tenantSystemPrompt, 'prompt demo');
  assert.equal(body.lastChatAt, '2026-04-07T00:00:00.000Z');
  assert.equal(body.tenantApiKeyLooksPlaceholder, false);
  assert.equal(Array.isArray(body.setupHints), true);
  assert.equal(body.setupHints.length, 2);
  assert.equal(JSON.stringify(body).includes('my-secret'), false);
});

await run('GET /debug/kv/:tenant marca api key de placeholder', async () => {
  const { env, kv } = makeEnv();
  kv.set('tenant:demo:api_key', 'TU_API_KEY_REAL');

  const res = await worker.fetch(new Request('https://x/debug/kv/demo'), env, {});
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.tenantApiKeyExists, true);
  assert.equal(body.tenantApiKeyLooksPlaceholder, true);
});

await run('chat ignora api key placeholder y no exige x-api-key', async () => {
  const { env, kv } = makeEnv();
  kv.set('tenant:demo:api_key', 'TU_API_KEY_REAL');

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) });

  const res = await worker.fetch(
    new Request('https://x/t/demo/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hola', conversationId: 'c-2', messageId: 'm-2', channel: 'web', userId: 'u-2' })
    }),
    env,
    {}
  );
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.reply, 'string');
});

await run('POST /debug/kv/:tenant escribe y relee', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request('https://x/debug/kv/demo', { method: 'POST' }), env, {});
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.wrote, true);
  assert.equal(Boolean(body.key), true);
  assert.equal(typeof body.valueReadBack, 'string');
});

await run('GET /t/:tenant/webhook valida verify token de demo', async () => {
  const { env } = makeEnv();
  env.META_VERIFY_TOKEN__demo = 'verify-demo';

  const okRes = await worker.fetch(
    new Request('https://x/t/demo/webhook?hub.mode=subscribe&hub.verify_token=verify-demo&hub.challenge=abc123'),
    env,
    {}
  );
  const okBody = await okRes.text();

  assert.equal(okRes.status, 200);
  assert.equal(okBody, 'abc123');
  assert.equal(okRes.headers.get('content-type'), 'text/plain');

  const failRes = await worker.fetch(
    new Request('https://x/t/demo/webhook?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=abc123'),
    env,
    {}
  );

  assert.equal(failRes.status, 403);
});

await run('POST /t/:tenant/webhook recibe payload y responde ok', async () => {
  const { env } = makeEnv();
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args);
  };

  try {
    const res = await worker.fetch(
      new Request('https://x/t/demo/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ object: 'whatsapp_business_account' })
      }),
      env,
      {}
    );
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(logs.some((entry) => entry[0] === '[meta:webhook]'), true);
  } finally {
    console.log = originalLog;
  }
});

await run('parseo de webhook de texto', async () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ from: '50760000000', id: 'wamid.1', type: 'text', text: { body: 'hola' } }]
            }
          }
        ]
      }
    ]
  };

  const messages = parseWhatsAppInboundMessages(payload);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, '50760000000');
  assert.equal(messages[0].messageId, 'wamid.1');
  assert.equal(messages[0].type, 'text');
  assert.equal(messages[0].text, 'hola');
});

await run('ignorar payload sin mensaje', async () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { statuses: [{ id: 'x' }] } }] }]
  };

  const messages = parseWhatsAppInboundMessages(payload);
  assert.equal(messages.length, 0);
});

await run('sendWhatsAppText construye request correcto', async () => {
  const { env } = makeEnv();
  env.META_WA_TOKEN__demo = 'wa-token';
  env.META_PHONE_NUMBER_ID__demo = '123456789';

  let requestUrl = '';
  let requestInit = null;
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return { ok: true, status: 200, text: async () => '' };
  };

  const result = await sendWhatsAppText(env, { tenant: 'demo', to: '50760000000', text: 'respuesta' });
  assert.equal(result.ok, true);
  assert.equal(requestUrl, 'https://graph.facebook.com/v20.0/123456789/messages');
  assert.equal(requestInit?.method, 'POST');
  assert.equal(requestInit?.headers.authorization, 'Bearer wa-token');
  assert.equal(requestInit?.headers['content-type'], 'application/json');
  assert.equal(
    requestInit?.body,
    JSON.stringify({
      messaging_product: 'whatsapp',
      to: '50760000000',
      type: 'text',
      text: { body: 'respuesta' }
    })
  );
});

await run('chat responde campos de observabilidad kv', async () => {
  const { env, kv } = makeEnv();
  kv.set('tenant:demo:api_key', 'secret');

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) });

  const res = await worker.fetch(
    new Request('https://x/t/demo/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
      body: JSON.stringify({ message: 'hola', conversationId: 'c-1', messageId: 'm-1', channel: 'web', userId: 'u-1' })
    }),
    env,
    {}
  );

  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(typeof body.kvLastChatAtWritten, 'boolean');
  assert.equal(typeof body.lastChatAtKey, 'string');
  assert.equal(typeof body.rateLimitKey, 'string');
});

console.log('all tests passed');
