# Referencia Completa de Configuracao (JSON)

Este documento explica cada parametro dos arquivos:

- bot.json
- sources.json
- musicQueue.json

Importante:

- JSON puro nao suporta comentarios de linha.
- Por isso, as explicacoes ficam neste arquivo.
- Depois de alterar qualquer JSON, reinicie o bot.

## 1) bot.json

### 1.1 presence

#### presence.idleText
- Tipo: string
- Padrao: +help
- O que faz: texto exibido no status do bot quando nao ha musica tocando.
- Exemplo: "Digite +help"

#### presence.playingSuffix
- Tipo: string
- Padrao: | +help
- O que faz: sufixo anexado ao titulo da musica no status enquanto toca.
- Resultado final: Titulo da musica + sufixo

#### presence.maxActivityLength
- Tipo: numero inteiro
- Padrao: 128
- O que faz: limita tamanho maximo do texto de status para evitar corte/problemas da API.
- Dica: mantenha em 128.

#### presence.status
- Tipo: string
- Padrao: online
- O que faz: define status do usuario do bot.
- Valores comuns: online, idle, dnd

### 1.2 autoLeave

#### autoLeave.defaultMinutes
- Tipo: numero
- Padrao: 2
- O que faz: tempo padrao (em minutos) para auto-leave quando o bot fica sozinho.
- Observacao: se AUTO_LEAVE_MINUTES estiver no .env, o .env tem prioridade.

### 1.3 ui

#### ui.dismissTimeoutMs
- Tipo: numero (milissegundos)
- Padrao: 300000
- O que faz: tempo para expirar mensagens com botoes descartaveis (help/fila/efeitos).

#### ui.queueRefreshIntervalMs
- Tipo: numero (milissegundos)
- Padrao: 4000
- O que faz: frequencia de atualizacao automatica da mensagem de fila.
- Menor valor: atualiza mais rapido, aumenta carga.

#### ui.queuePageSize
- Tipo: numero inteiro
- Padrao: 8
- O que faz: quantas musicas mostrar por pagina no +fila.

#### ui.favoritesPreviewLimit
- Tipo: numero inteiro
- Padrao: 20
- O que faz: quantidade maxima de favoritos exibidos no comando +fav (listagem).

#### ui.myInstantsSuggestionButtons
- Tipo: numero inteiro
- Padrao: 4 (perfil diario)
- O que faz: quantidade de botoes/sugestoes quando a busca de +i nao encontra exato.
- Dica: manter entre 3 e 5.

#### ui.myInstantsSearchPerTerm
- Tipo: numero inteiro
- Padrao: 5
- O que faz: quantidade de resultados por termo em buscas de sugestao de +i.
- Maior valor: mais chances de achar algo, mais requisicoes.

#### ui.myInstantsSelectionTimeoutMs
- Tipo: numero (milissegundos)
- Padrao: 60000
- O que faz: tempo para o menu de selecao do +i expirar.

#### ui.clearBulkDeleteAgeDays
- Tipo: numero inteiro
- Padrao: 14
- O que faz: janela de dias para deletar em lote no comando +clear.
- Nota tecnica: 14 dias e limite da API para bulk delete.

#### ui.soundCloudProgressScanLimit
- Tipo: numero inteiro
- Padrao: 30
- O que faz: quantas mensagens recentes o bot varre para limpar progresso antigo de SoundCloud.

### 1.4 commands

#### commands.defaultPrefixes
- Tipo: array de strings
- Padrao: lista atual de prefixos do bot
- O que faz: define prefixos padrao aceitos no servidor.
- Dica: nao remova +help e +d sem necessidade.

## 2) sources.json

### 2.1 resolution

#### resolution.maxItems
- Tipo: numero inteiro
- Padrao: 40 (perfil diario)
- O que faz: limite de itens para resolver em lote para YouTube.

#### resolution.concurrency
- Tipo: numero inteiro
- Padrao: 6 (perfil diario)
- O que faz: quantas resolucoes paralelas de busca podem rodar ao mesmo tempo.
- Maior valor: mais rapido, mais carga/rede.

