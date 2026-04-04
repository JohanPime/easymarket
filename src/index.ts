import type { ChatRequest, Env } from './types';

const json = (data: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...init?.headers
    }
  });

const tenantFromPath = (pathname: string): string | null => {
  const match = pathname.match(/^\/t\/([^/]+)\/api\/chat$/);
  return match?.[1] ?? null;
};

const handleHealth = (): Response =>
  json({ ok: true, service: 'easymarket', timestamp: new Date().toISOString() });

const handleChat = async (request: Request, env: Env, tenant: string): Promise<Response> => {
  let body: ChatRequest;

  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return json({ ok: false, error: 'invalid json body' }, { status: 400 });
  }

  if (!body.message || body.message.trim().length === 0) {
    return json({ ok: false, error: 'message is required' }, { status: 400 });
  }

  // keep a minimal heartbeat in kv.
  await env.EASYMARKET_KV.put(`tenant:${tenant}:last_chat_at`, new Date().toISOString());

  return json({
    ok: true,
    tenant,
    reply: `echo: ${body.message.trim()}`
  });
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return handleHealth();
    }

    const tenant = tenantFromPath(url.pathname);
    if (request.method === 'POST' && tenant) {
      return handleChat(request, env, tenant);
    }

    return json({ ok: false, error: 'not found' }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;
