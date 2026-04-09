import { generateReply } from './lib/gemini.ts';
import { parseWhatsAppInboundMessages, sendWhatsAppText } from './lib/whatsapp.ts';
import type { ChatMessage, ChatRequest, Env, MetaPublicConfig } from './types';

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

const webhookTenantFromPath = (pathname: string): string | null => {
  const match = pathname.match(/^\/t\/([^/]+)\/webhook$/);
  return match?.[1] ?? null;
};

const debugTenantFromPath = (pathname: string): string | null => {
  const match = pathname.match(/^\/debug\/kv\/([^/]+)$/);
  return match?.[1] ?? null;
};

const makeRequestId = (): string => crypto.randomUUID();

const safeString = (value: string): string => value.trim().slice(0, MAX_CONTENT_LENGTH);
const safeField = (value: string, fallback: string): string => {
  const clean = value.trim().slice(0, MAX_FIELD_LENGTH);
  return clean || fallback;
};

const kvKeyTenantPrompt = (tenant: string): string => `tenant:${tenant}:system_prompt`;
const kvKeyTenantApi = (tenant: string): string => `tenant:${tenant}:api_key`;
const kvKeyLastChatAt = (tenant: string): string => `tenant:${tenant}:last_chat_at`;
const kvKeyRateLimit = (tenant: string, channel: string, userId: string, minuteBucket: number): string =>
  `rl:${tenant}:${channel}:${userId}:${minuteBucket}`;
const isPlaceholderSecret = (value: string | null | undefined): boolean =>
  Boolean(value && /^(tu_|your_|test_|demo_|example_)/i.test(value.trim()));

