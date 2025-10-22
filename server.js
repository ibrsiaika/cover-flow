// Minimal full-stack search engine with crawler + ranker
// Start: npm install && npm start

const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const compression = require('compression');
const cheerio = require('cheerio');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const PAGES_FILE = path.join(DATA_DIR, 'pages.json');
const GRAPH_FILE = path.join(DATA_DIR, 'graph.json');

app.use(express.json({ limit: '2mb' }));
app.use(compression());

// Serve static website from project root
app.use(express.static(__dirname, { extensions: ['html'] }));

// ------------------------- Utilities -------------------------

async function ensureDataDir() {
  if (!fsSync.existsSync(DATA_DIR)) {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

// Lightweight stopword list
const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','but','by','for','if','in','into','is',
  'it','no','not','of','on','or','such','that','the','their','then','there',
  'these','they','this','to','was','will','with','your','you','from','we','our',
  'than','so','about','can','all','any','more','most','other','some','what','when',
  'which','who','whom','where','why','how'
]);

function normalizeText(s) {
  if (!s) return '';
  return s
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t && t.length > 2 && !STOPWORDS.has(t));
}

function urlDepth(u) {
  try {
    const { pathname } = new URL(u);
    const parts = pathname.split('/').filter(Boolean);
    return parts.length;
  } catch {
    return 0;
  }
}

function sha256(str) {
  return crypto.createHash('sha256').update(str || '', 'utf8').digest('hex');
}

// ------------------------- In-memory State -------------------------

let indexState = {
  N: 0,                            // number of documents
  df: {},                          // document frequency per term
  ii: {},                          // inverted index: term -> { docId: tf }
  docIdByUrl: {},                  // url -> docId
  pages: {},                       // docId -> { url, title, description, text, length, discoveredAt, lastModified, canonical, contentHash }
  authority: {}                    // docId -> rank [0..1]
};

let crawlState = {
  running: false,
  queueLength: 0,
  visitedCount: 0,
  startedAt: null,
  finishedAt: null,
  message: 'idle'
};

// Cancel + robots + rate-limit caches
let crawlCancel = { cancel: false };
const robotsCache = new Map(); // host -> { disallow: [prefix], fetchedAt }
const hostLastFetch = new Map(); // host -> timestamp ms
const CRAWL_DELAY_MS = 1000;

// ------------------------- Persistence -------------------------

async function loadIndex() {
  try {
    if (fsSync.existsSync(INDEX_FILE)) {
      const buf = await fs.readFile(INDEX_FILE, 'utf-8');
      const data = JSON.parse(buf);
      indexState.N = data.N || 0;
      indexState.df = data.df || {};
      indexState.ii = data.ii || {};
      indexState.docIdByUrl = data.docIdByUrl || {};
      indexState.authority = data.authority || {};
    }
    if (fsSync.existsSync(PAGES_FILE)) {
      const buf = await fs.readFile(PAGES_FILE, 'utf-8');
      indexState.pages = JSON.parse(buf) || {};
    }
  } catch (err) {
    console.error('Failed to load index:', err);
  }
}

async function saveIndex() {
  await ensureDataDir();
  const { N, df, ii, docIdByUrl, authority } = indexState;
  await fs.writeFile(INDEX_FILE, JSON.stringify({ N, df, ii, docIdByUrl, authority }, null, 2));
  await fs.writeFile(PAGES_FILE, JSON.stringify(indexState.pages, null, 2));
}

// ------------------------- Robots / Sitemap helpers -------------------------

async function getRobots(hostUrl, userAgent = 'GenieSearchBot') {
  try {
    const u = new URL(hostUrl);
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    if (robotsCache.has(u.host)) return robotsCache.get(u.host);

    const res = await axios.get(robotsUrl, { timeout: 8000, validateStatus: s => s >= 200 && s < 400 });
    const lines = String(res.data || '').split('\n');
    const disallow = [];
    const sitemaps = [];
    let uaBlock = false;
    let inAll = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [k, ...rest] = line.split(':');
      const key = (k || '').trim().toLowerCase();
      const value = (rest.join(':') || '').trim();
      if (key === 'user-agent') {
        uaBlock = value === '*' || value.toLowerCase().includes(userAgent.toLowerCase());
        inAll = value === '*';
      } else if ((uaBlock || inAll) && key === 'disallow') {
        if (value) disallow.push(value);
      } else if (key === 'sitemap') {
        if (value) sitemaps.push(value);
      }
    }
    const rec = { disallow, sitemaps, fetchedAt: Date.now() };
    robotsCache.set(u.host, rec);
    return rec;
  } catch {
    const rec = { disallow: [], sitemaps: [], fetchedAt: Date.now() };
    try { robotsCache.set(new URL(hostUrl).host, rec); } catch {}
    return rec;
  }
}

