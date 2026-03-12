/**
 * User Mode UI — Full Telegram client experience.
 * Two-page layout:
 *   - Main page: Chat list, message viewer, media
 *   - Settings page: Login, account management, user settings
 */

import { TGUserClient, getAccounts, getNextSessionIndex, getActiveAccountIndex, setActiveAccountIndex, removeAccount } from './user-client.js';
import { getUserSettings, saveUserSettings, getUserDefaults, getProxySettings, saveProxySettings } from './settings.js';
import { formatFileSize, getFileIcon } from './link-parser.js';

let userClient = null;
let currentEntity = null;
let currentDialogId = null;
let currentDialogTitle = null;
let dialogsCache = [];
let userReplyToMsgId = null;
let oldestMsgId = 0;
let isLoadingOlder = false;
let _currentPage = 'main'; // 'main' | 'settings'
let _activeDownloadId = 0; // Tracks current download, increments to cancel old ones

// ===== Download Queue =====
const _downloadQueue = [];
let _queueIdCounter = 0;
let _queueProcessing = false;
let _currentQueueItemId = null; // ID of item currently downloading

const thumbCache = new Map();
const rawMessageCache = new Map();

const USER_UI_KEY = 'tgcf_user_ui';
function saveUIState() {
  localStorage.setItem(USER_UI_KEY, JSON.stringify({
    filter: document.querySelector('.chat-filter-btn.active')?.dataset?.filter || 'all',
    openChatId: currentDialogId || null,
    openChatTitle: currentDialogTitle || null,
  }));
}
function getUIState() {
  try { return JSON.parse(localStorage.getItem(USER_UI_KEY)) || {}; } catch { return {}; }
}

/**
 * Get last-used API credentials for auto-fill.
 */
// Default Telegram Web API credentials (from web.telegram.org)
const DEFAULT_API_ID = '1025907';
const DEFAULT_API_HASH = '452b0359b988148995f22ff0f4229750';

function getLastCreds() {
  const accounts = getAccounts();
  if (accounts.length > 0) {
    const last = accounts[accounts.length - 1];
    return { apiId: last.apiId || DEFAULT_API_ID, apiHash: last.apiHash || DEFAULT_API_HASH };
  }
  return { apiId: DEFAULT_API_ID, apiHash: DEFAULT_API_HASH };
}

export function renderUserMode(container, addLog, switchMode) {
  // Store globally for account switcher re-renders
  window._userModeSwitchMode = switchMode;
  window._userModeAddLog = addLog;

  const accounts = getAccounts();
  const activeIdx = getActiveAccountIndex();
  const activeAccount = accounts.find(a => a.idx === activeIdx);
  const isLoggedIn = userClient && userClient.connected;
  const accountName = activeAccount?.name || (userClient?.me ? `${userClient.me.firstName || ''} ${userClient.me.lastName || ''}`.trim() : '');

  container.innerHTML = `
    <div class="header">
      <h1>👤 Telegram User Client</h1>
      <p>Client-side MTProto • Browse chats, view media, download files</p>
      <div class="header-actions">
        <button class="btn-outline btn-sm" id="btnUserSettings">⚙️ Settings</button>
        <button class="btn-outline btn-sm" id="btnSwitchToBot">🤖 Bot Mode</button>
      </div>
    </div>

    <!-- ===== MAIN PAGE ===== -->
    <div id="userMainPage">
      ${isLoggedIn || (accounts.length > 0) ? `
        <div class="user-status-bar" id="userStatusBar">
          <div class="flex-between">
            <span id="userLoggedInAs" class="text-dim">${accountName ? `👤 ${escHtml(accountName)}` : 'Not logged in'}</span>
            <span class="status-badge ${isLoggedIn ? 'connected' : 'disconnected'}" id="userStatusBadge">
              <span class="status-dot"></span>
              <span id="userStatusText">${isLoggedIn ? 'Connected' : 'Not logged in'}</span>
            </span>
          </div>
        </div>
      ` : `
        <div class="card" style="text-align:center; padding:32px;">
          <p style="font-size:1.1rem; margin-bottom:12px;">🔐 No account configured</p>
          <p class="text-dim" style="margin-bottom:16px;">Go to Settings to add your Telegram account.</p>
          <button class="btn-primary" id="btnGoToSettings" style="width:auto; padding:10px 28px;">⚙️ Open Settings</button>
        </div>
      `}

      <!-- Chat List -->
      <div class="card hidden" id="userChatsCard">
        <div class="flex-between mb-8">
          <h2><span class="icon">💬</span> Chats</h2>
          <div style="display:flex;gap:4px;">
            <button class="btn-outline btn-sm" id="btnRefreshChats">🔄</button>
            <button class="btn-outline btn-sm" id="btnClearReloadChats">🗑️</button>
          </div>
        </div>
        <div class="form-group" style="margin-bottom: 8px;">
          <input type="text" id="chatSearch" placeholder="🔍 Search chats..." style="padding: 8px 12px; font-size: 0.88rem;" />
        </div>
        <div style="display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap;">
          <button class="btn-outline btn-sm chat-filter-btn active" data-filter="all" style="font-size:0.75rem; padding:4px 10px;">All</button>
          <button class="btn-outline btn-sm chat-filter-btn" data-filter="user" style="font-size:0.75rem; padding:4px 10px;">👤 Private</button>
          <button class="btn-outline btn-sm chat-filter-btn" data-filter="bot" style="font-size:0.75rem; padding:4px 10px;">🤖 Bots</button>
          <button class="btn-outline btn-sm chat-filter-btn" data-filter="group" style="font-size:0.75rem; padding:4px 10px;">👥 Groups</button>
          <button class="btn-outline btn-sm chat-filter-btn" data-filter="channel" style="font-size:0.75rem; padding:4px 10px;">📢 Channels</button>
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
              <button class="btn-danger btn-sm" id="btnCancelDownload" style="padding:2px 10px; font-size:0.75rem; width:auto;">✕ Cancel</button>
            </div>
          </div>
        </div>
        <div class="reply-input-row mt-12">
          <input type="text" id="userMsgInput" placeholder="Type a message..." />
          <button class="btn-primary btn-sm" id="btnUserSend">Send</button>
        </div>
      </div>

      <!-- Download Queue -->
      <div class="card hidden" id="downloadQueueCard">
        <div class="flex-between mb-8">
          <h2><span class="icon">📥</span> Download Queue <span class="text-dim" id="queueCount" style="font-size:0.8rem; font-weight:400;"></span></h2>
          <button class="btn-outline btn-sm" id="btnClearQueue">🗑️ Clear</button>
        </div>
        <div id="downloadQueueList"></div>
      </div>

      <!-- Log -->
      <div class="card">
        <div class="flex-between mb-8">
          <h2><span class="icon">📋</span> Log</h2>
          <button class="btn-outline btn-sm" id="btnUserClearLog">Clear</button>
        </div>
        <div class="log-container" id="userLogContainer"></div>
      </div>
    </div>

    <!-- ===== SETTINGS PAGE ===== -->
    <!-- Settings Log (mirrors main log) -->
    <div id="userSettingsPage" class="hidden">

      <!-- Account Switcher -->
      ${accounts.length > 0 ? renderAccountSwitcher(accounts, activeIdx) : ''}

      <!-- Auth Card -->
      <div class="card" id="userAuthCard">
        <div class="flex-between mb-8">
          <h2><span class="icon">🔐</span> User Login</h2>
          <span class="status-badge ${isLoggedIn ? 'connected' : 'disconnected'}" id="userStatusBadge2">
            <span class="status-dot"></span>
            <span id="userStatusText2">${isLoggedIn ? 'Connected' : 'Not logged in'}</span>
          </span>
        </div>
        <div id="userAuthForm" ${isLoggedIn ? 'class="hidden"' : ''}>
          <div class="form-row">
            <div class="form-group">
              <label for="userApiId">API ID</label>
              <input type="text" id="userApiId" placeholder="12345678" autocomplete="off" value="${escHtml(getLastCreds().apiId)}" />
            </div>
            <div class="form-group">
              <label for="userApiHash">API Hash</label>
              <input type="password" id="userApiHash" placeholder="abc123def456..." autocomplete="off" value="${escHtml(getLastCreds().apiHash)}" />
            </div>
          </div>
          <div class="form-group">
            <label for="userPhone">Phone Number</label>
            <input type="text" id="userPhone" placeholder="+1234567890" autocomplete="off" />
          </div>
          <p class="hint">API credentials are pre-filled with Telegram Web defaults. You can use your own from <a href="https://my.telegram.org" target="_blank" style="color:var(--primary)">my.telegram.org</a>.</p>
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
        <div id="userLoggedInBar" ${isLoggedIn ? '' : 'class="hidden"'} style="margin-top:12px;">
          <div class="flex-between">
            <span id="userLoggedInAs2" class="text-dim">${accountName ? `👤 ${escHtml(accountName)}` : 'Logged in'}</span>
            <button class="btn-danger btn-sm" id="btnUserLogout">🚪 Logout</button>
          </div>
        </div>
      </div>

      <!-- User Settings -->
      <div class="card" id="userSettingsCard">
        <div class="flex-between mb-8">
          <h2><span class="icon">⚙️</span> User Settings</h2>
          <button class="btn-outline btn-sm" id="btnResetUserSettings">Reset Defaults</button>
        </div>
        <div class="form-group" style="margin-top: 8px;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" id="userSettingsStealth" style="width: auto; accent-color: var(--warning);" />
            <span>👻 Stealth Mode (avoid double tick)</span>
          </label>
          <p class="hint">Don't send read receipts when reading messages.</p>
        </div>
        <div class="form-group" style="margin-top: 8px;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" id="userSettingsAutoPhotos" style="width: auto; accent-color: var(--primary);" />
            <span>📷 Auto-load photo thumbnails</span>
          </label>
          <p class="hint">Automatically load photo previews in chats.</p>
        </div>
        <div class="form-group" style="margin-top: 8px;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" id="userSettingsNotify" style="width: auto; accent-color: var(--success);" />
            <span>🔔 Notify on new messages</span>
          </label>
          <p class="hint">Browser notifications for new messages.</p>
        </div>
        <div class="form-group" style="margin-top: 8px;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" id="userSettingsEnterSend" style="width: auto; accent-color: var(--primary);" />
            <span>⏎ Send with Enter</span>
          </label>
          <p class="hint">Press Enter to send (uncheck for Ctrl+Enter).</p>
        </div>
        <div class="form-group" style="margin-top: 8px;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" id="userSettingsProxy" style="width: auto; accent-color: var(--primary);" />
            <span>🌐 Enable Cloudflare Proxy</span>
          </label>
          <p class="hint">Route connections through a CF Worker proxy.</p>
        </div>
        <div class="form-group" style="margin-top: 8px;">
          <label for="userSettingsProxyDomain">Proxy Worker Domain</label>
          <input type="text" id="userSettingsProxyDomain" placeholder="tg-ws-api.your-account.workers.dev" style="background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; color: var(--text); font-size: 0.88rem;" />
        </div>
        <div class="form-group" style="margin-top: 8px;">
          <label for="userSettingsFontSize">Font Size</label>
          <select id="userSettingsFontSize" style="background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; color: var(--text); font-size: 0.95rem; width: 100%;">
            <option value="small">Small</option>
            <option value="normal">Normal</option>
            <option value="large">Large</option>
          </select>
        </div>
        <div class="mt-12">
          <button class="btn-primary btn-sm" id="btnSaveUserSettings" style="width: auto;">💾 Save Settings</button>
          <span class="text-dim" id="userSettingsSaveStatus" style="margin-left: 8px;"></span>
        </div>
      </div>

      <!-- Settings Log -->
      <div class="card">
        <div class="flex-between mb-8">
          <h2><span class="icon">📋</span> Log</h2>
          <button class="btn-outline btn-sm" id="btnSettingsClearLog">Clear</button>
        </div>
        <div class="log-container" id="settingsLogContainer"></div>
      </div>

      <div style="text-align:center; margin-top:16px;">
        <button class="btn-primary" id="btnBackToMain" style="width:auto; padding:10px 32px;">← Back to Chats</button>
      </div>
    </div>

    <p style="text-align: center; margin-top: 24px; font-size: 0.75rem; color: var(--text-dim);">
      🔒 Everything runs in your browser. Your session stays on your device.<br/>
      Built with <a href="https://github.com/sanyok12345/teleproto" target="_blank" style="color: var(--primary)">teleproto</a>
    </p>
  `;

  loadUserSettingsUI();
  bindUserEvents(addLog, switchMode);

  // Check for interrupted auth (e.g. refreshed during 2FA step)
  const authProgress = getAuthProgress();
  if (authProgress && authProgress.step === 'need_2fa') {
    addLog('info', 'Resuming login (2FA step)...');
    showPage('settings');
    resumeAuthFrom2FA(authProgress);
  } else {
    // Auto-reconnect
    const tempClient = new TGUserClient(() => {}, () => {});
    if (tempClient.hasSession() && tempClient.getSavedCredentials()) {
      addLog('info', 'Found saved user session. Reconnecting...');
      autoReconnectUser(addLog);
    } else if (accounts.length === 0) {
      showPage('settings');
    }
  }
}

