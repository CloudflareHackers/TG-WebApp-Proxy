/**
 * Telegram File Downloader - Client-Side MTProto
 * Two-step flow: Fetch file info (cached) → Download with parallel connections
 */

import './polyfills.js';
import './style.css';
import { TGDownloader } from './telegram-client.js';
import { parseTelegramLink, describeParsedLink, formatFileSize, getFileIcon } from './link-parser.js';

// ===== State =====
let downloader = null;
let isConnected = false;
let isDownloading = false;
let currentFileRef = null; // Cached file reference

// ===== Initialize UI =====
function init() {
  const app = document.getElementById('app');
  app.innerHTML = renderApp();
  bindEvents();
  
  const tempDownloader = new TGDownloader(() => {}, () => {});
  const saved = tempDownloader.getSavedCredentials();
  if (saved) {
    document.getElementById('apiId').value = saved.apiId || '';
    document.getElementById('apiHash').value = saved.apiHash || '';
    document.getElementById('botToken').value = saved.botToken || '';
  }
  
  addLog('dim', 'Ready. Enter your credentials and connect.');
  addLog('dim', 'All processing happens in your browser. Nothing is sent to any server.');
  
  if (saved && saved.apiId && saved.apiHash && saved.botToken) {
    addLog('info', 'Found saved session. Auto-reconnecting...');
    autoReconnect(saved);
  }
}

function renderApp() {
  return `
    <div class="header">
      <h1>📥 Telegram File Downloader</h1>
      <p>Client-side MTProto • No file size limits • Parallel downloads • Powered by GramJS</p>
    </div>

    <!-- Connection Card -->
    <div class="card" id="connectionCard">
      <div class="flex-between mb-8">
        <h2><span class="icon">🔌</span> Connection</h2>
        <span class="status-badge disconnected" id="statusBadge">
          <span class="status-dot"></span>
          <span id="statusText">Disconnected</span>
        </span>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="apiId">API ID</label>
          <input type="text" id="apiId" placeholder="12345678" autocomplete="off" />
        </div>
        <div class="form-group">
          <label for="apiHash">API Hash</label>
          <input type="password" id="apiHash" placeholder="abc123def456..." autocomplete="off" />
        </div>
      </div>

      <div class="form-group">
        <label for="botToken">Bot Token</label>
        <input type="password" id="botToken" placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz" autocomplete="off" />
      </div>

      <p class="hint">
        Get API ID & Hash from <a href="https://my.telegram.org" target="_blank" style="color: var(--primary)">my.telegram.org</a> → 
        API Development Tools. Bot token from <a href="https://t.me/BotFather" target="_blank" style="color: var(--primary)">@BotFather</a>.
      </p>

      <div class="mt-16" style="display: flex; gap: 8px;">
        <button class="btn-primary" id="btnConnect" style="flex: 1;">⚡ Connect</button>
        <button class="btn-outline btn-sm" id="btnClearSession" title="Clear saved session">🗑️</button>
      </div>
    </div>

    <!-- Download Card -->
    <div class="card" id="downloadCard">
      <h2><span class="icon">📥</span> Download File</h2>

      <div class="form-group">
        <label for="messageLink">Telegram Message Link</label>
        <input type="text" id="messageLink" placeholder="https://t.me/c/2113604672/730 or https://t.me/channel/123" />
      </div>

      <div id="parsedLinkInfo" class="hidden">
        <p class="text-dim" id="parsedLinkText"></p>
      </div>

      <!-- Step 1: Fetch Info -->
      <button class="btn-primary mt-12" id="btnFetchInfo" disabled>
        🔍 Fetch File Info
      </button>

      <!-- File Info (shown after fetch) -->
      <div id="fileInfoBox" class="hidden">
        <dl class="file-info" id="fileInfoContent"></dl>
        
        <!-- Step 2: Download with parallel connections -->
        <div class="mt-16" style="display: flex; gap: 8px; align-items: center;">
          <div class="form-group" style="margin-bottom: 0; flex: 0 0 auto;">
            <label for="connections" style="margin-bottom: 4px;">Connections</label>
            <select id="connections" style="background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; color: var(--text); font-size: 0.95rem; font-family: inherit;">
              <option value="1">1 (Standard)</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4" selected>4</option>
              <option value="6">6</option>
              <option value="8">8 (Max)</option>
            </select>
          </div>
          <button class="btn-success" id="btnDownload" style="flex: 1; margin-top: 18px;">
            📥 Download
          </button>
        </div>
      </div>

      <!-- Progress -->
      <div id="progressBox" class="hidden">
        <div class="progress-container">
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" id="progressBar"></div>
          </div>
          <div class="progress-info">
            <span id="progressPercent">0%</span>
            <span id="progressSpeed">--</span>
            <span id="progressEta">--</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Log Card -->
    <div class="card">
      <div class="flex-between mb-8">
        <h2><span class="icon">📋</span> Log</h2>
        <button class="btn-outline btn-sm" id="btnClearLog">Clear</button>
      </div>
      <div class="log-container" id="logContainer"></div>
    </div>

    <!-- Incoming Files (live from bot) -->
    <div class="card" id="incomingCard">
      <div class="flex-between mb-8">
        <h2><span class="icon">📨</span> Incoming Files</h2>
        <span class="text-dim" id="listeningStatus">Not listening</span>
      </div>
      <p class="hint mb-8">Send files to your bot — they appear here automatically for download.</p>
      <div id="incomingList">
        <p class="text-dim">No incoming files yet. Send a file to the bot to see it here.</p>
      </div>
    </div>

    <!-- Download History -->
    <div class="card" id="historyCard">
      <h2><span class="icon">📜</span> Download History</h2>
      <div id="historyList">
        <p class="text-dim">No downloads yet.</p>
      </div>
    </div>

    <p style="text-align: center; margin-top: 24px; font-size: 0.75rem; color: var(--text-dim);">
      🔒 Everything runs in your browser. Credentials never leave your device.<br/>
      Built with <a href="https://gram.js.org" target="_blank" style="color: var(--primary)">GramJS</a> • 
      Deployed on <a href="https://pages.cloudflare.com" target="_blank" style="color: var(--primary)">Cloudflare Pages</a>
    </p>
  `;
}

