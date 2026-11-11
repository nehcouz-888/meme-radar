// Soft-mention cluster (narrative early discovery direction 1). READ-ONLY.
// High-weight X accounts soft-mention words/memes/names (not only CA). When the same
// keyword is reused by >= minAccounts distinct high-weight accounts within windowHours
// (default 1–2h), emit a cluster and optionally search DexScreener for same-name low-MC
// tokens on SOL/BSC/(R). Alerts/research only — never trades.
import fs from 'node:fs';
import path from 'node:path';

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const n = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v))) ? null : Number(v);

export function softMentionClusterConfig(overrides = {}) {
  return {
    enabled: E('SOFT_MENTION_CLUSTER', '1') !== '0',
    minAccounts: Number(E('SOFT_MENTION_MIN_ACCOUNTS', 2)),
    windowHoursMin: Number(E('SOFT_MENTION_WINDOW_H_MIN', 1)),
    windowHoursMax: Number(E('SOFT_MENTION_WINDOW_H_MAX', 2)),
    minFollowersKol: Number(E('SOFT_MENTION_MIN_FOLLOWERS', 10000)),
    highWeightTiers: String(E('SOFT_MENTION_TIERS', 'official,founder,chain_lead,kol_alpha,kol,meme_whale')).split(',').map(s => s.trim()).filter(Boolean),
    searchChains: String(E('SOFT_MENTION_SEARCH_CHAINS', 'solana,bsc,robinhood')).split(',').map(s => s.trim()).filter(Boolean),
    followerMaxMcap: Number(E('SOFT_MENTION_FOLLOWER_MAX_MCAP', 100000)),
    eventsFile: E('SOFT_MENTION_EVENTS_FILE', '/workspace/meme-radar-run/scan-accum/narrative-early/state/soft-mention-events.jsonl'),
    outFile: E('SOFT_MENTION_OUT_FILE', '/workspace/meme-radar-run/scan-accum/narrative-early/out/soft-mention-clusters.json'),
    ...overrides
  };
}

