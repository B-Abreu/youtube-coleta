'use strict';

const axios = require('axios');

const BASE_URL = (process.env.NOCODB_URL || 'https://ndb.construtoracivil.com.br').replace(/\/$/, '');
const TABLE_ID = process.env.NOCODB_TABLE_VIDEOS;
const API_KEY = process.env.NOCODB_API_KEY;

function client() {
  if (!TABLE_ID || !API_KEY) {
    throw new Error('NOCODB_TABLE_VIDEOS e NOCODB_API_KEY sao obrigatorios');
  }
  return axios.create({
    baseURL: `${BASE_URL}/api/v2/tables/${TABLE_ID}`,
    headers: { 'xc-token': API_KEY, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}

async function buscarPorVideoIds(videoIds) {
  if (!videoIds.length) return new Map();
  const c = client();
  const encontrados = new Map();
  // NocoDB limita o tamanho da URL; processa em lotes
  const lotes = [];
  for (let i = 0; i < videoIds.length; i += 50) lotes.push(videoIds.slice(i, i + 50));
  for (const lote of lotes) {
    const where = `(video_id,in,${lote.join(',')})`;
    const resp = await c.get('/records', { params: { where, limit: 200, fields: 'Id,video_id,status' } });
    for (const r of resp.data.list || []) {
      encontrados.set(r.video_id, r);
    }
  }
  return encontrados;
}

async function upsertVideo(registro) {
  // Cria se nao existe; atualiza se ja existe (chave: video_id)
  const c = client();
  const existente = (await buscarPorVideoIds([registro.video_id])).get(registro.video_id);
  if (existente) {
    await c.patch('/records', { Id: existente.Id, ...registro });
    return existente.Id;
  }
  const resp = await c.post('/records', registro);
  return resp.data.Id;
}

async function uploadHtml(nomeArquivo, conteudoHtml) {
  if (!API_KEY) throw new Error('NOCODB_API_KEY ausente');
  const FormData = require('form-data');
  const form = new FormData();
  form.append('files', Buffer.from(conteudoHtml, 'utf8'), {
    filename: nomeArquivo,
    contentType: 'text/html',
  });
  const url = `${BASE_URL}/api/v2/storage/upload?path=youtube-coleta`;
  const resp = await axios.post(url, form, {
    headers: { 'xc-token': API_KEY, ...form.getHeaders() },
    maxBodyLength: Infinity,
    timeout: 60000,
  });
  return resp.data; // array com metadata do attachment
}

module.exports = { buscarPorVideoIds, upsertVideo, uploadHtml };
