# Youtube-coleta

Rotina diaria que monitora canais do YouTube por uploads novos, baixa a transcricao,
gera um resumo executivo em HTML (Claude) e envia via WhatsApp pela Evolution API.

Estado e conteudo (transcricao + HTML) ficam armazenados no NocoDB — nada de `state.json`
em arquivo, o que permite rodar em ambientes efemeros (Claude Code Routines, containers, etc).

## Stack

- Node.js (>= 18)
- `youtube-transcript` para legendas
- RSS oficial do canal (`feeds/videos.xml`) para listar uploads
- `openai` (gpt-4o-mini) para gerar o resumo HTML
- `axios` para Evolution API + NocoDB
- NocoDB como storage (estado + transcricoes + HTML)

## Esquema da tabela NocoDB

Tabela `mjmo0mjc6pq5zq3` (project `p9ep3apgyn4jr6g`):

| Campo | Tipo | Notas |
|---|---|---|
| `video_id` | SingleLineText | unique — chave de deduplicacao |
| `canal` | SingleLineText | |
| `canal_handle` | SingleLineText | |
| `titulo` | SingleLineText | |
| `url` | URL | |
| `publicado_em` | DateTime | |
| `coletado_em` | DateTime | |
| `status` | SingleSelect | `bootstrap`, `processado`, `erro` |
| `transcricao` | LongText | markdown completo |
| `resumo_html` | LongText | HTML final |
| `whatsapp_enviado` | Checkbox | |
| `erro` | LongText | mensagem de falha |

## Variaveis de ambiente

Veja `.env.example`. Em rotinas remotas, configure como **secrets** da routine.

```
EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE, EVOLUTION_TO_NUMBER
OPENAI_API_KEY, OPENAI_MODEL
NOCODB_URL, NOCODB_API_KEY, NOCODB_TABLE_VIDEOS
MAX_VIDEOS_POR_EXECUCAO, LEGENDA_IDIOMA_PREFERIDO, SALVAR_ARQUIVOS_LOCAL
```

## Uso local

```powershell
npm install
# 1) marca os 15 videos atuais como ja vistos (so na primeira vez):
node coletor.js --bootstrap
# 2) teste sem enviar WhatsApp (ainda chama Claude e grava no NocoDB):
node coletor.js --dry-run
# 3) execucao real:
node coletor.js
```

## Adicionar canais

Edite `canais.json`:
```json
[
  { "handle": "@CanaldoASVID", "url": "https://www.youtube.com/@CanaldoASVID", "nome_pasta": "CanaldoASVID" },
  { "handle": "@OutroCanal",   "url": "https://www.youtube.com/@OutroCanal",   "nome_pasta": "OutroCanal" }
]
```

## Rodar como Claude Code Routine

1. Subir esse diretorio como repo no GitHub (privado).
2. Em https://claude.ai/code/routines/new:
   - Conectar o repo.
   - Comando: `npm install --omit=dev && node coletor.js`
   - Cron: `0 22 * * *` (22:00 UTC == 19:00 BRT, sem horario de verao).
   - Adicionar todas as variaveis do `.env.example` como secrets.
3. Antes do primeiro run agendado, executar localmente `node coletor.js --bootstrap` (ou
   acionar a routine manualmente uma vez com a flag) para nao disparar 5 mensagens de
   videos antigos no primeiro dia.

## Rodar via Windows Task Scheduler (alternativa local)

```powershell
schtasks /Create /TN "Youtube-coleta" /SC DAILY /ST 19:00 `
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File `"C:\Users\bruno\OneDrive\Documentos\Claude\Microserviços\Youtube-coleta\run.ps1`"" `
  /RL HIGHEST /F
```

## Comportamento

- Lista os ate 15 videos mais recentes de cada canal pelo RSS do YouTube.
- Consulta o NocoDB (`video_id IN (...)`) — qualquer ID ja presente eh ignorado.
- Para cada novo: baixa transcricao, gera HTML com Claude, envia via Evolution,
  grava registro com status `processado`. Em falha, grava com `erro` (assim nao
  reprocessa indefinidamente).
- Primeira execucao: limita a `MAX_VIDEOS_POR_EXECUCAO` e marca o restante como
  `bootstrap`.
- `SALVAR_ARQUIVOS_LOCAL=1` opcionalmente espelha em `data/<canal>/<data>-<slug>/`.

## Endpoint Evolution

`POST {EVOLUTION_API_URL}/message/sendMedia/{EVOLUTION_INSTANCE}` — header `apikey`,
body com `mediatype: document`, `mimetype: text/html`, conteudo HTML em base64.
