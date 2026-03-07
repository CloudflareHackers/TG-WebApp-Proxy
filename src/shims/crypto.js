// Browser shim for Node.js `crypto` module - used by GramJS
// Uses Web Crypto API (available in all modern browsers)

export function randomBytes(size) {
  const buf = Buffer.alloc(size);
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  buf.set(bytes);
  return buf;
}

/**
 * createHash that matches GramJS's browser Hash class interface.
 * Uses Web Crypto API for correct hashing (async digest).
 * GramJS's Helpers.sha256 does `await hash.digest()` so async is fine.
 */
export function createHash(algorithm) {
  const algo = algorithm.toLowerCase().replace('-', '');
  const algoMap = { sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' };
  const webAlgo = algoMap[algo];

  // Store data as Uint8Array
  let data = null;

  return {
    update(input) {
      data = new Uint8Array(input instanceof Uint8Array ? input : Buffer.from(input));
      return this;
    },
    async digest() {
      if (!data) return Buffer.alloc(0);
      if (webAlgo) {
        const hashBuffer = await globalThis.crypto.subtle.digest(webAlgo, data);
        return Buffer.from(hashBuffer);
      }
      // Fallback for unsupported algorithms
      return Buffer.alloc(32);
    }
  };
}

export function createCipheriv() {
  throw new Error('createCipheriv not available in browser shim');
}

export function createDecipheriv() {
  throw new Error('createDecipheriv not available in browser shim');
}

/**
 * PBKDF2 synchronous implementation for browser.
 * Used by GramJS for 2FA password authentication (SRP).
 * @param {Buffer|string} password
 * @param {Buffer|string} salt
 * @param {number} iterations
 * @param {number} keylen - desired key length in bytes
 * @param {string} digest - 'sha256' or 'sha512'
 * @returns {Buffer}
 */
/**
 * PBKDF2 using Web Crypto API (async but named pbkdf2Sync for GramJS compatibility).
 * GramJS's Password.js expects this to return a Promise (their own "sync" is also async).
 */
export async function pbkdf2Sync(password, salt, iterations, ...args) {
  console.log('[crypto shim] pbkdf2Sync called:', { iterations, argsLen: args.length, arg0Type: typeof args[0], arg1: args[1] || args[0] });
  const keylen = typeof args[0] === 'number' ? args[0] : 64;
  const digest = typeof args[1] === 'string' ? args[1] : (typeof args[0] === 'string' ? args[0] : 'sha512');
  const hashMap = { sha512: 'SHA-512', sha256: 'SHA-256', sha1: 'SHA-1' };
  const hashAlgo = hashMap[(digest || 'sha512').toLowerCase()] || 'SHA-512';
  const bits = keylen * 8;

  const passwordKey = await globalThis.crypto.subtle.importKey(
    'raw',
    password instanceof Uint8Array ? password : Buffer.from(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derived = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: hashAlgo,
      salt: salt instanceof Uint8Array ? salt : Buffer.from(salt),
      iterations: iterations,
    },
    passwordKey,
    bits
  );

  return Buffer.from(derived);
}

/**
 * Async pbkdf2 (callback-based, for compatibility)
 */
export function pbkdf2(password, salt, iterations, keylen, digest, callback) {
  try {
    const result = pbkdf2Sync(password, salt, iterations, keylen, digest);
    if (callback) callback(null, result);
    return result;
  } catch (e) {
    if (callback) callback(e);
    else throw e;
  }
}

// Simple synchronous SHA-256 (pure JS)
function syncSha256(data, encoding) {
  const result = sha256(new Uint8Array(data));
  const buf = Buffer.from(result);
  if (encoding === 'hex') return buf.toString('hex');
  return buf;
}

function syncSha1(data, encoding) {
  const result = sha1(new Uint8Array(data));
  const buf = Buffer.from(result);
  if (encoding === 'hex') return buf.toString('hex');
  return buf;
}

// Minimal SHA-512 implementation (needed for PBKDF2 with sha512)
function sha512(data) {
  // SHA-512 uses 64-bit words — use BigInt for correctness
  const K = [
    0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
    0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
    0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
    0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
    0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
    0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
    0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
    0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
    0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
    0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
    0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
    0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
    0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
    0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
    0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
    0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
    0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
    0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90dacn, 0x1b710b35131c471bn,
    0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
    0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
  ];

  const mask64 = 0xffffffffffffffffn;
  const ror64 = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & mask64;
  const shr64 = (x, n) => x >> BigInt(n);

  let H = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
  ];

  const msgLen = data.length;
  const bitLen = BigInt(msgLen) * 8n;
  // Pad to 128-byte block boundary (SHA-512 uses 128-byte blocks)
  const padLen = ((msgLen + 16) >> 7 << 7) + 128;
  const msg = new Uint8Array(padLen);
  msg.set(data);
  msg[msgLen] = 0x80;
  // Store length as 128-bit big-endian (we only need lower 64 bits)
  const dv = new DataView(msg.buffer);
  // High 64 bits = 0 for messages < 2^64 bits
  dv.setUint32(padLen - 4, Number(bitLen & 0xffffffffn), false);
  dv.setUint32(padLen - 8, Number((bitLen >> 32n) & 0xffffffffn), false);

  const W = new Array(80);

  for (let offset = 0; offset < padLen; offset += 128) {
    for (let i = 0; i < 16; i++) {
      const hi = BigInt(dv.getUint32(offset + i * 8, false));
      const lo = BigInt(dv.getUint32(offset + i * 8 + 4, false));
      W[i] = ((hi << 32n) | lo) & mask64;
    }
    for (let i = 16; i < 80; i++) {
      const s0 = (ror64(W[i-15], 1) ^ ror64(W[i-15], 8) ^ shr64(W[i-15], 7)) & mask64;
      const s1 = (ror64(W[i-2], 19) ^ ror64(W[i-2], 61) ^ shr64(W[i-2], 6)) & mask64;
      W[i] = (W[i-16] + s0 + W[i-7] + s1) & mask64;
    }

    let [a, b, c, d, e, f, g, h] = H;

    for (let i = 0; i < 80; i++) {
      const S1 = (ror64(e, 14) ^ ror64(e, 18) ^ ror64(e, 41)) & mask64;
      const ch = ((e & f) ^ (~e & mask64 & g)) & mask64;
      const temp1 = (h + S1 + ch + K[i] + W[i]) & mask64;
      const S0 = (ror64(a, 28) ^ ror64(a, 34) ^ ror64(a, 39)) & mask64;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) & mask64;
      const temp2 = (S0 + maj) & mask64;
      h = g; g = f; f = e; e = (d + temp1) & mask64;
      d = c; c = b; b = a; a = (temp1 + temp2) & mask64;
    }

    H[0] = (H[0] + a) & mask64; H[1] = (H[1] + b) & mask64;
    H[2] = (H[2] + c) & mask64; H[3] = (H[3] + d) & mask64;
    H[4] = (H[4] + e) & mask64; H[5] = (H[5] + f) & mask64;
    H[6] = (H[6] + g) & mask64; H[7] = (H[7] + h) & mask64;
  }

  const result = new Uint8Array(64);
  const rv = new DataView(result.buffer);
  for (let i = 0; i < 8; i++) {
    rv.setUint32(i * 8, Number((H[i] >> 32n) & 0xffffffffn), false);
    rv.setUint32(i * 8 + 4, Number(H[i] & 0xffffffffn), false);
  }
  return result;
}