// ===== Page Navigation =====

function showPage(page) {
  _currentPage = page;
  const mainEl = document.getElementById('userMainPage');
  const settingsEl = document.getElementById('userSettingsPage');
  if (page === 'settings') {
    mainEl?.classList.add('hidden');
    settingsEl?.classList.remove('hidden');
  } else {
    mainEl?.classList.remove('hidden');
    settingsEl?.classList.add('hidden');
  }
}

function renderAccountSwitcher(accounts, activeIdx) {
  const activeAccount = accounts.find(a => a.idx === activeIdx);
  const canAddMore = accounts.length < 10;

  let optionsHtml = accounts.map(a => {
    const isActive = a.idx === activeIdx;
    return `<div class="account-option ${isActive ? 'active' : ''}" data-account-idx="${a.idx}">
      <span class="account-option-name">${escHtml(a.name || 'Unknown')}</span>
      <span class="account-option-detail">${escHtml(a.phone || '')} ${a.username ? `@${a.username}` : ''}</span>
      ${isActive ? '<span class="account-option-check">✓</span>' : ''}
      <button class="btn-outline btn-sm account-remove-btn" data-remove-idx="${a.idx}" style="padding:2px 8px; font-size:0.7rem; margin-left:4px; width:auto;" title="Remove account">🗑️</button>
    </div>`;
  }).join('');

  if (canAddMore) {
    optionsHtml += `<div class="account-option add-account" id="btnAddAccountDropdown">
      <span class="account-option-name">➕ Add Account</span>
      <span class="account-option-detail">Up to 10 accounts</span>
    </div>`;
  }

  return `
    <div class="card account-switcher-card" id="accountSwitcherCard">
      <div class="flex-between">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:1.1rem;">👥</span>
          <div>
            <div style="font-weight:600; font-size:0.9rem;">${escHtml(activeAccount?.name || 'No account')}</div>
            <div class="text-dim" style="font-size:0.75rem;">${escHtml(activeAccount?.phone || '')} ${activeAccount?.username ? `@${activeAccount.username}` : ''}</div>
          </div>
        </div>
        <button class="btn-outline btn-sm" id="btnToggleAccountDropdown">
          ${accounts.length} account${accounts.length !== 1 ? 's' : ''} ▾
        </button>
      </div>
      <div class="account-dropdown hidden" id="accountDropdown">
        ${optionsHtml}
      </div>
    </div>
  `;
}

function userLog(type, msg) {
  const time = new Date().toLocaleTimeString();
  const text = `[${time}] ${msg}`;
  // Write to both log containers (main + settings)
  ['userLogContainer', 'settingsLogContainer'].forEach(id => {
    const container = document.getElementById(id);
    if (!container) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = text;
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
  });
}

function setUserStatus(status) {
  ['userStatusBadge', 'userStatusBadge2'].forEach(id => {
    const badge = document.getElementById(id);
    if (badge) badge.className = `status-badge ${status}`;
  });
  ['userStatusText', 'userStatusText2'].forEach(id => {
    const text = document.getElementById(id);
    if (text) text.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  });
}

