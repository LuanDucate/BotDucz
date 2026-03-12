# 📖 Documentação Técnica — BotDucz

## Visão Geral

O **BotDucz** é um bot para Discord que reproduz áudios do site [MyInstants](https://www.myinstants.com) diretamente em canais de voz. Os usuários enviam um link de um som do MyInstants com o prefixo `+Ducz` e o bot extrai o MP3, conecta ao canal de voz e reproduz o áudio.

## Arquitetura

```
Usuário envia mensagem → Bot recebe a mensagem
        ↓
Verifica se tem o prefixo "+Ducz"
        ↓
Identifica o comando (link / parar / sair / ajuda)
        ↓
Se for um link do MyInstants:
    1. Faz requisição HTTP para a página
    2. Extrai a URL do MP3 via scraping do HTML
    3. Conecta ao canal de voz do usuário
    4. Faz stream do MP3 e reproduz via @discordjs/voice
```

## Tecnologias

| Tecnologia | Versão | Uso |
|---|---|---|
| Node.js | 18+ | Runtime JavaScript |
| discord.js | v14 | Comunicação com a API do Discord |
| @discordjs/voice | v0.18 | Conexão e reprodução em canais de voz |
| @discordjs/opus | v0.9 | Codificação de áudio Opus |
| sodium-native | v4 | Criptografia para conexão de voz |
| FFmpeg | - | Processamento/transcodificação de áudio |
| dotenv | v16 | Gerenciamento de variáveis de ambiente |

## Estrutura do Projeto

```
BotDucz/
├── index.js          # Código principal do bot
├── package.json      # Dependências e scripts
├── .env              # Token do bot (não versionado)
├── .env.example      # Modelo do arquivo .env
├── .gitignore        # Arquivos ignorados pelo git
├── DOCUMENTACAO.md   # Este documento
├── COMO_USAR.md      # Guia de uso
└── CriacaoBotDiscord.md  # Requisitos originais
```

## Como Funciona

### 1. Extração do MP3

O bot faz uma requisição HTTP GET para a página do MyInstants (ex: `https://www.myinstants.com/pt/instant/briga-de-gato-25101/`), recebe o HTML e busca pela URL do MP3 usando expressões regulares. Os padrões buscados são:

1. **Link de download**: `href="/media/sounds/nome.mp3"`
2. **Botão de play**: `play('/media/sounds/nome.mp3')`
3. **Referência genérica**: qualquer ocorrência de `/media/sounds/*.mp3`

### 2. Reprodução de Áudio

Após obter a URL do MP3, o bot:
1. Verifica se o usuário está em um canal de voz
2. Conecta ao canal usando `joinVoiceChannel()`
3. Cria um `AudioPlayer` e um `AudioResource` a partir do stream HTTP do MP3
4. Subscreve o player na conexão e inicia a reprodução

### 3. Gerenciamento de Estado

O bot mantém um `Map` (`guildPlayers`) que armazena o player e a conexão de voz ativa por servidor (guild). Isso permite controlar a reprodução (parar) e a conexão (sair) por servidor independentemente.

### 4. Intents do Discord

O bot utiliza as seguintes intents:
- `Guilds` — informações sobre servidores
- `GuildMessages` — receber mensagens
- `GuildVoiceStates` — informações sobre canais de voz
- `MessageContent` — ler o conteúdo das mensagens (requer ativação no Portal do Discord)
