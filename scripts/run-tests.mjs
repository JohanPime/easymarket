import assert from 'node:assert/strict';

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

console.log('all tests passed');
