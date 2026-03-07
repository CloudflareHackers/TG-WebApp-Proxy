/**
 * Telegram User Client wrapper using GramJS.
 * Authenticates as a user (not bot) using phone number + code + optional 2FA.
 * Provides chat list, message history, media download, and message sending.
 * 
 * Multi-account support: each account uses a different GramJS session name
 * (tg_user_0, tg_user_1, ... tg_user_9). Up to 10 accounts.
 */

import { TelegramClient, Api } from 'telegram';
import { NewMessage } from 'telegram/events';
import bigInt from 'big-integer';
import { getUserSettings } from './settings.js';

const MIN_PARALLEL_SIZE = 1024 * 1024; // 1MB — below this, single-connection is fine
const DEFAULT_CHUNK_SIZE = 524288; // 512KB — MTProto standard max
const MAX_CONNECTIONS = 8;

// ===== Multi-Account Storage =====
const ACCOUNTS_KEY = 'tgcf_accounts';
const ACTIVE_ACCOUNT_KEY = 'tgcf_active_account';
const MAX_ACCOUNTS = 10;

/**
 * Get stored account list.
 * @returns {Array<{idx: number, phone: string, name: string, username: string, apiId: string, apiHash: string}>}
 */
export function getAccounts() {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

/**
 * Save account list.
 */
export function saveAccounts(accounts) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

/**
 * Add or update an account in the list.
 */
export function upsertAccount(account) {
  const accounts = getAccounts();
  const existing = accounts.findIndex(a => a.idx === account.idx);
  if (existing >= 0) {
    accounts[existing] = { ...accounts[existing], ...account };
  } else {
    accounts.push(account);
  }
  saveAccounts(accounts);
  return accounts;
}

/**
 * Remove an account from the list.
 */
export function removeAccount(idx) {
  const accounts = getAccounts().filter(a => a.idx !== idx);
  saveAccounts(accounts);
  return accounts;
}

/**
 * Get the next available session index (0-9).
 */
export function getNextSessionIndex() {
  const accounts = getAccounts();
  const usedIndices = new Set(accounts.map(a => a.idx));
  for (let i = 0; i < MAX_ACCOUNTS; i++) {
    if (!usedIndices.has(i)) return i;
  }
  return -1; // All slots full
}

/**
 * Get the active account index.
 */
export function getActiveAccountIndex() {
  try {
    const val = localStorage.getItem(ACTIVE_ACCOUNT_KEY);
    return val !== null ? parseInt(val) : 0;
  } catch { return 0; }
}

/**
 * Set the active account index.
 */
export function setActiveAccountIndex(idx) {
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, idx.toString());
}

/**
 * Get session name for a given account index.
 */
function getSessionName(idx) {
  return `tg_user_${idx}`;
}

/**
 * Get creds key for a given account index.
 */
function getCredsKey(idx) {
  return `tg_user_creds_${idx}`;
}


export class TGUserClient {
  /**
   * @param {Function} onLog
   * @param {Function} onProgress
   * @param {number} accountIndex - session index (0-9), defaults to active account
   */
  constructor(onLog, onProgress, accountIndex) {
    this.client = null;
    this.onLog = onLog || (() => {});
    this.onProgress = onProgress || (() => {});
    this.connected = false;
    this.me = null;
    this.accountIndex = accountIndex !== undefined ? accountIndex : getActiveAccountIndex();
    this._sessionName = getSessionName(this.accountIndex);
    this._credsKey = getCredsKey(this.accountIndex);
  }

  // ===== CONNECTION =====

  /**
   * Initialize the client (doesn't connect yet).
   * Must call start() after this.
   */
  async init(apiId, apiHash) {
    this.onLog('info', `Initializing user MTProto client (account #${this.accountIndex})...`);
    this._apiId = apiId;
    this._apiHash = apiHash;
    this.client = new TelegramClient(this._sessionName, parseInt(apiId), apiHash, {
      connectionRetries: 10,
      retryDelay: 2000,
      autoReconnect: true,
      useWSS: true,
    });
    await this.client.connect();
    this.onLog('dim', 'Client connected, awaiting authentication...');
  }