function bindUserEvents(addLog, switchMode) {
  // Page navigation
  document.getElementById('btnUserSettings')?.addEventListener('click', () => showPage('settings'));
  document.getElementById('btnBackToMain')?.addEventListener('click', () => showPage('main'));
  document.getElementById('btnGoToSettings')?.addEventListener('click', () => showPage('settings'));
  document.getElementById('btnSwitchToBot')?.addEventListener('click', () => switchMode('bot'));

  // Auth
  document.getElementById('btnUserLogin')?.addEventListener('click', () => handleUserLogin());
  document.getElementById('btnUserLogout')?.addEventListener('click', () => handleUserLogout(addLog, switchMode));

  // Chats
  document.getElementById('btnRefreshChats')?.addEventListener('click', () => loadDialogs());
  document.getElementById('btnClearReloadChats')?.addEventListener('click', () => {
    dialogsCache = [];
    const list = document.getElementById('chatList');
    if (list) list.innerHTML = '<p class="text-dim">Cleared. Refreshing...</p>';
    loadDialogs();
  });
  document.getElementById('btnBackToChats')?.addEventListener('click', () => {
    document.getElementById('userMessagesCard')?.classList.add('hidden');
    document.getElementById('userChatsCard')?.classList.remove('hidden');
    currentEntity = null; currentDialogId = null; currentDialogTitle = null;
    saveUIState();
  });

  // Send
  document.getElementById('btnUserSend')?.addEventListener('click', () => handleUserSendMessage());
  document.getElementById('userMsgInput')?.addEventListener('keydown', (e) => {
    const settings = getUserSettings();
    const sendOnEnter = settings.sendWithEnter !== false;
    if (sendOnEnter) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleUserSendMessage(); }
    } else {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); handleUserSendMessage(); }
    }
  });

  // Log (clear both)
  document.getElementById('btnUserClearLog')?.addEventListener('click', () => {
    document.getElementById('userLogContainer').innerHTML = '';
    document.getElementById('settingsLogContainer').innerHTML = '';
  });
  document.getElementById('btnSettingsClearLog')?.addEventListener('click', () => {
    document.getElementById('userLogContainer').innerHTML = '';
    document.getElementById('settingsLogContainer').innerHTML = '';
  });

  // Search & filters
  document.getElementById('chatSearch')?.addEventListener('input', (e) => filterDialogs(e.target.value.toLowerCase()));
  document.querySelectorAll('.chat-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chat-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterDialogsByType(btn.dataset.filter);
      saveUIState();
    });
  });

  // Account switcher
  document.getElementById('btnToggleAccountDropdown')?.addEventListener('click', () => {
    document.getElementById('accountDropdown')?.classList.toggle('hidden');
  });
  document.querySelectorAll('.account-option:not(.add-account)').forEach(opt => {
    opt.addEventListener('click', () => {
      const idx = parseInt(opt.dataset.accountIdx);
      if (idx !== getActiveAccountIndex()) switchAccount(idx, addLog, switchMode);
      document.getElementById('accountDropdown')?.classList.add('hidden');
    });
  });
  document.getElementById('btnAddAccountDropdown')?.addEventListener('click', () => {
    document.getElementById('accountDropdown')?.classList.add('hidden');
    startAddAccount();
  });

  // Per-account remove buttons
  document.querySelectorAll('.account-remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't trigger account switch
      const idx = parseInt(btn.dataset.removeIdx);
      if (confirm(`Remove this account? Session data will be cleared.`)) {
        const client = new TGUserClient(() => {}, () => {}, idx);
        client.clearSession();
        userLog('info', `Account #${idx} removed.`);
        // If removing active account, disconnect
        if (idx === getActiveAccountIndex() && userClient) {
          userClient.disconnect().catch(() => {});
          userClient = null;
        }
        const remaining = getAccounts();
        if (remaining.length > 0) setActiveAccountIndex(remaining[0].idx);
        else localStorage.removeItem('tgcf_active_account');
        // Re-render
        const app = document.getElementById('app');
        if (app && window._userModeSwitchMode) renderUserMode(app, addLog, switchMode);
      }
    });
  });

  // Download Queue
  document.getElementById('btnClearQueue')?.addEventListener('click', () => clearDownloadQueue());

  // User Settings
  document.getElementById('btnSaveUserSettings')?.addEventListener('click', handleSaveUserSettings);
  document.getElementById('btnResetUserSettings')?.addEventListener('click', handleResetUserSettings);
}

// ===== Multi-Account =====

let _pendingAccountIndex = null;

function startAddAccount() {
  const nextIdx = getNextSessionIndex();
  if (nextIdx < 0) { userLog('error', 'Maximum 10 accounts reached.'); return; }
  _pendingAccountIndex = nextIdx;
  userLog('info', `Adding new account (slot #${nextIdx}).`);

  document.getElementById('userLoggedInBar')?.classList.add('hidden');
  document.getElementById('userAuthForm')?.classList.remove('hidden');
  document.getElementById('userCodeForm')?.classList.add('hidden');
  document.getElementById('user2FAForm')?.classList.add('hidden');

  // Auto-fill API creds from last account
  const creds = getLastCreds();
  const apiIdEl = document.getElementById('userApiId');
  const apiHashEl = document.getElementById('userApiHash');
  const phoneEl = document.getElementById('userPhone');
  if (apiIdEl) apiIdEl.value = creds.apiId;
  if (apiHashEl) apiHashEl.value = creds.apiHash;
  if (phoneEl) { phoneEl.value = ''; phoneEl.focus(); }
}

async function switchAccount(targetIdx, addLog, switchMode) {
  userLog('info', `Switching to account #${targetIdx}...`);
  setUserStatus('connecting');
  if (userClient) { await userClient.disconnect(); userClient = null; }
  dialogsCache = []; currentEntity = null; currentDialogId = null; currentDialogTitle = null;
  thumbCache.clear(); rawMessageCache.clear();
  setActiveAccountIndex(targetIdx);
  const app = document.getElementById('app');
  if (app) renderUserMode(app, addLog, switchMode);
}

// ===== Auth Flow =====
let _resolveCode = null;
let _resolvePassword = null;
const AUTH_PROGRESS_KEY = 'tgcf_auth_progress';

/** Save auth progress so we can resume after refresh */
function saveAuthProgress(data) {
  sessionStorage.setItem(AUTH_PROGRESS_KEY, JSON.stringify(data));
}
function getAuthProgress() {
  try { return JSON.parse(sessionStorage.getItem(AUTH_PROGRESS_KEY)); } catch { return null; }
}
function clearAuthProgress() {
  sessionStorage.removeItem(AUTH_PROGRESS_KEY);
}

/**
 * Resume auth from 2FA step after a page refresh.
 * GramJS session was saved after OTP, so we just need to reconnect and ask for password.
 */
async function resumeAuthFrom2FA(progress) {
  const { apiId, apiHash, phone, accountIndex } = progress;
  setUserStatus('connecting');
  userLog('info', 'Reconnecting to resume 2FA authentication...');

  // Show 2FA form directly
  document.getElementById('userAuthForm')?.classList.add('hidden');
  document.getElementById('userCodeForm')?.classList.add('hidden');
  document.getElementById('user2FAForm')?.classList.remove('hidden');
  document.getElementById('user2FA')?.focus();

  try {
    userClient = new TGUserClient(userLog, updateUserProgress, accountIndex);
    await userClient.init(apiId, apiHash);

    const phonePromise = () => Promise.resolve(phone);
    const codePromise = () => Promise.resolve(''); // OTP already done — GramJS will skip
    const passwordPromise = () => new Promise((resolve) => {
      _resolvePassword = resolve;
      document.getElementById('btnUserSubmit2FA')?.addEventListener('click', () => {
        const pw = document.getElementById('user2FA')?.value.trim();
        if (pw && _resolvePassword) {
          const pwBtn = document.getElementById('btnUserSubmit2FA');
          if (pwBtn) { pwBtn.disabled = true; pwBtn.innerHTML = '⏳ Authenticating...'; }
          setAuthInputsLocked(true);
          _resolvePassword(pw); _resolvePassword = null;
        }
      }, { once: true });
    });

    await userClient.authenticate(phonePromise, codePromise, passwordPromise);
    clearAuthProgress();
    onUserLoggedIn();
    showPage('main');
  } catch (error) {
    setUserStatus('disconnected');
    userLog('error', `2FA login failed: ${error.message}`);
    setAuthInputsLocked(false);
    // Reset 2FA button
    const pwBtn = document.getElementById('btnUserSubmit2FA');
    if (pwBtn) { pwBtn.disabled = false; pwBtn.innerHTML = '🔒 Submit'; }
  }
}

