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

- +i <texto|link-myinstants>
- +d <texto|link>
- +play <texto|link>

### 4.2 Prefixo - fila/controle

- +fila
- +fila <n>
- +skip
- +stop
- +d sair

### 4.3 Prefixo - efeitos

- +efeito <nome> [1-10]
- +ef <nome> [1-10]
- +ef
- +ef status
- +ef off
- +ef lista

### 4.4 Prefixo - favoritos

- Lista compartilhada por todos no servidor
- +fav
- +fav <numero>
- +fav remove <numero>

### 4.5 Prefixo - utilitarios

- +help
- +d ajuda
- +d prefix [add|remove|reset]
- +clear <1m|2h|1d>
- +killbot (owner)

### 4.6 Slash commands (/)

- /play query:<texto|link>
- /instants query:<texto|link-myinstants>
- /queue [posicao]
- /skip
- /stop
- /effect acao:<ativar|off|status|lista> [nome] [intensidade]
- /prefix acao:<view|add|remove|reset> [valor]
- /leave
- /help
- /killbot

## 5. Ajuda no Discord

Painel de ajuda:
- +help
- /help

Comportamento:
- painel de ajuda com embed atualizado
- botao "Fechar" para remover a mensagem de ajuda
- qualquer usuario pode interagir e fechar

## 6. Presenca e resumo operacional (bio visivel)

Quando nao ha musica tocando, o bot alterna linhas de presenca com:
- fontes suportadas (MyInstants/YouTube/SoundCloud/Spotify)
- recursos (fila, +ef, favoritos)
- creditos (Luam Ducate e Bryan Christen)

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
- src/utils.js: download/fetch utilitarios
- favorites.json: armazenamento de favoritos compartilhados

## 9. Historico de modificacoes (organizado por data)

### v2.0.0 — 2026-03-19 (release atual)

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
