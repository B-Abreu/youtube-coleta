'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { YoutubeTranscript } = require('youtube-transcript');
const OpenAI = require('openai');

const { buscarPorVideoIds, upsertVideo, uploadHtml } = require('./lib/nocoStore');

const ROOT = __dirname;
const CANAIS_PATH = path.join(ROOT, 'canais.json');
const DATA_DIR = path.join(ROOT, 'data');

const DRY_RUN = process.argv.includes('--dry-run');
const BOOTSTRAP = process.argv.includes('--bootstrap');
const SALVAR_ARQUIVOS_LOCAL = process.env.SALVAR_ARQUIVOS_LOCAL === '1';
const MAX_VIDEOS = parseInt(process.env.MAX_VIDEOS_POR_EXECUCAO || '5', 10);
const LANG_PREF = process.env.LEGENDA_IDIOMA_PREFERIDO || 'pt';

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function slugify(s) {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 80);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HTTP_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function resolverChannelId(handleUrl) {
  try {
    const resp = await axios.get(handleUrl, { headers: HTTP_HEADERS, timeout: 20000 });
    const html = resp.data;
    const m = html.match(/"channelId":"(UC[\w-]+)"/) || html.match(/channel\/(UC[\w-]+)/);
    if (!m) throw new Error(`Nao consegui extrair channelId de ${handleUrl}`);
    return m[1];
  } catch (e) {
    const status = e.response && e.response.status;
    throw new Error(`resolverChannelId falhou em ${handleUrl} (status=${status || 'N/A'}): ${e.message}`);
  }
}

async function listarVideosViaApi(channelId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('YOUTUBE_API_KEY nao configurada');
  // Truque: o ID da playlist de uploads do canal eh sempre "UU" + sufixo do channelId
  const playlistId = 'UU' + channelId.slice(2);
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=15&key=${apiKey}`;
  let resp;
  try {
    resp = await axios.get(url, { timeout: 20000 });
  } catch (e) {
    const status = e.response && e.response.status;
    const detail = e.response && e.response.data && JSON.stringify(e.response.data).slice(0, 300);
    throw new Error(`YouTube Data API falhou (status=${status || 'N/A'}): ${detail || e.message}`);
  }
  return (resp.data.items || []).map(it => ({
    videoId: it.contentDetails.videoId,
    titulo: it.snippet.title,
    publicadoEm: it.contentDetails.videoPublishedAt || it.snippet.publishedAt,
    url: `https://www.youtube.com/watch?v=${it.contentDetails.videoId}`,
    autor: it.snippet.videoOwnerChannelTitle || it.snippet.channelTitle,
  }));
}

async function pegarTranscricao(videoId) {
  try {
    const itens = await YoutubeTranscript.fetchTranscript(videoId, { lang: LANG_PREF });
    return itens.map(i => i.text).join(' ');
  } catch (e1) {
    try {
      const itens = await YoutubeTranscript.fetchTranscript(videoId);
      return itens.map(i => i.text).join(' ');
    } catch (e2) {
      throw new Error(`pegarTranscricao falhou para ${videoId}: ${e2.message} (lang ${LANG_PREF}: ${e1.message})`);
    }
  }
}

function montarMarkdown({ video, canal, transcricao }) {
  return `---
canal: ${canal.nome_pasta}
canal_url: ${canal.url}
titulo: ${JSON.stringify(video.titulo)}
video_id: ${video.videoId}
video_url: ${video.url}
publicado_em: ${video.publicadoEm}
coletado_em: ${new Date().toISOString()}
---

# ${video.titulo}

**Canal:** ${video.autor || canal.nome_pasta}
**URL:** ${video.url}
**Publicado em:** ${video.publicadoEm}

## Transcricao

${transcricao}
`;
}

