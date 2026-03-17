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
const { getYouTubeTitle, getPlaylistVideos, isPlaylistUrl } = require('./src/youtube');
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
} = require('./src/musicQueue');

// Evita rodar duas instâncias na mesma máquina (cria um lock file)
const lockFilePath = path.join(__dirname, 'bot.lock');

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
      killProcess(pid);
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
        const blockRegex = new RegExp(`ProcessId=${pid}[\s\S]*?CommandLine=(.*?)(?:\r?\n\r?\n|$)`, 'i');
        const m = output.match(blockRegex);
        const cmd = m ? (m[1] || '') : '';
        if (cmd.includes('index.js')) {
          killProcess(pid);
        }
      }
    } catch {
      // ignore se wmic não estiver disponível / falhar
    }
  }

  fs.writeFileSync(lockFilePath, String(currentPid), 'utf-8');

  const cleanup = () => {
    try {
      if (fs.existsSync(lockFilePath)) fs.unlinkSync(lockFilePath);
    } catch {}
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('uncaughtException', (err) => {
    // EPIPE e EOF podem acontecer ao trocar streams (ffmpeg/yt-dlp) rapidamente.
    // Não queremos encerrar o bot por isso.
    if (err && (err.code === 'EPIPE' || err.code === 'EOF')) {
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

// Prefixos padrão (inclui +p, +play, +skip, +stop, +i, +efeito e +fila/+queue)
const DEFAULT_PREFIXES = ['+Ducz', '+d', '+p', '+play', '+skip', '+stop', '+i', '+fav', '+efeito', '+efeitos', '+effect', '+fila', '+queue', '+help'];

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
let favoritesByUser = {};

function loadFavorites() {
  try {
    const raw = fs.readFileSync(favoritesFilePath, 'utf-8');
    favoritesByUser = JSON.parse(raw || '{}');
  } catch {
    favoritesByUser = {};
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
  return favoritesByUser[userId] || [];
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
  if (!favoritesByUser[userId]) favoritesByUser[userId] = [];
  favoritesByUser[userId].push(fav);
  saveFavorites();
  return favoritesByUser[userId].length;
}

function removeFavorite(userId, index) {
  const favs = getFavorites(userId);
  if (index < 0 || index >= favs.length) return false;
  favs.splice(index, 1);
  favoritesByUser[userId] = favs;
  saveFavorites();
  return true;
}

loadFavorites();

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
// Valor: { userId, timeoutId }
const pendingQueueMessages = new Map();
function cleanupPendingSfxRepeat(messageId) {
  const entry = pendingSfxRepeats.get(messageId);
  if (!entry) return;

  if (entry.collector) {
    try {
      entry.collector.stop();
    } catch {}
  }
  pendingSfxRepeats.delete(messageId);
}

function setupSfxRepeat(message, mp3Url, displayName, favoriteQuery = null) {
  if (!message || !mp3Url || typeof message.createReactionCollector !== 'function') return;

  cleanupPendingSfxRepeat(message.id);

  // Adiciona reação de pato para permitir repetir.
  message.react('🦆').catch(() => {});
  // Adiciona estrela para favoritar rapidamente a busca feita em +i.
  message.react('⭐').catch(() => {});

  const filter = (reaction, user) => {
    if (!reaction || !user) return false;
    // Ignora reações do próprio bot
    if (user.id === message.client?.user?.id) return false;
    return reaction.emoji.name === '🦆' || reaction.emoji.name === '⭐';
  };

  const collector = message.createReactionCollector({ filter });
  collector.on('collect', async (reaction, user) => {
    // Remover reação do usuário para permitir novos cliques
    reaction.users.remove(user.id).catch(() => {});

    const entry = pendingSfxRepeats.get(message.id);
    if (!entry) return;

    if (reaction.emoji.name === '⭐') {
      // Favorita para o autor do comando +i; evita usuários terceiros salvarem por acidente.
      if (user.id !== entry.userId) return;

      const favQuery = entry.favoriteQuery || entry.displayName;
      const result = addFavoriteQuery(user.id, favQuery);
      if (result.added) {
        await message.reply(`⭐ Favorito salvo (#${result.index}): **${favQuery}**`).catch(() => {});
      } else if (result.duplicate) {
        await message.reply(`ℹ️ Esse favorito já existe na sua lista (#${result.index}).`).catch(() => {});
      }
      return;
    }

    // Repetir o som
    try {
      const tmpFile = await downloadMp3(entry.mp3Url);
      await playSfx(message, tmpFile, entry.displayName);
    } catch (err) {
      console.error('❌ Erro ao repetir som:', err);
    }
  });

  collector.on('end', () => {
    pendingSfxRepeats.delete(message.id);
  });

  pendingSfxRepeats.set(message.id, {
    mp3Url,
    displayName,
    favoriteQuery,
    userId: message.author?.id,
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
  const { current, queue } = getQueue(message.guildId);
  if (!current && queue.length === 0) {
    return message.reply('📋 A fila está vazia.');
  }

  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(queue.length / pageSize));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);

  let text = '';
  if (current) text += `🎶 **Tocando agora:** ${current.title}\n\n`;
  if (queue.length > 0) {
    text += '📋 **Fila:**\n';
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
        .setCustomId(`queue_prev_${message.author.id}_${normalizedPage - 1}`)
        .setLabel('Anterior')
        .setStyle(ButtonStyle.Primary)
    );
  }

  if (queue.length > (normalizedPage + 1) * pageSize) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_next_${message.author.id}_${normalizedPage + 1}`)
        .setLabel('Próxima')
        .setStyle(ButtonStyle.Primary)
    );
  }

  // Botão para abrir modal de tocar por número
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_play_${message.author.id}`)
      .setLabel('Tocar (#)')
      .setStyle(ButtonStyle.Success)
  );

  // Botão para descartar a mensagem
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_dismiss_${message.author.id}`)
      .setLabel('Descartar')
      .setStyle(ButtonStyle.Secondary)
  );

  components.push(row);

  const reply = existingMessage
    ? await existingMessage.edit({ content: text, components })
    : await message.reply({ content: text, components });

  if (!reply) return;

  const timeoutId = setTimeout(() => {
    pendingQueueMessages.delete(reply.id);
  }, 5 * 60 * 1000);

  pendingQueueMessages.set(reply.id, {
    userId: message.author.id,
    timeoutId,
    page: normalizedPage,
  });
}

async function jumpToQueue(message, position) {
  const success = jumpTo(message.guildId, position);
  if (!success) {
    return message.reply('❌ Número inválido ou fila vazia. Use `+fila` para ver as músicas.');
  }
  return message.reply(`▶️ Indo para a música #${position} da fila...`);
}

// ============================================================
// Embed de ajuda
// ============================================================
function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎵 BotDucz — +help')
    .setDescription(
      'Toque sons do **MyInstants** e **YouTube** no canal de voz com fila, efeitos e controles rápidos.'
    )
    .addFields(
      {
        name: '▶️ Tocar um som do MyInstants (link)',
        value:
          '```\n+d <link-do-myinstants>\n```\nExemplo: `+i https://www.myinstants.com/pt/instant/briga-de-gato-25101/`',
      },
      {
        name: '🔍 Buscar e tocar um som do MyInstants',
        value:
          '```\n+i <descrição do som>\n```\nExemplo: `+i briga de gato`\n💡 *Sons do MyInstants tocam instantaneamente, mesmo com música do YouTube!*',
      },
      {
        name: '🎬 Tocar áudio do YouTube (link)',
        value:
          '```\n+d <link-do-youtube>\n```\nExemplo: `+d https://www.youtube.com/watch?v=dQw4w9WgXcQ`',
      },
      {
        name: '🔎 Buscar e tocar do YouTube',
        value:
          '```\n+d <nome da música>\n```\nExemplo: `+d nirvana smells like teen spirit`',
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
          '```\n+efeito <nome> [1-10]\n+efeito <1-10>\n+efeito status\n+efeito off\n+efeito lista\n+efeitos\n```\nEx: `+efeito robot 8`, `+efeito 6`',
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
          '```\n/play query:<texto|link>\n/skip\n/stop\n/queue [posicao]\n/effect acao:<ativar|off|status|lista> [nome] [intensidade]\n/prefix acao:<view|add|remove|reset> [valor]\n/leave\n/killbot\n/help\n```',
      },
      {
        name: '🚪 Sair do canal de voz',
        value: '```\n+d sair\n```',
      },
      {
        name: '❓ Mostrar ajuda',
        value: '```\n+help\n+d ajuda\n```',
      }
    )
    .setFooter({ text: 'BotDucz • Sons do MyInstants e YouTube no Discord' });
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

    await playSfx(message, tmpFile, soundName);
    setupSfxRepeat(message, mp3Url, soundName, input);
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
  await playSfx(message, tmpFile, result.title);
  setupSfxRepeat(message, mp3Url, result.title, query);
  return;
}

async function handlePlayQuery(message, query) {
  const input = query.split(/\s+/)[0];

  try {
    // Se for link do YouTube (vídeo ou playlist)
    if (YOUTUBE_REGEX.test(input)) {
      if (isPlaylistUrl(input)) {
        console.log('📋 Carregando playlist...');

        // Se a primeira tentativa falhar (lista vazia), tenta novamente uma vez.
        let videos = await getPlaylistVideos(input);
        if (!videos || videos.length === 0) {
          console.log('⚠️ Falha ao carregar playlist, tentando novamente...');
          videos = await getPlaylistVideos(input);
        }

        if (!videos || videos.length === 0) {
          console.log('❌ Não foi possível carregar a playlist.');
          return;
        }

        return addPlaylist(message, videos);
      }

      const title = await getYouTubeTitle(input);
      return addYouTube(message, input, title);
    }

    // Busca no YouTube por termo (padrão)
    const searchUrl = `ytsearch1:${query}`;
    const title = await getYouTubeTitle(searchUrl);
    return addYouTube(message, searchUrl, title);
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
    description: 'Toca um som do MyInstants ou do YouTube',
    options: [
      {
        name: 'query',
        type: 3, // STRING
        description: 'Link ou texto para pesquisar',
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
  { name: 'killbot', description: 'Encerra a instância do bot (dono somente)' },
  { name: 'help', description: 'Mostra a ajuda do bot' },
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
  client.user.setActivity('+help', { type: 2 });
  loadPrefixes();
  registerSlashCommands();
}

client.once('clientReady', onClientReady);

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
      const requiresSpace = ['+p', '+play', '+d', '+i', '+fav', '+efeito', '+efeitos', '+effect'].includes(lower);
      if (requiresSpace && nextChar && !/\s/.test(nextChar)) continue;
      usedPrefix = p;
      break;
    }
  }
  if (!usedPrefix) return;

  // Suporte a comandos como +skip / +stop sem precisar do +d
  const normalizedPrefix = usedPrefix.toLowerCase();
  if (normalizedPrefix === '+skip') return skip(message);
  if (normalizedPrefix === '+stop') return stop(message);
  if (normalizedPrefix === '+help') return message.reply({ embeds: [buildHelpEmbed()] });

  if (normalizedPrefix === '+fav') {
    const raw = message.content.slice(usedPrefix.length).trim();
    const favs = getFavorites(message.author.id);

    if (!raw) {
      if (!favs.length) {
        return message.reply('⭐ Você ainda não tem favoritos. Use `+i <texto>` e clique na reação ⭐ para salvar.');
      }

      const lines = favs.slice(0, 20).map((f, i) => {
        const q = typeof f === 'string' ? f : f.query;
        return `**${i + 1}.** ${q}`;
      });

      return message.reply(
        `⭐ **Seus favoritos**\n${lines.join('\n')}\n\n` +
          'Use `+fav <número>` para tocar um favorito.\n' +
          'Use `+fav remove <número>` para remover.'
      );
    }

    const removeMatch = raw.match(/^(remove|rm|del)\s+(\d+)$/i);
    if (removeMatch) {
      const index = Number(removeMatch[2]);
      const ok = removeFavorite(message.author.id, index - 1);
      return message.reply(ok ? `✅ Favorito #${index} removido.` : '❌ Número inválido.');
    }

    if (/^\d+$/.test(raw)) {
      const index = Number(raw);
      const fav = getFavoriteEntryByIndex(message.author.id, index);
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
      return jumpToQueue(message, target);
    }
    return showQueueMessage(message);
  }

  if (normalizedPrefix === '+efeito' || normalizedPrefix === '+efeitos' || normalizedPrefix === '+effect') {
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
      return message.reply(
        `🎸 Efeitos disponíveis:\n${listWithDescriptions}\n\n` +
        `Intensidade 1-10: ${intensityList.join(', ')}\n` +
        `Use \`+efeito <nome> [1-10]\` para ativar com intensidade (quando suportado).\n` +
        `Use \`+efeito lista\` para ver esta lista novamente.\n` +
        `Efeito ativo: **${currentEffect || 'nenhum'}** | Intensidade: **${currentIntensity}/10**`
      );
    }

    if (parts[0] === 'lista' || parts[0] === 'list') {
      return message.reply(
        `🎛️ **Lista de efeitos**\n${listWithDescriptions}\n\n` +
        `Comando: \`+efeito <nome> [1-10]\``
      );
    }

    // Só um número: muda intensidade do efeito atual
    const firstNum = parseInt(parts[0], 10);
    const isOnlyNumberToken = /^\d+$/.test(parts[0]);
    if (parts.length === 1 && isOnlyNumberToken && !isNaN(firstNum) && firstNum >= 1 && firstNum <= 10) {
      if (!currentEffect) {
        return message.reply('ℹ️ Nenhum efeito ativo. Ative um efeito primeiro com `+efeito <nome>`.');
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
      return message.reply(`❌ Efeito desconhecido. Use um dos: ${list.join(', ')}\nDica: \`+efeito <nome> <1-10>\` escolhe a intensidade.`);
    }

    if (intensity !== null && effectSupportsIntensity(effect)) {
      setEffectIntensity(message.guildId, intensity);
    }

    // Mesmo efeito ativo sem nova intensidade = sem mudança
    if (currentEffect === effect && intensity === null) {
      return message.reply(`ℹ️ O efeito **${effect}** já está ativo (intensidade ${currentIntensity}/10). Use \`+efeito ${effect} <1-10>\` para mudar a intensidade.`);
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
  if (!args) return message.reply({ embeds: [buildHelpEmbed()] });

  // +i = pesquisa MyInstants
  if (normalizedPrefix === '+i') {
    return handleInstantsQuery(message, args);
  }

  // ---- Comandos simples ----
  const argsParts = args.split(/\s+/);
  const cmd = argsParts[0].toLowerCase();

  if (cmd === 'ajuda') return message.reply({ embeds: [buildHelpEmbed()] });
  if (cmd === 'parar' || cmd === 'stop')
    return stop(message, (text) => sendEphemeralMessage(message, text));
  if (cmd === 'sair') return leave(message);
  if (cmd === 'skip' || cmd === 'pular')
    return skip(message, (text) => sendEphemeralMessage(message, text));
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
      return handlePlayQuery(msg, query);
    }

    if (cmd === 'skip') {
      return skip(msg, (text) => msg.reply({ content: text, ephemeral: true }));
    }

    if (cmd === 'stop') {
      return stop(msg, (text) => msg.reply({ content: text, ephemeral: true }));
    }

    if (cmd === 'queue') {
      const targetPos = interaction.options.getInteger('posicao');
      if (targetPos && targetPos >= 1) {
        return jumpToQueue(msg, targetPos);
      }

      const { current, queue } = getQueue(msg.guildId);
      if (!current && queue.length === 0) {
        return msg.reply('📋 A fila está vazia.');
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
      return msg.reply(text);
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
        return msg.reply(`🎛️ **Lista de efeitos**\n${txt}\n\nUse: /effect acao:ativar nome:<efeito> intensidade:<1-10>`);
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
      return leave(msg);
    }

    if (cmd === 'killbot') {
      if (!isOwner(interaction.user.id)) {
        return interaction.reply({ content: '❌ Apenas o dono pode usar +killbot.', ephemeral: true });
      }
      await interaction.reply({ content: '🛑 Comando killbot recebido. Encerrando instância...', ephemeral: true });
      await shutdownBot();
    }

    if (cmd === 'help') {
      return msg.reply({ embeds: [buildHelpEmbed()] });
    }

    return interaction.reply({ content: 'Comando não reconhecido.', ephemeral: true });
  }

  // ============================================================
  // Modal submit (tocar por número)
  if (interaction.isModalSubmit()) {
    if (!interaction.customId.startsWith('queue_play_modal_')) return;

    const userId = interaction.customId.split('_')[3];
    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '🔒 Somente quem abriu o modal pode usar este botão.', ephemeral: true });
    }

    const positionValue = interaction.fields.getTextInputValue('queuePosition');
    const position = Number(positionValue);
    if (Number.isNaN(position) || position < 1) {
      return interaction.reply({ content: '❌ Número inválido. Use um número válido da fila.', ephemeral: true });
    }

    return jumpToQueue(interaction, position);
  }

  // Interações (botões)
  // ============================================================
  if (!interaction.isButton()) return;

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
      await playSfx(entry.originMessage, tmpFile, choice.title);
      setupSfxRepeat(entry.originMessage, mp3Url, choice.title, entry.searchQuery || choice.title);
    } catch (err) {
      console.error('❌ Erro ao tocar escolha:', err);
      interaction.followUp({ content: '❌ Não foi possível tocar esse som.', ephemeral: true });
    }

    return;
  }

  if (interaction.customId.startsWith('queue_dismiss_')) {
    const userId = interaction.customId.split('_')[2];
    const entry = pendingQueueMessages.get(interaction.message.id);
    if (!entry || entry.userId !== userId) {
      return interaction.reply({ content: '🔒 Somente quem pediu pode descartar.', ephemeral: true });
    }

    pendingQueueMessages.delete(interaction.message.id);
    if (entry.timeoutId) clearTimeout(entry.timeoutId);

    return interaction.message.delete().catch(() => {});
  }

  if (interaction.customId.startsWith('queue_prev_') || interaction.customId.startsWith('queue_next_')) {
    const parts = interaction.customId.split('_');
    const userId = parts[2];
    const nextPage = Number(parts[3]);
    const entry = pendingQueueMessages.get(interaction.message.id);
    if (!entry || entry.userId !== userId) {
      return interaction.reply({ content: '🔒 Somente quem pediu pode ver mais.', ephemeral: true });
    }

    // Atualiza a mensagem com a próxima página
    await showQueueMessage(interaction.message, nextPage, interaction.message);
    return interaction.deferUpdate();
  }

  if (interaction.customId.startsWith('queue_play_')) {
    const userId = interaction.customId.split('_')[2];
    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '🔒 Somente quem pediu pode usar isso.', ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId(`queue_play_modal_${interaction.user.id}`)
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
