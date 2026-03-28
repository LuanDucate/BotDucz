const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const fs = require('fs');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { resolveSoundCloudTrackDetails } = require('./youtube');
const { APP_CONFIG } = require('./config');

const MQ_CFG = APP_CONFIG.musicQueue;
const EFFECT_APPLY_COOLDOWN_MS = 250;
const PLAY_NEXT_ERROR_DELAY_MS = 100;
const ADVANCE_SUPPRESSION_WINDOW_MS = 5000;

// ============================================================
// Estado por guild
// ============================================================
const guilds = new Map();
let onSongChangedCallback = null;

function setOnSongChangedCallback(cb) {
  onSongChangedCallback = typeof cb === 'function' ? cb : null;
}

function getGuildData(guildId) {
  if (!guilds.has(guildId)) {
    guilds.set(guildId, {
      guildId,
      connection: null,
      musicPlayer: null,
      sfxPlayer: null,
      queue: [],
      currentSong: null,
      textChannel: null,
      anchorMessageId: null,
      anchorNowPlayingEnabled: true,
      musicPausedForSfx: false,
      nowPlayingMessage: null,
      nowPlayingRenderPromise: null,
      nowPlayingSfxMessage: null,
      lastVoiceErrorAt: 0,
      effect: null, // currently applied effect (string key)
      effectIntensity: Number(MQ_CFG.defaultEffectIntensity) || 5, // intensidade do efeito (1-10)
      currentSongOffsetSeconds: 0,
      loop: false,
      loopPlaylist: false,
      playlistFull: [],
      history: [],
      sequenceCounter: 0,
      currentSequence: 0,
      sfxPlaybackToken: 0,
      advanceInProgress: false,
      advanceRequested: false,
      suppressNextIdleCount: 0,
      suppressNextErrorAdvanceCount: 0,
      suppressAdvanceUntil: 0,
      navCooldownUntil: 0,
      effectApplyCooldownUntil: 0,
      effectApplyTimer: null,
      playNextTimer: null,
      externalMoveGraceUntil: 0,
      removedSongKeys: new Set(),
    });
  }
  const data = guilds.get(guildId);
  if (!data.guildId) data.guildId = guildId;
  return data;
}

function buildCanonicalPlaylist(data) {
  if (!data) return [];
  const all = [
    ...(Array.isArray(data.playlistFull) ? data.playlistFull : []),
    ...(Array.isArray(data.history) ? data.history : []),
    ...(data.currentSong ? [data.currentSong] : []),
    ...(Array.isArray(data.queue) ? data.queue : []),
  ];

  const seenSeq = new Set();
  const seenFallback = new Set();
  const uniq = [];

  for (const song of all) {
    if (!song) continue;
    const seq = Number(song.sequence);
    if (Number.isFinite(seq)) {
      const k = `seq:${seq}`;
      if (seenSeq.has(k)) continue;
      seenSeq.add(k);
      uniq.push(song);
      continue;
    }

    const k = `fallback:${String(song.url || '')}|${String(song.title || '')}`;
    if (seenFallback.has(k)) continue;
    seenFallback.add(k);
    uniq.push(song);
  }

  // Ordem estável pela sequência original de inserção.
  uniq.sort((a, b) => {
    const sa = Number.isFinite(Number(a?.sequence)) ? Number(a.sequence) : Number.MAX_SAFE_INTEGER;
    const sb = Number.isFinite(Number(b?.sequence)) ? Number(b.sequence) : Number.MAX_SAFE_INTEGER;
    return sa - sb;
  });

  return uniq.map((s) => ({ ...s }));
}

function buildSessionPlaylist(data) {
  if (!data) return [];
  const all = [
    ...(Array.isArray(data.history) ? data.history : []),
    ...(data.currentSong ? [data.currentSong] : []),
    ...(Array.isArray(data.queue) ? data.queue : []),
  ];

  const seenSeq = new Set();
  const seenFallback = new Set();
  const uniq = [];

  for (const song of all) {
    if (!song) continue;
    if (isSongMarkedRemoved(data, song)) continue;
    const seq = Number(song.sequence);
    if (Number.isFinite(seq)) {
      const k = `seq:${seq}`;
      if (seenSeq.has(k)) continue;
      seenSeq.add(k);
      uniq.push(song);
      continue;
    }

    const k = `fallback:${String(song.url || '')}|${String(song.title || '')}`;
    if (seenFallback.has(k)) continue;
    seenFallback.add(k);
    uniq.push(song);
  }

  // Ordem estável pela sequência original de inserção.
  uniq.sort((a, b) => {
    const sa = Number.isFinite(Number(a?.sequence)) ? Number(a.sequence) : Number.MAX_SAFE_INTEGER;
    const sb = Number.isFinite(Number(b?.sequence)) ? Number(b.sequence) : Number.MAX_SAFE_INTEGER;
    return sa - sb;
  });

  return uniq.map((s) => ({ ...s }));
}

function findSongIndexInList(list, target) {
  if (!Array.isArray(list) || !target) return -1;
  return list.findIndex((song) => {
    if (!song) return false;
    if (Number.isFinite(song.sequence) && Number.isFinite(target.sequence)) {
      return song.sequence === target.sequence;
    }
    return song.url === target.url && song.title === target.title;
  });
}

function songsMatch(a, b) {
  if (!a || !b) return false;
  if (Number.isFinite(Number(a.sequence)) && Number.isFinite(Number(b.sequence))) {
    return Number(a.sequence) === Number(b.sequence);
  }
  return String(a.url || '') === String(b.url || '') && String(a.title || '') === String(b.title || '');
}

function getSongKey(song) {
  if (!song) return '';
  const seq = Number(song.sequence);
  if (Number.isFinite(seq)) return `seq:${seq}`;
  return `fallback:${String(song.url || '')}|${String(song.title || '')}`;
}

function markSongAsRemoved(data, song) {
  if (!data || !song) return;
  if (!(data.removedSongKeys instanceof Set)) data.removedSongKeys = new Set();
  const key = getSongKey(song);
  if (key) data.removedSongKeys.add(key);
}

function isSongMarkedRemoved(data, song) {
  if (!data || !song) return false;
  if (!(data.removedSongKeys instanceof Set)) return false;
  const key = getSongKey(song);
  return key ? data.removedSongKeys.has(key) : false;
}

function clearRemovedSongMarks(data) {
  if (!data) return;
  data.removedSongKeys = new Set();
}

function removeSongFromAllCollections(data, targetSong) {
  if (!data || !targetSong) return;

  markSongAsRemoved(data, targetSong);

  if (Array.isArray(data.history)) {
    data.history = data.history.filter((song) => !songsMatch(song, targetSong));
  }
  if (Array.isArray(data.queue)) {
    data.queue = data.queue.filter((song) => !songsMatch(song, targetSong));
  }
  if (Array.isArray(data.playlistFull)) {
    data.playlistFull = data.playlistFull.filter((song) => !songsMatch(song, targetSong));
  }

  if (data.currentSong && songsMatch(data.currentSong, targetSong)) {
    data.currentSong = null;
    data.currentSongOffsetSeconds = 0;
  }
}

function trimHistoryIfNeeded(data) {
  if (!data || data.loopPlaylist) return;
  while (data.history.length > (Number(MQ_CFG.maxHistoryItems) || 100)) {
    data.history.shift();
  }
}

function getLoopPlaylistView(data) {
  if (!data || !data.loopPlaylist) {
    return { songs: [], currentIndex: -1 };
  }

  const songs = data.playlistFull.length > 0 ? data.playlistFull.map((song) => ({ ...song })) : buildSessionPlaylist(data);
  const currentIndex = findSongIndexInList(songs, data.currentSong);
  return { songs, currentIndex };
}

function refreshLoopPlaylistSnapshot(data) {
  if (!data) return;
  data.playlistFull = buildSessionPlaylist(data);
}

function setEffect(guildId, effect) {
  const data = getGuildData(guildId);
  data.effect = effect;
  console.log(`🎛️ [guild ${guildId}] efeito definido para: ${effect ?? 'nenhum'}`);
}

function killProcessSafe(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill('SIGTERM');
  } catch {}
}

function buildMusicControlRow(guildId) {
  const data = guilds.get(guildId);
  const loopActive = data?.loop || false;
  const hasPrevious = Array.isArray(data?.history) && data.history.length > 0;
  const hasNext = Array.isArray(data?.queue) && data.queue.length > 0;
  const hasCurrent = Boolean(data?.currentSong);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`music_prev_${guildId}`)
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasPrevious),
    new ButtonBuilder()
      .setCustomId(`music_stop_${guildId}`)
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`music_skip_${guildId}`)
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasNext),
    new ButtonBuilder()
      .setCustomId(`music_loop_${guildId}`)
      .setEmoji('🔁')
      .setStyle(loopActive ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`music_remove_current_${guildId}`)
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasCurrent),
  );
}

function isExpectedStreamCloseError(err) {
  if (!err) return false;
  const code = String(err.code || '').toUpperCase();
  const msg = String(err.message || err || '').toLowerCase();
  let raw = '';
  try {
    raw = JSON.stringify(err).toLowerCase();
  } catch {}
  if (code === 'EPIPE' || code === 'EOF' || code === 'ERR_STREAM_PREMATURE_CLOSE') return true;
  if (msg.includes('premature close') || msg.includes('broken pipe') || msg.includes('eof')) return true;
  if (raw.includes('premature close') || raw.includes('broken pipe') || raw.includes('err_stream_premature_close')) return true;
  return false;
}

function destroyStreamSafe(stream) {
  if (!stream || typeof stream.destroy !== 'function') return;
  try {
    stream.destroy();
  } catch {}
}

function cleanupCurrentStream(data) {
  if (!data) return;

  killProcessSafe(data.currentYtdlp);
  killProcessSafe(data.currentFfmpeg);
  destroyStreamSafe(data.currentStream);

  data.currentYtdlp = null;
  data.currentFfmpeg = null;
  data.currentStream = null;
}

function clearScheduledTimers(data) {
  if (!data) return;
  if (data.effectApplyTimer) {
    clearTimeout(data.effectApplyTimer);
    data.effectApplyTimer = null;
  }
  if (data.playNextTimer) {
    clearTimeout(data.playNextTimer);
    data.playNextTimer = null;
  }
}