  /**
   * Authenticate as user.
   * @param {Function} getPhoneNumber - async () => string
   * @param {Function} getPhoneCode - async () => string
   * @param {Function} getPassword - async () => string (for 2FA)
   */
  async authenticate(getPhoneNumber, getPhoneCode, getPassword) {
    if (!this.client) throw new Error('Client not initialized. Call init() first.');

    await this.client.start({
      phoneNumber: getPhoneNumber,
      phoneCode: getPhoneCode,
      password: getPassword,
      onError: (err) => {
        this.onLog('error', `Auth error: ${err.message}`);
      },
    });

    // Save credentials for reconnection
    localStorage.setItem(this._credsKey, JSON.stringify({
      apiId: this._apiId,
      apiHash: this._apiHash,
    }));

    this.connected = true;
    this.me = await this.client.getMe();

    // Update account list
    const phone = this.me.phone || '';
    const name = [this.me.firstName || '', this.me.lastName || ''].filter(Boolean).join(' ') || 'Unknown';
    const username = this.me.username || '';
    upsertAccount({
      idx: this.accountIndex,
      phone: phone ? `+${phone}` : '',
      name,
      username,
      apiId: this._apiId,
      apiHash: this._apiHash,
    });
    setActiveAccountIndex(this.accountIndex);

    this.onLog('success', `✅ Logged in as ${name} (@${username || 'N/A'})`);
    return this.me;
  }

