//oi
require('dotenv').config();

// Configurar o FFmpeg bundled ANTES de importar @discordjs/voice
const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  REST,
  Routes,
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { extractMp3Url, searchMyInstants } = require('./src/myinstants');
const { downloadMp3 } = require('./src/utils');
const {
  getYouTubeTitle,
  getPlaylistVideos,
  isPlaylistUrl,
  resolveYouTubeSearch,
  resolveYouTubeSearchMany,
} = require('./src/youtube');
const {
  getSoundCloudPlaylistTracksStream,
  resolveSoundCloudTrackDetails,
} = require('./src/soundcloud');
const {
  getSpotifyCollectionTrackQueriesApi,
  getSpotifyCollectionTrackQueriesFromEmbed,
  getSpotifyCollectionTrackQueriesFallback,
  getSpotifyOEmbedTitle,
  getSpotifyTrackSearchQuery,
} = require('./src/spotify');
const {
  addYouTube,
  addPlaylist,
  playSfx,
  skip,
  stop,
  leave,
  getQueue,
  jumpTo,
  getEffectList,
  getIntensityEffectList,
  effectSupportsIntensity,
  getEffectDescriptions,
  setEffect,
  getEffect,
  setEffectIntensity,
  getEffectIntensity,
  applyEffectNow,
  stopSfx,
  refreshNowPlayingMessage,
  getNowPlayingMessageId,
  setNowPlayingAnchorEnabled,
  setOnSongChangedCallback,
  leaveSilently,
} = require('./src/musicQueue');
const { toggleLoop, getLoop, playPrevious, buildMusicControlRow } = require('./src/musicQueue');

// Evita rodar duas instâncias na mesma máquina (cria um lock file)
const lockFilePath = path.join(__dirname, 'bot.lock');
const BOT_VERSION = '2.0.0';
const BOT_BUILD_TAG = `v${BOT_VERSION}`;

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // No permission to signal the process? Ele ainda existe, apenas não podemos tocá-lo.
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function killProcess(pid) {
  try {
    process.kill(pid);
    return true;
  } catch {
    // Tentativa extra em Windows caso process.kill não funcione
    try {
      execSync(`taskkill /PID ${pid} /F /T`);
      return true;
    } catch {
      return false;
    }
  }
}

function ensureSingleInstance() {
  const currentPid = process.pid;

  // Tenta encerrar instância antiga baseada no lockfile
  if (fs.existsSync(lockFilePath)) {
    const pid = Number(fs.readFileSync(lockFilePath, 'utf-8'));
    if (pid && pid !== currentPid && isProcessRunning(pid)) {
      console.warn(`⚠️ Instância antiga detectada (PID ${pid}). Tentando encerrar...`);
      const killed = killProcess(pid);
      if (!killed && isProcessRunning(pid)) {
        console.error(`❌ Não foi possível encerrar a instância antiga (PID ${pid}).`);
        console.error('   Feche os processos Node manualmente e inicie o bot novamente.');
        process.exit(1);
      }
    }
  }

  // No Windows, limitar a apenas UMA instância rodando index.js.
  // Isso ajuda a evitar processos antigos que continuam respondendo aos comandos.
  if (process.platform === 'win32') {
    try {
      const output = execSync(
        'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /FORMAT:LIST',
        { encoding: 'utf8' }
      );

      const matches = [...output.matchAll(/ProcessId=(\d+)/g)].map((m) => Number(m[1]));
      for (const pid of matches) {
        if (!pid || pid === currentPid) continue;
        // Para checar se é o bot, buscamos 'index.js' na saída completa
        const blockRegex = new RegExp(`ProcessId=${pid}[\\s\\S]*?CommandLine=(.*?)(?:\\r?\\n\\r?\\n|$)`, 'i');
        const m = output.match(blockRegex);
        const cmd = m ? (m[1] || '') : '';
        if (cmd.includes('index.js')) {
          const killed = killProcess(pid);
          if (!killed && isProcessRunning(pid)) {
            console.error(`❌ Não foi possível encerrar processo antigo do bot (PID ${pid}).`);
            process.exit(1);
          }
        }
      }
    } catch {
      // ignore se wmic não estiver disponível / falhar
    }
  }

  fs.writeFileSync(lockFilePath, String(currentPid), 'utf-8');

  const cleanup = () => {
    try {
      if (!fs.existsSync(lockFilePath)) return;
      const lockPid = Number(fs.readFileSync(lockFilePath, 'utf-8'));
      if (lockPid === currentPid) {
        fs.unlinkSync(lockFilePath);
      }
    } catch {}
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('uncaughtException', (err) => {
    // EPIPE e EOF podem acontecer ao trocar streams (ffmpeg/yt-dlp) rapidamente.
    // Não queremos encerrar o bot por isso.
    const msg = String(err?.message || err || '').toLowerCase();
    if (
      err &&
      (
        err.code === 'EPIPE' ||
        err.code === 'EOF' ||
        err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        msg.includes('premature close')
      )
    ) {
      console.warn('⚠️ Ignorando erro de pipe/EOF (stream fechada)');
      return;
    }

    console.error('❌ Exceção não tratada:', err);
    process.exit(1);
  });
}

async function shutdownBot() {
  // Mata instância antiga (se houver) antes de encerrar esta.
  if (fs.existsSync(lockFilePath)) {
    const oldPid = Number(fs.readFileSync(lockFilePath, 'utf-8'));
    if (oldPid && oldPid !== process.pid && isProcessRunning(oldPid)) {
      killProcess(oldPid);
    }
  }

  try {
    await client.destroy();
  } catch {
    // ignorar falhas na destruição
  }

  // Dá tempo para enviar mensagens de confirmação antes de sair.
  setTimeout(() => process.exit(0), 250);
}

ensureSingleInstance();

// ============================================================
// Configuração
// ============================================================
const PREFIXES = ['+Ducz', '+d'];
const MYINSTANTS_REGEX = /https?:\/\/(www\.)?myinstants\.com\/(pt\/)?instant\/[\w\-]+\/?/i;
const YOUTUBE_REGEX = /https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/i;
const SOUNDCLOUD_REGEX = /https?:\/\/([a-z]+\.)?soundcloud\.com\//i;
const SOUNDCLOUD_SET_REGEX = /https?:\/\/([a-z]+\.)?soundcloud\.com\/[^\/]+\/sets\//i;
const SPOTIFY_TRACK_REGEX = /https?:\/\/(open\.)?spotify\.com\/(intl-[^\/]+\/)?track\//i;
const SPOTIFY_COLLECTION_REGEX = /https?:\/\/(open\.)?spotify\.com\/(intl-[^\/]+\/)?(playlist|album)\//i;
const SPOTIFY_ARTIST_REGEX = /https?:\/\/(open\.)?spotify\.com\/(intl-[^\/]+\/)?artist\//i;
const spotifyLoadSessions = new Map();
const soundCloudResolveQueues = new Map();
const activeSoundCloudProgressMessages = new Map();
const soundCloudProgressRenderPromises = new Map();
const soundCloudProgressAnchorMessageIds = new Map();
const autoLeaveTimers = new Map();
const DEFAULT_AUTO_LEAVE_MINUTES = 2;
const parsedAutoLeaveMinutes = Number.parseFloat(process.env.AUTO_LEAVE_MINUTES || '');
const AUTO_LEAVE_MINUTES = Number.isFinite(parsedAutoLeaveMinutes) && parsedAutoLeaveMinutes > 0
  ? parsedAutoLeaveMinutes
  : DEFAULT_AUTO_LEAVE_MINUTES;
const AUTO_LEAVE_GRACE_MS = Math.round(AUTO_LEAVE_MINUTES * 60 * 1000);
const SOUNDCLOUD_PROGRESS_REGEX = /^(📋 SoundCloud:|✅ SoundCloud:|📋 Lendo playlist do SoundCloud)/;

function getHumanCount(channel) {
  if (!channel) return 0;

  const guild = channel.guild;
  const channelId = channel.id;
  if (guild?.voiceStates?.cache && channelId) {
    let count = 0;
    for (const state of guild.voiceStates.cache.values()) {
      if (state.channelId !== channelId) continue;
      if (state.member?.user?.bot) continue;
      count += 1;
    }
    return count;
  }

  if (!channel.members) return 0;
  let count = 0;
  for (const member of channel.members.values()) {
    if (!member.user?.bot) {
      count += 1;
    }
  }
  return count;
}

function clearAutoLeaveTimer(guildId) {
  const timer = autoLeaveTimers.get(guildId);
  if (timer) {
    clearTimeout(timer);
    autoLeaveTimers.delete(guildId);
  }
}

function scheduleAutoLeave(guild, channelId, reason = 'sozinho no canal') {
  if (!guild?.id) return;
  const guildId = guild.id;
  clearAutoLeaveTimer(guildId);

  const timer = setTimeout(async () => {
    autoLeaveTimers.delete(guildId);
    const me = guild.members.me;
    const currentChannelId = me?.voice?.channelId;
    if (!currentChannelId || currentChannelId !== channelId) return;

    const currentChannel = guild.channels.cache.get(currentChannelId);
    if (getHumanCount(currentChannel) > 0) return;

    clearSpotifyLoadSession(guildId);
    activeSoundCloudProgressMessages.delete(guildId);
    soundCloudProgressRenderPromises.delete(guildId);
    soundCloudProgressAnchorMessageIds.delete(guildId);
    updateBotPresence(null);
    const left = leaveSilently(guildId);
    if (left) {
      console.log(`👋 Auto-leave [${guildId}] por ${reason}.`);
    }
  }, AUTO_LEAVE_GRACE_MS);

  autoLeaveTimers.set(guildId, timer);
}

async function handleBotVoiceMove(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  const newChannel = newState.channel;
  const newHumans = getHumanCount(newChannel);

  if (newChannel && newHumans > 0) {
    clearAutoLeaveTimer(guild.id);
    return;
  }

  if (newChannel && newHumans === 0) {
    scheduleAutoLeave(guild, newChannel.id, 'movido para canal vazio');
    return;
  }

  // Desconectado do canal de voz.
  clearAutoLeaveTimer(guild.id);
  clearSpotifyLoadSession(guild.id);
  activeSoundCloudProgressMessages.delete(guild.id);
  soundCloudProgressRenderPromises.delete(guild.id);
  soundCloudProgressAnchorMessageIds.delete(guild.id);
  updateBotPresence(null);
}

async function cleanupStaleSoundCloudProgressMessages(channel, keepMessageId = null) {
  if (!channel?.messages?.fetch || !client.user?.id) return;
  const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  if (!recent) return;

  const deletions = [];
  for (const msg of recent.values()) {
    if (msg.id === keepMessageId) continue;
    if (msg.author?.id !== client.user.id) continue;
    if (!SOUNDCLOUD_PROGRESS_REGEX.test(String(msg.content || ''))) continue;
    deletions.push(msg.delete().catch(() => {}));
  }

  if (deletions.length > 0) {
    await Promise.allSettled(deletions);
  }
}

async function upsertSoundCloudProgressMessage(message, content, opts = {}) {
  const guildId = message.guildId;
  const forceResend = Boolean(opts?.forceResend);
  const previousRender = soundCloudProgressRenderPromises.get(guildId) || Promise.resolve();

  const renderPromise = previousRender
    .catch(() => {})
    .then(async () => {
      const tracked = activeSoundCloudProgressMessages.get(guildId);
      const trackedMessage = tracked?.message || null;

      let nextMessage = null;
      if (trackedMessage && !forceResend) {
        nextMessage = await trackedMessage.edit(content).catch(() => null);
      }

      if (trackedMessage && forceResend) {
        await trackedMessage.delete().catch(() => {});
        activeSoundCloudProgressMessages.delete(guildId);
      }

      if (!nextMessage) {
        const anchorMessageId = soundCloudProgressAnchorMessageIds.get(guildId) || message?.id || null;
        const sendPayload = anchorMessageId
          ? {
              content,
              reply: {
                messageReference: anchorMessageId,
                failIfNotExists: false,
              },
            }
          : { content };
        nextMessage = await message.channel.send(sendPayload).catch(() => null);
      }

      if (!nextMessage) return trackedMessage;

      activeSoundCloudProgressMessages.set(guildId, {
        id: nextMessage.id,
        message: nextMessage,
        content,
      });
      await cleanupStaleSoundCloudProgressMessages(nextMessage.channel, nextMessage.id).catch(() => {});
      return nextMessage;
    });

  soundCloudProgressRenderPromises.set(guildId, renderPromise);
  return renderPromise;
}

async function bumpActiveSoundCloudProgressForGuild(guildId, song = null) {
  updateBotPresence(song?.title || null);
  const entry = activeSoundCloudProgressMessages.get(guildId);
  if (!entry?.message || !entry?.content || !String(entry.content).includes('⏳')) {
    await refreshNowPlayingMessage(guildId, { forceResend: true }).catch(() => {});
    return;
  }

  await upsertSoundCloudProgressMessage(entry.message, entry.content, { forceResend: true }).catch(() => {});
  await refreshNowPlayingMessage(guildId, { forceResend: true }).catch(() => {});
}

setOnSongChangedCallback((guildId, song) => bumpActiveSoundCloudProgressForGuild(guildId, song));

function updateBotPresence(songTitle = null) {
  if (!client.user) return;

  const title = String(songTitle || '').trim();
  const activityName = title ? `${title} | +help`.slice(0, 128) : '+help';
  client.user.setPresence({
    activities: [{ name: activityName, type: 2 }],
    status: 'online',
  });
}

function enqueueSoundCloudTrackResolve(guildId, track) {
  if (!guildId || !track || !track.needsResolve) return;

  if (!soundCloudResolveQueues.has(guildId)) {
    soundCloudResolveQueues.set(guildId, {
      active: 0,
      pending: [],
      seen: new Set(),
    });
  }

  const queue = soundCloudResolveQueues.get(guildId);
  const key = String(track.url || '').trim();
  if (!key || queue.seen.has(key)) return;
  queue.seen.add(key);
  queue.pending.push(track);

  const pump = () => {
    while (queue.active < 2 && queue.pending.length > 0) {
      const nextTrack = queue.pending.shift();
      queue.active += 1;

      resolveSoundCloudTrackDetails(nextTrack.url)
        .then(async (resolved) => {
          if (resolved) {
            nextTrack.url = resolved.url;
            nextTrack.title = resolved.title;
            nextTrack.needsResolve = false;
            await refreshNowPlayingMessage(guildId).catch(() => {});
            await refreshQueueMessagesForGuild(guildId).catch(() => {});
          }
        })
        .catch(() => {})
        .finally(() => {
          queue.active -= 1;
          pump();
        });
    }
  };

  pump();
}

function startSpotifyLoadSession(guildId) {
  const token = Symbol(`spotify-load-${guildId}`);
  spotifyLoadSessions.set(guildId, token);
  return token;
}

function isSpotifyLoadSessionActive(guildId, token) {
  return spotifyLoadSessions.get(guildId) === token;
}

function clearSpotifyLoadSession(guildId, token = null) {
  if (!spotifyLoadSessions.has(guildId)) return;
  if (token && spotifyLoadSessions.get(guildId) !== token) return;
  spotifyLoadSessions.delete(guildId);
}

async function resolveQueriesToVideos(queries, { maxItems = 30, concurrency = 5 } = {}) {
  const capped = queries.slice(0, Math.max(1, maxItems));
  const results = [];

  for (let i = 0; i < capped.length; i += concurrency) {
    const chunk = capped.slice(i, i + concurrency);
    const resolvedChunk = await Promise.all(
      chunk.map(async (q) => {
        try {
          return await resolveYouTubeSearch(q);
        } catch {
          return null;
        }
      })
    );
    for (const item of resolvedChunk) {
      if (item) results.push(item);
    }
  }

  return results;
}

// ============================================================
// Cliente Discord
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

// Prefixos padrão (inclui +p, +play, +skip, +stop, +i, +efeito/+ef e +fila/+queue)
const DEFAULT_PREFIXES = ['+Ducz', '+d', '+p', '+play', '+skip', '+stop', '+i', '+fav', '+efeito', '+efeitos', '+effect', '+ef', '+fila', '+queue', '+clear', '+help'];

// IDs de usuário (Discord) autorizados a usar +killbot
// Adicione aqui outros IDs separados por vírgula, se quiser.
const BOT_OWNER_IDS = new Set(
  (process.env.BOT_OWNER_IDS || '269292404308181003')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

if (BOT_OWNER_IDS.size === 0) {
  console.warn('⚠️ AVISO: a variável BOT_OWNER_IDS não está definida. +killbot ficará disponível para qualquer usuário.');
}

function isOwner(userId) {
  return BOT_OWNER_IDS.size === 0 || BOT_OWNER_IDS.has(userId);
}

// Arquivo de configuração de prefixos por guild
const prefixesFile = path.join(__dirname, 'prefixes.json');
let guildPrefixes = {};

function loadPrefixes() {
  try {
    const raw = fs.readFileSync(prefixesFile, 'utf-8');
    guildPrefixes = JSON.parse(raw || '{}');
  } catch {
    guildPrefixes = {};
  }
}

function savePrefixes() {
  try {
    fs.writeFileSync(prefixesFile, JSON.stringify(guildPrefixes, null, 2), 'utf-8');
  } catch (err) {
    console.error('Erro ao salvar prefixes.json:', err.message);
  }
}

function getPrefixes(guildId) {
  const custom = guildPrefixes[guildId] || [];
  return Array.from(new Set([...DEFAULT_PREFIXES, ...custom]));
}

function addPrefix(guildId, prefix) {
  if (!guildPrefixes[guildId]) guildPrefixes[guildId] = [];
  if (!guildPrefixes[guildId].includes(prefix)) {
    guildPrefixes[guildId].push(prefix);
    savePrefixes();
  }
}

function removePrefix(guildId, prefix) {
  if (!guildPrefixes[guildId]) return;
  guildPrefixes[guildId] = guildPrefixes[guildId].filter((p) => p !== prefix);
  if (guildPrefixes[guildId].length === 0) delete guildPrefixes[guildId];
  savePrefixes();
}

function setPrefixes(guildId, prefixes) {
  guildPrefixes[guildId] = prefixes;
  savePrefixes();
}

// Favoritos do MyInstants (persistidos em favorites.json)
const favoritesFilePath = path.join(__dirname, 'favorites.json');
const SHARED_FAVORITES_KEY = 'shared';
let favoritesByUser = {};

function sanitizeFavoriteEntry(entry) {
  if (typeof entry === 'string') {
    const query = entry.trim();
    return query ? { query } : null;
  }

  if (!entry || typeof entry !== 'object') return null;
  const query = String(entry.query || '').trim();
  if (!query) return null;
  const createdAt = entry.createdAt ? String(entry.createdAt) : undefined;
  return createdAt ? { query, createdAt } : { query };
}

function normalizeFavoritesStore(rawData) {
  const store = rawData && typeof rawData === 'object' ? rawData : {};
  const merged = [];
  const seen = new Set();

  const pushUnique = (item) => {
    const normalized = sanitizeFavoriteEntry(item);
    if (!normalized) return;
    const key = normalizeFavQuery(normalized.query);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(normalized);
  };

  const shared = Array.isArray(store[SHARED_FAVORITES_KEY]) ? store[SHARED_FAVORITES_KEY] : [];
  for (const item of shared) pushUnique(item);

  for (const value of Object.values(store)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) pushUnique(item);
  }

  return { [SHARED_FAVORITES_KEY]: merged };
}

function loadFavorites() {
  try {
    const raw = fs.readFileSync(favoritesFilePath, 'utf-8');
    favoritesByUser = normalizeFavoritesStore(JSON.parse(raw || '{}'));
    saveFavorites();
  } catch {
    favoritesByUser = { [SHARED_FAVORITES_KEY]: [] };
  }
}

function saveFavorites() {
  try {
    fs.writeFileSync(favoritesFilePath, JSON.stringify(favoritesByUser, null, 2), 'utf-8');
  } catch (err) {
    console.error('Erro ao salvar favorites.json:', err.message);
  }
}

function getFavorites(userId) {
  return favoritesByUser[SHARED_FAVORITES_KEY] || [];
}

function normalizeFavQuery(query) {
  return String(query || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function addFavoriteQuery(userId, query) {
  const normalized = normalizeFavQuery(query);
  if (!normalized) return { added: false, reason: 'empty' };

  const favs = getFavorites(userId);
  const existingIndex = favs.findIndex((f) => {
    if (typeof f === 'string') return normalizeFavQuery(f) === normalized;
    return normalizeFavQuery(f?.query) === normalized;
  });

  if (existingIndex >= 0) {
    return { added: false, duplicate: true, index: existingIndex + 1 };
  }

  const entry = { query: query.trim(), createdAt: new Date().toISOString() };
  const index = addFavorite(userId, entry);
  return { added: true, index };
}

function removeFavoriteQuery(userId, query) {
  const normalized = normalizeFavQuery(query);
  if (!normalized) return { removed: false, reason: 'empty' };

  const favs = getFavorites(userId);
  const existingIndex = favs.findIndex((f) => {
    if (typeof f === 'string') return normalizeFavQuery(f) === normalized;
    return normalizeFavQuery(f?.query) === normalized;
  });

  if (existingIndex < 0) return { removed: false, missing: true };
  removeFavorite(userId, existingIndex);
  return { removed: true, index: existingIndex + 1 };
}

function getFavoriteEntryByIndex(userId, index1Based) {
  const favs = getFavorites(userId);
  const idx = index1Based - 1;
  if (idx < 0 || idx >= favs.length) return null;
  const item = favs[idx];
  if (typeof item === 'string') return { query: item };
  if (item && typeof item.query === 'string') return { query: item.query, createdAt: item.createdAt };
  return null;
}

function addFavorite(userId, fav) {
  if (!favoritesByUser[SHARED_FAVORITES_KEY]) favoritesByUser[SHARED_FAVORITES_KEY] = [];
  favoritesByUser[SHARED_FAVORITES_KEY].push(fav);
  saveFavorites();
  return favoritesByUser[SHARED_FAVORITES_KEY].length;
}

function removeFavorite(userId, index) {
  const favs = getFavorites(userId);
  if (index < 0 || index >= favs.length) return false;
  favs.splice(index, 1);
  favoritesByUser[SHARED_FAVORITES_KEY] = favs;
  saveFavorites();
  return true;
}

loadFavorites();
startQueueLiveRefresh();

// Mapa temporário de escolhas de sugestões do MyInstants
// Chave: userId (garante apenas UMA seleção por usuário)
// Valor: { messageId, selectionMessage, options, timeoutId, searchQuery }
const pendingMyInstantsSelection = new Map();

// Mapa temporário para sinalizar botões de ação (favoritar / repetir)
// Chave: messageId
// Valor: { userId, favoriteData?, repeatQuery?, timeoutId }
const pendingMyInstantsActions = new Map();

// Mapa para reagir em +i com repetição do som (🦆)
// Chave: mensagem do usuário que executou o +i
// Valor: { mp3Url, displayName, collector }
const pendingSfxRepeats = new Map();
// Mensagem de fila exibida com botão de descartar
// Chave: mensagem do bot
// Valor: { userId, timeoutId, page, message, lastSignature }
const pendingQueueMessages = new Map();
// Mensagem de efeitos exibida com botão de descartar
// Chave: mensagem do bot
// Valor: { userId, timeoutId }
const pendingEffectMessages = new Map();
// Mensagem de help exibida com botão de fechar
// Chave: mensagem do bot
// Valor: { userId, timeoutId }
const pendingHelpMessages = new Map();
function cleanupPendingSfxRepeat(messageId) {
  const entry = pendingSfxRepeats.get(messageId);
  if (!entry) return;

  if (entry.collector) {
    try {
      entry.collector.stop();
    } catch {}
  }

  const duckReaction = entry.sourceMessage?.reactions?.cache?.find(
    (r) => r.emoji?.name === '🦆'
  );
  if (duckReaction) {
    duckReaction.remove().catch(() => {});
  }

  pendingSfxRepeats.delete(messageId);
}

function cleanupPendingSfxRepeatsByUser(guildId, userId) {
  for (const [messageId, entry] of pendingSfxRepeats.entries()) {
    if (entry?.guildId !== guildId) continue;
    if (userId && entry?.userId !== userId) continue;
    cleanupPendingSfxRepeat(messageId);
  }
}

function setupSfxRepeat(
  reactionMessage,
  mp3Url,
  displayName,
  favoriteQuery = null,
  ownerUserId = null,
  playbackMessage = null
) {
  if (!reactionMessage || !mp3Url || typeof reactionMessage.createReactionCollector !== 'function') return;

  const actionMessage = playbackMessage || reactionMessage;
  const commandMessage = reactionMessage;
  cleanupPendingSfxRepeat(reactionMessage.id);

  const sendFavoriteFeedback = async (entry, content) => {
    if (!entry) return;

    if (entry.favoriteStatusMessage && typeof entry.favoriteStatusMessage.edit === 'function') {
      await entry.favoriteStatusMessage.edit(content).catch(() => {});
      return;
    }

    const msg = await commandMessage.reply(content).catch(() => null);
    if (msg) entry.favoriteStatusMessage = msg;
  };

  // Adiciona reação de pato para permitir repetir.
  reactionMessage.react('🦆').catch(() => {});
  // Adiciona estrela para favoritar rapidamente a busca feita em +i.
  reactionMessage.react('⭐').catch(() => {});

  const filter = (reaction, user) => {
    if (!reaction || !user) return false;
    // Ignora reações do próprio bot
    if (user.id === reactionMessage.client?.user?.id) return false;
    return reaction.emoji.name === '🦆' || reaction.emoji.name === '⭐';
  };

  const collector = reactionMessage.createReactionCollector({ filter, dispose: true });
  collector.on('collect', async (reaction, user) => {
    const entry = pendingSfxRepeats.get(reactionMessage.id);
    if (!entry) return;

    if (reaction.emoji.name === '⭐') {
      const favQuery = entry.favoriteQuery || entry.displayName;
      const addResult = addFavoriteQuery(user.id, favQuery);
      if (addResult.added) {
        await sendFavoriteFeedback(entry, `⭐ Favorito salvo (#${addResult.index}): **${favQuery}**`);
      }
      return;
    }

    // Remover reação de pato do usuário para permitir novos cliques no 🦆
    reaction.users.remove(user.id).catch(() => {});

    // Evita repetição duplicada em cliques simultâneos, mas permite novos cliques depois.
    if (entry.repeatInFlight) return;
    entry.repeatInFlight = true;

    // Repetir o som
    try {
      const tmpFile = await downloadMp3(entry.mp3Url);
      await playSfx(entry.commandMessage || commandMessage, tmpFile, entry.displayName);
    } catch (err) {
      console.error('❌ Erro ao repetir som:', err);
    } finally {
      entry.repeatInFlight = false;
    }
  });

  collector.on('remove', async (reaction, user) => {
    const entry = pendingSfxRepeats.get(reactionMessage.id);
    if (!entry) return;
    if (reaction.emoji.name !== '⭐') return;

    const favQuery = entry.favoriteQuery || entry.displayName;
    const removeResult = removeFavoriteQuery(user.id, favQuery);
    if (removeResult.removed) {
      await sendFavoriteFeedback(entry, `🗑️ Favorito removido (#${removeResult.index}): **${favQuery}**`);
    }
  });

  collector.on('end', () => {
    pendingSfxRepeats.delete(reactionMessage.id);
  });

  pendingSfxRepeats.set(reactionMessage.id, {
    mp3Url,
    displayName,
    favoriteQuery,
    guildId: actionMessage.guildId,
    sourceMessage: reactionMessage,
    commandMessage,
    playbackMessage: actionMessage,
    userId: ownerUserId || actionMessage.author?.id,
    repeatInFlight: false,
    favoriteStatusMessage: null,
    collector,
  });
}

function cleanupPendingSelectionForUser(userId) {
  const entry = pendingMyInstantsSelection.get(userId);
  if (!entry) return;

  if (entry.timeoutId) {
    clearTimeout(entry.timeoutId);
  }
  if (entry.selectionMessage) {
    entry.selectionMessage.delete().catch(() => {});
  }
  pendingMyInstantsSelection.delete(userId);
}

async function showQueueMessage(message, page = 0, existingMessage = null) {
  const existingEntry = existingMessage ? pendingQueueMessages.get(existingMessage.id) : null;
  const requesterId = existingEntry?.userId || message?.author?.id || message?.user?.id || '0';

  if (!existingMessage) {
    const cleanupTasks = [];
    for (const [messageId, entry] of pendingQueueMessages.entries()) {
      if (!entry?.message) continue;
      if (entry.userId !== requesterId) continue;
      if (entry.message.guildId !== message.guildId) continue;
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      pendingQueueMessages.delete(messageId);
      cleanupTasks.push(entry.message.delete().catch(() => {}));
    }
    if (cleanupTasks.length > 0) {
      await Promise.allSettled(cleanupTasks);
    }
  }

  const { current, queue } = getQueue(message.guildId);
  if (!current && queue.length === 0) {
    if (existingMessage && existingEntry) {
      pendingQueueMessages.delete(existingMessage.id);
      if (existingEntry.timeoutId) clearTimeout(existingEntry.timeoutId);
      return existingMessage.edit({ content: '📋 A fila está vazia.', components: [] }).catch(() => null);
    }
    return message.reply('📋 A fila está vazia.');
  }

  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(queue.length / pageSize));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);

  let text = '';
  if (current) text += `🎶 **Tocando agora:** ${current.title}\n\n`;
  if (queue.length > 0) {
    text += `📋 **Fila (${queue.length}):**\n`;
    const start = normalizedPage * pageSize;
    const pageItems = queue.slice(start, start + pageSize);
    pageItems.forEach((song, i) => {
      text += `**${start + i + 1}.** ${song.title}\n`;
    });
    if (queue.length > start + pageSize) {
      text += `\n...e mais ${queue.length - (start + pageSize)} música(s)`;
    }
  }

  const components = [];
  const row = new ActionRowBuilder();

  // Navegação de páginas
  if (normalizedPage > 0) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_prev_${requesterId}_${normalizedPage - 1}`)
        .setLabel('Anterior')
        .setStyle(ButtonStyle.Primary)
    );
  }

  if (queue.length > (normalizedPage + 1) * pageSize) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_next_${requesterId}_${normalizedPage + 1}`)
        .setLabel('Próxima')
        .setStyle(ButtonStyle.Primary)
    );
  }

  // Botão para abrir modal de tocar por número
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_play_${requesterId}`)
      .setLabel('Tocar (#)')
      .setStyle(ButtonStyle.Success)
  );

  // Botão para descartar a mensagem
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_dismiss_${requesterId}`)
      .setLabel('Descartar')
      .setStyle(ButtonStyle.Secondary)
  );

  components.push(row);

  const signature = `${normalizedPage}|${current?.title || ''}|${queue.length}|${text}`;
  if (existingMessage && existingEntry?.lastSignature === signature) {
    return existingMessage;
  }

  const reply = existingMessage
    ? await existingMessage.edit({ content: text, components }).catch(() => null)
    : await message.reply({ content: text, components }).catch(() => null);

  if (!reply) return;

  let timeoutId = existingEntry?.timeoutId;
  if (!timeoutId) {
    timeoutId = setTimeout(() => {
      pendingQueueMessages.delete(reply.id);
    }, 5 * 60 * 1000);
  }

  pendingQueueMessages.set(reply.id, {
    userId: requesterId,
    timeoutId,
    page: normalizedPage,
    message: reply,
    lastSignature: signature,
  });
}

async function sendDismissableEffectMessage(message, content) {
  const requesterId = message?.author?.id || message?.user?.id || '0';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`effects_dismiss_${requesterId}`)
      .setLabel('Descartar')
      .setStyle(ButtonStyle.Secondary)
  );

  const sent = await message.reply({ content, components: [row] }).catch(() => null);
  if (!sent) return null;

  const timeoutId = setTimeout(() => {
    pendingEffectMessages.delete(sent.id);
  }, 5 * 60 * 1000);

  pendingEffectMessages.set(sent.id, {
    userId: requesterId,
    timeoutId,
  });

  return sent;
}

async function sendDismissableHelpMessage(message) {
  const requesterId = message?.author?.id || message?.user?.id || '0';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`help_dismiss_${requesterId}`)
      .setLabel('Fechar')
      .setStyle(ButtonStyle.Secondary)
  );

  const sent = await message.reply({ embeds: [buildHelpEmbed()], components: [row] }).catch(() => null);
  if (!sent) return null;

  const timeoutId = setTimeout(() => {
    pendingHelpMessages.delete(sent.id);
  }, 5 * 60 * 1000);

  pendingHelpMessages.set(sent.id, {
    userId: requesterId,
    timeoutId,
  });

  return sent;
}

function startQueueLiveRefresh() {
  const INTERVAL_MS = 4000;
  setInterval(async () => {
    for (const [messageId, entry] of pendingQueueMessages.entries()) {
      if (!entry?.message) continue;
      try {
        await showQueueMessage(entry.message, entry.page || 0, entry.message);
      } catch {
        if (entry.timeoutId) clearTimeout(entry.timeoutId);
        pendingQueueMessages.delete(messageId);
      }
    }
  }, INTERVAL_MS);
}

async function jumpToQueue(message, position) {
  const { queue } = getQueue(message.guildId);
  if (!queue.length) {
    return message.reply('❌ A fila está vazia. Use `+fila` para ver as músicas.');
  }
  if (!Number.isFinite(position) || position < 1) {
    return message.reply('❌ Número inválido. Use um número válido da fila.');
  }
  if (position > queue.length) {
    return message.reply(`❌ A fila tem apenas **${queue.length}** música(s). Não existe a posição **${position}**.`);
  }

  const success = await jumpTo(message.guildId, position);
  if (!success) {
    return message.reply('❌ Número inválido ou fila vazia. Use `+fila` para ver as músicas.');
  }
  await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
  return message.reply(`▶️ Indo para a música #${position} da fila...`);
}

async function refreshQueueMessagesForGuild(guildId) {
  const tasks = [];
  for (const [messageId, entry] of pendingQueueMessages.entries()) {
    if (!entry?.message || entry.message.guildId !== guildId) continue;
    tasks.push(
      showQueueMessage(entry.message, entry.page || 0, entry.message).catch(() => {
        if (entry.timeoutId) clearTimeout(entry.timeoutId);
        pendingQueueMessages.delete(messageId);
      })
    );
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

function parseClearDuration(raw) {
  const m = String(raw || '').trim().toLowerCase().match(/^(\d+)\s*([mhd])$/);
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return amount * multiplier;
}

async function clearBotMessagesByDuration(message, rawDuration) {
  const windowMs = parseClearDuration(rawDuration);
  if (!windowMs) {
    return message.reply('❌ Formato inválido. Use: `+clear 1m`, `+clear 2h` ou `+clear 1d`.');
  }

  const channel = message.channel;
  if (!channel || !channel.messages?.fetch) {
    return message.reply('❌ Não consegui acessar as mensagens deste canal.');
  }

  const botId = client.user?.id;
  if (!botId) {
    return message.reply('❌ Bot ainda não está pronto para limpar mensagens.');
  }

  const now = Date.now();
  const cutoff = now - windowMs;
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const activeNowPlayingMessageId = getNowPlayingMessageId(message.guildId);
  const activeSoundCloudProgressId = activeSoundCloudProgressMessages.get(message.guildId)?.id || null;

  let beforeId = null;
  let scanned = 0;
  let deleted = 0;
  let preservedActive = 0;
  let reachedCutoff = false;

  while (true) {
    const fetched = await channel.messages
      .fetch(beforeId ? { limit: 100, before: beforeId } : { limit: 100 })
      .catch(() => null);
    if (!fetched || fetched.size === 0) break;

    const batch = Array.from(fetched.values());
    scanned += batch.length;

    const bulkIds = [];
    const singleDelete = [];

    for (const msg of batch) {
      if (msg.createdTimestamp < cutoff) {
        reachedCutoff = true;
        break;
      }
      if (msg.author?.id !== botId) continue;

      const keepActiveNowPlaying =
        Boolean(activeNowPlayingMessageId) && msg.id === activeNowPlayingMessageId;
      const keepActiveSoundCloudProgress =
        Boolean(activeSoundCloudProgressId) && msg.id === activeSoundCloudProgressId;
      if (keepActiveSoundCloudProgress) {
        continue;
      }
      if (keepActiveNowPlaying) {
        preservedActive += 1;
        continue;
      }

      if (now - msg.createdTimestamp < fourteenDaysMs) {
        bulkIds.push(msg.id);
      } else {
        singleDelete.push(msg);
      }
    }

    if (bulkIds.length > 0) {
      for (let i = 0; i < bulkIds.length; i += 100) {
        const chunk = bulkIds.slice(i, i + 100);
        const result = await channel.bulkDelete(chunk, true).catch(() => null);
        deleted += result?.size || 0;
      }
    }

    for (const msg of singleDelete) {
      const ok = await msg.delete().then(() => true).catch(() => false);
      if (ok) deleted += 1;
    }

    beforeId = batch[batch.length - 1]?.id;
    if (!beforeId || reachedCutoff) break;
  }

  await refreshQueueMessagesForGuild(message.guildId).catch(() => {});

  return message.reply(
    `🧹 Limpeza concluída: **${deleted}** mensagem(ns) do bot removida(s) nos últimos **${rawDuration}**. ` +
      `Mantidas ativas: **${preservedActive}**.`
  );
}

// ============================================================
// Embed de ajuda
// ============================================================
function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎵 BotDucz — +help')
    .setDescription(
      'Central de ajuda do BotDucz: reproduza áudio de **MyInstants, YouTube, SoundCloud e Spotify** com fila, efeitos e atalhos.'
    )
    .addFields(
      {
        name: '▶️ Tocar um som do MyInstants (link)',
        value:
          '```\n+i <link-do-myinstants>\n```\nExemplo: `+i https://www.myinstants.com/pt/instant/briga-de-gato-25101/`',
      },
      {
        name: '🔍 Buscar e tocar um som do MyInstants',
        value:
          '```\n+i <descrição do som>\n```\nExemplo: `+i briga de gato`\n💡 *Sons do MyInstants tocam instantaneamente, mesmo com música do YouTube!*',
      },
      {
        name: '🎬 Tocar áudio por link (YouTube/SoundCloud/Spotify)',
        value:
          '```\n+d <link-do-youtube|soundcloud|spotify-track|spotify-playlist|spotify-album|spotify-artist>\n```\nExemplo: `+d https://www.youtube.com/watch?v=dQw4w9WgXcQ`\nAlias: `+play <link>`',
      },
      {
        name: '🔎 Buscar e tocar do YouTube',
        value:
          '```\n+d <nome da música>\n```\nExemplo: `+d nirvana smells like teen spirit`\nAlias: `+play <busca>`',
      },
      {
        name: '📋 Playlist do YouTube',
        value:
          '```\n+d <link-da-playlist>\n```\nColoque um link com `&list=` e todas as músicas serão adicionadas à fila!',
      },
      {
        name: '⏭️ Pular música',
        value: '```\n+d skip\n```',
      },
      {
        name: '📋 Ver fila de músicas',
        value: '```\n+d fila\n```',
      },
      {
        name: '⏹️ Parar e limpar fila',
        value: '```\n+d parar\n```',
      },
      {
        name: '🎛️ Efeitos de áudio',
        value:
          '```\n+efeito <nome> [1-10]\n+ef <nome> [1-10]\n+ef\n+ef <1-10>\n+ef status\n+ef off\n+ef lista\n+efeitos\n```\nEx: `+efeito robot 8`, `+ef robot 8`, `+ef`',
      },
      {
        name: '🧠 Funcionalidades',
        value:
          '• Pesquisa YouTube e MyInstants\n' +
          '• Suporte a playlist do YouTube\n' +
          '• Fila com paginação e botão "Tocar (#)"\n' +
          '• Jump para posição da fila (`+fila <n>`)\n' +
          '• Efeitos com intensidade por nível\n' +
          '• Repetição rápida de SFX via reação 🦆\n' +
          '• Favoritar busca do +i via ⭐ e executar com `+fav`',
      },
      {
        name: '⚙️ Administração',
        value:
          '```\n+d prefix\n+d prefix add <novo_prefixo>\n+d prefix remove <prefixo>\n+d prefix reset\n+killbot\n```\n`+killbot` é restrito ao dono do bot.',
      },
      {
        name: '🧩 Slash Commands (/)',
        value:
          '```\n/play query:<texto|link>\n/instants query:<texto|link myinstants>\n/queue [posicao]\n/skip\n/stop\n/effect acao:<ativar|off|status|lista> [nome] [intensidade]\n/prefix acao:<view|add|remove|reset> [valor]\n/leave\n/help\n/killbot\n```',
      },
      {
        name: '🚪 Sair do canal de voz',
        value: '```\n+d sair\n```',
      },
      {
        name: '❓ Mostrar ajuda',
        value: '```\n+help\n+d ajuda\n```',
      },
      {
        name: '👤 Créditos',
        value:
          'Criado por **Luam Ducate** (github/luanducate)\n' +
          'Com colaboração de **Bryan Christen** (github/bryan-christen)',
      }
    )
    .setFooter({ text: 'BotDucz • +help e /help para abrir este painel' });
}

async function sendEphemeralMessage(message, content, { ephemeral = false } = {}) {
  if (!message) return;

  // Em interações (slash commands), usamos o modo “ephemeral” nativo do Discord.
  if (ephemeral && message?.isInteraction) {
    try {
      return await message.reply({ content, ephemeral: true });
    } catch {
      // Se não suportar, ignora e usa fallback.
    }
  }

  // Fallback: apenas envia uma resposta normal (sem botão / sem exclusão automática).
  if (typeof message.reply === 'function') {
    return message.reply({ content });
  }
  if (message.channel) {
    return message.channel.send(content);
  }
}

function normalizeSearchTerms(query) {
  const stopWords = new Set(['de', 'do', 'da', 'dos', 'das', 'e', 'o', 'a', 'um', 'uma', 'por', 'para', 'com']);
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\wÀ-ÿ]/g, ''))
    .filter((w) => w.length >= 2 && !stopWords.has(w));
}

function createInteractionMessageAdapter(interaction) {
  let replied = false;
  return {
    isInteraction: true,
    guild: interaction.guild,
    guildId: interaction.guildId,
    member: interaction.member,
    channel: interaction.channel,
    author: interaction.user,
    reactions: {
      removeAll: () => Promise.resolve(),
    },
    react: () => Promise.resolve(),
    reply: (options) => {
      if (!replied) {
        replied = true;
        return interaction.reply({ ...options, fetchReply: true });
      }
      return interaction.followUp(options);
    },
  };
}

async function handleInstantsQuery(message, query) {
  const input = query.split(/\s+/)[0];

  // Link do MyInstants → toca instantaneamente (SFX)
  if (MYINSTANTS_REGEX.test(input)) {
    const mp3Url = await extractMp3Url(input);
    const tmpFile = await downloadMp3(mp3Url);
    const soundName = input
      .replace(/\/$/, '')
      .split('/')
      .pop()
      .replace(/-/g, ' ')
      .replace(/\d+$/, '')
      .trim();

    const sfxMessage = await playSfx(message, tmpFile, soundName);
    setupSfxRepeat(message, mp3Url, soundName, input, message.author?.id, sfxMessage || null);
    return;
  }

  // Pesquisa no MyInstants (texto)
  const results = await searchMyInstants(query, 5);
  if (!results || results.length === 0) {
    const suggestions = await getMyInstantsSuggestions(query, 3);
    if (!suggestions.length) {
      return sendEphemeralMessage(message, `❌ Nenhum som encontrado para: **${query}**`, { ephemeral: true });
    }

    return offerMyInstantsSelections(message, query, suggestions);
  }

  const result = results[0];
  const mp3Url = result.mp3Url ? result.mp3Url : await extractMp3Url(result.pageUrl);
  const tmpFile = await downloadMp3(mp3Url);
  const sfxMessage = await playSfx(message, tmpFile, result.title);
  setupSfxRepeat(message, mp3Url, result.title, query, message.author?.id, sfxMessage || null);
  return;
}

async function handlePlayQuery(message, query) {
  const input = query.split(/\s+/)[0];
  clearSpotifyLoadSession(message.guildId);

  try {
    // Link do SoundCloud: toca diretamente via yt-dlp
    if (SOUNDCLOUD_REGEX.test(input)) {
      if (SOUNDCLOUD_SET_REGEX.test(input)) {
        const scLoadToken = startSpotifyLoadSession(message.guildId);
        soundCloudProgressAnchorMessageIds.set(message.guildId, message.id);
        setNowPlayingAnchorEnabled(message.guildId, false);
        const previousProgressEntry = activeSoundCloudProgressMessages.get(message.guildId);
        if (previousProgressEntry?.message) {
          await previousProgressEntry.message.delete().catch(() => {});
        }
        activeSoundCloudProgressMessages.delete(message.guildId);
        soundCloudProgressRenderPromises.delete(message.guildId);
        await cleanupStaleSoundCloudProgressMessages(message.channel).catch(() => {});

        let progressMsg = await upsertSoundCloudProgressMessage(message, '📋 Lendo playlist do SoundCloud...').catch(() => null);
        let totalAdded = 0;
        const pending = [];

        // Flush pending buffer with deterministic batching:
        // - First batch: exactly 1 track (for instant 1st play)
        // - Subsequent batches: exactly 5 tracks each
        const flushPending = async (isFinal = false, maxPerBatch = 5) => {
          if (!pending.length) return;
          
          // On first flush (totalAdded === 0), take only first 1 track
          // On subsequent flushes, take up to maxPerBatch (5) tracks
          const batchSize = totalAdded === 0 ? 1 : maxPerBatch;
          const chunk = pending.splice(0, batchSize);
          
          if (!chunk.length) return;
          
          totalAdded += chunk.length;
          const statusText = isFinal
            ? `✅ SoundCloud: **${totalAdded}** faixas adicionadas à fila!`
            : `📋 SoundCloud: **${totalAdded}** faixas carregadas... ⏳`;

          await addPlaylist(message, chunk, { skipStatusMessage: true }).catch(() => null);
          progressMsg = await upsertSoundCloudProgressMessage(message, statusText).catch(() => progressMsg);

          for (const track of chunk) {
            enqueueSoundCloudTrackResolve(message.guildId, track);
          }
        };

        for await (const track of getSoundCloudPlaylistTracksStream(input)) {
          if (!isSpotifyLoadSessionActive(message.guildId, scLoadToken)) break;
          pending.push(track);
          
          // Flush deterministically:
          // - On first track: flush just that 1
          // - When pending reaches 5+ tracks after first: flush 5 at a time
          if (totalAdded === 0 || pending.length >= 5) {
            await flushPending();
          }
        }

        if (!isSpotifyLoadSessionActive(message.guildId, scLoadToken)) {
          const trackedProgressEntry = activeSoundCloudProgressMessages.get(message.guildId);
          if (trackedProgressEntry?.message) {
            await trackedProgressEntry.message.delete().catch(() => {});
          }
          activeSoundCloudProgressMessages.delete(message.guildId);
          soundCloudProgressRenderPromises.delete(message.guildId);
          soundCloudProgressAnchorMessageIds.delete(message.guildId);
          setNowPlayingAnchorEnabled(message.guildId, true);
          return;
        }

        // Flush any remaining tracks
        while (pending.length > 0) {
          await flushPending(false);
        }
        
        // Finalização: mantém a mensagem de progresso durante o carregamento
        // e remove apenas quando terminar tudo.
        if (totalAdded === 0) {
          const errText = '❌ Não consegui carregar essa playlist do SoundCloud.';
          const trackedProgressMsg = await upsertSoundCloudProgressMessage(message, errText).catch(() => progressMsg);
          if (trackedProgressMsg) progressMsg = trackedProgressMsg;
          else await message.reply(errText).catch(() => {});
          activeSoundCloudProgressMessages.delete(message.guildId);
          soundCloudProgressRenderPromises.delete(message.guildId);
          soundCloudProgressAnchorMessageIds.delete(message.guildId);
          setNowPlayingAnchorEnabled(message.guildId, true);
        } else {
          const successText = `✅ SoundCloud: **${totalAdded}** faixas adicionadas à fila!`;
          const finalMsg = await upsertSoundCloudProgressMessage(message, successText).catch(() => null);

          setNowPlayingAnchorEnabled(message.guildId, true);
          await refreshNowPlayingMessage(message.guildId, { forceResend: true }).catch(() => {});

          if (finalMsg?.id) {
            activeSoundCloudProgressMessages.set(message.guildId, {
              id: finalMsg.id,
              message: finalMsg,
              content: successText,
            });
            setTimeout(async () => {
              const tracked = activeSoundCloudProgressMessages.get(message.guildId);
              if (tracked?.id === finalMsg.id) {
                activeSoundCloudProgressMessages.delete(message.guildId);
              }
              soundCloudProgressRenderPromises.delete(message.guildId);
              soundCloudProgressAnchorMessageIds.delete(message.guildId);
              await finalMsg.delete().catch(() => {});
            }, 5000);
          } else {
            activeSoundCloudProgressMessages.delete(message.guildId);
            soundCloudProgressRenderPromises.delete(message.guildId);
            soundCloudProgressAnchorMessageIds.delete(message.guildId);
          }
        }

        clearSpotifyLoadSession(message.guildId, scLoadToken);
        return;
      }

      const title = await getYouTubeTitle(input);
      return addYouTube(message, input, title || 'faixa do SoundCloud');
    }

    // Link de faixa do Spotify: converte para busca no YouTube
    if (SPOTIFY_TRACK_REGEX.test(input)) {
      const spotifyQuery = await getSpotifyTrackSearchQuery(input);
      if (!spotifyQuery) {
        return message.reply('❌ Não consegui ler essa faixa do Spotify. Tente outro link de música.');
      }

      const resolved = await resolveYouTubeSearch(spotifyQuery);
      if (!resolved) {
        return message.reply('❌ Não consegui encontrar essa faixa do Spotify no YouTube.');
      }

      return addYouTube(message, resolved.url, resolved.title || `Spotify: ${spotifyQuery}`);
    }

    // Link de playlist/album do Spotify: extrai faixas e resolve para YouTube
    if (SPOTIFY_COLLECTION_REGEX.test(input)) {
      const loadToken = startSpotifyLoadSession(message.guildId);
      let progressMsg = await message.reply('📋 Lendo playlist/álbum do Spotify...').catch(() => null);
      console.log('📋 Spotify coleção detectada. Iniciando extração de faixas...');

      let trackQueries = await getSpotifyCollectionTrackQueriesFromEmbed(input, 500);

      // Fallback via API pública do Spotify quando disponível.
      if (!trackQueries.length) {
        trackQueries = await getSpotifyCollectionTrackQueriesApi(input, 500);
      }

      // Fallback para versões/ambientes onde API não responder.
      if (!trackQueries.length) {
        trackQueries = await getSpotifyCollectionTrackQueriesFallback(input, 500);
      }
      if (!trackQueries.length) {
        clearSpotifyLoadSession(message.guildId, loadToken);
        const errText = '❌ Não consegui extrair faixas dessa playlist/álbum do Spotify.';
        if (progressMsg) await progressMsg.edit(errText).catch(() => message.reply(errText).catch(() => {}));
        else await message.reply(errText).catch(() => {});
        return;
      }

      // Carrega tudo que conseguiu extrair, mas toca instantaneamente com 1 música primeiro.
      const targetQueries = trackQueries;
      const totalTarget = targetQueries.length;
      console.log(`📋 Spotify: ${totalTarget} faixa(s) alvo para resolver no YouTube.`);

      const seenUrls = new Set();
      const firstChunkSize = 1;
      const chunkSize = 15;
      const firstChunk = targetQueries.slice(0, firstChunkSize);

      const firstVideosRaw = await resolveQueriesToVideos(firstChunk, {
        maxItems: firstChunk.length,
        concurrency: 1,
      });
      if (!isSpotifyLoadSessionActive(message.guildId, loadToken)) return;

      const firstVideos = firstVideosRaw.filter((video) => {
        const key = String(video?.url || '').trim();
        if (!key || seenUrls.has(key)) return false;
        seenUrls.add(key);
        return true;
      });

      if (!firstVideos.length) {
        clearSpotifyLoadSession(message.guildId, loadToken);
        const errText = '❌ Não consegui encontrar músicas dessa playlist/álbum no YouTube.';
        if (progressMsg) await progressMsg.edit(errText).catch(() => message.reply(errText).catch(() => {}));
        else await message.reply(errText).catch(() => {});
        return;
      }

      let totalAdded = firstVideos.length;
      console.log(`📋 Spotify: ${totalAdded} faixa(s) resolvida(s) no lote inicial rápido.`);
      progressMsg = await addPlaylist(message, firstVideos, {
        editMsg: progressMsg,
        statusText: `📋 Spotify: tocando! Carregando mais... (**${totalAdded}**/${totalTarget}) ⏳`,
      });
      if (!isSpotifyLoadSessionActive(message.guildId, loadToken)) return;

      // Continua resolvendo e enfileirando em blocos até completar o alvo.
      for (let i = firstChunkSize; i < targetQueries.length; i += chunkSize) {
        if (!isSpotifyLoadSessionActive(message.guildId, loadToken)) return;

        const chunk = targetQueries.slice(i, i + chunkSize);
        const chunkVideosRaw = await resolveQueriesToVideos(chunk, {
          maxItems: chunk.length,
          concurrency: 15,
        });

        if (!isSpotifyLoadSessionActive(message.guildId, loadToken)) return;

        const chunkVideos = chunkVideosRaw.filter((video) => {
          const key = String(video?.url || '').trim();
          if (!key || seenUrls.has(key)) return false;
          seenUrls.add(key);
          return true;
        });

        if (!chunkVideos.length) continue;
        totalAdded += chunkVideos.length;
        const isFinal = i + chunkSize >= targetQueries.length;
        console.log(`📋 Spotify: +${chunkVideos.length} faixa(s) (${totalAdded}/${totalTarget}).`);
        progressMsg = await addPlaylist(message, chunkVideos, {
          editMsg: progressMsg,
          statusText: isFinal
            ? `✅ Spotify: **${totalAdded}** faixas adicionadas à fila!`
            : `📋 Spotify: **${totalAdded}**/${totalTarget} faixas carregadas... ⏳`,
        });
      }

      // Garante mensagem final mesmo se último bloco foi vazio
      if (progressMsg && typeof progressMsg.edit === 'function') {
        await progressMsg.edit(`✅ Spotify: **${totalAdded}** faixas adicionadas à fila!`).catch(() => {});
      }

      clearSpotifyLoadSession(message.guildId, loadToken);
      return;
    }

    // Link de artista do Spotify: enfileira uma seleção de músicas do artista
    if (SPOTIFY_ARTIST_REGEX.test(input)) {
      const artistTitleRaw = await getSpotifyOEmbedTitle(input);
      const artistName = String(artistTitleRaw || '')
        .replace(/\s+on\s+Spotify$/i, '')
        .replace(/\s+\|\s+Spotify$/i, '')
        .trim();

      if (!artistName) {
        return message.reply('❌ Não consegui identificar o artista nesse link do Spotify.');
      }

      const videos = await resolveYouTubeSearchMany(`${artistName} topic`, 15);
      if (!videos.length) {
        return message.reply('❌ Não encontrei músicas desse artista no YouTube.');
      }

      return addPlaylist(message, videos);
    }

    // Se for link do YouTube (vídeo ou playlist)
    if (YOUTUBE_REGEX.test(input)) {
      if (isPlaylistUrl(input)) {
        const ytProgressMsg = await message.reply('📋 Carregando playlist do YouTube...').catch(() => null);
        console.log('📋 Carregando playlist...');

        // Se a primeira tentativa falhar (lista vazia), tenta novamente uma vez.
        let videos = await getPlaylistVideos(input);
        if (!videos || videos.length === 0) {
          console.log('⚠️ Falha ao carregar playlist, tentando novamente...');
          videos = await getPlaylistVideos(input);
        }

        if (!videos || videos.length === 0) {
          console.log('❌ Não foi possível carregar a playlist.');
          if (ytProgressMsg) await ytProgressMsg.edit('❌ Não foi possível carregar a playlist.').catch(() => {});
          return;
        }

        return addPlaylist(message, videos, { editMsg: ytProgressMsg });
      }

      const title = await getYouTubeTitle(input);
      return addYouTube(message, input, title);
    }

    // Busca no YouTube por termo (padrão)
    const resolved = await resolveYouTubeSearch(query);
    if (!resolved) {
      return message.reply('❌ Não encontrei resultados para essa busca no YouTube.');
    }
    return addYouTube(message, resolved.url, resolved.title);
  } catch (error) {
    console.error('❌ Erro:', error.message);
    return message.reply(`❌ Erro: ${error.message}`);
  }
}

async function getMyInstantsSuggestions(query, maxOptions = 3) {
  const terms = normalizeSearchTerms(query);
  const seen = new Set();
  const results = [];

  for (const term of terms) {
    const found = await searchMyInstants(term, 5);
    for (const item of found) {
      const key = item.pageUrl || item.mp3Url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(item);
      if (results.length >= maxOptions) return results;
    }
    if (results.length >= maxOptions) break;
  }

  return results;
}

async function offerMyInstantsSelections(message, searchQuery, options) {
  const row = new ActionRowBuilder();
  const components = options.slice(0, 3).map((opt, index) =>
    new ButtonBuilder()
      .setCustomId(`myinstants_${index}`)
      .setLabel(`${index + 1}`)
      .setStyle(ButtonStyle.Primary)
  );

  row.addComponents(components);

  const description = options
    .slice(0, 3)
    .map((opt, index) => `**${index + 1}.** ${opt.title}`)
    .join('\n');

  // Se já existir uma seleção pendente para o usuário, atualiza em vez de criar outra
  const existing = pendingMyInstantsSelection.get(message.author.id);
  if (existing) {
    if (existing.timeoutId) clearTimeout(existing.timeoutId);

    existing.selectionMessage
      .edit({
        content: `❌ Nenhum som exato encontrado para **${searchQuery}**. Talvez você quis:\n${description}`,
        components: [row],
      })
      .catch(() => {});

    existing.options = options.slice(0, 3);
    existing.timeoutId = setTimeout(() => {
      pendingMyInstantsSelection.delete(message.author.id);
      existing.selectionMessage.delete().catch(() => {});
    }, 60_000);

    return;
  }

  const reply = await message.reply({
    content: `❌ Nenhum som exato encontrado para **${searchQuery}**. Talvez você quis:\n${description}`,
    components: [row],
  });

  const timeoutId = setTimeout(() => {
    const entry = pendingMyInstantsSelection.get(message.author.id);
    if (!entry) return;
    pendingMyInstantsSelection.delete(message.author.id);
    reply.delete().catch(() => {});
  }, 60_000);

  pendingMyInstantsSelection.set(message.author.id, {
    messageId: reply.id,
    originMessage: message,
    selectionMessage: reply,
    options: options.slice(0, 3),
    searchQuery,
    timeoutId,
  });
}

// ============================================================
// Slash commands (aparecem no menu / do Discord)
// ============================================================
const slashCommands = [
  {
    name: 'play',
    description: 'Toca audio por busca ou link (YouTube, SoundCloud, Spotify)',
    options: [
      {
        name: 'query',
        type: 3, // STRING
        description: 'Link ou texto para tocar',
        required: true,
      },
    ],
  },
  {
    name: 'instants',
    description: 'Toca som do MyInstants por texto ou link',
    options: [
      {
        name: 'query',
        type: 3, // STRING
        description: 'Texto de busca ou link do MyInstants',
        required: true,
      },
    ],
  },
  { name: 'skip', description: 'Pula a música atual' },
  { name: 'stop', description: 'Para e limpa a fila' },
  {
    name: 'queue',
    description: 'Mostra a fila de reprodução',
    options: [
      {
        name: 'posicao',
        type: 4, // INTEGER
        description: 'Opcional: pula para a posição da fila',
        required: false,
      },
    ],
  },
  {
    name: 'effect',
    description: 'Controla efeitos de áudio',
    options: [
      {
        name: 'acao',
        type: 3, // STRING
        description: 'Ação do efeito',
        required: true,
        choices: [
          { name: 'ativar', value: 'ativar' },
          { name: 'off', value: 'off' },
          { name: 'status', value: 'status' },
          { name: 'lista', value: 'lista' },
        ],
      },
      {
        name: 'nome',
        type: 3, // STRING
        description: 'Nome do efeito (obrigatório em ativar)',
        required: false,
      },
      {
        name: 'intensidade',
        type: 4, // INTEGER
        description: 'Intensidade de 1 a 10 (quando suportado)',
        required: false,
        min_value: 1,
        max_value: 10,
      },
    ],
  },
  {
    name: 'prefix',
    description: 'Gerencia prefixos personalizados da guild',
    options: [
      {
        name: 'acao',
        type: 3, // STRING
        description: 'Ação de prefixo',
        required: true,
        choices: [
          { name: 'view', value: 'view' },
          { name: 'add', value: 'add' },
          { name: 'remove', value: 'remove' },
          { name: 'reset', value: 'reset' },
        ],
      },
      {
        name: 'valor',
        type: 3, // STRING
        description: 'Prefixo para add/remove',
        required: false,
      },
    ],
  },
  { name: 'leave', description: 'Faz o bot sair do canal de voz' },
  { name: 'help', description: 'Mostra a ajuda do bot' },
  { name: 'killbot', description: 'Encerra a instância do bot (dono somente)' },
];

async function registerSlashCommands() {
  if (!process.env.DISCORD_TOKEN) return;
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), {
        body: slashCommands,
      });
    } catch (err) {
      console.error('Erro ao registrar comandos (/):', err.message || err);
    }
  }
}

// ============================================================
// Evento: Bot pronto
// ============================================================
function onClientReady() {
  console.log(`✅ BotDucz está online como ${client.user.tag}`);
  console.log(`📡 Conectado a ${client.guilds.cache.size} servidor(es)`);
  console.log(`🧩 BotDucz ${BOT_BUILD_TAG}`);  
  console.log(`🕒 Auto-leave sozinho: ${AUTO_LEAVE_MINUTES} minuto(s)`);
  updateBotPresence(null);
  loadPrefixes();
  registerSlashCommands();
}

client.once('clientReady', onClientReady);

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || !client.user) return;
  const botId = client.user.id;

  // Evento do próprio bot (foi movido/desconectado/conectado)
  if (newState.id === botId) {
    await handleBotVoiceMove(oldState, newState);
    return;
  }

  // Evento de outros usuários: se impactou o canal do bot, recalcular ocupação.
  const botChannelId = guild.members.me?.voice?.channelId;
  if (!botChannelId) return;

  const impacted = oldState.channelId === botChannelId || newState.channelId === botChannelId;
  if (!impacted) return;

  const botChannel = guild.channels.cache.get(botChannelId);
  const humans = getHumanCount(botChannel);
  if (humans > 0) {
    clearAutoLeaveTimer(guild.id);
  } else {
    scheduleAutoLeave(guild, botChannelId, 'canal ficou vazio');
  }
});