async function handleUserLogin() {
  const apiId = document.getElementById('userApiId')?.value.trim();
  const apiHash = document.getElementById('userApiHash')?.value.trim();
  const phone = document.getElementById('userPhone')?.value.trim();
  if (!apiId || !apiHash || !phone) { userLog('error', 'Please fill all fields.'); return; }

  const btn = document.getElementById('btnUserLogin');
  btn.disabled = true; btn.innerHTML = '⏳ Connecting...';
  setUserStatus('connecting');

  // Lock inputs during processing
  setAuthInputsLocked(true);

  const accountIndex = _pendingAccountIndex !== null ? _pendingAccountIndex : getActiveAccountIndex();
  _pendingAccountIndex = null;

  try {
    userClient = new TGUserClient(userLog, updateUserProgress, accountIndex);
    await userClient.init(apiId, apiHash);

    const phonePromise = () => Promise.resolve(phone);
    const codePromise = () => new Promise((resolve) => {
      _resolveCode = resolve;
      setAuthInputsLocked(false); // Unlock for code entry
      document.getElementById('userAuthForm')?.classList.add('hidden');
      document.getElementById('userCodeForm')?.classList.remove('hidden');
      document.getElementById('userCode')?.focus();
      document.getElementById('btnUserSubmitCode')?.addEventListener('click', () => {
        const code = document.getElementById('userCode')?.value.trim();
        if (code && _resolveCode) {
          const codeBtn = document.getElementById('btnUserSubmitCode');
          if (codeBtn) { codeBtn.disabled = true; codeBtn.innerHTML = '⏳ Verifying...'; }
          _resolveCode(code); _resolveCode = null;
        }
      }, { once: true });
    });
    const passwordPromise = () => new Promise((resolve) => {
      _resolvePassword = resolve;
      // Save progress so refresh can resume from 2FA directly
      saveAuthProgress({ step: 'need_2fa', apiId, apiHash, phone, accountIndex });
      setAuthInputsLocked(false); // Unlock for 2FA entry
      document.getElementById('userCodeForm')?.classList.add('hidden');
      document.getElementById('user2FAForm')?.classList.remove('hidden');
      document.getElementById('user2FA')?.focus();
      document.getElementById('btnUserSubmit2FA')?.addEventListener('click', () => {
        const pw = document.getElementById('user2FA')?.value.trim();
        if (pw && _resolvePassword) {
          const pwBtn = document.getElementById('btnUserSubmit2FA');
          if (pwBtn) { pwBtn.disabled = true; pwBtn.innerHTML = '⏳ Authenticating...'; }
          setAuthInputsLocked(true);
          _resolvePassword(pw); _resolvePassword = null;
        }
      }, { once: true });
    });

    await userClient.authenticate(phonePromise, codePromise, passwordPromise);
    clearAuthProgress();
    onUserLoggedIn();
    // Re-render the full UI to update status bar and remove "no account" card
    if (window._userModeSwitchMode) {
      const app = document.getElementById('app');
      renderUserMode(app, window._userModeAddLog || userLog, window._userModeSwitchMode);
    }
  } catch (error) {
    setUserStatus('disconnected');
    userLog('error', `Login failed: ${error.message}`);
    btn.innerHTML = '🔑 Login';
    setAuthInputsLocked(false);
    // Don't clear auth progress on PASSWORD_HASH_INVALID — let them retry
    if (!error.message?.includes('PASSWORD_HASH_INVALID')) {
      clearAuthProgress();
    }
  } finally {
    btn.disabled = false;
  }
}

async function autoReconnectUser(addLog) {
  setUserStatus('connecting');
  userLog('info', '🔄 Reconnecting to Telegram...');
  // Update status bar text
  ['userLoggedInAs', 'userLoggedInAs2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '⏳ Reconnecting...';
  });
  try {
    userClient = new TGUserClient(userLog, updateUserProgress);
    const ok = await userClient.reconnect();
    if (ok) {
      userLog('success', '✅ Reconnected successfully!');
      onUserLoggedIn();
    } else {
      setUserStatus('disconnected');
      userLog('warn', '⚠️ Session expired. Auto-cleaning...');
      // Auto-clean expired session
      const tempClean = new TGUserClient(() => {}, () => {});
      tempClean.clearSession();
      userClient = null;
      const remainingAccounts = getAccounts();
      if (remainingAccounts.length > 0) {
        setActiveAccountIndex(remainingAccounts[0].idx);
      } else {
        localStorage.removeItem('tgcf_active_account');
      }
      // Re-render to show clean state
      if (window._userModeSwitchMode) {
        const app = document.getElementById('app');
        renderUserMode(app, window._userModeAddLog || userLog, window._userModeSwitchMode);
        return;
      }
    }
  } catch (e) {
    setUserStatus('disconnected');
    userLog('warn', `Reconnect failed: ${e.message}`);
  }
}

function onUserLoggedIn() {
  setUserStatus('connected');
  document.getElementById('userAuthForm')?.classList.add('hidden');
  document.getElementById('userCodeForm')?.classList.add('hidden');
  document.getElementById('user2FAForm')?.classList.add('hidden');
  document.getElementById('userLoggedInBar')?.classList.remove('hidden');

  const name = userClient.me ? `${userClient.me.firstName || ''} ${userClient.me.lastName || ''}`.trim() : '';
  const username = userClient.me?.username || 'N/A';
  ['userLoggedInAs', 'userLoggedInAs2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = `👤 ${name} (@${username})`;
  });

  // Show chats on main page
  document.getElementById('userChatsCard')?.classList.remove('hidden');
  // Update status bar
  const statusBar = document.getElementById('userStatusBar');
  if (statusBar) statusBar.classList.remove('hidden');

  loadDialogs().then(() => {
    const ui = getUIState();
    if (ui.filter && ui.filter !== 'all') {
      document.querySelectorAll('.chat-filter-btn').forEach(b => b.classList.remove('active'));
      const btn = document.querySelector(`.chat-filter-btn[data-filter="${ui.filter}"]`);
      if (btn) { btn.classList.add('active'); filterDialogsByType(ui.filter); }
    }
    if (ui.openChatId && dialogsCache.length) {
      const d = dialogsCache.find(d => d.id === ui.openChatId);
      if (d) openChat(d);
    }
  });

  // Listen for new messages
  userClient.startListening((msg) => {
    const peer = msg.message?.peerId;
    const possibleIds = [];
    if (peer?.channelId) { const c = peer.channelId.toString(); possibleIds.push(c, `-100${c}`, `-${c}`); }
    if (peer?.chatId) { const g = peer.chatId.toString(); possibleIds.push(g, `-${g}`, `-100${g}`); }
    if (peer?.userId) possibleIds.push(peer.userId.toString());
    if (msg.senderId) possibleIds.push(msg.senderId.toString());

    const matchedDialog = dialogsCache.find(d => possibleIds.includes(d.id));
    if (matchedDialog) {
      matchedDialog.lastMessage = msg.text || (msg.media ? '[Media]' : '');
      matchedDialog.date = msg.date || new Date();
      if (!currentDialogId || !possibleIds.includes(currentDialogId)) {
        matchedDialog.unreadCount = (matchedDialog.unreadCount || 0) + 1;
      }
      const activeFilter = document.querySelector('.chat-filter-btn.active')?.dataset?.filter || 'all';
      filterDialogsByType(activeFilter);
    }

    if (currentEntity && currentDialogId && possibleIds.includes(currentDialogId)) {
      appendUserMessage(msg);
      if (msg.id) userClient.markAsRead(currentEntity, msg.id).catch(() => {});
    }

    const settings = getUserSettings();
    if (settings.notifyNewMessages && !document.hasFocus()) {
      try {
        if (Notification.permission === 'granted') new Notification('New message', { body: msg.text || '[Media]' });
        else if (Notification.permission !== 'denied') Notification.requestPermission();
      } catch {}
    }
  });
}