function cleanupOldStream(data, old) {
  if (!old) return;
  setTimeout(() => {
    killProcessSafe(old.ytdlp);
    killProcessSafe(old.ffmpeg);
    destroyStreamSafe(old.stream);
  }, Number(MQ_CFG.cleanupOldStreamDelayMs) || 250);
}

function buildNowPlayingContent(data) {
  const song = data?.currentSong;
  const queueSize = Array.isArray(data?.queue) ? data.queue.length : 0;
  const effect = data?.effect;
  const effectIntensity = data?.effectIntensity || 5;
  const lines = [`🎶 Tocando: **${song?.title || 'música'}**`];

  if (data?.loopPlaylist) {
    const loopView = getLoopPlaylistView(data);
    const totalSongs = Array.isArray(loopView.songs) ? loopView.songs.length : 0;
    const currentPos = (loopView.currentIndex || 0) >= 0 ? (loopView.currentIndex + 1) : 1;
    lines.push(`📋 Fila: ${currentPos} / ${Math.max(1, totalSongs)}`);
  } else if (queueSize > 0) {
    const playedCount = Array.isArray(data?.history) ? data.history.length : 0;
    const currentPos = playedCount + 1;
    const totalSongs = playedCount + 1 + queueSize;
    lines.push(`📋 Fila: ${currentPos} / ${totalSongs}`);
  }

  if (effect) {
    lines.push(`🎛️ Efeito: ${effect} ${effectIntensity}/10`);
  }

  const loops = [];
  if (data?.loopPlaylist) loops.push('playlist');
  if (data?.loop) loops.push('música');
  if (loops.length > 0) {
    lines.push(`🔁 Loops: ${loops.join(', ')}`);
  }

  const linkRef = song?.url && song.url.startsWith('http') ? `\n🔗 ${song.url}` : '';
  return `${lines.join('\n')}${linkRef}`;
}

async function upsertNowPlayingMessage(guildId, opts = {}) {
  const data = guilds.get(guildId);
  if (!data || !data.textChannel || !data.currentSong) return false;
  const forceResend = Boolean(opts?.forceResend);

  const payload = {
    content: buildNowPlayingContent(data),
    components: [buildMusicControlRow(guildId)],
  };

  const previousRender = data.nowPlayingRenderPromise || Promise.resolve();
  data.nowPlayingRenderPromise = previousRender
    .catch(() => {})
    .then(async () => {
      if (!data.currentSong || !data.textChannel) return false;

      if (forceResend && data.nowPlayingMessage) {
        let shouldResend = true;

        // Se o now playing já for a última mensagem do canal, basta editar.
        if (data.textChannel?.messages?.fetch) {
          const latestBatch = await data.textChannel.messages.fetch({ limit: 1 }).catch(() => null);
          const latestMsg = latestBatch?.first?.();
          if (latestMsg?.id === data.nowPlayingMessage.id) {
            shouldResend = false;
          }
        }

        if (shouldResend) {
          await data.nowPlayingMessage.delete().catch(() => {});
          data.nowPlayingMessage = null;
        }
      }

      if (data.nowPlayingMessage) {
        const updated = await data.nowPlayingMessage.edit(payload).catch(() => null);
        if (updated) {
          data.nowPlayingMessage = updated;
          return true;
        }
      }

      const sendPayload = data.anchorMessageId && data.anchorNowPlayingEnabled !== false
        ? {
            ...payload,
            reply: {
              messageReference: data.anchorMessageId,
              failIfNotExists: false,
            },
          }
        : payload;

      const created = await data.textChannel.send(sendPayload).catch(() => null);
      if (created) {
        data.nowPlayingMessage = created;
        return true;
      }

      return false;
    });

  return data.nowPlayingRenderPromise;
}

async function refreshNowPlayingMessage(guildId, opts = {}) {
  return upsertNowPlayingMessage(guildId, opts);
}

function isSoundCloudApiTrack(song) {
  const url = String(song?.url || '').trim().toLowerCase();
  return url.includes('api-v2.soundcloud.com/tracks/');
}

async function ensurePlayableSong(song) {
  if (!song || !isSoundCloudApiTrack(song)) return song;

  const resolved = await resolveSoundCloudTrackDetails(song.url).catch(() => null);
  if (!resolved) return song;

  song.url = resolved.url;
  song.title = resolved.title;
  song.needsResolve = false;
  return song;
}

function playSong(guildId, song, seekSeconds = 0, smoothSwitch = false) {
  const data = guilds.get(guildId);
  if (!data) return;
  const previousSong = data.currentSong;

  // Ensure history array exists and is properly typed
  if (!Array.isArray(data.history)) {
    data.history = [];
  }

  // Ao trocar de recurso com player ativo, o recurso antigo pode emitir Idle.
  // Contabilizamos para ignorar esse Idle fantasma e não avançar duas vezes.
  const playerStatus = data.musicPlayer?.state?.status;
  const replacingActiveResource =
    Boolean(data.currentStream) &&
    Boolean(data.currentSong) &&
    playerStatus &&
    playerStatus !== AudioPlayerStatus.Idle;
  if (replacingActiveResource) {
    data.suppressNextIdleCount = (data.suppressNextIdleCount || 0) + 1;
    data.suppressNextErrorAdvanceCount = (data.suppressNextErrorAdvanceCount || 0) + 1;
    data.suppressAdvanceUntil = Date.now() + ADVANCE_SUPPRESSION_WINDOW_MS;
  }

  data.currentSong = song;
  data.currentSequence = Number.isFinite(song?.sequence) ? song.sequence : (data.currentSequence || 0);
  const songChanged = previousSong !== song;

  const logMeta = [];
  if (data.loopPlaylist) {
    const loopView = getLoopPlaylistView(data);
    const totalSongs = Array.isArray(loopView.songs) ? loopView.songs.length : 0;
    if ((loopView.currentIndex || 0) >= 0 && totalSongs > 0) {
      logMeta.push(`${loopView.currentIndex + 1} / ${totalSongs}`);
    }
    logMeta.push('loop playlist ativo');
  }
  if (data.loop) {
    logMeta.push('loop música ativo');
  }

  const songLabel = logMeta.length > 0
    ? `${song.title} (${logMeta.join(', ')})`
    : song.title;

  console.log(
    `🎶 Tocando: ${songLabel} (efeito: ${data.effect || 'nenhum'}, seek: ${seekSeconds}s)`
  );

  // Quando trocamos de efeito ou de música, mantemos o stream antigo por um curto período
  // para evitar que o player tente escrever em uma stream que já foi fechada.
  const oldStream = {
    stream: data.currentStream,
    ytdlp: data.currentYtdlp,
    ffmpeg: data.currentFfmpeg,
  };

  const { stream, ytdlp, ffmpeg, isRaw } = createFilteredStream(
    song.url,
    data.effect,
    data.effectIntensity || 5,
    seekSeconds,
    smoothSwitch
  );

  const resource = createAudioResource(stream, {
    inputType: isRaw ? StreamType.Raw : StreamType.Arbitrary,
  });

  // Evita crash por EPIPE quando mudamos de stream rapidamente.
  if (stream && typeof stream.on === 'function') {
    stream.on('error', (err) => {
      if (isExpectedStreamCloseError(err)) return;
      console.error('❌ Erro no stream de áudio:', err?.message || err);
    });
  }

  // Armazenar informações para permitir reiniciar a faixa mantendo o ponto atual
  data.currentResource = resource;
  data.currentResourceStart = Date.now();
  data.currentSongOffsetSeconds = seekSeconds;
  data.currentStream = stream;
  data.currentYtdlp = ytdlp;
  data.currentFfmpeg = ffmpeg;

  cleanupOldStream(data, oldStream);

  data.connection.subscribe(data.musicPlayer);
  data.musicPlayer.play(resource);

  if (data.textChannel) {
    if (songChanged && typeof onSongChangedCallback === 'function') {
      Promise.resolve(onSongChangedCallback(guildId, song)).catch(() => {
        upsertNowPlayingMessage(guildId, { forceResend: true }).catch(() => {});
      });
    } else {
      upsertNowPlayingMessage(guildId, { forceResend: songChanged }).catch(() => {});
    }
  }
}

function getEffect(guildId) {
  const data = guilds.get(guildId);
  return data ? data.effect : null;
}

function setEffectIntensity(guildId, intensity) {
  const data = getGuildData(guildId);
  data.effectIntensity = Math.max(1, Math.min(10, Math.floor(intensity)));
  console.log(`🎛️ [guild ${guildId}] intensidade do efeito definida para: ${data.effectIntensity}`);
}

function getEffectIntensity(guildId) {
  const data = guilds.get(guildId);
  return data ? (data.effectIntensity || 5) : 5;
}

/**
 * Reaplica o efeito atual imediatamente reiniciando a música em reprodução.
 * Retorna true se havia uma música tocando e foi reiniciada.
 */
