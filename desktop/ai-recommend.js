/* ai-recommend.js - Non-blocking Local ONNX AI Similarity Engine (all-MiniLM-L6-v2)
   ---------------------------------------------------------------------------
   - Attempts lazy, non-blocking loading of @huggingface/transformers using
     Xenova/all-MiniLM-L6-v2 with { dtype: 'q8', local_files_only: true }.
   - Automatically falls back to a fast, deterministic TF-IDF + bigram cosine
     similarity engine when ONNX weights or @huggingface/transformers are not
     bundled yet — zero startup latency and millisecond query times.
   - Strictly partitioned vector indexes: 'safe' vs 'isolated' (18+). Safe
     queries never read isolated items, and adult items are never indexed into
     the safe partition.
   - Builds semantic documents from title, synopsis/overview, genres, tags,
     cast, and year; returns top 12-16 cosine-similarity matches with match
     percentage pills. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const VALID_PARTITIONS = { safe: true, isolated: true };
const ADULT_KINDS = { ep: 1, r34: 1, r34v: 1, hc: 1, htv: 1, jav: 1, ai: 1, hentai20: 1, nhentai: 1 };
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'have',
  'will', 'about', 'after', 'before', 'when', 'where', 'what', 'which', 'while',
  'their', 'there', 'they', 'them', 'been', 'were', 'being', 'more', 'most',
  'very', 'just', 'over', 'such', 'only', 'also', 'than', 'then', 'some',
  'episode', 'season', 'movie', 'series', 'watch', 'online', 'free', 'full', 'hd'
]);

const INDEX_DIR = path.resolve(os.tmpdir(), 'superbox-ai-index');
const MAX_PARTITION_ITEMS = 2500;

let extractor = null;
let engineMode = 'tfidf'; /* 'onnx' | 'tfidf' */
let onnxAttempted = false;
let onnxLoading = null;

/* Strictly isolated in-memory vector stores */
const stores = {
  safe: new Map(),
  isolated: new Map()
};

/* Term document frequency maps per partition (for TF-IDF fallback) */
const dfMaps = {
  safe: new Map(),
  isolated: new Map()
};

const dirtyFlags = { safe: false, isolated: false };
let persistTimer = null;

function ensureDir() {
  try {
    if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true });
  } catch (e) {}
}

function indexFileFor(partition) {
  const p = partition === 'isolated' ? 'isolated' : 'safe';
  const fp = path.resolve(INDEX_DIR, 'vectors-' + p + '.json');
  if (!fp.startsWith(INDEX_DIR + path.sep)) return '';
  return fp;
}

function resolveModelsDir() {
  const candidates = [];
  try { if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'models')); } catch (e) {}
  candidates.push(path.join(__dirname, 'models'));
  candidates.push(path.join(__dirname, '..', 'models'));
  for (let i = 0; i < candidates.length; i++) {
    try {
      if (fs.existsSync(candidates[i])) return candidates[i];
    } catch (e) {}
  }
  return path.join(__dirname, 'models');
}

/* Non-blocking background initialization of local ONNX model (all-MiniLM-L6-v2). */
function initOnnxBackground() {
  if (onnxAttempted || onnxLoading) return onnxLoading;
  onnxAttempted = true;
  onnxLoading = (async function () {
    try {
      const modelsDir = resolveModelsDir();
      const mod = await import('@huggingface/transformers');
      if (mod && mod.env) {
        mod.env.allowRemoteModels = false;
        mod.env.allowLocalModels = true;
        mod.env.localModelPath = modelsDir;
      }
      if (mod && typeof mod.pipeline === 'function') {
        const pipe = await mod.pipeline('feature-extraction', MODEL_ID, {
          dtype: 'q8',
          local_files_only: true
        });
        if (pipe) {
          extractor = pipe;
          engineMode = 'onnx';
          /* Re-embed existing items lazily in background */
          reembedAllAsync().catch(function () {});
        }
      }
    } catch (e) {
      /* Local ONNX weights or package not bundled yet — TF-IDF cosine engine stays active. */
      engineMode = 'tfidf';
    }
    return engineMode;
  })();
  return onnxLoading;
}

function isAdultItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.adult === true || item.isAdult === true || item.partition === 'isolated') return true;
  const k = String(item.kind || item.source || '').toLowerCase();
  if (ADULT_KINDS[k]) return true;
  return false;
}

function normPartition(partition, item) {
  if (partition === 'isolated' || isAdultItem(item)) return 'isolated';
  return 'safe';
}

