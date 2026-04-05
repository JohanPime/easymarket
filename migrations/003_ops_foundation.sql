-- phase 2 ops foundation for production flows
create table if not exists conversations (
  id text primary key,
  tenant_id text not null,
  channel text not null default 'web',
  external_user_id text not null,
  status text not null default 'open',
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create index if not exists idx_conversations_tenant_id
  on conversations(tenant_id);

create index if not exists idx_conversations_external_user_id
  on conversations(external_user_id);

alter table chat_messages add column message_id text;

create unique index if not exists idx_chat_messages_tenant_message_role
  on chat_messages(tenant_id, message_id, role)
  where message_id is not null;
