const tenantEl = document.querySelector('#tenant');
const messageEl = document.querySelector('#message');
const sendEl = document.querySelector('#send');
const logEl = document.querySelector('#log');

const writeLog = (value) => {
  logEl.textContent = JSON.stringify(value, null, 2);
};

sendEl?.addEventListener('click', async () => {
  const tenant = tenantEl?.value?.trim() || 'demo';
  const message = messageEl?.value?.trim() || '';

  const response = await fetch(`/t/${encodeURIComponent(tenant)}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message })
  });

  const data = await response.json();
  writeLog(data);
});
