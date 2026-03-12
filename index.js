require('dotenv').config();

// Configurar o FFmpeg bundled ANTES de importar @discordjs/voice
const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const { spawn, execSync } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

// Armazena os players por guild para controle de reprodução
const guildPlayers = new Map();

// ============================================================
// Funções auxiliares
// ============================================================

/**
 * Faz uma requisição HTTP/HTTPS e retorna o corpo da resposta como string.
 * Segue redirecionamentos automaticamente.
 */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    }, (res) => {
      // Seguir redirecionamentos
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Erro HTTP ${res.statusCode} ao acessar ${url}`));
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Extrai a URL direta do MP3 a partir de uma página do MyInstants.
 * Procura pelo link "Baixar MP3" ou "Download MP3" no HTML da página.
 */
async function extractMp3Url(pageUrl) {
  const html = await fetchUrl(pageUrl);

  // Método 1: Procurar o link de download direto no HTML
  const downloadMatch = html.match(/href=["'](\/media\/sounds\/[^"']+\.mp3)["']/i);
  if (downloadMatch) {
    return `https://www.myinstants.com${downloadMatch[1]}`;
  }

  // Método 2: Procurar no atributo onclick do botão
  const onclickMatch = html.match(/play\(['"]?(\/media\/sounds\/[^'")\\s]+\.mp3)['"]?\)/i);
  if (onclickMatch) {
    return `https://www.myinstants.com${onclickMatch[1]}`;
  }

  // Método 3: Procurar qualquer referência a /media/sounds/*.mp3
  const genericMatch = html.match(/(\/media\/sounds\/[^\s"'<>]+\.mp3)/i);
  if (genericMatch) {
    return `https://www.myinstants.com${genericMatch[1]}`;
  }

  throw new Error('Não foi possível encontrar o arquivo MP3 nesta página.');
}

/**
 * Baixa o arquivo MP3 para um arquivo temporário.
 * Retorna o caminho do arquivo temporário.
 */
function downloadMp3(mp3Url) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `botducz_${Date.now()}.mp3`);

    function doDownload(downloadUrl) {
      const dl = downloadUrl.startsWith('https') ? https : http;
      dl.get(downloadUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doDownload(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Erro HTTP ${res.statusCode} ao baixar o áudio`));
        }
        const fileStream = fs.createWriteStream(tmpFile);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve(tmpFile);
        });
        fileStream.on('error', (err) => {
          fs.unlink(tmpFile, () => {});
          reject(err);
        });
      }).on('error', reject);
    }

    doDownload(mp3Url);
  });
}

/**
 * Busca um som no MyInstants por texto.
 * Retorna um objeto { title, pageUrl } do primeiro resultado, ou null se não encontrar.
 */
async function searchMyInstants(query) {
  const searchUrl = `https://www.myinstants.com/pt/search/?name=${encodeURIComponent(query)}`;
  console.log(`🔍 Buscando no MyInstants: ${searchUrl}`);
  const html = await fetchUrl(searchUrl);

  // Procurar links de instants nos resultados da busca
  // Padrão: <a href="/pt/instant/nome-do-som-12345/" ...> ou onclick com play
  // Os resultados aparecem como botões com links para as páginas dos instants
  const resultPattern = /href=["'](\/pt\/instant\/[\w\-]+\/)["'][^>]*>([^<]*)/gi;
  const results = [];
  let match;

  while ((match = resultPattern.exec(html)) !== null) {
    const instantPath = match[1];
    const title = match[2].trim();
    // Evitar duplicatas
    if (!results.find(r => r.pageUrl === `https://www.myinstants.com${instantPath}`)) {
      results.push({
        title: title || instantPath.split('/').filter(Boolean).pop().replace(/-/g, ' '),
        pageUrl: `https://www.myinstants.com${instantPath}`,
      });
    }
  }

  // Fallback: procurar por onclick do botão que tem o MP3 direto
  if (results.length === 0) {
    const onclickPattern = /onclick=["']play\(['"]?(\/media\/sounds\/[^'")\s]+\.mp3)['"]?\)["']/gi;
    let onclickMatch;
    while ((onclickMatch = onclickPattern.exec(html)) !== null) {
      const mp3Path = onclickMatch[1];
      const soundName = mp3Path.split('/').pop().replace('.mp3', '').replace(/-/g, ' ').replace(/_/g, ' ');
      results.push({
        title: soundName,
        mp3Url: `https://www.myinstants.com${mp3Path}`,
      });
    }
  }

  if (results.length === 0) {
    return null;
  }

  console.log(`✅ Encontrados ${results.length} resultado(s). Primeiro: "${results[0].title}"`);
  return results[0];
}

/**
 * Conecta ao canal de voz (ou reutiliza conexão existente).
 * Retorna { connection, player }.
 */
async function connectToVoice(message) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    throw new Error('VOICE_NOT_CONNECTED');
  }

  const permissions = voiceChannel.permissionsFor(message.guild.members.me);
  if (!permissions.has('Connect') || !permissions.has('Speak')) {
    throw new Error('VOICE_NO_PERMISSION');
  }

  let playerData = guildPlayers.get(message.guildId);
  let connection;

  if (playerData && playerData.connection) {
    connection = playerData.connection;
    // Se o canal mudou, reconectar
    if (connection.joinConfig.channelId !== voiceChannel.id) {
      connection.destroy();
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
    }
  } else {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guildId,
      adapterCreator: message.guild.voiceAdapterCreator,
    });
  }

  // Aguardar a conexão ficar pronta
  console.log('🔗 Aguardando conexão de voz ficar pronta...');

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    console.log('✅ Conexão de voz pronta!');
  } catch (err) {
    console.error('❌ Timeout na conexão de voz:', err.message);
    connection.destroy();
    guildPlayers.delete(message.guildId);
    throw new Error('VOICE_TIMEOUT');
  }

  // Criar player
  const player = createAudioPlayer();

  // Parar player anterior se existir
  if (playerData && playerData.player) {
    playerData.player.stop();
  }

  // Registrar o player e a conexão
  guildPlayers.set(message.guildId, { player, connection });

  // Subscriber
  connection.subscribe(player);

  // Desconectar se a conexão for fechada (usar once para evitar memory leak)
  connection.removeAllListeners(VoiceConnectionStatus.Disconnected);
  connection.once(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      guildPlayers.delete(message.guildId);
    }
  });

  return { connection, player };
}