function applyEffectNow(guildId) {
  const data = guilds.get(guildId);
  if (!data || !data.currentSong || !data.musicPlayer) return false;

  const now = Date.now();
  if (now < (data.effectApplyCooldownUntil || 0)) {
    if (!data.effectApplyTimer) {
      const waitMs = Math.max(15, (data.effectApplyCooldownUntil || now) - now);
      data.effectApplyTimer = setTimeout(() => {
        data.effectApplyTimer = null;
        applyEffectNow(guildId);
      }, waitMs);
    }
    return true;
  }
  data.effectApplyCooldownUntil = now + EFFECT_APPLY_COOLDOWN_MS;

  // Pausa o player imediatamente para congelar o playbackDuration no ponto exato.
  // Isso dá uma leitura de posição precisa (mesmo princípio do SFX pause/unpause).
  // O player.play(newResource) mais abaixo retomará a reprodução automaticamente.
  const wasPlaying = data.musicPlayer.state.status === AudioPlayerStatus.Playing;
  if (wasPlaying) data.musicPlayer.pause();

  const playbackMs =
    data.currentResource && typeof data.currentResource.playbackDuration === 'number'
      ? data.currentResource.playbackDuration
      : 0;
  // Fallback ao wall clock apenas se playbackDuration for 0 (início do buffering)
  const wallClockMs = data.currentResourceStart ? Date.now() - data.currentResourceStart : 0;
  const elapsedMs = playbackMs > 0 ? playbackMs : wallClockMs;

  // Mantém posição absoluta da faixa entre múltiplas trocas de efeito.
  const baseOffsetMs = (data.currentSongOffsetSeconds || 0) * 1000;
  // Ajuste fino conservador para reduzir corte sem acumular drift em múltiplas trocas.
  const BASE_FINE_TUNE_BACK_MS = 220;
  const EFFECT_FINE_TUNE_EXTRA_MS = {
    nightcore: 90,
  };
  const extraBackMs = EFFECT_FINE_TUNE_EXTRA_MS[data.effect] || 0;
  const seekSeconds = Math.max(
    0,
    (baseOffsetMs + elapsedMs - (BASE_FINE_TUNE_BACK_MS + extraBackMs)) / 1000
  );

  console.log(
    `🎛️ [guild ${guildId}] aplicando efeito agora (reiniciando a música em ~${seekSeconds.toFixed(3)}s).`
  );

  // Recria o stream com o novo filtro (ou sem filtro) a partir do mesmo ponto.
  const currentSong = data.currentSong;

  // Limpa processos antigos para evitar EPIPE e streams zumbis.
  cleanupCurrentStream(data);

  // Recria o stream a partir do mesmo ponto com transição suave.
  playSong(guildId, currentSong, seekSeconds, true);

  return true;
}

function schedulePlayNext(guildId, delayMs = 0) {
  const data = guilds.get(guildId);
  if (!data) return;
  if (data.playNextTimer) return;
  data.playNextTimer = setTimeout(() => {
    data.playNextTimer = null;
    playNext(guildId).catch(() => {});
  }, Math.max(0, Number(delayMs) || 0));
}

async function ensureConnection(message) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    throw new Error('VOICE_NOT_CONNECTED');
  }

  const permissions = voiceChannel.permissionsFor(message.guild.members.me);
  if (!permissions?.has('Connect') || !permissions?.has('Speak')) {
    throw new Error('VOICE_NO_PERMISSION');
  }

  const data = getGuildData(message.guildId);
  data.guildId = message.guildId;

  const currentState = data.connection?.state?.status;
  const isReady = currentState === VoiceConnectionStatus.Ready;
  let needNewConnection = !data.connection || !isReady;

  if (
    data.connection &&
    !needNewConnection &&
    data.connection.joinConfig.channelId !== voiceChannel.id
  ) {
    data.connection.destroy();
    data.connection = null;
    needNewConnection = true;
  }

  if (needNewConnection) {
    data.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guildId,
      adapterCreator: message.guild.voiceAdapterCreator,
    });

    wireConnectionLifecycle(data, message.guildId);

    try {
      await entersState(data.connection, VoiceConnectionStatus.Ready, 30_000);
      console.log('✅ Conexão de voz pronta!');
    } catch {
      data.connection.destroy();
      data.connection = null;
      throw new Error('VOICE_TIMEOUT');
    }
    // Resetar players ao reconectar
    data.musicPlayer = null;
    data.sfxPlayer = null;
  }

  // Criar music player se não existe
  if (!data.musicPlayer) {
    data.musicPlayer = createAudioPlayer();

    data.musicPlayer.on(AudioPlayerStatus.Idle, () => {
      if ((data.suppressAdvanceUntil || 0) > 0 && Date.now() > data.suppressAdvanceUntil) {
        data.suppressNextIdleCount = 0;
        data.suppressNextErrorAdvanceCount = 0;
        data.suppressAdvanceUntil = 0;
      }

      if ((data.suppressNextIdleCount || 0) > 0) {
        data.suppressNextIdleCount -= 1;
        if ((data.suppressNextIdleCount || 0) <= 0 && (data.suppressNextErrorAdvanceCount || 0) <= 0) {
          data.suppressAdvanceUntil = 0;
        }
        return;
      }

      console.log('🔇 Música finalizada.');
      if (data.nowPlayingSfxMessage) {
        data.nowPlayingSfxMessage.delete().catch(() => {});
        data.nowPlayingSfxMessage = null;
      }

      const lastSong = data.currentSong;
      data.currentSong = null;
      data.currentSongOffsetSeconds = 0;

      if (data.loop && lastSong) {
        // Loop ativo: repete a mesma música sem avançar a fila
        playSong(data.guildId, lastSong);
      } else {
        // Histórico para o botão ⏮️ voltar (limitado para não crescer sem fim)
        if (lastSong) {
          if (!Array.isArray(data.history)) data.history = [];
          data.history.push(lastSong);
          trimHistoryIfNeeded(data);
        }
        schedulePlayNext(data.guildId, 0);
      }
    });

    data.musicPlayer.on('error', (error) => {
      if ((data.suppressAdvanceUntil || 0) > 0 && Date.now() > data.suppressAdvanceUntil) {
        data.suppressNextIdleCount = 0;
        data.suppressNextErrorAdvanceCount = 0;
        data.suppressAdvanceUntil = 0;
      }

      if ((data.suppressNextErrorAdvanceCount || 0) > 0) {
        data.suppressNextErrorAdvanceCount -= 1;
        // Um recurso antigo emitiu Error em vez de Idle — consome também o idle counter
        // para evitar que suppressNextIdleCount acumule e suprima avanços de fila reais.
        if ((data.suppressNextIdleCount || 0) > 0) data.suppressNextIdleCount -= 1;
        if ((data.suppressNextIdleCount || 0) <= 0 && (data.suppressNextErrorAdvanceCount || 0) <= 0) {
          data.suppressAdvanceUntil = 0;
        }
        console.warn('⚠️ Ignorando erro do recurso anterior durante troca manual.');
        return;
      }

      if (error && (error.code === 'EPIPE' || error.code === 'EOF')) {
        console.warn('⚠️ Erro de pipe/EOF no music player, avançando para próxima faixa.');
        cleanupCurrentStream(data);
        data.currentSong = null;
        data.currentSongOffsetSeconds = 0;
        schedulePlayNext(data.guildId, PLAY_NEXT_ERROR_DELAY_MS);
        return;
      }

      console.error('❌ Erro no music player:', error.message || error);
      cleanupCurrentStream(data);
      data.currentSong = null;
      data.currentSongOffsetSeconds = 0;
      schedulePlayNext(data.guildId, 0);
    });
  }

  // Criar sfx player se não existe
  if (!data.sfxPlayer) {
    data.sfxPlayer = createAudioPlayer();
  }

  data.textChannel = message.channel;
  if (message?.id) data.anchorMessageId = message.id;
  return data;
}

// ============================================================
// Fila de músicas
// ============================================================

/**
 * Toca a próxima música da fila.
 */
// Efeitos disponíveis (sem variantes duplicadas — use intensidade 1-10)
const VALID_EFFECTS = [
  'bassboost', 'nightcore', 'helium', 'slow', 'echo',
  'reverb', 'karaoke', '8d', 'distortion', 'vaporwave', 'tremolo',
  'chipmunk', 'alvin', 'giant', 'robot', 'radio', 'telefone',
  'glitch', 'reverse', 'drunk', 'lag', '8bit',
];

const INTENSITY_EFFECTS = [
  'bassboost', 'nightcore', 'helium', 'slow', 'echo',
  'reverb', '8d', 'distortion', 'vaporwave', 'tremolo',
  'chipmunk', 'alvin', 'giant', 'robot', 'radio', 'telefone',
  'glitch', 'reverse', 'drunk', 'lag', '8bit',
];

const EFFECT_DESCRIPTIONS = {
  bassboost: 'Reforca os graves e deixa o som mais encorpado.',
  nightcore: 'Acelera e aumenta o pitch para um som mais energetico.',
  helium: 'Eleva bastante o pitch, deixando as vozes mais finas.',
  slow: 'Diminui o ritmo e adiciona ambiencia para um efeito mais arrastado.',
  echo: 'Adiciona repeticoes curtas, como um eco ritmico.',
  reverb: 'Simula reflexoes de ambiente, como uma sala ampla.',
  karaoke: 'Reduz o vocal central para destacar o instrumental.',
  '8d': 'Move o audio entre os canais para sensacao espacial.',
  distortion: 'Satura e comprime o som para um timbre agressivo.',
  vaporwave: 'Deixa o audio mais lento, grave e "vintage".',
  tremolo: 'Oscila o volume rapidamente, criando pulsacao.',
  chipmunk: 'Pitch alto estilo desenho animado.',
  alvin: 'Esquilo dos filmes — voz bem aguda e acelerada estilo Alvin e os Esquilos!',
  giant: 'Pitch grave e pesado, estilo gigante.',
  robot: 'Robot metalico pesado com foco de voz (estilo sintetico agressivo).',
  radio: 'Som de radio velho, limitado e chiado.',
  telefone: 'Faixa de telefone (300Hz-3400Hz).',
  glitch: 'Cortes ritmicos e stutter digital.',
  reverse: 'Efeito de reverso (janela curta repetida).',
  drunk: 'Pitch instavel e oscilante.',
  lag: 'Travadas com pausas e repeticoes.',
  '8bit': 'Bitcrusher e amostragem baixa estilo retro.',
};

function lerp(a, b, t) { return a + (b - a) * t; }
function intensityT(level) { return (Math.max(1, Math.min(10, level)) - 1) / 9; }
function effectSupportsIntensity(effect) { return INTENSITY_EFFECTS.includes(effect); }
function clampLevel(level) { return Math.max(1, Math.min(10, Math.floor(level))); }

// Curva por faixas:
// 1-3: leve | 4-7: engraçado | 8-10: absurdo total
function tieredIntensityT(level) {
  const l = clampLevel(level);
  if (l <= 3) return lerp(0.00, 0.28, (l - 1) / 2);
  if (l <= 7) return lerp(0.35, 0.72, (l - 4) / 3);
  return lerp(0.80, 1.00, (l - 8) / 2);
}