function itemIdOf(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.id) return String(item.id);
  if (item.tmdb) return 'tmdb:' + (item.mt === 'tv' ? 'tv' : 'movie') + ':' + String(item.tmdb);
  if (item.subjectId) return 'mb:' + String(item.subjectId);
  if (item.vid) return 'yt:' + String(item.vid);
  if (item.page) return 'pg:' + String(item.page).toLowerCase().replace(/[?#].*$/, '').slice(0, 180);
  const t = String(item.t || item.title || '').trim().toLowerCase();
  return t ? ('t:' + t.slice(0, 120) + ':' + String(item.year || '')) : '';
}

function buildDocText(item) {
  if (!item || typeof item !== 'object') return '';
  const title = String(item.t || item.title || item.name || '').trim();
  const synopsis = String(item.overview || item.desc || item.synopsis || item.description || '').trim();
  const genres = Array.isArray(item.genres)
    ? item.genres.map(function (g) { return typeof g === 'string' ? g : (g && g.name) || ''; }).join(' ')
    : String(item.genre || '');
  const tags = Array.isArray(item.tags) ? item.tags.join(' ') : String(item.tags || '');
  const cast = Array.isArray(item.cast)
    ? item.cast.map(function (c) { return typeof c === 'string' ? c : (c && c.name) || ''; }).join(' ')
    : String(item.cast || '');
  const year = String(item.year || '').slice(0, 4);
  const kind = String(item.mt || item.kind || '');
  /* Weight title & genres slightly higher by repeating tokens cleanly */
  return [title, title, genres, genres, tags, cast, synopsis, year, kind].filter(Boolean).join(' ').slice(0, 1800);
}

function tokenize(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f\u3040-\u30ff\u4e00-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(function (w) { return w.length >= 2 && !STOP_WORDS.has(w); });
  const out = [];
  for (let i = 0; i < words.length && out.length < 180; i++) {
    out.push(words[i]);
    if (i + 1 < words.length) out.push(words[i] + '_' + words[i + 1]);
  }
  return out;
}

function buildSparseTf(tokens) {
  const tf = {};
  const len = tokens.length || 1;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    tf[tok] = (tf[tok] || 0) + 1;
  }
  const vec = {};
  let normSq = 0;
  const keys = Object.keys(tf);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const w = 1 + Math.log(tf[k]);
    vec[k] = w / Math.sqrt(len);
    normSq += vec[k] * vec[k];
  }
  const norm = Math.sqrt(normSq) || 1;
  for (let i = 0; i < keys.length; i++) vec[keys[i]] /= norm;
  return vec;
}

