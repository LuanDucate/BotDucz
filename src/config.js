const fs = require('fs');
const path = require('path');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) return override;
  if (!isPlainObject(override)) return base;

  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = deepMerge(base[key], value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function loadJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const DEFAULT_CONFIG = {
  bot: {
    presence: {
      idleText: '+help',
      playingSuffix: '| +help',
      maxActivityLength: 128,
      status: 'online',
    },
    autoLeave: {
      defaultMinutes: 2,
    },
    ui: {
      dismissTimeoutMs: 5 * 60 * 1000,
      queueRefreshIntervalMs: 4000,
      queuePageSize: 8,
      favoritesPreviewLimit: 20,
      myInstantsSuggestionButtons: 3,
      myInstantsSearchPerTerm: 5,
      myInstantsSelectionTimeoutMs: 60 * 1000,
      clearBulkDeleteAgeDays: 14,
      soundCloudProgressScanLimit: 30,
    },
    commands: {
      defaultPrefixes: ['+Ducz', '+d', '+p', '+play', '+skip', '+stop', '+i', '+fav', '+efeito', '+efeitos', '+effect', '+ef', '+fila', '+queue', '+clear', '+help'],
    },
  },
  sources: {
    resolution: {
      maxItems: 30,
      concurrency: 5,
    },
    youtube: {
      playlistMaxVideos: 50,
      artistSearchResults: 15,
    },
    spotify: {
      collectionMaxTracks: 500,
      initialBatchSize: 1,
      batchSize: 15,
      initialResolveConcurrency: 1,
      batchResolveConcurrency: 15,
    },
    soundcloud: {
      resolveConcurrency: 2,
      firstBatchSize: 1,
      batchSize: 5,
      finalStatusDeleteDelayMs: 5000,
    },
  },
  musicQueue: {
    defaultEffectIntensity: 5,
    cleanupOldStreamDelayMs: 250,
    maxHistoryItems: 100,
    navCooldownMs: 350,
    voiceReconnectWaitMs: 5000,
    ipDiscoveryLogCooldownMs: 30 * 1000,
  },
};

const configDir = path.join(__dirname, '..', 'config');
const botJson = loadJsonFile(path.join(configDir, 'bot.json'));
const sourcesJson = loadJsonFile(path.join(configDir, 'sources.json'));
const musicQueueJson = loadJsonFile(path.join(configDir, 'musicQueue.json'));

const APP_CONFIG = {
  bot: deepMerge(DEFAULT_CONFIG.bot, botJson),
  sources: deepMerge(DEFAULT_CONFIG.sources, sourcesJson),
  musicQueue: deepMerge(DEFAULT_CONFIG.musicQueue, musicQueueJson),
};

module.exports = {
  APP_CONFIG,
};