/**
 * Toca um áudio de arquivo temporário local no canal de voz.
 */
async function playLocalFile(message, tmpFile, displayName) {
  const { player } = await connectToVoice(message);

  const resource = createAudioResource(tmpFile);
  player.play(resource);

  // Remover reação de loading e adicionar 🎵
  await message.reactions.removeAll().catch(() => {});
  await message.react('<:petler:1437632444999270481>');

  message.reply(`🔊 Tocando: **${displayName || 'som'}**`);

  // Quando terminar de tocar (once para evitar memory leak)
  player.once(AudioPlayerStatus.Idle, () => {
    console.log('🔇 Áudio finalizado.');
    fs.unlink(tmpFile, () => {});
  });

  // Tratamento de erros do player
  player.once('error', (error) => {
    console.error('❌ Erro no player:', error.message);
    console.error('   Stack:', error.stack);
    fs.unlink(tmpFile, () => {});
    message.reply('❌ Ocorreu um erro ao reproduzir o áudio.');
  });
}

/**
 * Obtém o título do vídeo do YouTube via yt-dlp.
 */
function getYouTubeTitle(url) {
  return new Promise((resolve) => {
    try {
      const proc = spawn('yt-dlp', ['--get-title', '--no-warnings', '--no-playlist', url]);
      let title = '';
      proc.stdout.on('data', (data) => (title += data.toString()));
      proc.on('close', (code) => {
        resolve(code === 0 && title.trim() ? title.trim() : 'vídeo do YouTube');
      });
      proc.on('error', () => resolve('vídeo do YouTube'));
    } catch {
      resolve('vídeo do YouTube');
    }
  });
}

/**
 * Toca um áudio do YouTube no canal de voz usando yt-dlp.
 */