const normKw = s => String(s || '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();

/** Is this account high-weight for soft-mention clustering? */
export function isHighWeightAccount(account = {}, cfg = softMentionClusterConfig()) {
  if (!account || account.enabled === false) return false;
  const tier = String(account.tier || account.category || '').toLowerCase();
  if (['official', 'founder', 'chain_lead'].includes(tier)) return true;
  if (!cfg.highWeightTiers.includes(tier)) return false;
  const fans = n(account.followerCount ?? account.followers);
  if (fans == null) return tier.startsWith('kol') || tier === 'meme_whale'; // unknown fans: allow listed KOL tiers
  return fans >= cfg.minFollowersKol;
}

/**
 * Append-only event shape: { handle, tier, keyword, text?, at, tweetId?, followers? }
 * keywords may be cashtags/names without CA.
 */
export function appendSoftMentionEvent(file, event) {
  const row = {
    handle: String(event.handle || '').replace(/^@/, '').toLowerCase(),
    tier: String(event.tier || ''),
    keyword: normKw(event.keyword),
    at: event.at || new Date().toISOString(),
    tweetId: event.tweetId || null,
    followers: n(event.followers),
    text: event.text ? String(event.text).slice(0, 280) : null
  };
  if (!row.handle || !row.keyword) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

export function readEvents(file, { limit = 5000 } = {}) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const slice = lines.slice(-limit);
  const out = [];
  for (const line of slice) {
    try { out.push(JSON.parse(line)); } catch { /* skip bad */ }
  }
  return out;
}

/**
 * Find keywords reused by >= minAccounts distinct high-weight handles inside windowHoursMax.
 * Uses windowHoursMax as the lookback; min is documentation of intended 1–2h band.
 */
export function findSoftMentionClusters(events, cfg = softMentionClusterConfig(), nowMs = Date.now()) {
  if (!cfg.enabled) return [];
  const windowMs = cfg.windowHoursMax * 3600e3;
  const byKw = new Map();
  for (const e of events || []) {
    const kw = normKw(e.keyword); if (!kw) continue;
    const t = Date.parse(e.at || '');
    if (!Number.isFinite(t) || nowMs - t > windowMs || t > nowMs + 60e3) continue;
    if (!isHighWeightAccount({ tier: e.tier, followerCount: e.followers, enabled: true }, cfg)) continue;
    if (!byKw.has(kw)) byKw.set(kw, []);
    byKw.get(kw).push({ ...e, keyword: kw, _t: t });
  }
  const clusters = [];
  for (const [keyword, rows] of byKw) {
    rows.sort((a, b) => a._t - b._t);
    // sliding: take latest windowHoursMax span with most distinct handles
    const handles = new Map(); // handle -> earliest in window
    let best = null;
    let left = 0;
    for (let right = 0; right < rows.length; right++) {
      const r = rows[right];
      while (left <= right && r._t - rows[left]._t > windowMs) {
        const old = rows[left];
        const h = handles.get(old.handle);
        if (h === old._t) handles.delete(old.handle);
        left++;
      }
      if (!handles.has(r.handle)) handles.set(r.handle, r._t);
      if (handles.size >= cfg.minAccounts) {
        const spanH = (r._t - rows[left]._t) / 3600e3;
        const snapshot = {
          keyword,
          accounts: [...handles.keys()],
          accountCount: handles.size,
          spanHours: Math.max(0, spanH),
          firstAt: new Date(rows[left]._t).toISOString(),
          lastAt: new Date(r._t).toISOString(),
          events: rows.slice(left, right + 1).map(({ _t, ...x }) => x)
        };
        if (!best || snapshot.accountCount > best.accountCount || (snapshot.accountCount === best.accountCount && snapshot.spanHours < best.spanHours)) best = snapshot;
      }
    }
    if (best) clusters.push(best);
  }
  clusters.sort((a, b) => b.accountCount - a.accountCount || a.spanHours - b.spanHours);
  return clusters;
}

const DS = { solana: 'solana', sol: 'solana', bsc: 'bsc', robinhood: 'robinhood', r: 'robinhood' };
const normName = s => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');

/** Filter DexScreener pairs to same-name/ticker low-MC hits on allowed chains. Pure. */
export function pickLowMcSameName(pairs, keyword, cfg = softMentionClusterConfig()) {
  const want = new Set((cfg.searchChains || []).map(c => DS[c] || c));
  const nk = normName(keyword);
  if (!nk) return [];
  const byTok = new Map();
  for (const p of pairs || []) {
    const chain = DS[p.chainId] || p.chainId;
    if (!want.has(chain)) continue;
    const sym = normName(p.baseToken?.symbol), name = normName(p.baseToken?.name);
    if (sym !== nk && name !== nk && !name.includes(nk) && !sym.includes(nk)) continue;
    const mcap = n(p.marketCap ?? p.fdv);
    if (mcap == null || mcap <= 0 || mcap > cfg.followerMaxMcap) continue;
    const a = String(p.baseToken?.address || '').toLowerCase();
    if (!a) continue;
    const liq = n(p.liquidity?.usd) || 0;
    const cur = byTok.get(`${chain}:${a}`);
    if (!cur || liq > cur.liq) {
      byTok.set(`${chain}:${a}`, {
        chain, address: p.baseToken.address, symbol: p.baseToken?.symbol, name: p.baseToken?.name,
        mcap, liq, url: p.url || null, pairAddress: p.pairAddress || null
      });
    }
  }
  return [...byTok.values()].sort((a, b) => a.mcap - b.mcap);
}

/** Build WeChat-plain digest lines (no markdown/emoji). */
export function formatClusterDigest(cluster, hits = []) {
  const lines = [];
  lines.push(`软提及聚类: ${cluster.keyword}`);
  lines.push(`高权重账号 ${cluster.accountCount} 个在 ${cluster.spanHours.toFixed(2)} 小时内复用: ${cluster.accounts.map(h => '@' + h).join(' ')}`);
  lines.push(`窗口: ${cluster.firstAt} ~ ${cluster.lastAt}`);
  if (!hits.length) lines.push('同名低市值币: 暂无 (或未跑链上搜索)');
  else {
    lines.push(`同名低市值币 (MC<=$${cfgFmt(cluster._maxMcap || 100000)}):`);
    for (const h of hits.slice(0, 8)) {
      lines.push(`- ${h.symbol || '?'} ${h.chain} MC≈$${Math.round(h.mcap)} 流动性≈$${Math.round(h.liq || 0)}`);
      lines.push(`  CA: ${h.address}`);
      if (h.url) lines.push(`  ${h.url}`);
    }
  }
  lines.push('仅研究提醒，不自动交易。');
  return lines.join('\n');
}
function cfgFmt(v) { return Number(v).toLocaleString('en-US'); }
