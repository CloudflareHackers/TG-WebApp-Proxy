/**
 * User Mode UI — Full Telegram client experience.
 * Chat list, message viewer, media download, send messages.
 */

import { TGUserClient } from './user-client.js';
import { formatFileSize, getFileIcon } from './link-parser.js';

let userClient = null;
let currentEntity = null;
let currentDialogId = null;
let dialogsCache = [];

export function renderUserMode(container, addLog, switchMode) {
  container.innerHTML = `
    <div class="header">
      <h1>👤 Telegram User Client</h1>
      <p>Client-side MTProto • Browse chats, view media, download files</p>
    </div>

    <!-- Auth Card -->
    <div class="card" id="userAuthCard">
      <div class="flex-between mb-8">
        <h2><span class="icon">🔐</span> User Login</h2>
        <span class="status-badge disconnected" id="userStatusBadge">
          <span class="status-dot"></span>
          <span id="userStatusText">Not logged in</span>
        </span>
      </div>
      <div id="userAuthForm">
        <div class="form-row">
          <div class="form-group">
            <label for="userApiId">API ID</label>
            <input type="text" id="userApiId" placeholder="12345678" autocomplete="off" />
          </div>
          <div class="form-group">
            <label for="userApiHash">API Hash</label>
            <input type="password" id="userApiHash" placeholder="abc123def456..." autocomplete="off" />
          </div>
        </div>
        <div class="form-group">
          <label for="userPhone">Phone Number</label>
          <input type="text" id="userPhone" placeholder="+1234567890" autocomplete="off" />
        </div>
        <p class="hint">Enter your phone number with country code. You'll receive a code in Telegram.</p>
        <button class="btn-primary mt-12" id="btnUserLogin">🔑 Login</button>
      </div>
      <div id="userCodeForm" class="hidden">
        <div class="form-group">
          <label for="userCode">Verification Code</label>
          <input type="text" id="userCode" placeholder="12345" autocomplete="off" />
        </div>
        <p class="hint">Enter the code sent to your Telegram app.</p>
        <button class="btn-primary mt-12" id="btnUserSubmitCode">✅ Submit Code</button>
      </div>
      <div id="user2FAForm" class="hidden">
        <div class="form-group">
          <label for="user2FA">Two-Factor Password</label>
          <input type="password" id="user2FA" placeholder="Your 2FA password" autocomplete="off" />
        </div>
        <button class="btn-primary mt-12" id="btnUserSubmit2FA">🔒 Submit</button>
      </div>
      <div id="userLoggedInBar" class="hidden mt-12">
        <div class="flex-between">
          <span id="userLoggedInAs" class="text-dim">Logged in</span>
          <div style="display: flex; gap: 8px;">
            <button class="btn-danger btn-sm" id="btnUserLogout">🚪 Logout</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Chat List -->
    <div class="card hidden" id="userChatsCard">
      <div class="flex-between mb-8">
        <h2><span class="icon">💬</span> Chats</h2>
        <button class="btn-outline btn-sm" id="btnRefreshChats">🔄 Refresh</button>
      </div>
      <div class="form-group" style="margin-bottom: 8px;">
        <input type="text" id="chatSearch" placeholder="🔍 Search chats..." style="padding: 8px 12px; font-size: 0.88rem;" />
      </div>
      <div id="chatList" style="max-height: 400px; overflow-y: auto;">
        <p class="text-dim">Loading chats...</p>
      </div>
    </div>

    <!-- Message Viewer -->
    <div class="card hidden" id="userMessagesCard">
      <div class="flex-between mb-8">
        <h2><span class="icon">📝</span> <span id="chatTitle">Messages</span></h2>
        <button class="btn-outline btn-sm" id="btnBackToChats">← Back</button>
      </div>
      <div id="messageList" style="max-height: 500px; overflow-y: auto; padding: 4px 0;">
        <p class="text-dim">Select a chat</p>
      </div>
      <div id="userProgressBox" class="hidden">
        <div class="progress-container">
          <div class="progress-bar-bg"><div class="progress-bar-fill" id="userProgressBar"></div></div>
          <div class="progress-info">
            <span id="userProgressPercent">0%</span>
            <span id="userProgressSpeed">--</span>
          </div>
        </div>
      </div>
      <div class="reply-input-row mt-12">
        <input type="text" id="userMsgInput" placeholder="Type a message..." />
        <button class="btn-primary btn-sm" id="btnUserSend">Send</button>
      </div>
    </div>

    <!-- Log -->
    <div class="card">
      <div class="flex-between mb-8">
        <h2><span class="icon">📋</span> Log</h2>
        <div style="display: flex; gap: 8px;">
          <button class="btn-outline btn-sm" id="btnUserClearLog">Clear</button>
          <button class="btn-outline btn-sm" id="btnSwitchToBot">🤖 Bot Mode</button>
        </div>
      </div>
      <div class="log-container" id="userLogContainer"></div>
    </div>

    <p style="text-align: center; margin-top: 24px; font-size: 0.75rem; color: var(--text-dim);">
      🔒 Everything runs in your browser. Your session stays on your device.<br/>
      Built with <a href="https://gram.js.org" target="_blank" style="color: var(--primary)">GramJS</a>
    </p>
  `;

  // Bind events
  bindUserEvents(addLog, switchMode);

  // Check for saved session and auto-reconnect
  const tempClient = new TGUserClient(() => {}, () => {});
  if (tempClient.hasSession() && tempClient.getSavedCredentials()) {
    addLog('info', 'Found saved user session. Reconnecting...');
    autoReconnectUser(addLog);
  }
}