async function gerarHtmlResumo({ video, transcricao }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY nao configurada');
  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || 'gpt-4o';

  const system = `Voce eh um analista de equity research senior, especializado em bolsa brasileira e mercado internacional.
Sua tarefa eh transformar transcricoes de videos de analise de investimentos em relatorios HTML densos e acionaveis em portugues do Brasil.

REGRAS INEGOCIAVEIS:
- Extraia NUMEROS especificos da transcricao: receita, lucro, EBITDA, margens, crescimento (%), dividend yield, P/L, P/VP, ROE, ROIC, divida liquida, payout, multiplos, preco-alvo, qualquer guidance.
- NUNCA invente numeros. Se um dado nao foi dito, omita ou marque como "n/d".
- Sempre que houver numero, contextualize (vs trimestre anterior, vs ano anterior, vs setor).
- Identifique a TESE do analista (bull/bear/neutro) e os principais drivers que ela sustenta.
- Liste riscos com nomes especificos (regulatorio, alavancagem, concorrencia X, ciclo macro, FX, etc), nao genericos.
- Liste oportunidades/catalisadores tambem com nome e prazo (ex: "venda de ativo X esperada para 2026", "expansao em Y mercado").
- Mantenha o tom analitico, sem floreios. Direto ao ponto.
- Responda SEMPRE somente com HTML valido completo. Sem cercas de codigo.`;

  const user = `Gere um relatorio HTML completo (DOCTYPE, head, body) sobre este video.

Titulo: ${video.titulo}
URL: ${video.url}
Canal: ${video.autor || ''}

Transcricao integral:
"""
${transcricao}
"""

ESTRUTURA DO RELATORIO (na ordem):

1. <header> com:
   - <h1> titulo do video
   - linha com: empresa/ticker (se houver), setor, link "Assistir no YouTube"

2. Secao "Tese central": 1 paragrafo curto (3-5 linhas) com a tese do analista. Comece com tag clara: <strong>Vies:</strong> Bull / Bear / Neutro.

3. Secao "Numeros-chave": grid de cards com os indicadores citados. Cada card mostra:
   - Nome da metrica
   - Valor (grande, destacado)
   - Variacao/contexto pequeno embaixo (ex: "+12% YoY", "vs 8x do setor")
   Inclua APENAS metricas efetivamente citadas. Minimo 4, maximo 12 cards.

4. Secao "Drivers e oportunidades": lista detalhada com 3-7 itens. Cada item: <strong>Driver:</strong> descricao + impacto + prazo se mencionado.

5. Secao "Riscos e pontos de atencao": lista detalhada com 3-7 itens. Cada item: <strong>Risco:</strong> descricao + magnitude/probabilidade se discutido.

6. Secao "Valuation e recomendacao": preco-alvo (se houver), multiplos, comparacao com pares, recomendacao implicita ou explicita do analista. Se nao houver, escreva "Nao discutido explicitamente no video".

7. Secao "Trechos de destaque": 3-5 citacoes curtas e literais da transcricao (entre aspas), as mais carregadas de tese ou numeros.

8. Secao "Acompanhamento sugerido": 2-4 itens objetivos (ex: "Acompanhar resultado do 2T26 em agosto", "Monitorar aprovacao da regulacao X").

CSS (inline no <head>, sem libs externas):
- font-family: -apple-system, "Segoe UI", Roboto, sans-serif
- max-width: 760px, centralizado, padding generoso
- Fundo body: #f7f8fa; cartao: #fff com border-radius 8px, padding 16-20px, box-shadow leve
- h1: 24-28px peso 700, cor #0f172a
- h2: 18-20px peso 600, com barra lateral colorida (border-left 4px) e padding-left 12px. Cores: Tese #2563eb, Numeros #0891b2, Drivers #16a34a, Riscos #dc2626, Valuation #7c3aed, Trechos #475569, Acompanhamento #ea580c
- Cards de numeros: grid responsivo (display:grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap:12px). Cada card: fundo #fff, valor em 22px peso 700 cor #0f172a, label em 12px maiusculas cor #64748b, contexto em 12px italico cor #475569
- Listas de drivers e riscos: cada item com fundo branco, padding 12px, border-radius 6px, separador com border-left 3px (verde drivers, vermelho riscos)
- Citacoes: <blockquote> com border-left 3px #94a3b8, fundo #f1f5f9, padding 10px 14px, fonte italica
- Espacamento entre secoes: margin-top 28px

Responda SOMENTE com o HTML completo.`;

  const resp = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const texto = (resp.choices[0]?.message?.content || '').trim();
  return texto.replace(/^```html\s*/i, '').replace(/```\s*$/i, '').trim();
}

async function enviarWhatsAppDocumento({ html, fileName, titulo }) {
  const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  const numero = process.env.EVOLUTION_TO_NUMBER;
  if (!baseUrl || !apiKey || !instance || !numero) {
    throw new Error('Variaveis Evolution API incompletas');
  }
  const base64 = Buffer.from(html, 'utf8').toString('base64');
  const url = `${baseUrl}/message/sendMedia/${instance}`;
  const payload = {
    number: numero,
    mediatype: 'document',
    mimetype: 'text/html',
    caption: `Resumo do video: ${titulo}`,
    media: base64,
    fileName,
  };
  const resp = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    timeout: 60000,
  });
  return resp.data;
}

