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
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================
// Configuração
// ============================================================
const PREFIX = '+Ducz';
const MYINSTANTS_REGEX = /https?:\/\/(www\.)?myinstants\.com\/(pt\/)?instant\/[\w\-]+\/?/i;

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
    lib.get(url, (res) => {
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
  // Padrão: href="/media/sounds/nome-do-som.mp3"
  const downloadMatch = html.match(/href=["'](\/media\/sounds\/[^"']+\.mp3)["']/i);
  if (downloadMatch) {
    return `https://www.myinstants.com${downloadMatch[1]}`;
  }

  // Método 2: Procurar no atributo onclick do botão
  // Padrão: play('/media/sounds/nome-do-som.mp3')
  const onclickMatch = html.match(/play\(['"]?(\/media\/sounds\/[^'")\s]+\.mp3)['"]?\)/i);
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
    const lib = mp3Url.startsWith('https') ? https : http;

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
 * Constrói o embed de ajuda do bot.
 */
function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎵 BotDucz — Ajuda')
    .setDescription('Toque sons do **MyInstants** diretamente no canal de voz!')
    .addFields(
      {
        name: '▶️ Tocar um som',
        value: '```\n+Ducz <link-do-myinstants>\n```\nExemplo:\n`+Ducz https://www.myinstants.com/pt/instant/briga-de-gato-25101/`',
      },
      {
        name: '⏹️ Parar o áudio',
        value: '```\n+Ducz parar\n```',
      },
      {
        name: '🚪 Sair do canal de voz',
        value: '```\n+Ducz sair\n```',
      },
      {
        name: '❓ Mostrar ajuda',
        value: '```\n+Ducz ajuda\n```',
      }
    )
    .setFooter({ text: 'BotDucz • Sons do MyInstants no Discord' });
}

// ============================================================
// Evento: Bot pronto
// ============================================================
client.once('ready', () => {
  console.log(`✅ BotDucz está online como ${client.user.tag}`);
  console.log(`📡 Conectado a ${client.guilds.cache.size} servidor(es)`);
  client.user.setActivity('+Ducz ajuda', { type: 2 }); // type 2 = "Listening"
});

// ============================================================
// Evento: Mensagem recebida
// ============================================================
client.on('messageCreate', async (message) => {
  // Ignorar mensagens de bots e sem o prefixo correto
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  // Extrair o argumento após o prefixo
  const args = message.content.slice(PREFIX.length).trim();

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
  // Comando: tocar link do MyInstants
  // --------------------------------------------------------
  const url = args.split(/\s+/)[0];

  if (!MYINSTANTS_REGEX.test(url)) {
    return message.reply(
      '❌ Link inválido! Use um link do **MyInstants**, por exemplo:\n' +
        '`+Ducz https://www.myinstants.com/pt/instant/briga-de-gato-25101/`\n\n' +
        'Digite `+Ducz ajuda` para ver todos os comandos.'
    );
  }

  // Verificar se o usuário está em um canal de voz
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    return message.reply('❌ Você precisa estar em um **canal de voz** para usar este comando!');
  }

  // Verificar permissões
  const permissions = voiceChannel.permissionsFor(message.guild.members.me);
  if (!permissions.has('Connect') || !permissions.has('Speak')) {
    return message.reply('❌ Não tenho permissão para **conectar** ou **falar** nesse canal de voz!');
  }

  try {
    // Indicar que está processando
    await message.react('🔄');

    // 1. Extrair URL do MP3
    const mp3Url = await extractMp3Url(url);
    console.log(`🎵 MP3 encontrado: ${mp3Url}`);

    // 2. Baixar o MP3 para arquivo temporário
    console.log('⬇️ Baixando MP3...');
    const tmpFile = await downloadMp3(mp3Url);
    console.log(`✅ MP3 baixado: ${tmpFile}`);

    // 3. Conectar ao canal de voz (ou reutilizar conexão existente)
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
    connection.on('stateChange', (oldState, newState) => {
      console.log(`  Conexão: ${oldState.status} → ${newState.status}`);
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      console.log('✅ Conexão de voz pronta!');
    } catch (err) {
      console.error('❌ Timeout na conexão de voz:', err.message);
      connection.destroy();
      guildPlayers.delete(message.guildId);
      fs.unlink(tmpFile, () => {});
      return message.reply('❌ Não consegui conectar ao canal de voz. Tente novamente.');
    }

    // 4. Criar player e resource a partir do arquivo baixado
    const player = createAudioPlayer();
    const resource = createAudioResource(tmpFile);

    // Parar player anterior se existir
    if (playerData && playerData.player) {
      playerData.player.stop();
    }

    // Registrar o player e a conexão
    guildPlayers.set(message.guildId, { player, connection });

    // Subscriber e tocar
    connection.subscribe(player);
    player.play(resource);

    // Remover reação de loading e adicionar ✅
    await message.reactions.removeAll().catch(() => {});
    await message.react('🎵');

    // Extrair nome do som do URL para exibir
    const soundName = url
      .replace(/\/$/, '')
      .split('/')
      .pop()
      .replace(/-/g, ' ')
      .replace(/\d+$/, '')
      .trim();

    message.reply(`🔊 Tocando: **${soundName || 'som'}**`);

    // Quando terminar de tocar
    player.on(AudioPlayerStatus.Idle, () => {
      console.log('🔇 Áudio finalizado.');
      // Limpar arquivo temporário
      fs.unlink(tmpFile, () => {});
    });

    // Tratamento de erros do player
    player.on('error', (error) => {
      console.error('❌ Erro no player:', error.message);
      console.error('   Stack:', error.stack);
      fs.unlink(tmpFile, () => {});
      message.reply('❌ Ocorreu um erro ao reproduzir o áudio.');
    });

    // Desconectar se a conexão for fechada
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Parece estar reconectando
      } catch {
        // Desconectou de verdade
        connection.destroy();
        guildPlayers.delete(message.guildId);
      }
    });
  } catch (error) {
    console.error('❌ Erro:', error.message);
    await message.reactions.removeAll().catch(() => {});
    await message.react('❌');
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
