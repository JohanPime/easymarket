export interface Env {
  EASYMARKET_DB: D1Database;
  EASYMARKET_KV: KVNamespace;
  EASYMARKET_DOCS: R2Bucket;
}

export interface ChatRequest {
  message: string;
  conversationId?: string;
}