function buildRobotVoiceFilter(intensity = 5) {
  const t = tieredIntensityT(intensity);
  // Filtro estilo Blitzcrank: ring-mod agressivo, crusher pesado, ressonância metálica.
  const hp = Math.round(lerp(180, 320, t));
  const lp = Math.round(lerp(4800, 3000, t));
  const lowCut = lerp(-5.0, -11.0, t).toFixed(1);
  const metalPeak = lerp(2.0, 8.0, t).toFixed(1);    // ressonância de caixa metálica ~800 Hz
  const presence1 = lerp(4.0, 12.0, t).toFixed(1);   // presença de voz ~1200 Hz
  const presence2 = lerp(3.0, 8.0, t).toFixed(1);    // ar / inteligibilidade ~2500 Hz
  const ringFreq = lerp(65.0, 160.0, t).toFixed(1);  // ring-mod mais alto e agressivo
  const ringDepth = lerp(0.58, 0.99, t).toFixed(2);  // profundidade quase total no máximo
  const crusherBits = Math.round(lerp(8, 4, t));      // crusher mais destrutivo
  const crusherIn = lerp(1.20, 2.30, t).toFixed(2);  // overdrive maior na entrada
  const robotRate = Math.round(lerp(22050, 8000, t)); // downsampling mais agressivo
  const metalDelay = Math.round(lerp(8, 20, t));
  const metalDecay = lerp(0.12, 0.32, t).toFixed(2);
  const makeup = lerp(1.22, 1.90, t).toFixed(2);

  return [
    // Foca mais no centro (voz) — proporção levemente maior.
    'pan=stereo|c0=0.65*FL+0.35*FR|c1=0.65*FR+0.35*FL',
    `highpass=f=${hp}`,
    `lowpass=f=${lp}`,
    `equalizer=f=260:t=q:w=1.1:g=${lowCut}`,
    `equalizer=f=800:t=q:w=0.8:g=${metalPeak}`,
    `equalizer=f=1200:t=q:w=1.2:g=${presence1}`,
    `equalizer=f=2500:t=q:w=1.0:g=${presence2}`,
    `tremolo=f=${ringFreq}:d=${ringDepth}`,
    `acrusher=level_in=${crusherIn}:level_out=1:bits=${crusherBits}:mode=log`,
    `aresample=${robotRate}`,
    'aresample=48000',
    `aecho=0.80:0.44:${metalDelay}:${metalDecay}`,
    'compand=attacks=0.001:decays=0.06:points=-90/-90|-40/-30|-24/-14|-10/-4|0/-1.5',
    `volume=${makeup}`,
    'alimiter=limit=0.94:level=disabled',
  ].join(',');
}

function buildAlvinFilter(intensity = 5) {
  const t = tieredIntensityT(intensity);
  // Alvin e os Esquilos: pitch ~+7 a +12 semitons, levemente acelerado (fiel aos filmes).
  // +7 semi = 2^(7/12) ≈ 1.498 | +12 semi = 2^(12/12) = 2.000
  const rate = lerp(1.50, 2.00, t).toFixed(4);
  // Não corrige totalmente o tempo — fica levemente mais rápido (estilo filme).
  const tempo = lerp(0.94, 0.72, t).toFixed(3);
  const treble = lerp(3.5, 8.0, t).toFixed(1);        // brilho característico do esquilo
  const presence = lerp(2.5, 6.5, t).toFixed(1);     // clareza da voz aguda
  const compMakeup = lerp(1.5, 3.5, t).toFixed(1);   // punch para deixar a voz "no ar"

  return [
    `asetrate=44100*${rate}`,
    'aresample=44100',
    `atempo=${tempo}`,
    `treble=g=${treble}`,
    `equalizer=f=3000:t=q:w=1.0:g=${presence}`,
    `acompressor=threshold=-20dB:ratio=3:attack=5:release=60:makeup=${compMakeup}`,
  ].join(',');
}

/**
 * Constrói o filtro FFmpeg para o efeito com intensidade 1-10.
 * 1 = suave, 5 = padrão, 10 = exagerado/meme.
 */
function buildEffectFilter(effect, intensity = 5) {
  if (!effect || !VALID_EFFECTS.includes(effect)) return null;
  const t = effectSupportsIntensity(effect) ? tieredIntensityT(intensity) : intensityT(5);
  switch (effect) {
    case 'bassboost': {
      const g1 = lerp(1, 18, t).toFixed(1);
      const g2 = lerp(0.5, 12, t).toFixed(1);
      return `equalizer=f=70:t=q:w=1.1:g=${g1},equalizer=f=120:t=q:w=1.0:g=${g2}`;
    }
    case 'nightcore': {
      // Nightcore estilo anime: pitch/speed altos, mas sem virar "helium".
      const rate = lerp(1.10, 1.36, t).toFixed(4);
      const tempo = lerp(1.01, 1.12, t).toFixed(3);
      const echoDecay = lerp(0.03, 0.16, t).toFixed(2);
      const echoDelay = Math.round(lerp(40, 95, t));
      const echo = t > 0.30 ? `,aecho=0.88:0.75:${echoDelay}:${echoDecay}` : '';
      // brilho leve + grave leve para timbre nightcore mais "YouTube".
      return `asetrate=44100*${rate},aresample=44100,atempo=${tempo},equalizer=f=120:t=q:w=1.1:g=3.0,treble=g=1.6${echo}`;
    }
    case 'helium': {
      const rate = lerp(1.12, 2.0, t).toFixed(4);
      const tempo = lerp(0.92, 0.58, t).toFixed(3);
      return `asetrate=44100*${rate},aresample=44100,atempo=${tempo}`;
    }
    case 'slow': {
      const rate = lerp(0.88, 0.55, t).toFixed(4);
      // Delay máx 600ms: acima fica "segunda voz" pelo áudio lento
      const echoDelay = Math.round(lerp(150, 600, t));
      const echoDecay = lerp(0.15, 0.38, t).toFixed(2);
      // in_gain dinâmico: in_gain + out_gain*decay ≈ 0.95 sempre
      const inGain = (0.95 - 0.82 * parseFloat(echoDecay)).toFixed(2);
      // t=1: inGain=0.638; total=0.638+0.82*0.38=0.95 ✓
      return `asetrate=44100*${rate},aresample=44100,atempo=0.9,aecho=${inGain}:0.82:${echoDelay}:${echoDecay}`;
    }
    case 'echo': {
      // Delay máx 380ms: eco audível sem soar como "segunda música"
      const delay = Math.round(lerp(50, 380, t));
      const decay = lerp(0.10, 0.48, t).toFixed(2);
      const inGain = Math.max(0.40, 0.95 - 0.88 * parseFloat(decay)).toFixed(2);
      // t=1: max(0.40, 0.528); total=0.528+0.422=0.95 ✓
      return `aecho=${inGain}:0.88:${delay}:${decay}`;
    }
    case 'reverb': {
      // Multi-tap com delays curtos: cria textura de sala, não eco distinto
      const d1 = Math.round(lerp(15, 60, t));
      const d2 = Math.round(lerp(35, 130, t));
      const d3 = Math.round(lerp(60, 220, t));
      const dec1 = lerp(0.14, 0.33, t).toFixed(2);
      const dec2 = lerp(0.09, 0.22, t).toFixed(2);
      const dec3 = lerp(0.05, 0.13, t).toFixed(2);
      // t=1: 0.50+0.62*(0.33+0.22+0.13)=0.50+0.422=0.922 ✓
      return `aecho=0.50:0.62:${d1}|${d2}|${d3}:${dec1}|${dec2}|${dec3}`;
    }
    case 'karaoke': {
      // Evita dependência de stereotools (pode falhar em alguns builds de ffmpeg).
      // Pan por diferença L-R remove o centro (voz principal) sem derrubar o stream.
      const mix = lerp(0.55, 0.95, t).toFixed(2);
      return `pan=stereo|c0=${mix}*FL-${mix}*FR|c1=${mix}*FR-${mix}*FL`;
    }
    case '8d': {
      const hz = lerp(0.1, 1.5, t).toFixed(2);
      const wide = lerp(1.1, 3.5, t).toFixed(2);
      return `apulsator=hz=${hz},stereowiden=${wide}`;
    }
    case 'distortion': {
      const gain = lerp(3, 14, t).toFixed(1);
      const bits = Math.round(lerp(14, 3, t));
      const levelIn = lerp(1.05, 3.0, t).toFixed(2);
      return `equalizer=f=80:t=q:w=1.2:g=${gain},acrusher=level_in=${levelIn}:level_out=1:bits=${bits}:mode=log`;
    }
    case 'vaporwave': {
      const rate = lerp(0.92, 0.68, t).toFixed(4);
      const tempo = lerp(0.95, 0.80, t).toFixed(3);
      // Delay máx 750ms: dreamy sem tocar "outra música" junto
      const echoDelay = Math.round(lerp(200, 750, t));
      const echoDecay = lerp(0.15, 0.38, t).toFixed(2);
      const inGain = Math.max(0.48, 0.95 - 0.86 * parseFloat(echoDecay)).toFixed(2);
      // t=1: max(0.48, 0.623); total=0.623+0.86*0.38=0.95 ✓
      const lowpass = Math.round(lerp(9500, 2200, t));
      return `asetrate=44100*${rate},aresample=44100,atempo=${tempo},aecho=${inGain}:0.86:${echoDelay}:${echoDecay},lowpass=f=${lowpass}`;
    }
    case 'tremolo': {
      const freq = lerp(2, 16, t).toFixed(1);
      const depth = lerp(0.1, 0.95, t).toFixed(2);
      return `tremolo=f=${freq}:d=${depth}`;
    }
    case 'chipmunk': {
      const rate = lerp(1.10, 1.95, t).toFixed(4);
      const tempo = lerp(0.98, 0.60, t).toFixed(3);
      return `asetrate=44100*${rate},aresample=44100,atempo=${tempo},treble=g=2.5`;
    }
    case 'alvin':
      return buildAlvinFilter(intensity);
    case 'giant': {
      const rate = lerp(0.95, 0.56, t).toFixed(4);
      const tempo = lerp(0.99, 0.83, t).toFixed(3);
      const bass = lerp(1.5, 8.0, t).toFixed(1);
      return `asetrate=44100*${rate},aresample=44100,atempo=${tempo},equalizer=f=110:t=q:w=1.2:g=${bass}`;
    }
    case 'robot':
      return buildRobotVoiceFilter(intensity);
    case 'radio': {
      const hp = Math.round(lerp(220, 700, t));
      const lp = Math.round(lerp(4200, 2100, t));
      const bits = Math.round(lerp(12, 6, t));
      const tremD = lerp(0.02, 0.12, t).toFixed(2);
      return `highpass=f=${hp},lowpass=f=${lp},acrusher=level_in=1.08:level_out=1:bits=${bits}:mode=log,tremolo=f=13:d=${tremD}`;
    }
    case 'telefone': {
      const hp = Math.round(lerp(300, 450, t));
      const lp = Math.round(lerp(3400, 2600, t));
      const bits = Math.round(lerp(14, 8, t));
      return `highpass=f=${hp},lowpass=f=${lp},acrusher=level_in=1.0:level_out=1:bits=${bits}`;
    }
    case 'glitch': {
      const bits = Math.round(lerp(11, 4, t));
      const down = Math.round(lerp(22050, 7000, t));
      const tremF = lerp(12, 40, t).toFixed(1);
      const tremD = lerp(0.55, 0.98, t).toFixed(2);
      const d1 = Math.round(lerp(40, 120, t));
      const d2 = Math.round(lerp(80, 260, t));
      const dec1 = lerp(0.10, 0.35, t).toFixed(2);
      const dec2 = lerp(0.05, 0.25, t).toFixed(2);
      // Glitch estável sem expressões: digitalização + pulsação agressiva + ecos curtos.
      return `acrusher=level_in=1.2:level_out=1:bits=${bits}:mode=log,aresample=${down},aresample=48000,tremolo=f=${tremF}:d=${tremD},aecho=0.72:0.62:${d1}|${d2}:${dec1}|${dec2}`;
    }
    case 'reverse': {
      // Em stream contínuo, reverse real tende a travar (precisa de EOF).
      // Aqui usamos um "reverse illusion" estável para tempo real.
      const phIn = lerp(0.35, 0.85, t).toFixed(2);
      const phOut = lerp(0.45, 0.92, t).toFixed(2);
      const speed = lerp(0.20, 0.90, t).toFixed(2);
      const decay = lerp(0.25, 0.62, t).toFixed(2);
      return `aphaser=in_gain=${phIn}:out_gain=${phOut}:delay=2:decay=${decay}:speed=${speed},aecho=0.75:0.60:80:0.22`;
    }
    case 'drunk': {
      const vf = lerp(2.2, 8.8, t).toFixed(2);
      const vd = lerp(0.16, 0.90, t).toFixed(2);
      const wow = lerp(0.996, 0.955, t).toFixed(4);
      return `vibrato=f=${vf}:d=${vd},asetrate=44100*${wow},aresample=44100`;
    }
    case 'lag': {
      const d1 = Math.round(lerp(180, 420, t));
      const d2 = Math.round(lerp(360, 920, t));
      const d3 = Math.round(lerp(540, 1450, t));
      const dec1 = lerp(0.20, 0.46, t).toFixed(2);
      const dec2 = lerp(0.14, 0.34, t).toFixed(2);
      const dec3 = lerp(0.08, 0.24, t).toFixed(2);
      const tremF = lerp(2.5, 7.0, t).toFixed(2);
      const tremD = lerp(0.35, 0.85, t).toFixed(2);
      // Efeito de "lag": repetições longas + variação de volume em blocos.
      return `aecho=0.76:0.66:${d1}|${d2}|${d3}:${dec1}|${dec2}|${dec3},tremolo=f=${tremF}:d=${tremD}`;
    }
    case '8bit': {
      const bits = Math.round(lerp(7, 2, t));
      const outRate = Math.round(lerp(11000, 4200, t));
      const inGain = lerp(1.40, 2.80, t).toFixed(2);
      const hp = Math.round(lerp(180, 380, t));
      const lp = Math.round(lerp(4400, 2200, t));
      const tremD = lerp(0.03, 0.10, t).toFixed(2);
      // 8-bit mais evidente: redução forte de bits e sample rate com timbre arcade.
      return `highpass=f=${hp},lowpass=f=${lp},acrusher=level_in=${inGain}:level_out=1:bits=${bits}:mode=log,aresample=${outRate},aresample=48000,compand=attacks=0:decays=0.05:points=-80/-80|-36/-30|-18/-14|0/-5,tremolo=f=12:d=${tremD}`;
    }
    default:
      return null;
  }
}