function sparseCosine(vA, vB, dfMap, totalDocs) {
  if (!vA || !vB) return 0;
  const keysA = Object.keys(vA);
  if (!keysA.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  const N = Math.max(2, totalDocs || 2);
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    const idf = dfMap ? Math.log(1 + N / (1 + (dfMap.get(k) || 0))) : 1;
    const wa = vA[k] * idf;
    normA += wa * wa;
    if (vB[k]) dot += wa * (vB[k] * idf);
  }
  const keysB = Object.keys(vB);
  for (let i = 0; i < keysB.length; i++) {
    const k = keysB[i];
    const idf = dfMap ? Math.log(1 + N / (1 + (dfMap.get(k) || 0))) : 1;
    const wb = vB[k] * idf;
    normB += wb * wb;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function denseCosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

async function computeDenseEmbedding(text) {
  if (!extractor || engineMode !== 'onnx') return null;
  try {
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    if (out && out.data && out.data.length) return Array.from(out.data);
  } catch (e) {}
  return null;
}

/* Batch embeddings: one ONNX pass per chunk instead of one per title. */
async function computeDenseBatch(texts) {
  if (!extractor || engineMode !== 'onnx' || !Array.isArray(texts) || !texts.length) return [];
  try {
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    if (out && typeof out.tolist === 'function' && out.dims && out.dims.length === 2) {
      return out.tolist();
    }
    if (out && out.data) return [Array.from(out.data)];
  } catch (e) {}
  return [];
}

function sanitizeCardMeta(item) {
  return {
    id: itemIdOf(item),
    t: String(item.t || item.title || item.name || '').slice(0, 140),
    poster: /^https?:\/\//i.test(String(item.poster || '')) ? String(item.poster) : '',
    year: String(item.year || '').slice(0, 4),
    rating: String(item.rating || '').slice(0, 8),
    badge: String(item.badge || '').slice(0, 18),
    kind: String(item.kind || (item.tmdb ? 'tmdb' : 'mb')).slice(0, 20),
    tmdb: item.tmdb || undefined,
    mt: item.mt === 'tv' ? 'tv' : (item.mt === 'movie' ? 'movie' : undefined),
    subjectId: item.subjectId || undefined,
    dp: item.dp || undefined,
    vid: item.vid || undefined,
    page: /^https?:\/\//i.test(String(item.page || '')) ? String(item.page) : undefined,
    genres: Array.isArray(item.genres) ? item.genres.slice(0, 6).map(function (g) { return typeof g === 'string' ? g : (g && g.name) || ''; }).filter(Boolean) : [],
    overview: String(item.overview || item.desc || item.synopsis || '').slice(0, 260)
  };
}

function updateDf(partition, oldVec, newVec) {
  const df = dfMaps[partition];
  if (oldVec) {
    Object.keys(oldVec).forEach(function (k) {
      const n = (df.get(k) || 1) - 1;
      if (n <= 0) df.delete(k); else df.set(k, n);
    });
  }
  if (newVec) {
    Object.keys(newVec).forEach(function (k) {
      df.set(k, (df.get(k) || 0) + 1);
    });
  }
}

function schedulePersist(partition) {
  dirtyFlags[partition] = true;
  if (persistTimer) return;
  persistTimer = setTimeout(function () {
    persistTimer = null;
    ['safe', 'isolated'].forEach(function (p) {
      if (!dirtyFlags[p]) return;
      dirtyFlags[p] = false;
      persistPartition(p);
    });
  }, 4000);
  try { persistTimer.unref(); } catch (e) {}
}

function persistPartition(partition) {
  ensureDir();
  const fp = indexFileFor(partition);
  if (!fp) return;
  try {
    const arr = [];
    for (const entry of stores[partition].values()) {
      arr.push({
        id: entry.id,
        meta: entry.meta,
        doc: entry.doc,
        sparse: entry.sparse,
        dense: entry.dense || null,
        at: entry.at
      });
    }
    fs.writeFile(fp, JSON.stringify({ v: 1, partition: partition, items: arr }), 'utf8', function () {});
  } catch (e) {}
}

function hydrateFromDisk() {
  ['safe', 'isolated'].forEach(function (p) {
    const fp = indexFileFor(p);
    if (!fp) return;
    try {
      if (!fs.existsSync(fp)) return;
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!parsed || !Array.isArray(parsed.items)) return;
      parsed.items.slice(0, MAX_PARTITION_ITEMS).forEach(function (it) {
        if (!it || !it.id || !it.meta || !it.sparse) return;
        stores[p].set(it.id, it);
        updateDf(p, null, it.sparse);
      });
    } catch (e) {}
  });
}

async function reembedAllAsync() {
  if (engineMode !== 'onnx' || !extractor) return;
  for (const p of ['safe', 'isolated']) {
    for (const entry of stores[p].values()) {
      if (!entry.dense && entry.doc) {
        entry.dense = await computeDenseEmbedding(entry.doc);
      }
    }
    schedulePersist(p);
  }
}

async function indexItems(items, requestedPartition) {
  if (!Array.isArray(items) || !items.length) return { indexed: 0, mode: engineMode };
  const prepared = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (!raw || typeof raw !== 'object') continue;
    /* Hard partition enforcement: adult items NEVER enter 'safe' */
    if (requestedPartition === 'safe' && isAdultItem(raw)) continue;
    const part = VALID_PARTITIONS[requestedPartition]
      ? (isAdultItem(raw) ? 'isolated' : requestedPartition)
      : normPartition(requestedPartition, raw);
    const id = itemIdOf(raw);
    const meta = sanitizeCardMeta(raw);
    if (!id || !meta.t) continue;
    const doc = buildDocText(raw);
    if (!doc) continue;
    const prev = stores[part].get(id);
    prepared.push({
      part: part,
      id: id,
      meta: meta,
      doc: doc,
      sparse: buildSparseTf(tokenize(doc)),
      dense: prev && prev.doc === doc && prev.dense ? prev.dense : null
    });
  }
  /* Embed every uncached document in chunks of 16; cached docs skip inference. */
  if (engineMode === 'onnx') {
    const need = prepared.filter(function (e) { return !e.dense; });
    for (let i = 0; i < need.length; i += 16) {
      const chunk = need.slice(i, i + 16);
      const rows = await computeDenseBatch(chunk.map(function (e) { return e.doc; }));
      chunk.forEach(function (e, k) { if (rows[k] && rows[k].length) e.dense = rows[k]; });
    }
  }
  let count = 0;
  const touched = { safe: false, isolated: false };
  prepared.forEach(function (e) {
    const store = stores[e.part];
    const prev = store.get(e.id);
    updateDf(e.part, prev ? prev.sparse : null, e.sparse);
    store.set(e.id, {
      id: e.id,
      meta: e.meta,
      doc: e.doc,
      sparse: e.sparse,
      dense: e.dense || (prev && prev.dense) || null,
      at: Date.now()
    });
    if (store.size > MAX_PARTITION_ITEMS) {
      const oldestKey = store.keys().next().value;
      if (oldestKey) {
        const old = store.get(oldestKey);
        updateDf(e.part, old ? old.sparse : null, null);
        store.delete(oldestKey);
      }
    }
    touched[e.part] = true;
    count++;
  });
  if (touched.safe) schedulePersist('safe');
  if (touched.isolated) schedulePersist('isolated');
  return {
    indexed: count,
    mode: engineMode,
    counts: { safe: stores.safe.size, isolated: stores.isolated.size }
  };
}

