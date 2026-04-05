export interface Env {
  EASYMARKET_DB: D1Database;
  EASYMARKET_KV: KVNamespace;
  EASYMARKET_DOCS: R2Bucket;
  GEMINI_API_1?: string;
  GEMINI_API_2?: string;
  GEMINI_API_3?: string;
  EASYMARKET_API_KEY?: string;
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
