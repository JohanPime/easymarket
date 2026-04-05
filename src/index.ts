import { generateReply } from './lib/gemini.ts';
import type { ChatMessage, ChatRequest, Env } from './types';

const DEFAULT_SYSTEM_PROMPT =
  'eres el asistente de easymarket. responde en español de forma breve y útil para atención comercial y soporte general. no inventes datos; si falta contexto, pide aclaración.';

const MAX_MESSAGES = 30;
const MAX_CONTENT_LENGTH = 2000;
const MAX_FIELD_LENGTH = 120;
const MAX_REQUESTS_PER_MINUTE = 30;

const json = (data: unknown, init?: ResponseInit, requestId?: string): Response =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(requestId ? { 'x-request-id': requestId } : {}),
      ...init?.headers
    }
  });

const tenantFromPath = (pathname: string): string | null => {
  const match = pathname.match(/^\/t\/([^/]+)\/api\/chat$/);
  return match?.[1] ?? null;
};

const makeRequestId = (): string => crypto.randomUUID();

const safeString = (value: string): string => value.trim().slice(0, MAX_CONTENT_LENGTH);
const safeField = (value: string, fallback: string): string => {
  const clean = value.trim().slice(0, MAX_FIELD_LENGTH);
  return clean || fallback;
};

const getTenantSystemPrompt = async (env: Env, tenant: string): Promise<string> => {
  const prompt = await env.EASYMARKET_KV.get(`tenant:${tenant}:system_prompt`);
  if (!prompt || !prompt.trim()) return DEFAULT_SYSTEM_PROMPT;
  return prompt.trim();
};

const isUniqueConstraintError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('unique constraint') || message.includes('is not unique');
};

const ensureTenantExists = async (env: Env, tenant: string): Promise<void> => {
  const found = await env.EASYMARKET_DB.prepare('select id from tenants where id = ? limit 1')
    .bind(tenant)
    .first<{ id: string }>();

  if (!found) {
    await env.EASYMARKET_DB.prepare('insert into tenants (id, name) values (?, ?)')
      .bind(tenant, tenant)
      .run();
  }
};

const ensureConversationExists = async (
  env: Env,
  input: { conversationId: string; tenant: string; channel: string; userId: string }
): Promise<void> => {
  try {
    const found = await env.EASYMARKET_DB.prepare('select id from conversations where id = ? limit 1')
      .bind(input.conversationId)
      .first<{ id: string }>();

    if (!found) {
      await env.EASYMARKET_DB.prepare(
        'insert into conversations (id, tenant_id, channel, external_user_id, status) values (?, ?, ?, ?, ?)'
      )
        .bind(input.conversationId, input.tenant, input.channel, input.userId, 'open')
        .run();
      return;
    }

    await env.EASYMARKET_DB.prepare(
      "update conversations set updated_at = datetime('now') where id = ?"
    )
      .bind(input.conversationId)
      .run();
  } catch {
    // keep compatibility if migration 003 is pending.
  }
};

const logMessage = async (
  env: Env,
  input: {
    tenant: string;
    conversationId: string;
    messageId: string;
    role: ChatMessage['role'];
    content: string;
    channel: string;
    userId: string;
    createdBy: 'user' | 'bot';
  }
): Promise<void> => {
  try {
    await env.EASYMARKET_DB.prepare(
      'insert into chat_messages (tenant_id, role, content, conversation_id, channel, external_user_id, created_by, message_id) values (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        input.tenant,
        input.role,
        input.content,
        input.conversationId,
        input.channel,
        input.userId,
        input.createdBy,
        input.messageId
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    const isSchemaError = message.includes('no such column') || message.includes('has no column');
    if (isUniqueConstraintError(error)) {
      throw new Error('DUPLICATE_MESSAGE_ROLE');
    }

    if (!isSchemaError) {
      throw error;
    }

    // keep compatibility if migration 002/003 is pending.
    await env.EASYMARKET_DB.prepare(
      'insert into chat_messages (tenant_id, role, content) values (?, ?, ?)'
    )
      .bind(input.tenant, input.role, input.content)
      .run();
  }
};

const getAssistantReplyForMessageId = async (
  env: Env,
  input: { tenant: string; messageId: string }
): Promise<string | null> => {
  try {
    const row = await env.EASYMARKET_DB.prepare(
      'select content from chat_messages where tenant_id = ? and message_id = ? and role = ? order by id desc limit 1'
    )
      .bind(input.tenant, input.messageId, 'assistant')
      .first<{ content: string }>();

    return row?.content ?? null;
  } catch {
    return null;
  }
};

const assertTenantApiKey = async (
  request: Request,
  env: Env,
  tenant: string,
  requestId: string
): Promise<Response | null> => {
  const sentKey = request.headers.get('x-api-key')?.trim();
  const tenantKey = await env.EASYMARKET_KV.get(`tenant:${tenant}:api_key`);
  const fallbackKey = env.EASYMARKET_API_KEY?.trim() || null;
  const expectedKey = tenantKey?.trim() || fallbackKey;

  if (!expectedKey) {
    return null;
  }

  if (!sentKey || sentKey !== expectedKey) {
    return json({ ok: false, error: 'unauthorized' }, { status: 401 }, requestId);
  }

  return null;
};

const assertRateLimit = async (
  env: Env,
  input: { tenant: string; channel: string; userId: string },
  requestId: string
): Promise<Response | null> => {
  const minuteBucket = Math.floor(Date.now() / 60000);
  const key = `rl:${input.tenant}:${input.channel}:${input.userId}:${minuteBucket}`;
  const current = Number((await env.EASYMARKET_KV.get(key)) || '0');

  if (current >= MAX_REQUESTS_PER_MINUTE) {
    return json(
      {
        ok: false,
        error: 'rate limit exceeded'
      },
      { status: 429 },
      requestId
    );
  }

  await env.EASYMARKET_KV.put(key, String(current + 1), { expirationTtl: 120 });
  return null;
};

const normalizeMessages = (body: ChatRequest): ChatMessage[] => {
  let base: ChatMessage[] = [];

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    base = body.messages
      .filter(
        (message): message is ChatMessage =>
          Boolean(message && typeof message.content === 'string') &&
          (message.role === 'system' || message.role === 'assistant' || message.role === 'user')
      )
      .map((message) => ({ role: message.role, content: safeString(message.content) }))
      .filter((message) => message.content.length > 0);
  }

  if (base.length === 0 && typeof body.message === 'string' && body.message.trim().length > 0) {
    base = [{ role: 'user', content: safeString(body.message) }];
  }

  return base.slice(-MAX_MESSAGES);
};