function userLog(type, msg) {
  const container = document.getElementById('userLogContainer');
  if (!container) return;
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${time}] ${msg}`;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

function setUserStatus(status) {
  const badge = document.getElementById('userStatusBadge');
  const text = document.getElementById('userStatusText');
  if (badge) badge.className = `status-badge ${status}`;
  if (text) text.textContent = status.charAt(0).toUpperCase() + status.slice(1);
}

function bindUserEvents(addLog, switchMode) {
  document.getElementById('btnUserLogin')?.addEventListener('click', () => handleUserLogin());
  document.getElementById('btnUserLogout')?.addEventListener('click', () => handleUserLogout());
  document.getElementById('btnRefreshChats')?.addEventListener('click', () => loadDialogs());
  document.getElementById('btnBackToChats')?.addEventListener('click', () => {
    document.getElementById('userMessagesCard')?.classList.add('hidden');
    document.getElementById('userChatsCard')?.classList.remove('hidden');
    currentEntity = null;
    currentDialogId = null;
  });
  document.getElementById('btnUserSend')?.addEventListener('click', () => handleUserSendMessage());
  document.getElementById('userMsgInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleUserSendMessage(); }
  });
  document.getElementById('btnUserClearLog')?.addEventListener('click', () => {
    document.getElementById('userLogContainer').innerHTML = '';
  });
  document.getElementById('btnSwitchToBot')?.addEventListener('click', () => {
    switchMode('bot');
  });
  document.getElementById('chatSearch')?.addEventListener('input', (e) => {
    filterDialogs(e.target.value.toLowerCase());
  });
}

// ===== Auth Flow =====
let _resolveCode = null;
let _resolvePassword = null;

async function handleUserLogin() {
  const apiId = document.getElementById('userApiId')?.value.trim();
  const apiHash = document.getElementById('userApiHash')?.value.trim();
  const phone = document.getElementById('userPhone')?.value.trim();
  if (!apiId || !apiHash || !phone) { userLog('error', 'Please fill all fields.'); return; }

  const btn = document.getElementById('btnUserLogin');
  btn.disabled = true; btn.innerHTML = '⏳ Connecting...';
  setUserStatus('connecting');

  try {
    userClient = new TGUserClient(userLog, updateUserProgress);
    await userClient.init(apiId, apiHash);

    // Start auth — GramJS will call these callbacks
    const phonePromise = () => Promise.resolve(phone);
    const codePromise = () => new Promise((resolve) => {
      _resolveCode = resolve;
      document.getElementById('userAuthForm')?.classList.add('hidden');
      document.getElementById('userCodeForm')?.classList.remove('hidden');
      document.getElementById('userCode')?.focus();
      document.getElementById('btnUserSubmitCode')?.addEventListener('click', () => {
        const code = document.getElementById('userCode')?.value.trim();
        if (code && _resolveCode) { _resolveCode(code); _resolveCode = null; }
      }, { once: true });
    });
    const passwordPromise = () => new Promise((resolve) => {
      _resolvePassword = resolve;
      document.getElementById('userCodeForm')?.classList.add('hidden');
      document.getElementById('user2FAForm')?.classList.remove('hidden');
      document.getElementById('user2FA')?.focus();
      document.getElementById('btnUserSubmit2FA')?.addEventListener('click', () => {
        const pw = document.getElementById('user2FA')?.value.trim();
        if (pw && _resolvePassword) { _resolvePassword(pw); _resolvePassword = null; }
      }, { once: true });
    });

    await userClient.authenticate(phonePromise, codePromise, passwordPromise);
    onUserLoggedIn();
  } catch (error) {
    setUserStatus('disconnected');
    userLog('error', `Login failed: ${error.message}`);
    btn.innerHTML = '🔑 Login';
  } finally {
    btn.disabled = false;
  }
}

async function autoReconnectUser(addLog) {
  setUserStatus('connecting');
  try {
    userClient = new TGUserClient(userLog, updateUserProgress);
    const ok = await userClient.reconnect();
    if (ok) {
      onUserLoggedIn();
    } else {
      setUserStatus('disconnected');
      userLog('warn', 'Session expired. Please login again.');
    }
  } catch (e) {
    setUserStatus('disconnected');
    userLog('warn', `Reconnect failed: ${e.message}`);
  }
}

function onUserLoggedIn() {
  setUserStatus('connected');
  // Hide auth form, show logged-in bar
  document.getElementById('userAuthForm')?.classList.add('hidden');
  document.getElementById('userCodeForm')?.classList.add('hidden');
  document.getElementById('user2FAForm')?.classList.add('hidden');
  document.getElementById('userLoggedInBar')?.classList.remove('hidden');
  const nameEl = document.getElementById('userLoggedInAs');
  if (nameEl && userClient.me) {
    nameEl.textContent = `👤 ${userClient.me.firstName || ''} ${userClient.me.lastName || ''} (@${userClient.me.username || 'N/A'})`;
  }
  // Show chats
  document.getElementById('userChatsCard')?.classList.remove('hidden');
  loadDialogs();
  // Listen for new messages
  userClient.startListening((msg) => {
    // If viewing this chat, append message
    if (currentEntity && msg.senderId) {
      appendUserMessage(msg);
    }
  });
}

async function handleUserLogout() {
  if (userClient) {
    userClient.clearSession();
    await userClient.disconnect();
    userClient = null;
  }
  setUserStatus('disconnected');
  document.getElementById('userLoggedInBar')?.classList.add('hidden');
  document.getElementById('userAuthForm')?.classList.remove('hidden');
  document.getElementById('userChatsCard')?.classList.add('hidden');
  document.getElementById('userMessagesCard')?.classList.add('hidden');
  userLog('info', 'Logged out. Session cleared.');
}

// ===== Dialogs =====

async function loadDialogs() {
  if (!userClient || !userClient.connected) return;
  const list = document.getElementById('chatList');
  if (list) list.innerHTML = '<p class="text-dim">Loading...</p>';

  try {
    dialogsCache = await userClient.getDialogs(100);
    renderDialogs(dialogsCache);
  } catch (e) {
    userLog('error', `Failed to load chats: ${e.message}`);
    if (list) list.innerHTML = '<p class="text-dim">Failed to load chats.</p>';
  }
}

function renderDialogs(dialogs) {
  const list = document.getElementById('chatList');
  if (!list) return;
  list.innerHTML = '';

  for (const d of dialogs) {
    const item = document.createElement('div');
    item.className = 'msg-item convo-item';
    const icon = d.isChannel ? '📢' : d.isGroup ? '👥' : '👤';
    const time = d.date ? d.date.toLocaleTimeString() : '';
    const preview = d.lastMessage.length > 80 ? d.lastMessage.slice(0, 80) + '...' : (d.lastMessage || '[No messages]');
    const unread = d.unreadCount > 0 ? `<span style="background: var(--primary); color: white; border-radius: 10px; padding: 1px 6px; font-size: 0.7rem; margin-left: 4px;">${d.unreadCount}</span>` : '';
    item.innerHTML = `
      <div class="msg-sender">
        <span style="font-size: 1.1rem;">${icon}</span>
        <span class="msg-sender-name" style="flex: 1;">${escHtml(d.title)}${unread}</span>
        <span class="msg-time">${time}</span>
      </div>
      <div class="msg-text">${escHtml(preview)}</div>
    `;
    item.addEventListener('click', () => openChat(d));
    list.appendChild(item);
  }

  if (dialogs.length === 0) {
    list.innerHTML = '<p class="text-dim">No chats found.</p>';
  }
}

function filterDialogs(query) {
  if (!query) {
    renderDialogs(dialogsCache);
    return;
  }
  const filtered = dialogsCache.filter(d => d.title.toLowerCase().includes(query));
  renderDialogs(filtered);
}

// ===== Chat Viewer =====

async function openChat(dialog) {
  currentEntity = dialog.entity;
  currentDialogId = dialog.id;

  document.getElementById('userChatsCard')?.classList.add('hidden');
  document.getElementById('userMessagesCard')?.classList.remove('hidden');
  document.getElementById('chatTitle').textContent = dialog.title;
  document.getElementById('messageList').innerHTML = '<p class="text-dim">Loading messages...</p>';
  document.getElementById('userMsgInput')?.focus();

  try {
    const messages = await userClient.getMessages(currentEntity, 40);
    const list = document.getElementById('messageList');
    list.innerHTML = '';
    // Messages come newest-first, reverse for display
    for (const msg of messages.reverse()) {
      appendUserMessage(msg);
    }
    list.scrollTop = list.scrollHeight;
  } catch (e) {
    userLog('error', `Failed to load messages: ${e.message}`);
    document.getElementById('messageList').innerHTML = '<p class="text-dim">Failed to load messages.</p>';
  }
}

function appendUserMessage(msg) {
  const list = document.getElementById('messageList');
  if (!list) return;
  // Remove placeholder
  const ph = list.querySelector(':scope > p.text-dim');
  if (ph) ph.remove();

  const div = document.createElement('div');
  const time = msg.date ? msg.date.toLocaleTimeString() : '';
  const isOut = msg.out;

  if (isOut) {
    div.className = 'reply-sent';
    div.innerHTML = `
      ${msg.text ? `<div class="reply-sent-text">${escHtml(msg.text)}</div>` : ''}
      ${msg.media ? renderMediaBadge(msg) : ''}
      <div class="reply-sent-time">${time}</div>
    `;
  } else {
    div.className = 'reply-received';
    div.innerHTML = `
      ${msg.media ? renderMediaBadge(msg) : ''}
      ${msg.text ? `<div class="reply-received-text">${escHtml(msg.text)}</div>` : ''}
      <div class="reply-received-time">${time}</div>
    `;
  }

  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function renderMediaBadge(msg) {
  if (!msg.media) return '';
  const m = msg.media;
  const icon = m.type === 'photo' ? '📷' : getFileIcon(m.mimeType, m.fileName);
  const size = m.fileSize ? formatFileSize(m.fileSize) : '';
  const name = m.type === 'photo' ? 'Photo' : (m.fileName || 'File');
  return `
    <div style="display:flex; align-items:center; gap:8px; margin: 4px 0; padding: 6px 8px; background: rgba(0,136,204,0.1); border-radius: 6px; cursor: pointer;" 
         onclick="window._downloadUserMedia && window._downloadUserMedia(${msg.id})">
      <span>${icon}</span>
      <span style="font-size: 0.82rem;">${escHtml(name)} ${size ? `(${size})` : ''}</span>
      <span style="font-size: 0.75rem; color: var(--primary);">📥 Download</span>
    </div>
  `;
}

// Global download handler
window._downloadUserMedia = async (msgId) => {
  if (!userClient || !userClient.connected || !currentEntity) return;
  try {
    userLog('info', `Downloading message #${msgId}...`);
    const messages = await userClient.getMessages(currentEntity, 1, msgId + 1);
    const msg = messages.find(m => m.id === msgId);
    if (!msg || !msg.message) { userLog('error', 'Message not found.'); return; }

    const media = msg.media;
    const fileName = media?.fileName || (media?.type === 'photo' ? `photo_${msgId}.jpg` : `file_${msgId}`);
    const mimeType = media?.mimeType || (media?.type === 'photo' ? 'image/jpeg' : 'application/octet-stream');

    document.getElementById('userProgressBox')?.classList.remove('hidden');
    await userClient.downloadAndSave(msg.message, fileName, mimeType);
    setTimeout(() => { document.getElementById('userProgressBox')?.classList.add('hidden'); }, 2000);
  } catch (e) {
    userLog('error', `Download failed: ${e.message}`);
    document.getElementById('userProgressBox')?.classList.add('hidden');
  }
};

// ===== Send Message =====

async function handleUserSendMessage() {
  if (!userClient || !userClient.connected || !currentEntity) return;
  const input = document.getElementById('userMsgInput');
  const text = input?.value?.trim();
  if (!text) return;

  try {
    await userClient.sendMessage(currentEntity, text);
    appendUserMessage({
      id: Date.now(),
      text,
      date: new Date(),
      out: true,
      media: null,
    });
    input.value = '';
    input.focus();
  } catch (e) {
    userLog('error', `Send failed: ${e.message}`);
  }
}

// ===== Progress =====

function updateUserProgress(progress) {
  const bar = document.getElementById('userProgressBar');
  const pct = document.getElementById('userProgressPercent');
  const spd = document.getElementById('userProgressSpeed');
  if (bar) bar.style.width = `${progress.percent.toFixed(1)}%`;
  if (pct) pct.textContent = `${progress.percent.toFixed(1)}%`;
  if (spd) spd.textContent = `${formatFileSize(progress.speed)}/s`;
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