// ===== Event Bindings =====
function bindEvents() {
  document.getElementById('btnConnect').addEventListener('click', handleConnect);
  document.getElementById('btnFetchInfo').addEventListener('click', handleFetchInfo);
  document.getElementById('btnDownload').addEventListener('click', handleDownload);
  document.getElementById('btnClearLog').addEventListener('click', () => {
    document.getElementById('logContainer').innerHTML = '';
  });
  document.getElementById('btnClearSession').addEventListener('click', handleClearSession);
  
  document.getElementById('messageLink').addEventListener('input', (e) => {
    const parsed = parseTelegramLink(e.target.value);
    const infoEl = document.getElementById('parsedLinkInfo');
    const textEl = document.getElementById('parsedLinkText');
    
    // Reset file info and progress when link changes
    currentFileRef = null;
    document.getElementById('fileInfoBox').classList.add('hidden');
    document.getElementById('progressBox').classList.add('hidden');
    resetProgress();
    
    if (parsed) {
      infoEl.classList.remove('hidden');
      textEl.textContent = '✅ ' + describeParsedLink(parsed);
      document.getElementById('btnFetchInfo').disabled = !isConnected;
    } else if (e.target.value.trim()) {
      infoEl.classList.remove('hidden');
      textEl.textContent = '❌ Invalid Telegram link';
      document.getElementById('btnFetchInfo').disabled = true;
    } else {
      infoEl.classList.add('hidden');
      document.getElementById('btnFetchInfo').disabled = true;
    }
  });
}

// ===== Auto Reconnect =====
async function autoReconnect(saved) {
  const btn = document.getElementById('btnConnect');
  btn.disabled = true;
  btn.innerHTML = '⏳ Reconnecting...';
  setConnectionStatus('connecting');

  try {
    downloader = new TGDownloader(addLog, updateProgress);
    await downloader.connect(saved.apiId, saved.apiHash, saved.botToken);
    isConnected = true;
    setConnectionStatus('connected');
    btn.innerHTML = '🔌 Disconnect';
    btn.className = 'btn-danger';
    startFileListener();
    const link = document.getElementById('messageLink').value.trim();
    if (parseTelegramLink(link)) {
      document.getElementById('btnFetchInfo').disabled = false;
    }
  } catch (error) {
    setConnectionStatus('disconnected');
    btn.innerHTML = '⚡ Connect';
    addLog('warn', `Auto-reconnect failed. Click Connect to try manually.`);
  } finally {
    btn.disabled = false;
  }
}