const handleHealth = (): Response =>
  json({ ok: true, service: 'easymarket', timestamp: new Date().toISOString() });

const handleChat = async (request: Request, env: Env, tenant: string): Promise<Response> => {
  const requestId = makeRequestId();
  let body: ChatRequest;

  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return json({ ok: false, error: 'invalid json body' }, { status: 400 }, requestId);
  }

  const authError = await assertTenantApiKey(request, env, tenant, requestId);
  if (authError) return authError;

  const messages = normalizeMessages(body);
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');

  if (!latestUserMessage || latestUserMessage.content.length === 0) {
    return json({ ok: false, error: 'message is required' }, { status: 400 }, requestId);
  }

  const conversationId = safeField(body.conversationId || '', crypto.randomUUID());
  const channel = safeField(body.channel || '', 'web');
  const userId = safeField(body.userId || '', 'anonymous-web-user');
  const messageId = safeField(body.messageId || '', crypto.randomUUID());

  const rateLimitError = await assertRateLimit(env, { tenant, channel, userId }, requestId);
  if (rateLimitError) return rateLimitError;

  try {
    const existingReply = await getAssistantReplyForMessageId(env, { tenant, messageId });
    if (existingReply) {
      return json(
        {
          ok: true,
          tenant,
          conversationId,
          reply: existingReply,
          deduped: true
        },
        undefined,
        requestId
      );
    }

    const systemPrompt = await getTenantSystemPrompt(env, tenant);

    if (!messages.some((message) => message.role === 'system')) {
      messages.unshift({ role: 'system', content: systemPrompt });
    }

    await ensureTenantExists(env, tenant);
    await ensureConversationExists(env, { conversationId, tenant, channel, userId });

    await logMessage(env, {
      tenant,
      conversationId,
      messageId,
      role: 'user',
      content: latestUserMessage.content,
      channel,
      userId,
      createdBy: 'user'
    });
    
    // if a retry races with an existing assistant row, reuse it.
    // if not ready yet, client can retry with the same messageId.
    const reply = await generateReply(messages, env);

    try {
      await logMessage(env, {
        tenant,
        conversationId,
        messageId,
        role: 'assistant',
        content: reply,
        channel,
        userId,
        createdBy: 'bot'
      });
    } catch (error) {
      const err = error as Error;
      if (err.message !== 'DUPLICATE_MESSAGE_ROLE') {
        throw error;
      }
    }

    await env.EASYMARKET_KV.put(`tenant:${tenant}:last_chat_at`, new Date().toISOString());

    return json({ ok: true, tenant, conversationId, messageId, reply }, undefined, requestId);
  } catch (error) {
    const err = error as Error;

    if (err.message === 'DUPLICATE_MESSAGE_ROLE') {
      const existingReply = await getAssistantReplyForMessageId(env, { tenant, messageId });
      if (existingReply) {
        return json(
          {
            ok: true,
            tenant,
            conversationId,
            reply: existingReply,
            deduped: true
          },
          undefined,
          requestId
        );
      }

      return json(
        {
          ok: false,
          error: 'duplicate message in progress, retry with same messageId'
        },
        { status: 409 },
        requestId
      );
    }

    if (err.message === 'NO_KEYS' || err.message === 'ALL_KEYS_COOLDOWN') {
      return json(
        {
          ok: false,
          error:
            err.message === 'ALL_KEYS_COOLDOWN'
              ? 'las claves de gemini están en cooldown, intenta en unos segundos'
              : 'no hay claves de gemini configuradas en este momento'
        },
        { status: 503 },
        requestId
      );
    }

    return json(
      {
        ok: false,
        error: 'error interno',
        requestId
      },
      { status: 500 },
      requestId
    );
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

export { generateReply };
