# Guia de Presets de Configuracao

Este diretorio usa 3 arquivos ativos de configuracao:

- bot.json
- sources.json
- musicQueue.json

Esses 3 arquivos sao lidos pelo bot na inicializacao e definem o comportamento atual.

## Estrutura de presets

Os perfis prontos ficam em:

- presets/daily
- presets/high-performance
- presets/low-resource

Cada preset tem os mesmos 3 arquivos:

- bot.json
- sources.json
- musicQueue.json

## Entendendo cada parametro

Para ver a explicacao detalhada de cada campo dos JSONs, consulte:

- CONFIG_REFERENCE.md

Esse arquivo funciona como os comentarios da configuracao (JSON nao aceita comentario nativo).

## Como trocar de preset (Windows PowerShell)

Execute no diretorio raiz do projeto (onde esta o package.json).

### 1. Daily (uso diario - recomendado)

```powershell
Copy-Item .\config\presets\daily\bot.json .\config\bot.json -Force
Copy-Item .\config\presets\daily\sources.json .\config\sources.json -Force
Copy-Item .\config\presets\daily\musicQueue.json .\config\musicQueue.json -Force
```

### 2. High Performance (mais rapido, mais carga)

```powershell
Copy-Item .\config\presets\high-performance\bot.json .\config\bot.json -Force
Copy-Item .\config\presets\high-performance\sources.json .\config\sources.json -Force
Copy-Item .\config\presets\high-performance\musicQueue.json .\config\musicQueue.json -Force
```

### 3. Low Resource (menos consumo de recursos)

```powershell
Copy-Item .\config\presets\low-resource\bot.json .\config\bot.json -Force
Copy-Item .\config\presets\low-resource\sources.json .\config\sources.json -Force
Copy-Item .\config\presets\low-resource\musicQueue.json .\config\musicQueue.json -Force
```

## Aplicacao das mudancas

Depois de trocar preset, reinicie o bot para aplicar:

```powershell
npm run check
npm start
```

## Dica de fluxo

- Comece com daily.
- Se quiser mais velocidade para playlists grandes, use high-performance.
- Se notar uso alto de CPU/RAM/rede, use low-resource.

## Personalizacao propria

Voce pode criar um novo preset copiando um existente, por exemplo:

1. Crie pasta: presets/meu-perfil
2. Copie os 3 JSON de um perfil base
3. Ajuste os valores
4. Aplique com Copy-Item para os arquivos ativos

Exemplo rapido:

```powershell
New-Item -ItemType Directory .\config\presets\meu-perfil
Copy-Item .\config\presets\daily\*.json .\config\presets\meu-perfil\
```

Depois, edite os arquivos em presets/meu-perfil e aplique igual aos exemplos acima.
