// Narrative daily filter (direction 2). READ-ONLY.
// Take Weibo + X hot events and keep only "tokenizable" candidates:
// person / brand / meme_name / abbrev. Alerts/research only.
// ✅ 2026-11-12 audit fixes: TTL freshness, noise filtering, zero candidates allowed
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
    // ✅ Fix (b): 不再填充到40，允许零候选
    maxCandidates: Number(E('NARRATIVE_MAX_CANDIDATES', 100)),  // 移除硬性40填充
    blocklist: String(E('NARRATIVE_BLOCKLIST', '比特币,以太坊,bitcoin,ethereum,btc,eth,sol,bnb,usdt,usdc')).split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    // ✅ Fix (a): TTL freshness (默认7天)
    ttlDays: Number(E('NARRATIVE_TTL_DAYS', 7)),
    ...overrides
  };
}

// ✅ Fix (b): 去除gm/gn等明显问候噪声
const STOP = new Set([
  '的', '了', '是', '在', '和', '与', '或', 
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'on', 'in', 
  '热搜', '热点', '今日', '今天',
  // ✅ 简单问候噪声
  'gm', 'gn', 'hello', 'hi', 'hey', 'bye', 'goodbye',
  // ✅ 通用问候
  '早安', '晚安', '你好', '再见', '周一', '周二', '周三', '周四', '周五', '周六', '周日'
]);

