# BotDucz

Bot de Discord para reproduzir audio em canal de voz com suporte a:
- MyInstants (link ou busca por texto)
- YouTube (link, busca e playlist)
- SoundCloud (link e playlist)
- Spotify (track, playlist, album e artista, convertido para YouTube)

## Resumo rapido do que o bot faz

- Toca instant de MyInstants com comando rapido (+i)
- Toca musicas por busca ou link com foco em +p (play/tocar)
- Mantem fila de reproducao com navegacao por botoes
- Permite pular, parar, sair e ir para item especifico da fila
- Aplica efeitos de audio com intensidade (+efeito e +ef)
- Suporta favoritos compartilhados para buscas do +i (+fav)
- Reacoes no +i: 🦆 repetir, 📢 tocar mais alto (uma vez), ⭐ favoritar
- O status de favorito do mesmo +i reutiliza uma unica mensagem dinamica (salvo/removido)
- Megafones 📢 antigos de instants sao limpos ao iniciar ou encerrar o bot
- Mensagens de status de fila e "fila vazia" removidas automaticamente
- Tem comandos slash organizados no menu /

## Estrutura de codigo (didatica)

- index.js: roteamento principal de comandos e eventos do Discord
- src/musicQueue.js: fila, players, efeitos, controle de reproducao
- src/myinstants.js: busca e extracao de audio do MyInstants
- src/youtube.js: funcoes de YouTube e utilitarios de busca via yt-dlp
- src/soundcloud.js: ponto unico para funcoes SoundCloud
- src/spotify.js: ponto unico para funcoes Spotify
- src/config.js: loader central de configuracoes JSON com fallback seguro
- src/utils.js: utilitarios HTTP/download

## Configuracao por JSON (edicao facil)

Agora voce pode ajustar comportamento do bot sem editar codigo, usando:

- config/bot.json
- config/sources.json
- config/musicQueue.json

Principais opcoes configuraveis:

- Presenca do bot ocioso/tocando (+help e sufixo)
- Auto-leave padrao (quando nao usar AUTO_LEAVE_MINUTES no .env)
- Timeouts de botoes (help/fila/efeitos)
- Tamanho da pagina de +fila
- Frequencia de refresh da fila em tela
- Quantidade de favoritos exibidos no +fav
- Quantidade de sugestoes e timeout de selecao do +i
- Volume do megafone 📢 nos instants (sfx.megaphoneVolume, padrao 3.0)
- Limites de playlist YouTube/Spotify
- Batching e concorrencia de carregamento Spotify/SoundCloud
- Cooldown de navegacao e tamanho maximo de historico da fila

Importante:

- Os valores padrao ja estao iguais ao comportamento atual do bot.
- Se algum JSON estiver faltando ou invalido, o bot usa fallback interno sem quebrar.
- Depois de alterar um JSON, reinicie o bot para aplicar as mudancas.

## Biografia sugerida do bot (Discord)

Use este texto no perfil do bot no Discord Developer Portal:

"Reproduz audios do MyInstants, YouTube, SoundCloud e Spotify, com fila, efeitos e favoritos. Criado por Luam Ducate (github/luanducate), com colaboracao de Bryan Christen (github/bryan-christen)."

Observacao: a bio de perfil do bot e configurada no Portal do Discord, nao pelo codigo.

## Instalacao

1. Instale dependencias:

```bash
npm install
```

2. Crie o arquivo .env a partir do .env.example e configure:

```env
DISCORD_TOKEN=seu_token_aqui
AUTO_LEAVE_MINUTES=2
```

3. Inicie:

```bash
npm start
```

## Prefixos principais

- +p (principal para musica)
- +play
- +i
- +stop
- +skip
- +fav
- +fila
- +ef
- +help

Aliases legados ainda aceitos: +d e +Ducz.

## Comandos por prefixo

### Reproducao

- PT-BR:
  - +p <texto|link-youtube|link-soundcloud|link-spotify>
  - +tocar <texto|link>
  - +i <texto|link-myinstants> (instant)
- EN:
  - +play <text|link>
  - +i <text|myinstants-link>
- Reacoes no +i:
  - 🦆 repetir instant
  - 📢 tocar mais alto uma unica vez (volume em bot.json → sfx.megaphoneVolume)
  - ⭐ salvar/remover dos favoritos com uma unica mensagem de status por instant equivalente no canal

### Controle de fila

- Navegacao:
  - +fila
  - +queue
  - +fila <numero>
- Remocao por posicao:
  - +fila remove <numero>
  - +queue remove <numero>
  - +remove <numero>
  - +rm <numero>
- Remocao da musica atual:
  - +fila remove atual
  - +remove atual
  - +rm atual
- Controle rapido:
  - +skip / +pular
  - +stop / +parar
  - +sair / +leave

