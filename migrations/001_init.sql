-- core tenant records
create table if not exists tenants (
  id text primary key,
  name text not null,
  created_at text not null default (datetime('now'))
);

-- minimal chat log
create table if not exists chat_messages (
  id integer primary key autoincrement,
  tenant_id text not null,
  role text not null,
  content text not null,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_chat_messages_tenant_id
  on chat_messages(tenant_id);
