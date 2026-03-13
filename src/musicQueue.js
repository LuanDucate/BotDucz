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

// ============================================================
// Estado por guild
// ============================================================
const guilds = new Map();

function getGuildData(guildId) {
  if (!guilds.has(guildId)) {
    guilds.set(guildId, {
      connection: null,
      musicPlayer: null,
      sfxPlayer: null,
      queue: [],
      currentSong: null,
      textChannel: null,
      musicPausedForSfx: false,
    });
  }
  return guilds.get(guildId);
}

// ============================================================
// Conexão de voz
// ============================================================
async function ensureConnection(message) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) throw new Error('VOICE_NOT_CONNECTED');

  const permissions = voiceChannel.permissionsFor(message.guild.members.me);
  if (!permissions.has('Connect') || !permissions.has('Speak')) {
    throw new Error('VOICE_NO_PERMISSION');
  }

  const data = getGuildData(message.guildId);

  let needNewConnection =
    !data.connection ||
    data.connection.state.status === VoiceConnectionStatus.Destroyed;

  if (
    data.connection &&
    !needNewConnection &&
    data.connection.joinConfig.channelId !== voiceChannel.id
  ) {
    data.connection.destroy();
    needNewConnection = true;
  }

  if (needNewConnection) {
    data.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guildId,
      adapterCreator: message.guild.voiceAdapterCreator,
    });

    try {
      await entersState(data.connection, VoiceConnectionStatus.Ready, 30_000);
      console.log('✅ Conexão de voz pronta!');
    } catch {
      data.connection.destroy();
      data.connection = null;
      throw new Error('VOICE_TIMEOUT');
    }

    data.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(data.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(data.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        cleanup(message.guildId);
      }
    });

    // Resetar players ao reconectar
    data.musicPlayer = null;
    data.sfxPlayer = null;
  }

  // Criar music player se não existe
  if (!data.musicPlayer) {
    data.musicPlayer = createAudioPlayer();

    data.musicPlayer.on(AudioPlayerStatus.Idle, () => {
      console.log('🔇 Música finalizada.');
      data.currentSong = null;
      playNext(message.guildId);
    });

    data.musicPlayer.on('error', (error) => {
      console.error('❌ Erro no music player:', error.message);
      data.currentSong = null;
      playNext(message.guildId);
    });
  }

  // Criar sfx player se não existe
  if (!data.sfxPlayer) {
    data.sfxPlayer = createAudioPlayer();
  }

  data.textChannel = message.channel;
  return data;
}

// ============================================================
// Fila de músicas
// ============================================================

/**
 * Toca a próxima música da fila.
 */
function playNext(guildId) {
  const data = guilds.get(guildId);
  if (!data || data.queue.length === 0) {
    if (data) data.currentSong = null;
    return;
  }

  const song = data.queue.shift();
  data.currentSong = song;

  console.log(`🎶 Tocando próxima da fila: ${song.title}`);

  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestaudio/best',
    '-o', '-',
    '--quiet',
    '--no-warnings',
    '--no-playlist',
    '--extractor-args', 'youtube:player_client=android',
    song.url,
  ]);

  ytdlp.stderr.on('data', (d) =>
    console.error('yt-dlp stderr:', d.toString().trim())
  );

  ytdlp.on('error', (error) => {
    console.error('❌ yt-dlp erro:', error.message);
    if (data.textChannel) {
      data.textChannel.send('❌ **yt-dlp** não está instalado ou ocorreu um erro.');
    }
  });

  const resource = createAudioResource(ytdlp.stdout, {
    inputType: StreamType.Arbitrary,
  });

  // Inscrever music player na conexão e tocar
  data.connection.subscribe(data.musicPlayer);
  data.musicPlayer.play(resource);

  if (data.textChannel) {
    const queueSize = data.queue.length;
    const queueMsg = queueSize > 0 ? ` | 📋 ${queueSize} na fila` : '';
    data.textChannel.send(`🎶 Tocando: **${song.title}**${queueMsg}`);
  }
}

/**
 * Adiciona um vídeo do YouTube à fila (ou toca imediatamente se vazia).
 */
