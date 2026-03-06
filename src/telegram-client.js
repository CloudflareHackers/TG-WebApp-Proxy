/**
 * Telegram MTProto Client wrapper using GramJS.
 * Runs entirely in the browser - connections via WebSocket.
 * Authenticates as a bot using bot token.
 * Downloads files with NO size limit (unlike Bot API's 20MB cap).
 * Supports PARALLEL chunk downloads for faster speeds.
 */

import { TelegramClient, Api } from 'telegram';
import { utils } from 'telegram';
import { NewMessage } from 'telegram/events';
import bigInt from 'big-integer';

const CREDENTIALS_KEY = 'tg_credentials';
const MAX_CHUNK_SIZE = 512 * 1024; // 512KB - MTProto max per request
const MIN_PARALLEL_SIZE = 1024 * 1024; // 1MB - minimum for parallel mode

export class TGDownloader {
  constructor(onLog, onProgress) {
    this.client = null;
    this.onLog = onLog || (() => {});
    this.onProgress = onProgress || (() => {});
    this.connected = false;
    this._fileCache = new Map(); // Cache file info by link
  }

  // ===== CONNECTION =====

  async connect(apiId, apiHash, botToken) {
    try {
      this.onLog('info', 'Initializing MTProto connection...');
      this.client = new TelegramClient('tg_bot', parseInt(apiId), apiHash, {
        connectionRetries: 5,
        useWSS: true,
      });
      this.onLog('info', 'Connecting to Telegram servers...');
      await this.client.start({ botAuthToken: botToken });
      localStorage.setItem(CREDENTIALS_KEY, JSON.stringify({ apiId, apiHash, botToken }));
      this.connected = true;
      const me = await this.client.getMe();
      this.onLog('success', `Connected as @${me.username} (${me.firstName})`);
      this.onLog('dim', `Session saved. Will reconnect faster next time.`);
      return { success: true, botInfo: me };
    } catch (error) {
      this.connected = false;
      this.onLog('error', `Connection failed: ${error.message}`);
      throw error;
    }
  }

  async disconnect() {
    if (this.client) {
      try { await this.client.disconnect(); } catch {}
      this.client = null;
      this.connected = false;
      this.onLog('info', 'Disconnected from Telegram.');
    }
  }

  getSavedCredentials() {
    try {
      const saved = localStorage.getItem(CREDENTIALS_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  }

  clearSession() {
    localStorage.removeItem(CREDENTIALS_KEY);
    this._fileCache.clear();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith('tg_bot:')) localStorage.removeItem(key);
    }
  }

  // ===== FETCH FILE INFO (cached) =====

