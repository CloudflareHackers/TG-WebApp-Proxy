/**
 * Telegram User Client wrapper using GramJS.
 * Authenticates as a user (not bot) using phone number + code + optional 2FA.
 * Provides chat list, message history, media download, and message sending.
 */

import { TelegramClient, Api } from 'telegram';
import { NewMessage } from 'telegram/events';
import bigInt from 'big-integer';
import { getSettings } from './settings.js';

const USER_SESSION_KEY = 'tg_user_session';
const USER_CREDS_KEY = 'tg_user_creds';

export class TGUserClient {
  constructor(onLog, onProgress) {
    this.client = null;
    this.onLog = onLog || (() => {});
    this.onProgress = onProgress || (() => {});
    this.connected = false;
    this.me = null;
  }

  // ===== CONNECTION =====

  /**
   * Initialize the client (doesn't connect yet).
   * Must call start() after this.
   */
  async init(apiId, apiHash) {
    this.onLog('info', 'Initializing user MTProto client...');
    this._apiId = apiId;
    this._apiHash = apiHash;
    this.client = new TelegramClient('tg_user', parseInt(apiId), apiHash, {
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
    localStorage.setItem(USER_CREDS_KEY, JSON.stringify({
      apiId: this._apiId,
      apiHash: this._apiHash,
    }));

    this.connected = true;
    this.me = await this.client.getMe();
    this.onLog('success', `✅ Logged in as ${this.me.firstName || ''} ${this.me.lastName || ''} (@${this.me.username || 'N/A'})`);
    return this.me;
  }

  /**
   * Reconnect using saved session.
   */
  async reconnect() {
    const creds = this.getSavedCredentials();
    if (!creds) throw new Error('No saved user credentials.');

    this.client = new TelegramClient('tg_user', parseInt(creds.apiId), creds.apiHash, {
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
      this.onLog('success', `Reconnected as ${this.me.firstName || ''} (@${this.me.username || 'N/A'})`);
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
      this.onLog('info', 'User client disconnected.');
    }
  }

  getSavedCredentials() {
    try {
      const raw = localStorage.getItem(USER_CREDS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  hasSession() {
    // Check if GramJS has a saved session in localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('tg_user:')) return true;
    }
    return false;
  }

  clearSession() {
    localStorage.removeItem(USER_CREDS_KEY);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith('tg_user:')) localStorage.removeItem(key);
    }
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
    return dialogs.map(d => ({
      id: d.id?.toString(),
      title: d.title || d.name || 'Unknown',
      unreadCount: d.unreadCount || 0,
      lastMessage: d.message?.text || d.message?.message || '',
      date: d.date ? new Date(d.date * 1000) : null,
      isChannel: d.isChannel,
      isGroup: d.isGroup,
      isUser: d.isUser,
      entity: d.entity,
      dialog: d,
    }));
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
        for (const attr of doc.attributes || []) {
          if (attr.className === 'DocumentAttributeFilename') fileName = attr.fileName;
        }
        mediaInfo = {
          type: 'document',
          fileName,
          fileSize: Number(doc.size || 0),
          mimeType: doc.mimeType || '',
          dcId: doc.dcId,
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
      senderName: '', // resolved later if needed
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
      const buffer = await this.downloadMedia(message, true);
      if (!buffer || buffer.length === 0) return null;
      const base64 = Buffer.from(buffer).toString('base64');
      return `data:image/jpeg;base64,${base64}`;
    } catch { return null; }
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