// ===== Connection Handler =====
async function handleConnect() {
  const btn = document.getElementById('btnConnect');
  
  if (isConnected && downloader) {
    await downloader.disconnect();
    setConnectionStatus('disconnected');
    isConnected = false;
    btn.innerHTML = '⚡ Connect';
    btn.className = 'btn-primary';
    document.getElementById('btnFetchInfo').disabled = true;
    return;
  }

  const apiId = document.getElementById('apiId').value.trim();
  const apiHash = document.getElementById('apiHash').value.trim();
  const botToken = document.getElementById('botToken').value.trim();

  if (!apiId || !apiHash || !botToken) {
    addLog('error', 'Please fill in all credentials.');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '⏳ Connecting...';
  setConnectionStatus('connecting');

  try {
    downloader = new TGDownloader(addLog, updateProgress);
    await downloader.connect(apiId, apiHash, botToken);
    isConnected = true;
    setConnectionStatus('connected');
    btn.innerHTML = '🔌 Disconnect';
    btn.className = 'btn-danger';
    startFileListener();
    const link = document.getElementById('messageLink').value.trim();
    if (parseTelegramLink(link)) {
      document.getElementById('btnFetchInfo').disabled = false;
    }
  } catch (error) {
    setConnectionStatus('disconnected');
    btn.innerHTML = '⚡ Connect';
    addLog('error', `Failed: ${error.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ===== Step 1: Fetch File Info =====
async function handleFetchInfo() {
  if (!isConnected || !downloader) return;

  const linkInput = document.getElementById('messageLink').value.trim();
  const parsed = parseTelegramLink(linkInput);
  if (!parsed) { addLog('error', 'Invalid Telegram link.'); return; }

  const btn = document.getElementById('btnFetchInfo');
  btn.disabled = true;
  btn.innerHTML = '⏳ Fetching...';

  try {
    let chatId;
    if (parsed.type === 'public') {
      chatId = parsed.username;
    } else {
      chatId = parsed.fullChannelId.toString();
    }

    addLog('info', `Resolving: ${describeParsedLink(parsed)}`);
    
    // Fetch file info (cached by link)
    currentFileRef = await downloader.fetchFileInfo(chatId, parsed.messageId, linkInput);

    // Show file info + download button
    showFileInfo(currentFileRef);

    btn.innerHTML = '✅ File info loaded';
    setTimeout(() => { btn.innerHTML = '🔍 Fetch File Info'; }, 2000);
  } catch (error) {
    addLog('error', `Fetch failed: ${error.message}`);
    btn.innerHTML = '🔍 Fetch File Info';
    currentFileRef = null;
  } finally {
    btn.disabled = false;
  }
}

// ===== Step 2: Download =====
async function handleDownload() {
  if (!isConnected || !downloader || isDownloading || !currentFileRef) return;

  const connections = parseInt(document.getElementById('connections').value) || 4;
  const btn = document.getElementById('btnDownload');
  const progressBox = document.getElementById('progressBox');
  
  btn.disabled = true;
  btn.innerHTML = '⏳ Downloading...';
  isDownloading = true;
  progressBox.classList.remove('hidden');
  resetProgress();

  try {
    // Download using cached fileRef — no re-fetch needed!
    const { blob, fileInfo } = await downloader.downloadFile(currentFileRef, connections);

    // Save to device
    downloader.saveBlobAs(blob, fileInfo.fileName);
    addToHistory(fileInfo);

    btn.innerHTML = '✅ Done!';
    // Hide progress after a brief moment to show 100%
    setTimeout(() => {
      btn.innerHTML = '📥 Download';
      progressBox.classList.add('hidden');
      resetProgress();
    }, 3000);
  } catch (error) {
    addLog('error', `Download failed: ${error.message}`);
    btn.innerHTML = '📥 Download';
    progressBox.classList.add('hidden');
    resetProgress();
  } finally {
    btn.disabled = false;
    isDownloading = false;
  }
}

// ===== Incoming File Listener =====
let listenerStarted = false;

function startFileListener() {
  if (listenerStarted || !downloader || !isConnected) return;
  listenerStarted = true;

  const statusEl = document.getElementById('listeningStatus');
  if (statusEl) statusEl.textContent = '🟢 Listening';

  downloader.startListening((fileRef) => {
    addIncomingFile(fileRef);
  });
}

let incomingCounter = 0;

function addIncomingFile(fileRef) {
  const list = document.getElementById('incomingList');
  if (!list) return;

  // Clear placeholder
  if (list.querySelector('.text-dim')) list.innerHTML = '';

  const id = `incoming_${incomingCounter++}`;
  const icon = getFileIcon(fileRef.mimeType, fileRef.fileName);
  const time = fileRef.date ? fileRef.date.toLocaleTimeString() : new Date().toLocaleTimeString();

  const item = document.createElement('div');
  item.className = 'history-item';
  item.id = id;
  item.innerHTML = `
    <span class="file-icon">${icon}</span>
    <div class="file-details" style="flex: 1; min-width: 0;">
      <div class="file-name">${fileRef.fileName}</div>
      <div class="file-meta">${formatFileSize(fileRef.fileSize)} • ${fileRef.mimeType || 'Unknown'} • ${fileRef.chatName || ''} • ${time}</div>
    </div>
    <button class="btn-success btn-sm" data-incoming-id="${id}" style="flex-shrink: 0;">
      📥 Download
    </button>
  `;

  // Store fileRef on the element for retrieval
  item._fileRef = fileRef;

  // Bind download button
  item.querySelector('button').addEventListener('click', () => handleIncomingDownload(item, fileRef));

  list.prepend(item);
}

async function handleIncomingDownload(itemEl, fileRef) {
  if (!isConnected || !downloader || isDownloading) {
    addLog('warn', 'Cannot download: busy or disconnected.');
    return;
  }

  const btn = itemEl.querySelector('button');
  const connections = parseInt(document.getElementById('connections')?.value) || 4;

  btn.disabled = true;
  btn.innerHTML = '⏳ ...';
  isDownloading = true;

  // Show progress
  const progressBox = document.getElementById('progressBox');
  progressBox.classList.remove('hidden');
  resetProgress();

  try {
    const { blob, fileInfo } = await downloader.downloadFile(fileRef, connections);
    downloader.saveBlobAs(blob, fileInfo.fileName);
    addToHistory(fileInfo);

    btn.innerHTML = '✅ Done';
    btn.className = 'btn-outline btn-sm';
    setTimeout(() => {
      progressBox.classList.add('hidden');
      resetProgress();
    }, 2000);
  } catch (error) {
    addLog('error', `Download failed: ${error.message}`);
    btn.innerHTML = '📥 Retry';
    btn.disabled = false;
    progressBox.classList.add('hidden');
    resetProgress();
  } finally {
    isDownloading = false;
  }
}

// ===== Clear Session =====
function handleClearSession() {
  const temp = new TGDownloader(() => {}, () => {});
  temp.clearSession();
  document.getElementById('apiId').value = '';
  document.getElementById('apiHash').value = '';
  document.getElementById('botToken').value = '';
  currentFileRef = null;
  addLog('info', 'Session and credentials cleared.');
}

// ===== UI Helpers =====
function setConnectionStatus(status) {
  const badge = document.getElementById('statusBadge');
  const text = document.getElementById('statusText');
  badge.className = `status-badge ${status}`;
  text.textContent = status.charAt(0).toUpperCase() + status.slice(1);
}

function addLog(type, message) {
  const container = document.getElementById('logContainer');
  if (!container) return;
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${time}] ${message}`;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

function updateProgress(progress) {
  const bar = document.getElementById('progressBar');
  const percent = document.getElementById('progressPercent');
  const speed = document.getElementById('progressSpeed');
  const eta = document.getElementById('progressEta');
  if (!bar) return;
  
  bar.style.width = `${progress.percent.toFixed(1)}%`;
  percent.textContent = `${progress.percent.toFixed(1)}%`;
  speed.textContent = `${formatFileSize(progress.speed)}/s`;
  
  if (progress.remaining > 0 && progress.remaining < 86400) {
    const mins = Math.floor(progress.remaining / 60);
    const secs = Math.floor(progress.remaining % 60);
    eta.textContent = mins > 0 ? `${mins}m ${secs}s left` : `${secs}s left`;
  } else {
    eta.textContent = 'Calculating...';
  }
}

function resetProgress() {
  const bar = document.getElementById('progressBar');
  if (bar) bar.style.width = '0%';
  document.getElementById('progressPercent').textContent = '0%';
  document.getElementById('progressSpeed').textContent = '--';
  document.getElementById('progressEta').textContent = '--';
}

function showFileInfo(fileRef) {
  const box = document.getElementById('fileInfoBox');
  const content = document.getElementById('fileInfoContent');
  
  content.innerHTML = `
    <dt>📄 File</dt><dd>${fileRef.fileName}</dd>
    <dt>📊 Size</dt><dd>${formatFileSize(fileRef.fileSize)}</dd>
    <dt>📎 Type</dt><dd>${fileRef.mimeType || 'Unknown'}</dd>
    <dt>🏢 DC</dt><dd>DC ${fileRef.dcId || '?'}</dd>
  `;
  
  box.classList.remove('hidden');
}

function addToHistory(fileInfo) {
  const list = document.getElementById('historyList');
  const icon = getFileIcon(fileInfo.mimeType, fileInfo.fileName);
  
  if (list.querySelector('.text-dim')) list.innerHTML = '';
  
  const item = document.createElement('div');
  item.className = 'history-item';
  item.innerHTML = `
    <span class="file-icon">${icon}</span>
    <div class="file-details">
      <div class="file-name">${fileInfo.fileName}</div>
      <div class="file-meta">${formatFileSize(fileInfo.fileSize)} • ${fileInfo.mimeType || 'Unknown'} • ${new Date().toLocaleTimeString()}</div>
    </div>
  `;
  list.prepend(item);
}

// ===== Boot =====
document.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', () => {
  if (downloader && isConnected) downloader.disconnect().catch(() => {});
});