function isAllowedByRobots(u, disallow) {
  try {
    const url = new URL(u);
    const path = url.pathname || '/';
    for (const rule of disallow || []) {
      if (!rule) continue;
      if (rule === '/') return false;
      if (path.startsWith(rule)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

async function parseSitemap(url) {
  try {
    const res = await axios.get(url, { timeout: 10000, responseType: 'text', validateStatus: s => s >= 200 && s < 400 });
    const xml = String(res.data || '');
    const urls = [];
    // simple extraction of <loc>...</loc>
    const re = /<loc>([^<]+)<\/loc>/gi;
    let m;
    while ((m = re.exec(xml)) && urls.length < 500) {
      urls.push(m[1]);
    }
    return urls;
  } catch {
    return [];
  }
}

// ------------------------- Crawler -------------------------

async function fetchPage(url, userAgent = 'GenieSearchBot/1.0 (+https://example.com/bot)') {
  const res = await axios.get(url, {
    responseType: 'text',
    maxRedirects: 5,
    timeout: 15000,
    headers: {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    validateStatus: s => s >= 200 && s < 400
  });
  const lastModified = res.headers['last-modified'] || null;
  const contentType = res.headers['content-type'] || '';
  return { html: res.data, finalUrl: res.request?.res?.responseUrl || url, lastModified, contentType };
}

function extractLinks($, baseUrl) {
  const links = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const u = new URL(href, baseUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        u.hash = '';
        links.add(u.toString());
      }
    } catch { /* ignore */ }
  });
  return Array.from(links);
}

function extractText($) {
  $('script, style, noscript').remove();
  const text = $('body').text();
  return normalizeText(text);
}

function extractTitleAndDescription($) {
  const title = normalizeText($('title').first().text());
  const description = normalizeText($('meta[name=description]').attr('content') || '');
  const canonical = normalizeText($('link[rel="canonical"]').attr('href') || '');
  return { title, description, canonical };
}

function addToIndex(url, title, description, text, discoveredAt, lastModified, canonical, contentHash) {
  // Assign docId
  let docId = indexState.docIdByUrl[url];
  if (docId === undefined) {
    docId = indexState.N++;
    indexState.docIdByUrl[url] = docId;
  }

  const tokens = tokenize([title, description, text].join(' '));
  const length = tokens.length;

  // term frequencies
  const tfMap = {};
  for (const t of tokens) tfMap[t] = (tfMap[t] || 0) + 1;

  // update inverted index and df
  for (const [term, tf] of Object.entries(tfMap)) {
    if (!indexState.ii[term]) indexState.ii[term] = {};
    if (!indexState.ii[term][docId]) {
      indexState.df[term] = (indexState.df[term] || 0) + 1;
    }
    indexState.ii[term][docId] = tf;
  }

  indexState.pages[docId] = {
    url, title, description, length,
    text: text.slice(0, 40000), // cap text size for storage
    discoveredAt, lastModified, canonical, contentHash
  };

  return docId;
}

function computeAuthority(graph, nodes) {
  // Simple PageRank
  const d = 0.85;
  const nodeIds = nodes; // array of docIds
  const n = nodeIds.length;
  if (n === 0) return {};

  const outdeg = new Map();
  const inlinks = new Map();
  for (const i of nodeIds) {
    const outs = graph[i] || [];
    outdeg.set(i, outs.length);
    for (const j of outs) {
      if (!inlinks.has(j)) inlinks.set(j, []);
      inlinks.get(j).push(i);
    }
  }
  let rank = new Map(nodeIds.map(i => [i, 1 / n]));
  for (let iter = 0; iter < 15; iter++) {
    const newRank = new Map();
    for (const i of nodeIds) {
      let sum = 0;
      const incoming = inlinks.get(i) || [];
      for (const j of incoming) {
        const od = outdeg.get(j) || 0;
        sum += (rank.get(j) || 0) / (od || n); // distribute sink nodes uniformly
      }
      newRank.set(i, (1 - d) / n + d * sum);
    }
    rank = newRank;
  }
  let max = 0;
  for (const v of rank.values()) max = Math.max(max, v);
  const norm = {};
  for (const [k, v] of rank.entries()) {
    norm[k] = max ? v / max : 0;
  }
  return norm;
}

async function crawl({ seeds, maxPages = 50, sameDomainOnly = true, userAgent }) {
  crawlState.running = true;
  crawlState.startedAt = new Date().toISOString();
  crawlState.finishedAt = null;
  crawlState.message = 'crawling';
  crawlState.visitedCount = 0;
  crawlCancel.cancel = false;

  const queue = [];
  const visited = new Set();

  const graphs = {}; // docId -> [docId, ...]
  const seedHosts = new Set();

  for (const s of seeds) {
    try {
      const u = new URL(s);
      seedHosts.add(u.host);
      queue.push(u.toString());
      // preload robots + sitemap
      const rb = await getRobots(u.toString());
      for (const sm of rb.sitemaps.slice(0, 3)) {
        const urls = await parseSitemap(sm);
        for (const su of urls.slice(0, 200)) {
          try {
            const nu = new URL(su);
            if (sameDomainOnly && nu.host !== u.host) continue;
            const nustr = nu.toString();
            if (!queue.includes(nustr)) queue.push(nustr);
          } catch {}
        }
      }
    } catch { /* ignore malformed */}
  }

  while (queue.length && crawlState.visitedCount < maxPages) {
    if (crawlCancel.cancel) break;
    crawlState.queueLength = queue.length;

    const url = queue.shift();
    if (visited.has(url)) continue;

    // robots allow?
    try {
      const u = new URL(url);
      const robots = await getRobots(url);
      if (!isAllowedByRobots(url, robots.disallow)) {
        continue;
      }
      // simple per-host crawl delay
      const last = hostLastFetch.get(u.host) || 0;
      const wait = Math.max(0, CRAWL_DELAY_MS - (Date.now() - last));
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      hostLastFetch.set(u.host, Date.now());
    } catch {}

    visited.add(url);

    try {
      const { html, finalUrl, lastModified, contentType } = await fetchPage(url, userAgent);
      if (!/text\/html/i.test(contentType || '')) continue;

      const $ = cheerio.load(html);
      const { title, description, canonical } = extractTitleAndDescription($);
      const text = extractText($);

      // canonical normalization
      let finalDocUrl = finalUrl;
      if (canonical) {
        try { finalDocUrl = new URL(canonical, finalUrl).toString(); } catch {}
      }

      // duplicate detection by content hash
      const hash = sha256(text);
      let duplicate = false;
      for (const p of Object.values(indexState.pages)) {
        if (p.contentHash && p.contentHash === hash) { duplicate = true; break; }
      }
      if (duplicate) continue;

      const nowIso = new Date().toISOString();
      const docId = addToIndex(finalDocUrl, title || finalDocUrl, description, text, nowIso, lastModified, canonical, hash);

      // links
      const links = extractLinks($, finalDocUrl);
      const outDocIds = [];
      for (const l of links) {
        try {
          const u = new URL(l, finalDocUrl);
          if (sameDomainOnly && !seedHosts.has(u.host)) continue;
          const normalized = u.toString();
          if (!visited.has(normalized) && !queue.includes(normalized)) {
            queue.push(normalized);
          }
          let toId = indexState.docIdByUrl[normalized];
          if (toId === undefined) {
            toId = indexState.N;
          }
          outDocIds.push(toId);
        } catch { /* ignore */ }
      }
      graphs[docId] = outDocIds;

      crawlState.visitedCount++;
    } catch (err) {
      // Skip on errors
    }
  }

  // Rebuild graph with actual docIds only
  const existingIds = Object.keys(indexState.pages).map(x => parseInt(x, 10));
  const graph = {};
  for (const i of existingIds) {
    const outs = graphs[i] || [];
    graph[i] = outs.filter(j => indexState.pages[j] !== undefined);
  }

  // Save graph to file (optional debugging/reference)
  await ensureDataDir();
  await fs.writeFile(GRAPH_FILE, JSON.stringify(graph, null, 2));

  // Compute authority and persist
  indexState.authority = computeAuthority(graph, existingIds);

  await saveIndex();

  crawlState.running = false;
  crawlState.finishedAt = new Date().toISOString();
  crawlState.message = 'idle';
  crawlState.queueLength = queue.length;
}

// ------------------------- Search -------------------------

function bm25ishScore(queryTokens) {
  const scores = new Map();
  const docTitleHits = new Map();

  const seen = new Set();
  const qt = [];
  for (const t of queryTokens) {
    if (!seen.has(t)) {
      seen.add(t);
      qt.push(t);
    }
  }

  const N = indexState.N || 1;

  for (const term of qt) {
    const postings = indexState.ii[term];
    const df = indexState.df[term] || 0;
    if (!postings || df === 0) continue;

    const idf = Math.log(1 + N / (1 + df));

    for (const [docIdStr, tf] of Object.entries(postings)) {
      const docId = parseInt(docIdStr, 10);
      const base = Math.sqrt(tf) * idf;
      scores.set(docId, (scores.get(docId) || 0) + base);

      // title hits
      const title = (indexState.pages[docId]?.title || '').toLowerCase();
      if (title.includes(term)) {
        docTitleHits.set(docId, (docTitleHits.get(docId) || 0) + 1);
      }
    }
  }

  // Finalize with boosts
  const results = [];
  const now = Date.now();
  for (const [docId, base] of scores.entries()) {
    const page = indexState.pages[docId];
    if (!page) continue;

    const titleHit = docTitleHits.get(docId) || 0;
    const titleBoost = 1 + Math.min(0.15 * titleHit, 0.6);

    const phrase = queryTokens.join(' ');
    const hasPhrase = (page.text || '').toLowerCase().includes(phrase) ? 1 : 0;
    const phraseBoost = hasPhrase ? 1.25 : 1.0;

    // Recency half-life of 180 days
    const discovered = new Date(page.discoveredAt || now).getTime();
    const ageDays = Math.max(0, (now - discovered) / (1000 * 60 * 60 * 24));
    const recencyMul = Math.pow(0.5, ageDays / 180); // 1.0 -> ~0.5 at 6 months
    const recency = 0.8 + 0.2 * recencyMul;         // bound impact

    const depth = urlDepth(page.url);
    const depthMul = Math.max(0.8, 1 - depth * 0.03);

    const authority = indexState.authority[docId] || 0;
    const authorityMul = 0.8 + 0.2 * authority;

    const finalScore = base * titleBoost * phraseBoost * recency * depthMul * authorityMul;

    results.push({ docId, score: finalScore });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function makeSnippet(text, tokens, maxLen = 180) {
  const lower = (text || '').toLowerCase();
  let idx = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i !== -1) {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    return (text || '').slice(0, maxLen) + ((text || '').length > maxLen ? '…' : '');
  }
  const start = Math.max(0, idx - Math.floor(maxLen / 2));
  const end = Math.min(text.length, start + maxLen);
  let snippet = text.slice(start, end);
  // highlight simple occurrences
  for (const t of tokens) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\// Minimal full-stack search engine with crawler + ranker
// Start: npm install && npm start

const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const compression = require('compression');
const cheerio = require('cheerio');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const PAGES_FILE = path.join(DATA_DIR, 'pages.json');
const GRAPH_FILE = path.join(DATA_DIR, 'graph.json');

app.use(express.json({ limit: '2mb' }));
app.use(compression());

// Serve static website from project root
app.use(express.static(__dirname, { extensions: ['html'] }));

// ------------------------- Utilities -------------------------

async function ensureDataDir() {
  if (!fsSync.existsSync(DATA_DIR)) {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

// Lightweight stopword list
const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','but','by','for','if','in','into','is',
  'it','no','not','of','on','or','such','that','the','their','then','there',
  'these','they','this','to','was','will','with','your','you','from','we','our',
  'than','so','about','can','all','any','more','most','other','some','what','when',
  'which','who','whom','where','why','how'
]);

function normalizeText(s) {
  if (!s) return '';
  return s
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t && t.length > 2 && !STOPWORDS.has(t));
}

function urlDepth(u) {
  try {
    const { pathname } = new URL(u);
    const parts = pathname.split('/').filter(Boolean);
    return parts.length;
  } catch {
    return 0;
  }
}

// ------------------------- In-memory State -------------------------

let indexState = {
  N: 0,                            // number of documents
  df: {},                          // document frequency per term
  ii: {},                          // inverted index: term -> { docId: tf }
  docIdByUrl: {},                  // url -> docId
  pages: {},                       // docId -> { url, title, description, text, length, discoveredAt, lastModified }
  authority: {}                    // docId -> rank [0..1]
};

let crawlState = {
  running: false,
  queueLength: 0,
  visitedCount: 0,
  startedAt: null,
  finishedAt: null,
  message: 'idle'
};

// ------------------------- Persistence -------------------------

async function loadIndex() {
  try {
    if (fsSync.existsSync(INDEX_FILE)) {
      const buf = await fs.readFile(INDEX_FILE, 'utf-8');
      const data = JSON.parse(buf);
      indexState.N = data.N || 0;
      indexState.df = data.df || {};
      indexState.ii = data.ii || {};
      indexState.docIdByUrl = data.docIdByUrl || {};
      indexState.authority = data.authority || {};
    }
    if (fsSync.existsSync(PAGES_FILE)) {
      const buf = await fs.readFile(PAGES_FILE, 'utf-8');
      indexState.pages = JSON.parse(buf) || {};
    }
  } catch (err) {
    console.error('Failed to load index:', err);
  }
}

async function saveIndex() {
  await ensureDataDir();
  const { N, df, ii, docIdByUrl, authority } = indexState;
  await fs.writeFile(INDEX_FILE, JSON.stringify({ N, df, ii, docIdByUrl, authority }, null, 2));
  await fs.writeFile(PAGES_FILE, JSON.stringify(indexState.pages, null, 2));
}

// ------------------------- Crawler -------------------------

async function fetchPage(url, userAgent = 'GenieSearchBot/1.0 (+https://example.com/bot)') {
  const res = await axios.get(url, {
    responseType: 'text',
    maxRedirects: 5,
    timeout: 15000,
    headers: {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    validateStatus: s => s >= 200 && s < 400
  });
  const lastModified = res.headers['last-modified'] || null;
  return { html: res.data, finalUrl: res.request?.res?.responseUrl || url, lastModified };
}

function extractLinks($, baseUrl) {
  const links = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const u = new URL(href, baseUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        // strip hash
        u.hash = '';
        links.add(u.toString());
      }
    } catch { /* ignore */ }
  });
  return Array.from(links);
}

function extractText($) {
  $('script, style, noscript').remove();
  const text = $('body').text();
  return normalizeText(text);
}

function extractTitleAndDescription($) {
  const title = normalizeText($('title').first().text());
  const description = normalizeText($('meta[name=description]').attr('content') || '');
  return { title, description };
}

function addToIndex(url, title, description, text, discoveredAt, lastModified) {
  // Assign docId
  let docId = indexState.docIdByUrl[url];
  if (docId === undefined) {
    docId = indexState.N++;
    indexState.docIdByUrl[url] = docId;
  }

  const tokens = tokenize([title, description, text].join(' '));
  const length = tokens.length;

  // term frequencies
  const tfMap = {};
  for (const t of tokens) tfMap[t] = (tfMap[t] || 0) + 1;

  // update inverted index and df
  for (const [term, tf] of Object.entries(tfMap)) {
    if (!indexState.ii[term]) indexState.ii[term] = {};
    if (!indexState.ii[term][docId]) {
      indexState.df[term] = (indexState.df[term] || 0) + 1;
    }
    indexState.ii[term][docId] = tf;
  }

  indexState.pages[docId] = {
    url, title, description, length,
    text: text.slice(0, 40000), // cap text size for storage
    discoveredAt, lastModified
  };

  return docId;
}

function computeAuthority(graph, nodes) {
  // Simple PageRank
  const d = 0.85;
  const nodeIds = nodes; // array of docIds
  const n = nodeIds.length;
  if (n === 0) return {};

  const outdeg = new Map();
  const inlinks = new Map();
  for (const i of nodeIds) {
    const outs = graph[i] || [];
    outdeg.set(i, outs.length);
    for (const j of outs) {
      if (!inlinks.has(j)) inlinks.set(j, []);
      inlinks.get(j).push(i);
    }
  }
  let rank = new Map(nodeIds.map(i => [i, 1 / n]));
  for (let iter = 0; iter < 15; iter++) {
    const newRank = new Map();
    for (const i of nodeIds) {
      let sum = 0;
      const incoming = inlinks.get(i) || [];
      for (const j of incoming) {
        const od = outdeg.get(j) || 0;
        sum += (rank.get(j) || 0) / (od || n); // distribute sink nodes uniformly
      }
      newRank.set(i, (1 - d) / n + d * sum);
    }
    rank = newRank;
  }
  let max = 0;
  for (const v of rank.values()) max = Math.max(max, v);
  const norm = {};
  for (const [k, v] of rank.entries()) {
    norm[k] = max ? v / max : 0;
  }
  return norm;
}

async function crawl({ seeds, maxPages = 50, sameDomainOnly = true, userAgent }) {
  crawlState.running = true;
  crawlState.startedAt = new Date().toISOString();
  crawlState.finishedAt = null;
  crawlState.message = 'crawling';
  crawlState.visitedCount = 0;

  const queue = [];
  const visited = new Set();

  const graphs = {}; // docId -> [docId, ...]
  const seedHosts = new Set();

  for (const s of seeds) {
    try {
      const u = new URL(s);
      seedHosts.add(u.host);
      queue.push(u.toString());
    } catch { /* ignore malformed */}
  }

  while (queue.length && crawlState.visitedCount < maxPages) {
    crawlState.queueLength = queue.length;

    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const { html, finalUrl, lastModified } = await fetchPage(url, userAgent);
      const $ = cheerio.load(html);
      const text = extractText($);
      const { title, description } = extractTitleAndDescription($);

      const nowIso = new Date().toISOString();
      const docId = addToIndex(finalUrl, title || finalUrl, description, text, nowIso, lastModified);

      // links
      const links = extractLinks($, finalUrl);
      const outDocIds = [];
      for (const l of links) {
        try {
          const u = new URL(l, finalUrl);
          if (sameDomainOnly && !seedHosts.has(u.host)) continue;
          const normalized = u.toString();
          if (!visited.has(normalized) && !queue.includes(normalized)) {
            queue.push(normalized);
          }
          // register potential docId for graph
          let toId = indexState.docIdByUrl[normalized];
          if (toId === undefined) {
            // temporarily assign to ensure stable mapping when computing graph later
            toId = indexState.N;
          }
          outDocIds.push(toId);
        } catch { /* ignore */ }
      }
      graphs[docId] = outDocIds;

      crawlState.visitedCount++;
    } catch (err) {
      // Skip on errors
    }
  }

  // Rebuild graph with actual docIds only
  const existingIds = Object.keys(indexState.pages).map(x => parseInt(x, 10));
  const graph = {};
  for (const i of existingIds) {
    const outs = graphs[i] || [];
    graph[i] = outs.filter(j => indexState.pages[j] !== undefined);
  }

  // Save graph to file (optional debugging/reference)
  await ensureDataDir();
  await fs.writeFile(GRAPH_FILE, JSON.stringify(graph, null, 2));

  // Compute authority and persist
  indexState.authority = computeAuthority(graph, existingIds);

  await saveIndex();

  crawlState.running = false;
  crawlState.finishedAt = new Date().toISOString();
  crawlState.message = 'idle';
  crawlState.queueLength = queue.length;
}

