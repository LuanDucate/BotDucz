# Documentacao Tecnica - BotDucz

## 1. Objetivo

O BotDucz e um bot de audio para Discord focado em:
- MyInstants (SFX por busca/link)
- YouTube (busca/link/playlist)
- SoundCloud (link/playlist)
- Spotify (track/playlist/album/artista convertido para YouTube)

Tambem inclui:
- fila com navegacao por botao
- efeitos com intensidade
- favoritos compartilhados para pesquisa de instant
- comandos por prefixo e slash commands

## 2. Stack e dependencias

- Node.js 18+
- discord.js v14
- @discordjs/voice
- ffmpeg-static
- yt-dlp (via processo externo)
- opusscript
- dotenv

## 3. Fluxo geral de comandos

1. Usuario envia comando (prefixo ou slash)
2. index.js identifica tipo de comando
3. Roteia para:
- handleInstantsQuery (MyInstants)
- handlePlayQuery (YouTube/SoundCloud/Spotify)
- comandos de fila, efeitos, prefixo, limpeza, ajuda
4. src/musicQueue.js gerencia estado por guild:
- conexao de voz
- players
- fila e musica atual
- efeito/intensidade
- mensagens de now playing

## 4. Comandos por categoria

### 4.1 Prefixo - reproducao

- PT-BR:
  - +p <texto|link>
  - +tocar <texto|link>
  - +i <texto|link-myinstants> (instant)
- EN:
  - +play <text|link>
  - +i <text|myinstants-link>
- Reacoes no +i:
  - 🦆 repetir instant
  - 📢 tocar mais alto uma unica vez (volume em bot.json → sfx.megaphoneVolume)
  - ⭐ salvar/remover dos favoritos compartilhados com uma unica mensagem de status por instant equivalente no canal
- Alias legado aceito: +d / +Ducz

### 4.2 Prefixo - fila/controle

- Navegacao:
  - +fila
  - +queue
  - +fila <n>
- Remocao por posicao:
  - +fila remove <n>
  - +queue remove <n>
  - +remove <n>
  - +rm <n>
- Remocao da musica atual:
  - +fila remove atual
  - +remove atual
  - +rm atual
- Controle rapido:
  - +skip / +pular
  - +stop / +parar
  - +sair / +leave

### 4.3 Prefixo - playlists salvas

- PT-BR:
  - +fila listar
  - +fila salvar <nome>
  - +fila carregar <nome|numero>
  - +fila atualizar <nome>
  - +fila apagar <nome|numero>
- EN:
  - +fila list
  - +fila save <name>
  - +fila load <name|number>
  - +fila update <name>
  - +fila delete <name|number>
- Atalhos:
  - +playlist <acao> <referencia>
  - +pl <acao> <referencia>

### 4.4 Prefixo - efeitos

- +efeito <nome> [1-10]
- +ef <nome> [1-10]
- +ef
- +ef status
- +ef off
- +ef lista

### 4.5 Prefixo - favoritos

- Lista compartilhada por todos no servidor
- +fav
- +fav <numero>
- +fav remove <numero>

### 4.6 Prefixo - utilitarios

- +help
- +ajuda
- +prefix
- +prefix <novo_prefixo>
- +prefix set <novo_prefixo>
- +prefix reset
- +clear <1m|2h|1d>
- +killbot (owner)

### 4.7 Slash commands (/)

- Midia:
  - /play query:<texto|link>
  - /instants query:<texto|link-myinstants>
- Fila e playlist:
  - /queue [posicao]
  - /remove alvo:<atual|posicao> [posicao]
  - /playlist acao:<listar|salvar|carregar|atualizar|apagar> [referencia]
- Controle:
  - /skip
  - /stop
  - /leave
- Ajustes:
  - /effect acao:<ativar|off|status|lista> [nome] [intensidade]
  - /prefix acao:<view|set|reset> [valor]
- Utilitarios:
  - /help
  - /killbot

## 5. Ajuda no Discord

Painel de ajuda:
- +help
- /help

