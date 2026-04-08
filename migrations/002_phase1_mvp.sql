-- phase 1 chat metadata for multichannel support
alter table chat_messages add column conversation_id text;
alter table chat_messages add column channel text default 'web';
alter table chat_messages add column external_user_id text;
alter table chat_messages add column created_by text default 'bot';

create index if not exists idx_chat_messages_conversation_id
  on chat_messages(conversation_id);

create index if not exists idx_chat_messages_channel
  on chat_messages(channel);