function salvarLocalSeHabilitado({ canal, video, md, html }) {
  if (!SALVAR_ARQUIVOS_LOCAL) return;
  const dataPub = (video.publicadoEm || new Date().toISOString()).slice(0, 10);
  const slug = slugify(video.titulo) || video.videoId;
  const pasta = path.join(DATA_DIR, canal.nome_pasta, `${dataPub}-${slug}`);
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, 'transcricao.md'), md, 'utf8');
  fs.writeFileSync(path.join(pasta, 'resumo.html'), html, 'utf8');
}

async function processarCanal(canal) {
  log(`Canal: ${canal.handle}`);
  const channelId = canal.channel_id || await resolverChannelId(canal.url);
  log(`  channelId: ${channelId}`);

  const videos = await listarVideosViaApi(channelId);
  log(`  API: ${videos.length} videos`);

  const tratados = await buscarPorVideoIds(videos.map(v => v.videoId));
  const novos = videos.filter(v => !tratados.has(v.videoId));
  log(`  ${novos.length} novos (${tratados.size} ja na base)`);

  if (BOOTSTRAP) {
    for (const v of novos) {
      await upsertVideo({
        video_id: v.videoId,
        canal: canal.nome_pasta,
        canal_handle: canal.handle,
        titulo: v.titulo,
        url: v.url,
        publicado_em: v.publicadoEm,
        coletado_em: new Date().toISOString(),
        status: 'bootstrap',
      });
    }
    log(`  [bootstrap] marcados ${novos.length} videos como ja vistos`);
    return;
  }

  const primeira = tratados.size === 0;
  const aProcessar = primeira ? novos.slice(0, MAX_VIDEOS) : novos;
  if (primeira && novos.length > MAX_VIDEOS) {
    log(`  Primeira execucao: processando ${MAX_VIDEOS} de ${novos.length}; demais marcados como bootstrap`);
    for (const v of novos.slice(MAX_VIDEOS)) {
      await upsertVideo({
        video_id: v.videoId,
        canal: canal.nome_pasta,
        canal_handle: canal.handle,
        titulo: v.titulo,
        url: v.url,
        publicado_em: v.publicadoEm,
        coletado_em: new Date().toISOString(),
        status: 'bootstrap',
      });
    }
  }

  for (const video of aProcessar) {
    log(`  -> ${video.titulo} (${video.videoId})`);
    const baseRegistro = {
      video_id: video.videoId,
      canal: canal.nome_pasta,
      canal_handle: canal.handle,
      titulo: video.titulo,
      url: video.url,
      publicado_em: video.publicadoEm,
      coletado_em: new Date().toISOString(),
    };
    try {
      const transcricao = await pegarTranscricao(video.videoId);
      const md = montarMarkdown({ video, canal, transcricao });
      const html = await gerarHtmlResumo({ video, transcricao });

      salvarLocalSeHabilitado({ canal, video, md, html });

      let enviado = false;
      if (!DRY_RUN) {
        const fileName = `${slugify(video.titulo) || video.videoId}.html`;
        await enviarWhatsAppDocumento({ html, fileName, titulo: video.titulo });
        enviado = true;
        log(`     enviado via WhatsApp`);
      } else {
        log(`     [dry-run] envio WhatsApp pulado`);
      }

      let attachment = null;
      try {
        const fileName = `${slugify(video.titulo) || video.videoId}.html`;
        attachment = await uploadHtml(fileName, html);
      } catch (e) {
        log(`     aviso: upload do arquivo HTML falhou: ${e.message}`);
      }

      await upsertVideo({
        ...baseRegistro,
        status: 'processado',
        transcricao: md,
        resumo_html: html,
        whatsapp_enviado: enviado,
        ...(attachment ? { arquivo_html: attachment } : {}),
      });
    } catch (e) {
      log(`     ERRO: ${e.message}`);
      await upsertVideo({ ...baseRegistro, status: 'erro', erro: e.message });
    }
  }
}

async function main() {
  if (SALVAR_ARQUIVOS_LOCAL) fs.mkdirSync(DATA_DIR, { recursive: true });
  const canais = JSON.parse(fs.readFileSync(CANAIS_PATH, 'utf8'));
  for (const canal of canais) {
    try {
      await processarCanal(canal);
    } catch (e) {
      log(`Falha canal ${canal.handle}: ${e.message}`);
    }
  }
  log('Concluido.');
}

main().catch(e => {
  log('Falha geral:', e.message);
  process.exit(1);
});