function getEffectList() {
  return [...VALID_EFFECTS];
}

function getIntensityEffectList() {
  return [...INTENSITY_EFFECTS];
}

function getEffectDescriptions() {
  return { ...EFFECT_DESCRIPTIONS };
}

function createFilteredStream(url, effect, intensity = 5, seekSeconds = 0, smoothSwitch = false) {
  const filter = buildEffectFilter(effect, intensity);

  const buildMasterPostFilter = () => {
    // Cadeia final leve para segurar picos e manter consistência sem custo alto.
    return [
      'acompressor=threshold=-17dB:ratio=2.2:attack=5:release=140:makeup=1.16',
      'volume=1.08',
      'alimiter=limit=0.98:level=disabled',
    ].join(',');
  };

  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestaudio/best',
    '-o', '-',
    '--quiet',
    '--no-warnings',
    '--no-progress',
    '--no-playlist',
    '--extractor-args', 'youtube:player_client=android',
    url,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // DEBUG: saber quando executamos FFmpeg e qual filtro estamos aplicando
  if (filter) {
    console.log(`🎛️ Aplicando efeito de áudio: ${effect} -> ${filter}`);
  } else {
    console.log('🎛️ Nenhum efeito ativo; tocando sem filtro.');
  }

  const logYtdlp = (d) => {
    const msg = d.toString().trim();
    if (!msg) return;
    if (msg.toLowerCase().includes('broken pipe')) return;
    if (msg.toLowerCase().includes('invalid argument')) return;
    if (msg.toLowerCase().includes('exception ignored in:')) return;
    if (msg.toLowerCase().includes("textiowrapper name='<stdout>'")) return;
    console.error('yt-dlp stderr:', msg);
  };

  ytdlp.stderr.on('data', logYtdlp);
  ytdlp.on('error', (error) => {
    console.error('❌ yt-dlp erro:', error.message);
  });

  if (ytdlp.stdout && typeof ytdlp.stdout.on === 'function') {
    ytdlp.stdout.on('error', (err) => {
      if (isExpectedStreamCloseError(err)) return;
      console.error('❌ yt-dlp stdout erro:', err?.message || err);
    });
  }

  const needFfmpeg = Boolean(filter) || seekSeconds > 0 || smoothSwitch;
  if (!needFfmpeg) {
    return { stream: ytdlp.stdout, ytdlp, ffmpeg: null, isRaw: false };
  }

  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffmpegArgs = ['-hide_banner', '-loglevel', 'error'];
  ffmpegArgs.push('-i', 'pipe:0');

  // Em entrada via pipe, -ss pode ser inconsistente. Usamos atrim para corte preciso.
  const seekFilter = seekSeconds > 0
    ? `atrim=start=${seekSeconds.toFixed(3)},asetpts=PTS-STARTPTS`
    : null;

  // Fade curto para suavizar sem aumentar muito a latência perceptível.
  const fade = smoothSwitch ? 'afade=t=in:st=0:d=0.06' : null;
  const master = buildMasterPostFilter();
  const fullFilter = [seekFilter, filter, fade, master].filter(Boolean).join(',');

  if (fullFilter) {
    ffmpegArgs.push('-af', fullFilter);
  }
  ffmpegArgs.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');

  const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  ytdlp.stdout.pipe(ffmpeg.stdin);

  ffmpeg.on('error', (error) => {
    console.error('❌ ffmpeg erro:', error.message);
  });

  ffmpeg.stderr.on('data', (d) => {
    const msg = String(d || '').trim();
    if (!msg) return;
    if (msg.toLowerCase().includes('broken pipe')) return;
    if (msg.toLowerCase().includes('conversion failed')) return;
    // Artefatos normais de fechamento de stream ao trocar efeito/música
    if (msg.includes('Error muxing a packet')) return;
    if (msg.includes('Error writing trailer')) return;
    if (msg.includes('Error closing file')) return;
    if (msg.includes('Error submitting a packet to the muxer')) return;
    console.error('ffmpeg stderr:', msg);
  });

  if (ffmpeg.stdout && typeof ffmpeg.stdout.on === 'function') {
    ffmpeg.stdout.on('error', (err) => {
      if (isExpectedStreamCloseError(err)) return;
      console.error('❌ ffmpeg stdout erro:', err?.message || err);
    });
  }

  ffmpeg.once('close', () => {
    try {
      if (ytdlp.stdout && ffmpeg.stdin) ytdlp.stdout.unpipe(ffmpeg.stdin);
    } catch {}
    killProcessSafe(ytdlp);
  });

  ytdlp.once('close', () => {
    try {
      if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
    } catch {}
  });

  return { stream: ffmpeg.stdout, ytdlp, ffmpeg, isRaw: true };
}

async function playNext(guildId) {
  const data = guilds.get(guildId);
  if (!data) {
    return;
  }

  // Ensure history array exists
  if (!Array.isArray(data.history)) {
    data.history = [];
  }

  if (data.advanceInProgress) {
    data.advanceRequested = true;
    return;
  }

  data.advanceInProgress = true;
  try {
    if (data.queue.length === 0) {
      if (data.loopPlaylist) {
        // Loop de playlist: reabastece a fila do início usando snapshot canônico.
        const full = data.playlistFull.length > 0 ? data.playlistFull : buildSessionPlaylist(data);
        if (full.length === 0) {
          data.currentSong = null;
          if (data.nowPlayingMessage) {
            data.nowPlayingMessage.delete().catch(() => {});
            data.nowPlayingMessage = null;
          }
          if (typeof onSongChangedCallback === 'function') {
            Promise.resolve(onSongChangedCallback(guildId, null)).catch(() => {});
          }
          return;
        }
        data.playlistFull = full.map((s) => ({ ...s }));
        data.queue = full.map(s => ({ ...s }));
        data.history = [];
      } else {
        data.currentSong = null;
        if (data.nowPlayingMessage) {
          data.nowPlayingMessage.delete().catch(() => {});
          data.nowPlayingMessage = null;
        }
        if (typeof onSongChangedCallback === 'function') {
          Promise.resolve(onSongChangedCallback(guildId, null)).catch(() => {});
        }
        return;
      }
    }

    const song = data.queue.shift();
    if (!song) {
      data.currentSong = null;
      return;
    }

    try {
      await ensurePlayableSong(song);
      playSong(guildId, song);
    } catch (err) {
      console.error('❌ Falha ao iniciar a próxima música, tentando avançar:', err?.message || err);
      data.currentSong = null;
      data.currentSongOffsetSeconds = 0;
      cleanupCurrentStream(data);
      if (data.queue.length > 0) {
        schedulePlayNext(guildId, PLAY_NEXT_ERROR_DELAY_MS);
      } else if (data.loopPlaylist) {
        const full = data.playlistFull.length > 0 ? data.playlistFull : buildSessionPlaylist(data);
        if (full.length === 0) return;
        data.playlistFull = full.map((s) => ({ ...s }));
        data.queue = full.map(s => ({ ...s }));
        data.history = [];
        schedulePlayNext(guildId, PLAY_NEXT_ERROR_DELAY_MS);
      }
    }
  } finally {
    data.advanceInProgress = false;
    if (data.advanceRequested) {
      data.advanceRequested = false;
      schedulePlayNext(guildId, 0);
    }
  }
}

