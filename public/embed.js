(() => {
  const script = document.currentScript;
  const apiBase = script.getAttribute('data-api-base') || new URL(script.src, location.href).origin;
  const title = script.getAttribute('data-title') || 'Chat with us';
  const primary = script.getAttribute('data-primary-color') || '#0061ff';
  const company = script.getAttribute('data-company') || '';
  const position = script.getAttribute('data-position') || 'right'; // 'right' | 'left'

  const sessionKey = 'embchat_session_v1';
  let sessionId = localStorage.getItem(sessionKey) || null;
  const context = { company };

  const container = document.createElement('div');
  container.style.all = 'initial';
  const shadow = container.attachShadow({ mode: 'open' });
  document.addEventListener('DOMContentLoaded', () => {
    document.body.appendChild(container);
  });

  const styles = `
    :host { all: initial; }
    .launcher { position: fixed; ${position === 'left' ? 'left' : 'right'}: 20px; bottom: 20px; width: 56px; height: 56px; border-radius: 50%; background: ${primary}; color: #fff; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 24px rgba(0,0,0,.2); cursor: pointer; font: 500 16px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; z-index: 2147483647; }
    .launcher:hover { filter: brightness(0.95); }
    .panel { position: fixed; ${position === 'left' ? 'left' : 'right'}: 20px; bottom: 90px; width: 360px; max-width: calc(100vw - 32px); height: 520px; max-height: calc(100vh - 120px); background: #ffffff; border-radius: 16px; box-shadow: 0 12px 36px rgba(0,0,0,.22); display: grid; grid-template-rows: auto 1fr auto; overflow: hidden; z-index: 2147483647; opacity: 0; pointer-events: none; transform: translateY(8px); transition: all .2s ease; }
    .panel[open] { opacity: 1; pointer-events: all; transform: translateY(0); }
    .header { background: ${primary}; color: #fff; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; font: 600 14px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    .header button { background: transparent; border: 0; color: #fff; font-size: 20px; cursor: pointer; }
    .messages { padding: 12px; overflow: auto; background: #f7f8fa; }
    .msg { max-width: 80%; padding: 10px 12px; border-radius: 12px; margin: 6px 0; font: 400 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; white-space: pre-wrap; word-break: break-word; }
    .msg.user { background: #e8f0ff; color: #102a63; margin-left: auto; }
    .msg.assistant { background: #ffffff; color: #222; border: 1px solid #eceff3; }
    form { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 12px; background: #fff; border-top: 1px solid #eceff3; }
    input[type="text"] { border: 1px solid #d7dce3; border-radius: 10px; padding: 10px 12px; font: 400 14px/1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; outline: none; }
    input[type="text"]:focus { border-color: ${primary}; box-shadow: 0 0 0 3px color-mix(in oklab, ${primary} 20%, transparent); }
    button[type="submit"] { background: ${primary}; color: #fff; border: 0; border-radius: 10px; padding: 0 14px; font: 600 14px/1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; cursor: pointer; }
    .brand { font-size: 12px; color: #cfe0ff; margin-left: 8px; }
  `;

  shadow.innerHTML = `
    <style>${styles}</style>
    <div class="launcher" id="launcher" aria-label="Open chat" title="Open chat">💬</div>
    <div class="panel" id="panel" role="dialog" aria-modal="true" aria-label="Chat panel">
      <div class="header">
        <div>${title} <span class="brand">${company ? '· ' + company : ''}</span></div>
        <button id="close" aria-label="Close">×</button>
      </div>
      <div class="messages" id="messages" aria-live="polite"></div>
      <form id="form" autocomplete="off">
        <input id="input" type="text" placeholder="Type your message..." />
        <button id="send" type="submit">Send</button>
      </form>
    </div>
  `;

  const $ = id => shadow.getElementById(id);
  const launcher = $('launcher');
  const panel = $('panel');
  const messages = $('messages');
  const form = $('form');
  const input = $('input');
  const closeBtn = $('close');

  function addMsg(role, content) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = content;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function openPanel() {
    panel.setAttribute('open', '');
    launcher.style.display = 'none';
    input.focus();
  }

  function closePanel() {
    panel.removeAttribute('open');
    launcher.style.display = 'flex';
  }

  launcher.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);

  async function sendMessage(text) {
    addMsg('user', text);
    input.value = '';
    addMsg('assistant', '…');
    try {
      const res = await fetch(`${apiBase}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          message: text,
          user: { url: location.href, userAgent: navigator.userAgent },
          context
        })
      });
      const data = await res.json();
      if (data && data.sessionId) {
        sessionId = data.sessionId;
        try { localStorage.setItem(sessionKey, sessionId); } catch {}
      }
      const last = messages.lastElementChild;
      if (last && last.classList.contains('assistant')) {
        last.textContent = data.reply || 'Okay.';
      }
    } catch (err) {
      const last = messages.lastElementChild;
      if (last && last.classList.contains('assistant')) {
        last.textContent = 'Network error. Please try again.';
      }
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sendMessage(text);
  });

  // Open with keyboard shortcut (optional): Alt+/ opens chat
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === '/') {
      if (panel.hasAttribute('open')) closePanel(); else openPanel();
    }
  });
})();