async function handleUserLogout(addLog, switchMode) {
  if (userClient) {
    userLog('info', `Logging out...`);
    try { await userClient.logout(); } catch (e) {
      userClient.clearSession();
      try { await userClient.disconnect(); } catch {}
    }
    userClient = null;
    dialogsCache = []; currentEntity = null; currentDialogId = null; currentDialogTitle = null;
    thumbCache.clear(); rawMessageCache.clear();
    localStorage.removeItem(USER_UI_KEY);

    const remaining = getAccounts();
    if (remaining.length > 0) {
      setActiveAccountIndex(remaining[0].idx);
      const app = document.getElementById('app');
      renderUserMode(app, addLog || userLog, switchMode || (() => {}));
      return;
    }
    localStorage.removeItem('tgcf_active_account');
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
    const activeFilter = document.querySelector('.chat-filter-btn.active')?.dataset?.filter || 'all';
    filterDialogsByType(activeFilter);
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
    const icon = d.isSelf ? '🔖' : d.isBot ? '🤖' : d.isChannel ? '📢' : d.isGroup ? '👥' : '👤';
    const time = d.date ? d.date.toLocaleTimeString() : '';
    const preview = d.lastMessage.length > 80 ? d.lastMessage.slice(0, 80) + '...' : (d.lastMessage || '[No messages]');
    const hasUnread = d.unreadCount > 0;
    const unread = hasUnread ? `<span style="background: var(--primary); color: white; border-radius: 10px; padding: 1px 6px; font-size: 0.7rem; margin-left: 4px;">${d.unreadCount}</span>` : '';
    if (!hasUnread) item.style.opacity = '0.6';
    const meta = [d.username ? `@${d.username}` : '', d.tgId ? `ID:${d.tgId}` : ''].filter(Boolean).join(' • ');
    item.innerHTML = `
      <div class="msg-sender">
        <span style="font-size: 1.1rem;">${icon}</span>
        <span class="msg-sender-name" style="flex: 1;">${escHtml(d.title)}${unread}</span>
        <span class="msg-time">${time}</span>
      </div>
      ${meta ? `<div class="text-dim" style="font-size:0.72rem; margin-bottom:2px;">${escHtml(meta)}</div>` : ''}
      <div class="msg-text">${escHtml(preview)}</div>
    `;
    item.addEventListener('click', () => openChat(d));
    list.appendChild(item);
  }
  if (dialogs.length === 0) list.innerHTML = '<p class="text-dim">No chats found.</p>';
}

function filterDialogs(query) {
  if (!query) { renderDialogs(dialogsCache); return; }
  const q = query.toLowerCase();
  renderDialogs(dialogsCache.filter(d =>
    d.title.toLowerCase().includes(q) ||
    (d.username && d.username.toLowerCase().includes(q)) ||
    (d.tgId && d.tgId.includes(q))
  ));
}
function filterDialogsByType(type) {
  if (type === 'all') { renderDialogs(dialogsCache); return; }
  renderDialogs(dialogsCache.filter(d => {
    if (type === 'bot') return d.isBot;
    if (type === 'user') return d.isUser && !d.isBot;
    if (type === 'group') return d.isGroup;
    if (type === 'channel') return d.isChannel;
    return true;
  }));
}

// ===== Chat Viewer =====

async function openChat(dialog) {
  currentEntity = dialog.entity; currentDialogId = dialog.id; currentDialogTitle = dialog.title;
  userReplyToMsgId = null; oldestMsgId = 0; saveUIState();
  document.getElementById('userChatsCard')?.classList.add('hidden');
  document.getElementById('userMessagesCard')?.classList.remove('hidden');
  document.getElementById('chatTitle').textContent = dialog.title;
  document.getElementById('messageList').innerHTML = '<p class="text-dim">Loading messages...</p>';
  const canWrite = !dialog.isChannel || (dialog.entity?.adminRights || dialog.entity?.creator);
  const inputRow = document.querySelector('#userMessagesCard .reply-input-row');
  if (inputRow) inputRow.style.display = canWrite ? '' : 'none';
  if (canWrite) document.getElementById('userMsgInput')?.focus();

  try {
    const messages = await userClient.getMessages(currentEntity, 40);
    const list = document.getElementById('messageList');
    list.innerHTML = '';
    const msgMap = {};
    for (const msg of messages) {
      msgMap[msg.id] = msg.text || (msg.media ? '[Media]' : '');
      if (msg.message) rawMessageCache.set(msg.id, msg.message);
    }
    let maxId = 0;
    for (const msg of messages.reverse()) {
      if (msg.replyToMsgId && msgMap[msg.replyToMsgId]) msg.replyToText = msgMap[msg.replyToMsgId];
      appendUserMessage(msg);
      if (msg.id > maxId) maxId = msg.id;
    }
    if (messages.length > 0) oldestMsgId = messages[messages.length - 1].id;
    list.scrollTop = list.scrollHeight;
    list.addEventListener('scroll', handleScrollLoadOlder);
    if (maxId > 0) userClient.markAsRead(currentEntity, maxId).catch(() => {});
    const settings = getUserSettings();
    if (settings.autoDownloadPhotos) loadVisibleThumbnails();
  } catch (e) {
    userLog('error', `Failed to load messages: ${e.message}`);
    document.getElementById('messageList').innerHTML = '<p class="text-dim">Failed to load messages.</p>';
  }
}

async function handleScrollLoadOlder() {
  const list = document.getElementById('messageList');
  if (!list || !userClient || !currentEntity || isLoadingOlder || oldestMsgId <= 0) return;
  if (list.scrollTop > 50) return;
  isLoadingOlder = true;
  const prevHeight = list.scrollHeight;
  try {
    const older = await userClient.getMessages(currentEntity, 20, oldestMsgId);
    if (older.length === 0) { oldestMsgId = 0; isLoadingOlder = false; return; }
    for (const msg of older) {
      if (msg.message) rawMessageCache.set(msg.id, msg.message);
      prependUserMessage(msg);
      if (msg.id < oldestMsgId || oldestMsgId === 0) oldestMsgId = msg.id;
    }
    list.scrollTop = list.scrollHeight - prevHeight;
    const settings = getUserSettings();
    if (settings.autoDownloadPhotos) loadVisibleThumbnails();
  } catch {} finally { isLoadingOlder = false; }
}

function prependUserMessage(msg) { const list = document.getElementById('messageList'); if (list) list.prepend(createMessageElement(msg)); }

function appendUserMessage(msg) {
  const list = document.getElementById('messageList'); if (!list) return;
  const ph = list.querySelector(':scope > p.text-dim'); if (ph) ph.remove();
  if (msg.message) rawMessageCache.set(msg.id, msg.message);
  list.appendChild(createMessageElement(msg));
  list.scrollTop = list.scrollHeight;
}

function createMessageElement(msg) {
  const div = document.createElement('div');
  div.id = `msg_${msg.id}`;
  const time = smartDate(msg.date);
  const replyBar = renderReplyBar(msg);
  const mediaHtml = msg.media ? renderMediaContent(msg) : '';
  if (msg.out) {
    div.className = 'reply-sent';
    div.innerHTML = `${replyBar}${msg.text ? `<div class="reply-sent-text">${escHtml(msg.text)}</div>` : ''}${mediaHtml}<div class="reply-sent-time">${time}</div>`;
  } else {
    div.className = 'reply-received clickable-msg';
    div.innerHTML = `${replyBar}${mediaHtml}${msg.text ? `<div class="reply-received-text">${escHtml(msg.text)}</div>` : ''}<div class="reply-received-time">${time} • tap to reply ↩</div>`;
    div.addEventListener('click', (e) => {
      if (e.target.closest('.media-photo-container') || e.target.closest('.media-video-container') || e.target.closest('.media-file-container')) return;
      setUserReplyTo(msg.id, msg.text || '[Media]');
    });
  }
  return div;
}

// ===== Media =====

function renderMediaContent(msg) {
  const m = msg.media;
  if (m.type === 'photo') return renderPhotoMedia(msg);
  if (m.type === 'video' || m.type === 'video_note') return renderVideoMedia(msg);
  if (m.type === 'voice' || m.type === 'audio') return renderAudioMedia(msg);
  return renderFileMedia(msg);
}

