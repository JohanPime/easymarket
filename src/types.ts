export interface Env {
  EASYMARKET_DB: D1Database;
  EASYMARKET_KV: KVNamespace;
  EASYMARKET_DOCS?: R2Bucket;
  GEMINI_API_1?: string;
  GEMINI_API_2?: string;
  GEMINI_API_3?: string;
  EASYMARKET_API_KEY?: string;
  META_APP_ID?: string;
  META_EMBEDDED_SIGNUP_CONFIG_ID?: string;
  META_VERIFY_TOKEN__demo?: string;
  META_WA_TOKEN__demo?: string;
  META_PHONE_NUMBER_ID__demo?: string;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  message?: string;
  messages?: ChatMessage[];
  conversationId?: string;
  channel?: string;
  userId?: string;
  messageId?: string;
}

export interface MetaPublicConfig {
  appId: string | null;
  embeddedSignupConfigId: string | null;
  redirectUri: string;
}

export interface OnboardingExtractedResult {
  code: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
}
