// Cross-chain spillover signal (added 2026-10-18). READ-ONLY research helper, no trading/posting.
// Idea: when a token leads on one chain (e.g. FTR on Solana), same-ticker/same-narrative copies on a
// follower chain (default BSC) often catch "market-cap spillover". We pick at most ONE follower per
// leader per chain (highest liquidity above a floor, tie -> earliest) to avoid rewarding a swarm of
// copy-scams, and give it a moderate bonus. Existing HARD_REJECT / risk caps still apply afterwards.
// Switch: SPILLOVER_ENABLED=0 disables (default on). Thresholds env-tunable.
const n = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v))) ? null : Number(v);
const E = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : Number(process.env[k]));
export function spilloverConfig() {
  return {
    enabled: process.env.SPILLOVER_ENABLED !== '0',
    followers: (process.env.SPILLOVER_FOLLOWER_CHAINS || 'bsc').split(',').map(s => s.trim()).filter(Boolean),
    maxLeaders: E('SPILLOVER_MAX_LEADERS', 6),
    leaderExtraChains: (process.env.SPILLOVER_LEADER_EXTRA_CHAINS ?? 'robinhood').split(',').map(s => s.trim()).filter(Boolean), // leader-only discovery (GeckoTerminal trending, free)
    followerMaxMcap: E('SPILLOVER_FOLLOWER_MAX_MCAP', 100000), // follower must be low-cap; above -> note only, no bonus
    leaderMinMcap: E('SPILLOVER_LEADER_MIN_MCAP', 1e6),
    leaderMinVol24: E('SPILLOVER_LEADER_MIN_VOL24', 5e5),
    leaderMaxMcap: E('SPILLOVER_LEADER_MAX_MCAP', 200e6), // exclude SOL/PUMP/AERO-type majors
    leaderMaxAgeH: E('SPILLOVER_LEADER_MAX_AGE_H', 336),  // meme leader must be <=14d old
    followerMinLiq: E('SPILLOVER_FOLLOWER_MIN_LIQ', 8000),
    followerMaxRatio: E('SPILLOVER_FOLLOWER_MAX_RATIO', 0.5), // follower mcap must be < 50% of leader
    followerMaxAgeH: E('SPILLOVER_FOLLOWER_MAX_AGE_H', 168),
    maxBonus: E('SPILLOVER_MAX_BONUS', 15)
  };
}
const DS2 = { solana: 'sol', bsc: 'bsc', base: 'base', ethereum: 'eth', robinhood: 'robinhood' };
export const dsChain = id => DS2[id] || id;
const norm = s => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
// Leader = non-follower-chain token with real size/heat. Returns leader strength 0..1 components.
export function isLeader(c, cfg = spilloverConfig()) {
  if (!c || c.status === 'HARD_REJECT' || c.liq == null || !c.symbol) return false;
  if ((n(c.mcap) || 0) > cfg.leaderMaxMcap) return false;
  if (n(c.ageH) == null || c.ageH > cfg.leaderMaxAgeH) return false;
  const big = (n(c.mcap) || 0) >= cfg.leaderMinMcap && (n(c.vol24) || 0) >= cfg.leaderMinVol24;
  const hot = (n(c.fomo?.trendingRank) ?? 99) <= 10 && (n(c.mcap) || 0) >= cfg.leaderMinMcap / 2;
  return big || hot;
}
export function leaderStrength(c) {
  let s = 5; const why = ['龙头基础+5'];
  if ((n(c.mcap) || 0) >= 5e6) { s += 3; why.push('龙头市值≥5M+3'); }
  if ((n(c.vol24) || 0) >= 1e6 || (n(c.chg24) || 0) >= 100) { s += 2; why.push('龙头24h量≥1M或涨≥100%+2'); }
  if ((n(c.fomo?.trendingRank) ?? 99) <= 10) { s += 2; why.push('Fomo trending Top10+2'); }
  return { pts: s, why };
}
// Name/ticker match: exact normalized symbol, or exact normalized name (catches "Flying Tesla Roadster").
export function matches(leader, p) {
  const ls = norm(leader.symbol), ln = norm(leader.name), ps = norm(p.baseToken?.symbol), pn = norm(p.baseToken?.name);
  if (ls && ps && ls === ps) return 'ticker';
  if (ln && ln.length >= 5 && (pn === ln || ps === ln)) return 'name';
  return null;
}
// pairs: DexScreener search results. Returns best follower per follower chain (or []).
export function pickFollowers(leader, pairs, cfg = spilloverConfig(), now = Date.now()) {
  const out = [];
  for (const fc of cfg.followers) {
    if (fc === leader.chain) continue;
    const byTok = new Map(), seenPair = new Set();
    for (const p of pairs || []) {
      if (seenPair.has(p.pairAddress)) continue; seenPair.add(p.pairAddress);
      if (dsChain(p.chainId) !== fc) continue;
      const how = matches(leader, p); if (!how) continue;
      const a = String(p.baseToken.address).toLowerCase(); const cur = byTok.get(a);
      // aggregate liquidity across pools of the same token; keep earliest pool time
      const liq = n(p.liquidity?.usd) || 0;
      if (!cur) byTok.set(a, { p, how, liq, created: n(p.pairCreatedAt), mcap: n(p.marketCap ?? p.fdv) });
      else { cur.liq += liq; if (n(p.pairCreatedAt) && (!cur.created || n(p.pairCreatedAt) < cur.created)) cur.created = n(p.pairCreatedAt); if (liq > (n(cur.p.liquidity?.usd) || 0)) cur.p = p; cur.mcap = cur.mcap ?? n(p.marketCap ?? p.fdv); }
    }
    const lm = n(leader.mcap) || 0;
    const ok = [...byTok.values()].filter(f => f.liq >= cfg.followerMinLiq && f.mcap != null && f.mcap > 0
      && (!lm || f.mcap < lm * cfg.followerMaxRatio) && (!f.created || (now - f.created) / 3600e3 <= cfg.followerMaxAgeH));
    ok.sort((a, b) => b.liq - a.liq || (a.created || 9e15) - (b.created || 9e15));
    if (ok[0]) out.push({ chain: fc, address: ok[0].p.baseToken.address.toLowerCase(), pair: ok[0].p, match: ok[0].how, liqTotal: ok[0].liq, created: ok[0].created, mcap: ok[0].mcap, copies: byTok.size });
  }
  return out;
}
// Bonus for the follower, scaled by leader strength and how early/small the follower is vs leader.
export function spilloverBonus(leader, f, cfg = spilloverConfig()) {
  if (n(f.mcap) != null && f.mcap > cfg.followerMaxMcap) return { pts: 0, ratio: n(leader.mcap) ? f.mcap / leader.mcap : null, why: [`跟随币市值${Math.round(f.mcap)}>上限${cfg.followerMaxMcap}，不加分(仅提示)`] };
  const ls = leaderStrength(leader); let pts = ls.pts; const why = [...ls.why];
  const ratio = (n(f.mcap) && n(leader.mcap)) ? f.mcap / leader.mcap : null;
  if (ratio != null) { if (ratio < 0.05) { pts += 3; why.push(`跟随/龙头市值${(ratio * 100).toFixed(1)}%<5%+3`); } else if (ratio < 0.2) { pts += 1; why.push(`市值比${(ratio * 100).toFixed(1)}%+1`); } else { pts -= 2; why.push(`市值比${(ratio * 100).toFixed(1)}%偏高-2`); } }
  if (f.match === 'name') { pts -= 1; why.push('仅名称匹配-1'); }
  if ((f.copies || 0) >= 5) { pts -= 2; why.push(`同名仿盘${f.copies}个-2`); }
  pts = Math.max(0, Math.min(cfg.maxBonus, pts));
  return { pts, ratio, why };
}