function renderPhotoMedia(msg) {
  const m = msg.media; const size = m.fileSize ? formatFileSize(m.fileSize) : ''; const cached = thumbCache.get(msg.id);
  return `<div class="media-photo-container" data-msg-id="${msg.id}">${cached
    ? `<img src="${cached}" class="media-photo-thumb" alt="📷" onclick="window._openPhotoLightbox(${msg.id})" />`
    : `<div class="media-photo-placeholder" onclick="window._loadAndShowPhoto(${msg.id})"><span>📷</span><span class="media-photo-label">Photo ${size ? `(${size})` : ''}</span><span class="media-photo-load">Click to load</span></div>`}</div>`;
}

function renderVideoMedia(msg) {
  const m = msg.media; const size = m.fileSize ? formatFileSize(m.fileSize) : ''; const duration = m.duration ? formatDuration(m.duration) : '';
  const icon = m.isVideoNote ? '⏺️' : '🎬'; const label = m.isVideoNote ? 'Video Message' : (m.fileName || 'Video');
  return `<div class="media-video-container" data-msg-id="${msg.id}"><div class="media-video-badge"><div class="media-video-icon">${icon}</div><div class="media-video-info"><span class="media-video-name">${escHtml(label)}</span><span class="media-video-meta">${[duration, size].filter(Boolean).join(' • ')}</span></div></div><div class="media-video-actions"><button class="btn-primary btn-sm" onclick="window._downloadUserMedia(${msg.id})">📥 Download</button></div></div>`;
}

function renderAudioMedia(msg) {
  const m = msg.media; const size = m.fileSize ? formatFileSize(m.fileSize) : ''; const duration = m.duration ? formatDuration(m.duration) : '';
  const icon = m.isVoice ? '🎤' : '🎵'; const label = m.isVoice ? 'Voice Message' : (m.fileName || 'Audio');
  return `<div class="media-video-container" data-msg-id="${msg.id}"><div class="media-video-badge"><div class="media-video-icon">${icon}</div><div class="media-video-info"><span class="media-video-name">${escHtml(label)}</span><span class="media-video-meta">${[duration, size].filter(Boolean).join(' • ')}</span></div></div><div class="media-video-actions"><button class="btn-primary btn-sm" onclick="window._downloadUserMedia(${msg.id})">📥 Download</button></div></div>`;
}

function renderFileMedia(msg) {
  const m = msg.media; const icon = getFileIcon(m.mimeType, m.fileName);
  const size = m.fileSize ? formatFileSize(m.fileSize) : ''; const name = m.fileName || 'File';
  return `<div class="media-file-container" onclick="window._downloadUserMedia(${msg.id})"><span class="media-file-icon">${icon}</span><span class="media-file-name">${escHtml(name)} ${size ? `(${size})` : ''}</span><span class="media-file-dl">📥 Download</span></div>`;
}

function renderReplyBar(msg) {
  if (!msg.replyToMsgId) return '';
  const preview = msg.replyToText || `Message #${msg.replyToMsgId}`;
  const short = preview.length > 60 ? preview.substring(0, 60) + '...' : preview;
  return `<div class="reply-quote-bar" style="cursor:pointer; margin-bottom:4px;" onclick="document.getElementById('msg_${msg.replyToMsgId}')?.scrollIntoView({behavior:'smooth', block:'center'}); document.getElementById('msg_${msg.replyToMsgId}')?.classList.add('highlight-msg'); setTimeout(()=>document.getElementById('msg_${msg.replyToMsgId}')?.classList.remove('highlight-msg'),1500);"><span class="reply-quote-text">↩ ${escHtml(short)}</span></div>`;
}

// ===== Thumbnails & Media Globals =====

async function loadVisibleThumbnails() {
  if (!userClient || !userClient.connected) return;
  for (const container of document.querySelectorAll('.media-photo-container')) {
    const msgId = parseInt(container.dataset.msgId);
    if (thumbCache.has(msgId)) continue;
    const rawMsg = rawMessageCache.get(msgId);
    if (!rawMsg) continue;
    try {
      const thumbUrl = await userClient.getPhotoThumb(rawMsg);
      if (thumbUrl) {
        thumbCache.set(msgId, thumbUrl);
        const ph = container.querySelector('.media-photo-placeholder');
        if (ph) ph.outerHTML = `<img src="${thumbUrl}" class="media-photo-thumb" alt="📷" onclick="window._openPhotoLightbox(${msgId})" />`;
      }
    } catch {}
  }
}

window._loadAndShowPhoto = async (msgId) => {
  if (!userClient || !userClient.connected) return;
  const rawMsg = rawMessageCache.get(msgId); if (!rawMsg) return;
  const container = document.querySelector(`.media-photo-container[data-msg-id="${msgId}"]`); if (!container) return;
  const ph = container.querySelector('.media-photo-placeholder');
  if (ph) ph.innerHTML = '<span>⏳</span><span class="media-photo-label">Loading...</span>';
  try {
    const thumbUrl = await userClient.getPhotoThumb(rawMsg);
    if (thumbUrl) { thumbCache.set(msgId, thumbUrl); if (ph) ph.outerHTML = `<img src="${thumbUrl}" class="media-photo-thumb" alt="📷" onclick="window._openPhotoLightbox(${msgId})" />`; }
    else if (ph) ph.innerHTML = '<span>📷</span><span class="media-photo-label">Failed</span>';
  } catch { if (ph) ph.innerHTML = '<span>📷</span><span class="media-photo-label">Failed</span>'; }
};

window._openPhotoLightbox = async (msgId) => {
  const thumbUrl = thumbCache.get(msgId);
  const overlay = document.createElement('div'); overlay.className = 'photo-lightbox';
  overlay.innerHTML = `<img src="${thumbUrl || ''}" alt="Photo" id="lightboxImg_${msgId}" /><div class="lightbox-actions"><button class="lightbox-btn" id="lightboxDl_${msgId}">📥 Save</button><button class="lightbox-btn lightbox-close-btn">✕</button></div><div class="lightbox-loading hidden" id="lightboxLoading_${msgId}">Loading full size...</div>`;
  overlay.querySelector('.lightbox-close-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector(`#lightboxDl_${msgId}`).addEventListener('click', async (e) => {
    e.stopPropagation(); if (!userClient?.connected) return;
    const rawMsg = rawMessageCache.get(msgId); if (!rawMsg) return;
    document.getElementById('userProgressBox')?.classList.remove('hidden');
    try { await userClient.downloadAndSave(rawMsg, `photo_${msgId}.jpg`, 'image/jpeg'); } catch (err) { userLog('error', `Download failed: ${err.message}`); }
    setTimeout(() => document.getElementById('userProgressBox')?.classList.add('hidden'), 2000);
  });
  document.body.appendChild(overlay);
  if (userClient?.connected) {
    const rawMsg = rawMessageCache.get(msgId);
    if (rawMsg) {
      const ld = overlay.querySelector(`#lightboxLoading_${msgId}`); if (ld) ld.classList.remove('hidden');
      try { const fullUrl = await userClient.getFullPhoto(rawMsg); if (fullUrl) { const img = overlay.querySelector(`#lightboxImg_${msgId}`); if (img) img.src = fullUrl; } } catch {}
      if (ld) ld.classList.add('hidden');
    }
  }
};

window._playVideo = async (msgId, mimeType) => {
  if (!userClient?.connected) return;
  const rawMsg = rawMessageCache.get(msgId); if (!rawMsg) return;
  const pc = document.getElementById(`videoPlayer_${msgId}`); if (!pc) return;
  if (pc.querySelector('video, audio')) { pc.classList.toggle('hidden'); return; }
  // Enqueue a playback download
  enqueueDownload({ msgId, mode: 'play', mimeType, playerContainerId: `videoPlayer_${msgId}` });
};

window._downloadUserMedia = (msgId) => {
  if (!userClient?.connected || !currentEntity) return;
  enqueueDownload({ msgId, mode: 'save' });
};

// ===== Download Queue System =====

/**
 * Resolve raw message and file metadata for a given msgId.
 * Returns { rawMsg, fileName, mimeType, fileSize, icon } or null.
 */
