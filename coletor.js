'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { YoutubeTranscript } = require('youtube-transcript');
const Anthropic = require('@anthropic-ai/sdk').default;

const { buscarPorVideoIds, upsertVideo } = require('./lib/nocoStore');

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

async function resolverChannelId(handleUrl) {
  const resp = await axios.get(handleUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 20000,
  });
  const html = resp.data;
  const m = html.match(/"channelId":"(UC[\w-]+)"/) || html.match(/channel\/(UC[\w-]+)/);
  if (!m) throw new Error(`Nao consegui extrair channelId de ${handleUrl}`);
  return m[1];
}

async function listarVideosRSS(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const resp = await axios.get(url, { timeout: 20000 });
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const feed = parser.parse(resp.data);
  const entries = feed.feed && feed.feed.entry ? [].concat(feed.feed.entry) : [];
  return entries.map(e => ({
    videoId: e['yt:videoId'],
    titulo: e.title,
    publicadoEm: e.published,
    url: e.link && e.link['@_href'],
    autor: e.author && e.author.name,
  }));
}

async function pegarTranscricao(videoId) {
  try {
    const itens = await YoutubeTranscript.fetchTranscript(videoId, { lang: LANG_PREF });
    return itens.map(i => i.text).join(' ');
  } catch (_) {
    const itens = await YoutubeTranscript.fetchTranscript(videoId);
    return itens.map(i => i.text).join(' ');
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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nao configurada');
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  const prompt = `Voce vai analisar a transcricao de um video do YouTube e produzir um resumo executivo em HTML.

Titulo: ${video.titulo}
URL: ${video.url}
Canal: ${video.autor || ''}

Transcricao:
"""
${transcricao}
"""

Gere um documento HTML completo (com <!DOCTYPE html>, <head> e <body>) em portugues do Brasil contendo:
- Titulo do video como <h1>
- Link para o video
- Secao "Principais questoes abordadas" com lista de 5 a 10 itens objetivos
- Secao "Resumo executivo" (2-4 paragrafos)
- Secao "Pontos de acao / aplicacoes praticas" (lista curta, se aplicavel)
- Secao "Citacoes ou trechos de destaque" (3-5 trechos curtos da transcricao)
Use CSS inline simples e moderno (fonte sans-serif, max-width 720px, espacamento confortavel).
Responda SOMENTE com o HTML, sem cercas de codigo, sem comentarios fora do HTML.`;

  const resp = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  const texto = resp.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
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

  const videos = await listarVideosRSS(channelId);
  log(`  RSS: ${videos.length} videos`);

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

      await upsertVideo({
        ...baseRegistro,
        status: 'processado',
        transcricao: md,
        resumo_html: html,
        whatsapp_enviado: enviado,
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
