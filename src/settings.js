/**
 * Settings module — persists user preferences in localStorage.
 * 
 * Settings:
 * - parallelWorkers: number of parallel download connections (1-32, default 8)
 * - chunkSize: MTProto chunk size in bytes (must be multiple of 4096, max 1MB, default 512KB)
 * - proxyEnabled: whether to route Telegram connections through CF proxy
 * - autoChunkSize: let the app auto-detect best chunk size
 */

const SETTINGS_KEY = 'tgcf_settings';

const CHUNK_SIZES = [
  { value: 65536,   label: '64 KB' },
  { value: 131072,  label: '128 KB' },
  { value: 262144,  label: '256 KB' },
  { value: 524288,  label: '512 KB' },
  { value: 1048576, label: '1 MB' },
];

const DEFAULTS = {
  parallelWorkers: 4,
  chunkSize: 524288,       // 512KB — MTProto standard max
  proxyEnabled: false,
  proxyDomain: 'tg-ws-api.hashhackersapi.workers.dev',  // Default proxy worker domain
  autoChunkSize: false,
  bestChunkSize: null,     // Auto-detected best chunk size (set by auto-tuning)
};

export function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw);
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function getChunkSizeOptions() {
  return CHUNK_SIZES;
}

export function getDefaults() {
  return { ...DEFAULTS };
}

/**
 * Auto-tune chunk size by trying different sizes and measuring throughput.
 * @param {Function} downloadTestChunk - async function(chunkSize) that downloads a test chunk and returns { bytes, ms }
 * @returns {number} The best performing chunk size
 */
export async function autoTuneChunkSize(downloadTestChunk) {
  const settings = getSettings();
  const sizesToTry = [524288, 262144, 131072]; // Try 512K, 256K, 128K
  let bestSize = 524288;
  let bestSpeed = 0;

  for (const size of sizesToTry) {
    try {
      const result = await downloadTestChunk(size);
      const speed = result.bytes / (result.ms / 1000); // bytes/sec
      if (speed > bestSpeed) {
        bestSpeed = speed;
        bestSize = size;
      }
    } catch {
      // This size failed, try smaller
      continue;
    }
  }

  settings.bestChunkSize = bestSize;
  settings.autoChunkSize = true;
  saveSettings(settings);
  return bestSize;
}