async function resolveMediaInfo(msgId) {
  let rawMsg = rawMessageCache.get(msgId);
  if (!rawMsg) {
    const msgs = await userClient.getMessages(currentEntity, 1, msgId + 1);
    const m = msgs.find(m => m.id === msgId);
    if (!m?.message) return null;
    rawMsg = m.message;
    rawMessageCache.set(msgId, rawMsg);
  }
  const media = rawMsg.media;
  let fileName = `file_${msgId}`;
  let mimeType = 'application/octet-stream';
  let fileSize = 0;
  let icon = '📄';

  if (media?.document) {
    fileName = 'file';
    mimeType = media.document.mimeType || 'application/octet-stream';
    fileSize = Number(media.document.size || 0);
    for (const a of media.document.attributes || []) {
      if (a.className === 'DocumentAttributeFilename') fileName = a.fileName;
      if (a.className === 'DocumentAttributeVideo') icon = a.roundMessage ? '⏺️' : '🎬';
      if (a.className === 'DocumentAttributeAudio') icon = a.voice ? '🎤' : '🎵';
    }
    if (icon === '📄') icon = getFileIcon(mimeType, fileName);
  } else if (media?.photo) {
    fileName = `photo_${msgId}.jpg`;
    mimeType = 'image/jpeg';
    icon = '📷';
    const sizes = media.photo?.sizes || [];
    const largest = sizes[sizes.length - 1];
    fileSize = largest?.size ? Number(largest.size) : 0;
  }
  return { rawMsg, fileName, mimeType, fileSize, icon };
}

/**
 * Enqueue a download item.
 * @param {object} opts - { msgId, mode: 'save'|'play', mimeType?, playerContainerId? }
 */
function enqueueDownload(opts) {
  // Prevent duplicate: don't add same msgId if already queued or downloading
  const isDuplicate = _downloadQueue.some(i => i.msgId === opts.msgId && (i.status === 'queued' || i.status === 'downloading'));
  if (isDuplicate) {
    userLog('warn', `⚠️ #${opts.msgId} already in queue`);
    return;
  }

  const id = ++_queueIdCounter;
  const item = {
    id,
    msgId: opts.msgId,
    mode: opts.mode || 'save', // 'save' or 'play'
    mimeType: opts.mimeType || null,
    playerContainerId: opts.playerContainerId || null,
    status: 'queued', // queued | downloading | done | error | cancelled
    percent: 0,
    speed: 0,
    fileName: `#${opts.msgId}`,
    fileSize: 0,
    icon: '📄',
    error: null,
  };
  _downloadQueue.push(item);
  userLog('info', `📥 Queued download #${opts.msgId}`);
  renderQueueUI();
  processQueue(); // Kick off processing (no-op if already running)
}

/**
 * Remove a single item from the queue (cancel if active).
 */
function removeQueueItem(itemId) {
  const idx = _downloadQueue.findIndex(i => i.id === itemId);
  if (idx === -1) return;
  const item = _downloadQueue[idx];
  if (item.status === 'downloading') {
    // Cancel the active download
    item.status = 'cancelled';
    _activeDownloadId++;
    userLog('warn', `⚠️ Cancelled: ${item.fileName}`);
  }
  _downloadQueue.splice(idx, 1);
  renderQueueUI();
}

/**
 * Clear completed/error/cancelled items. Cancel active download.
 */
function clearDownloadQueue() {
  // Cancel active download if any
  if (_currentQueueItemId !== null) {
    _activeDownloadId++;
    const active = _downloadQueue.find(i => i.id === _currentQueueItemId);
    if (active) active.status = 'cancelled';
  }
  _downloadQueue.length = 0;
  _queueProcessing = false;
  _currentQueueItemId = null;
  renderQueueUI();
  userLog('info', '🗑️ Download queue cleared.');
}

/**
 * Process the queue one at a time.
 */
async function processQueue() {
  if (_queueProcessing) return;
  _queueProcessing = true;

  while (true) {
    const next = _downloadQueue.find(i => i.status === 'queued');
    if (!next) break;
    if (!userClient?.connected) {
      userLog('error', 'Not connected. Queue paused.');
      break;
    }

    next.status = 'downloading';
    _currentQueueItemId = next.id;
    _activeDownloadId++;
    const myDownloadId = _activeDownloadId;
    renderQueueUI();

    try {
      // Resolve media info
      const info = await resolveMediaInfo(next.msgId);
      if (!info) { next.status = 'error'; next.error = 'Not found'; renderQueueUI(); continue; }
      next.fileName = info.fileName;
      next.fileSize = info.fileSize;
      next.icon = info.icon;
      next.mimeType = next.mimeType || info.mimeType;
      renderQueueUI();

      if (next.mode === 'play') {
        await processPlayItem(next, info, myDownloadId);
      } else {
        await processSaveItem(next, info, myDownloadId);
      }

      // Check if cancelled mid-download
      if (next.status === 'cancelled') continue;
      next.status = 'done';
      next.percent = 100;
    } catch (e) {
      if (next.status !== 'cancelled') {
        next.status = 'error';
        next.error = e.message;
        userLog('error', `Download failed: ${e.message}`);
      }
    }
    _currentQueueItemId = null;
    renderQueueUI();
  }

  _queueProcessing = false;
  _currentQueueItemId = null;
}

/**
 * Process a 'save' download item using parallel connections.
 */