/**
 * Adiciona um vídeo do YouTube à fila (ou toca imediatamente se vazia).
 */
async function addYouTube(message, url, title) {
  const data = await ensureConnection(message);
  const startingFreshSession = !data.currentSong && data.queue.length === 0;
  if (startingFreshSession) {
    clearRemovedSongMarks(data);
    data.history = [];
    data.playlistFull = [];
    data.loop = false;
    data.loopPlaylist = false;
  }
  const song = { url, title: title || 'vídeo do YouTube' };
  if (!Number.isFinite(song.sequence)) {
    data.sequenceCounter = (data.sequenceCounter || 0) + 1;
    song.sequence = data.sequenceCounter;
  }

  // CRITICAL: isActive deve considerar Buffering também!
  const isActive =
    data.currentSong &&
    (data.musicPlayer.state.status === AudioPlayerStatus.Playing ||
      data.musicPlayer.state.status === AudioPlayerStatus.Paused ||
      data.musicPlayer.state.status === AudioPlayerStatus.Buffering);

  if (!isActive) {
    data.queue.push(song);
    refreshLoopPlaylistSnapshot(data);
    playNext(message.guildId);
    return null;
  } else {
    data.queue.push(song);
    refreshLoopPlaylistSnapshot(data);
    const position = data.queue.length;
    const sentMsg = await message.reply(`📋 **${song.title}** adicionada à fila (posição #${position})`).catch(() => null);
    await refreshNowPlayingMessage(message.guildId).catch(() => {});
    return sentMsg;
  }
}

/**
 * Adiciona todos os vídeos de uma playlist à fila.
 * opts.editMsg  — mensagem existente a editar em vez de criar nova
 * opts.statusText — texto customizado (substitui o padrão)
 * Retorna a mensagem enviada/editada.
 */
async function addPlaylist(message, videos, opts = {}) {
  const data = await ensureConnection(message);
  const startingFreshSession = !data.currentSong && data.queue.length === 0;
  if (startingFreshSession) {
    clearRemovedSongMarks(data);
    data.history = [];
    data.playlistFull = [];
    data.loop = false;
    data.loopPlaylist = false;
  }

  // CRITICAL: isActive deve considerar Buffering também, senão playNext() é chamado prematuramente!
  const isActive =
    data.currentSong &&
    (data.musicPlayer.state.status === AudioPlayerStatus.Playing ||
      data.musicPlayer.state.status === AudioPlayerStatus.Paused ||
      data.musicPlayer.state.status === AudioPlayerStatus.Buffering);

  for (const video of videos) {
    if (!Number.isFinite(video.sequence)) {
      data.sequenceCounter = (data.sequenceCounter || 0) + 1;
      video.sequence = data.sequenceCounter;
    }
    data.queue.push(video);
  }

  refreshLoopPlaylistSnapshot(data);

  if (!isActive) {
    playNext(message.guildId);
  }

  const defaultText = !isActive
    ? `📋 Playlist com **${videos.length}** música(s) adicionada! Tocando a primeira...`
    : `📋 **${videos.length}** música(s) da playlist adicionadas à fila!`;

  const text = Object.prototype.hasOwnProperty.call(opts, 'statusText') ? opts.statusText : defaultText;

  if (opts.skipStatusMessage) {
    await refreshNowPlayingMessage(message.guildId).catch(() => {});
    return opts.editMsg || null;
  }

  let sentMsg = null;
  if (opts.editMsg && typeof opts.editMsg.edit === 'function') {
    sentMsg = await opts.editMsg.edit(text).catch(() => null);
    if (!sentMsg) sentMsg = await message.reply(text).catch(() => null);
  } else {
    sentMsg = await message.reply(text).catch(() => null);
  }

  await refreshNowPlayingMessage(message.guildId).catch(() => {});

  return sentMsg;
}

// ============================================================
// SFX (MyInstants) — toca instantaneamente, sem fila
// ============================================================

/**
 * Toca um som do MyInstants imediatamente.
 * Se há música tocando, pausa ela brevemente, toca o SFX,
 * e depois retoma a música.
 */