Comportamento:
- painel de ajuda com embed atualizado
- botao "Fechar" para remover a mensagem de ajuda
- painel +fila com controles de playlist: Loop Playlist, Atualizar Playlist, Apagar Playlist,
  Carregar salva (#/nome), Playlists salvas, Apagar salva (#/nome), Descartar
- qualquer usuario pode interagir e fechar

## 6. Presenca e resumo operacional (bio visivel)

Quando nao ha musica tocando:
- presenca exibe apenas +help

Quando ha musica tocando:
- presenca exibe titulo atual + "| +help"

## 7. Perfil/Biografia do bot

Importante:
- a bio oficial do bot no perfil e configurada no Discord Developer Portal
- essa bio nao e alterada pela API do bot em runtime

Texto recomendado:
"Reproduz audios do MyInstants, YouTube, SoundCloud e Spotify, com fila, efeitos e favoritos. Criado por Luam Ducate (github/luanducate), com colaboracao de Bryan Christen (github/bryan-christen)."

## 8. Arquivos principais

- index.js: parsing de comando, help, slash, interacoes, presenca
- src/musicQueue.js: fila, tocador, efeitos, now playing, botoes de controle
- src/myinstants.js: scraping de busca e extracao de mp3
- src/youtube.js: resolucao de midia YouTube e utilitarios de busca
- src/soundcloud.js: interface de funcoes SoundCloud
- src/spotify.js: funcoes de extracao/normalizacao para Spotify
- src/config.js: leitura e merge de configuracoes JSON com fallback
- src/utils.js: download/fetch utilitarios
- config/bot.json: presenca, UI, timeouts, sfx (megaphoneVolume), prefixes padrao
- config/sources.json: limites de YouTube/Spotify/SoundCloud e concorrencia
- config/musicQueue.json: historico, cooldowns e parametros internos da fila
- favorites.json: armazenamento de favoritos compartilhados

## 9. Historico de modificacoes (organizado por data)

### 2026-03-28 - playlists salvas, fila e slash

- Playlists salvas com fluxo completo em +fila, +playlist e +pl
- Carregar e apagar playlist por nome ou numero da listagem
- Botao de carregar salva (#/nome) no painel +fila com modal
- Ajustes de layout no painel +fila (reiniciar, loop, atualizar/apagar, carregar/listar/apagar salva, descartar)
- Remocao da musica atual movida para o painel de "Tocando"
- Correcao do restart para respeitar estado real da playlist/sessao sem ressuscitar removidas
- +help atualizado com os novos fluxos e botoes
- Slash commands atualizados com /playlist e /remove

### v2.1.0 — 2026-03-20 (release atual)

Fix e UX:
- Fix: +skip apos +p agora funciona corretamente (await adicionado em todos os retornos async de handlePlayQuery)
- UX: deferredSkipRequests agora armazena referencia da mensagem ⏳ e a remove ao disparar ou cancelar o skip
- UX: mensagens "adicionada a fila" e "X faixas adicionadas" rastreadas em queueStatusMessages e limpas quando a fila esvazia
- UX: mensagem "A fila esta vazia." rastreada em emptyQueueMessages e removida ao iniciar nova musica, novo +p ou novo +fila
- UX: prefixos transientes incluem '📋 A fila esta vazia.' (limpeza no startup)
- UX: feedback de favorito do mesmo instant e consolidado em uma unica mensagem dinamica por consulta equivalente no canal

Novo recurso - Megafone nos instants:
- Ordem das reacoes do +i ajustada para 🦆/📢/⭐ via setupSfxRepeat
- Um clique: toca o instant com volume multiplicado (padrao 3.0x)
- Apos uso: reacao e removida permanentemente da mensagem (megaphoneUsed flag)
- Megafones 📢 antigos em mensagens de +i sao removidos no startup e no shutdown do bot
- playSfx agora aceita volumeMultiplier (usa inlineVolume quando != 1.0)
- Configuravel em config/bot.json → sfx.megaphoneVolume

Documentacao:
- README e DOCUMENTACAO atualizados
- buildHelpEmbed() expandido com descricao das reacoes 🦆/📢/⭐ e do feedback dinamico de favoritos

### v2.0.0 — 2026-03-19

Release que consolida a evolucao completa do bot:
- SoundCloud: faixas e playlists via yt-dlp streaming
- Spotify: track, playlist, album e artista (resolucao para YouTube)
- Fila paginada com botoes, modal "Tocar (#)" e refresh automatico
- Controles inline de musica (botoes: anterior, parar, pular, loop)
- Efeitos (+ef) com botao descartar e alias completo
- Favoritos compartilhados (lista unica por servidor, migracao automatica)
- Help com botao "Fechar" e embed atualizado
- Slash /instants, /help, /queue e demais organizados
- Presenca rotativa ociosa com creditos
- Auto-leave configuravel via AUTO_LEAVE_MINUTES
- Interacoes abertas: qualquer usuario pode usar botoes/modais
- Modularizacao: src/spotify.js e src/soundcloud.js extraidos de index.js

### 2026-03-19

Topico A - Ajuda e UX:
- +help e /help com botao "Fechar"
- embed de help revisado e ampliado
- informacoes de +ef reforcadas no help e respostas do comando

Topico B - Slash e organizacao:
- adicao de /instants
- reorganizacao da listagem de slash commands

Topico C - Presenca e resumo:
- resumo rotativo em presenca ociosa
- creditos de autoria e colaboracao adicionados

Topico D - Documentacao:
- README refeito com manual pratico
- DOCUMENTACAO.md revisado por topicos

Topico E - Refatoracao de estrutura:
- remocao de restricao de usuario para botoes de interacao
- extracao de helpers Spotify para src/spotify.js
- extracao de helpers SoundCloud para src/soundcloud.js

### v1.0.0 — versao inicial (sem data consolidada)

- reproducao basica de MyInstants e YouTube
- playlists YouTube/SoundCloud/Spotify
- efeitos com intensidade
- favoritos por usuario (migrado para compartilhado na v2.0.0)
- auto-leave em canal vazio

## 10. Creditos

- Criado por Luam Ducate - github/luanducate
- Colaboracao principal: Bryan Christen - github/bryan-christen