// Minimal SHA-256 implementation
function sha256(data) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  let H0 = 0x6a09e667, H1 = 0xbb67ae85, H2 = 0x3c6ef372, H3 = 0xa54ff53a;
  let H4 = 0x510e527f, H5 = 0x9b05688c, H6 = 0x1f83d9ab, H7 = 0x5be0cd19;

  const msgLen = data.length;
  const bitLen = msgLen * 8;
  const padLen = ((msgLen + 8) >> 6 << 6) + 64;
  const msg = new Uint8Array(padLen);
  msg.set(data);
  msg[msgLen] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(padLen - 4, bitLen, false);

  const W = new Uint32Array(64);

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = (ror(W[i-15], 7) ^ ror(W[i-15], 18) ^ (W[i-15] >>> 3));
      const s1 = (ror(W[i-2], 17) ^ ror(W[i-2], 19) ^ (W[i-2] >>> 10));
      W[i] = (W[i-16] + s0 + W[i-7] + s1) | 0;
    }
    let a = H0, b = H1, c = H2, d = H3, e = H4, f = H5, g = H6, h = H7;
    for (let i = 0; i < 64; i++) {
      const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    H0 = (H0 + a) | 0; H1 = (H1 + b) | 0; H2 = (H2 + c) | 0; H3 = (H3 + d) | 0;
    H4 = (H4 + e) | 0; H5 = (H5 + f) | 0; H6 = (H6 + g) | 0; H7 = (H7 + h) | 0;
  }

  const result = new Uint8Array(32);
  const rv = new DataView(result.buffer);
  rv.setUint32(0, H0); rv.setUint32(4, H1); rv.setUint32(8, H2); rv.setUint32(12, H3);
  rv.setUint32(16, H4); rv.setUint32(20, H5); rv.setUint32(24, H6); rv.setUint32(28, H7);
  return result;
}

function sha1(data) {
  let H0 = 0x67452301, H1 = 0xEFCDAB89, H2 = 0x98BADCFE, H3 = 0x10325476, H4 = 0xC3D2E1F0;
  const msgLen = data.length;
  const bitLen = msgLen * 8;
  const padLen = ((msgLen + 8) >> 6 << 6) + 64;
  const msg = new Uint8Array(padLen);
  msg.set(data);
  msg[msgLen] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(padLen - 4, bitLen, false);
  const W = new Uint32Array(80);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) W[i] = rol(W[i-3] ^ W[i-8] ^ W[i-14] ^ W[i-16], 1);
    let a = H0, b = H1, c = H2, d = H3, e = H4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const temp = (rol(a, 5) + f + e + k + W[i]) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = temp;
    }
    H0 = (H0 + a) | 0; H1 = (H1 + b) | 0; H2 = (H2 + c) | 0; H3 = (H3 + d) | 0; H4 = (H4 + e) | 0;
  }
  const result = new Uint8Array(20);
  const rv = new DataView(result.buffer);
  rv.setUint32(0, H0); rv.setUint32(4, H1); rv.setUint32(8, H2); rv.setUint32(12, H3); rv.setUint32(16, H4);
  return result;
}

function ror(n, b) { return (n >>> b) | (n << (32 - b)); }
function rol(n, b) { return (n << b) | (n >>> (32 - b)); }

export default { randomBytes, createHash, createCipheriv, createDecipheriv, pbkdf2Sync, pbkdf2 };
