import type { Env } from '../types';

export interface WhatsAppInboundMessage {
  from: string;
  messageId: string;
  type: string;
  text: string | null;
}

const safe = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const parseWhatsAppInboundMessages = (payload: unknown): WhatsAppInboundMessage[] => {
  if (!payload || typeof payload !== 'object') return [];

  const root = payload as {
    object?: unknown;
    entry?: Array<{
      changes?: Array<{
        value?: { messages?: Array<{ from?: unknown; id?: unknown; type?: unknown; text?: { body?: unknown } }> };
      }>;
    }>;
  };

  if (root.object !== 'whatsapp_business_account' || !Array.isArray(root.entry)) return [];

  const output: WhatsAppInboundMessage[] = [];
  for (const entry of root.entry) {
    if (!Array.isArray(entry?.changes)) continue;
    for (const change of entry.changes) {
      const messages = change?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        const from = safe(message?.from);
        const messageId = safe(message?.id);
        const type = safe(message?.type);
        if (!from || !messageId || !type) continue;
        const text = safe(message?.text?.body);
        output.push({ from, messageId, type, text });
      }
    }
  }

  return output;
};

const getMetaWaConfig = (
  env: Env,
  tenant: string
): { token: string | null; phoneNumberId: string | null } => {
  if (tenant === 'demo') {
    return {
      token: env.META_WA_TOKEN__demo?.trim() || null,
      phoneNumberId: env.META_PHONE_NUMBER_ID__demo?.trim() || null
    };
  }

  return { token: null, phoneNumberId: null };
};

export const sendWhatsAppText = async (
  env: Env,
  input: { tenant: string; to: string; text: string }
): Promise<{ ok: boolean; status?: number; error?: string }> => {
  const config = getMetaWaConfig(env, input.tenant);
  if (!config.token || !config.phoneNumberId) {
    return { ok: false, error: 'missing_whatsapp_config' };
  }

  const response = await fetch(`https://graph.facebook.com/v20.0/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: input.to,
      type: 'text',
      text: { body: input.text }
    })
  });

  if (!response.ok) {
    const bodyText = await response.text();
    return { ok: false, status: response.status, error: bodyText || 'send_failed' };
  }

  return { ok: true, status: response.status };
};
