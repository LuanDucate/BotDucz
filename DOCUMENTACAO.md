# 📖 Documentação Técnica — BotDucz

## Visão Geral

O **BotDucz** é um bot para Discord que reproduz áudios do site [MyInstants](https://www.myinstants.com) e do **YouTube** diretamente em canais de voz. Os usuários podem:
- Enviar um **link do MyInstants** para tocar o som
- **Buscar por texto** (ex: `+Ducz monark`) e o bot encontra e toca o som mais relevante
- Enviar um **link do YouTube** para tocar o áudio do vídeo

## Arquitetura

```
Usuário envia mensagem → Bot recebe a mensagem
        ↓
Verifica se tem o prefixo "+Ducz"
        ↓
Identifica o tipo de input:
        ↓
┌─ Comandos (ajuda / parar / sair)
│
├─ Link do MyInstants:
│   1. Faz requisição HTTP para a página
│   2. Extrai a URL do MP3 via scraping do HTML
│   3. Baixa o MP3 temporariamente
│   4. Conecta ao canal de voz e reproduz
│
├─ Link do YouTube:
│   1. Usa play-dl para obter stream de áudio
│   2. Conecta ao canal de voz e reproduz
│
└─ Texto (busca):
    1. Faz scraping da busca do MyInstants
    2. Pega o primeiro resultado
    3. Extrai o MP3 e reproduz
```

## Tecnologias

| Tecnologia | Versão | Uso |
|---|---|---|
| Node.js | 18+ | Runtime JavaScript |
| discord.js | v14 | Comunicação com a API do Discord |
| @discordjs/voice | v0.19 | Conexão e reprodução em canais de voz |
| play-dl | v1.9 | Stream de áudio do YouTube |
| ffmpeg-static | v5 | FFmpeg bundled para processamento de áudio |
| opusscript | v0.1 | Codificação de áudio Opus |
| dotenv | v16 | Gerenciamento de variáveis de ambiente |

## Como Funciona

### 1. Extração do MP3 (MyInstants)

O bot faz uma requisição HTTP GET para a página do MyInstants (ex: `https://www.myinstants.com/pt/instant/briga-de-gato-25101/`), recebe o HTML e busca pela URL do MP3 usando expressões regulares. Os padrões buscados são:

1. **Link de download**: `href="/media/sounds/nome.mp3"`
2. **Botão de play**: `play('/media/sounds/nome.mp3')`
3. **Referência genérica**: qualquer ocorrência de `/media/sounds/*.mp3`

### 2. Busca por Texto (MyInstants)

Quando o usuário digita texto em vez de um link, o bot:
1. Faz GET em `https://www.myinstants.com/pt/search/?name=<query>`
2. Faz scraping do HTML para encontrar links de instants nos resultados
3. Pega o primeiro resultado e extrai o MP3 da página correspondente

### 3. Stream do YouTube

Quando o usuário envia um link do YouTube, o bot:
1. Usa a biblioteca `play-dl` para obter o stream de áudio
2. Cria um `AudioResource` diretamente do stream (sem baixar arquivo)
3. Obtém o título do vídeo para exibir ao usuário

### 4. Reprodução de Áudio

A função `connectToVoice()` gerencia a conexão com o canal de voz de forma reutilizável:
1. Verifica se o usuário está em um canal de voz
2. Conecta ao canal usando `joinVoiceChannel()`
3. Cria um `AudioPlayer` e subscreve na conexão

### 5. Gerenciamento de Estado

O bot mantém um `Map` (`guildPlayers`) que armazena o player e a conexão de voz ativa por servidor (guild). Isso permite controlar a reprodução (parar) e a conexão (sair) por servidor independentemente.

### 4. Intents do Discord

O bot utiliza as seguintes intents:
- `Guilds` — informações sobre servidores
- `GuildMessages` — receber mensagens
- `GuildVoiceStates` — informações sobre canais de voz
- `MessageContent` — ler o conteúdo das mensagens (requer ativação no Portal do Discord)