// ------------------------- Search -------------------------

function bm25ishScore(queryTokens) {
  const scores = new Map();
  const docTitleHits = new Map();

  const seen = new Set();
  const qt = [];
  for (const t of queryTokens) {
    if (!seen.has(t)) {
      seen.add(t);
      qt.push(t);
    }
  }

  const N = indexState.N || 1;

  for (const term of qt) {
    const postings = indexState.ii[term];
    const df = indexState.df[term] || 0;
    if (!postings || df === 0) continue;

    const idf = Math.log(1 + N / (1 + df));

    for (const [docIdStr, tf] of Object.entries(postings)) {
      const docId = parseInt(docIdStr, 10);
      const base = Math.sqrt(tf) * idf;
      scores.set(docId, (scores.get(docId) || 0) + base);

      // title hits
      const title = (indexState.pages[docId]?.title || '').toLowerCase();
      if (title.includes(term)) {
        docTitleHits.set(docId, (docTitleHits.get(docId) || 0) + 1);
      }
    }
  }

  // Finalize with boosts
  const results = [];
  const now = Date.now();
  for (const [docId, base] of scores.entries()) {
    const page = indexState.pages[docId];
    if (!page) continue;

    const titleHit = docTitleHits.get(docId) || 0;
    const titleBoost = 1 + Math.min(0.15 * titleHit, 0.6);

    const phrase = queryTokens.join(' ');
    const hasPhrase = (page.text || '').toLowerCase().includes(phrase) ? 1 : 0;
    const phraseBoost = hasPhrase ? 1.25 : 1.0;

    // Recency half-life of 180 days
    const discovered = new Date(page.discoveredAt || now).getTime();
    const ageDays = Math.max(0, (now - discovered) / (1000 * 60 * 60 * 24));
    const recencyMul = Math.pow(0.5, ageDays / 180); // 1.0 -> ~0.5 at 6 months
    const recency = 0.8 + 0.2 * recencyMul;         // bound impact

    const depth = urlDepth(page.url);
    const depthMul = Math.max(0.8, 1 - depth * 0.03);

    const authority = indexState.authority[docId] || 0;
    const authorityMul = 0.8 + 0.2 * authority;

    const finalScore = base * titleBoost * phraseBoost * recency * depthMul * authorityMul;

    results.push({ docId, score: finalScore });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function makeSnippet(text, tokens, maxLen = 180) {
  const lower = (text || '').toLowerCase();
  let idx = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i !== -1) {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    return (text || '').slice(0, maxLen) + ((text || '').length > maxLen ? '…' : '');
  }
  const start = Math.max(0, idx - Math.floor(maxLen / 2));
  const end = Math.min(text.length, start + maxLen);
  let snippet = text.slice(start, end);
  // highlight simple occurrences
  for (const t of tokens) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')})`, 'ig');
    snippet = snippet.replace(re, '<mark>$1</mark>');
  }
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  return snippet;
}

