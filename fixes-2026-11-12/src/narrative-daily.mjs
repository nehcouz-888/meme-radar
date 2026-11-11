// Narrative daily filter (direction 2). READ-ONLY.
// Take Weibo + X hot events and keep only "tokenizable" candidates:
// person / brand / meme name / abbrev. Alerts/research only.
import fs from 'node:fs';
import path from 'node:path';

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

export function narrativeDailyConfig(overrides = {}) {
  return {
    enabled: E('NARRATIVE_DAILY', '1') !== '0',
    sources: String(E('NARRATIVE_SOURCES', 'weibo_hot,x_hot')).split(',').map(s => s.trim()).filter(Boolean),
    tokenizableKinds: ['person', 'brand', 'meme_name', 'abbrev'],
    minNameLen: Number(E('NARRATIVE_MIN_NAME_LEN', 2)),
    maxNameLen: Number(E('NARRATIVE_MAX_NAME_LEN', 32)),
    maxCandidates: Number(E('NARRATIVE_MAX_CANDIDATES', 40)),
    blocklist: String(E('NARRATIVE_BLOCKLIST', '比特币,以太坊,bitcoin,ethereum,btc,eth,sol,bnb,usdt,usdc')).split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    ...overrides
  };
}

const STOP = new Set(['的', '了', '是', '在', '和', '与', '或', 'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'on', 'in', '热搜', '热点', '今日', '今天']);

/** Heuristic kind classifier for a hot title/name. Pure. */
export function classifyTokenizable(raw, cfg = narrativeDailyConfig()) {
  const name = String(raw || '').trim();
  if (!name) return { ok: false, reason: 'empty' };
  const compact = name.replace(/\s+/g, '');
  if (compact.length < cfg.minNameLen || compact.length > cfg.maxNameLen) return { ok: false, reason: 'length' };
  const lower = name.toLowerCase();
  if (cfg.blocklist.some(b => lower === b || lower.includes(b))) return { ok: false, reason: 'blocklist' };
  if (STOP.has(lower) || STOP.has(compact)) return { ok: false, reason: 'stopword' };
  // URLs / CA-like discarded as narrative names
  if (/https?:\/\//i.test(name) || /\b0x[a-fA-F0-9]{40}\b/.test(name) || /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.test(name)) {
    return { ok: false, reason: 'address_or_url' };
  }
  let kind = 'meme_name';
  if (/^[A-Z]{2,6}$/.test(compact) || /^[A-Za-z]{2,6}$/.test(compact) && compact === compact.toUpperCase()) kind = 'abbrev';
  else if (/(公司|品牌|集团|ltd|gmbh|studio)/i.test(name) || /\b(inc|ltd|corp|brand)\b/i.test(name)) kind = 'brand';
  else if (/[\u4e00-\u9fff]{2,4}$/.test(compact) && !/[0-9]/.test(compact) && compact.length <= 4) kind = 'person'; // short CJK often person/meme
  else if (/\b(elon|trump|musk|cz|hey[ií]|vitalik)\b/i.test(name)) kind = 'person';
  if (!cfg.tokenizableKinds.includes(kind)) return { ok: false, reason: 'kind_disabled', kind };
  return { ok: true, kind, name: name.slice(0, cfg.maxNameLen), compact };
}

/**
 * events: [{ source: 'weibo_hot'|'x_hot', title|name|text, rank?, hot?, at? }]
 * Returns ranked tokenizable candidates.
 */
export function filterTokenizableEvents(events, cfg = narrativeDailyConfig()) {
  if (!cfg.enabled) return [];
  const allowSrc = new Set(cfg.sources);
  const seen = new Map();
  for (const e of events || []) {
    const src = String(e.source || '').toLowerCase();
    if (allowSrc.size && !allowSrc.has(src)) continue;
    const raw = e.title || e.name || e.text || e.keyword || '';
    const c = classifyTokenizable(raw, cfg);
    if (!c.ok) continue;
    const key = c.compact.toLowerCase();
    const prev = seen.get(key);
    const row = {
      name: c.name,
      kind: c.kind,
      source: src,
      rank: e.rank ?? null,
      hot: e.hot ?? null,
      at: e.at || null,
      raw
    };
    if (!prev) seen.set(key, row);
    else {
      // merge sources
      const sources = new Set(String(prev.sources || prev.source).split('+').filter(Boolean));
      sources.add(src);
      prev.sources = [...sources].join('+');
      if ((e.rank ?? 999) < (prev.rank ?? 999)) prev.rank = e.rank;
      if ((e.hot ?? 0) > (prev.hot ?? 0)) prev.hot = e.hot;
    }
  }
  const list = [...seen.values()].map(x => ({ ...x, sources: x.sources || x.source }));
  list.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || (b.hot ?? 0) - (a.hot ?? 0));
  return list.slice(0, cfg.maxCandidates);
}

export function appendHotEvent(file, event) {
  const row = {
    source: String(event.source || ''),
    title: event.title || event.name || event.text || '',
    rank: event.rank ?? null,
    hot: event.hot ?? null,
    at: event.at || new Date().toISOString()
  };
  if (!row.source || !row.title) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

export function readHotEvents(file, { limit = 2000 } = {}) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit);
  const out = [];
  for (const line of lines) { try { out.push(JSON.parse(line)); } catch {} }
  return out;
}

export function formatNarrativeDigest(candidates) {
  const lines = ['叙事日筛 (可代币化候选，微博+X 热)', `共 ${candidates.length} 条`, ''];
  candidates.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.name} [${c.kind}] 来源:${c.sources || c.source}${c.rank != null ? ` 排名:${c.rank}` : ''}`);
  });
  lines.push('', '仅研究提醒，不自动交易。可对同名低市值币做 SOL/BSC 检索。');
  return lines.join('\n');
}