// ---------------- 2026-10-20 follower hard filter (user-approved). SPILLOVER_HARD_FILTER=0 disables ----------------
// Pure function. Inputs: raw GoPlus token_security record (EVM), DexScreener pair, extras { gtVol24, leaderDev, chain }.
const DEAD = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', '0xdead000000000000000042069420694206942069']);
export function hardFilterConfig() {
  return {
    enabled: process.env.SPILLOVER_HARD_FILTER !== '0',
    lpLockMin: E('HF_LP_LOCK_MIN', 0.9), top10Reject: E('HF_TOP10_REJECT', 0.30), top10Penalty: E('HF_TOP10_PENALTY_FROM', 0.20),
    singleReject: E('HF_SINGLE_HOLDER_REJECT', 0.08), top10PenaltyPts: E('HF_TOP10_PENALTY_PTS', 10),
    bundleReject: E('HF_BUNDLE_REJECT', 0.20), bundlePenalty: E('HF_BUNDLE_PENALTY_FROM', 0.10), bundlePenaltyPts: E('HF_BUNDLE_PENALTY_PTS', 10),
    volMismatchX: E('HF_VOL_MISMATCH_X', 5), avgTradeLiqMax: E('HF_AVG_TRADE_LIQ_MAX', 0.05)
  };
}
// Volume consistency, usable for any chain: returns reasons[] (empty = ok)
export function volumeCheck({ dsVol24, gtVol24, txns24, liq }, cfg = hardFilterConfig()) {
  const r = [];
  const a = n(dsVol24), b = n(gtVol24);
  if (a != null && b != null && Math.min(a, b) > 0 && Math.max(a, b) / Math.min(a, b) > cfg.volMismatchX) r.push(`多源24h成交差${(Math.max(a, b) / Math.min(a, b)).toFixed(1)}倍(DexScreener ${Math.round(a)} / GeckoTerminal ${Math.round(b)})`);
  else if (a != null && b != null && ((a > 1000 && b === 0) || (b > 1000 && a === 0))) r.push(`多源24h成交一方为0(DexScreener ${Math.round(a)} / GeckoTerminal ${Math.round(b)})`);
  const t = n(txns24), l = n(liq);
  if (a != null && t && l && a / t > l * cfg.avgTradeLiqMax) r.push(`平均每笔成交${Math.round(a / t)}>流动性${Math.round(l)}的${cfg.avgTradeLiqMax * 100}%`);
  return r;
}
export function evaluateEvmFollower(gp, pair, extra = {}, cfg = hardFilterConfig()) {
  const out = { enabled: cfg.enabled, reject: [], downgrade: [], penalty: 0, notes: [], bonusCap0: [] };
  if (!cfg.enabled) return out;
  if (!gp) { out.downgrade.push('GoPlus 无数据(安全未知)'); return out; }
  // 1) LP locked/burned >= 90%
  const lps = Array.isArray(gp.lp_holders) ? gp.lp_holders : [];
  if (!lps.length) out.reject.push('LP 持有人数据缺失(无法确认锁定/销毁)');
  else { const safe = lps.reduce((s, h) => s + ((String(h.is_locked) === '1' || DEAD.has(String(h.address).toLowerCase())) ? (n(h.percent) || 0) : 0), 0);
    if (safe < cfg.lpLockMin) out.reject.push(`LP 锁定/销毁仅${(safe * 100).toFixed(1)}%<${cfg.lpLockMin * 100}%`); else out.notes.push(`LP 锁定/销毁${(safe * 100).toFixed(1)}%`); }
  // 2) open source / owner / proxy
  if (String(gp.is_open_source) !== '1') out.downgrade.push(`合约未开源或未知(is_open_source=${gp.is_open_source ?? '空'})`);
  const owner = String(gp.owner_address || '').toLowerCase();
  if (owner && !DEAD.has(owner)) out.reject.push(`owner 未放弃(${owner.slice(0, 10)}...)`);
  if (String(gp.is_proxy) === '1') out.reject.push('代理合约 is_proxy=1');
  // 3) concentration excluding pool / LP / dead addresses
  const pools = new Set([...(gp.dex || []).map(d => String(d.pair).toLowerCase()), String(pair?.pairAddress || '').toLowerCase(), ...DEAD]);
  const hs = (gp.holders || []).filter(h => !pools.has(String(h.address).toLowerCase()) && !/pancake|uniswap|lp|pool|lock/i.test(String(h.tag || '')));
  if (!hs.length) out.downgrade.push('持仓分布未知');
  else { const pcts = hs.map(h => n(h.percent) || 0).sort((a, b) => b - a); const top10 = pcts.slice(0, 10).reduce((a, b) => a + b, 0);
    if (pcts[0] > cfg.singleReject) out.reject.push(`单地址持仓${(pcts[0] * 100).toFixed(1)}%>${cfg.singleReject * 100}%`);
    if (top10 > cfg.top10Reject) out.reject.push(`前十持仓(剔除池子)${(top10 * 100).toFixed(1)}%>${cfg.top10Reject * 100}%`);
    else if (top10 >= cfg.top10Penalty) { out.penalty += cfg.top10PenaltyPts; out.notes.push(`前十持仓${(top10 * 100).toFixed(1)}%扣${cfg.top10PenaltyPts}`); }
    else out.notes.push(`前十持仓${(top10 * 100).toFixed(1)}%`); }
  // 4) bundler: no free EVM bundler source -> unknown, not clean
  out.notes.push('捆绑未知(BSC/Base 无数据，不视为干净)');
  // 5) volume consistency
  const vr = volumeCheck({ dsVol24: pair?.volume?.h24, gtVol24: extra.gtVol24, txns24: (n(pair?.txns?.h24?.buys) || 0) + (n(pair?.txns?.h24?.sells) || 0), liq: pair?.liquidity?.usd }, cfg);
  for (const x of vr) out.downgrade.push(`疑似刷量: ${x}`);
  // 6) different dev and no socials -> spillover bonus cap 0
  const socials = ((pair?.info?.socials || []).length + (pair?.info?.websites || []).length) > 0;
  const creator = String(gp.creator_address || '').toLowerCase();
  const sameDev = extra.leaderDev && creator && String(extra.leaderDev).toLowerCase() === creator;
  if (!sameDev && !socials) out.bonusCap0.push('与龙头 dev 不同且无任何社交链接');
  return out;
}
// SOL candidates: bundler share (null = unknown in degraded mode)
export function solBundleCheck(bundlePct, cfg = hardFilterConfig()) {
  if (!cfg.enabled) return { reject: null, penalty: 0, note: null };
  const b = n(bundlePct);
  if (b == null) return { reject: null, penalty: 0, note: '捆绑未知(降级模式无数据)' };
  if (b >= cfg.bundleReject) return { reject: `捆绑交易占比${(b * 100).toFixed(1)}%>=${cfg.bundleReject * 100}%`, penalty: 0, note: null };
  if (b >= cfg.bundlePenalty) return { reject: null, penalty: cfg.bundlePenaltyPts, note: `捆绑${(b * 100).toFixed(1)}%扣${cfg.bundlePenaltyPts}` };
  return { reject: null, penalty: 0, note: `捆绑${(b * 100).toFixed(1)}%` };
}