async function playYouTube(message, url) {
  const { player } = await connectToVoice(message);

  console.log(`🎬 Obtendo stream do YouTube via yt-dlp: ${url}`);

  // Obter título do vídeo em paralelo
  const titlePromise = getYouTubeTitle(url);

  // Iniciar stream de áudio via yt-dlp
  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestaudio/best', // fallback para 'best' se 'bestaudio' não existir
    '-o', '-',
    '--quiet',
    '--no-warnings',
    '--no-playlist',
    '--extractor-args', 'youtube:player_client=android', // android client costuma ter menos 403
    url,
  ]);

  // Tratar erros do processo yt-dlp
  let ytdlpError = '';
  ytdlp.stderr.on('data', (data) => {
    ytdlpError += data.toString();
    console.error('yt-dlp stderr:', data.toString().trim());
  });

  ytdlp.on('error', (error) => {
    console.error('❌ yt-dlp não encontrado:', error.message);
    message.reply('❌ **yt-dlp** não está instalado! Instale com:\n```\nwinget install yt-dlp\n```');
  });

  const resource = createAudioResource(ytdlp.stdout, {
    inputType: StreamType.Arbitrary,
  });

  player.play(resource);

  const videoTitle = await titlePromise;

  // Remover reação de loading e adicionar 🎶
  await message.reactions.removeAll().catch(() => {});
  await message.react('🎶');

  message.reply(`🔊 Tocando do YouTube: **${videoTitle}**`);

  // Quando terminar de tocar (once para evitar memory leak)
  player.once(AudioPlayerStatus.Idle, () => {
    console.log('🔇 Áudio do YouTube finalizado.');
  });

  // Tratamento de erros do player
  player.once('error', (error) => {
    console.error('❌ Erro no player (YouTube):', error.message);
    console.error('   Stack:', error.stack);
    message.reply('❌ Ocorreu um erro ao reproduzir o áudio do YouTube.');
  });
}

/**
 * Constrói o embed de ajuda do bot.
 */
function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎵 BotDucz — Ajuda')
    .setDescription('Toque sons do **MyInstants** e **YouTube** diretamente no canal de voz!\n\n💡 Use `+Ducz` ou `+d` como prefixo.')
    .addFields(
      {
        name: '▶️ Tocar um som do MyInstants (link)',
        value: '```\n+d <link-do-myinstants>\n```\nExemplo: `+d https://www.myinstants.com/pt/instant/briga-de-gato-25101/`',
      },
      {
        name: '🔍 Buscar e tocar um som do MyInstants',
        value: '```\n+d <descrição do som>\n```\nExemplo: `+d briga de gato`',
      },
      {
        name: '🎬 Tocar áudio do YouTube (link)',
        value: '```\n+d <link-do-youtube>\n```\nExemplo: `+d https://www.youtube.com/watch?v=dQw4w9WgXcQ`',
      },
      {
        name: '🔎 Buscar e tocar do YouTube',
        value: '```\n+d yt <nome da música>\n```\nExemplo: `+d yt nirvana smells like teen spirit`',
      },
      {
        name: '⏹️ Parar o áudio',
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
  client.user.setActivity('+d ajuda', { type: 2 }); // type 2 = "Listening"
});