async function processSaveItem(item, info, myDownloadId) {
  const startTime = Date.now();

  const onProgress = (downloaded, total, speed, percent) => {
    if (_activeDownloadId !== myDownloadId) return;
    item.percent = percent;
    item.speed = speed;
    renderQueueItemProgress(item);
  };
  const isCancelled = () => _activeDownloadId !== myDownloadId;

  const buffer = await userClient.downloadParallel(info.rawMsg, onProgress, isCancelled, 4);

  if (_activeDownloadId !== myDownloadId) { item.status = 'cancelled'; return; }
  if (!buffer) throw new Error('Download returned empty.');

  const blob = new Blob([buffer], { type: info.mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = info.fileName || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  userLog('success', `💾 Saved: ${info.fileName} (${elapsed}s)`);
}

/**
 * Process a 'play' download item using parallel connections.
 */
async function processPlayItem(item, info, myDownloadId) {
  const pc = document.getElementById(item.playerContainerId);
  if (pc) { pc.classList.remove('hidden'); pc.innerHTML = '<div class="text-dim" style="padding:8px; font-size:0.82rem;">⏳ Downloading for playback...</div>'; }

  const mimeType = item.mimeType || info.mimeType || 'video/mp4';

  const onProgress = (downloaded, total, speed, percent) => {
    if (_activeDownloadId !== myDownloadId) return;
    item.percent = percent;
    item.speed = speed;
    renderQueueItemProgress(item);
  };
  const isCancelled = () => _activeDownloadId !== myDownloadId;

  const buffer = await userClient.downloadParallel(info.rawMsg, onProgress, isCancelled, 4);

  if (_activeDownloadId !== myDownloadId) { item.status = 'cancelled'; if (pc) pc.innerHTML = ''; return; }
  if (!buffer || buffer.length === 0) { if (pc) pc.innerHTML = '<div class="text-dim" style="padding:8px;">Failed.</div>'; throw new Error('Empty buffer'); }

  const blob = new Blob([buffer], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  const isAudio = mimeType.startsWith('audio/');
  if (pc) pc.innerHTML = isAudio
    ? `<audio controls autoplay style="width:100%; margin-top:4px;" src="${blobUrl}"></audio>`
    : `<video controls autoplay playsinline style="width:100%; max-height:300px; border-radius:8px; margin-top:4px;" src="${blobUrl}"></video>`;
}

/**
 * Render the full queue UI (show/hide card, render list items).
 */
function renderQueueUI() {
  const card = document.getElementById('downloadQueueCard');
  const listEl = document.getElementById('downloadQueueList');
  const countEl = document.getElementById('queueCount');
  if (!card || !listEl) return;

  if (_downloadQueue.length === 0) {
    card.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }

  card.classList.remove('hidden');
  const pending = _downloadQueue.filter(i => i.status === 'queued').length;
  const active = _downloadQueue.filter(i => i.status === 'downloading').length;
  if (countEl) countEl.textContent = `(${active ? '1 active' : ''}${active && pending ? ', ' : ''}${pending ? `${pending} queued` : ''}${!active && !pending ? `${_downloadQueue.length} done` : ''})`;

  listEl.innerHTML = _downloadQueue.map(item => {
    const statusIcon = item.status === 'downloading' ? '⏳' : item.status === 'done' ? '✅' : item.status === 'error' ? '❌' : item.status === 'cancelled' ? '🚫' : '⏸️';
    const statusClass = item.status === 'downloading' ? 'active' : item.status === 'done' ? 'done' : item.status === 'error' ? 'error' : item.status === 'cancelled' ? 'cancelled' : 'queued';
    const sizeStr = item.fileSize ? formatFileSize(item.fileSize) : '';
    const speedStr = item.status === 'downloading' && item.speed > 0 ? `${formatFileSize(item.speed)}/s` : '';
    const modeLabel = item.mode === 'play' ? '▶' : '📥';
    const showProgress = item.status === 'downloading';
    const showRemove = item.status !== 'done';

    return `<div class="queue-item queue-item-${statusClass}" data-queue-id="${item.id}">
      <div class="queue-item-header">
        <span class="queue-item-icon">${item.icon}</span>
        <div class="queue-item-info">
          <span class="queue-item-name">${escHtml(item.fileName)} <span class="queue-item-mode">${modeLabel}</span></span>
          <span class="queue-item-meta">${[sizeStr, speedStr].filter(Boolean).join(' • ')} ${statusIcon} ${item.status}${item.error ? ': ' + escHtml(item.error) : ''}</span>
        </div>
        ${showRemove ? `<button class="btn-outline btn-sm queue-item-remove" onclick="window._removeQueueItem(${item.id})" style="padding:2px 8px; font-size:0.72rem; width:auto;">✕</button>` : ''}
      </div>
      ${showProgress ? `<div class="queue-item-progress"><div class="progress-bar-bg" style="height:4px;"><div class="progress-bar-fill" id="queueBar_${item.id}" style="width:${item.percent.toFixed(1)}%;"></div></div></div>` : ''}
    </div>`;
  }).join('');
}

/**
 * Update only the progress bar and meta for an active item (fast path, no full re-render).
 */
function renderQueueItemProgress(item) {
  const bar = document.getElementById(`queueBar_${item.id}`);
  if (bar) bar.style.width = `${item.percent.toFixed(1)}%`;
  // Update meta text
  const el = document.querySelector(`.queue-item[data-queue-id="${item.id}"] .queue-item-meta`);
  if (el) {
    const sizeStr = item.fileSize ? formatFileSize(item.fileSize) : '';
    const speedStr = item.speed > 0 ? `${formatFileSize(item.speed)}/s` : '';
    el.textContent = `${[sizeStr, speedStr].filter(Boolean).join(' • ')} ⏳ downloading ${item.percent.toFixed(0)}%`;
  }
  // Also mirror to the old progress box for backward compat
  updateUserProgress({ percent: item.percent, speed: item.speed });
}

/** Cancel current download by incrementing the download ID */
function cancelUserDownload() {
  if (_currentQueueItemId !== null) {
    removeQueueItem(_currentQueueItemId);
  } else {
    _activeDownloadId++;
  }
  document.getElementById('userProgressBox')?.classList.add('hidden');
  const bar = document.getElementById('userProgressBar');
  if (bar) bar.style.width = '0%';
}

// Bind cancel button
document.getElementById('btnCancelDownload')?.addEventListener('click', cancelUserDownload);

// Global remove handler for queue items
window._removeQueueItem = (itemId) => removeQueueItem(itemId);

// ===== Reply & Send =====

function setUserReplyTo(msgId, preview) {
  userReplyToMsgId = msgId;
  const input = document.getElementById('userMsgInput');
  if (input) { input.placeholder = `↩ Reply to: ${(preview || '').substring(0, 50)}...`; input.focus(); }
}
window._clearUserReply = () => { userReplyToMsgId = null; const input = document.getElementById('userMsgInput'); if (input) input.placeholder = 'Type a message...'; };

async function handleUserSendMessage() {
  if (!userClient?.connected || !currentEntity) return;
  const input = document.getElementById('userMsgInput'); const text = input?.value?.trim(); if (!text) return;
  try {
    await userClient.sendMessage(currentEntity, text, userReplyToMsgId || undefined);
    appendUserMessage({ id: Date.now(), text, date: new Date(), out: true, media: null, replyToMsgId: userReplyToMsgId || null });
    const msgList = document.getElementById('messageList');
    if (msgList) setTimeout(() => { msgList.scrollTop = msgList.scrollHeight; }, 50);
    input.value = ''; input.placeholder = 'Type a message...'; userReplyToMsgId = null; input.focus();
  } catch (e) { userLog('error', `Send failed: ${e.message}`); }
}

// ===== User Settings =====

function loadUserSettingsUI() {
  const s = getUserSettings();
  const proxy = getProxySettings(); // Shared proxy
  const el = (id) => document.getElementById(id);
  if (el('userSettingsStealth')) el('userSettingsStealth').checked = !!s.stealthMode;
  if (el('userSettingsAutoPhotos')) el('userSettingsAutoPhotos').checked = s.autoDownloadPhotos !== false;
  if (el('userSettingsNotify')) el('userSettingsNotify').checked = s.notifyNewMessages !== false;
  if (el('userSettingsEnterSend')) el('userSettingsEnterSend').checked = s.sendWithEnter !== false;
  if (el('userSettingsProxy')) el('userSettingsProxy').checked = !!proxy.proxyEnabled;
  if (el('userSettingsProxyDomain')) el('userSettingsProxyDomain').value = proxy.proxyDomain || '';
  if (el('userSettingsFontSize')) el('userSettingsFontSize').value = s.fontSize || 'normal';
}

function handleSaveUserSettings() {
  const s = getUserSettings();
  s.stealthMode = !!document.getElementById('userSettingsStealth')?.checked;
  s.autoDownloadPhotos = !!document.getElementById('userSettingsAutoPhotos')?.checked;
  s.notifyNewMessages = !!document.getElementById('userSettingsNotify')?.checked;
  s.sendWithEnter = !!document.getElementById('userSettingsEnterSend')?.checked;
  s.fontSize = document.getElementById('userSettingsFontSize')?.value || 'normal';
  saveUserSettings(s);

  // Save shared proxy settings (syncs to both modes)
  const proxyEnabled = !!document.getElementById('userSettingsProxy')?.checked;
  let pd = (document.getElementById('userSettingsProxyDomain')?.value || '').trim().replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/+$/, '');
  saveProxySettings({ proxyEnabled, proxyDomain: pd });

  const status = document.getElementById('userSettingsSaveStatus');
  if (status) { status.textContent = '✅ Saved!'; setTimeout(() => { status.textContent = ''; }, 2000); }
  userLog('info', `⚙️ Settings saved. Proxy: ${proxyEnabled ? 'ON' : 'OFF'}`);
}

function handleResetUserSettings() {
  saveUserSettings(getUserDefaults()); loadUserSettingsUI();
  const status = document.getElementById('userSettingsSaveStatus');
  if (status) { status.textContent = '🔄 Reset'; setTimeout(() => { status.textContent = ''; }, 2000); }
}

// ===== Helpers =====

function updateUserProgress(progress) {
  const bar = document.getElementById('userProgressBar');
  const pct = document.getElementById('userProgressPercent');
  const spd = document.getElementById('userProgressSpeed');
  if (bar) bar.style.width = `${progress.percent.toFixed(1)}%`;
  if (pct) pct.textContent = `${progress.percent.toFixed(1)}%`;
  if (spd) spd.textContent = `${formatFileSize(progress.speed)}/s`;
}

function smartDate(date) {
  if (!date) return '';
  const now = new Date(); const d = date instanceof Date ? date : new Date(date);
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * Lock/unlock auth inputs during processing to prevent edits.
 */
function setAuthInputsLocked(locked) {
  ['userApiId', 'userApiHash', 'userPhone', 'userCode', 'user2FA'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.readOnly = locked; el.style.opacity = locked ? '0.5' : '1'; }
  });
  ['btnUserSubmitCode', 'btnUserSubmit2FA'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });
}

function formatDuration(seconds) { if (!seconds) return ''; const m = Math.floor(seconds / 60); const s = Math.floor(seconds % 60); return `${m}:${s.toString().padStart(2, '0')}`; }
function escHtml(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML.replace(/\n/g, '<br>'); }
function escAttr(str) { return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }
