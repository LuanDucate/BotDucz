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
  Partials,
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
const { APP_CONFIG } = require('./src/config');
const {
  addYouTube,
  addPlaylist,
  playSfx,
  skip,
  stop,
  leave,
  getQueue,
  getQueueFull,
  getPlaylistSnapshot,
  restorePlaylistSnapshot,
  removeCurrentSong,
  removeQueuePosition,
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
const { toggleLoop, getLoop, toggleLoopPlaylist, getLoopPlaylist, restartPlaylist, playPrevious, buildMusicControlRow } = require('./src/musicQueue');

// Evita rodar duas instâncias na mesma máquina (cria um lock file)
const lockFilePath = path.join(__dirname, 'bot.lock');
const BOT_VERSION = '2.1.0';
const BOT_BUILD_TAG = `v${BOT_VERSION}`;
const BOT_CFG = APP_CONFIG.bot;
const SOURCES_CFG = APP_CONFIG.sources;
let presenceHelpCommandHint = '+help';

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
  process.on('SIGINT', () => {
    shutdownBot().catch(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    shutdownBot().catch(() => process.exit(0));
  });
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

let shutdownInFlight = null;

async function shutdownBot() {
  if (shutdownInFlight) return shutdownInFlight;

  shutdownInFlight = (async () => {
  // Mata instância antiga (se houver) antes de encerrar esta.
  if (fs.existsSync(lockFilePath)) {
    const oldPid = Number(fs.readFileSync(lockFilePath, 'utf-8'));
    if (oldPid && oldPid !== process.pid && isProcessRunning(oldPid)) {
      killProcess(oldPid);
    }
  }

  for (const messageId of Array.from(pendingSfxRepeats.keys())) {
    cleanupPendingSfxRepeat(messageId);
  }

  for (const guildId of Array.from(queueStatusMessages.keys())) {
    clearQueueStatusMessages(guildId);
  }

  await clearNowPlayingMessagesInAllGuildTextChannels().catch(() => {});
  await clearOldInstantMegaphonesInAllGuildTextChannels().catch(() => {});

  try {
    await client.destroy();
  } catch {
    // ignorar falhas na destruição
  }

  // Dá tempo para enviar mensagens de confirmação antes de sair.
  setTimeout(() => process.exit(0), 250);
  })();

  return shutdownInFlight;
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
const DEFAULT_AUTO_LEAVE_MINUTES = Number(BOT_CFG.autoLeave?.defaultMinutes) || 2;
const parsedAutoLeaveMinutes = Number.parseFloat(process.env.AUTO_LEAVE_MINUTES || '');
const AUTO_LEAVE_MINUTES = Number.isFinite(parsedAutoLeaveMinutes) && parsedAutoLeaveMinutes > 0
  ? parsedAutoLeaveMinutes
  : DEFAULT_AUTO_LEAVE_MINUTES;
const AUTO_LEAVE_GRACE_MS = Math.round(AUTO_LEAVE_MINUTES * 60 * 1000);
const SOUNDCLOUD_PROGRESS_REGEX = /^(📋 SoundCloud:|✅ SoundCloud:|📋 Lendo playlist do SoundCloud)/;

const pendingPlayRequests = new Map();
const deferredSkipRequests = new Map();
const queueStatusMessages = new Map();
const queueStatusMessageTimers = new Map();

function removeTrackedQueueStatusMessage(guildId, messageId) {
  const msgs = queueStatusMessages.get(guildId);
  if (!msgs) return;
  const next = msgs.filter((m) => m && m.id !== messageId);
  if (next.length === 0) {
    queueStatusMessages.delete(guildId);
    return;
  }
  queueStatusMessages.set(guildId, next);
}

function trackQueueStatusMessage(guildId, msg) {
  if (!msg || !msg.id || typeof msg.delete !== 'function') return;
  if (!queueStatusMessages.has(guildId)) queueStatusMessages.set(guildId, []);

  const current = queueStatusMessages.get(guildId);
  if (!current.some((m) => m?.id === msg.id)) {
    current.push(msg);
  }

  const prevTimer = queueStatusMessageTimers.get(msg.id);
  if (prevTimer) clearTimeout(prevTimer);

  // Mensagens de status de adição na fila devem sumir sozinhas rapidamente.
  const timeoutId = setTimeout(() => {
    queueStatusMessageTimers.delete(msg.id);
    removeTrackedQueueStatusMessage(guildId, msg.id);
    msg.delete().catch(() => {});
  }, 5000);
  queueStatusMessageTimers.set(msg.id, timeoutId);
}

function clearQueueStatusMessages(guildId) {
  const msgs = queueStatusMessages.get(guildId);
  if (!msgs) return;
  queueStatusMessages.delete(guildId);
  for (const msg of msgs) {
    const t = queueStatusMessageTimers.get(msg?.id);
    if (t) {
      clearTimeout(t);
      queueStatusMessageTimers.delete(msg.id);
    }
    msg.delete().catch(() => {});
  }
}

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
  const recent = await channel.messages
    .fetch({ limit: Number(BOT_CFG.ui?.soundCloudProgressScanLimit) || 30 })
    .catch(() => null);
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
  const loadingInProgress = isPlaylistLoadInProgress(guildId);

  // Se não há carregamento ativo, limpamos qualquer progresso residual para
  // evitar que a mensagem "...carregadas ⏳" reapareça a cada troca de faixa.
  if (!loadingInProgress) {
    if (entry?.message) {
      await entry.message.delete().catch(() => {});
    }
    activeSoundCloudProgressMessages.delete(guildId);
    soundCloudProgressRenderPromises.delete(guildId);
    soundCloudProgressAnchorMessageIds.delete(guildId);
    await refreshNowPlayingMessage(guildId).catch(() => {});
    return;
  }

  if (!entry?.message || !entry?.content || !String(entry.content).includes('⏳')) {
    await refreshNowPlayingMessage(guildId).catch(() => {});
    return;
  }

  await upsertSoundCloudProgressMessage(entry.message, entry.content, { forceResend: true }).catch(() => {});
  await refreshNowPlayingMessage(guildId).catch(() => {});
}

setOnSongChangedCallback((guildId, song) => {
  if (!song) clearQueueStatusMessages(guildId);
  if (song) clearEmptyQueueMessage(guildId);
  bumpActiveSoundCloudProgressForGuild(guildId, song);
});

function updateBotPresence(songTitle = null) {
  if (!client.user) return;

  const title = String(songTitle || '').trim();
  const rawSuffix = String(BOT_CFG.presence?.playingSuffix || '| +help');
  const suffix = rawSuffix.includes('help') ? `| ${presenceHelpCommandHint}` : rawSuffix;
  const rawIdleText = String(BOT_CFG.presence?.idleText || '+help');
  const idleText = rawIdleText.includes('help') ? presenceHelpCommandHint : rawIdleText;
  const maxActivityLength = Number(BOT_CFG.presence?.maxActivityLength) || 128;
  const presenceStatus = String(BOT_CFG.presence?.status || 'online');
  const activityName = title ? `${title} ${suffix}`.slice(0, maxActivityLength) : idleText;
  client.user.setPresence({
    activities: [{ name: activityName, type: 2 }],
    status: presenceStatus,
  });
}

function normalizePrefixForDisplay(prefix) {
  const p = String(prefix || '').trim();
  return p || '+p';
}

function updatePresenceHelpHint(guildId = null, fallbackPrefix = null) {
  presenceHelpCommandHint = '+help';
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
    while (queue.active < (Number(SOURCES_CFG.soundcloud?.resolveConcurrency) || 2) && queue.pending.length > 0) {
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

function beginPendingPlayRequest(guildId) {
  pendingPlayRequests.set(guildId, (pendingPlayRequests.get(guildId) || 0) + 1);
}

function finishPendingPlayRequest(guildId) {
  const current = pendingPlayRequests.get(guildId) || 0;
  if (current <= 1) {
    pendingPlayRequests.delete(guildId);
    return;
  }
  pendingPlayRequests.set(guildId, current - 1);
}

function hasPendingPlayRequest(guildId) {
  return (pendingPlayRequests.get(guildId) || 0) > 0;
}

function queueDeferredSkip(guildId) {
  const existing = deferredSkipRequests.get(guildId);
  deferredSkipRequests.set(guildId, { timestamp: Date.now(), notificationMessage: existing?.notificationMessage ?? null });
}

function clearDeferredSkip(guildId) {
  const entry = deferredSkipRequests.get(guildId);
  if (entry?.notificationMessage) {
    entry.notificationMessage.delete().catch(() => {});
  }
  deferredSkipRequests.delete(guildId);
}

async function flushDeferredSkipIfReady(guildId) {
  if (!deferredSkipRequests.has(guildId)) return false;

  const { current, queue } = getQueueFull(guildId);
  if (!current || !Array.isArray(queue) || queue.length === 0) {
    if (!hasPendingPlayRequest(guildId)) {
      clearDeferredSkip(guildId);
    }
    return false;
  }

  const entry = deferredSkipRequests.get(guildId);
  deferredSkipRequests.delete(guildId);
  if (entry?.notificationMessage) {
    entry.notificationMessage.delete().catch(() => {});
  }
  await skip({ guildId }, () => Promise.resolve());
  await refreshQueueMessagesForGuild(guildId, { forceCurrentSongPage: true }).catch(() => {});
  return true;
}

async function runSkipOrDefer(
  message,
  replyFn = (text) => message.reply(text),
  deferredReplyFn = replyFn
) {
  const { current, queue } = getQueueFull(message.guildId);
  const waitingForIncomingTrack =
    Boolean(current) &&
    Array.isArray(queue) &&
    queue.length === 0 &&
    (hasPendingPlayRequest(message.guildId) || isPlaylistLoadInProgress(message.guildId));

  if (waitingForIncomingTrack) {
    const alreadyDeferred = deferredSkipRequests.has(message.guildId);
    queueDeferredSkip(message.guildId);
    if (!alreadyDeferred && typeof deferredReplyFn === 'function') {
      const notifMsg = await deferredReplyFn('⏳ A próxima música ainda está carregando. Vou pular automaticamente assim que entrar na fila.').catch(() => null);
      const entry = deferredSkipRequests.get(message.guildId);
      if (entry && notifMsg) entry.notificationMessage = notifMsg;
    }
    return { deferred: true };
  }

  return skip(message, replyFn);
}

function isSpotifyLoadSessionActive(guildId, token) {
  return spotifyLoadSessions.get(guildId) === token;
}

function clearSpotifyLoadSession(guildId, token = null) {
  if (!spotifyLoadSessions.has(guildId)) return;
  if (token && spotifyLoadSessions.get(guildId) !== token) return;
  spotifyLoadSessions.delete(guildId);
}

function isPlaylistLoadInProgress(guildId) {
  return spotifyLoadSessions.has(guildId);
}

async function resolveQueriesToVideos(queries, { maxItems = 30, concurrency = 5 } = {}) {
  const effectiveMaxItems = Number(maxItems) || Number(SOURCES_CFG.resolution?.maxItems) || 30;
  const effectiveConcurrency = Number(concurrency) || Number(SOURCES_CFG.resolution?.concurrency) || 5;
  const capped = queries.slice(0, Math.max(1, effectiveMaxItems));
  const results = [];

  for (let i = 0; i < capped.length; i += effectiveConcurrency) {
    const chunk = capped.slice(i, i + effectiveConcurrency);
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
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Prefixos padrão (inclui +p, +play, +skip, +stop, +i, +efeito/+ef e +fila/+queue)
const DEFAULT_PREFIXES = Array.isArray(BOT_CFG.commands?.defaultPrefixes)
  ? BOT_CFG.commands.defaultPrefixes
  : ['+Ducz', '+d', '+p', '+play', '+tocar', '+skip', '+pular', '+stop', '+parar', '+sair', '+leave', '+i', '+fav', '+efeito', '+efeitos', '+effect', '+ef', '+fila', '+queue', '+remove', '+rm', '+playlist', '+pl', '+clear', '+help', '+ajuda', '+prefix'];

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

// Playlists salvas por guild (persistidas em savedPlaylists.json)
const savedPlaylistsFilePath = path.join(__dirname, 'savedPlaylists.json');
let savedPlaylistsByGuild = {};
const activeLoadedPlaylistByGuild = new Map();

function normalizePlaylistName(name) {
  return String(name || '').trim().toLowerCase();
}

function loadSavedPlaylists() {
  try {
    const raw = fs.readFileSync(savedPlaylistsFilePath, 'utf-8');
    const parsed = JSON.parse(raw || '{}');
    savedPlaylistsByGuild = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    savedPlaylistsByGuild = {};
  }
}

function saveSavedPlaylists() {
  try {
    fs.writeFileSync(savedPlaylistsFilePath, JSON.stringify(savedPlaylistsByGuild, null, 2), 'utf-8');
  } catch (err) {
    console.error('Erro ao salvar savedPlaylists.json:', err.message);
  }
}

function getSavedPlaylistsForGuild(guildId) {
  const key = String(guildId || '');
  if (!savedPlaylistsByGuild[key] || typeof savedPlaylistsByGuild[key] !== 'object') {
    savedPlaylistsByGuild[key] = {};
  }
  return savedPlaylistsByGuild[key];
}

function listSavedPlaylistEntries(guildId) {
  const guildStore = getSavedPlaylistsForGuild(guildId);
  return Object.entries(guildStore)
    .map(([storageName, entry]) => ({ storageName, entry }))
    .sort((a, b) => {
      const ta = Date.parse(a.entry?.updatedAt || '') || 0;
      const tb = Date.parse(b.entry?.updatedAt || '') || 0;
      return tb - ta;
    });
}

function getSavedPlaylistEntry(guildId, rawName) {
  const name = normalizePlaylistName(rawName);
  if (!name) return null;
  const guildStore = getSavedPlaylistsForGuild(guildId);
  const entry = guildStore[name];
  if (!entry || typeof entry !== 'object') return null;
  return { name, entry };
}

function upsertSavedPlaylist(guildId, rawName, snapshot) {
  const name = normalizePlaylistName(rawName);
  if (!name) return { ok: false, reason: 'invalid-name' };
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, reason: 'invalid-snapshot' };

  const guildStore = getSavedPlaylistsForGuild(guildId);
  guildStore[name] = {
    name,
    updatedAt: new Date().toISOString(),
    snapshot,
  };
  saveSavedPlaylists();
  return { ok: true, name, entry: guildStore[name] };
}

function deleteSavedPlaylist(guildId, rawName) {
  const name = normalizePlaylistName(rawName);
  if (!name) return false;
  const guildStore = getSavedPlaylistsForGuild(guildId);
  if (!Object.prototype.hasOwnProperty.call(guildStore, name)) return false;
  delete guildStore[name];
  saveSavedPlaylists();
  return true;
}

function setActiveLoadedPlaylist(guildId, playlistName) {
  const gid = String(guildId || '');
  const normalized = normalizePlaylistName(playlistName);
  if (!gid || !normalized) return;
  activeLoadedPlaylistByGuild.set(gid, normalized);
}

function clearActiveLoadedPlaylist(guildId) {
  const gid = String(guildId || '');
  if (!gid) return;
  activeLoadedPlaylistByGuild.delete(gid);
}

function getActiveLoadedPlaylist(guildId) {
  const gid = String(guildId || '');
  if (!gid) return null;
  const value = activeLoadedPlaylistByGuild.get(gid);
  return value || null;
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

function getFavoriteQueryState(query) {
  const normalized = normalizeFavQuery(query);
  if (!normalized) return { exists: false, index: -1 };

  const favs = getFavorites();
  const existingIndex = favs.findIndex((f) => {
    if (typeof f === 'string') return normalizeFavQuery(f) === normalized;
    return normalizeFavQuery(f?.query) === normalized;
  });

  return {
    exists: existingIndex >= 0,
    index: existingIndex,
  };
}

function getFavoriteCandidateState(candidates = []) {
  for (const candidate of candidates) {
    const state = getFavoriteQueryState(candidate);
    if (state.exists) {
      return { exists: true, index: state.index, query: String(candidate || '').trim() };
    }
  }

  const fallback = candidates.find((candidate) => normalizeFavQuery(candidate));
  return {
    exists: false,
    index: -1,
    query: fallback ? String(fallback).trim() : '',
  };
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
loadSavedPlaylists();
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
// Mensagem de "fila vazia" enviada por guild (1 por guild)
const emptyQueueMessages = new Map();

function ensureQueueInteractionState(interaction, pageHint = null) {
  const msg = interaction?.message;
  if (!msg?.id) return null;

  const existing = pendingQueueMessages.get(msg.id);
  if (existing?.timeoutId) clearTimeout(existing.timeoutId);

  const idParts = String(interaction.customId || '').split('_');
  const requesterId = existing?.userId || idParts[2] || interaction.user?.id || '0';
  const page = Number.isFinite(Number(pageHint)) ? Number(pageHint) : (existing?.page || 0);
  const timeoutId = setTimeout(() => {
    pendingQueueMessages.delete(msg.id);
  }, Number(BOT_CFG.ui?.dismissTimeoutMs) || 5 * 60 * 1000);

  const nextEntry = {
    userId: requesterId,
    timeoutId,
    page,
    message: msg,
    lastSignature: existing?.lastSignature || null,
  };

  pendingQueueMessages.set(msg.id, nextEntry);
  return nextEntry;
}

function trackEmptyQueueMessage(guildId, msg) {
  if (!msg || typeof msg.delete !== 'function') return;
  const old = emptyQueueMessages.get(guildId);
  if (old && old.id !== msg.id) old.delete().catch(() => {});
  emptyQueueMessages.set(guildId, msg);
}

function clearEmptyQueueMessage(guildId) {
  const msg = emptyQueueMessages.get(guildId);
  if (msg) {
    emptyQueueMessages.delete(guildId);
    msg.delete().catch(() => {});
  }
}
// Mensagem de efeitos exibida com botão de descartar
// Chave: mensagem do bot
// Valor: { userId, timeoutId }
const pendingEffectMessages = new Map();
// Confirmação de efeito ativo por guild (1 por guild, expira em 10s)
const guildEffectConfirmMsgs = new Map();
// Erro de efeito desconhecido por guild (1 por guild, expira em 15s)
const guildEffectErrorMsgs = new Map();
// Mensagem de help exibida com botão de fechar
// Chave: mensagem do bot
// Valor: { userId, timeoutId }
const pendingHelpMessages = new Map();
const instantFavoriteStatusMessages = new Map();
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

  const megaphoneReaction = entry.sourceMessage?.reactions?.cache?.find(
    (r) => r.emoji?.name === '📢'
  );
  if (megaphoneReaction) {
    megaphoneReaction.users.remove(client.user.id).catch(() => {});
  }

  const activeStarReaction = entry.sourceMessage?.reactions?.cache?.find(
    (r) => r.emoji?.name === INSTANT_FAVORITE_ADD_EMOJI
  );
  if (activeStarReaction) {
    activeStarReaction.users.remove(client.user.id).catch(() => {});
  }

  const inactiveStarReaction = entry.sourceMessage?.reactions?.cache?.find(
    (r) => r.emoji?.name === INSTANT_FAVORITE_REMOVE_EMOJI
  );
  if (inactiveStarReaction) {
    inactiveStarReaction.users.remove(client.user.id).catch(() => {});
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

const INSTANT_FAVORITE_ADD_EMOJI = '⭐';
const INSTANT_FAVORITE_REMOVE_EMOJI = '🌟';

async function clearInstantFavoriteReactions(message) {
  if (!message || !client.user?.id) return;

  const addReaction = message.reactions?.cache?.find((r) => r.emoji?.name === INSTANT_FAVORITE_ADD_EMOJI);
  if (addReaction) {
    await addReaction.users.remove(client.user.id).catch(() => {});
  }

  const removeReaction = message.reactions?.cache?.find((r) => r.emoji?.name === INSTANT_FAVORITE_REMOVE_EMOJI);
  if (removeReaction) {
    await removeReaction.users.remove(client.user.id).catch(() => {});
  }
}

async function clearInstantMegaphoneReaction(message) {
  if (!message || !client.user?.id) return;

  const megaphoneReaction = message.reactions?.cache?.find((r) => r.emoji?.name === '📢');
  if (megaphoneReaction) {
    await megaphoneReaction.users.remove(client.user.id).catch(() => {});
  }
}

function getInstantFavoriteStatusKey(channelId, query) {
  const normalized = normalizeFavQuery(query);
  if (!channelId || !normalized) return '';
  return `${channelId}:${normalized}`;
}

function parseInstantFavoriteStatusMessage(message) {
  const content = String(message?.content || '').trim();
  const match = content.match(/^(⭐ Favorito salvo|🗑️ Favorito removido) \(#(\d+)\): \*\*(.+)\*\*$/);
  if (!match) return null;

  const query = String(match[3] || '').trim();
  const normalizedQuery = normalizeFavQuery(query);
  if (!normalizedQuery) return null;

  return {
    kind: match[1],
    index: Number(match[2]),
    query,
    normalizedQuery,
  };
}

async function clearDuplicateFavoriteStatusMessages(channel, query, keepMessageId = null, { limit = 100 } = {}) {
  if (!channel || !channel.messages?.fetch || !client.user?.id) return [];

  const normalizedQuery = normalizeFavQuery(query);
  if (!normalizedQuery) return [];

  const fetched = await channel.messages.fetch({ limit }).catch(() => null);
  if (!fetched) return [];

  const matches = [];
  for (const msg of fetched.values()) {
    if (!msg || msg.author?.id !== client.user.id) continue;
    const parsed = parseInstantFavoriteStatusMessage(msg);
    if (!parsed || parsed.normalizedQuery !== normalizedQuery) continue;
    matches.push(msg);
  }

  matches.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  const keeper = keepMessageId
    ? matches.find((msg) => msg.id === keepMessageId) || null
    : matches[0] || null;

  const tasks = [];
  for (const msg of matches) {
    if (keeper && msg.id === keeper.id) continue;
    tasks.push(msg.delete().catch(() => {}));
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }

  return keeper ? [keeper] : [];
}

async function upsertFavoriteStatusMessage(commandMessage, entry, query, content) {
  if (!commandMessage?.channel) return;

  const key = getInstantFavoriteStatusKey(commandMessage.channelId, query);
  if (!key) return;

  let targetMessage = instantFavoriteStatusMessages.get(key) || null;

  if (!targetMessage) {
    const existing = await clearDuplicateFavoriteStatusMessages(commandMessage.channel, query);
    targetMessage = existing[0] || null;
  }

  if (targetMessage && typeof targetMessage.edit === 'function') {
    const edited = await targetMessage.edit(content).catch(() => null);
    if (edited) {
      instantFavoriteStatusMessages.set(key, edited);
      entry.favoriteStatusMessage = edited;
      await clearDuplicateFavoriteStatusMessages(commandMessage.channel, query, edited.id).catch(() => {});
      return;
    }
    instantFavoriteStatusMessages.delete(key);
  }

  if (entry.favoriteStatusMessage && typeof entry.favoriteStatusMessage.edit === 'function') {
    const edited = await entry.favoriteStatusMessage.edit(content).catch(() => null);
    if (edited) {
      instantFavoriteStatusMessages.set(key, edited);
      entry.favoriteStatusMessage = edited;
      await clearDuplicateFavoriteStatusMessages(commandMessage.channel, query, edited.id).catch(() => {});
      return;
    }
  }

  const msg = await commandMessage.reply(content).catch(() => null);
  if (msg) {
    instantFavoriteStatusMessages.set(key, msg);
    entry.favoriteStatusMessage = msg;
    await clearDuplicateFavoriteStatusMessages(commandMessage.channel, query, msg.id).catch(() => {});
  }
}

async function clearFavoriteReactionFromPreviousIdenticalInstantMessages(message, { limit = 100 } = {}) {
  if (!message?.channel?.messages?.fetch || !message?.author?.id) return;

  const currentContent = String(message.content || '').trim();
  if (!currentContent) return;

  const currentInstant = inferInstantCommandFromMessage(message);
  if (!currentInstant?.query) return;

  const fetched = await message.channel.messages.fetch({ limit }).catch(() => null);
  if (!fetched) return;

  const tasks = [];
  for (const candidate of fetched.values()) {
    if (!candidate || candidate.id === message.id) continue;
    if (candidate.author?.id !== message.author.id) continue;
    if (String(candidate.content || '').trim() !== currentContent) continue;

    const candidateInstant = inferInstantCommandFromMessage(candidate);
    if (!candidateInstant?.query) continue;
    if (String(candidateInstant.query || '').trim() !== String(currentInstant.query || '').trim()) continue;

    tasks.push(clearInstantFavoriteReactions(candidate));
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

async function syncInstantFavoriteReaction(message, favoriteQuery) {
  if (!message || typeof message.react !== 'function' || !client.user?.id) return;

  const candidates = Array.isArray(favoriteQuery) ? favoriteQuery : [favoriteQuery];
  const isFavorited = getFavoriteCandidateState(candidates).exists;
  const desiredEmoji = isFavorited ? INSTANT_FAVORITE_REMOVE_EMOJI : INSTANT_FAVORITE_ADD_EMOJI;

  await clearInstantFavoriteReactions(message);

  await message.react(desiredEmoji).catch(() => {});
}

function setupSfxRepeat(
  reactionMessage,
  mp3Url,
  displayName,
  favoriteQuery = null,
  ownerUserId = null,
  playbackMessage = null,
  commandMessageOverride = null
) {
  if (!reactionMessage || !mp3Url || typeof reactionMessage.createReactionCollector !== 'function') return;

  const actionMessage = playbackMessage || reactionMessage;
  const commandMessage = commandMessageOverride || reactionMessage;
  cleanupPendingSfxRepeat(reactionMessage.id);
  const favoriteCandidates = [favoriteQuery, displayName].filter((value) => normalizeFavQuery(value));
  const existingFavorite = getFavoriteCandidateState(favoriteCandidates);
  const resolvedFavoriteQuery = existingFavorite.query || favoriteQuery || displayName;

  const sendFavoriteFeedback = async (entry, content, favQuery) => {
    if (!entry) return;
    await upsertFavoriteStatusMessage(commandMessage, entry, favQuery, content).catch(() => {});
  };

  // Adiciona reações na ordem garantida: 🦆 → 📢 → ⭐
  reactionMessage.react('🦆').catch(() => {});
  reactionMessage.react('📢').catch(() => {});
  clearFavoriteReactionFromPreviousIdenticalInstantMessages(reactionMessage)
    .then(() => syncInstantFavoriteReaction(reactionMessage, favoriteCandidates))
    .catch(() => {});

  const filter = (reaction, user) => {
    if (!reaction || !user) return false;
    // Ignora reações do próprio bot
    if (user.id === reactionMessage.client?.user?.id) return false;
    return (
      reaction.emoji.name === '🦆' ||
      reaction.emoji.name === '📢' ||
      reaction.emoji.name === INSTANT_FAVORITE_ADD_EMOJI ||
      reaction.emoji.name === INSTANT_FAVORITE_REMOVE_EMOJI
    );
  };

  const collector = reactionMessage.createReactionCollector({ filter, dispose: true });
  collector.on('collect', async (reaction, user) => {
    const entry = pendingSfxRepeats.get(reactionMessage.id);
    if (!entry) return;

    if (
      reaction.emoji.name === INSTANT_FAVORITE_ADD_EMOJI ||
      reaction.emoji.name === INSTANT_FAVORITE_REMOVE_EMOJI
    ) {
      const favoriteState = getFavoriteCandidateState([entry.favoriteQuery, entry.displayName]);
      const favQuery = favoriteState.query || entry.favoriteQuery || entry.displayName;
      reaction.users.remove(user.id).catch(() => {});
      if (reaction.emoji.name === INSTANT_FAVORITE_REMOVE_EMOJI && favoriteState.exists) {
        const removeResult = removeFavoriteQuery(user.id, favQuery);
        if (removeResult.removed) {
          await sendFavoriteFeedback(entry, `🗑️ Favorito removido (#${removeResult.index}): **${favQuery}**`, favQuery);
        }
      } else if (reaction.emoji.name === INSTANT_FAVORITE_ADD_EMOJI && !favoriteState.exists) {
        const addResult = addFavoriteQuery(user.id, favQuery);
        if (addResult.added) {
          await sendFavoriteFeedback(entry, `⭐ Favorito salvo (#${addResult.index}): **${favQuery}**`, favQuery);
        }
      }
      await syncInstantFavoriteReaction(reactionMessage, [entry.favoriteQuery, entry.displayName]).catch(() => {});
      return;
    }

    // Megafone: toca 2x mais alto, uma única vez
    if (reaction.emoji.name === '📢') {
      if (entry.megaphoneUsed) return;
      entry.megaphoneUsed = true;
      reaction.users.remove(user.id).catch(() => {});
      const megaReaction = reactionMessage.reactions.cache.get('📢');
      if (megaReaction) megaReaction.remove().catch(() => {});
      try {
        const tmpFile = await downloadMp3(entry.mp3Url);
        const megaVol = Number(BOT_CFG.sfx?.megaphoneVolume) || 2.0;
        await playSfx(entry.commandMessage || commandMessage, tmpFile, entry.displayName, megaVol);
      } catch (err) {
        console.error('❌ Erro ao tocar com megafone:', err);
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
    if (
      reaction.emoji.name !== INSTANT_FAVORITE_ADD_EMOJI &&
      reaction.emoji.name !== INSTANT_FAVORITE_REMOVE_EMOJI
    ) return;
  });

  collector.on('end', () => {
    pendingSfxRepeats.delete(reactionMessage.id);
  });

  pendingSfxRepeats.set(reactionMessage.id, {
    mp3Url,
    displayName,
    favoriteQuery: resolvedFavoriteQuery,
    guildId: actionMessage.guildId,
    sourceMessage: reactionMessage,
    commandMessage,
    playbackMessage: actionMessage,
    userId: ownerUserId || actionMessage.author?.id,
    repeatInFlight: false,
    megaphoneUsed: false,
    favoriteStatusMessage: null,
    collector,
  });
}

function inferInstantCommandFromMessage(message) {
  const content = String(message?.content || '').trim();
  if (!content || !message?.guildId) return null;

  const prefixes = getPrefixes(message.guildId).sort((a, b) => b.length - a.length);
  let usedPrefix = null;
  for (const p of prefixes) {
    if (content.toLowerCase().startsWith(p.toLowerCase())) {
      const nextChar = content[p.length];
      const lower = p.toLowerCase();
      const requiresSpace = ['+p', '+play', '+tocar', '+d', '+i', '+fav', '+efeito', '+efeitos', '+effect', '+ef', '+remove', '+rm', '+playlist', '+pl', '+clear', '+parar', '+pular', '+sair', '+leave', '+ajuda', '+prefix'].includes(lower);
      if (requiresSpace && nextChar && !/\s/.test(nextChar)) continue;
      usedPrefix = p;
      break;
    }
  }

  if (!usedPrefix) return null;

  const normalizedPrefix = usedPrefix.toLowerCase();
  const args = content.slice(usedPrefix.length).trim();
  if (!args) return null;

  if (normalizedPrefix === '+i') {
    const firstToken = args.split(/\s+/)[0];
    return {
      query: args,
      directLink: MYINSTANTS_REGEX.test(firstToken) ? firstToken : null,
    };
  }

  const parts = args.split(/\s+/);
  const cmd = String(parts[0] || '').toLowerCase();
  if (cmd !== 'instant' && cmd !== 'instants') return null;

  const query = parts.slice(1).join(' ').trim();
  if (!query) return null;

  const firstToken = query.split(/\s+/)[0];
  return {
    query,
    directLink: MYINSTANTS_REGEX.test(firstToken) ? firstToken : null,
  };
}

function createLegacyReactionMessageAdapter(message, user) {
  return {
    guild: message.guild,
    guildId: message.guildId,
    member: message.guild?.members?.cache?.get(user.id) || null,
    channel: message.channel,
    author: user,
    reactions: {
      removeAll: () => Promise.resolve(),
    },
    react: () => Promise.resolve(),
    reply: (options) => {
      const normalized = typeof options === 'string' ? { content: options } : options;
      return message.reply(normalized);
    },
  };
}

async function handleLegacyInstantReaction(reaction, user, { isRemoval = false } = {}) {
  if (!reaction || !user || user.bot) return;
  const emoji = reaction.emoji?.name;
  if (emoji !== '🦆' && emoji !== INSTANT_FAVORITE_ADD_EMOJI && emoji !== INSTANT_FAVORITE_REMOVE_EMOJI) return;

  try {
    if (reaction.partial) await reaction.fetch().catch(() => null);
    if (reaction.message?.partial) await reaction.message.fetch().catch(() => null);
  } catch {}

  const sourceMessage = reaction.message;
  if (!sourceMessage || pendingSfxRepeats.has(sourceMessage.id)) return;

  const inferred = inferInstantCommandFromMessage(sourceMessage);
  if (!inferred?.query) return;

  if (emoji === INSTANT_FAVORITE_ADD_EMOJI || emoji === INSTANT_FAVORITE_REMOVE_EMOJI) {
    if (isRemoval) return;

    reaction.users.remove(user.id).catch(() => {});
    const favoriteState = getFavoriteCandidateState([inferred.query]);
    if (emoji === INSTANT_FAVORITE_REMOVE_EMOJI && favoriteState.exists) {
      removeFavoriteQuery(user.id, favoriteState.query || inferred.query);
    } else if (emoji === INSTANT_FAVORITE_ADD_EMOJI && !favoriteState.exists) {
      addFavoriteQuery(user.id, inferred.query);
    }
    await syncInstantFavoriteReaction(sourceMessage, inferred.query).catch(() => {});
    return;
  }

  reaction.users.remove(user.id).catch(() => {});

  const msgAdapter = createLegacyReactionMessageAdapter(sourceMessage, user);
  try {
    let mp3Url = null;
    let displayName = inferred.query;

    if (inferred.directLink) {
      mp3Url = await extractMp3Url(inferred.directLink);
      displayName = inferred.directLink
        .replace(/\/$/, '')
        .split('/')
        .pop()
        .replace(/-/g, ' ')
        .replace(/\d+$/, '')
        .trim() || inferred.query;
    } else {
      const results = await searchMyInstants(inferred.query, 1);
      const picked = Array.isArray(results) ? results[0] : null;
      if (!picked) return;
      mp3Url = picked.mp3Url ? picked.mp3Url : await extractMp3Url(picked.pageUrl);
      displayName = picked.title || inferred.query;
    }

    if (!mp3Url) return;

    const tmpFile = await downloadMp3(mp3Url);
    const sfxMessage = await playSfx(msgAdapter, tmpFile, displayName);
    setupSfxRepeat(sourceMessage, mp3Url, displayName, inferred.query, user.id, sfxMessage || null, msgAdapter);
  } catch (err) {
    console.error('❌ Erro ao repetir instant antigo por reação:', err);
  }
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
    clearEmptyQueueMessage(message.guildId);
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
  const { current, queue, history, loopPlaylist, playlistSongs, currentIndex, effect, effectIntensity } = getQueueFull(message.guildId);
  if (!current && queue.length === 0) {
    if (existingMessage && existingEntry) {
      pendingQueueMessages.delete(existingMessage.id);
      if (existingEntry.timeoutId) clearTimeout(existingEntry.timeoutId);
      const edited = await existingMessage.edit({ content: '📋 A fila está vazia.', components: [] }).catch(() => null);
      if (edited) trackEmptyQueueMessage(message.guildId, edited);
      return edited;
    }
    const sent = await message.reply('📋 A fila está vazia.').catch(() => null);
    if (sent) trackEmptyQueueMessage(message.guildId, sent);
    return sent;
  }

  // Monta lista de exibição: modo normal (só fila) ou modo loop-playlist (histórico + atual + fila)
  const allSongs = loopPlaylist
    ? (playlistSongs.length > 0 ? playlistSongs : [...history, ...(current ? [current] : []), ...queue])
    : queue;
  const currentIdx = loopPlaylist ? currentIndex : -1;
  const displayTotal = loopPlaylist ? allSongs.length : queue.length;

  const pageSize = Number(BOT_CFG.ui?.queuePageSize) || 8;
  const totalPages = Math.max(1, Math.ceil(displayTotal / pageSize));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const effectLabel = effect ? ` | 🎛️ ${effect} ${effectIntensity}/10` : '';
  const activeSavedPlaylistName = getActiveLoadedPlaylist(message.guildId);
  const savedPlaylistsCount = listSavedPlaylistEntries(message.guildId).length;
  const restartSongTotal = loopPlaylist
    ? allSongs.length
    : ((current ? 1 : 0) + queue.length);

  let text = '';
  if (loopPlaylist) {
    text += `🔄 **Playlist em loop (${allSongs.length} músicas)${effectLabel}**`;
    if (totalPages > 1) text += ` — pág. ${normalizedPage + 1}/${totalPages}`;
    text += '\n\n';
    const start = normalizedPage * pageSize;
    const pageItems = allSongs.slice(start, start + pageSize);
    pageItems.forEach((song, i) => {
      const gidx = start + i;
      if (gidx === currentIdx) {
        text += `▶️ **${gidx + 1}. ${song.title}** ← tocando\n`;
      } else {
        text += `**${gidx + 1}.** ${song.title}\n`;
      }
    });
    if (allSongs.length > start + pageSize) {
      text += `\n...e mais ${allSongs.length - (start + pageSize)} música(s)`;
    }
  } else {
    if (current) text += `🎶 **Tocando agora:** ${current.title}${effectLabel}\n\n`;
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
  }

  if (activeSavedPlaylistName) {
    text += `\n\n💾 **Playlist carregada:** ${activeSavedPlaylistName}`;
  }
  text += `\n💽 **Playlists salvas:** ${savedPlaylistsCount}`;

  const components = [];
  const row = new ActionRowBuilder();
  const playlistLoading = isPlaylistLoadInProgress(message.guildId);

  // Navegação de páginas
  if (normalizedPage > 0) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_prev_${requesterId}_${normalizedPage - 1}`)
        .setLabel('◀ Anterior')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(playlistLoading)
    );
  }

  if (displayTotal > (normalizedPage + 1) * pageSize) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_next_${requesterId}_${normalizedPage + 1}`)
        .setLabel('Próxima ▶')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(playlistLoading)
    );
  }

  // Botão para abrir modal de tocar por número
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_play_${requesterId}`)
      .setLabel('Tocar (#)')
      .setStyle(ButtonStyle.Success)
      .setDisabled(playlistLoading)
  );

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_remove_pick_${requesterId}`)
      .setLabel('Remover (#)')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(playlistLoading || displayTotal === 0)
  );

  // Botão para descartar a mensagem
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_restart_${requesterId}`)
      .setLabel('Reiniciar')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(playlistLoading || restartSongTotal <= 1)
  );

  components.push(row);

  // Segunda linha: controles de playlist
  if (current || queue.length > 0) {
    const row2 = new ActionRowBuilder();
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_loopplaylist_${requesterId}`)
        .setLabel('Loop Playlist')
        .setEmoji('🔄')
        .setStyle(loopPlaylist ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(playlistLoading)
    );

    if (activeSavedPlaylistName) {
      row2.addComponents(
        new ButtonBuilder()
          .setCustomId(`queue_update_current_${requesterId}`)
          .setLabel('Atualizar Playlist')
          .setStyle(ButtonStyle.Success)
          .setDisabled(playlistLoading),
        new ButtonBuilder()
          .setCustomId(`queue_saved_delete_${requesterId}`)
          .setLabel('Apagar Playlist')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(playlistLoading)
      );
    }
    components.push(row2);

    const row3 = new ActionRowBuilder();
    if (!activeSavedPlaylistName) {
      row3.addComponents(
        new ButtonBuilder()
          .setCustomId(`queue_save_pick_${requesterId}`)
          .setLabel('Salvar Playlist')
          .setStyle(ButtonStyle.Success)
          .setDisabled(playlistLoading)
      );
    }
    row3.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_saved_load_pick_${requesterId}`)
        .setLabel('Carregar salva (#/nome)')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(savedPlaylistsCount === 0),
      new ButtonBuilder()
        .setCustomId(`queue_saved_list_${requesterId}`)
        .setLabel('Playlists salvas')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`queue_saved_delete_pick_${requesterId}`)
        .setLabel('Apagar salva (#/nome)')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(savedPlaylistsCount === 0),
      new ButtonBuilder()
        .setCustomId(`queue_dismiss_${requesterId}`)
        .setLabel('Descartar')
        .setStyle(ButtonStyle.Secondary)
    );
    components.push(row3);
  }

  const signature = `${normalizedPage}|${current?.title || ''}|${queue.length}|${playlistLoading ? 1 : 0}|${text}`;
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
    }, Number(BOT_CFG.ui?.dismissTimeoutMs) || 5 * 60 * 1000);
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
  }, Number(BOT_CFG.ui?.dismissTimeoutMs) || 5 * 60 * 1000);

  pendingEffectMessages.set(sent.id, {
    userId: requesterId,
    timeoutId,
  });

  return sent;
}

// Envia confirmação de efeito com 1 msg por guild (substitui a anterior) que expira em 10s
async function sendTimedEffectConfirm(message, guildId, text) {
  const prev = guildEffectConfirmMsgs.get(guildId);
  if (prev) {
    clearTimeout(prev.timeoutId);
    prev.msg.delete().catch(() => {});
    guildEffectConfirmMsgs.delete(guildId);
  }
  const sent = await message.reply(text).catch(() => null);
  if (!sent) return null;
  const timeoutId = setTimeout(() => {
    guildEffectConfirmMsgs.delete(guildId);
    sent.delete().catch(() => {});
  }, 10_000);
  guildEffectConfirmMsgs.set(guildId, { msg: sent, timeoutId });
  return sent;
}

function clearEffectErrorMessage(guildId) {
  const prev = guildEffectErrorMsgs.get(guildId);
  if (prev) {
    clearTimeout(prev.timeoutId);
    prev.msg.delete().catch(() => {});
    guildEffectErrorMsgs.delete(guildId);
  }
}

// Envia mensagem de erro de efeito com 1 msg por guild que expira em 15s
async function sendTimedEffectError(message, guildId, text) {
  clearEffectErrorMessage(guildId);
  const sent = await message.reply(text).catch(() => null);
  if (!sent) return null;
  const timeoutId = setTimeout(() => {
    guildEffectErrorMsgs.delete(guildId);
    sent.delete().catch(() => {});
  }, 15_000);
  guildEffectErrorMsgs.set(guildId, { msg: sent, timeoutId });
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
  }, Number(BOT_CFG.ui?.dismissTimeoutMs) || 5 * 60 * 1000);

  pendingHelpMessages.set(sent.id, {
    userId: requesterId,
    timeoutId,
  });

  return sent;
}

function startQueueLiveRefresh() {
  const INTERVAL_MS = Number(BOT_CFG.ui?.queueRefreshIntervalMs) || 4000;
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
  if (isPlaylistLoadInProgress(message.guildId)) {
    return message.reply('⏳ A playlist ainda está carregando. Aguarde finalizar para usar `+fila <n>` / Tocar (#).');
  }

  const { queue } = getQueue(message.guildId);
  const { loopPlaylist, playlistSongs } = getQueueFull(message.guildId);
  const totalSongs = loopPlaylist ? playlistSongs.length : queue.length;

  if (!totalSongs) {
    return message.reply('❌ A fila está vazia. Use `+fila` para ver as músicas.');
  }
  if (!Number.isFinite(position) || position < 1) {
    return message.reply('❌ Número inválido. Use um número válido da fila.');
  }
  if (position > totalSongs) {
    return message.reply(`❌ A fila tem apenas **${totalSongs}** música(s). Não existe a posição **${position}**.`);
  }

  const success = await jumpTo(message.guildId, position);
  if (!success) {
    return message.reply('❌ Número inválido ou fila vazia. Use `+fila` para ver as músicas.');
  }
  await refreshQueueMessagesForGuild(message.guildId, { forceCurrentSongPage: true }).catch(() => {});
  const sent = await message.reply(`▶️ Indo para a música #${position} da fila...`).catch(() => null);
  if (sent) {
    setTimeout(() => {
      sent.delete().catch(() => {});
    }, 10_000);
  }
  return sent;
}

async function removeQueuePositionByCommand(message, position) {
  if (isPlaylistLoadInProgress(message.guildId)) {
    return message.reply('⏳ A playlist ainda está carregando. Aguarde finalizar para usar remoção por número.');
  }

  const { queue } = getQueue(message.guildId);
  const { loopPlaylist, playlistSongs } = getQueueFull(message.guildId);
  const totalSongs = loopPlaylist ? playlistSongs.length : queue.length;

  if (!totalSongs) {
    return message.reply('❌ A fila está vazia. Use `+fila` para ver as músicas.');
  }

  if (!Number.isFinite(position) || position < 1) {
    return message.reply('❌ Número inválido. Use um número válido da fila.');
  }

  if (position > totalSongs) {
    return message.reply(`❌ A fila tem apenas **${totalSongs}** música(s). Não existe a posição **${position}**.`);
  }

  const result = await removeQueuePosition(message.guildId, position);
  if (!result?.ok) {
    return message.reply('❌ Não consegui remover essa música. Tente abrir `+fila` novamente.');
  }

  await refreshQueueMessagesForGuild(message.guildId, { forceCurrentSongPage: true }).catch(() => {});
  if (result.removedCurrent) {
    await refreshNowPlayingMessage(message.guildId, { forceResend: true }).catch(() => {});
  }

  const removedTitle = result.removedSong?.title || 'música';
  return message.reply(`🗑️ Removida a música #${position}: **${removedTitle}**.`);
}

async function removeCurrentSongByCommand(message) {
  if (isPlaylistLoadInProgress(message.guildId)) {
    return message.reply('⏳ A playlist ainda está carregando. Aguarde finalizar para remover a música atual.');
  }

  const result = await removeCurrentSong(message.guildId);
  if (!result?.ok) {
    return message.reply('❌ Não há música atual tocando para remover.');
  }

  await refreshQueueMessagesForGuild(message.guildId, { forceCurrentSongPage: true }).catch(() => {});
  await refreshNowPlayingMessage(message.guildId, { forceResend: true }).catch(() => {});

  const removedTitle = result.removedSong?.title || 'música';
  return message.reply(`🗑️ Música atual removida: **${removedTitle}**.`);
}

async function handlePlaylistCommand(message, rawArgs) {
  const raw = String(rawArgs || '').trim();
  if (!raw) {
    return message.reply(
      '💾 Uso de playlist salva:\n' +
      '`+playlist listar`\n' +
      '`+playlist salvar <nome>`\n' +
      '`+playlist carregar <nome|numero>`\n' +
      '`+playlist atualizar <nome>`\n' +
      '`+playlist apagar <nome|numero>`\n' +
      'Atalho: `+pl ...`'
    );
  }

  const parts = raw.split(/\s+/);
  const action = (parts[0] || '').toLowerCase();
  const playlistName = parts.slice(1).join(' ').trim();
  const actionAliases = {
    list: ['listar', 'list', 'ls'],
    save: ['salvar', 'save'],
    load: ['carregar', 'load'],
    update: ['atualizar', 'update'],
    delete: ['apagar', 'delete', 'del', 'remover', 'remove'],
  };

  const isAction = (group) => actionAliases[group].includes(action);

  if (isAction('list')) {
    const entries = listSavedPlaylistEntries(message.guildId);
    if (!entries.length) {
      return message.reply('💾 Nenhuma playlist salva neste servidor.');
    }
    const lines = entries.slice(0, 20).map(({ storageName, entry }, idx) => {
      const when = entry?.updatedAt ? `<t:${Math.floor(new Date(entry.updatedAt).getTime() / 1000)}:R>` : 'sem data';
      return `**${idx + 1}.** ${storageName} (${when})`;
    });
    return message.reply(`💾 **Playlists salvas**\n${lines.join('\n')}`);
  }

  if (!playlistName) {
    return message.reply('❌ Informe o nome da playlist. Ex: `+playlist salvar academia`');
  }

  if (isAction('save')) {
    if (isPlaylistLoadInProgress(message.guildId)) {
      return message.reply('⏳ A playlist ainda está carregando. Aguarde finalizar para salvar.');
    }
    const existing = getSavedPlaylistEntry(message.guildId, playlistName);
    if (existing) {
      return message.reply('⚠️ Já existe playlist com esse nome. Use `+playlist atualizar <nome>` para sobrescrever.');
    }
    const snapshot = getPlaylistSnapshot(message.guildId);
    if (!snapshot) {
      return message.reply('❌ Não há playlist/fila ativa para salvar agora.');
    }
    const saved = upsertSavedPlaylist(message.guildId, playlistName, snapshot);
    if (!saved.ok) return message.reply('❌ Não consegui salvar essa playlist.');
    const total = (snapshot.currentSong ? 1 : 0) + (Array.isArray(snapshot.queue) ? snapshot.queue.length : 0);
    return message.reply(`✅ Playlist **${saved.name}** salva com **${total}** música(s).`);
  }

  if (isAction('update')) {
    if (isPlaylistLoadInProgress(message.guildId)) {
      return message.reply('⏳ A playlist ainda está carregando. Aguarde finalizar para atualizar.');
    }
    const existing = getSavedPlaylistEntry(message.guildId, playlistName);
    if (!existing) {
      return message.reply('❌ Playlist não encontrada. Use `+playlist salvar <nome>` primeiro.');
    }
    const snapshot = getPlaylistSnapshot(message.guildId);
    if (!snapshot) {
      return message.reply('❌ Não há playlist/fila ativa para atualizar agora.');
    }
    const updated = upsertSavedPlaylist(message.guildId, playlistName, snapshot);
    if (!updated.ok) return message.reply('❌ Não consegui atualizar essa playlist.');
    const total = (snapshot.currentSong ? 1 : 0) + (Array.isArray(snapshot.queue) ? snapshot.queue.length : 0);
    return message.reply(`♻️ Playlist **${updated.name}** atualizada com **${total}** música(s).`);
  }

  if (isAction('load')) {
    if (isPlaylistLoadInProgress(message.guildId)) {
      return message.reply('⏳ A playlist ainda está carregando. Aguarde finalizar para carregar uma playlist salva.');
    }
    const entries = listSavedPlaylistEntries(message.guildId);
    let resolvedName = playlistName;
    if (/^\d+$/.test(playlistName)) {
      const idx = Number(playlistName) - 1;
      resolvedName = entries[idx]?.storageName || '';
    }

    const found = getSavedPlaylistEntry(message.guildId, resolvedName);
    if (!found) {
      return message.reply('❌ Playlist não encontrada. Use `+playlist listar` para ver as salvas (nome ou número).');
    }

    const restored = await restorePlaylistSnapshot(message, found.entry.snapshot).catch((err) => ({ ok: false, reason: err?.message || 'restore-error' }));
    if (!restored?.ok) {
      return message.reply('❌ Não consegui carregar essa playlist salva.');
    }

    await refreshQueueMessagesForGuild(message.guildId, { forceCurrentSongPage: true }).catch(() => {});
    const total = Number(restored.totalSongs) || 0;
    const currentTitle = restored.currentTitle || 'música';
    setActiveLoadedPlaylist(message.guildId, found.name);
    return message.reply(`▶️ Playlist **${found.name}** carregada (${total} música(s)). Tocando: **${currentTitle}**.`);
  }

  if (isAction('delete')) {
    const entries = listSavedPlaylistEntries(message.guildId);
    let resolvedName = playlistName;
    if (/^\d+$/.test(playlistName)) {
      const idx = Number(playlistName) - 1;
      resolvedName = entries[idx]?.storageName || '';
    }
    if (!resolvedName) {
      return message.reply('❌ Playlist não encontrada para apagar (nome ou número inválido).');
    }

    const ok = deleteSavedPlaylist(message.guildId, resolvedName);
    if (!ok) return message.reply('❌ Playlist não encontrada para apagar.');
    if (getActiveLoadedPlaylist(message.guildId) === normalizePlaylistName(resolvedName)) {
      clearActiveLoadedPlaylist(message.guildId);
    }
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
    return message.reply(`🗑️ Playlist **${normalizePlaylistName(resolvedName)}** removida.`);
  }

  return message.reply('❌ Ação inválida. Use `+playlist listar|salvar|carregar|atualizar|apagar <nome|numero>`.');
}

function getCurrentSongQueuePage(guildId) {
  const pageSize = Number(BOT_CFG.ui?.queuePageSize) || 8;
  const { currentIndex, loopPlaylist } = getQueueFull(guildId);
  if (!loopPlaylist) return 0;
  return Math.max(0, Math.floor((Math.max(0, currentIndex)) / pageSize));
}

async function refreshQueueMessagesForGuild(guildId, opts = {}) {
  const forceCurrentSongPage = Boolean(opts?.forceCurrentSongPage);
  const targetPage = forceCurrentSongPage ? getCurrentSongQueuePage(guildId) : null;
  const tasks = [];
  for (const [messageId, entry] of pendingQueueMessages.entries()) {
    if (!entry?.message || entry.message.guildId !== guildId) continue;
    const nextPage = targetPage !== null ? targetPage : (entry.page || 0);
    if (targetPage !== null) {
      entry.page = targetPage;
      pendingQueueMessages.set(messageId, entry);
    }
    tasks.push(
      showQueueMessage(entry.message, nextPage, entry.message).catch(() => {
        if (entry.timeoutId) clearTimeout(entry.timeoutId);
        pendingQueueMessages.delete(messageId);
      })
    );
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

async function clearQueueMessagesForGuild(guildId) {
  const tasks = [];
  for (const [messageId, entry] of pendingQueueMessages.entries()) {
    if (!entry?.message || entry.message.guildId !== guildId) continue;
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    pendingQueueMessages.delete(messageId);
    tasks.push(entry.message.delete().catch(() => {}));
  }

  const guild = client.guilds.cache.get(guildId);
  if (guild) {
    for (const channel of guild.channels.cache.values()) {
      if (!channel || !channel.isTextBased?.() || !channel.messages?.fetch) continue;
      tasks.push(clearQueueUiMessagesInChannel(channel).catch(() => {}));
    }
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

const QUEUE_UI_COMPONENT_PREFIXES = [
  'queue_dismiss_',
  'queue_prev_',
  'queue_next_',
  'queue_play_',
  'queue_remove_pick_',
  'queue_remove_current_',
  'queue_save_pick_',
  'queue_update_current_',
  'queue_saved_load_pick_',
  'queue_saved_list_',
  'queue_saved_delete_pick_',
  'queue_saved_update_',
  'queue_saved_delete_',
  'queue_loopplaylist_',
  'queue_restart_',
];

function messageHasQueueUiComponents(msg) {
  if (!msg || msg.author?.id !== client.user?.id) return false;
  const rows = Array.isArray(msg.components) ? msg.components : [];
  for (const row of rows) {
    const comps = Array.isArray(row?.components) ? row.components : [];
    for (const comp of comps) {
      const cid = String(comp?.customId || '');
      if (!cid) continue;
      if (QUEUE_UI_COMPONENT_PREFIXES.some((prefix) => cid.startsWith(prefix))) return true;
    }
  }
  return false;
}

async function clearQueueUiMessagesInChannel(channel, { limit = 100 } = {}) {
  if (!channel || !channel.messages?.fetch || !client.user?.id) return;
  const fetched = await channel.messages.fetch({ limit }).catch(() => null);
  if (!fetched) return;

  const tasks = [];
  for (const msg of fetched.values()) {
    if (!messageHasQueueUiComponents(msg)) continue;
    tasks.push(msg.delete().catch(() => {}));
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

const NOW_PLAYING_MESSAGE_PREFIXES = ['🎶 Tocando:', '🔊 Tocando:'];
const TRANSIENT_BOT_MESSAGE_PREFIXES = [
  '❌ Não encontrei resultados para essa busca no YouTube.',
  '📋 A fila está vazia.',
  '📋 Spotify:',
  '✅ Spotify:',
  '📋 SoundCloud:',
  '✅ SoundCloud:',
  '📋 Lendo playlist do SoundCloud...',
  '📋 Playlist com ',
];
const STALE_UI_COMPONENT_PREFIXES = [
  'effects_dismiss_',
  'help_dismiss_',
  'queue_dismiss_',
  'queue_prev_',
  'queue_next_',
  'queue_play_',
  'queue_remove_pick_',
  'queue_remove_current_',
  'queue_save_pick_',
  'queue_update_current_',
  'queue_saved_load_pick_',
  'queue_saved_list_',
  'queue_saved_delete_pick_',
  'queue_saved_update_',
  'queue_saved_delete_',
  'queue_loopplaylist_',
  'queue_restart_',
  'music_remove_current_',
];

function isNowPlayingLikeBotMessage(msg) {
  if (!msg || msg.author?.id !== client.user?.id) return false;
  const content = String(msg.content || '');
  return NOW_PLAYING_MESSAGE_PREFIXES.some((prefix) => content.startsWith(prefix));
}

function isTransientBotMessage(msg) {
  if (!msg || msg.author?.id !== client.user?.id) return false;
  const content = String(msg.content || '');
  return TRANSIENT_BOT_MESSAGE_PREFIXES.some((prefix) => content.startsWith(prefix));
}

async function clearNowPlayingMessagesInChannel(channel, { limit = 100 } = {}) {
  if (!channel || !channel.messages?.fetch || !client.user?.id) return;
  const fetched = await channel.messages.fetch({ limit }).catch(() => null);
  if (!fetched) return;

  const tasks = [];
  for (const msg of fetched.values()) {
    if (!isNowPlayingLikeBotMessage(msg)) continue;
    tasks.push(msg.delete().catch(() => {}));
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

async function clearTransientBotMessagesInChannel(channel, { limit = 100 } = {}) {
  if (!channel || !channel.messages?.fetch || !client.user?.id) return;
  const fetched = await channel.messages.fetch({ limit }).catch(() => null);
  if (!fetched) return;

  const tasks = [];
  for (const msg of fetched.values()) {
    if (!isTransientBotMessage(msg)) continue;
    tasks.push(msg.delete().catch(() => {}));
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

async function clearOldInstantMegaphonesInChannel(channel, { limit = 100 } = {}) {
  if (!channel || !channel.messages?.fetch || !client.user?.id) return;
  const fetched = await channel.messages.fetch({ limit }).catch(() => null);
  if (!fetched) return;

  const tasks = [];
  for (const msg of fetched.values()) {
    if (!inferInstantCommandFromMessage(msg)?.query) continue;
    tasks.push(clearInstantMegaphoneReaction(msg));
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

function messageHasStaleUiComponents(msg) {
  if (!msg || msg.author?.id !== client.user?.id) return false;
  const rows = Array.isArray(msg.components) ? msg.components : [];
  for (const row of rows) {
    const comps = Array.isArray(row?.components) ? row.components : [];
    for (const comp of comps) {
      const cid = String(comp?.customId || '');
      if (!cid) continue;
      if (STALE_UI_COMPONENT_PREFIXES.some((prefix) => cid.startsWith(prefix))) return true;
    }
  }
  return false;
}

async function clearStaleUiMessagesInChannel(channel, { limit = 100 } = {}) {
  if (!channel || !channel.messages?.fetch || !client.user?.id) return;
  const fetched = await channel.messages.fetch({ limit }).catch(() => null);
  if (!fetched) return;

  const tasks = [];
  for (const msg of fetched.values()) {
    if (!messageHasStaleUiComponents(msg)) continue;
    tasks.push(msg.delete().catch(() => {}));
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

async function clearNowPlayingMessagesInAllGuildTextChannels() {
  const tasks = [];
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (!channel || !channel.isTextBased?.() || !channel.messages?.fetch) continue;
      tasks.push(clearNowPlayingMessagesInChannel(channel).catch(() => {}));
      tasks.push(clearTransientBotMessagesInChannel(channel).catch(() => {}));
      tasks.push(clearStaleUiMessagesInChannel(channel).catch(() => {}));
    }
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

async function clearOldInstantMegaphonesInAllGuildTextChannels() {
  const tasks = [];
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (!channel || !channel.isTextBased?.() || !channel.messages?.fetch) continue;
      tasks.push(clearOldInstantMegaphonesInChannel(channel).catch(() => {}));
    }
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
  const bulkDeleteAgeDays = Number(BOT_CFG.ui?.clearBulkDeleteAgeDays) || 14;
  const fourteenDaysMs = bulkDeleteAgeDays * 24 * 60 * 60 * 1000;
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
      'Central de ajuda do BotDucz: use **+p**, **+play** ou **+tocar** para músicas e **+i** para sons instantâneos. Comandos em PT-BR e EN disponíveis.'
    )
    .addFields(
      {
        name: '🚀 Comandos principais (PT-BR / EN)',
        value:
          '**PT-BR**\n' +
          '`+p <texto|link>` • `+tocar <texto|link>` • `+i <texto|link-myinstants>`\n' +
          '`+stop` • `+skip`\n\n' +
          '**EN**\n' +
          '`+play <text|link>` • `+i <text|myinstants-link>`\n\n' +
          'Exemplos: `+p legiao urbana`, `+play queen bohemian rhapsody`, `+i risada`\n' +
          'Alias legado aceito: `+d` / `+Ducz`.',
      },
      {
        name: '▶️ Instant do MyInstants (PT-BR / EN)',
        value:
          '```\n+i <link-do-myinstants>\n```\nExemplo: `+i https://www.myinstants.com/pt/instant/briga-de-gato-25101/`',
      },
      {
        name: '🔍 Buscar instant (PT-BR / EN)',
        value:
          '```\n+i <descricao do som>\n```\nExemplo: `+i briga de gato`\n' +
          '💡 *Instants tocam instantaneamente, mesmo com qualquer áudio tocando!*\n' +
          '🦆 Reaja com **🦆** para repetir • 📢 **📢** para tocar mais alto (uma vez) • ⭐ **⭐** para favoritar',
      },
      {
        name: '🎬 Tocar música por link (PT-BR / EN)',
        value:
          '```\n+p <youtube|soundcloud|spotify>\n\n+play <youtube|soundcloud|spotify>\n\n+tocar <youtube|soundcloud|spotify>\n```\nSuportado: YouTube, SoundCloud, Spotify (track/playlist/album/artist)\nExemplo: `+p https://www.youtube.com/watch?v=dQw4w9WgXcQ`',
      },
      {
        name: '🔎 Buscar e tocar música (PT-BR / EN)',
        value:
          '```\n+p <nome da música>\n+play <music name>\n+tocar <nome da música>\n```\nExemplo: `+p nirvana smells like teen spirit`',
      },
      {
        name: '📋 Playlist do YouTube (PT-BR / EN)',
        value:
          '```\n+p <link-da-playlist>\n```\nColoque um link com `&list=` e todas as músicas serão adicionadas à fila!',
      },
      {
        name: '⏭️ Pular música (PT-BR / EN)',
        value: '```\n+skip\n+pular\n```',
      },
      {
        name: '📋 Ver fila de músicas (PT-BR / EN)',
        value:
          '**Visualizar / navegar**\n' +
          '`+fila` • `+queue` • `+fila <n>`\n\n' +
          '**Remover por posição**\n' +
          '`+fila remove <n>` • `+queue remove <n>` • `+remove <n>` • `+rm <n>`\n\n' +
          '**Remover atual**\n' +
          '`+fila remove atual` • `+remove atual` • `+rm atual`',
      },
      {
        name: '💾 Playlists salvas (PT-BR / EN)',
        value:
          '**PT-BR**\n' +
          '`+fila listar` • `+fila salvar <nome>` • `+fila carregar <nome|numero>`\n' +
          '`+fila atualizar <nome>` • `+fila apagar <nome|numero>`\n\n' +
          '**EN**\n' +
          '`+fila list` • `+fila save <name>` • `+fila load <name|number>`\n' +
          '`+fila update <name>` • `+fila delete <name|number>`\n\n' +
          '**Atalhos**\n' +
          '`+playlist ...` • `+pl ...`\n\n' +
          '**Painel +fila**\n' +
          '`Tocar (#)` • `Remover (#)` • `Reiniciar` • `Loop Playlist`\n' +
          '`Atualizar Playlist` • `Apagar Playlist` • `Carregar salva (#/nome)`\n' +
          '`Playlists salvas` • `Apagar salva (#/nome)` • `Descartar`',
      },
      {
        name: '⏹️ Parar e limpar fila (PT-BR / EN)',
        value: '```\n+stop\n+parar\n```',
      },
      {
        name: '🎛️ Efeitos de áudio (PT-BR / EN)',
        value:
          '```\n+efeito <nome> [1-10]\n+ef <nome> [1-10]\n+ef\n+ef <1-10>\n+ef status\n+ef off\n+ef lista\n+efeitos\n```\nEx: `+efeito robot 8`, `+ef robot 8`, `+ef`',
      },
      {
        name: '🧠 Funcionalidades',
        value:
          '• YouTube, SoundCloud, Spotify e MyInstants\n' +
          '• Fila paginada com botões e jump por número\n' +
          '• Remoção por posição e remoção da música atual\n' +
          '• Playlists salvas (salvar, carregar, atualizar, apagar) por nome ou número\n' +
          '• Efeitos de áudio com intensidade por nível\n' +
          '• Reações no +i: 🦆 repetir, 📢 megafone, ⭐ favoritar\n' +
          '• Favoritos compartilhados (`+fav`)\n' +
          '• Limpeza automática de mensagens transitórias de fila/status',
      },
      {
        name: '⚙️ Administração',
        value:
          '```\n+prefix\n+prefix <novo_prefixo>\n+prefix set <novo_prefixo>\n+prefix reset\n+killbot\n```\n`+killbot` é restrito ao dono do bot.',
      },
      {
        name: '🧩 Comandos Slash (/)',
        value:
          '`/play query:<texto|link>`\n' +
          '`/instants query:<texto|link myinstants>`\n' +
          '`/queue [posicao]`\n' +
          '`/remove alvo:<atual|posicao> [posicao]`\n' +
          '`/playlist acao:<listar|salvar|carregar|atualizar|apagar> [referencia]`\n' +
          '`/skip` • `/stop` • `/leave`\n' +
          '`/effect acao:<ativar|off|status|lista> [nome] [intensidade]`\n' +
          '`/prefix acao:<view|set|reset> [valor]`\n' +
          '`/help` • `/killbot`',
      },
      {
        name: '🚪 Sair do canal de voz',
        value: '```\n+sair\n+leave\n```',
      },
      {
        name: '❓ Mostrar ajuda',
        value: '```\n+help\n+ajuda\n```',
      },
      {
        name: '👤 Créditos',
        value:
          'Criado por **Luan Ducate** (github/luanducate)\n' +
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

async function sendTemporaryMessage(message, content, timeoutMs = 15_000) {
  const sent = await message.reply(content).catch(() => null);
  if (!sent) return null;

  setTimeout(() => {
    sent.delete().catch(() => {});
  }, timeoutMs);

  return sent;
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
  const normalizeReplyOptions = (options) => {
    if (typeof options === 'string') return { content: options };
    if (!options || typeof options !== 'object') return { content: String(options ?? '') };
    return options;
  };
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
      const normalized = normalizeReplyOptions(options);
      if (!replied) {
        replied = true;
        return interaction.reply({ ...normalized, fetchReply: true });
      }
      return interaction.followUp(normalized);
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
  let playlistLoadToken = null;
  beginPendingPlayRequest(message.guildId);
  clearSpotifyLoadSession(message.guildId);
  clearQueueStatusMessages(message.guildId);
  clearEmptyQueueMessage(message.guildId);
  await clearNowPlayingMessagesInChannel(message.channel).catch(() => {});

  try {
    const addYouTubeAndFlushDeferredSkip = async (url, title) => {
      const result = await addYouTube(message, url, title);
      trackQueueStatusMessage(message.guildId, result);
      await flushDeferredSkipIfReady(message.guildId).catch(() => {});
      return result;
    };

    const addPlaylistAndFlushDeferredSkip = async (videos, opts = {}) => {
      const result = await addPlaylist(message, videos, opts);
      trackQueueStatusMessage(message.guildId, result);
      await flushDeferredSkipIfReady(message.guildId).catch(() => {});
      return result;
    };

    // Link do SoundCloud: toca diretamente via yt-dlp
    if (SOUNDCLOUD_REGEX.test(input)) {
      if (SOUNDCLOUD_SET_REGEX.test(input)) {
        const scLoadToken = startSpotifyLoadSession(message.guildId);
        playlistLoadToken = scLoadToken;
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
        const soundCloudFirstBatchSize = Number(SOURCES_CFG.soundcloud?.firstBatchSize) || 1;
        const soundCloudBatchSize = Number(SOURCES_CFG.soundcloud?.batchSize) || 5;

        // Flush pending buffer with deterministic batching:
        // - First batch: exactly 1 track (for instant 1st play)
        // - Subsequent batches: exactly 5 tracks each
        const flushPending = async (isFinal = false, maxPerBatch = soundCloudBatchSize) => {
          if (!pending.length) return;
          
          // On first flush (totalAdded === 0), take only first 1 track
          // On subsequent flushes, take up to maxPerBatch (5) tracks
          const batchSize = totalAdded === 0 ? soundCloudFirstBatchSize : maxPerBatch;
          const chunk = pending.splice(0, batchSize);
          
          if (!chunk.length) return;
          
          totalAdded += chunk.length;
          const statusText = isFinal
            ? `✅ SoundCloud: **${totalAdded}** faixas adicionadas à fila!`
            : `📋 SoundCloud: **${totalAdded}** faixas carregadas... ⏳`;

          await addPlaylistAndFlushDeferredSkip(chunk, { skipStatusMessage: true }).catch(() => null);
          progressMsg = await upsertSoundCloudProgressMessage(message, statusText).catch(() => progressMsg);

          for (const track of chunk) {
            enqueueSoundCloudTrackResolve(message.guildId, track);
          }
        };

        for await (const track of getSoundCloudPlaylistTracksStream(input)) {

          if (!isSpotifyLoadSessionActive(message.guildId, scLoadToken)) break;
          pending.push(track);

          // - On first track: flush just that 1
          // - When pending reaches 5+ tracks after first: flush 5 at a time
          if (totalAdded === 0 || pending.length >= soundCloudBatchSize) {
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
          await refreshNowPlayingMessage(message.guildId).catch(() => {});

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
            }, Number(SOURCES_CFG.soundcloud?.finalStatusDeleteDelayMs) || 5000);
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
      return await addYouTubeAndFlushDeferredSkip(input, title || 'faixa do SoundCloud');
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

      return await addYouTubeAndFlushDeferredSkip(resolved.url, resolved.title || `Spotify: ${spotifyQuery}`);
    }

    // Link de playlist/album do Spotify: extrai faixas e resolve para YouTube
    if (SPOTIFY_COLLECTION_REGEX.test(input)) {
      const loadToken = startSpotifyLoadSession(message.guildId);
      playlistLoadToken = loadToken;
      let progressMsg = await message.reply('📋 Lendo playlist/álbum do Spotify...').catch(() => null);
      console.log('📋 Spotify coleção detectada. Iniciando extração de faixas...');

      const spotifyCollectionMaxTracks = Number(SOURCES_CFG.spotify?.collectionMaxTracks) || 500;
      let trackQueries = await getSpotifyCollectionTrackQueriesFromEmbed(input, spotifyCollectionMaxTracks);

      // Fallback via API pública do Spotify quando disponível.
      if (!trackQueries.length) {
        trackQueries = await getSpotifyCollectionTrackQueriesApi(input, spotifyCollectionMaxTracks);
      }

      // Fallback para versões/ambientes onde API não responder.
      if (!trackQueries.length) {
        trackQueries = await getSpotifyCollectionTrackQueriesFallback(input, spotifyCollectionMaxTracks);
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
      const firstChunkSize = Number(SOURCES_CFG.spotify?.initialBatchSize) || 1;
      const chunkSize = Number(SOURCES_CFG.spotify?.batchSize) || 15;
      const firstChunk = targetQueries.slice(0, firstChunkSize);

      const firstVideosRaw = await resolveQueriesToVideos(firstChunk, {
        maxItems: firstChunk.length,
        concurrency: Number(SOURCES_CFG.spotify?.initialResolveConcurrency) || 1,
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
      progressMsg = await addPlaylistAndFlushDeferredSkip(firstVideos, {
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
          concurrency: Number(SOURCES_CFG.spotify?.batchResolveConcurrency) || 15,
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
        progressMsg = await addPlaylistAndFlushDeferredSkip(chunkVideos, {
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

      const videos = await resolveYouTubeSearchMany(
        `${artistName} topic`,
        Number(SOURCES_CFG.youtube?.artistSearchResults) || 15
      );
      if (!videos.length) {
        return message.reply('❌ Não encontrei músicas desse artista no YouTube.');
      }

      return await addPlaylistAndFlushDeferredSkip(videos);
    }

    // Se for link do YouTube (vídeo ou playlist)
    if (YOUTUBE_REGEX.test(input)) {
      if (isPlaylistUrl(input)) {
        const ytProgressMsg = await message.reply('📋 Carregando playlist do YouTube...').catch(() => null);
        console.log('📋 Carregando playlist...');

        // Se a primeira tentativa falhar (lista vazia), tenta novamente uma vez.
        let videos = await getPlaylistVideos(input, Number(SOURCES_CFG.youtube?.playlistMaxVideos) || 50);
        if (!videos || videos.length === 0) {
          console.log('⚠️ Falha ao carregar playlist, tentando novamente...');
          videos = await getPlaylistVideos(input, Number(SOURCES_CFG.youtube?.playlistMaxVideos) || 50);
        }

        if (!videos || videos.length === 0) {
          console.log('❌ Não foi possível carregar a playlist.');
          if (ytProgressMsg) await ytProgressMsg.edit('❌ Não foi possível carregar a playlist.').catch(() => {});
          return;
        }

        return await addPlaylistAndFlushDeferredSkip(videos, { editMsg: ytProgressMsg });
      }

      const title = await getYouTubeTitle(input);
      return await addYouTubeAndFlushDeferredSkip(input, title);
    }

    // Busca no YouTube por termo (padrão)
    const resolved = await resolveYouTubeSearch(query);
    if (!resolved) {
      return sendTemporaryMessage(message, '❌ Não encontrei resultados para essa busca no YouTube.', 15_000);
    }
    return await addYouTubeAndFlushDeferredSkip(resolved.url, resolved.title);
  } catch (error) {
    console.error('❌ Erro:', error.message);
    return message.reply(`❌ Erro: ${error.message}`);
  } finally {
    if (playlistLoadToken) {
      clearSpotifyLoadSession(message.guildId, playlistLoadToken);
    }
    finishPendingPlayRequest(message.guildId);
    await flushDeferredSkipIfReady(message.guildId).catch(() => {});
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
  }
}

async function getMyInstantsSuggestions(query, maxOptions = 3) {
  const effectiveMaxOptions = Number(maxOptions) || Number(BOT_CFG.ui?.myInstantsSuggestionButtons) || 3;
  const terms = normalizeSearchTerms(query);
  const seen = new Set();
  const results = [];

  for (const term of terms) {
    const found = await searchMyInstants(term, Number(BOT_CFG.ui?.myInstantsSearchPerTerm) || 5);
    for (const item of found) {
      const key = item.pageUrl || item.mp3Url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(item);
      if (results.length >= effectiveMaxOptions) return results;
    }
    if (results.length >= effectiveMaxOptions) break;
  }

  return results;
}

async function offerMyInstantsSelections(message, searchQuery, options) {
  const maxSuggestionButtons = Number(BOT_CFG.ui?.myInstantsSuggestionButtons) || 3;
  const suggestionTimeoutMs = Number(BOT_CFG.ui?.myInstantsSelectionTimeoutMs) || 60_000;
  const row = new ActionRowBuilder();
  const components = options.slice(0, maxSuggestionButtons).map((opt, index) =>
    new ButtonBuilder()
      .setCustomId(`myinstants_${index}`)
      .setLabel(`${index + 1}`)
      .setStyle(ButtonStyle.Primary)
  );

  row.addComponents(components);

  const description = options
    .slice(0, maxSuggestionButtons)
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

    existing.options = options.slice(0, maxSuggestionButtons);
    existing.timeoutId = setTimeout(() => {
      pendingMyInstantsSelection.delete(message.author.id);
      existing.selectionMessage.delete().catch(() => {});
    }, suggestionTimeoutMs);

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
  }, suggestionTimeoutMs);

  pendingMyInstantsSelection.set(message.author.id, {
    messageId: reply.id,
    originMessage: message,
    selectionMessage: reply,
    options: options.slice(0, maxSuggestionButtons),
    searchQuery,
    timeoutId,
  });
}

function parseMyInstantsTitleFromSelectionContent(content, index) {
  const safeIndex = Number(index);
  if (!Number.isFinite(safeIndex) || safeIndex < 0) return null;
  const lineNumber = safeIndex + 1;
  const text = String(content || '');
  const lines = text.split(/\r?\n/);
  const marker = `**${lineNumber}.**`;
  const line = lines.find((l) => l.trim().startsWith(marker));
  if (!line) return null;
  return line.replace(marker, '').trim() || null;
}

async function playMyInstantsFromLegacyButton(interaction, index) {
  const inferredTitle = parseMyInstantsTitleFromSelectionContent(interaction.message?.content, index);
  if (!inferredTitle) {
    return interaction.update({ content: '⏳ Seleção expirada. Tente novamente.', components: [] }).catch(() => {});
  }

  await interaction.deferUpdate().catch(() => {});

  const msgAdapter = {
    guild: interaction.guild,
    guildId: interaction.guildId,
    member: interaction.member,
    channel: interaction.channel,
    author: interaction.user,
    reply: (options) => {
      const normalized = typeof options === 'string' ? { content: options } : options;
      return interaction.channel.send(normalized);
    },
  };

  const found = await searchMyInstants(inferredTitle, 1).catch(() => []);
  if (!found.length) {
    return interaction.followUp({ content: '❌ Não consegui reproduzir esse instant antigo. Tente buscar de novo com `+i`.', ephemeral: true }).catch(() => {});
  }

  const picked = found[0];
  try {
    const mp3Url = picked.mp3Url ? picked.mp3Url : await extractMp3Url(picked.pageUrl);
    const tmpFile = await downloadMp3(mp3Url);
    const sfxMessage = await playSfx(msgAdapter, tmpFile, picked.title || inferredTitle);
    setupSfxRepeat(
      interaction.message,
      mp3Url,
      picked.title || inferredTitle,
      inferredTitle,
      interaction.user?.id,
      sfxMessage || null,
      msgAdapter
    );
    return interaction.followUp({
      content: `✅ Instant antigo reproduzido: **${picked.title || inferredTitle}**. O pato/estrela voltaram a funcionar nessa mensagem.`,
      ephemeral: true,
    }).catch(() => {});
  } catch (err) {
    console.error('❌ Erro ao reproduzir instant antigo:', err);
    return interaction.followUp({ content: '❌ Não foi possível reproduzir esse instant antigo.', ephemeral: true }).catch(() => {});
  }
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
    name: 'remove',
    description: 'Remove música atual ou remove por posição da fila',
    options: [
      {
        name: 'alvo',
        type: 3,
        description: 'O que remover',
        required: true,
        choices: [
          { name: 'atual', value: 'atual' },
          { name: 'posicao', value: 'posicao' },
        ],
      },
      {
        name: 'posicao',
        type: 4,
        description: 'Posição da fila (obrigatório quando alvo=posicao)',
        required: false,
        min_value: 1,
      },
    ],
  },
  {
    name: 'playlist',
    description: 'Gerencia playlists salvas (nome ou número da listagem)',
    options: [
      {
        name: 'acao',
        type: 3,
        description: 'Ação da playlist',
        required: true,
        choices: [
          { name: 'listar', value: 'listar' },
          { name: 'salvar', value: 'salvar' },
          { name: 'carregar', value: 'carregar' },
          { name: 'atualizar', value: 'atualizar' },
          { name: 'apagar', value: 'apagar' },
        ],
      },
      {
        name: 'referencia',
        type: 3,
        description: 'Nome da playlist ou número da listagem',
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
    description: 'Visualiza, define ou reseta prefixo personalizado da guild',
    options: [
      {
        name: 'acao',
        type: 3, // STRING
        description: 'Ação de prefixo',
        required: true,
        choices: [
          { name: 'view', value: 'view' },
          { name: 'set', value: 'set' },
          { name: 'reset', value: 'reset' },
        ],
      },
      {
        name: 'valor',
        type: 3, // STRING
        description: 'Prefixo para set',
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
// ============================================================
function onClientReady() {
  console.log(`✅ BotDucz está online como ${client.user.tag}`);
  console.log(`📡 Conectado a ${client.guilds.cache.size} servidor(es)`);
  console.log(`🧩 BotDucz ${BOT_BUILD_TAG}`);  
  console.log(`🕒 Auto-leave sozinho: ${AUTO_LEAVE_MINUTES} minuto(s)`);
  updatePresenceHelpHint(null, '+p');
  updateBotPresence(null);
  loadPrefixes();
  registerSlashCommands();
  clearNowPlayingMessagesInAllGuildTextChannels().catch(() => {});
  clearOldInstantMegaphonesInAllGuildTextChannels().catch(() => {});
}

client.once('clientReady', onClientReady);
client.on('messageReactionAdd', async (reaction, user) => {
  await handleLegacyInstantReaction(reaction, user, { isRemoval: false }).catch(() => {});
});

client.on('messageReactionRemove', async (reaction, user) => {
  await handleLegacyInstantReaction(reaction, user, { isRemoval: true }).catch(() => {});
});

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
      const requiresSpace = ['+p', '+play', '+tocar', '+d', '+i', '+fav', '+efeito', '+efeitos', '+effect', '+ef', '+remove', '+rm', '+playlist', '+pl', '+clear', '+parar', '+pular', '+sair', '+leave', '+ajuda', '+prefix'].includes(lower);
      if (requiresSpace && nextChar && !/\s/.test(nextChar)) continue;
      usedPrefix = p;
      break;
    }
  }
  if (!usedPrefix) return;

  updatePresenceHelpHint(message.guildId, usedPrefix);

  // Suporte a comandos como +skip / +stop sem precisar do +d
  const normalizedPrefix = usedPrefix.toLowerCase();
  if (normalizedPrefix === '+skip') {
    const result = await runSkipOrDefer(message);
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
    return result;
  }
  if (normalizedPrefix === '+stop') {
    clearSpotifyLoadSession(message.guildId);
    clearDeferredSkip(message.guildId);
    clearActiveLoadedPlaylist(message.guildId);
    const result = await stop(message);
    updateBotPresence(null);
    await clearQueueMessagesForGuild(message.guildId).catch(() => {});
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
    return result;
  }
  if (normalizedPrefix === '+parar') {
    clearSpotifyLoadSession(message.guildId);
    clearDeferredSkip(message.guildId);
    clearActiveLoadedPlaylist(message.guildId);
    const result = await stop(message);
    updateBotPresence(null);
    await clearQueueMessagesForGuild(message.guildId).catch(() => {});
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
    return result;
  }
  if (normalizedPrefix === '+pular') {
    const result = await runSkipOrDefer(message);
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
    return result;
  }
  if (normalizedPrefix === '+remove' || normalizedPrefix === '+rm') {
    const raw = message.content.slice(usedPrefix.length).trim();
    const normalizedRaw = raw.toLowerCase();
    if (normalizedRaw === 'atual' || normalizedRaw === 'current' || normalizedRaw === 'now') {
      const result = await removeCurrentSongByCommand(message);
      await refreshQueueMessagesForGuild(message.guildId, { forceCurrentSongPage: true }).catch(() => {});
      return result;
    }
    const target = Number(raw);
    if (Number.isNaN(target) || target < 1) {
      return message.reply('❌ Uso: `+remove <número>` / `+rm <número>` ou `+remove atual` / `+rm atual`.');
    }
    const result = await removeQueuePositionByCommand(message, target);
    await refreshQueueMessagesForGuild(message.guildId, { forceCurrentSongPage: true }).catch(() => {});
    return result;
  }
  if (normalizedPrefix === '+playlist' || normalizedPrefix === '+pl') {
    const raw = message.content.slice(usedPrefix.length).trim();
    return handlePlaylistCommand(message, raw);
  }
  if (normalizedPrefix === '+sair' || normalizedPrefix === '+leave') {
    clearSpotifyLoadSession(message.guildId);
    clearDeferredSkip(message.guildId);
    clearActiveLoadedPlaylist(message.guildId);
    const result = leave(message);
    updateBotPresence(null);
    await clearQueueMessagesForGuild(message.guildId).catch(() => {});
    await clearNowPlayingMessagesInChannel(message.channel).catch(() => {});
    return result;
  }
  if (normalizedPrefix === '+ajuda') return sendDismissableHelpMessage(message);
  if (normalizedPrefix === '+prefix') {
    const raw = message.content.slice(usedPrefix.length).trim();
    const parts = raw ? ['prefix', ...raw.split(/\s+/)] : ['prefix'];
    const sub = parts[1]?.toLowerCase();
    if (!sub) {
      const custom = guildPrefixes[message.guildId] || [];
      return message.reply(
        `Prefixos atuais: ${getPrefixes(message.guildId).join(', ')}\n` +
          `Prefixos personalizados: ${custom.length ? custom.join(', ') : 'nenhum'}\n` +
          'Uso: `+prefix <novo_prefixo>` | `+prefix set <novo_prefixo>` | `+prefix reset`'
      );
    }
    if (sub === 'reset') {
      setPrefixes(message.guildId, []);
      updatePresenceHelpHint(message.guildId, '+p');
      updateBotPresence(null);
      return message.reply('✅ Prefixo personalizado removido (voltou para os padrões).');
    }
    const isSetKeyword = sub === 'set';
    const newPrefix = isSetKeyword ? parts[2] : parts[1];
    if (!newPrefix) {
      return message.reply('❌ Uso: `+prefix <novo_prefixo>` | `+prefix set <novo_prefixo>` | `+prefix reset`');
    }
    setPrefixes(message.guildId, [newPrefix]);
    updatePresenceHelpHint(message.guildId, newPrefix);
    updateBotPresence(null);
    return message.reply(`✅ Prefixo personalizado definido para **${newPrefix}**.`);
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

      const lines = favs.slice(0, Number(BOT_CFG.ui?.favoritesPreviewLimit) || 20).map((f, i) => {
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
    const playlistMatch = remaining.match(/^(listar|list|ls|salvar|save|carregar|load|atualizar|update|apagar|delete|del)(?:\s+(.+))?$/i);
    if (playlistMatch) {
      const action = String(playlistMatch[1] || '').trim().toLowerCase();
      const name = String(playlistMatch[2] || '').trim();
      const mapped = ['listar', 'list', 'ls'].includes(action)
        ? 'listar'
        : ['salvar', 'save'].includes(action)
          ? 'salvar'
          : ['carregar', 'load'].includes(action)
            ? 'carregar'
            : ['atualizar', 'update'].includes(action)
              ? 'atualizar'
              : 'apagar';
      const forwarded = name ? `${mapped} ${name}` : mapped;
      return handlePlaylistCommand(message, forwarded);
    }

    const removeCurrentMatch = remaining.match(/^(remove|rm|del|remover)\s+(atual|current|now)$/i);
    if (removeCurrentMatch) {
      const result = await removeCurrentSongByCommand(message);
      await refreshQueueMessagesForGuild(message.guildId, { forceCurrentSongPage: true }).catch(() => {});
      return result;
    }
    const removeMatch = remaining.match(/^(remove|rm|del|remover)\s+(\d+)$/i);
    if (removeMatch) {
      const target = Number(removeMatch[2]);
      const result = await removeQueuePositionByCommand(message, target);
      await refreshQueueMessagesForGuild(message.guildId, { forceCurrentSongPage: true }).catch(() => {});
      return result;
    }
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
      clearEffectErrorMessage(message.guildId);
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
      clearEffectErrorMessage(message.guildId);
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
        clearEffectErrorMessage(message.guildId);
        return message.reply('ℹ️ Nenhum efeito ativo. Ative um efeito primeiro com `+efeito <nome>` ou `+ef <nome>`.');
      }
      if (!effectSupportsIntensity(currentEffect)) {
        clearEffectErrorMessage(message.guildId);
        return message.reply(`ℹ️ O efeito **${currentEffect}** não usa intensidade. Ele tem configuração fixa.`);
      }
      setEffectIntensity(message.guildId, firstNum);
      const appliedNow = applyEffectNow(message.guildId);
      clearEffectErrorMessage(message.guildId);
      return sendTimedEffectConfirm(message, message.guildId,
        appliedNow
          ? `✅ Efeito **${currentEffect}** (intensidade ${firstNum}/10) aplicado imediatamente.`
          : `✅ Efeito **${currentEffect}** (intensidade ${firstNum}/10) definido.`
      );
    }

    const effect = parts[0];
    const rawI = parts[1] ? parseInt(parts[1], 10) : null;
    const intensity = (rawI !== null && !isNaN(rawI) && rawI >= 1 && rawI <= 10) ? rawI : null;

    if (effect === 'status') {
      clearEffectErrorMessage(message.guildId);
      return message.reply(
        currentEffect
          ? `🎛️ Efeito atual: **${currentEffect}** | Intensidade: **${currentIntensity}/10**`
          : '🎛️ Nenhum efeito ativo.'
      );
    }

    console.log(`🎛️ [guild ${message.guildId}] comando +efeito -> ${effect} (intensidade: ${intensity ?? currentIntensity})`);

    if (effect === 'off' || effect === 'none') {
      if (!currentEffect) {
        clearEffectErrorMessage(message.guildId);
        return message.reply('ℹ️ O efeito já está desativado.');
      }

      setEffect(message.guildId, null);
      const appliedNow = applyEffectNow(message.guildId);
      clearEffectErrorMessage(message.guildId);
      return sendTimedEffectConfirm(message, message.guildId,
        appliedNow ? '✅ Efeitos desativados e aplicado à música atual.' : '✅ Efeitos desativados.'
      );
    }

    if (!list.includes(effect)) {
      return sendTimedEffectError(message, message.guildId, `❌ Efeito desconhecido. Use um dos: ${list.join(', ')}\nDica: \`+efeito <nome> <1-10>\` ou \`+ef <nome> <1-10>\`.`);
    }

    if (intensity !== null && effectSupportsIntensity(effect)) {
      setEffectIntensity(message.guildId, intensity);
    }

    // Mesmo efeito ativo sem nova intensidade = sem mudança
    if (currentEffect === effect && intensity === null) {
      clearEffectErrorMessage(message.guildId);
      return sendTimedEffectConfirm(
        message,
        message.guildId,
        `ℹ️ O efeito **${effect}** já está ativo (intensidade ${currentIntensity}/10). Use \`+efeito ${effect} <1-10>\` ou \`+ef ${effect} <1-10>\` para mudar a intensidade.`
      );
    }

    setEffect(message.guildId, effect);
    const appliedNow = applyEffectNow(message.guildId);
    const supportsIntensity = effectSupportsIntensity(effect);
    const effectiveIntensity = getEffectIntensity(message.guildId);
    clearEffectErrorMessage(message.guildId);
    return sendTimedEffectConfirm(
      message,
      message.guildId,
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
  if (cmd === 'help') return sendDismissableHelpMessage(message);
  if (normalizedPrefix === '+p' && ['skip', 'pular', 'stop', 'parar', 'sair', 'leave', 'help', 'ajuda', 'queue', 'fila', 'remove', 'rm', 'playlist', 'pl', 'prefix', 'instant', 'instants'].includes(cmd)) {
    return message.reply('ℹ️ O `+p` agora é exclusivo para tocar música. Use `+skip`, `+stop`, `+fila`, `+remove`, `+playlist`, `+help`, `+sair`, `+prefix` e `+i` para os demais comandos.');
  }
  if (cmd === 'play' || cmd === 'tocar') {
    if (normalizedPrefix === '+p') {
      return message.reply('ℹ️ Use `+p <texto|link>` (sem `play`/`tocar` depois do `+p`).');
    }
    const query = argsParts.slice(1).join(' ').trim();
    if (!query) return message.reply('❌ Uso: `+p <texto|link>` ou `+play <texto|link>` ou `+tocar <texto|link>`.');
    await handlePlayQuery(message, query);
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
    return;
  }
  if (cmd === 'instant' || cmd === 'instants') {
    const query = argsParts.slice(1).join(' ').trim();
    if (!query) return message.reply('❌ Uso: `+i <texto|link-myinstants>`.');
    if (normalizedPrefix === '+p') {
      return message.reply('ℹ️ Para instant use `+i <texto|link-myinstants>` (sem `+p`).');
    }
    return handleInstantsQuery(message, query);
  }
  if (cmd === 'parar' || cmd === 'stop') {
    if (normalizedPrefix === '+p') {
      return message.reply('ℹ️ Use `+stop` ou `+parar` (sem `+p`).');
    }
    clearSpotifyLoadSession(message.guildId);
    clearDeferredSkip(message.guildId);
    clearActiveLoadedPlaylist(message.guildId);
    const result = await stop(message, (text) => sendEphemeralMessage(message, text));
    updateBotPresence(null);
    await clearQueueMessagesForGuild(message.guildId).catch(() => {});
    await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
    return result;
  }
  if (cmd === 'sair') {
    if (normalizedPrefix === '+p') {
      return message.reply('ℹ️ Use `+sair` ou `+leave` (sem `+p`).');
    }
    clearSpotifyLoadSession(message.guildId);
    clearDeferredSkip(message.guildId);
    clearActiveLoadedPlaylist(message.guildId);
    const result = leave(message);
    updateBotPresence(null);
    await clearQueueMessagesForGuild(message.guildId).catch(() => {});
    await clearNowPlayingMessagesInChannel(message.channel).catch(() => {});
    return result;
  }
  if (cmd === 'skip' || cmd === 'pular') {
    if (normalizedPrefix === '+p') {
      return message.reply('ℹ️ Use `+skip` ou `+pular` (sem `+p`).');
    }
    const result = await runSkipOrDefer(
      message,
      (text) => sendEphemeralMessage(message, text),
      (text) => sendEphemeralMessage(message, text)
    );
    await refreshQueueMessagesForGuild(message.guildId, { forceCurrentSongPage: true }).catch(() => {});
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
    if (normalizedPrefix === '+p') {
      return message.reply('ℹ️ Use `+prefix` (sem `+p`) para gerenciar prefixos.');
    }
    const sub = argsParts[1]?.toLowerCase();
    if (!sub) {
      const custom = guildPrefixes[message.guildId] || [];
      return message.reply(
        `Prefixos atuais: ${getPrefixes(message.guildId).join(', ')}\n` +
          `Prefixos personalizados: ${custom.length ? custom.join(', ') : 'nenhum'}\n` +
          'Uso: `+prefix <novo_prefixo>` | `+prefix set <novo_prefixo>` | `+prefix reset`'
      );
    }

    if (sub === 'reset') {
      setPrefixes(message.guildId, []);
      updatePresenceHelpHint(message.guildId, '+p');
      updateBotPresence(null);
      return message.reply('✅ Prefixo personalizado removido (voltou para os padrões).');
    }

    const isSetKeyword = sub === 'set';
    const newPrefix = isSetKeyword ? argsParts[2] : argsParts[1];
    if (!newPrefix) {
      return message.reply('❌ Uso: `+prefix <novo_prefixo>` | `+prefix set <novo_prefixo>` | `+prefix reset`');
    }

    setPrefixes(message.guildId, [newPrefix]);
    updatePresenceHelpHint(message.guildId, newPrefix);
    updateBotPresence(null);
    return message.reply(`✅ Prefixo personalizado definido para **${newPrefix}**.`);
  }

  if (cmd === 'fila' || cmd === 'queue') {
    const sub = (argsParts[1] || '').toLowerCase();

    if (['listar', 'list', 'ls'].includes(sub)) {
      return handlePlaylistCommand(message, 'listar');
    }

    if (['salvar', 'save', 'carregar', 'load', 'atualizar', 'update', 'apagar', 'delete', 'del'].includes(sub)) {
      const name = argsParts.slice(2).join(' ').trim();
      if (!name && !['listar', 'list', 'ls'].includes(sub)) {
        return message.reply('❌ Informe o nome. Ex: `+fila salvar academia`');
      }
      const mapped = ['salvar', 'save'].includes(sub)
        ? 'salvar'
        : ['carregar', 'load'].includes(sub)
          ? 'carregar'
          : ['atualizar', 'update'].includes(sub)
            ? 'atualizar'
            : 'apagar';
      return handlePlaylistCommand(message, `${mapped} ${name}`.trim());
    }

    if (['remove', 'rm', 'del', 'remover'].includes(sub)) {
      const maybeCurrent = (argsParts[2] || '').toLowerCase();
      if (['atual', 'current', 'now'].includes(maybeCurrent)) {
        const result = await removeCurrentSongByCommand(message);
        await refreshQueueMessagesForGuild(message.guildId, { forceCurrentSongPage: true }).catch(() => {});
        return result;
      }
      const target = Number(argsParts[2]);
      if (Number.isNaN(target) || target < 1) {
        return message.reply('❌ Uso: `+fila remove <número>` / `+queue remove <número>` ou `+fila remove atual`.');
      }
      const result = await removeQueuePositionByCommand(message, target);
      await refreshQueueMessagesForGuild(message.guildId, { forceCurrentSongPage: true }).catch(() => {});
      return result;
    }

    if (/^\d+$/.test(argsParts[1] || '')) {
      const target = Number(argsParts[1]);
      const result = await jumpToQueue(message, target);
      await refreshQueueMessagesForGuild(message.guildId).catch(() => {});
      return result;
    }

    return showQueueMessage(message);
  }

  if (cmd === 'playlist' || cmd === 'pl') {
    const subRaw = argsParts.slice(1).join(' ').trim();
    return handlePlaylistCommand(message, subRaw);
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
      const result = await runSkipOrDefer(
        msg,
        (text) => msg.reply({ content: text, ephemeral: true }),
        (text) => interaction.reply({ content: text, ephemeral: true })
      );
      await refreshQueueMessagesForGuild(msg.guildId).catch(() => {});
      return result;
    }

    if (cmd === 'stop') {
      clearSpotifyLoadSession(msg.guildId);
      clearDeferredSkip(msg.guildId);
      clearActiveLoadedPlaylist(msg.guildId);
      const result = await stop(msg, (text) => msg.reply({ content: text, ephemeral: true }));
      updateBotPresence(null);
      await clearQueueMessagesForGuild(msg.guildId).catch(() => {});
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

    if (cmd === 'remove') {
      if (isPlaylistLoadInProgress(msg.guildId)) {
        return interaction.reply({ content: '⏳ A playlist ainda está carregando. Aguarde finalizar para remover.', ephemeral: true });
      }

      const alvo = interaction.options.getString('alvo');
      if (alvo === 'atual') {
        const result = await removeCurrentSongByCommand(msg);
        await refreshQueueMessagesForGuild(msg.guildId, { forceCurrentSongPage: true }).catch(() => {});
        return result;
      }

      const posicao = interaction.options.getInteger('posicao');
      if (!Number.isFinite(posicao) || posicao < 1) {
        return interaction.reply({ content: '❌ Informe `posicao` quando `alvo=posicao`.', ephemeral: true });
      }

      const result = await removeQueuePositionByCommand(msg, posicao);
      await refreshQueueMessagesForGuild(msg.guildId, { forceCurrentSongPage: true }).catch(() => {});
      return result;
    }

    if (cmd === 'playlist') {
      const action = String(interaction.options.getString('acao') || '').toLowerCase();
      const ref = String(interaction.options.getString('referencia') || '').trim();

      if (action === 'listar') {
        return handlePlaylistCommand(msg, 'listar');
      }

      if (!ref) {
        return interaction.reply({ content: '❌ Informe `referencia` (nome ou número) para essa ação.', ephemeral: true });
      }

      return handlePlaylistCommand(msg, `${action} ${ref}`.trim());
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
      clearEffectErrorMessage(msg.guildId);
      return sendTimedEffectConfirm(msg, msg.guildId,
        appliedNow
          ? supportsIntensity
            ? `✅ Efeito **${effect}** (intensidade ${effectiveIntensity}/10) ativado e aplicado imediatamente.`
            : `✅ Efeito **${effect}** ativado e aplicado imediatamente.`
          : supportsIntensity
            ? `✅ Efeito **${effect}** (intensidade ${effectiveIntensity}/10) ativado. Vale para as próximas músicas.`
            : `✅ Efeito **${effect}** ativado. Vale para as próximas músicas.`
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

      if (action === 'set') {
        if (!value) return msg.reply('❌ Informe o valor do prefixo em `valor`.');
        setPrefixes(msg.guildId, [value]);
        updatePresenceHelpHint(msg.guildId, value);
        updateBotPresence(null);
        return msg.reply(`✅ Prefixo personalizado definido para **${value}**.`);
      }

      if (action === 'reset') {
        setPrefixes(msg.guildId, []);
        updatePresenceHelpHint(msg.guildId, '+p');
        updateBotPresence(null);
        return msg.reply('✅ Prefixo personalizado removido (voltou para os padrões).');
      }
    }

    if (cmd === 'leave') {
      clearSpotifyLoadSession(msg.guildId);
      clearDeferredSkip(msg.guildId);
      clearActiveLoadedPlaylist(msg.guildId);
      const result = leave(msg);
      updateBotPresence(null);
      await clearQueueMessagesForGuild(msg.guildId).catch(() => {});
      await clearNowPlayingMessagesInChannel(msg.channel).catch(() => {});
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
    if (interaction.customId === 'queue_play_modal') {
      if (isPlaylistLoadInProgress(interaction.guildId)) {
        return interaction.reply({
          content: '⏳ A playlist ainda está carregando. Aguarde finalizar para usar Tocar (#).',
          ephemeral: true,
        });
      }

      const positionValue = interaction.fields.getTextInputValue('queuePosition');
      const position = Number(positionValue);
      if (Number.isNaN(position) || position < 1) {
        return interaction.reply({ content: '❌ Número inválido. Use um número válido da fila.', ephemeral: true });
      }

      const { queue } = getQueue(interaction.guildId);
      const { loopPlaylist, playlistSongs } = getQueueFull(interaction.guildId);
      const totalSongs = loopPlaylist ? playlistSongs.length : queue.length;
      if (!totalSongs) {
        return interaction.reply({ content: '❌ A fila está vazia.', ephemeral: true });
      }
      if (position > totalSongs) {
        return interaction.reply({
          content: `❌ A fila tem apenas **${totalSongs}** música(s). Não existe a posição **${position}**.`,
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const success = await jumpTo(interaction.guildId, position);
      if (!success) {
        return interaction.editReply('❌ Não consegui ir para essa música. Tente abrir `+fila` novamente.');
      }

      await refreshQueueMessagesForGuild(interaction.guildId, { forceCurrentSongPage: true }).catch(() => {});
      await interaction.editReply(`▶️ Indo para a música #${position} da fila...`);
      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, 10_000);
      return;
    }

    if (interaction.customId === 'queue_remove_modal') {
      if (isPlaylistLoadInProgress(interaction.guildId)) {
        return interaction.reply({
          content: '⏳ A playlist ainda está carregando. Aguarde finalizar para usar Remover (#).',
          ephemeral: true,
        });
      }

      const positionValue = interaction.fields.getTextInputValue('queueRemovePosition');
      const position = Number(positionValue);
      if (Number.isNaN(position) || position < 1) {
        return interaction.reply({ content: '❌ Número inválido. Use um número válido da fila.', ephemeral: true });
      }

      const result = await removeQueuePosition(interaction.guildId, position);
      if (!result?.ok) {
        return interaction.reply({ content: '❌ Não consegui remover essa música. Confira a posição em `+fila`.', ephemeral: true });
      }

      await refreshQueueMessagesForGuild(interaction.guildId, { forceCurrentSongPage: true }).catch(() => {});
      if (result.removedCurrent) {
        await refreshNowPlayingMessage(interaction.guildId, { forceResend: true }).catch(() => {});
      }

      const removedTitle = result.removedSong?.title || 'música';
      return interaction.reply({ content: `🗑️ Removida a música #${position}: **${removedTitle}**.`, ephemeral: true });
    }

    if (interaction.customId === 'queue_saved_delete_modal') {
      const value = String(interaction.fields.getTextInputValue('savedPlaylistRef') || '').trim();
      if (!value) {
        return interaction.reply({ content: '❌ Informe o nome ou número da playlist salva.', ephemeral: true });
      }

      const entries = listSavedPlaylistEntries(interaction.guildId);
      let resolvedName = value;
      if (/^\d+$/.test(value)) {
        const idx = Number(value) - 1;
        resolvedName = entries[idx]?.storageName || '';
      }
      if (!resolvedName) {
        return interaction.reply({ content: '❌ Playlist não encontrada para apagar (nome ou número inválido).', ephemeral: true });
      }

      const ok = deleteSavedPlaylist(interaction.guildId, resolvedName);
      if (!ok) {
        return interaction.reply({ content: '❌ Playlist não encontrada para apagar.', ephemeral: true });
      }

      if (getActiveLoadedPlaylist(interaction.guildId) === normalizePlaylistName(resolvedName)) {
        clearActiveLoadedPlaylist(interaction.guildId);
      }
      await refreshQueueMessagesForGuild(interaction.guildId).catch(() => {});
      return interaction.reply({ content: `🗑️ Playlist **${normalizePlaylistName(resolvedName)}** removida.`, ephemeral: true });
    }

    if (interaction.customId === 'queue_saved_load_modal') {
      if (isPlaylistLoadInProgress(interaction.guildId)) {
        return interaction.reply({
          content: '⏳ A playlist ainda está carregando. Aguarde finalizar para carregar outra playlist salva.',
          ephemeral: true,
        });
      }

      const value = String(interaction.fields.getTextInputValue('savedPlaylistLoadRef') || '').trim();
      if (!value) {
        return interaction.reply({ content: '❌ Informe o nome ou número da playlist salva.', ephemeral: true });
      }

      const entries = listSavedPlaylistEntries(interaction.guildId);
      let resolvedName = value;
      if (/^\d+$/.test(value)) {
        const idx = Number(value) - 1;
        resolvedName = entries[idx]?.storageName || '';
      }
      if (!resolvedName) {
        return interaction.reply({ content: '❌ Playlist não encontrada para carregar (nome ou número inválido).', ephemeral: true });
      }

      const found = getSavedPlaylistEntry(interaction.guildId, resolvedName);
      if (!found) {
        return interaction.reply({ content: '❌ Playlist não encontrada para carregar.', ephemeral: true });
      }

      const msgAdapter = createInteractionMessageAdapter(interaction);
      const restored = await restorePlaylistSnapshot(msgAdapter, found.entry.snapshot).catch((err) => ({ ok: false, reason: err?.message || 'restore-error' }));
      if (!restored?.ok) {
        return interaction.reply({ content: '❌ Não consegui carregar essa playlist salva.', ephemeral: true });
      }

      setActiveLoadedPlaylist(interaction.guildId, found.name);
      await refreshQueueMessagesForGuild(interaction.guildId, { forceCurrentSongPage: true }).catch(() => {});

      const total = Number(restored.totalSongs) || 0;
      const currentTitle = restored.currentTitle || 'música';
      return interaction.reply({ content: `▶️ Playlist **${found.name}** carregada (${total} música(s)). Tocando: **${currentTitle}**.`, ephemeral: true });
    }

    if (interaction.customId === 'queue_save_modal') {
      if (isPlaylistLoadInProgress(interaction.guildId)) {
        return interaction.reply({
          content: '⏳ A playlist ainda está carregando. Aguarde finalizar para salvar.',
          ephemeral: true,
        });
      }

      const playlistName = String(interaction.fields.getTextInputValue('playlistName') || '').trim();
      if (!playlistName) {
        return interaction.reply({ content: '❌ Informe um nome para a playlist.', ephemeral: true });
      }

      const existing = getSavedPlaylistEntry(interaction.guildId, playlistName);
      if (existing) {
        return interaction.reply({ content: '⚠️ Já existe playlist com esse nome. Use `+playlist atualizar <nome>` para sobrescrever.', ephemeral: true });
      }

      const snapshot = getPlaylistSnapshot(interaction.guildId);
      if (!snapshot) {
        return interaction.reply({ content: '❌ Não há playlist/fila ativa para salvar agora.', ephemeral: true });
      }

      const saved = upsertSavedPlaylist(interaction.guildId, playlistName, snapshot);
      if (!saved.ok) {
        return interaction.reply({ content: '❌ Não consegui salvar essa playlist.', ephemeral: true });
      }

      setActiveLoadedPlaylist(interaction.guildId, playlistName);
      const total = (snapshot.currentSong ? 1 : 0) + (Array.isArray(snapshot.queue) ? snapshot.queue.length : 0);
      await refreshQueueMessagesForGuild(interaction.guildId).catch(() => {});
      return interaction.reply({ content: `✅ Playlist **${saved.name}** salva com **${total}** música(s).`, ephemeral: true });
    }

    return;
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
    if (isPlaylistLoadInProgress(interaction.guildId)) {
      return interaction.reply({ content: '⏳ A playlist ainda está carregando. Aguarde finalizar para usar este comando.', ephemeral: true });
    }
    const msgAdapter = createInteractionMessageAdapter(interaction);
    const success = playPrevious(msgAdapter);
    if (!success) {
      return interaction.reply({ content: '❌ Não há música anterior.', ephemeral: true });
    }
    await interaction.deferUpdate();
    await refreshNowPlayingMessage(msgAdapter.guildId, { forceResend: true }).catch(() => {});
    await refreshQueueMessagesForGuild(msgAdapter.guildId).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('music_stop_')) {
    await interaction.deferUpdate();
    const msgAdapter = createInteractionMessageAdapter(interaction);
    clearSpotifyLoadSession(msgAdapter.guildId);
    clearDeferredSkip(msgAdapter.guildId);
    clearActiveLoadedPlaylist(msgAdapter.guildId);
    await stop(msgAdapter, () => Promise.resolve());
    await clearQueueMessagesForGuild(msgAdapter.guildId).catch(() => {});
    await refreshQueueMessagesForGuild(msgAdapter.guildId).catch(() => {});
    await clearNowPlayingMessagesInChannel(interaction.channel).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('music_skip_')) {
    const msgAdapter = createInteractionMessageAdapter(interaction);
    const result = await runSkipOrDefer(
      msgAdapter,
      () => Promise.resolve(),
      (text) => interaction.reply({ content: text, ephemeral: true })
    );
    if (!result?.deferred) {
      await interaction.deferUpdate();
      await refreshNowPlayingMessage(msgAdapter.guildId, { forceResend: true }).catch(() => {});
    }
    await refreshQueueMessagesForGuild(msgAdapter.guildId, { forceCurrentSongPage: true }).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('music_loop_')) {
    const guildId = interaction.customId.slice('music_loop_'.length);
    toggleLoop(guildId);
    const row = buildMusicControlRow(guildId);
    await interaction.update({ components: [row] });
    await refreshNowPlayingMessage(guildId).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('music_remove_current_')) {
    const guildId = interaction.customId.slice('music_remove_current_'.length);
    const result = await removeCurrentSong(guildId);
    if (!result?.ok) {
      return interaction.reply({ content: '❌ Não há música atual para remover.', ephemeral: true });
    }
    await interaction.deferUpdate().catch(() => {});
    await refreshQueueMessagesForGuild(guildId, { forceCurrentSongPage: true }).catch(() => {});
    await refreshNowPlayingMessage(guildId, { forceResend: true }).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('myinstants_')) {
    const entry = pendingMyInstantsSelection.get(interaction.user.id);
    const index = Number(interaction.customId.split('_')[1]);
    if (!entry || entry.messageId !== interaction.message.id) {
      return playMyInstantsFromLegacyButton(interaction, index);
    }

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
    pendingQueueMessages.delete(interaction.message.id);
    if (entry?.timeoutId) clearTimeout(entry.timeoutId);

    await interaction.deferUpdate().catch(() => {});

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
    if (isPlaylistLoadInProgress(interaction.guildId)) {
      return interaction.reply({
        content: '⏳ A playlist ainda está carregando. Aguarde finalizar para usar navegação da fila.',
        ephemeral: true,
      });
    }

    const parts = interaction.customId.split('_');
    const nextPage = Number(parts[3]);
    const entry = ensureQueueInteractionState(interaction, nextPage);
    if (!entry) return interaction.deferUpdate();

    // Responde imediatamente ao Discord
    await interaction.deferUpdate();

    // Atualiza a mensagem com a próxima página
    await showQueueMessage(interaction.message, nextPage, interaction.message);
  }

  if (interaction.customId.startsWith('queue_remove_current_')) {
    const entry = ensureQueueInteractionState(interaction);
    if (!entry) return interaction.deferUpdate();

    if (isPlaylistLoadInProgress(interaction.guildId)) {
      return interaction.reply({
        content: '⏳ A playlist ainda está carregando. Aguarde finalizar para remover a música atual.',
        ephemeral: true,
      });
    }

    await interaction.deferUpdate().catch(() => {});
    const result = await removeCurrentSong(interaction.guildId);
    if (!result?.ok) {
      await interaction.followUp({
        content: '❌ Não há música atual para remover.',
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    await refreshQueueMessagesForGuild(interaction.guildId, { forceCurrentSongPage: true }).catch(() => {});
    await showQueueMessage(interaction.message, entry.page || 0, interaction.message).catch(() => {});
    await refreshNowPlayingMessage(interaction.guildId, { forceResend: true }).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('queue_saved_update_')) {
    const entry = ensureQueueInteractionState(interaction);
    if (!entry) return interaction.deferUpdate();

    if (isPlaylistLoadInProgress(interaction.guildId)) {
      return interaction.reply({
        content: '⏳ A playlist ainda está carregando. Aguarde finalizar para atualizar a playlist salva.',
        ephemeral: true,
      });
    }

    const activeName = getActiveLoadedPlaylist(interaction.guildId);
    if (!activeName) {
      return interaction.reply({ content: '❌ Nenhuma playlist carregada para atualizar.', ephemeral: true });
    }

    await interaction.deferUpdate().catch(() => {});
    const msgAdapter = createInteractionMessageAdapter(interaction);
    await handlePlaylistCommand(msgAdapter, `atualizar ${activeName}`).catch(() => {});
    await showQueueMessage(interaction.message, entry.page || 0, interaction.message).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('queue_update_current_')) {
    const entry = ensureQueueInteractionState(interaction);
    if (!entry) return interaction.deferUpdate();

    if (isPlaylistLoadInProgress(interaction.guildId)) {
      return interaction.reply({
        content: '⏳ A playlist ainda está carregando. Aguarde finalizar para atualizar.',
        ephemeral: true,
      });
    }

    const activeName = getActiveLoadedPlaylist(interaction.guildId);
    if (!activeName) {
      return interaction.reply({ content: '❌ Nenhuma playlist carregada para atualizar.', ephemeral: true });
    }

    const snapshot = getPlaylistSnapshot(interaction.guildId);
    if (!snapshot) {
      return interaction.reply({ content: '❌ Não há playlist/fila ativa para atualizar agora.', ephemeral: true });
    }

    const updated = upsertSavedPlaylist(interaction.guildId, activeName, snapshot);
    if (!updated.ok) {
      return interaction.reply({ content: '❌ Não consegui atualizar essa playlist.', ephemeral: true });
    }

    const total = (snapshot.currentSong ? 1 : 0) + (Array.isArray(snapshot.queue) ? snapshot.queue.length : 0);
    await interaction.deferUpdate().catch(() => {});
    await refreshQueueMessagesForGuild(interaction.guildId).catch(() => {});
    await interaction.followUp({ content: `♻️ Playlist **${updated.name}** atualizada com **${total}** música(s).`, ephemeral: true }).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('queue_saved_list_')) {
    const entries = listSavedPlaylistEntries(interaction.guildId);
    if (!entries.length) {
      return interaction.reply({ content: '💾 Nenhuma playlist salva neste servidor.', ephemeral: true });
    }
    const lines = entries.slice(0, 20).map(({ storageName, entry }, idx) => {
      const when = entry?.updatedAt ? `<t:${Math.floor(new Date(entry.updatedAt).getTime() / 1000)}:R>` : 'sem data';
      return `**${idx + 1}.** ${storageName} (${when})`;
    });
    return interaction.reply({ content: `💾 **Playlists salvas**\n${lines.join('\n')}`, ephemeral: true });
  }

  if (interaction.customId.startsWith('queue_saved_load_pick_')) {
    const modal = new ModalBuilder()
      .setCustomId('queue_saved_load_modal')
      .setTitle('Carregar playlist salva')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('savedPlaylistLoadRef')
            .setLabel('Nome ou número da playlist salva')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ex: 2 ou academia')
            .setRequired(true)
        )
      );

    return interaction.showModal(modal);
  }

  if (interaction.customId.startsWith('queue_saved_delete_pick_')) {
    const modal = new ModalBuilder()
      .setCustomId('queue_saved_delete_modal')
      .setTitle('Apagar playlist salva')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('savedPlaylistRef')
            .setLabel('Nome ou número da playlist salva')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ex: 2 ou academia')
            .setRequired(true)
        )
      );

    return interaction.showModal(modal);
  }

  if (interaction.customId.startsWith('queue_saved_delete_')) {
    const entry = ensureQueueInteractionState(interaction);
    if (!entry) return interaction.deferUpdate();

    const activeName = getActiveLoadedPlaylist(interaction.guildId);
    if (!activeName) {
      return interaction.reply({ content: '❌ Nenhuma playlist carregada para apagar.', ephemeral: true });
    }

    await interaction.deferUpdate().catch(() => {});
    const msgAdapter = createInteractionMessageAdapter(interaction);
    await handlePlaylistCommand(msgAdapter, `apagar ${activeName}`).catch(() => {});
    await showQueueMessage(interaction.message, entry.page || 0, interaction.message).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('queue_remove_pick_')) {
    const entry = ensureQueueInteractionState(interaction);
    if (!entry) return interaction.deferUpdate();
    if (isPlaylistLoadInProgress(interaction.guildId)) {
      return interaction.reply({ content: '⏳ A playlist ainda está carregando. Aguarde finalizar para usar Remover (#).', ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId('queue_remove_modal')
      .setTitle('Remover música da fila')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('queueRemovePosition')
            .setLabel('Número da música na fila')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ex: 5')
            .setRequired(true)
        )
      );

    return interaction.showModal(modal);
  }

  if (interaction.customId.startsWith('queue_loopplaylist_')) {
    const entry = ensureQueueInteractionState(interaction);
    if (!entry) return interaction.deferUpdate();
    if (isPlaylistLoadInProgress(interaction.guildId)) {
      return interaction.reply({ content: '⏳ A playlist ainda está carregando. Aguarde finalizar para usar Loop Playlist.', ephemeral: true });
    }
    await interaction.deferUpdate().catch(() => {});
    const loopInfo = toggleLoopPlaylist(interaction.guildId);
    // Se ativou loop, navegar para a página da música atual com índice preciso
    const ps = Number(BOT_CFG.ui?.queuePageSize) || 8;
    const targetPage = loopInfo.enabled ? Math.floor((loopInfo.currentIndex || 0) / ps) : 0;
    await showQueueMessage(interaction.message, targetPage, interaction.message).catch(() => {});
    await refreshNowPlayingMessage(interaction.guildId).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('queue_restart_')) {
    const entry = ensureQueueInteractionState(interaction);
    if (!entry) return interaction.deferUpdate();

    if (isPlaylistLoadInProgress(interaction.guildId)) {
      return interaction.reply({
        content: '⏳ A playlist ainda está carregando. Aguarde finalizar para usar Reiniciar playlist.',
        ephemeral: true,
      });
    }

    await interaction.deferUpdate().catch(() => {});
    restartPlaylist(interaction.guildId);
    // Força o estado interno da paginação para a primeira página.
    entry.page = 0;
    pendingQueueMessages.set(interaction.message.id, entry);
    await showQueueMessage(interaction.message, 0, interaction.message).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('queue_play_')) {
    const entry = ensureQueueInteractionState(interaction);
    if (!entry) return interaction.deferUpdate();
    if (isPlaylistLoadInProgress(interaction.guildId)) {
      return interaction.reply({ content: '⏳ A playlist ainda está carregando. Aguarde finalizar para usar Tocar (#).', ephemeral: true });
    }
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

  if (interaction.customId.startsWith('queue_save_pick_')) {
    const entry = ensureQueueInteractionState(interaction);
    if (!entry) return interaction.deferUpdate();
    if (isPlaylistLoadInProgress(interaction.guildId)) {
      return interaction.reply({ content: '⏳ A playlist ainda está carregando. Aguarde finalizar para salvar playlist.', ephemeral: true });
    }
    const modal = new ModalBuilder()
      .setCustomId('queue_save_modal')
      .setTitle('Salvar playlist atual')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('playlistName')
            .setLabel('Nome da playlist')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ex: academia')
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
