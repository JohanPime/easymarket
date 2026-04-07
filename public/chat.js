const tenantEl = document.querySelector('#tenant');
const apiKeyEl = document.querySelector('#apiKey');
const systemPromptEl = document.querySelector('#systemPrompt');
const messageEl = document.querySelector('#message');
const sendEl = document.querySelector('#send');
const newChatEl = document.querySelector('#newChat');
const messagesEl = document.querySelector('#messages');
const statusEl = document.querySelector('#status');
const metaEl = document.querySelector('#meta');

/** @type {{role: 'system'|'user'|'assistant', content: string}[]} */
let history = [];
let busy = false;
let conversationId = crypto.randomUUID();

const getWebUserId = () => {
  const key = 'easymarket:web_user_id';
  const found = localStorage.getItem(key);
  if (found) return found;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
};

const setStatus = (text, mode = 'idle') => {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('error', mode === 'error');
  statusEl.classList.toggle('ok', mode === 'ok');
};

const updateMeta = () => {
  if (!metaEl) return;
  metaEl.textContent = `${history.length} mensajes · conv ${conversationId.slice(0, 8)}`;
};

const bubble = (role, content) => {
  const container = document.createElement('article');
  container.className = `bubble ${role}`;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = role === 'assistant' ? 'assistant' : role;

  const text = document.createElement('div');
  text.textContent = content;

  container.append(meta, text);
  return container;
};

const renderMessages = () => {
  if (!messagesEl) return;
  messagesEl.innerHTML = '';

  history
    .filter((m) => m.role !== 'system')
    .forEach((message) => messagesEl.appendChild(bubble(message.role, message.content)));

  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateMeta();
};

const setBusy = (value) => {
  busy = value;
  if (!sendEl || !messageEl || !tenantEl || !newChatEl || !apiKeyEl) return;
  sendEl.disabled = value;
  messageEl.disabled = value;
  tenantEl.disabled = value;
  newChatEl.disabled = value;
  apiKeyEl.disabled = value;
};

const resetConversation = () => {
  conversationId = crypto.randomUUID();
  history = [];
  const systemPrompt = systemPromptEl?.value?.trim();
  if (systemPrompt) {
    history.push({ role: 'system', content: systemPrompt });
  }
  renderMessages();
  setStatus('conversación reiniciada', 'ok');
};

const sendMessage = async () => {
  if (busy) return;

  const tenant = tenantEl?.value?.trim() || 'demo';
  const message = messageEl?.value?.trim() || '';
  const apiKey = apiKeyEl?.value?.trim() || '';

  if (!message) {
    setStatus('escribe un mensaje antes de enviar', 'error');
    return;
  }

  const baseHistory = [...history];
  baseHistory.push({ role: 'user', content: message });
  history = baseHistory;
  renderMessages();

  if (messageEl) {
    messageEl.value = '';
    messageEl.focus();
  }

  setBusy(true);
  setStatus('consultando gemini...');

  try {
    const messageId = crypto.randomUUID();
    const headers = { 'content-type': 'application/json' };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }

    const response = await fetch(`/t/${encodeURIComponent(tenant)}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: baseHistory,
        conversationId,
        channel: 'web',
        userId: getWebUserId(),
        messageId
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      setStatus(`error ${response.status}: ${data.error || 'sin detalle'}`, 'error');
      history = baseHistory;
      renderMessages();
      return;
    }

    const reply = typeof data.reply === 'string' ? data.reply : 'sin respuesta';
    if (typeof data.conversationId === 'string' && data.conversationId.trim()) {
      conversationId = data.conversationId;
    }

    history.push({ role: 'assistant', content: reply });
    renderMessages();
    setStatus(data.deduped ? 'respuesta reutilizada por idempotencia' : 'respuesta recibida', 'ok');
  } catch (error) {
    history = baseHistory;
    renderMessages();
    const messageText = error instanceof Error ? error.message : 'network error';
    setStatus(`error de red: ${messageText}`, 'error');
  } finally {
    setBusy(false);
  }
};

sendEl?.addEventListener('click', sendMessage);
newChatEl?.addEventListener('click', resetConversation);
messageEl?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
});

resetConversation();