// ------------------------- API -------------------------

app.get('/api/status', (req, res) => {
  res.json({
    crawl: crawlState,
    index: {
      documents: indexState.N,
      terms: Object.keys(indexState.df).length
    }
  });
});

app.post('/api/crawl', async (req, res) => {
  try {
    const { seeds, maxPages, sameDomainOnly, userAgent } = req.body || {};
    if (crawlState.running) {
      return res.status(409).json({ ok: false, message: 'A crawl is already in progress' });
    }
    if (!Array.isArray(seeds) || seeds.length === 0) {
      return res.status(400).json({ ok: false, message: 'Provide seeds: string[] of URLs' });
    }
    const normalizedSeeds = [];
    for (const s of seeds) {
      try { normalizedSeeds.push(new URL(s).toString()); } catch {}
    }
    if (normalizedSeeds.length === 0) {
      return res.status(400).json({ ok: false, message: 'No valid seed URLs provided' });
    }

    // Launch crawl without blocking response
    setImmediate(async () => {
      try {
        await crawl({
          seeds: normalizedSeeds,
          maxPages: Math.min(Number(maxPages) || 50, 500),
          sameDomainOnly: sameDomainOnly !== false,
          userAgent
        });
      } catch (err) {
        crawlState.running = false;
        crawlState.message = 'error';
        crawlState.finishedAt = new Date().toISOString();
      }
    });

    res.json({ ok: true, message: 'Crawl started', seeds: normalizedSeeds });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Failed to start crawl' });
  }
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));
  if (!q) return res.json({ ok: true, query: q, results: [] });

  const tokens = tokenize(q);
  if (tokens.length === 0) return res.json({ ok: true, query: q, results: [] });

  const ranked = bm25ishScore(tokens).slice(0, limit);
  const results = ranked.map(r => {
    const page = indexState.pages[r.docId];
    const snippet = makeSnippet(page.text || '', tokens);
    return {
      title: page.title || page.url,
      url: page.url,
      score: Number(r.score.toFixed(4)),
      snippet
    };
  });
  res.json({ ok: true, query: q, count: results.length, results });
});