### 2.2 youtube

#### youtube.playlistMaxVideos
- Tipo: numero inteiro
- Padrao: 80 (perfil diario)
- O que faz: maximo de videos puxados de playlist do YouTube.

#### youtube.artistSearchResults
- Tipo: numero inteiro
- Padrao: 18 (perfil diario)
- O que faz: quantidade de resultados quando link de artista Spotify vira busca no YouTube.

### 2.3 spotify

#### spotify.collectionMaxTracks
- Tipo: numero inteiro
- Padrao: 400 (perfil diario)
- O que faz: limite de faixas lidas de playlist/album do Spotify.

#### spotify.initialBatchSize
- Tipo: numero inteiro
- Padrao: 1
- O que faz: quantas faixas entram no primeiro lote para iniciar tocando rapido.

#### spotify.batchSize
- Tipo: numero inteiro
- Padrao: 12 (perfil diario)
- O que faz: tamanho dos lotes seguintes apos o primeiro.

#### spotify.initialResolveConcurrency
- Tipo: numero inteiro
- Padrao: 1
- O que faz: concorrencia no primeiro lote (normalmente menor para priorizar estabilidade).

#### spotify.batchResolveConcurrency
- Tipo: numero inteiro
- Padrao: 10 (perfil diario)
- O que faz: concorrencia dos lotes seguintes de Spotify para YouTube.

### 2.4 soundcloud

#### soundcloud.resolveConcurrency
- Tipo: numero inteiro
- Padrao: 2
- O que faz: quantas faixas SoundCloud o bot tenta resolver em paralelo.

#### soundcloud.firstBatchSize
- Tipo: numero inteiro
- Padrao: 1
- O que faz: tamanho do primeiro lote para comecar a tocar rapidamente.

#### soundcloud.batchSize
- Tipo: numero inteiro
- Padrao: 6 (perfil diario)
- O que faz: tamanho dos lotes seguintes de playlist SoundCloud.

#### soundcloud.finalStatusDeleteDelayMs
- Tipo: numero (milissegundos)
- Padrao: 5000
- O que faz: tempo para apagar a mensagem final de progresso SoundCloud.

## 3) musicQueue.json

#### defaultEffectIntensity
- Tipo: numero inteiro (1-10)
- Padrao: 5
- O que faz: intensidade inicial padrao de efeitos que suportam intensidade.

#### cleanupOldStreamDelayMs
- Tipo: numero (milissegundos)
- Padrao: 250
- O que faz: atraso para finalizar processos antigos de stream ao trocar musica.
- Menor valor: troca mais agressiva; maior valor: mais conservador.

#### maxHistoryItems
- Tipo: numero inteiro
- Padrao: 120 (perfil diario)
- O que faz: tamanho maximo do historico usado pelo botao de voltar musica.

#### navCooldownMs
- Tipo: numero (milissegundos)
- Padrao: 300 (perfil diario)
- O que faz: tempo minimo entre comandos de navegacao (skip/previous/jump) para evitar spam.

#### voiceReconnectWaitMs
- Tipo: numero (milissegundos)
- Padrao: 5000
- O que faz: tempo de espera para tentativa de reconexao de voz antes de limpar sessao.

#### ipDiscoveryLogCooldownMs
- Tipo: numero (milissegundos)
- Padrao: 30000
- O que faz: intervalo minimo entre logs repetidos de erro de IP discovery.
- Serve para nao poluir logs.

## 4) Faixas recomendadas para ajuste

- queueRefreshIntervalMs: 2000 a 8000
- playlistMaxVideos: 30 a 200
- collectionMaxTracks: 100 a 1000
- batchResolveConcurrency (Spotify): 6 a 20
- resolveConcurrency (SoundCloud): 1 a 4
- navCooldownMs: 250 a 700

## 5) Regra de seguranca

Se algum valor ficar exagerado (concorrencia/lotes muito altos), o bot pode:

- usar mais CPU e RAM
- aumentar risco de timeout/restricao de rede
- ficar menos estavel em servidor VPS pequeno

Se isso acontecer, volte para preset daily ou low-resource.
