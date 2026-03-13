# BotDucz

Um bot para Discord que reproduz áudios do site [MyInstants](https://www.myinstants.com) e do **YouTube** diretamente em canais de voz.

## Funcionalidades

- **Reprodução de áudios do MyInstants**: Envie um link direto ou busque por texto (ex: `+Ducz briga de gato`) para tocar o som mais relevante.
- **Reprodução de áudios do YouTube**: Envie um link do YouTube para tocar o áudio do vídeo.
- **Comandos básicos**: `+Ducz ajuda`, `+Ducz parar`, `+Ducz sair`.
- **Gerenciamento de fila**: Suporte para fila de músicas (veja `src/musicQueue.js`).

# 🎵 Como Usar o BotDucz

## Pré-requisitos

1. **Node.js** versão 18 ou superior — [Baixar aqui](https://nodejs.org/)
2. **FFmpeg** — necessário para processamento de áudio

### Instalar o FFmpeg no Windows

Opção 1 — Via **winget** (mais fácil):
```bash
winget install Gyan.FFmpeg
```

Opção 2 — Via **Chocolatey**:
```bash
choco install ffmpeg
```

Opção 3 — Manual:
1. Baixe em https://ffmpeg.org/download.html
2. Extraia e adicione a pasta `bin` ao PATH do sistema

> **Verifique a instalação:** abra o terminal e digite `ffmpeg -version`

---

## Configurar o Bot no Discord

### 1. Criar o Bot

1. Acesse o [Discord Developer Portal](https://discord.com/developers/applications)
2. Clique em **"New Application"** e dê o nome **BotDucz**
3. No menu lateral, vá em **"Bot"**
4. Clique em **"Reset Token"** e **copie o token** (guarde em local seguro!)

### 2. Ativar Intents

Na mesma página do Bot, ative estas opções:
- ✅ **MESSAGE CONTENT INTENT**
- ✅ **SERVER MEMBERS INTENT** (opcional)
- ✅ **PRESENCE INTENT** (opcional)

### 3. Definir Permissões e Convidar

1. No menu lateral, vá em **"OAuth2" → "URL Generator"**
2. Em **Scopes**, marque: `bot`
3. Em **Bot Permissions**, marque:
   - ✅ Send Messages
   - ✅ Read Message History
   - ✅ Add Reactions
   - ✅ Connect
   - ✅ Speak
4. Copie a URL gerada e abra no navegador para **adicionar o bot ao seu servidor**

---

## Instalar e Rodar

### 1. Instalar dependências

```bash
cd D:\PastaDoProjeto\BotDucz
npm install
```

### 2. Configurar o token

Copie o arquivo `.env.example` para `.env` e coloque seu token:

```bash
copy .env.example .env
```

Edite o arquivo `.env`:
```
DISCORD_TOKEN=seu_token_aqui
```

### 3. Iniciar o bot

```bash
npm start
```

Você verá no terminal:
```
✅ BotDucz está online como BotDucz#1234
📡 Conectado a 1 servidor(es)
```

---

## Comandos

| Comando | Descrição |
|---|---|
| `+Ducz <link-myinstants>` | Toca o áudio do MyInstants no canal de voz |
| `+Ducz <descrição>` | Busca um som no MyInstants por texto e toca o primeiro resultado |
| `+Ducz <link-youtube>` | Toca o áudio de um vídeo do YouTube |
| `+Ducz yt Link Park forró` | Toca o áudio do primeiro vídeo do YouTube com a descrição |
| `+Ducz parar` | Para o áudio que está tocando |
| `+Ducz sair` | Desconecta o bot do canal de voz |
| `+Ducz ajuda` | Mostra a lista de comandos |
| `+d`| Funciona igual ao +Ducz fica mais facil para digitar |
|---|---|


### Exemplos

1. Entre em um canal de voz no Discord

2. **Tocar um som do MyInstants por link:**
   ```
   +Ducz https://www.myinstants.com/pt/instant/briga-de-gato-25101/
   ```

3. **Buscar e tocar um som por texto:**
   ```
   +Ducz monark
   ```
   O bot procura no MyInstants e toca o som que mais se assemelha! 🔍

4. **Tocar áudio do YouTube:**
   ```
   +Ducz https://www.youtube.com/watch?v=dQw4w9WgXcQ
   ```
   O bot extrai o áudio do vídeo e toca no canal de voz! 🎬

---

## Solução de Problemas

| Problema | Solução |
|---|---|
| Bot não responde | Verifique se o **MESSAGE CONTENT INTENT** está ativado no Portal |
| "DISCORD_TOKEN não encontrado" | Verifique se o arquivo `.env` existe e contém o token |
| Erro ao conectar no canal de voz | Verifique se o FFmpeg está instalado (`ffmpeg -version`) |
| "Não tenho permissão" | Verifique as permissões do bot no servidor (Connect + Speak) |
| Bot entra mas não toca áudio | Reinstale as dependências: `npm install @discordjs/opus sodium-native` |

## Contribuição

Sinta-se à vontade para abrir issues ou pull requests.

## Licença

Este projeto é de código aberto.

## Luan Ducate 2026