### Playlists salvas

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
- Botoes no +fila:
  - Tocar (#), Remover (#), Reiniciar, Loop Playlist
  - Atualizar Playlist, Apagar Playlist
  - Carregar salva (#/nome), Playlists salvas, Apagar salva (#/nome), Descartar

### Efeitos

- +efeito <nome> [1-10]
- +ef <nome> [1-10]
- +ef
- +ef <1-10>
- +ef status
- +ef off
- +ef lista

### Favoritos de instant

- Lista compartilhada por todos no servidor
- +fav
- +fav <numero>
- +fav remove <numero>

### Utilitarios

- +help
- +ajuda
- +prefix
- +prefix <valor>
- +prefix set <valor>
- +prefix reset
- +clear <1m|2h|1d>
- +killbot (apenas dono)

## Slash commands (/)

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

## Ajuda in-app

- +help abre painel de ajuda com botao "Fechar"
- /help abre o mesmo painel com botao "Fechar"
- +fila possui paginação e controles: Tocar (#), Remover (#), Reiniciar, Loop Playlist,
  Atualizar Playlist, Apagar Playlist, Carregar salva (#/nome), Playlists salvas,
  Apagar salva (#/nome), Descartar
- qualquer pessoa do canal pode interagir com os botoes de help/fila/efeitos

## Historico de modificacoes

### 2026-03-28 - playlists salvas, fila e UX de painel

- Novo: sistema de playlists salvas com suporte completo via +fila, +playlist e +pl
- Novo: carregar/apagar playlist salva por nome ou por numero da listagem
- Novo: botao no +fila para carregar salva por numero/nome (modal)
- Novo: salvar/atualizar playlist pelo painel +fila com estado de playlist ativa
- UX: reorganizacao dos botoes do painel +fila (reiniciar, loop, atualizar/apagar, carregar/listar/apagar salva, descartar)
- UX: remocao da musica atual movida para o painel "Tocando" (nao mais no +fila)
- Fix: restart da playlist respeitando estado da sessao e sem reintroduzir musica removida
- Docs: +help, README e DOCUMENTACAO atualizados com todos os fluxos novos
- Slash: adicionados /playlist e /remove, com suporte a referencia por nome ou numero

### v2.1.0 — 2026-03-20 (release atual)

- Fix: +skip apos +p agora funciona corretamente (await no deferred skip)
- UX: mensagem "⏳ carregando..." do skip adiado e removida automaticamente ao disparar
- UX: mensagens de status de fila ("adicionada a fila", "X faixas adicionadas") removidas quando a fila esvazia
- UX: mensagem "A fila esta vazia." removida ao iniciar nova musica ou novo +p
- Novo: ordem das reacoes do +i ajustada para 🦆/📢/⭐; o 📢 toca o instant mais alto uma unica vez e depois desaparece
- UX: megafones 📢 antigos de mensagens +i sao removidos automaticamente ao iniciar ou encerrar o bot
- UX: feedback de favorito do mesmo instant agora alterna dinamicamente entre salvo/removido em uma unica mensagem por consulta equivalente
- Config: bot.json → sfx.megaphoneVolume (volume do megafone, padrao 3.0)
- Doc: README e DOCUMENTACAO atualizados para v2.1.0

### v2.0.0 — 2026-03-19

Versao principal que transforma o bot de um reprodutor basico (MyInstants + YouTube)
numa plataforma completa de audio para Discord:

- Suporte a SoundCloud (faixas e playlists)
- Suporte a Spotify (track, playlist, album, artista)
- Fila de reproducao com botoes de navegacao, paginacao e "Tocar (#)"
- Controles de musica inline: ⏮️ anterior, ⏹️ parar, ⏭️ pular, 🔁 loop
- Efeitos de audio com intensidade (+ef / +efeito) e botao descartar
- Favoritos compartilhados para +i (lista unica do servidor)
- Help com botao "Fechar" (+help e /help)
- Slash command /instants dedicado ao MyInstants
- Presenca rotativa com bio do bot e creditos
- Auto-leave quando canal de voz fica vazio
- Qualquer usuario pode interagir com botoes (sem restricao de autor)
- Modularizacao: src/spotify.js e src/soundcloud.js
- Scripts de manutencao no package.json (dev, check, start:verbose)
- .gitignore expandido para commit limpo

### 2026-03-19 - Organizacao de ajuda, docs e slash

Etapa 1 - Ajuda/manual:
- painel de help revisado com comandos atualizados
- inclusao explicita do alias +ef em exemplos e orientacoes
- inclusao de botao "Fechar" no +help e /help

Etapa 2 - Slash commands:
- reorganizacao da listagem do menu /
- adicao do comando /instants para MyInstants direto
- textos de descricao ajustados para facilitar uso

Etapa 3 - Presenca/bio operacional:
- presenca rotativa quando o bot esta ocioso com resumo de funcionalidades
- linha de creditos em presenca: Luam Ducate e Bryan Christen

Etapa 4 - Documentacao:
- README reestruturado com guia pratico
- comandos separados por topicos
- secao de bio sugerida para o perfil do bot

Etapa 5 - Organizacao de codigo:
- criacao de src/spotify.js para centralizar funcoes de Spotify
- criacao de src/soundcloud.js para centralizar funcoes de SoundCloud
- index.js ficou mais limpo, mantendo o comportamento atual

### v1.0.0 — versao inicial (sem data consolidada)

- reproducao basica de MyInstants e YouTube
- suporte a playlists YouTube/SoundCloud/Spotify
- sistema de efeitos com intensidade
- favoritos por usuario para +i (migrado para compartilhado na v2.0.0)
- auto-leave quando canal de voz fica vazio

## Creditos

- Criado por Luam Ducate - github/luanducate
- Colaboracao principal: Bryan Christen - github/bryan-christen