async function playSfx(message, tmpFile, displayName, volumeMultiplier = 1.0) {
  const data = await ensureConnection(message);
  const requesterId = message.author?.id || '0';
  const sfxToken = (data.sfxPlaybackToken || 0) + 1;
  data.sfxPlaybackToken = sfxToken;

  const musicIsPlaying =
    data.musicPlayer.state.status === AudioPlayerStatus.Playing;

  // Pausar música se estiver tocando
  if (musicIsPlaying && !data.musicPausedForSfx) {
    data.musicPlayer.pause();
    data.musicPausedForSfx = true;
  }

  // Inscrever sfx player na conexão
  data.connection.subscribe(data.sfxPlayer);

  const effectiveVol = Number.isFinite(Number(volumeMultiplier)) ? Number(volumeMultiplier) : 1.0;
  const useInlineVolume = Math.abs(effectiveVol - 1.0) > 0.001;
  const resource = useInlineVolume
    ? createAudioResource(tmpFile, { inlineVolume: true })
    : createAudioResource(tmpFile);
  if (useInlineVolume) resource.volume.setVolume(effectiveVol);
  data.sfxPlayer.play(resource);

  // Mensagem temporária para não poluir o chat
  if (data.nowPlayingSfxMessage) {
    data.nowPlayingSfxMessage.delete().catch(() => {});
    data.nowPlayingSfxMessage = null;
  }

  const sfxControls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sfx_stop_${message.guildId}_${requesterId}`)
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger)
  );

  const msg = await message
    .reply({
      content: `🔊 Tocando: **${displayName || 'som'}**`,
      components: [sfxControls],
    })
    .catch(() => null);

  if (msg && data.sfxPlaybackToken === sfxToken) {
    data.nowPlayingSfxMessage = msg;
  } else if (msg) {
    msg.delete().catch(() => {});
  }

  // Quando o SFX terminar, retomar a música
  const onFinish = () => {
    data.sfxPlayer.removeListener('error', onError);
    fs.unlink(tmpFile, () => {});

    // Ignore finalização de um SFX antigo quando já existe outro mais novo tocando.
    if (data.sfxPlaybackToken !== sfxToken) return;

    if (data.nowPlayingSfxMessage) {
      data.nowPlayingSfxMessage.delete().catch(() => {});
      data.nowPlayingSfxMessage = null;
    }

    if (data.musicPausedForSfx) {
      data.connection.subscribe(data.musicPlayer);
      data.musicPlayer.unpause();
      data.musicPausedForSfx = false;
    } else if (data.musicPlayer) {
      data.connection.subscribe(data.musicPlayer);
    }
  };

  const onError = (error) => {
    console.error('❌ Erro no sfx player:', error.message);
    data.sfxPlayer.removeListener(AudioPlayerStatus.Idle, onFinish);
    fs.unlink(tmpFile, () => {});

    // Ignore erro de um SFX antigo quando já existe outro mais novo tocando.
    if (data.sfxPlaybackToken !== sfxToken) return;

    if (data.nowPlayingSfxMessage) {
      data.nowPlayingSfxMessage.delete().catch(() => {});
      data.nowPlayingSfxMessage = null;
    }

    if (data.musicPausedForSfx) {
      data.connection.subscribe(data.musicPlayer);
      data.musicPlayer.unpause();
      data.musicPausedForSfx = false;
    }
  };

  data.sfxPlayer.once(AudioPlayerStatus.Idle, onFinish);
  data.sfxPlayer.once('error', onError);

  return msg;
}

function stopSfx(guildId) {
  const data = guilds.get(guildId);
  if (!data || !data.sfxPlayer) return false;

  const status = data.sfxPlayer.state?.status;
  if (!status || status === AudioPlayerStatus.Idle) return false;

  data.sfxPlayer.stop();
  return true;
}

// ============================================================
// Comandos de controle
// ============================================================

async function skip(message, replyFn = (text) => message.reply(text)) {
  const data = guilds.get(message.guildId);
  if (!data || !data.currentSong) {
    await replyFn('❌ Nenhuma música está tocando no momento.');
    return;
  }

  const now = Date.now();
  if (now < (data.navCooldownUntil || 0)) {
    await replyFn('⏳ Aguarde um instante antes de avançar novamente.');
    return;
  }
  data.navCooldownUntil = now + (Number(MQ_CFG.navCooldownMs) || 350);

  if (data.queue.length === 0) {
    await replyFn('❌ Não há próxima música na fila.');
    return;
  }

  // Add current song to history before advancing
  if (!Array.isArray(data.history)) data.history = [];
  if (data.currentSong) {
    data.history.push(data.currentSong);
    trimHistoryIfNeeded(data);
  }

  // Get next song WITHOUT revealing it yet
  const nextSong = data.queue.shift();

  // Ensure SoundCloud metadata is fresh
  await ensurePlayableSong(nextSong).catch(() => {});
  
  // Play the next song (will increment suppress counters again if active resource exists)
  playSong(message.guildId, nextSong, 0, true);
  
  // Update UI and notify
  await refreshNowPlayingMessage(message.guildId).catch(() => {});
}


async function stop(message, replyFn = (text) => message.reply(text)) {
  const data = guilds.get(message.guildId);
  if (!data) {
    await replyFn('❌ Nenhum áudio está tocando no momento.');
    return;
  }

  const hasActiveAudioOrQueue = Boolean(data.currentSong) || data.queue.length > 0;
  const hasAnyLoopEnabled = Boolean(data.loop) || Boolean(data.loopPlaylist);

  if (!hasActiveAudioOrQueue && !hasAnyLoopEnabled) {
    await replyFn('❌ Nenhum áudio está tocando no momento.');
    return;
  }

  if (data.nowPlayingMessage) {
    data.nowPlayingMessage.delete().catch(() => {});
    data.nowPlayingMessage = null;
  }
  if (data.nowPlayingSfxMessage) {
    data.nowPlayingSfxMessage.delete().catch(() => {});
    data.nowPlayingSfxMessage = null;
  }

  data.queue = [];
  data.currentSong = null;
  data.currentSequence = 0;
  data.sequenceCounter = 0;
  data.history = [];
  data.loop = false;
  data.loopPlaylist = false;
  data.playlistFull = [];
  clearRemovedSongMarks(data);
  data.musicPausedForSfx = false;
  data.advanceInProgress = false;
  data.advanceRequested = false;
  clearScheduledTimers(data);
  data.suppressNextIdleCount = 0;
  data.suppressNextErrorAdvanceCount = 0;
  data.navCooldownUntil = 0;
  if (data.musicPlayer) data.musicPlayer.stop();
  if (data.sfxPlayer) data.sfxPlayer.stop();
}

function leave(message) {
  const data = guilds.get(message.guildId);
  if (!data || !data.connection) {
    message.reply('❌ Não estou em nenhum canal de voz.');
    return;
  }

  clearRemovedSongMarks(data);

  if (data.nowPlayingMessage) {
    data.nowPlayingMessage.delete().catch(() => {});
    data.nowPlayingMessage = null;
  }
  if (data.nowPlayingSfxMessage) {
    data.nowPlayingSfxMessage.delete().catch(() => {});
    data.nowPlayingSfxMessage = null;
  }

  cleanup(message.guildId);
  message.reply('👋 Saí do canal de voz!');
}

function leaveSilently(guildId) {
  const data = guilds.get(guildId);
  if (!data || !data.connection) return false;
  cleanup(guildId);
  return true;
}

function wireConnectionLifecycle(data, guildId) {
  if (!data?.connection) return;
  const boundConnection = data.connection;

  // Evita crash quando a biblioteca emite erro de rede
  const onConnectionError = (err) => {
    if (data.connection !== boundConnection) return;

    const now = Date.now();
    const isIpDiscoveryError =
      err && typeof err.message === 'string' &&
      err.message.includes('Cannot perform IP discovery');

    // Se for erro comum de IP discovery, limita logs a cada 30s por guild
    if (isIpDiscoveryError) {
      if (now - data.lastVoiceErrorAt < (Number(MQ_CFG.ipDiscoveryLogCooldownMs) || 30_000)) return;
      data.lastVoiceErrorAt = now;
    }

    console.error('⚠️ Erro na conexão de voz:', err.message || err);
  };

  data.connection.on('error', onConnectionError);

  // Remover listener ao destruir a conexão, para evitar múltiplos logs
  const cleanupConnection = () => {
    if (data.connection !== boundConnection) return;
    try {
      boundConnection.removeListener('error', onConnectionError);
    } catch {}
  };
  boundConnection.on(VoiceConnectionStatus.Destroyed, cleanupConnection);

  boundConnection.on(VoiceConnectionStatus.Disconnected, async () => {
    if (data.connection !== boundConnection) return;

    try {
      await Promise.race([
        entersState(boundConnection, VoiceConnectionStatus.Signalling, Number(MQ_CFG.voiceReconnectWaitMs) || 5_000),
        entersState(boundConnection, VoiceConnectionStatus.Connecting, Number(MQ_CFG.voiceReconnectWaitMs) || 5_000),
      ]);
    } catch {
      if (data.connection !== boundConnection) return;
      if (Date.now() < (data.externalMoveGraceUntil || 0)) {
        return;
      }
      cleanup(guildId);
    }
  });
}

function cleanup(guildId) {
  const data = guilds.get(guildId);
  if (!data) return;

  if (data.nowPlayingMessage) {
    data.nowPlayingMessage.delete().catch(() => {});
    data.nowPlayingMessage = null;
  }
  if (data.nowPlayingSfxMessage) {
    data.nowPlayingSfxMessage.delete().catch(() => {});
    data.nowPlayingSfxMessage = null;
  }

  data.queue = [];
  data.currentSong = null;
  data.anchorMessageId = null;
  data.anchorNowPlayingEnabled = true;
  data.history = [];
  data.loopPlaylist = false;
  data.playlistFull = [];
  clearRemovedSongMarks(data);
  data.musicPausedForSfx = false;
  data.advanceInProgress = false;
  data.advanceRequested = false;
  clearScheduledTimers(data);
  data.suppressNextIdleCount = 0;
  data.suppressNextErrorAdvanceCount = 0;
  data.navCooldownUntil = 0;
  if (data.musicPlayer) data.musicPlayer.stop();
  if (data.sfxPlayer) data.sfxPlayer.stop();
  if (data.connection) {
    try {
      data.connection.destroy();
    } catch {}
    data.connection = null;
  }
  guilds.delete(guildId);
}

function getQueue(guildId) {
  const data = guilds.get(guildId);
  if (!data) return { current: null, queue: [] };
  return {
    current: data.currentSong,
    queue: [...data.queue],
  };
}

async function removeCurrentSong(guildId) {
  const data = guilds.get(guildId);
  if (!data || !data.currentSong) {
    return { ok: false, reason: 'no-current' };
  }

  if (data.loopPlaylist) {
    const full = data.playlistFull.length > 0 ? data.playlistFull.map((song) => ({ ...song })) : buildSessionPlaylist(data);
    const currentIndex = findSongIndexInList(full, data.currentSong);
    if (currentIndex < 0) {
      return { ok: false, reason: 'invalid-position' };
    }
    return removeQueuePosition(guildId, currentIndex + 1);
  }

  const removedSong = data.currentSong;

  if (data.queue.length > 0) {
    const nextSong = data.queue.shift();
    if (!nextSong) {
      data.currentSong = null;
      return { ok: false, reason: 'empty' };
    }

    await ensurePlayableSong(nextSong).catch(() => {});
    playSong(guildId, nextSong, 0, true);
    removeSongFromAllCollections(data, removedSong);
    await refreshNowPlayingMessage(guildId).catch(() => {});
    refreshLoopPlaylistSnapshot(data);
    return { ok: true, removedSong, removedCurrent: true };
  }

  data.currentSong = null;
  data.currentSongOffsetSeconds = 0;
  cleanupCurrentStream(data);
  if (data.musicPlayer) data.musicPlayer.stop();

  if (data.nowPlayingMessage) {
    data.nowPlayingMessage.delete().catch(() => {});
    data.nowPlayingMessage = null;
  }

  if (typeof onSongChangedCallback === 'function') {
    Promise.resolve(onSongChangedCallback(guildId, null)).catch(() => {});
  }

  removeSongFromAllCollections(data, removedSong);
  refreshLoopPlaylistSnapshot(data);
  return { ok: true, removedSong, removedCurrent: true };
}

async function removeQueuePosition(guildId, position) {
  const data = guilds.get(guildId);
  if (!data) return { ok: false, reason: 'missing-guild' };

  const idx = Math.floor(Number(position)) - 1;
  if (!Number.isFinite(idx) || idx < 0) {
    return { ok: false, reason: 'invalid-position' };
  }

  if (data.loopPlaylist) {
    const full = data.playlistFull.length > 0 ? data.playlistFull.map((song) => ({ ...song })) : buildSessionPlaylist(data);
    if (idx >= full.length) {
      return { ok: false, reason: 'invalid-position' };
    }

    const removedSong = full[idx];
    markSongAsRemoved(data, removedSong);
    const currentIndex = findSongIndexInList(full, data.currentSong);
    if (currentIndex < 0) {
      return { ok: false, reason: 'invalid-position' };
    }

    const nextFull = full.filter((_, i) => i !== idx).map((song) => ({ ...song }));

    if (nextFull.length === 0) {
      data.playlistFull = [];
      data.history = [];
      data.queue = [];
      data.currentSong = null;
      data.currentSongOffsetSeconds = 0;
      cleanupCurrentStream(data);
      if (data.musicPlayer) data.musicPlayer.stop();
      if (data.nowPlayingMessage) {
        data.nowPlayingMessage.delete().catch(() => {});
        data.nowPlayingMessage = null;
      }
      if (typeof onSongChangedCallback === 'function') {
        Promise.resolve(onSongChangedCallback(guildId, null)).catch(() => {});
      }
      return { ok: true, removedSong, removedCurrent: true, queueEmpty: true };
    }

    if (idx === currentIndex) {
      const nextIndex = Math.min(idx, nextFull.length - 1);
      const nextSong = nextFull[nextIndex];

      data.playlistFull = nextFull.map((song) => ({ ...song }));
      data.history = nextFull.slice(0, nextIndex).map((song) => ({ ...song }));
      data.queue = nextFull.slice(nextIndex + 1).map((song) => ({ ...song }));

      await ensurePlayableSong(nextSong).catch(() => {});
      playSong(guildId, { ...nextSong }, 0, true);
      await refreshNowPlayingMessage(guildId).catch(() => {});

      return { ok: true, removedSong, removedCurrent: true };
    }

    const nextCurrentIndex = idx < currentIndex ? currentIndex - 1 : currentIndex;
    data.playlistFull = nextFull.map((song) => ({ ...song }));
    data.history = nextFull.slice(0, nextCurrentIndex).map((song) => ({ ...song }));
    data.queue = nextFull.slice(nextCurrentIndex + 1).map((song) => ({ ...song }));

    return { ok: true, removedSong, removedCurrent: false };
  }

  if (idx >= data.queue.length) {
    return { ok: false, reason: 'invalid-position' };
  }

  const [removedSong] = data.queue.splice(idx, 1);
  if (!removedSong) return { ok: false, reason: 'invalid-position' };
  removeSongFromAllCollections(data, removedSong);
  refreshLoopPlaylistSnapshot(data);
  return { ok: true, removedSong, removedCurrent: false };
}

async function jumpTo(guildId, position) {
  const data = guilds.get(guildId);
  if (!data) return false;

  if (data.loopPlaylist) {
    const full = data.playlistFull.length > 0 ? data.playlistFull.map((song) => ({ ...song })) : buildSessionPlaylist(data);
    const idx = Math.floor(position) - 1;
    if (isNaN(idx) || idx < 0 || idx >= full.length) return false;

    const targetSong = full[idx];
    if (!targetSong) return false;

    data.playlistFull = full.map((song) => ({ ...song }));
    data.history = full.slice(0, idx).map((song) => ({ ...song }));
    data.queue = full.slice(idx + 1).map((song) => ({ ...song }));

    await ensurePlayableSong(targetSong).catch(() => {});
    playSong(guildId, { ...targetSong }, 0, true);
    await refreshNowPlayingMessage(guildId).catch(() => {});

    return true;
  }

  // Position is 1-based index into the queue (not including the current song)
  const idx = Math.floor(position) - 1;
  if (isNaN(idx) || idx < 0 || idx >= data.queue.length) return false;

  if (!Array.isArray(data.history)) data.history = [];

  // Keep skipped songs in history so ⏮️ can walk back from the jumped target.
  const skippedBeforeTarget = data.queue.splice(0, idx);
  const targetSong = data.queue.shift();
  if (!targetSong) return false;

  if (data.currentSong) data.history.push(data.currentSong);
  if (skippedBeforeTarget.length > 0) data.history.push(...skippedBeforeTarget);
  trimHistoryIfNeeded(data);

  await ensurePlayableSong(targetSong).catch(() => {});
  playSong(guildId, targetSong, 0, true);
  await refreshNowPlayingMessage(guildId).catch(() => {});

  return true;
}

function toggleLoop(guildId) {
  const data = guilds.get(guildId);
  if (!data) return false;
  data.loop = !data.loop;
  return data.loop;
}

function getLoop(guildId) {
  const data = guilds.get(guildId);
  return data?.loop || false;
}

function toggleLoopPlaylist(guildId) {
  const data = guilds.get(guildId);
  if (!data) {
    return { enabled: false, currentIndex: 0, total: 0 };
  }
  data.loopPlaylist = !data.loopPlaylist;
  if (data.loopPlaylist) {
    // Snapshot canônico por ordem original (sequence), robusto para jump/skip durante carregamento.
    data.playlistFull = buildSessionPlaylist(data);
    const currentIndex = Math.max(0, findSongIndexInList(data.playlistFull, data.currentSong));
    return { enabled: true, currentIndex, total: data.playlistFull.length };
  } else {
    data.playlistFull = [];
    return { enabled: false, currentIndex: 0, total: 0 };
  }
}

function getLoopPlaylist(guildId) {
  return guilds.get(guildId)?.loopPlaylist || false;
}

function getQueueFull(guildId) {
  const data = guilds.get(guildId);
  if (!data) return { current: null, queue: [], history: [], loopPlaylist: false, effect: null, effectIntensity: 5 };
  const loopView = getLoopPlaylistView(data);
  return {
    current: data.currentSong,
    queue: [...data.queue],
    history: [...(data.history || [])],
    loopPlaylist: data.loopPlaylist || false,
    playlistSongs: loopView.songs,
    currentIndex: loopView.currentIndex,
    effect: data.effect,
    effectIntensity: data.effectIntensity || 5,
  };
}

function restartPlaylist(guildId) {
  const data = guilds.get(guildId);
  if (!data) return false;
  // Reinicia sempre com base no estado real da sessão (history + atual + fila)
  // para não herdar entradas residuais em playlistFull.
  const full = buildSessionPlaylist(data);
  if (full.length === 0) return false;
  const freshList = full.map(s => ({ ...s }));
  // Mantém snapshot limpo/canônico para os próximos ciclos e para novos restarts.
  data.playlistFull = freshList.map(s => ({ ...s }));
  data.history = [];
  data.queue = freshList.slice(1);
  playSong(guildId, freshList[0], 0, true);
  return true;
}

/**
 * Toca a música anterior (botão ⏮️).
 * Empurra a música atual para o início da fila e inicia a anterior imediatamente.
 * Retorna false se não há música anterior.
 */
function playPrevious(message) {
  const data = guilds.get(message.guildId);
  if (!data || !Array.isArray(data.history) || data.history.length === 0) return false;

  const now = Date.now();
  if (now < (data.navCooldownUntil || 0)) return false;
  data.navCooldownUntil = now + (Number(MQ_CFG.navCooldownMs) || 350);

  const prev = data.history.pop();
  const curr = data.currentSong;

  // Preserva a música atual no início da fila para permitir voltar/avançar sem saltos.
  if (curr) data.queue.unshift(curr);

  // Toca a anterior imediatamente.
  playSong(message.guildId, prev, 0, true);
  refreshNowPlayingMessage(message.guildId).catch(() => {});
  return true;
}

function getNowPlayingMessageId(guildId) {
  const data = guilds.get(guildId);
  return data?.nowPlayingMessage?.id || null;
}

function setNowPlayingAnchorEnabled(guildId, enabled) {
  const data = getGuildData(guildId);
  data.anchorNowPlayingEnabled = Boolean(enabled);
}

function cloneSongs(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(Boolean).map((song) => ({ ...song }));
}

function getMaxSequenceFromSongs(...lists) {
  let maxSeq = 0;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const song of list) {
      const seq = Number(song?.sequence);
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    }
  }
  return maxSeq;
}

function getPlaylistSnapshot(guildId) {
  const data = guilds.get(guildId);
  if (!data) return null;

  const currentSong = data.currentSong ? { ...data.currentSong } : null;
  const queue = cloneSongs(data.queue);
  if (!currentSong && queue.length === 0) return null;

  const history = cloneSongs(data.history);
  const playlistFull = cloneSongs(buildSessionPlaylist(data));
  const maxSequence = getMaxSequenceFromSongs(history, currentSong ? [currentSong] : [], queue, playlistFull);

  return {
    version: 1,
    savedAt: Date.now(),
    currentSong,
    queue,
    history,
    loop: Boolean(data.loop),
    loopPlaylist: Boolean(data.loopPlaylist),
    playlistFull,
    effect: data.effect || null,
    effectIntensity: Math.max(1, Math.min(10, Math.floor(data.effectIntensity || 5))),
    sequenceCounter: Math.max(Number(data.sequenceCounter) || 0, maxSequence),
  };
}

async function restorePlaylistSnapshot(message, snapshot) {
  if (!message?.guildId || !snapshot || typeof snapshot !== 'object') {
    return { ok: false, reason: 'invalid-snapshot' };
  }

  const data = await ensureConnection(message);

  const hadActiveResource = Boolean(data.currentStream) || Boolean(data.currentSong);
  if (hadActiveResource) {
    data.suppressNextIdleCount = (data.suppressNextIdleCount || 0) + 1;
    data.suppressNextErrorAdvanceCount = (data.suppressNextErrorAdvanceCount || 0) + 1;
    data.suppressAdvanceUntil = Date.now() + ADVANCE_SUPPRESSION_WINDOW_MS;
  }

  clearScheduledTimers(data);
  cleanupCurrentStream(data);
  if (data.musicPlayer) data.musicPlayer.stop();
  if (data.sfxPlayer) data.sfxPlayer.stop();

  const restoredCurrent = snapshot.currentSong ? { ...snapshot.currentSong } : null;
  const restoredQueue = cloneSongs(snapshot.queue);
  const restoredHistory = cloneSongs(snapshot.history);
  const restoredPlaylistFull = cloneSongs(snapshot.playlistFull);

  if (!restoredCurrent && restoredQueue.length === 0) {
    return { ok: false, reason: 'empty-snapshot' };
  }

  data.loop = Boolean(snapshot.loop);
  data.loopPlaylist = Boolean(snapshot.loopPlaylist);
  clearRemovedSongMarks(data);
  data.effect = snapshot.effect || null;
  data.effectIntensity = Math.max(1, Math.min(10, Math.floor(snapshot.effectIntensity || 5)));
  data.history = restoredHistory;
  data.queue = restoredQueue;
  data.playlistFull = restoredPlaylistFull;
  data.currentSong = restoredCurrent;
  data.currentSongOffsetSeconds = 0;
  data.currentSequence = Number.isFinite(Number(restoredCurrent?.sequence))
    ? Number(restoredCurrent.sequence)
    : 0;
  data.sequenceCounter = Math.max(
    Number(snapshot.sequenceCounter) || 0,
    getMaxSequenceFromSongs(data.history, data.currentSong ? [data.currentSong] : [], data.queue, data.playlistFull)
  );

  if (data.loopPlaylist && data.playlistFull.length === 0) {
    refreshLoopPlaylistSnapshot(data);
  }

  if (data.currentSong) {
    const targetSong = { ...data.currentSong };
    data.currentSong = null;
    await ensurePlayableSong(targetSong).catch(() => {});
    playSong(message.guildId, targetSong, 0, true);
    await refreshNowPlayingMessage(message.guildId, { forceResend: true }).catch(() => {});
    return {
      ok: true,
      currentTitle: targetSong.title || 'música',
      totalSongs: (data.currentSong ? 1 : 0) + data.queue.length,
    };
  }

  await playNext(message.guildId).catch(() => {});
  await refreshNowPlayingMessage(message.guildId, { forceResend: true }).catch(() => {});
  return {
    ok: true,
    currentTitle: data.currentSong?.title || 'música',
    totalSongs: (data.currentSong ? 1 : 0) + data.queue.length,
  };
}

module.exports = {
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
  ensureConnection,
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
  toggleLoop,
  getLoop,
  toggleLoopPlaylist,
  getLoopPlaylist,
  restartPlaylist,
  playPrevious,
  buildMusicControlRow,
  refreshNowPlayingMessage,
  getNowPlayingMessageId,
  setNowPlayingAnchorEnabled,
  setOnSongChangedCallback,
  leaveSilently,
  stopSfx,
};