export const getTenantPrompt = async (
  env: Env,
  tenant: string
): Promise<{ key: string; value: string; exists: boolean; error?: string }> => {
  const key = kvKeyTenantPrompt(tenant);
  try {
    const value = await env.EASYMARKET_KV.get(key);
    console.log('[kv:getTenantPrompt]', { tenant, key, exists: Boolean(value) });
    if (!value || !value.trim()) {
      return { key, value: DEFAULT_SYSTEM_PROMPT, exists: false };
    }
    return { key, value: value.trim(), exists: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'unknown error';
    console.log('[kv:getTenantPrompt:error]', { tenant, key, error: errorMsg });
    return { key, value: DEFAULT_SYSTEM_PROMPT, exists: false, error: errorMsg };
  }
};

export const getTenantApiKey = async (
  env: Env,
  tenant: string
): Promise<{ key: string; value: string | null; exists: boolean; error?: string }> => {
  const key = kvKeyTenantApi(tenant);
  try {
    const value = await env.EASYMARKET_KV.get(key);
    console.log('[kv:getTenantApiKey]', { tenant, key, exists: Boolean(value) });
    return { key, value: value?.trim() || null, exists: Boolean(value?.trim()) };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'unknown error';
    console.log('[kv:getTenantApiKey:error]', { tenant, key, error: errorMsg });
    return { key, value: null, exists: false, error: errorMsg };
  }
};

export const putLastChatAt = async (
  env: Env,
  tenant: string,
  timestamp: string
): Promise<{ ok: boolean; key: string; readBack: string | null; error?: string }> => {
  const key = kvKeyLastChatAt(tenant);
  try {
    console.log('[kv:putLastChatAt:write]', { tenant, key, valueType: typeof timestamp });
    await env.EASYMARKET_KV.put(key, timestamp);
    const readBack = await env.EASYMARKET_KV.get(key);
    console.log('[kv:putLastChatAt:read]', { tenant, key, readBackExists: Boolean(readBack) });
    return { ok: readBack === timestamp, key, readBack };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'unknown error';
    console.log('[kv:putLastChatAt:error]', { tenant, key, error: errorMsg });
    return { ok: false, key, readBack: null, error: errorMsg };
  }
};

export const incrementRateLimit = async (
  env: Env,
  input: { tenant: string; channel: string; userId: string; maxPerMinute?: number }
): Promise<{
  ok: boolean;
  limited: boolean;
  key: string;
  current: number;
  next: number;
  minuteBucket: number;
  error?: string;
}> => {
  const minuteBucket = Math.floor(Date.now() / 60000);
  const key = kvKeyRateLimit(input.tenant, input.channel, input.userId, minuteBucket);
  const maxPerMinute = input.maxPerMinute ?? MAX_REQUESTS_PER_MINUTE;

  try {
    const current = Number((await env.EASYMARKET_KV.get(key)) || '0');
    const limited = current >= maxPerMinute;
    if (!limited) {
      await env.EASYMARKET_KV.put(key, String(current + 1), { expirationTtl: 120 });
    }

    console.log('[kv:incrementRateLimit]', {
      tenant: input.tenant,
      channel: input.channel,
      userId: input.userId,
      key,
      current,
      next: limited ? current : current + 1,
      limited
    });

    return {
      ok: true,
      limited,
      key,
      current,
      next: limited ? current : current + 1,
      minuteBucket
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'unknown error';
    console.log('[kv:incrementRateLimit:error]', {
      tenant: input.tenant,
      channel: input.channel,
      userId: input.userId,
      key,
      error: errorMsg
    });
    return {
      ok: false,
      limited: false,
      key,
      current: 0,
      next: 0,
      minuteBucket,
      error: errorMsg
    };
  }
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
  const tenantApi = await getTenantApiKey(env, tenant);
  const fallbackKey = env.EASYMARKET_API_KEY?.trim() || null;
  const expectedKeyRaw = tenantApi.value || fallbackKey;
  const expectedKey = isPlaceholderSecret(expectedKeyRaw) ? null : expectedKeyRaw;

  if (!expectedKey) {
    return null;
  }

  if (!sentKey || sentKey !== expectedKey) {
    return json({ ok: false, error: 'unauthorized' }, { status: 401 }, requestId);
  }

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

const asTrimmedOrNull = (value: string | undefined): string | null => {
  const clean = value?.trim();
  return clean ? clean : null;
};

const readMetaPublicConfig = (env: Env, request: Request): MetaPublicConfig => {
  const url = new URL(request.url);
  return {
    appId: asTrimmedOrNull(env.META_APP_ID),
    embeddedSignupConfigId: asTrimmedOrNull(env.META_EMBEDDED_SIGNUP_CONFIG_ID),
    redirectUri: `${url.origin}/wa-onboarding`
  };
};

const safeInlineJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const renderWaOnboardingPage = (config: MetaPublicConfig): string => {
  const runtimeConfig = safeInlineJson(config);
  const hasMissingConfig = !config.appId || !config.embeddedSignupConfigId;

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>EasyMarket WhatsApp Onboarding</title>
    <style>
      :root { color-scheme: light dark; --bg: #0b1220; --panel: #111a2b; --text: #e7edf7; --muted: #a7b4c8; --error: #ff7a7a; --ok: #71d08f; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100dvh; background: radial-gradient(circle at top, #16243d 0%, var(--bg) 45%); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
      main { max-width: 900px; margin: 0 auto; padding: 1.2rem; display: grid; gap: 0.9rem; }
      .panel { background: rgba(17, 26, 43, 0.82); border: 1px solid #22314d; border-radius: 12px; padding: 1rem; }
      h1 { margin: 0 0 0.35rem; }
      .muted { color: var(--muted); margin: 0; }
      button { width: 100%; border-radius: 10px; border: 0; padding: 0.8rem; font: inherit; font-weight: 600; cursor: pointer; background: #2469b8; color: var(--text); }
      button:disabled { opacity: 0.6; cursor: not-allowed; }
      .status-ok { color: var(--ok); }
      .status-error { color: var(--error); }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 320px; }
      .grid { display: grid; gap: 0.8rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h1>EasyMarket WhatsApp Onboarding</h1>
        <p class="muted">conecta el whatsapp del negocio con meta embedded signup.</p>
      </section>
      <section class="panel">
        <button id="connectBtn" type="button">Conectar WhatsApp del negocio</button>
      </section>
      <section class="panel grid">
        <div><strong>estado</strong><pre id="status"></pre></div>
        <div><strong>resultado</strong><pre id="result"></pre></div>
        <div><strong>error</strong><pre id="error"></pre></div>
      </section>
      <section class="panel">
        <strong>payload crudo (debug temporal)</strong>
        <pre id="rawPayload"></pre>
      </section>
    </main>
    <script>
      (() => {
        const config = ${runtimeConfig};
        const statusEl = document.getElementById('status');
        const resultEl = document.getElementById('result');
        const errorEl = document.getElementById('error');
        const rawPayloadEl = document.getElementById('rawPayload');
        const connectBtn = document.getElementById('connectBtn');
        const sdkUrl = 'https://connect.facebook.net/en_US/sdk.js';
        const graphVersion = 'v22.0';
        const expectedOrigins = new Set(['https://www.facebook.com', 'https://web.facebook.com', 'https://business.facebook.com']);
        let sdkReady = false;

        const setText = (el, text) => { if (el) el.textContent = text; };
        const setStatus = (text, mode = 'normal') => {
          setText(statusEl, text);
          if (!statusEl) return;
          statusEl.className = mode === 'ok' ? 'status-ok' : mode === 'error' ? 'status-error' : '';
        };
        const setError = (text) => setText(errorEl, text || '');
        const setResult = (value) => setText(resultEl, JSON.stringify(value, null, 2));
        const setRaw = (value) => setText(rawPayloadEl, JSON.stringify(value, null, 2));

        const parseMaybeJson = (value) => {
          if (typeof value !== 'string') return value;
          try { return JSON.parse(value); } catch { return value; }
        };

        const extractResult = (payload) => {
          const root = payload && typeof payload === 'object' ? payload : {};
          const data = root.data && typeof root.data === 'object' ? root.data : {};
          const session = data.session_info && typeof data.session_info === 'object' ? data.session_info : {};
          const extras = data.extras && typeof data.extras === 'object' ? data.extras : {};

          return {
            code: typeof root.code === 'string' ? root.code : typeof data.code === 'string' ? data.code : null,
            wabaId: typeof session.waba_id === 'string' ? session.waba_id : typeof extras.waba_id === 'string' ? extras.waba_id : null,
            phoneNumberId:
              typeof session.phone_number_id === 'string'
                ? session.phone_number_id
                : typeof extras.phone_number_id === 'string'
                  ? extras.phone_number_id
                  : null
          };
        };

        const onMessage = (event) => {
          if (!expectedOrigins.has(event.origin)) return;
          const parsed = parseMaybeJson(event.data);
          console.log('[wa-onboarding] postMessage', { origin: event.origin, payload: parsed });
          setRaw({ source: 'postMessage', origin: event.origin, payload: parsed });
          const extracted = extractResult(parsed);
          setResult(extracted);
        };

        const loadSdk = () =>
          new Promise((resolve, reject) => {
            if (window.FB && typeof window.FB.init === 'function') {
              resolve();
              return;
            }
            const existing = document.getElementById('facebook-jssdk');
            if (existing) {
              setTimeout(() => (window.FB ? resolve() : reject(new Error('sdk no disponible'))), 1000);
              return;
            }
            const script = document.createElement('script');
            script.id = 'facebook-jssdk';
            script.async = true;
            script.defer = true;
            script.src = sdkUrl;
            script.onload = () => (window.FB ? resolve() : reject(new Error('sdk no inicializado')));
            script.onerror = () => reject(new Error('no se pudo cargar sdk'));
            document.head.appendChild(script);
            setTimeout(() => reject(new Error('timeout cargando sdk')), 10000);
          });

        const initSdk = async () => {
          if (!config.appId || !config.embeddedSignupConfigId) {
            connectBtn.disabled = true;
            setStatus('config faltante en worker', 'error');
            setError('faltan META_APP_ID o META_EMBEDDED_SIGNUP_CONFIG_ID en Cloudflare.');
            setResult({ sdkLoaded: false, configReady: false, appId: config.appId, embeddedSignupConfigId: config.embeddedSignupConfigId });
            return;
          }

          try {
            setStatus('cargando sdk...');
            await loadSdk();
            window.FB.init({ appId: config.appId, autoLogAppEvents: true, xfbml: false, version: graphVersion });
            sdkReady = true;
            setStatus('sdk cargado y config lista', 'ok');
            setResult({ sdkLoaded: true, configReady: true, appId: config.appId, embeddedSignupConfigId: config.embeddedSignupConfigId, redirectUri: config.redirectUri });
            console.log('[wa-onboarding] sdk initialized', { appId: config.appId, embeddedSignupConfigId: config.embeddedSignupConfigId, redirectUri: config.redirectUri });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'error sdk';
            setStatus('error cargando sdk', 'error');
            setError(msg);
            connectBtn.disabled = true;
            console.error('[wa-onboarding] sdk error', error);
          }
        };

        const launchSignup = () => {
          if (!sdkReady || !window.FB) {
            setStatus('sdk no disponible', 'error');
            return;
          }
          setStatus('login iniciado');
          setError('');
          setRaw({ source: 'login', event: 'started' });
          console.log('[wa-onboarding] login start', { configId: config.embeddedSignupConfigId });

          window.FB.login(
            (response) => {
              console.log('[wa-onboarding] login callback', response);
              setRaw({ source: 'login_callback', payload: response });
              if (!response || !response.authResponse) {
                setStatus('flujo cancelado o sin authResponse', 'error');
                setError('el usuario canceló o no se recibió authResponse.');
                setResult({ code: null, wabaId: null, phoneNumberId: null, status: 'cancelled' });
                return;
              }
              const extracted = extractResult(response);
              setStatus('flujo completado', 'ok');
              setResult({ ...extracted, status: 'completed' });
            },
            {
              config_id: config.embeddedSignupConfigId,
              response_type: 'code',
              override_default_response_type: true,
              extras: {
                setup: {},
                feature: 'whatsapp_embedded_signup',
                sessionInfoVersion: '3'
              }
            }
          );
        };

        window.addEventListener('message', onMessage);
        connectBtn.addEventListener('click', launchSignup);
        setRaw({ source: 'runtime_config', payload: config });
        ${hasMissingConfig ? "setError('faltan variables de entorno para iniciar el onboarding.');" : ''}
        void initSdk();
      })();
    </script>
  </body>
</html>`;
};

const handleWaOnboardingGet = (request: Request, env: Env): Response => {
  const config = readMetaPublicConfig(env, request);
  return new Response(renderWaOnboardingPage(config), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
};

const getMetaVerifyToken = (env: Env, tenant: string): string | null => {
  if (tenant === 'demo') {
    return env.META_VERIFY_TOKEN__demo?.trim() || null;
  }

  return null;
};

const handleWebhookGet = (url: URL, env: Env, tenant: string): Response => {
  // meta callback verification
  const verifyToken = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const expectedToken = getMetaVerifyToken(env, tenant);

  if (!verifyToken || !challenge || !expectedToken || verifyToken !== expectedToken) {
    return new Response(null, { status: 403 });
  }

  return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
};

const webhookInternalApiKey = async (env: Env, tenant: string): Promise<string | null> => {
  const tenantApi = await getTenantApiKey(env, tenant);
  if (tenantApi.value && !isPlaceholderSecret(tenantApi.value)) {
    return tenantApi.value;
  }

  const fallback = env.EASYMARKET_API_KEY?.trim() || null;
  if (fallback && !isPlaceholderSecret(fallback)) {
    return fallback;
  }

  return null;
};

const handleWebhookPost = async (request: Request, env: Env, tenant: string): Promise<Response> => {
  // receive meta test webhooks
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json body' }, { status: 400 });
  }

  console.log('[meta:webhook]', payload);
  const inboundMessages = parseWhatsAppInboundMessages(payload);
  const internalApiKey = await webhookInternalApiKey(env, tenant);

  for (const inbound of inboundMessages) {
    if (inbound.type !== 'text' || !inbound.text) {
      continue;
    }

    const chatPayload: ChatRequest = {
      message: inbound.text,
      channel: 'whatsapp',
      userId: inbound.from,
      messageId: inbound.messageId,
      conversationId: `wa:${tenant}:${inbound.from}`
    };

    const headers = new Headers({ 'content-type': 'application/json' });
    if (internalApiKey) {
      headers.set('x-api-key', internalApiKey);
    }

    const internalRequest = new Request(`https://internal/t/${tenant}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(chatPayload)
    });

    const chatResponse = await handleChat(internalRequest, env, tenant);
    if (!chatResponse.ok) {
      console.log('[meta:webhook:chat_error]', { tenant, from: inbound.from, status: chatResponse.status });
      continue;
    }

    const chatBody = (await chatResponse.json()) as { reply?: unknown };
    if (typeof chatBody.reply !== 'string' || !chatBody.reply.trim()) {
      continue;
    }

    const sendResult = await sendWhatsAppText(env, { tenant, to: inbound.from, text: chatBody.reply });
    if (!sendResult.ok) {
      console.log('[meta:webhook:send_error]', {
        tenant,
        from: inbound.from,
        error: sendResult.error || 'unknown',
        status: sendResult.status || null
      });
    }
  }

  return json({ ok: true });
};

const handleDebugKvGet = async (env: Env, tenant: string, requestId: string): Promise<Response> => {
  const prompt = await getTenantPrompt(env, tenant);
  const tenantApi = await getTenantApiKey(env, tenant);
  const lastChatKey = kvKeyLastChatAt(tenant);
  const apiKeyLooksPlaceholder = isPlaceholderSecret(tenantApi.value);
  const setupHints = [
    `wrangler kv key put --remote --namespace-id <KV_NAMESPACE_ID> "${prompt.key}" "<SYSTEM_PROMPT>"`,
    `wrangler kv key put --remote --namespace-id <KV_NAMESPACE_ID> "${tenantApi.key}" "<TENANT_API_KEY>"`
  ];

  let lastChatAt: string | null = null;
  let lastChatReadError: string | null = null;
  try {
    lastChatAt = await env.EASYMARKET_KV.get(lastChatKey);
    console.log('[kv:debug:getLastChatAt]', { tenant, key: lastChatKey, exists: Boolean(lastChatAt) });
  } catch (error) {
    lastChatReadError = error instanceof Error ? error.message : 'unknown error';
    console.log('[kv:debug:getLastChatAt:error]', { tenant, key: lastChatKey, error: lastChatReadError });
  }

  return json(
    {
      ok: true,
      tenant,
      tenantSystemPrompt: prompt.exists ? prompt.value : null,
      tenantApiKeyExists: tenantApi.exists,
      tenantApiKeyLooksPlaceholder: apiKeyLooksPlaceholder,
      lastChatAt,
      keysIntentadas: {
        tenantPromptKey: prompt.key,
        tenantApiKey: tenantApi.key,
        lastChatAtKey: lastChatKey
      },
      setupHints,
      readErrors: {
        tenantPromptError: prompt.error || null,
        tenantApiError: tenantApi.error || null,
        lastChatAtError: lastChatReadError
      }
    },
    undefined,
    requestId
  );
};

const handleDebugKvPost = async (env: Env, tenant: string, requestId: string): Promise<Response> => {
  const now = new Date().toISOString();
  const write = await putLastChatAt(env, tenant, now);

  return json(
    {
      ok: true,
      tenant,
      wrote: write.ok,
      key: write.key,
      valueReadBack: write.readBack,
      error: write.error || null
    },
    undefined,
    requestId
  );
};

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

  const rateLimit = await incrementRateLimit(env, { tenant, channel, userId });
  if (!rateLimit.ok) {
    return json(
      {
        ok: false,
        error: 'rate limit check failed',
        rateLimitKey: rateLimit.key,
        details: rateLimit.error || 'unknown'
      },
      { status: 500 },
      requestId
    );
  }

  if (rateLimit.limited) {
    return json(
      {
        ok: false,
        error: 'rate limit exceeded',
        rateLimitKey: rateLimit.key
      },
      { status: 429 },
      requestId
    );
  }

  try {
    const existingReply = await getAssistantReplyForMessageId(env, { tenant, messageId });
    if (existingReply) {
      return json(
        {
          ok: true,
          tenant,
          conversationId,
          messageId,
          reply: existingReply,
          deduped: true,
          kvLastChatAtWritten: false,
          lastChatAtKey: kvKeyLastChatAt(tenant),
          rateLimitKey: rateLimit.key
        },
        undefined,
        requestId
      );
    }

    const prompt = await getTenantPrompt(env, tenant);
    if (!messages.some((message) => message.role === 'system')) {
      messages.unshift({ role: 'system', content: prompt.value });
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

    const kvWrite = await putLastChatAt(env, tenant, new Date().toISOString());

    return json(
      {
        ok: true,
        tenant,
        conversationId,
        messageId,
        reply,
        kvLastChatAtWritten: kvWrite.ok,
        lastChatAtKey: kvWrite.key,
        rateLimitKey: rateLimit.key
      },
      undefined,
      requestId
    );
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
            messageId,
            reply: existingReply,
            deduped: true,
            kvLastChatAtWritten: false,
            lastChatAtKey: kvKeyLastChatAt(tenant),
            rateLimitKey: rateLimit.key
          },
          undefined,
          requestId
        );
      }

      return json(
        {
          ok: false,
          error: 'duplicate message in progress, retry with same messageId',
          rateLimitKey: rateLimit.key
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
              : 'no hay claves de gemini configuradas en este momento',
          rateLimitKey: rateLimit.key
        },
        { status: 503 },
        requestId
      );
    }

    return json(
      {
        ok: false,
        error: 'error interno',
        requestId,
        rateLimitKey: rateLimit.key
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

    if (request.method === 'GET' && url.pathname === '/wa-onboarding') {
      return handleWaOnboardingGet(request, env);
    }

    const debugTenant = debugTenantFromPath(url.pathname);
    if (request.method === 'GET' && debugTenant) {
      return handleDebugKvGet(env, debugTenant, makeRequestId());
    }

    if (request.method === 'POST' && debugTenant) {
      return handleDebugKvPost(env, debugTenant, makeRequestId());
    }

    const webhookTenant = webhookTenantFromPath(url.pathname);
    if (request.method === 'GET' && webhookTenant) {
      return handleWebhookGet(url, env, webhookTenant);
    }

    if (request.method === 'POST' && webhookTenant) {
      return handleWebhookPost(request, env, webhookTenant);
    }

    const tenant = tenantFromPath(url.pathname);
    if (request.method === 'POST' && tenant) {
      return handleChat(request, env, tenant);
    }

    return json({ ok: false, error: 'not found' }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;

export { generateReply };
