//oi
require('dotenv').config();

// Configurar o FFmpeg bundled ANTES de importar @discordjs/voice
const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { extractMp3Url, searchMyInstants } = require('./src/myinstants');
const { downloadMp3 } = require('./src/utils');
const { getYouTubeTitle, getPlaylistVideos, isPlaylistUrl } = require('./src/youtube');
const {
  addYouTube,
  addPlaylist,
  playSfx,
  skip,
  stop,
  leave,
  getQueue,
} = require('./src/musicQueue');

// ============================================================
// Configuração
// ============================================================
const PREFIXES = ['+Ducz', '+d'];
const MYINSTANTS_REGEX = /https?:\/\/(www\.)?myinstants\.com\/(pt\/)?instant\/[\w\-]+\/?/i;
const YOUTUBE_REGEX = /https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/i;

// ============================================================
// Cliente Discord
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

// ============================================================
// Embed de ajuda
// ============================================================
function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎵 BotDucz — Ajuda')
    .setDescription(
      'Toque sons do **MyInstants** e **YouTube** diretamente no canal de voz!\n\n💡 Use `+Ducz` ou `+d` como prefixo.'
    )
    .addFields(
      {
        name: '▶️ Tocar um som do MyInstants (link)',
        value:
          '```\n+d <link-do-myinstants>\n```\nExemplo: `+d https://www.myinstants.com/pt/instant/briga-de-gato-25101/`',
      },
      {
        name: '🔍 Buscar e tocar um som do MyInstants',
        value:
          '```\n+d <descrição do som>\n```\nExemplo: `+d briga de gato`\n💡 *Sons do MyInstants tocam instantaneamente, mesmo com música do YouTube!*',
      },
      {
        name: '🎬 Tocar áudio do YouTube (link)',
        value:
          '```\n+d <link-do-youtube>\n```\nExemplo: `+d https://www.youtube.com/watch?v=dQw4w9WgXcQ`',
      },
      {
        name: '🔎 Buscar e tocar do YouTube',
        value:
          '```\n+d yt <nome da música>\n```\nExemplo: `+d yt nirvana smells like teen spirit`',
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
        name: '🚪 Sair do canal de voz',
        value: '```\n+d sair\n```',
      },
      {
        name: '❓ Mostrar ajuda',
        value: '```\n+d ajuda\n```',
      }
    )
    .setFooter({ text: 'BotDucz • Sons do MyInstants e YouTube no Discord' });
}

// ============================================================
// Evento: Bot pronto
// ============================================================
client.once('ready', () => {
  console.log(`✅ BotDucz está online como ${client.user.tag}`);
  console.log(`📡 Conectado a ${client.guilds.cache.size} servidor(es)`);
  client.user.setActivity('+d ajuda', { type: 2 });
});

// ============================================================
// Evento: Mensagem recebida
// ============================================================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Verificar prefixo
  let usedPrefix = null;
  for (const p of PREFIXES) {
    if (message.content.toLowerCase().startsWith(p.toLowerCase())) {
      const nextChar = message.content[p.length];
      if (p.toLowerCase() === '+d' && nextChar && /[a-zA-Z]/.test(nextChar)) continue;
      usedPrefix = p;
      break;
    }
  }
  if (!usedPrefix) return;

  const args = message.content.slice(usedPrefix.length).trim();
  if (!args) return message.reply({ embeds: [buildHelpEmbed()] });

  // ---- Comandos simples ----
  const cmd = args.toLowerCase();
  if (cmd === 'ajuda') return message.reply({ embeds: [buildHelpEmbed()] });
  if (cmd === 'parar') return stop(message);
  if (cmd === 'sair') return leave(message);
  if (cmd === 'skip' || cmd === 'pular') return skip(message);

  if (cmd === 'fila' || cmd === 'queue') {
    const { current, queue } = getQueue(message.guildId);
    if (!current && queue.length === 0) {
      return message.reply('📋 A fila está vazia.');
    }
    let text = '';
    if (current) text += `🎶 **Tocando agora:** ${current.title}\n\n`;
    if (queue.length > 0) {
      text += '📋 **Fila:**\n';
      const maxShow = 10;
      queue.slice(0, maxShow).forEach((song, i) => {
        text += `**${i + 1}.** ${song.title}\n`;
      });
      if (queue.length > maxShow) {
        text += `\n...e mais ${queue.length - maxShow} música(s)`;
      }
    }
    return message.reply(text);
  }

  // ---- Detectar tipo de input ----
  const input = args.split(/\s+/)[0];

  try {
    // Link do MyInstants → toca instantaneamente (SFX)
    if (MYINSTANTS_REGEX.test(input)) {
      await message.react('🔄');
      const mp3Url = await extractMp3Url(input);
      const tmpFile = await downloadMp3(mp3Url);
      const soundName = input
        .replace(/\/$/, '')
        .split('/')
        .pop()
        .replace(/-/g, ' ')
        .replace(/\d+$/, '')
        .trim();
      await playSfx(message, tmpFile, soundName);
      return;
    }

    // Link do YouTube (com ou sem playlist)
    if (YOUTUBE_REGEX.test(input)) {
      await message.react('🔄');
      if (isPlaylistUrl(input)) {
        await message.channel.send('📋 Carregando playlist... aguarde.');
        const videos = await getPlaylistVideos(input);
        if (videos.length === 0) {
          await message.reactions.removeAll().catch(() => {});
          return message.reply('❌ Não foi possível carregar a playlist.');
        }
        await message.reactions.removeAll().catch(() => {});
        await message.react('🎶');
        await addPlaylist(message, videos);
      } else {
        const title = await getYouTubeTitle(input);
        await message.reactions.removeAll().catch(() => {});
        await message.react('🎶');
        await addYouTube(message, input, title);
      }
      return;
    }

    // Busca no YouTube com "yt <query>"
    if (input.toLowerCase() === 'yt') {
      const ytQuery = args.slice(2).trim();
      if (!ytQuery) {
        return message.reply('❌ Digite o nome da música! Exemplo: `+d yt nirvana`');
      }
      await message.react('🔍');
      const searchUrl = `ytsearch1:${ytQuery}`;
      const title = await getYouTubeTitle(searchUrl);
      await message.reactions.removeAll().catch(() => {});
      await message.react('🎶');
      await addYouTube(message, searchUrl, title);
      return;
    }

    // Busca por texto no MyInstants (padrão) → toca instantaneamente (SFX)
    await message.react('🔍');
    const searchQuery = args;
    const result = await searchMyInstants(searchQuery);

    if (!result) {
      await message.reactions.removeAll().catch(() => {});
      await message.react('❌');
      return message.reply(`❌ Nenhum som encontrado para: **${searchQuery}**`);
    }

    let mp3Url;
    if (result.mp3Url) {
      mp3Url = result.mp3Url;
    } else {
      mp3Url = await extractMp3Url(result.pageUrl);
    }

    const tmpFile = await downloadMp3(mp3Url);
    await playSfx(message, tmpFile, result.title);
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
// Login
// ============================================================
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN não encontrado! Crie um arquivo .env com o token do bot.');
  console.error('   Copie o arquivo .env.example para .env e preencha com seu token.');
  process.exit(1);
}

client.login(token);