// ============================================================
// Evento: Mensagem recebida
// ============================================================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Verificar prefixo (suporta prefixes personalizados por guilda)
  // Preferir prefixes mais longos primeiro (ex: +play antes de +p)
  const prefixes = getPrefixes(message.guildId).sort((a, b) => b.length - a.length);
  let usedPrefix = null;
  for (const p of prefixes) {
    if (message.content.toLowerCase().startsWith(p.toLowerCase())) {
      const nextChar = message.content[p.length];
      const lower = p.toLowerCase();
      const requiresSpace = ['+p', '+play', '+d', '+i', '+fav', '+efeito', '+efeitos', '+effect', '+ef', '+clear'].includes(lower);
      if (requiresSpace && nextChar && !/\s/.test(nextChar)) continue;
      usedPrefix = p;
      break;
    }
  }
  if (!usedPrefix) return;

  // Suporte a comandos como +skip / +stop sem precisar do +d
  const normalizedPrefix = usedPrefix.toLowerCase();
  if (normalizedPrefix === '+skip') {
    const result = await skip(message);
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
    return result;
  }
  if (normalizedPrefix === '+stop') {
    clearSpotifyLoadSession(message.guildId);
    const result = await stop(message);
    updateBotPresence(null);
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
    return result;
  }
  if (normalizedPrefix === '+clear') {
    const raw = message.content.slice(usedPrefix.length).trim();
    return clearBotMessagesByDuration(message, raw);
  }
  if (normalizedPrefix === '+help') return sendDismissableHelpMessage(message);

  if (normalizedPrefix === '+fav') {
    const raw = message.content.slice(usedPrefix.length).trim();
    const favs = getFavorites();

    if (!raw) {
      if (!favs.length) {
        return message.reply('⭐ A lista compartilhada ainda não tem favoritos. Use `+i <texto>` e clique na reação ⭐ para salvar.');
      }

      const lines = favs.slice(0, 20).map((f, i) => {
        const q = typeof f === 'string' ? f : f.query;
        return `**${i + 1}.** ${q}`;
      });

      return message.reply(
        `⭐ **Favoritos compartilhados**\n${lines.join('\n')}\n\n` +
          'Use `+fav <número>` para tocar um favorito.\n' +
          'Use `+fav remove <número>` para remover.'
      );
    }

    const removeMatch = raw.match(/^(remove|rm|del)\s+(\d+)$/i);
    if (removeMatch) {
      const index = Number(removeMatch[2]);
      const ok = removeFavorite(null, index - 1);
      return message.reply(ok ? `✅ Favorito #${index} removido.` : '❌ Número inválido.');
    }

    if (/^\d+$/.test(raw)) {
      const index = Number(raw);
      const fav = getFavoriteEntryByIndex(null, index);
      if (!fav) return message.reply('❌ Favorito não encontrado nesse número.');
      return handleInstantsQuery(message, fav.query);
    }

    const needle = normalizeFavQuery(raw);
    const idx = favs.findIndex((f) => {
      const q = typeof f === 'string' ? f : f.query;
      return normalizeFavQuery(q).includes(needle);
    });

    if (idx < 0) {
      return message.reply('❌ Não encontrei favorito com esse texto. Use `+fav` para listar.');
    }

    const chosen = favs[idx];
    const query = typeof chosen === 'string' ? chosen : chosen.query;
    return handleInstantsQuery(message, query);
  }

  if (normalizedPrefix === '+fila' || normalizedPrefix === '+queue') {
    const remaining = message.content.slice(usedPrefix.length).trim();
    const target = Number(remaining);
    if (remaining && !Number.isNaN(target) && target >= 1) {
      const result = await jumpToQueue(message, target);
      await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
      return result;
    }
    return showQueueMessage(message);
  }

  if (normalizedPrefix === '+efeito' || normalizedPrefix === '+efeitos' || normalizedPrefix === '+effect' || normalizedPrefix === '+ef') {
    const rawArgs = message.content.slice(usedPrefix.length).trim().toLowerCase();
    const parts = rawArgs.split(/\s+/);
    const list = getEffectList();
    const intensityList = getIntensityEffectList();
    const descriptions = getEffectDescriptions();
    const currentEffect = getEffect(message.guildId);
    const currentIntensity = getEffectIntensity(message.guildId);

    const listWithDescriptions = list
      .map((name) => `• **${name}**: ${descriptions[name] || 'Sem descrição.'}`)
      .join('\n');

    if (!rawArgs) {
      return sendDismissableEffectMessage(
        message,
        `🎸 Efeitos disponíveis:\n${listWithDescriptions}\n\n` +
        `Intensidade 1-10: ${intensityList.join(', ')}\n` +
        `Use \`+efeito <nome> [1-10]\` ou \`+ef <nome> [1-10]\` para ativar.\n` +
        `Use \`+efeito lista\` ou \`+ef lista\` para ver esta lista novamente.\n` +
        `Efeito ativo: **${currentEffect || 'nenhum'}** | Intensidade: **${currentIntensity}/10**`
      );
    }

    if (parts[0] === 'lista' || parts[0] === 'list') {
      return sendDismissableEffectMessage(
        message,
        `🎛️ **Lista de efeitos**\n${listWithDescriptions}\n\n` +
        `Comando: \`+efeito <nome> [1-10]\` ou \`+ef <nome> [1-10]\``
      );
    }

    // Só um número: muda intensidade do efeito atual
    const firstNum = parseInt(parts[0], 10);
    const isOnlyNumberToken = /^\d+$/.test(parts[0]);
    if (parts.length === 1 && isOnlyNumberToken && !isNaN(firstNum) && firstNum >= 1 && firstNum <= 10) {
      if (!currentEffect) {
        return message.reply('ℹ️ Nenhum efeito ativo. Ative um efeito primeiro com `+efeito <nome>` ou `+ef <nome>`.');
      }
      if (!effectSupportsIntensity(currentEffect)) {
        return message.reply(`ℹ️ O efeito **${currentEffect}** não usa intensidade. Ele tem configuração fixa.`);
      }
      setEffectIntensity(message.guildId, firstNum);
      const appliedNow = applyEffectNow(message.guildId);
      return message.reply(
        appliedNow
          ? `🎛️ Intensidade do efeito **${currentEffect}** alterada para **${firstNum}/10** e aplicada imediatamente.`
          : `🎛️ Intensidade do efeito **${currentEffect}** alterada para **${firstNum}/10**.`
      );
    }

    const effect = parts[0];
    const rawI = parts[1] ? parseInt(parts[1], 10) : null;
    const intensity = (rawI !== null && !isNaN(rawI) && rawI >= 1 && rawI <= 10) ? rawI : null;

    if (effect === 'status') {
      return message.reply(
        currentEffect
          ? `🎛️ Efeito atual: **${currentEffect}** | Intensidade: **${currentIntensity}/10**`
          : '🎛️ Nenhum efeito ativo.'
      );
    }

    console.log(`🎛️ [guild ${message.guildId}] comando +efeito -> ${effect} (intensidade: ${intensity ?? currentIntensity})`);

    if (effect === 'off' || effect === 'none') {
      if (!currentEffect) {
        return message.reply('ℹ️ O efeito já está desativado.');
      }

      setEffect(message.guildId, null);
      const appliedNow = applyEffectNow(message.guildId);
      return message.reply(
        appliedNow
          ? '✅ Efeitos desativados e aplicado à música atual.'
          : '✅ Efeitos desativados.'
      );
    }

    if (!list.includes(effect)) {
      return message.reply(`❌ Efeito desconhecido. Use um dos: ${list.join(', ')}\nDica: \`+efeito <nome> <1-10>\` ou \`+ef <nome> <1-10>\`.`);
    }

    if (intensity !== null && effectSupportsIntensity(effect)) {
      setEffectIntensity(message.guildId, intensity);
    }

    // Mesmo efeito ativo sem nova intensidade = sem mudança
    if (currentEffect === effect && intensity === null) {
      return message.reply(`ℹ️ O efeito **${effect}** já está ativo (intensidade ${currentIntensity}/10). Use \`+efeito ${effect} <1-10>\` ou \`+ef ${effect} <1-10>\` para mudar a intensidade.`);
    }

    setEffect(message.guildId, effect);
    const appliedNow = applyEffectNow(message.guildId);
    const supportsIntensity = effectSupportsIntensity(effect);
    const effectiveIntensity = getEffectIntensity(message.guildId);
    return message.reply(
      appliedNow
        ? supportsIntensity
          ? `✅ Efeito **${effect}** (intensidade ${effectiveIntensity}/10) ativado e aplicado imediatamente.`
          : `✅ Efeito **${effect}** ativado e aplicado imediatamente (intensidade não aplicável).`
        : supportsIntensity
          ? `✅ Efeito **${effect}** (intensidade ${effectiveIntensity}/10) ativado. Vale para as próximas músicas.`
          : `✅ Efeito **${effect}** ativado. Vale para as próximas músicas (intensidade não aplicável).`
    );
  }

  const args = message.content.slice(usedPrefix.length).trim();
  if (!args) return sendDismissableHelpMessage(message);

  // +i = pesquisa MyInstants
  if (normalizedPrefix === '+i') {
    return handleInstantsQuery(message, args);
  }

  // ---- Comandos simples ----
  const argsParts = args.split(/\s+/);
  const cmd = argsParts[0].toLowerCase();

  if (cmd === 'ajuda') return sendDismissableHelpMessage(message);
  if (cmd === 'parar' || cmd === 'stop') {
    clearSpotifyLoadSession(message.guildId);
    const result = await stop(message, (text) => sendEphemeralMessage(message, text));
    updateBotPresence(null);
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
    return result;
  }
  if (cmd === 'sair') {
    clearSpotifyLoadSession(message.guildId);
    const result = leave(message);
    updateBotPresence(null);
    return result;
  }
  if (cmd === 'skip' || cmd === 'pular') {
    const result = await skip(message, (text) => sendEphemeralMessage(message, text));
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
    return result;
  }
  if (cmd === 'clear') {
    const rawDuration = argsParts[1] || '';
    return clearBotMessagesByDuration(message, rawDuration);
  }
  if (cmd === 'killbot') {
    if (!isOwner(message.author.id)) {
      return sendEphemeralMessage(message, '❌ Apenas o dono pode usar +killbot.');
    }

    await sendEphemeralMessage(message, '🛑 killbot: encerrando instâncias (local + antiga) ...');
    await shutdownBot();
  }

  // Prefixo personalizado (por guilda)
  if (cmd === 'prefix') {
    const sub = argsParts[1]?.toLowerCase();
    if (!sub) {
      const custom = guildPrefixes[message.guildId] || [];
      return message.reply(
        `Prefixos atuais: ${getPrefixes(message.guildId).join(', ')}\n` +
          `Prefixos personalizados: ${custom.length ? custom.join(', ') : 'nenhum'}\n` +
          'Use `+d prefix add <prefixo>` ou `+d prefix remove <prefixo>` para ajustar.'
      );
    }

    if (sub === 'add' && argsParts[2]) {
      const newP = argsParts[2];
      addPrefix(message.guildId, newP);
      return message.reply(`✅ Prefixo **${newP}** adicionado!`);
    }

    if (sub === 'remove' && argsParts[2]) {
      const remP = argsParts[2];
      removePrefix(message.guildId, remP);
      return message.reply(`✅ Prefixo **${remP}** removido!`);
    }

    if (sub === 'reset') {
      setPrefixes(message.guildId, []);
      return message.reply('✅ Prefixos personalizados removidos (volta ao padrão).');
    }

    return message.reply('✅ Uso: `+d prefix [add|remove|reset] <prefixo>`');
  }

  if (cmd === 'fila' || cmd === 'queue') {
    return showQueueMessage(message);
  }

  // ---- Detectar tipo de input ----
  try {
    await handlePlayQuery(message, args);
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
  } catch (error) {
    console.error('❌ Erro:', error.message);
    await message.reactions.removeAll().catch(() => {});
    await message.react('❌');

    if (error.message === 'VOICE_NOT_CONNECTED') {
      return message.reply(
        '❌ Você precisa estar em um **canal de voz** para usar este comando!'
      );
    }
    if (error.message === 'VOICE_NO_PERMISSION') {
      return message.reply(
        '❌ Não tenho permissão para **conectar** ou **falar** nesse canal de voz!'
      );
    }
    if (error.message === 'VOICE_TIMEOUT') {
      return message.reply('❌ Não consegui conectar ao canal de voz. Tente novamente.');
    }

    message.reply(`❌ Erro: ${error.message}`);
  }
});