// ✅ 问候短语正则（包括Good Thursday等）
const GREETING_PATTERNS = [
  /^good\s+(morning|night|evening|afternoon|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i,
  /^happy\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i,
  /^(goodnight|goodmorning)$/i
];

/** Heuristic kind classifier for a hot title/name. Pure. */
export function classifyTokenizable(raw, cfg = narrativeDailyConfig()) {
  const name = String(raw || '').trim();
  if (!name) return { ok: false, reason: 'empty' };
  const compact = name.replace(/\s+/g, '');
  if (compact.length < cfg.minNameLen || compact.length > cfg.maxNameLen) return { ok: false, reason: 'length' };
  const lower = name.toLowerCase();
  if (cfg.blocklist.some(b => lower === b || lower.includes(b))) return { ok: false, reason: 'blocklist' };
  if (STOP.has(lower) || STOP.has(compact)) return { ok: false, reason: 'stopword' };
  
  // ✅ Fix (b): 检查问候短语
  if (GREETING_PATTERNS.some(p => p.test(name))) {
    return { ok: false, reason: 'greeting_noise' };
  }
  
  // URLs / CA-like discarded as narrative names
  if (/https?:\/\//i.test(name) || /\b0x[a-fA-F0-9]{40}\b/.test(name) || /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.test(name)) {
    return { ok: false, reason: 'address_or_url' };
  }
  
  // ✅ Fix (b): 未有可代币化证据不默认meme_name
  let kind = null;
  
  // 缩写
  if (/^[A-Z]{2,6}$/.test(compact) || /^[A-Za-z]{2,6}$/.test(compact) && compact === compact.toUpperCase()) {
    kind = 'abbrev';
  }
  // 品牌/公司
  else if (/(公司|品牌|集团|ltd|gmbh|studio)/i.test(name) || /\b(inc|ltd|corp|brand)\b/i.test(name)) {
    kind = 'brand';
  }
  // 短CJK可能是人名（但需要避免通用词汇）
  else if (/[\u4e00-\u9fff]{2,4}$/.test(compact) && !/[0-9]/.test(compact) && compact.length <= 4) {
    // 避免通用短语被识别为人名
    const commonPhrases = ['天气', '今天', '明天', '周末', '假期', '上班', '下班'];
    if (!commonPhrases.some(p => compact.includes(p))) {
      kind = 'person';
    }
  }
  // 已知人物/meme
  else if (/\b(elon|trump|musk|cz|hey[ií]|vitalik|pepe|doge|shib)\b/i.test(name)) {
    kind = 'meme_name';
  }
  // ✅ 有明确代币化特征的才认为是meme_name
  else if (/coin|token|crypto|nft|defi|web3|blockchain/i.test(name)) {
    kind = 'meme_name';
  }
  
  // ✅ 如果没有识别出kind，不默认为meme_name，直接拒绝
  if (!kind) {
    return { ok: false, reason: 'no_tokenizable_evidence' };
  }
  
  if (!cfg.tokenizableKinds.includes(kind)) return { ok: false, reason: 'kind_disabled', kind };
  return { ok: true, kind, name: name.slice(0, cfg.maxNameLen), compact };
}

/**
 * events: [{ source: 'weibo_hot'|'x_hot', title|name|text, rank?, hot?, at? }]
 * Returns ranked tokenizable candidates with TTL and first/last seen tracking.
 * ✅ Fix (a): TTL freshness, first_seen/last_seen tracking
 */
export function filterTokenizableEvents(events, cfg = narrativeDailyConfig(), { now = Date.now() } = {}) {
  if (!cfg.enabled) return [];
  
  // ✅ Fix (a): TTL筛选 - 只保留最近N天的事件
  const ttlMs = cfg.ttlDays * 24 * 3600 * 1000;
  const cutoff = now - ttlMs;
  
  const allowSrc = new Set(cfg.sources);
  const seen = new Map();
  
  for (const e of events || []) {
    const src = String(e.source || '').toLowerCase();
    if (allowSrc.size && !allowSrc.has(src)) continue;
    
    // ✅ Fix (a): TTL检查 - 过滤旧事件
    const eventAt = e.at ? new Date(e.at).getTime() : now;
    if (eventAt < cutoff) continue;  // 跳过过期事件
    
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
      at: e.at || new Date(now).toISOString(),
      raw
    };
    
    if (!prev) {
      // ✅ Fix (a): 首次见到，记录first_seen和last_seen
      row.first_seen = row.at;
      row.last_seen = row.at;
      seen.set(key, row);
    } else {
      // ✅ Fix (a): 合并来源，更新last_seen，保留first_seen
      const sources = new Set(String(prev.sources || prev.source).split('+').filter(Boolean));
      sources.add(src);
      prev.sources = [...sources].join('+');
      
      // 更新last_seen
      const prevAt = new Date(prev.last_seen || prev.at).getTime();
      const currAt = new Date(row.at).getTime();
      if (currAt > prevAt) {
        prev.last_seen = row.at;
      }
      
      // ✅ Fix (a): 更新rank和hot（保留最优值）
      if ((e.rank ?? 999) < (prev.rank ?? 999)) prev.rank = e.rank;
      if ((e.hot ?? 0) > (prev.hot ?? 0)) prev.hot = e.hot;
      
      // 更新at为最新时间
      if (currAt > new Date(prev.at).getTime()) {
        prev.at = row.at;
      }
    }
  }
  
  const list = [...seen.values()].map(x => ({ ...x, sources: x.sources || x.source }));
  
  // ✅ Fix (a): 排序优先最新事件，而非历史最佳rank
  // 先按last_seen降序（最新的在前），再按rank升序
  list.sort((a, b) => {
    const aTime = new Date(a.last_seen || a.at).getTime();
    const bTime = new Date(b.last_seen || b.at).getTime();
    if (bTime !== aTime) return bTime - aTime;  // 最新的在前
    return (a.rank ?? 999) - (b.rank ?? 999);  // 然后按rank
  });
  
  // ✅ Fix (b): 不填充到40，允许零候选
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
  // ✅ Fix (c): A级标注"叙事匹配，非链上安全验证"
  const lines = [
    '叙事日筛 (可代币化候选，微博+X 热)',
    '⚠️ A级：仅叙事匹配，非链上安全验证。仿盘不共享主币评级。',
    `共 ${candidates.length} 条`,
    ''
  ];
  
  if (candidates.length === 0) {
    lines.push('今日无符合条件的新鲜叙事候选。');
  } else {
    candidates.forEach((c, i) => {
      const timeInfo = c.first_seen && c.last_seen 
        ? ` 首见:${c.first_seen.split('T')[0]} 末见:${c.last_seen.split('T')[0]}`
        : '';
      lines.push(`${i + 1}. ${c.name} [${c.kind}] 来源:${c.sources || c.source}${c.rank != null ? ` 排名:${c.rank}` : ''}${timeInfo}`);
    });
  }
  
  lines.push('', '仅研究提醒，不自动交易。可对同名低市值币做 SOL/BSC 检索。');
  return lines.join('\n');
}