// ============================================================
// Evento: Mensagem recebida
// ============================================================
client.on('messageCreate', async (message) => {
  // Ignorar mensagens de bots
  if (message.author.bot) return;

  // Verificar qual prefixo foi usado (+Ducz ou +d)
  let usedPrefix = null;
  for (const p of PREFIXES) {
    if (message.content.toLowerCase().startsWith(p.toLowerCase())) {
      // Garantir que +d não captura +Ducz (verificar se o próximo char não é letra)
      const nextChar = message.content[p.length];
      if (p.toLowerCase() === '+d' && nextChar && /[a-zA-Z]/.test(nextChar)) continue;
      usedPrefix = p;
      break;
    }
  }
  if (!usedPrefix) return;

  // Extrair o argumento após o prefixo
  const args = message.content.slice(usedPrefix.length).trim();

  // Sem argumentos = mostrar ajuda
  if (!args) {
    return message.reply({ embeds: [buildHelpEmbed()] });
  }

  // --------------------------------------------------------
  // Comando: ajuda
  // --------------------------------------------------------
  if (args.toLowerCase() === 'ajuda') {
    return message.reply({ embeds: [buildHelpEmbed()] });
  }

  // --------------------------------------------------------
  // Comando: parar
  // --------------------------------------------------------
  if (args.toLowerCase() === 'parar') {
    const playerData = guildPlayers.get(message.guildId);
    if (playerData && playerData.player) {
      playerData.player.stop();
      return message.reply('⏹️ Áudio parado!');
    }
    return message.reply('❌ Nenhum áudio está tocando no momento.');
  }

  // --------------------------------------------------------
  // Comando: sair
  // --------------------------------------------------------
  if (args.toLowerCase() === 'sair') {
    const playerData = guildPlayers.get(message.guildId);
    if (playerData) {
      if (playerData.player) playerData.player.stop();
      if (playerData.connection) playerData.connection.destroy();
      guildPlayers.delete(message.guildId);
      return message.reply('👋 Saí do canal de voz!');
    }
    return message.reply('❌ Não estou em nenhum canal de voz.');
  }

  // --------------------------------------------------------
  // Detectar tipo de input
  // --------------------------------------------------------
  const input = args.split(/\s+/)[0];

  try {
    // --------------------------------------------------------
    // Caso 1: Link do MyInstants
    // --------------------------------------------------------
    if (MYINSTANTS_REGEX.test(input)) {
      await message.react('🔄');

      const mp3Url = await extractMp3Url(input);
      console.log(`🎵 MP3 encontrado: ${mp3Url}`);

      console.log('⬇️ Baixando MP3...');
      const tmpFile = await downloadMp3(mp3Url);
      console.log(`✅ MP3 baixado: ${tmpFile}`);

      const soundName = input
        .replace(/\/$/, '')
        .split('/')
        .pop()
        .replace(/-/g, ' ')
        .replace(/\d+$/, '')
        .trim();

      await playLocalFile(message, tmpFile, soundName);
      return;
    }

    // --------------------------------------------------------
    // Caso 2: Link do YouTube
    // --------------------------------------------------------
    if (YOUTUBE_REGEX.test(input)) {
      await message.react('🔄');
      await playYouTube(message, input);
      return;
    }

    // --------------------------------------------------------
    // Caso 3: Busca no YouTube com "yt <query>"
    // --------------------------------------------------------
    if (input.toLowerCase() === 'yt') {
      const ytQuery = args.slice(2).trim(); // remover "yt" do início
      if (!ytQuery) {
        return message.reply('❌ Digite o nome da música! Exemplo: `+d yt nirvana`');
      }
      await message.react('🔍');
      // Usar yt-dlp com ytsearch para buscar e tocar o primeiro resultado
      await playYouTube(message, `ytsearch1:${ytQuery}`);
      return;
    }

    // --------------------------------------------------------
    // Caso 3: Busca por texto no MyInstants
    // --------------------------------------------------------
    await message.react('🔍');

    const searchQuery = args; // usar todo o texto, não apenas a primeira palavra
    const result = await searchMyInstants(searchQuery);

    if (!result) {
      await message.reactions.removeAll().catch(() => {});
      await message.react('❌');
      return message.reply(`❌ Nenhum som encontrado para: **${searchQuery}**`);
    }

    // Se o resultado já tem a URL do MP3 direto (do fallback onclick)
    if (result.mp3Url) {
      console.log(`🎵 MP3 direto encontrado: ${result.mp3Url}`);
      const tmpFile = await downloadMp3(result.mp3Url);
      await playLocalFile(message, tmpFile, result.title);
      return;
    }

    // Caso contrário, extrair o MP3 da página do resultado
    console.log(`🎵 Acessando página: ${result.pageUrl}`);
    const mp3Url = await extractMp3Url(result.pageUrl);
    console.log(`🎵 MP3 encontrado: ${mp3Url}`);

    const tmpFile = await downloadMp3(mp3Url);
    console.log(`✅ MP3 baixado: ${tmpFile}`);

    await playLocalFile(message, tmpFile, result.title);
  } catch (error) {
    console.error('❌ Erro:', error.message);
    await message.reactions.removeAll().catch(() => {});
    await message.react('❌');

    if (error.message === 'VOICE_NOT_CONNECTED') {
      return message.reply('❌ Você precisa estar em um **canal de voz** para usar este comando!');
    }
    if (error.message === 'VOICE_NO_PERMISSION') {
      return message.reply('❌ Não tenho permissão para **conectar** ou **falar** nesse canal de voz!');
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