// ============================================================
// Comandos via / (slash)
// ============================================================
client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const msg = createInteractionMessageAdapter(interaction);
    const cmd = interaction.commandName;

    if (cmd === 'play') {
      const query = interaction.options.getString('query');
      if (!query) return interaction.reply({ content: 'Digite algo para tocar.', ephemeral: true });
      const result = await handlePlayQuery(msg, query);
      await refreshQueueMessagesForGuild(msg.guildId).catch(() => {});
      return result;
    }

    if (cmd === 'instants') {
      const query = interaction.options.getString('query');
      if (!query) return interaction.reply({ content: 'Digite algo para tocar.', ephemeral: true });
      return handleInstantsQuery(msg, query);
    }

    if (cmd === 'skip') {
      const result = await skip(msg, (text) => msg.reply({ content: text, ephemeral: true }));
      await refreshQueueMessagesForGuild(msg.guildId).catch(() => {});
      return result;
    }

    if (cmd === 'stop') {
      clearSpotifyLoadSession(msg.guildId);
      const result = await stop(msg, (text) => msg.reply({ content: text, ephemeral: true }));
      updateBotPresence(null);
      await refreshQueueMessagesForGuild(msg.guildId).catch(() => {});
      return result;
    }

    if (cmd === 'queue') {
      const targetPos = interaction.options.getInteger('posicao');
      if (targetPos && targetPos >= 1) {
        return jumpToQueue(msg, targetPos);
      }
      return showQueueMessage(msg);
    }

    if (cmd === 'effect') {
      const action = interaction.options.getString('acao');
      const effect = interaction.options.getString('nome')?.toLowerCase() || null;
      const intensity = interaction.options.getInteger('intensidade');
      const list = getEffectList();
      const descriptions = getEffectDescriptions();
      const currentEffect = getEffect(msg.guildId);
      const currentIntensity = getEffectIntensity(msg.guildId);

      if (action === 'lista') {
        const txt = list
          .map((name) => `• **${name}**: ${descriptions[name] || 'Sem descrição.'}`)
          .join('\n');
        return sendDismissableEffectMessage(
          msg,
          `🎛️ **Lista de efeitos**\n${txt}\n\nUse: /effect acao:ativar nome:<efeito> intensidade:<1-10>`
        );
      }

      if (action === 'status') {
        return msg.reply(
          currentEffect
            ? `🎛️ Efeito atual: **${currentEffect}** | Intensidade: **${currentIntensity}/10**`
            : '🎛️ Nenhum efeito ativo.'
        );
      }

      if (action === 'off') {
        if (!currentEffect) return msg.reply('ℹ️ O efeito já está desativado.');
        setEffect(msg.guildId, null);
        const appliedNow = applyEffectNow(msg.guildId);
        return msg.reply(appliedNow ? '✅ Efeitos desativados e aplicado à música atual.' : '✅ Efeitos desativados.');
      }

      if (!effect) {
        return msg.reply('❌ Em `ativar`, informe o nome do efeito em `nome`.');
      }
      if (!list.includes(effect)) {
        return msg.reply(`❌ Efeito desconhecido. Use /effect acao:lista para ver todos.`);
      }

      if (intensity !== null && intensity !== undefined && effectSupportsIntensity(effect)) {
        setEffectIntensity(msg.guildId, intensity);
      }

      if (currentEffect === effect && (intensity === null || intensity === undefined)) {
        return msg.reply(`ℹ️ O efeito **${effect}** já está ativo (intensidade ${currentIntensity}/10).`);
      }

      setEffect(msg.guildId, effect);
      const appliedNow = applyEffectNow(msg.guildId);
      const supportsIntensity = effectSupportsIntensity(effect);
      const effectiveIntensity = getEffectIntensity(msg.guildId);
      return msg.reply(
        appliedNow
          ? supportsIntensity
            ? `✅ Efeito **${effect}** (intensidade ${effectiveIntensity}/10) ativado e aplicado imediatamente.`
            : `✅ Efeito **${effect}** ativado e aplicado imediatamente (intensidade não aplicável).`
          : supportsIntensity
            ? `✅ Efeito **${effect}** (intensidade ${effectiveIntensity}/10) ativado.`
            : `✅ Efeito **${effect}** ativado (intensidade não aplicável).`
      );
    }

    if (cmd === 'prefix') {
      const action = interaction.options.getString('acao');
      const value = interaction.options.getString('valor');

      if (action === 'view') {
        const custom = guildPrefixes[msg.guildId] || [];
        return msg.reply(
          `Prefixos atuais: ${getPrefixes(msg.guildId).join(', ')}\n` +
            `Prefixos personalizados: ${custom.length ? custom.join(', ') : 'nenhum'}`
        );
      }

      if (action === 'add') {
        if (!value) return msg.reply('❌ Informe o valor do prefixo em `valor`.');
        addPrefix(msg.guildId, value);
        return msg.reply(`✅ Prefixo **${value}** adicionado.`);
      }

      if (action === 'remove') {
        if (!value) return msg.reply('❌ Informe o valor do prefixo em `valor`.');
        removePrefix(msg.guildId, value);
        return msg.reply(`✅ Prefixo **${value}** removido.`);
      }

      if (action === 'reset') {
        setPrefixes(msg.guildId, []);
        return msg.reply('✅ Prefixos personalizados removidos (volta ao padrão).');
      }
    }

    if (cmd === 'leave') {
      clearSpotifyLoadSession(msg.guildId);
      const result = leave(msg);
      updateBotPresence(null);
      return result;
    }

    if (cmd === 'killbot') {
      if (!isOwner(interaction.user.id)) {
        return interaction.reply({ content: '❌ Apenas o dono pode usar +killbot.', ephemeral: true });
      }
      await interaction.reply({ content: '🛑 Comando killbot recebido. Encerrando instância...', ephemeral: true });
      await shutdownBot();
    }

    if (cmd === 'help') {
      return sendDismissableHelpMessage(msg);
    }

    return interaction.reply({ content: 'Comando não reconhecido.', ephemeral: true });
  }

  // ============================================================
  // Modal submit (tocar por número)
  if (interaction.isModalSubmit()) {
    if (interaction.customId !== 'queue_play_modal') return;

    const positionValue = interaction.fields.getTextInputValue('queuePosition');
    const position = Number(positionValue);
    if (Number.isNaN(position) || position < 1) {
      return interaction.reply({ content: '❌ Número inválido. Use um número válido da fila.', ephemeral: true });
    }

    const { queue } = getQueue(interaction.guildId);
    if (!queue.length) {
      return interaction.reply({ content: '❌ A fila está vazia.', ephemeral: true });
    }
    if (position > queue.length) {
      return interaction.reply({
        content: `❌ A fila tem apenas **${queue.length}** música(s). Não existe a posição **${position}**.`,
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const success = await jumpTo(interaction.guildId, position);
    if (!success) {
      return interaction.editReply('❌ Não consegui ir para essa música. Tente abrir `+fila` novamente.');
    }

    await refreshQueueMessagesForGuild(interaction.guildId).catch(() => {});
    return interaction.editReply(`▶️ Indo para a música #${position} da fila...`);
  }

  // Interações (botões)
  // ============================================================
  if (!interaction.isButton()) return;

  if (interaction.customId.startsWith('sfx_stop_')) {
    const parts = interaction.customId.split('_');
    const guildId = parts[2];

    const stopped = stopSfx(guildId);
    if (!stopped) {
      return interaction.reply({ content: 'ℹ️ Nenhum instant está tocando agora.', ephemeral: true });
    }

    return interaction.deferUpdate();
  }

  // ---- Controles de música (⏮️ ⏹️ ⏭️ 🔁) ----
  if (interaction.customId.startsWith('music_prev_')) {
    const msgAdapter = createInteractionMessageAdapter(interaction);
    const success = playPrevious(msgAdapter);
    if (!success) {
      return interaction.reply({ content: '❌ Não há música anterior.', ephemeral: true });
    }
    await refreshQueueMessagesForGuild(msgAdapter.guildId).catch(() => {});
    return interaction.deferUpdate();
  }

  if (interaction.customId.startsWith('music_stop_')) {
    await interaction.deferUpdate();
    const msgAdapter = createInteractionMessageAdapter(interaction);
    clearSpotifyLoadSession(msgAdapter.guildId);
    await stop(msgAdapter, () => Promise.resolve());
    await refreshQueueMessagesForGuild(msgAdapter.guildId).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('music_skip_')) {
    await interaction.deferUpdate();
    const msgAdapter = createInteractionMessageAdapter(interaction);
    await skip(msgAdapter, () => Promise.resolve());
    await refreshQueueMessagesForGuild(msgAdapter.guildId).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('music_loop_')) {
    const guildId = interaction.customId.slice('music_loop_'.length);
    toggleLoop(guildId);
    const row = buildMusicControlRow(guildId);
    return interaction.update({ components: [row] });
  }

  if (interaction.customId.startsWith('myinstants_')) {
    const entry = pendingMyInstantsSelection.get(interaction.user.id);
    if (!entry || entry.messageId !== interaction.message.id) {
      return interaction.update({ content: '⏳ Seleção expirada. Tente novamente.', components: [] }).catch(() => {});
    }

    const index = Number(interaction.customId.split('_')[1]);
    const choice = entry.options[index];
    if (!choice) {
      return interaction.reply({ content: 'Opção inválida.', ephemeral: true });
    }

    pendingMyInstantsSelection.delete(interaction.user.id);
    if (entry.timeoutId) clearTimeout(entry.timeoutId);

    // Deleta a mensagem de seleção para não deixar “botões mortos” na conversa
    interaction.message.delete().catch(() => {});

    try {
      const mp3Url = choice.mp3Url ? choice.mp3Url : await extractMp3Url(choice.pageUrl);
      const tmpFile = await downloadMp3(mp3Url);
      const sfxMessage = await playSfx(entry.originMessage, tmpFile, choice.title);
      setupSfxRepeat(
        entry.originMessage,
        mp3Url,
        choice.title,
        entry.searchQuery || choice.title,
        entry.originMessage.author?.id,
        sfxMessage || null
      );
    } catch (err) {
      console.error('❌ Erro ao tocar escolha:', err);
      interaction.followUp({ content: '❌ Não foi possível tocar esse som.', ephemeral: true });
    }

    return;
  }

  if (interaction.customId.startsWith('queue_dismiss_')) {
    const entry = pendingQueueMessages.get(interaction.message.id);
    if (!entry) return interaction.deferUpdate();

    pendingQueueMessages.delete(interaction.message.id);
    if (entry.timeoutId) clearTimeout(entry.timeoutId);

    return interaction.message.delete().catch(() => {});
  }

  if (interaction.customId.startsWith('effects_dismiss_')) {
    const entry = pendingEffectMessages.get(interaction.message.id);
    if (!entry) return interaction.deferUpdate();

    pendingEffectMessages.delete(interaction.message.id);
    if (entry.timeoutId) clearTimeout(entry.timeoutId);

    return interaction.message.delete().catch(() => {});
  }

  if (interaction.customId.startsWith('help_dismiss_')) {
    const entry = pendingHelpMessages.get(interaction.message.id);
    if (!entry) return interaction.deferUpdate();

    pendingHelpMessages.delete(interaction.message.id);
    if (entry.timeoutId) clearTimeout(entry.timeoutId);

    return interaction.message.delete().catch(() => {});
  }

  if (interaction.customId.startsWith('queue_prev_') || interaction.customId.startsWith('queue_next_')) {
    const parts = interaction.customId.split('_');
    const nextPage = Number(parts[3]);
    const entry = pendingQueueMessages.get(interaction.message.id);
    if (!entry) return interaction.deferUpdate();

    // Atualiza a mensagem com a próxima página
    await showQueueMessage(interaction.message, nextPage, interaction.message);
    return interaction.deferUpdate();
  }

  if (interaction.customId.startsWith('queue_play_')) {
    const modal = new ModalBuilder()
      .setCustomId('queue_play_modal')
      .setTitle('Tocar música da fila')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('queuePosition')
            .setLabel('Número da música na fila')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ex: 5')
            .setRequired(true)
        )
      );

    return interaction.showModal(modal);
  }
});

// ============================================================
// Login
// ============================================================
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN não encontrado! Crie um arquivo .env com o token do bot.');
  console.error('   Copie o arquivo .env.example para .env e preencha com seu token.');
  process.exit(1);
}

client.login(token);

client.on('error', (err) => {
  console.error('⚠️ Erro no cliente Discord:', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Rejeição não tratada:', reason);
});