  /**
   * Reconnect using saved session.
   */
  async reconnect() {
    const creds = this.getSavedCredentials();
    if (!creds) throw new Error('No saved user credentials.');

    this.client = new TelegramClient(this._sessionName, parseInt(creds.apiId), creds.apiHash, {
      connectionRetries: 10,
      retryDelay: 2000,
      autoReconnect: true,
      useWSS: true,
    });

    await this.client.connect();

    // Check if session is still valid
    try {
      this.me = await this.client.getMe();
      this.connected = true;

      // Update account info on reconnect
      const name = [this.me.firstName || '', this.me.lastName || ''].filter(Boolean).join(' ') || 'Unknown';
      upsertAccount({
        idx: this.accountIndex,
        phone: this.me.phone ? `+${this.me.phone}` : '',
        name,
        username: this.me.username || '',
        apiId: creds.apiId,
        apiHash: creds.apiHash,
      });

      this.onLog('success', `Reconnected as ${name} (@${this.me.username || 'N/A'})`);
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }

  async disconnect() {
    if (this.client) {
      try { await this.client.disconnect(); } catch {}
      this.client = null;
      this.connected = false;
      this.me = null;
      this.onLog('info', 'User client disconnected.');
    }
  }

  /**
   * Full logout: revoke server-side auth, disconnect, and clear all session data.
   */
  async logout() {
    if (this.client && this.connected) {
      // Try to revoke the auth session on Telegram's side
      try {
        await this.client.invoke(new Api.auth.LogOut());
        this.onLog('info', 'Server-side session revoked.');
      } catch (e) {
        this.onLog('dim', `Could not revoke server session: ${e.message}`);
      }
    }
    // Disconnect the client
    await this.disconnect();
    // Clear all local session data
    this.clearSession();
  }

  getSavedCredentials() {
    try {
      const raw = localStorage.getItem(this._credsKey);
      if (raw) return JSON.parse(raw);
      // Fallback: check legacy key
      const legacy = localStorage.getItem('tg_user_creds');
      if (legacy) {
        // Migrate legacy to new format
        localStorage.setItem(this._credsKey, legacy);
        localStorage.removeItem('tg_user_creds');
        return JSON.parse(legacy);
      }
      return null;
    } catch { return null; }
  }

  hasSession() {
    const prefix = this._sessionName + ':';
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) return true;
    }
    // Fallback: check legacy session
    if (this.accountIndex === 0) {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('tg_user:')) return true;
      }
    }
    return false;
  }

  clearSession() {
    localStorage.removeItem(this._credsKey);
    const prefix = this._sessionName + ':';
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) localStorage.removeItem(key);
    }
    // Also clear legacy keys for account 0
    if (this.accountIndex === 0) {
      localStorage.removeItem('tg_user_creds');
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith('tg_user:')) localStorage.removeItem(key);
      }
    }
    // Remove from account list
    removeAccount(this.accountIndex);
  }

  // ===== DIALOGS (Chat List) =====

  /**
   * Get list of dialogs (chats).
   * @param {number} limit
   * @returns {Array} dialogs with entity info
   */
  async getDialogs(limit = 50) {
    if (!this.client || !this.connected) throw new Error('Not connected.');
    const dialogs = await this.client.getDialogs({ limit });
    const me = this.me;
    return dialogs.map(d => {
      const entity = d.entity;
      const isSelf = d.isUser && entity?.id && me?.id && entity.id.toString() === me.id.toString();
      const username = entity?.username || '';
      const tgId = entity?.id?.toString() || d.id?.toString() || '';
      return {
        id: d.id?.toString(),
        title: isSelf ? 'Saved Messages' : (d.title || d.name || 'Unknown'),
        unreadCount: d.unreadCount || 0,
        lastMessage: d.message?.text || d.message?.message || '',
        date: d.date ? new Date(d.date * 1000) : null,
        isChannel: d.isChannel,
        isGroup: d.isGroup,
        isUser: d.isUser,
        isSelf,
        username,
        tgId,
        entity: d.entity,
        dialog: d,
      };
    });
  }

  // ===== MESSAGES =====

  /**
   * Get message history for a chat.
   * @param {object} entity
   * @param {number} limit
   * @param {number} offsetId - for pagination
   */
  async getMessages(entity, limit = 30, offsetId = 0) {
    if (!this.client || !this.connected) throw new Error('Not connected.');
    const messages = await this.client.getMessages(entity, {
      limit,
      offsetId,
    });
    return messages.map(m => this._formatMessage(m));
  }

  _formatMessage(m) {
    let mediaInfo = null;
    if (m.media) {
      if (m.media.document) {
        const doc = m.media.document;
        let fileName = 'file';
        let isVideo = false;
        let isAudio = false;
        let isVoice = false;
        let isVideoNote = false;
        let duration = 0;
        for (const attr of doc.attributes || []) {
          if (attr.className === 'DocumentAttributeFilename') fileName = attr.fileName;
          if (attr.className === 'DocumentAttributeVideo') {
            isVideo = true;
            duration = attr.duration || 0;
            if (attr.roundMessage) isVideoNote = true;
          }
          if (attr.className === 'DocumentAttributeAudio') {
            isAudio = true;
            duration = attr.duration || 0;
            if (attr.voice) isVoice = true;
          }
        }
        mediaInfo = {
          type: isVideoNote ? 'video_note' : isVideo ? 'video' : isVoice ? 'voice' : isAudio ? 'audio' : 'document',
          fileName,
          fileSize: Number(doc.size || 0),
          mimeType: doc.mimeType || '',
          dcId: doc.dcId,
          duration,
          isVideo,
          isAudio,
          isVoice,
          isVideoNote,
        };
      } else if (m.media.photo) {
        const photo = m.media.photo;
        const sizes = photo.sizes || [];
        const largest = sizes[sizes.length - 1];
        mediaInfo = {
          type: 'photo',
          fileSize: largest?.size ? Number(largest.size) : 0,
          dcId: photo.dcId,
        };
      }
    }

    return {
      id: m.id,
      text: m.text || m.message || '',
      date: m.date ? new Date(m.date * 1000) : null,
      out: m.out, // sent by us
      media: mediaInfo,
      message: m, // raw GramJS message for downloads
      senderId: m.senderId?.toString(),
      senderName: '',
      replyToMsgId: m.replyTo?.replyToMsgId || null,
      replyToText: null, // will be filled by UI if needed
    };
  }

  // ===== SEND MESSAGE =====

  async sendMessage(entity, text, replyTo) {
    if (!this.client || !this.connected) throw new Error('Not connected.');
    await this.client.sendMessage(entity, {
      message: text,
      replyTo: replyTo || undefined,
    });
  }

  // ===== READ RECEIPTS =====

  /**
   * Mark messages as read (sends read receipt / double tick).
   * Only sends if stealth mode is disabled in user settings.
   */
  async markAsRead(entity, maxId) {
    if (!this.client || !this.connected) return;
    
    // Check stealth mode from user settings
    try {
      const settings = getUserSettings();
      if (settings.stealthMode) {
        this.onLog('dim', '👻 Stealth: skipped read receipt');
        return;
      }
    } catch {}

    try {
      await this.client.invoke(new Api.messages.ReadHistory({
        peer: entity,
        maxId: maxId || 0,
      }));
    } catch (err) {
      // Try channel version
      try {
        await this.client.invoke(new Api.channels.ReadHistory({
          channel: entity,
          maxId: maxId || 0,
        }));
      } catch {}
    }
  }

  // ===== MEDIA DOWNLOAD =====

  /**
   * Download media from a message.
   * @param {object} message - raw GramJS message
   * @param {boolean} thumb - download thumbnail instead
   */
  async downloadMedia(message, thumb = false) {
    if (!this.client || !this.connected) throw new Error('Not connected.');
    const buffer = await this.client.downloadMedia(message, {
      thumb: thumb ? 0 : undefined,
    });
    if (!buffer) return null;
    return buffer;
  }

  /**
   * Download media as blob URL.
   */
  async downloadMediaAsUrl(message, mimeType = 'application/octet-stream') {
    const buffer = await this.downloadMedia(message);
    if (!buffer) return null;
    const blob = new Blob([buffer], { type: mimeType });
    return URL.createObjectURL(blob);
  }

  /**
   * Download and save media to disk.
   */
  async downloadAndSave(message, fileName, mimeType) {
    const startTime = Date.now();
    let lastUpdate = 0;

    const buffer = await this.client.downloadMedia(message, {
      progressCallback: (downloaded, total) => {
        const now = Date.now();
        if (now - lastUpdate < 200 && downloaded < total) return;
        lastUpdate = now;
        const elapsed = (now - startTime) / 1000;
        const speed = Number(downloaded) / (elapsed || 1);
        const percent = total > 0 ? (Number(downloaded) / Number(total)) * 100 : 0;
        const remaining = speed > 0 ? (Number(total) - Number(downloaded)) / speed : 0;
        this.onProgress({ downloaded: Number(downloaded), total: Number(total), percent, speed, elapsed, remaining });
      },
    });

    if (!buffer) throw new Error('Download returned empty.');
    const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.onLog('success', `💾 Saved: ${fileName} (${elapsed}s)`);
  }

  /**
   * Get photo thumbnail as data URL.
   */
  async getPhotoThumb(message) {
    try {
      // Download medium-size photo (not tiny thumb) for better quality
      const buffer = await this.downloadMedia(message, false);
      if (!buffer || buffer.length === 0) return null;
      const base64 = Buffer.from(buffer).toString('base64');
      return `data:image/jpeg;base64,${base64}`;
    } catch { return null; }
  }

  /**
   * Download full photo as blob URL (for lightbox).
   */
  async getFullPhoto(message) {
    try {
      const buffer = await this.downloadMedia(message, false);
      if (!buffer || buffer.length === 0) return null;
      const blob = new Blob([buffer], { type: 'image/jpeg' });
      return URL.createObjectURL(blob);
    } catch { return null; }
  }

  /**
   * Download video/media and return as blob URL for playback.
   */
  async downloadMediaForPlayback(message, mimeType = 'video/mp4') {
    try {
      const startTime = Date.now();
      let lastUpdate = 0;

      const buffer = await this.client.downloadMedia(message, {
        progressCallback: (downloaded, total) => {
          const now = Date.now();
          if (now - lastUpdate < 200 && downloaded < total) return;
          lastUpdate = now;
          const elapsed = (now - startTime) / 1000;
          const speed = Number(downloaded) / (elapsed || 1);
          const percent = total > 0 ? (Number(downloaded) / Number(total)) * 100 : 0;
          const remaining = speed > 0 ? (Number(total) - Number(downloaded)) / speed : 0;
          this.onProgress({ downloaded: Number(downloaded), total: Number(total), percent, speed, elapsed, remaining });
        },
      });
      if (!buffer || buffer.length === 0) return null;
      const blob = new Blob([buffer], { type: mimeType });
      return URL.createObjectURL(blob);
    } catch { return null; }
  }

  // ===== PARALLEL DOWNLOAD =====

  /**
   * Extract file location and metadata from a raw GramJS message for parallel download.
   */
  _extractFileLocation(message) {
    const media = message.media;
    if (!media) return null;

    if (media.document) {
      const doc = media.document;
      return {
        fileLocation: new Api.InputDocumentFileLocation({
          id: doc.id,
          accessHash: doc.accessHash,
          fileReference: doc.fileReference,
          thumbSize: '',
        }),
        dcId: doc.dcId,
        fileSize: Number(doc.size || 0),
      };
    } else if (media.photo) {
      const photo = media.photo;
      const sizes = photo.sizes || [];
      const largest = sizes[sizes.length - 1];
      return {
        fileLocation: new Api.InputPhotoFileLocation({
          id: photo.id,
          accessHash: photo.accessHash,
          fileReference: photo.fileReference,
          thumbSize: largest ? largest.type : '',
        }),
        dcId: photo.dcId,
        fileSize: largest?.size ? Number(largest.size) : 0,
      };
    }
    return null;
  }

  /**
   * Download media with parallel connections for faster speed.
   * Falls back to single-connection for small files.
   * @param {object} message - raw GramJS message
   * @param {Function} onProgress - (downloaded, total) => void
   * @param {Function} isCancelled - () => boolean, return true to abort
   * @param {number} connections - number of parallel connections (1-8)
   * @returns {Buffer}
   */
  async downloadParallel(message, onProgress, isCancelled, connections = 4) {
    if (!this.client || !this.connected) throw new Error('Not connected.');
    connections = Math.min(Math.max(1, connections), MAX_CONNECTIONS);

    const loc = this._extractFileLocation(message);

    // For small files or if no file location, use simple single-connection download
    if (!loc || loc.fileSize < MIN_PARALLEL_SIZE) {
      return this._downloadSingleWithProgress(message, onProgress, isCancelled);
    }

    const { fileLocation, dcId, fileSize } = loc;
    const chunkSize = DEFAULT_CHUNK_SIZE;
    const totalChunks = Math.ceil(fileSize / chunkSize);
    const actualConnections = Math.min(connections, totalChunks);
    const chunksPerWorker = Math.ceil(totalChunks / actualConnections);
    const maxSenders = Math.min(actualConnections, MAX_CONNECTIONS);

    this.onLog('dim', `Parallel: ${totalChunks} chunks, ${actualConnections} workers, ${maxSenders} DC conns`);

    // Create DC senders
    const senders = [];
    try {
      for (let i = 0; i < maxSenders; i++) {
        const sender = await this.client.getSender(dcId);
        senders.push(sender);
      }
    } catch (e) {
      this.onLog('warn', `Only ${senders.length} senders created: ${e.message}`);
      if (senders.length === 0) {
        this.onLog('warn', 'Falling back to single-connection...');
        return this._downloadSingleWithProgress(message, onProgress, isCancelled);
      }
    }

    const startTime = Date.now();
    const workerProgress = new Array(actualConnections).fill(0);

    // Build tasks
    const tasks = [];
    for (let i = 0; i < actualConnections; i++) {
      const startChunk = i * chunksPerWorker;
      const endChunk = Math.min(startChunk + chunksPerWorker, totalChunks);
      if (startChunk >= totalChunks) break;

      const startOffset = startChunk * chunkSize;
      const endOffset = Math.min(endChunk * chunkSize, fileSize);

      tasks.push(
        this._downloadRange(fileLocation, senders[i % senders.length], startOffset, endOffset, i, workerProgress, startTime, fileSize, chunkSize, onProgress, isCancelled)
      );
    }

    // Run all workers in parallel
    let results;
    try {
      results = await Promise.all(tasks);
    } catch (e) {
      // If parallel fails, try single
      this.onLog('warn', `Parallel failed: ${e.message}. Retrying single...`);
      return this._downloadSingleWithProgress(message, onProgress, isCancelled);
    }

    // Merge all chunks
    const totalBytes = results.reduce((sum, buf) => sum + buf.length, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of results) {
      merged.set(new Uint8Array(chunk.buffer || chunk), offset);
      offset += chunk.length;
    }

    return Buffer.from(merged);
  }

  /**
   * Download a byte range using upload.GetFile with retries and DC migration.
   */
  async _downloadRange(fileLocation, sender, startOffset, endOffset, workerIdx, workerProgress, startTime, totalFileSize, chunkSize, onProgress, isCancelled) {
    const chunks = [];
    let currentOffset = startOffset;
    let retries = 0;
    const MAX_RETRIES = 3;

    while (currentOffset < endOffset) {
      if (isCancelled && isCancelled()) throw new Error('Cancelled');

      const request = new Api.upload.GetFile({
        location: fileLocation,
        offset: bigInt(currentOffset),
        limit: chunkSize,
      });

      let result;
      try {
        result = await this.client.invokeWithSender(request, sender);
        retries = 0;
      } catch (e) {
        if (e.message && e.message.includes('FILE_MIGRATE_')) {
          const newDc = parseInt(e.message.match(/\d+/)?.[0] || '0');
          if (newDc) {
            sender = await this.client.getSender(newDc);
            result = await this.client.invokeWithSender(request, sender);
          } else throw e;
        } else if (retries < MAX_RETRIES) {
          retries++;
          await new Promise(r => setTimeout(r, 1000 * retries));
          try { sender = await this.client.getSender(undefined); } catch { await new Promise(r => setTimeout(r, 3000)); sender = await this.client.getSender(undefined); }
          continue;
        } else throw e;
      }

      const bytes = result.bytes;
      chunks.push(bytes);
      currentOffset += bytes.length;

      // Update progress
      workerProgress[workerIdx] = currentOffset - startOffset;
      const totalDownloaded = workerProgress.reduce((a, b) => a + b, 0);
      if (onProgress) {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = totalDownloaded / (elapsed || 1);
        const percent = totalFileSize > 0 ? (totalDownloaded / totalFileSize) * 100 : 0;
        onProgress(totalDownloaded, totalFileSize, speed, percent);
      }

      if (bytes.length < chunkSize) break;
    }

    // Merge worker chunks
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = Buffer.alloc(totalLen);
    let pos = 0;
    for (const chunk of chunks) {
      chunk.copy ? chunk.copy(merged, pos) : merged.set(new Uint8Array(chunk), pos);
      pos += chunk.length;
    }
    return merged;
  }

  /**
   * Single-connection download with progress callback (fallback).
   */
  async _downloadSingleWithProgress(message, onProgress, isCancelled) {
    const startTime = Date.now();
    let lastUpdate = 0;
    const buffer = await this.client.downloadMedia(message, {
      progressCallback: (downloaded, total) => {
        if (isCancelled && isCancelled()) return;
        const now = Date.now();
        if (now - lastUpdate < 200 && downloaded < total) return;
        lastUpdate = now;
        const elapsed = (now - startTime) / 1000;
        const speed = Number(downloaded) / (elapsed || 1);
        const percent = total > 0 ? (Number(downloaded) / Number(total)) * 100 : 0;
        if (onProgress) onProgress(Number(downloaded), Number(total), speed, percent);
      },
    });
    if (!buffer) throw new Error('Download returned empty.');
    return buffer;
  }

  // ===== LISTEN FOR NEW MESSAGES =====

  startListening(onNewMessage) {
    if (!this.client || !this.connected) return;
    this.client.addEventHandler(async (event) => {
      try {
        const m = event.message;
        if (!m) return;
        onNewMessage(this._formatMessage(m));
      } catch {}
    }, new NewMessage({}));
  }

  // ===== HELPERS =====

  _formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0) + ' ' + units[i];
  }
}
