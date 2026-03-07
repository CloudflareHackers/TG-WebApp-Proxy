/**
 * IndexedDB persistence for conversations, files, and chats.
 * Conversations grouped by senderId — each stores full message history.
 */

const DB_NAME = 'tgcf_dl';
const DB_VERSION = 2;

let db = null;

export async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Conversations: keyed by senderId, stores sender info + message array
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'senderId' });
      }

      // Incoming files (media only)
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'id' });
      }

      // Remove old stores if upgrading
      if (db.objectStoreNames.contains('messages')) {
        db.deleteObjectStore('messages');
      }
      if (db.objectStoreNames.contains('chats')) {
        db.deleteObjectStore('chats');
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = (event) => {
      console.error('IndexedDB error:', event.target.error);
      reject(event.target.error);
    };
  });
}

// ===== Conversations =====

/**
 * Add a message to a conversation (grouped by senderId).
 * Creates the conversation if it doesn't exist.
 */
export async function addMessageToConversation(msgData) {
  if (!db) return;
  const senderId = msgData.senderId || 'unknown';
  
  return new Promise((resolve) => {
    const tx = db.transaction('conversations', 'readwrite');
    const store = tx.objectStore('conversations');
    const getReq = store.get(senderId);
    
    getReq.onsuccess = () => {
      const existing = getReq.result || {
        senderId,
        senderName: msgData.senderName || 'Unknown',
        senderType: msgData.senderType || 'User',
        messages: [],
      };
      
      // Update sender info (may have been resolved now)
      if (msgData.senderName && msgData.senderName !== 'Unknown') {
        existing.senderName = msgData.senderName;
      }
      if (msgData.senderType) {
        existing.senderType = msgData.senderType;
      }

      // Store peer info for replies
      if (msgData.chatPeerType && msgData.chatPeerId) {
        existing.chatPeerType = msgData.chatPeerType;
        existing.chatPeerId = msgData.chatPeerId;
      } else if (msgData.chatPeer) {
        existing.chatPeerType = msgData.chatPeer.channelId ? 'channel' : msgData.chatPeer.chatId ? 'chat' : 'user';
        existing.chatPeerId = (msgData.chatPeer.channelId || msgData.chatPeer.chatId || msgData.chatPeer.userId || '').toString();
      }
      
      // Add the message
      const msg = {
        id: msgData.id,
        text: msgData.text || '',
        hasMedia: !!msgData.hasMedia,
        thumbnailUrl: msgData.thumbnailUrl || null,
        date: msgData.date instanceof Date ? msgData.date.toISOString() : (msgData.date || new Date().toISOString()),
        fromBot: !!msgData.fromBot, // true if sent by us
      };
      
      // Avoid duplicates
      if (!existing.messages.find(m => m.id === msg.id)) {
        existing.messages.push(msg);
        // Keep max 200 messages per conversation
        if (existing.messages.length > 200) {
          existing.messages = existing.messages.slice(-200);
        }
      }
      
      existing.lastMessageDate = msg.date;
      existing.lastMessagePreview = msg.text || (msg.hasMedia ? '📎 [Media]' : '');
      
      store.put(existing);
      resolve(existing);
    };
    
    getReq.onerror = () => resolve(null);
  });
}

/**
 * Save a bot reply to a conversation.
 */
export async function addBotReplyToConversation(senderId, text) {
  if (!db) return;
  return addMessageToConversation({
    id: `bot_${Date.now()}`,
    senderId,
    text,
    date: new Date(),
    fromBot: true,
  });
}

/**
 * Get all conversations, sorted by last message date.
 */
export async function getAllConversations() {
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction('conversations', 'readonly');
    const store = tx.objectStore('conversations');
    const request = store.getAll();
    request.onsuccess = () => {
      const results = request.result || [];
      results.sort((a, b) => new Date(b.lastMessageDate || 0) - new Date(a.lastMessageDate || 0));
      resolve(results);
    };
    request.onerror = () => resolve([]);
  });
}

/**
 * Get a single conversation by senderId.
 */
export async function getConversation(senderId) {
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction('conversations', 'readonly');
    const request = tx.objectStore('conversations').get(senderId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

// ===== Files =====

export async function saveFile(fileData) {
  if (!db) return;
  const tx = db.transaction('files', 'readwrite');
  tx.objectStore('files').put({
    id: `file_${fileData.messageId || fileData.id || Date.now()}`,
    fileName: fileData.fileName,
    fileSize: fileData.fileSize,
    mimeType: fileData.mimeType,
    chatName: fileData.chatName || '',
    dcId: fileData.dcId,
    date: fileData.date instanceof Date ? fileData.date.toISOString() : (fileData.date || new Date().toISOString()),
    downloaded: false,
  });
}

export async function getAllFiles(limit = 1000) {
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction('files', 'readonly');
    const request = tx.objectStore('files').getAll();
    request.onsuccess = () => {
      const results = request.result || [];
      results.sort((a, b) => new Date(b.date) - new Date(a.date));
      resolve(limit ? results.slice(0, limit) : results);
    };
    request.onerror = () => resolve([]);
  });
}

export async function markFileDownloaded(id) {
  if (!db) return;
  const tx = db.transaction('files', 'readwrite');
  const store = tx.objectStore('files');
  const request = store.get(id);
  request.onsuccess = () => {
    const file = request.result;
    if (file) { file.downloaded = true; store.put(file); }
  };
}

// ===== Delete single conversation =====
export async function deleteConversation(senderId) {
  if (!db) return;
  const tx = db.transaction('conversations', 'readwrite');
  tx.objectStore('conversations').delete(senderId);
}

// ===== Clear conversations only =====
export async function clearConversations() {
  if (!db) return;
  const tx = db.transaction('conversations', 'readwrite');
  tx.objectStore('conversations').clear();
}

// ===== Clear files only =====
export async function clearFiles() {
  if (!db) return;
  const tx = db.transaction('files', 'readwrite');
  tx.objectStore('files').clear();
}

// ===== Clear all =====

export async function clearAllData() {
  if (!db) return;
  const tx = db.transaction(['conversations', 'files'], 'readwrite');
  tx.objectStore('conversations').clear();
  tx.objectStore('files').clear();
}