  /**
   * Fetch message and extract file location info. Results are cached by link key.
   * Returns a reusable fileRef object for downloading (no need to re-fetch).
   */
  async fetchFileInfo(chatIdentifier, messageId, cacheKey) {
    if (!this.client || !this.connected) {
      throw new Error('Not connected. Please connect first.');
    }

    // Check cache first
    if (cacheKey && this._fileCache.has(cacheKey)) {
      this.onLog('dim', 'Using cached file info (no re-fetch needed).');
      return this._fileCache.get(cacheKey);
    }

    this.onLog('info', `Fetching message #${messageId}...`);

    // Resolve entity
    let entity;
    if (typeof chatIdentifier === 'string' && !chatIdentifier.startsWith('-')) {
      this.onLog('dim', `Resolving @${chatIdentifier}...`);
      entity = await this.client.getEntity(chatIdentifier);
    } else {
      const id = typeof chatIdentifier === 'bigint' ? chatIdentifier : BigInt(chatIdentifier);
      this.onLog('dim', `Resolving channel ID ${id}...`);
      entity = await this.client.getEntity(id);
    }

    // Fetch message
    const result = await this.client.getMessages(entity, { ids: [messageId] });
    if (!result || result.length === 0 || !result[0]) {
      throw new Error(`Message #${messageId} not found. Make sure the bot has access.`);
    }

    const message = result[0];
    const media = message.media;
    if (!media) throw new Error('This message has no media.');

    // Extract file metadata
    let fileName = 'unknown';
    let fileSize = 0;
    let mimeType = '';
    let fileLocation = null;
    let dcId = null;

    if (media.document) {
      const doc = media.document;
      fileSize = Number(doc.size);
      mimeType = doc.mimeType || '';
      dcId = doc.dcId;

      for (const attr of doc.attributes || []) {
        if (attr.className === 'DocumentAttributeFilename') {
          fileName = attr.fileName;
        }
      }
      if (fileName === 'unknown' && mimeType) {
        fileName = `file_${message.id}.${mimeType.split('/')[1] || 'bin'}`;
      }

      // Create the reusable InputDocumentFileLocation
      fileLocation = new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: '',
      });
    } else if (media.photo) {
      const photo = media.photo;
      const sizes = photo.sizes || [];
      const largest = sizes[sizes.length - 1];
      fileSize = largest && largest.size ? Number(largest.size) : 0;
      mimeType = 'image/jpeg';
      fileName = `photo_${message.id}.jpg`;
      dcId = photo.dcId;

      fileLocation = new Api.InputPhotoFileLocation({
        id: photo.id,
        accessHash: photo.accessHash,
        fileReference: photo.fileReference,
        thumbSize: largest ? largest.type : '',
      });
    }

    if (!fileLocation) {
      throw new Error('Could not extract file location from message.');
    }

    const fileRef = {
      fileName,
      fileSize,
      mimeType,
      fileLocation,
      dcId,
      message, // keep reference for fallback
      hasMedia: true,
    };

    // Cache it
    if (cacheKey) {
      this._fileCache.set(cacheKey, fileRef);
    }

    this.onLog('success', `File: ${fileName} (${this._formatSize(fileSize)}) [${mimeType}]`);
    return fileRef;
  }

  // ===== DOWNLOAD =====

  /**
   * Download a file using cached fileRef.
   * @param {object} fileRef - from fetchFileInfo()
   * @param {number} connections - parallel connections (1-8)
   */
  async downloadFile(fileRef, connections = 1) {
    if (!this.client || !this.connected) {
      throw new Error('Not connected. Please connect first.');
    }

    connections = Math.min(Math.max(1, connections), 8);
    const { fileSize, fileName, mimeType, fileLocation, dcId } = fileRef;

    // For small files or single connection, use simple download
    if (connections <= 1 || fileSize < MIN_PARALLEL_SIZE) {
      this.onLog('info', `Downloading ${fileName} [1 connection]...`);
      return this._downloadSingle(fileRef);
    }

    // Parallel download
    this.onLog('info', `Downloading ${fileName} [${connections} connections]...`);
    return this._downloadParallel(fileRef, connections);
  }

  /**
   * Single-connection download using GramJS downloadMedia (simple, reliable)
   */
  async _downloadSingle(fileRef) {
    const startTime = Date.now();
    let lastUpdate = 0;

    const buffer = await this.client.downloadMedia(fileRef.message, {
      progressCallback: (downloaded, total) => {
        const now = Date.now();
        if (now - lastUpdate < 200 && downloaded < total) return;
        lastUpdate = now;
        this._emitProgress(startTime, Number(downloaded), Number(total));
      },
    });

    if (!buffer) throw new Error('Download returned empty data.');
    return this._finishDownload(buffer, fileRef, startTime);
  }

  /**
   * PARALLEL multi-connection download.
   * Uses upload.GetFile with different offsets via multiple DC senders.
   * Each worker downloads a range of the file simultaneously.
   */
  async _downloadParallel(fileRef, connections) {
    const { fileSize, fileLocation, dcId } = fileRef;
    const startTime = Date.now();

    // Calculate chunk distribution
    const totalChunks = Math.ceil(fileSize / MAX_CHUNK_SIZE);
    const actualConnections = Math.min(connections, totalChunks);
    const chunksPerWorker = Math.ceil(totalChunks / actualConnections);

    this.onLog('dim', `${totalChunks} chunks (${this._formatSize(MAX_CHUNK_SIZE)} each), ${actualConnections} workers`);

    // Get senders (each creates a separate connection to the DC)
    const senders = [];
    try {
      for (let i = 0; i < actualConnections; i++) {
        const sender = await this.client.getSender(dcId);
        senders.push(sender);
      }
    } catch (e) {
      this.onLog('warn', `Could only create ${senders.length} senders: ${e.message}`);
      if (senders.length === 0) {
        this.onLog('warn', 'Falling back to single-connection download...');
        return this._downloadSingle(fileRef);
      }
    }

    // Track progress per worker
    const workerProgress = new Array(actualConnections).fill(0);

    // Create download tasks
    const tasks = [];
    for (let i = 0; i < actualConnections; i++) {
      const startChunk = i * chunksPerWorker;
      const endChunk = Math.min(startChunk + chunksPerWorker, totalChunks);
      if (startChunk >= totalChunks) break;

      const startOffset = startChunk * MAX_CHUNK_SIZE;
      const endOffset = Math.min(endChunk * MAX_CHUNK_SIZE, fileSize);

      tasks.push(
        this._downloadRange(
          fileLocation,
          senders[i % senders.length],
          startOffset,
          endOffset,
          i,
          workerProgress,
          startTime,
          fileSize
        )
      );
    }

    // Run all workers in parallel
    let results;
    try {
      results = await Promise.all(tasks);
    } catch (e) {
      this.onLog('warn', `Parallel download failed: ${e.message}. Retrying single...`);
      return this._downloadSingle(fileRef);
    }

    // Merge all chunks in order into one buffer
    const totalBytes = results.reduce((sum, buf) => sum + buf.length, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of results) {
      merged.set(new Uint8Array(chunk.buffer || chunk), offset);
      offset += chunk.length;
    }

    return this._finishDownload(Buffer.from(merged), fileRef, startTime);
  }

  /**
   * Download a byte range using low-level upload.GetFile.
   * Each call downloads from startOffset to endOffset in 512KB chunks.
   */
  async _downloadRange(fileLocation, sender, startOffset, endOffset, workerIdx, workerProgress, startTime, totalFileSize) {
    const chunks = [];
    let currentOffset = startOffset;

    while (currentOffset < endOffset) {
      // Limit MUST be a multiple of 4096 and between 4096-524288 for MTProto
      // Always request full MAX_CHUNK_SIZE - server returns only what's available for last chunk
      const remaining = endOffset - currentOffset;
      const limit = remaining < MAX_CHUNK_SIZE ? MAX_CHUNK_SIZE : MAX_CHUNK_SIZE;

      const request = new Api.upload.GetFile({
        location: fileLocation,
        offset: bigInt(currentOffset),
        limit: limit,
      });

      let result;
      try {
        result = await this.client.invokeWithSender(request, sender);
      } catch (e) {
        if (e.message && e.message.includes('FILE_MIGRATE_')) {
          // File is on another DC
          const newDc = parseInt(e.message.match(/\d+/)?.[0] || '0');
          if (newDc) {
            this.onLog('dim', `Worker ${workerIdx + 1}: migrating to DC${newDc}`);
            sender = await this.client.getSender(newDc);
            result = await this.client.invokeWithSender(request, sender);
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }

      const bytes = result.bytes;
      chunks.push(bytes);
      currentOffset += bytes.length;

      // Update progress
      workerProgress[workerIdx] = currentOffset - startOffset;
      const totalDownloaded = workerProgress.reduce((a, b) => a + b, 0);
      this._emitProgress(startTime, totalDownloaded, totalFileSize);

      // If we got less than requested, we've reached the end
      if (bytes.length < limit) break;
    }

    // Merge this worker's chunks
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = Buffer.alloc(totalLen);
    let pos = 0;
    for (const chunk of chunks) {
      chunk.copy ? chunk.copy(merged, pos) : merged.set(new Uint8Array(chunk), pos);
      pos += chunk.length;
    }

    this.onLog('dim', `Worker ${workerIdx + 1}: done (${this._formatSize(totalLen)})`);
    return merged;
  }

  // ===== INCOMING MESSAGE LISTENER =====

  /**
   * Start listening for incoming messages with media.
   * Calls onFileReceived(fileRef) whenever a file/media message arrives.
   */
  startListening(onFileReceived) {
    if (!this.client || !this.connected) {
      this.onLog('error', 'Not connected. Cannot listen for messages.');
      return;
    }

    this._onFileReceived = onFileReceived;

    // GramJS event handler for new messages
    this.client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message || !message.media) return;

        // Only process documents, photos, videos
        const media = message.media;
        if (!media.document && !media.photo) return;

        // Extract file info
        let fileName = 'unknown';
        let fileSize = 0;
        let mimeType = '';
        let fileLocation = null;
        let dcId = null;

        if (media.document) {
          const doc = media.document;
          fileSize = Number(doc.size);
          mimeType = doc.mimeType || '';
          dcId = doc.dcId;

          for (const attr of doc.attributes || []) {
            if (attr.className === 'DocumentAttributeFilename') {
              fileName = attr.fileName;
            }
          }
          if (fileName === 'unknown' && mimeType) {
            fileName = `file_${message.id}.${mimeType.split('/')[1] || 'bin'}`;
          }

          fileLocation = new Api.InputDocumentFileLocation({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference,
            thumbSize: '',
          });
        } else if (media.photo) {
          const photo = media.photo;
          const sizes = photo.sizes || [];
          const largest = sizes[sizes.length - 1];
          fileSize = largest && largest.size ? Number(largest.size) : 0;
          mimeType = 'image/jpeg';
          fileName = `photo_${message.id}.jpg`;
          dcId = photo.dcId;

          fileLocation = new Api.InputPhotoFileLocation({
            id: photo.id,
            accessHash: photo.accessHash,
            fileReference: photo.fileReference,
            thumbSize: largest ? largest.type : '',
          });
        }

        if (!fileLocation) return;

        // Get chat info
        let chatName = 'Unknown';
        try {
          const peer = message.peerId;
          if (peer?.channelId) {
            chatName = `Channel -100${peer.channelId}`;
          } else if (peer?.chatId) {
            chatName = `Chat -${peer.chatId}`;
          } else if (peer?.userId) {
            chatName = `User ${peer.userId}`;
          }
        } catch {}

        const fileRef = {
          fileName,
          fileSize,
          mimeType,
          fileLocation,
          dcId,
          message,
          hasMedia: true,
          chatName,
          messageId: message.id,
          date: message.date ? new Date(message.date * 1000) : new Date(),
        };

        // Cache it
        const cacheKey = `msg_${message.id}_${dcId}`;
        this._fileCache.set(cacheKey, fileRef);

        this.onLog('info', `📨 New file: ${fileName} (${this._formatSize(fileSize)}) from ${chatName}`);

        if (this._onFileReceived) {
          this._onFileReceived(fileRef);
        }
      } catch (e) {
        // Silently ignore non-media messages
      }
    }, new NewMessage({}));

    this.onLog('success', '👂 Listening for incoming files...');
  }

  // ===== HELPERS =====

  _finishDownload(buffer, fileRef, startTime) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgSpeed = this._formatSize(fileRef.fileSize / (parseFloat(elapsed) || 1));
    this.onLog('success', `Download complete! (${elapsed}s, avg ${avgSpeed}/s)`);

    const blob = new Blob([buffer], { type: fileRef.mimeType || 'application/octet-stream' });
    return { blob, fileInfo: fileRef };
  }

  _emitProgress(startTime, downloadedBytes, totalBytes) {
    const now = Date.now();
    const elapsed = (now - startTime) / 1000;
    const speed = downloadedBytes / (elapsed || 1);
    const percent = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
    const remaining = speed > 0 ? (totalBytes - downloadedBytes) / speed : 0;
    this.onProgress({
      downloaded: downloadedBytes,
      total: totalBytes,
      percent: Math.min(percent, 100),
      speed,
      elapsed,
      remaining,
    });
  }

  saveBlobAs(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    this.onLog('success', `💾 File saved: ${fileName}`);
  }

  _formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0) + ' ' + units[i];
  }
}
