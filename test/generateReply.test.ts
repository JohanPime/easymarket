import { afterEach, expect, test, vi } from 'vitest';
import type { Env } from '../src/types';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

test('rota entre keys y modelos ante 429 y 402', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
    .mockResolvedValueOnce({ ok: false, status: 402, json: async () => ({}) })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'hola' }] } }] })
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'adios' }] } }] })
    });

  vi.stubGlobal('fetch', fetchMock);

  const { generateReply } = await import('../src/lib/gemini');
  const env = { GEMINI_API_1: 'k1', GEMINI_API_2: 'k2' } as Env;
  const messages = [{ role: 'user', content: 'hola' }] as const;

  const reply1 = await generateReply([...messages], env);
  expect(reply1).toBe('hola');
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[0][0]).toContain('gemini-2.5-flash');
  expect(fetchMock.mock.calls[1][0]).toContain('gemini-2.5-pro');
  expect(fetchMock.mock.calls[2][0]).toContain('key=k2');

  const reply2 = await generateReply([...messages], env);
  expect(reply2).toBe('adios');
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(fetchMock.mock.calls[3][0]).toContain('key=k1');
});

test('no rota en error no recuperable 400', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: 'bad request' } })
  });

  vi.stubGlobal('fetch', fetchMock);

  const { generateReply } = await import('../src/lib/gemini');
  const env = { GEMINI_API_1: 'k1' } as Env;

  await expect(generateReply([{ role: 'user', content: 'hola' }], env)).rejects.toThrow('bad request');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('reintenta en errores 500', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    });

  vi.stubGlobal('fetch', fetchMock);

  const { generateReply } = await import('../src/lib/gemini');
  const env = { GEMINI_API_1: 'k1' } as Env;
  const reply = await generateReply([{ role: 'user', content: 'hola' }], env);

  expect(reply).toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0][0]).toContain('gemini-2.5-flash');
  expect(fetchMock.mock.calls[1][0]).toContain('gemini-2.5-pro');
});

test('falla tras agotar combinaciones', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

  vi.stubGlobal('fetch', fetchMock);

  const { generateReply } = await import('../src/lib/gemini');
  const env = { GEMINI_API_1: 'k1', GEMINI_API_2: 'k2' } as Env;

  await expect(generateReply([{ role: 'user', content: 'hola' }], env)).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(fetchMock.mock.calls[0][0]).toContain('gemini-2.5-flash');
  expect(fetchMock.mock.calls[1][0]).toContain('gemini-2.5-pro');
  expect(fetchMock.mock.calls[2][0]).toContain('gemini-2.5-flash');
  expect(fetchMock.mock.calls[3][0]).toContain('gemini-2.5-pro');
});
