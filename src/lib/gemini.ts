import type { ChatMessage, Env } from '../types';

const GEMINI_FLASH = 'gemini-2.5-flash';
const GEMINI_PRO = 'gemini-2.5-pro';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_KEY_COOLDOWN_MS = 30000;

export let currentKeyIndex = 0;

const keyCooldownUntil = new Map<string, number>();

type GeminiData = Record<string, unknown>;

export class GeminiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

export const getApiKeys = (env: Env): string[] =>
  [env.GEMINI_API_1, env.GEMINI_API_2, env.GEMINI_API_3].filter(
    (key): key is string => Boolean(key && key.trim())
  );

const mapRole = (role: ChatMessage['role']): 'model' | 'user' => {
  if (role === 'assistant') return 'model';
  return 'user';
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const getBackoffMs = (attempt: number): number => {
  const base = Math.min(250 * 2 ** attempt, 2000);
  const jitter = Math.floor(Math.random() * 120);
  return base + jitter;
};

const isKeyCoolingDown = (key: string): boolean => {
  const cooldownUntil = keyCooldownUntil.get(key) ?? 0;
  return cooldownUntil > Date.now();
};

const setKeyCooldown = (key: string, status?: number): void => {
  if (status !== 402 && status !== 403 && status !== 429) return;
  keyCooldownUntil.set(key, Date.now() + MAX_KEY_COOLDOWN_MS);
};

export const geminiRequest = async (
  model: string,
  key: string,
  messages: ChatMessage[],
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<GeminiData> => {
  const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`;
  const contents = messages.map((message) => ({
    role: mapRole(message.role),
    parts: [{ text: message.content }]
  }));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents }),
      signal: controller.signal
    });
  } catch {
    throw new GeminiError('network error');
  } finally {
    clearTimeout(timeoutId);
  }

  const data = (await response.json().catch(() => ({}))) as GeminiData;

  if (!response.ok) {
    const apiError = (data.error as { message?: string } | undefined)?.message;
    throw new GeminiError(apiError || response.statusText || 'gemini request failed', response.status);
  }

  return data;
};

export const extractReply = (aiResp: unknown): string => {
  if (!aiResp) return '';

  if (typeof aiResp === 'string') {
    return aiResp.trim();
  }

  const data = aiResp as {
    output?: Array<{ content?: string }>;
    output_text?: string;
    response?: string;
    choices?: Array<{ message?: { content?: string }; text?: string }>;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  if (Array.isArray(data.output) && data.output.length > 0) {
    return data.output[0]?.content?.trim() || '';
  }

  if (typeof data.output_text === 'string') {
    return data.output_text.trim();
  }

  if (typeof data.response === 'string') {
    return data.response.trim();
  }

  if (Array.isArray(data.choices) && data.choices.length > 0) {
    const choice = data.choices[0];
    return (choice?.message?.content || choice?.text || '').trim();
  }

  if (Array.isArray(data.candidates) && data.candidates.length > 0) {
    const parts = data.candidates[0]?.content?.parts;
    if (Array.isArray(parts) && parts.length > 0) {
      return parts.map((part) => part.text || '').join('').trim();
    }
  }

  return '';
};

export const generateReply = async (messages: ChatMessage[], env: Env): Promise<string> => {
  const keys = getApiKeys(env);
  if (!keys.length) {
    throw new Error('NO_KEYS');
  }

  const models = [GEMINI_FLASH, GEMINI_PRO];
  let lastError: unknown = null;
  let attemptedRequest = false;

  for (let keyStep = 0; keyStep < keys.length; keyStep += 1) {
    const keyIndex = (currentKeyIndex + keyStep) % keys.length;
    const key = keys[keyIndex];

    if (isKeyCoolingDown(key)) {
      continue;
    }

    for (let modelStep = 0; modelStep < models.length; modelStep += 1) {
      const model = models[modelStep];

      try {
        attemptedRequest = true;
        const response = await geminiRequest(model, key, messages);
        currentKeyIndex = (keyIndex + 1) % keys.length;
        return extractReply(response) || 'sin respuesta';
      } catch (error) {
        const geminiError = error as GeminiError;
        const status = geminiError.status;
        const isRecoverable =
          status === 429 ||
          status === 402 ||
          status === 403 ||
          (typeof status === 'number' && status >= 500) ||
          status === undefined;

        if (isRecoverable) {
          setKeyCooldown(key, status);
          const attempt = keyStep * models.length + modelStep;
          await sleep(getBackoffMs(attempt));
          lastError = error;
          continue;
        }

        throw error;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  if (!attemptedRequest) {
    throw new Error('ALL_KEYS_COOLDOWN');
  }

  throw new Error('NO_KEYS');
};