// ------------------------- Boot -------------------------

(async function boot() {
  await ensureDataDir();
  await loadIndex();

  app.listen(PORT, () => {
    console.log(`Genie Search listening on http://localhost:${PORT}`);
  });
})();')})`, 'ig');
    snippet = snippet.replace(re, '<mark>$1</mark>');
  }
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  return snippet;
}

// ------------------------- API -------------------------

app.get('/api/status', (req, res) => {
  res.json({
    crawl: crawlState,
    index: {
      documents: indexState.N,
      terms: Object.keys(indexState.df).length
    }
  });
});

// Start crawl
app.post('/api/crawl', async (req, res) => {
  try {
    const { seeds, maxPages, sameDomainOnly, userAgent } = req.body || {};
    if (crawlState.running) {
      return res.status(409).json({ ok: false, message: 'A crawl is already in progress' });
    }
    if (!Array.isArray(seeds) || seeds.length === 0) {
      return res.status(400).json({ ok: false, message: 'Provide seeds: string[] of URLs' });
    }
    const normalizedSeeds = [];
    for (const s of seeds) {
      try { normalizedSeeds.push(new URL(s).toString()); } catch {}
    }
    if (normalizedSeeds.length === 0) {
      return res.status(400).json({ ok: false, message: 'No valid seed URLs provided' });
    }

    // Launch crawl without blocking response
    setImmediate(async () => {
      try {
        await crawl({
          seeds: normalizedSeeds,
          maxPages: Math.min(Number(maxPages) || 50, 500),
          sameDomainOnly: sameDomainOnly !== false,
          userAgent
        });
      } catch (err) {
        crawlState.running = false;
        crawlState.message = 'error';
        crawlState.finishedAt = new Date().toISOString();
      }
    });

    res.json({ ok: true, message: 'Crawl started', seeds: normalizedSeeds });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Failed to start crawl' });
  }
});