async function addYouTube(message, url, title) {
  const data = await ensureConnection(message);
  const song = { url, title: title || 'vídeo do YouTube' };

  const isActive =
    data.currentSong &&
    (data.musicPlayer.state.status === AudioPlayerStatus.Playing ||
      data.musicPlayer.state.status === AudioPlayerStatus.Paused);

  if (!isActive) {
    data.queue.push(song);
    playNext(message.guildId);
  } else {
    data.queue.push(song);
    const position = data.queue.length;
    message.reply(`📋 **${song.title}** adicionada à fila (posição #${position})`);
  }
}

/**
 * Adiciona todos os vídeos de uma playlist à fila.
 */
async function addPlaylist(message, videos) {
  const data = await ensureConnection(message);

  const isActive =
    data.currentSong &&
    (data.musicPlayer.state.status === AudioPlayerStatus.Playing ||
      data.musicPlayer.state.status === AudioPlayerStatus.Paused);

  for (const video of videos) {
    data.queue.push(video);
  }

  if (!isActive) {
    message.reply(
      `📋 Playlist com **${videos.length}** música(s) adicionada! Tocando a primeira...`
    );
    playNext(message.guildId);
  } else {
    message.reply(`📋 **${videos.length}** música(s) da playlist adicionadas à fila!`);
  }
}

// ============================================================
// SFX (MyInstants) — toca instantaneamente, sem fila
// ============================================================

/**
 * Toca um som do MyInstants imediatamente.
 * Se há música tocando, pausa ela brevemente, toca o SFX,
 * e depois retoma a música.
 */
async function playSfx(message, tmpFile, displayName) {
  const data = await ensureConnection(message);

  const musicIsPlaying =
    data.musicPlayer.state.status === AudioPlayerStatus.Playing;

  // Pausar música se estiver tocando
  if (musicIsPlaying && !data.musicPausedForSfx) {
    data.musicPlayer.pause();
    data.musicPausedForSfx = true;
  }

  // Inscrever sfx player na conexão
  data.connection.subscribe(data.sfxPlayer);

  const resource = createAudioResource(tmpFile);
  data.sfxPlayer.play(resource);

  await message.reactions.removeAll().catch(() => {});
  await message.react('🦆').catch(() => {});
  message.reply(`🔊 Tocando: **${displayName || 'som'}**`);

  // Quando o SFX terminar, retomar a música
  const onFinish = () => {
    data.sfxPlayer.removeListener('error', onError);
    fs.unlink(tmpFile, () => {});

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

    if (data.musicPausedForSfx) {
      data.connection.subscribe(data.musicPlayer);
      data.musicPlayer.unpause();
      data.musicPausedForSfx = false;
    }
  };

  data.sfxPlayer.once(AudioPlayerStatus.Idle, onFinish);
  data.sfxPlayer.once('error', onError);
}

// ============================================================
// Comandos de controle
// ============================================================

function skip(message) {
  const data = guilds.get(message.guildId);
  if (!data || !data.currentSong) {
    message.reply('❌ Nenhuma música está tocando no momento.');
    return;
  }

  const skipped = data.currentSong.title;
  // stop() dispara o evento Idle → playNext() toca a próxima
  data.musicPlayer.stop();
  message.reply(`⏭️ Pulando: **${skipped}**`);
}

function stop(message) {
  const data = guilds.get(message.guildId);
  if (!data || (!data.currentSong && data.queue.length === 0)) {
    message.reply('❌ Nenhum áudio está tocando no momento.');
    return;
  }

  data.queue = [];
  data.currentSong = null;
  data.musicPausedForSfx = false;
  if (data.musicPlayer) data.musicPlayer.stop();
  if (data.sfxPlayer) data.sfxPlayer.stop();
  message.reply('⏹️ Áudio parado e fila limpa!');
}

function leave(message) {
  const data = guilds.get(message.guildId);
  if (!data || !data.connection) {
    message.reply('❌ Não estou em nenhum canal de voz.');
    return;
  }

  cleanup(message.guildId);
  message.reply('👋 Saí do canal de voz!');
}

function cleanup(guildId) {
  const data = guilds.get(guildId);
  if (!data) return;

  data.queue = [];
  data.currentSong = null;
  data.musicPausedForSfx = false;
  if (data.musicPlayer) data.musicPlayer.stop();
  if (data.sfxPlayer) data.sfxPlayer.stop();
  if (data.connection) {
    try {
      data.connection.destroy();
    } catch {}
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

module.exports = {
  addYouTube,
  addPlaylist,
  playSfx,
  skip,
  stop,
  leave,
  getQueue,
  ensureConnection,
};