async function querySimilar(seed, opts) {
  const o = opts || {};
  const part = o.partition === 'isolated' || isAdultItem(seed) ? 'isolated' : 'safe';
  const limit = Math.max(4, Math.min(24, Number(o.limit) || 16));
  const store = stores[part];
  const df = dfMaps[part];

  /* Optionally index any candidate items passed alongside the seed (strictly partitioned) */
  if (Array.isArray(o.candidates) && o.candidates.length) {
    await indexItems(o.candidates, part);
  }

  const seedId = itemIdOf(seed);
  const seedTitleNorm = String((seed && (seed.t || seed.title || seed.name)) || '').trim().toLowerCase();
  const doc = buildDocText(seed || {});
  if (!doc || !store.size) {
    return { ok: true, mode: engineMode, partition: part, ms: 0, items: [] };
  }

  const t0 = Date.now();
  const qSparse = buildSparseTf(tokenize(doc));
  const qDense = engineMode === 'onnx' ? await computeDenseEmbedding(doc) : null;
  const totalDocs = store.size;
  const scored = [];

  for (const entry of store.values()) {
    if (seedId && entry.id === seedId) continue;
    if (seedTitleNorm && entry.meta.t.toLowerCase() === seedTitleNorm) continue;
    let sim = 0;
    if (qDense && entry.dense) {
      sim = denseCosine(qDense, entry.dense);
    } else {
      sim = sparseCosine(qSparse, entry.sparse, df, totalDocs);
    }
    /* Small boost for shared genre/year proximity */
    if (seed && seed.year && entry.meta.year && Math.abs(Number(seed.year) - Number(entry.meta.year)) <= 3) {
      sim += 0.03;
    }
    if (sim > 0.01) scored.push({ entry: entry, sim: sim });
  }

  scored.sort(function (a, b) { return b.sim - a.sim; });
  const top = scored.slice(0, limit);
  const maxSim = top.length ? Math.max(0.25, top[0].sim) : 1;

  const items = top.map(function (row, idx) {
    /* Calibrated match percentage pill (76% - 99% Match) */
    const rel = Math.min(1, row.sim / maxSim);
    const pct = Math.max(74, Math.min(99, Math.round(74 + rel * 24 - idx * 0.35)));
    return Object.assign({}, row.entry.meta, {
      score: Math.round(row.sim * 1000) / 1000,
      match: pct + '% Match'
    });
  });

  return {
    ok: true,
    mode: engineMode,
    model: engineMode === 'onnx' ? MODEL_ID : 'tfidf-cosine-fallback',
    partition: part,
    ms: Math.max(1, Date.now() - t0),
    indexed: totalDocs,
    items: items
  };
}

function status() {
  return {
    ok: true,
    mode: engineMode,
    model: engineMode === 'onnx' ? MODEL_ID : 'tfidf-cosine-fallback',
    partitions: {
      safe: stores.safe.size,
      isolated: stores.isolated.size
    }
  };
}

/* Hydrate disk index synchronously on module load and kick off non-blocking ONNX probe */
hydrateFromDisk();
setTimeout(function () { initOnnxBackground(); }, 1200).unref();

module.exports = {
  indexItems: indexItems,
  querySimilar: querySimilar,
  status: status,
  initOnnxBackground: initOnnxBackground
};