// Stop crawl
app.post('/api/crawl/stop', (req, res) => {
  if (!crawlState.running) {
    return res.json({ ok: true, message: 'Crawler not running' });
  }
  crawlCancel.cancel = true;
  res.json({ ok: true, message: 'Stopping crawler…' });
});

// Clear index
app.post('/api/index/clear', async (req, res) => {
  try {
    indexState = { N: 0, df: {}, ii: {}, docIdByUrl: {}, pages: {}, authority: {} };
    await ensureDataDir();
    for (const f of [INDEX_FILE, PAGES_FILE, GRAPH_FILE]) {
      if (fsSync.existsSync(f)) await fs.unlink(f).catch(() => {});
    }
    res.json({ ok: true, message: 'Index cleared' });
  } catch {
    res.status(500).json({ ok: false, message: 'Failed to clear index' });
  }
});

// Suggestions
app.get('/api/suggest', (req, res) => {
  const q = (req.query.q || '').toString().toLowerCase().trim();
  if (!q || q.length < 2) return res.json({ ok: true, suggestions: [] });
  const out = [];
  for (const term of Object.keys(indexState.df)) {
    if (term.startsWith(q)) {
      out.push({ term, df: indexState.df[term] || 0 });
    }
  }
  out.sort((a, b) => b.df - a.df);
  res.json({ ok: true, suggestions: out.slice(0, 8).map(x => x.term) });
});

// Search with site: and pagination and phrase parsing
app.get('/api/search', (req, res) => {
  const raw = (req.query.q || '').toString().trim();
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  if (!raw) return res.json({ ok: true, query: raw, results: [] });

  // Parse phrase in quotes and site:domain
  const phraseMatch = raw.match(/"([^"]+)"/);
  const forcedPhrase = phraseMatch ? phraseMatch[1].toLowerCase() : null;
  const siteMatch = raw.match(/\\bsite:([^\\s]+)/i);
  const siteFilter = siteMatch ? siteMatch[1].toLowerCase() : null;

  let cleaned = raw.replace(/"[^"]*"/g, ' ').replace(/\\bsite:[^\\s]+/ig, ' ').trim();
  const tokens = tokenize(cleaned);
  if (forcedPhrase) tokens.push(...tokenize(forcedPhrase));

  if (tokens.length === 0) return res.json({ ok: true, query: raw, results: [] });

  const ranked = bm25ishScore(tokens);
  let items = ranked;

  // site filter
  if (siteFilter) {
    items = items.filter(r => {
      const url = (indexState.pages[r.docId]?.url || '').toLowerCase();
      try {
        const h = new URL(url).host.toLowerCase();
        return h.includes(siteFilter);
      } catch { return false; }
    });
  }

  // phrase enforcement if quotes used
  if (forcedPhrase) {
    const ph = forcedPhrase;
    items = items.filter(r => {
      const t = (indexState.pages[r.docId]?.text || '').toLowerCase();
      return t.includes(ph);
    });
  }

  const paged = items.slice(offset, offset + limit);
  const results = paged.map(r => {
    const page = indexState.pages[r.docId];
    const snippet = makeSnippet(page.text || '', tokens);
    return {
      title: page.title || page.url,
      url: page.url,
      score: Number(r.score.toFixed(4)),
      snippet
    };
  });
  res.json({ ok: true, query: raw, count: items.length, offset, limit, results });
});

// ------------------------- Boot -------------------------

(async function boot() {
  await ensureDataDir();
  await loadIndex();

  app.listen(PORT, () => {
    console.log(`Genie Search listening on http://localhost:${PORT}`);
  });
})();