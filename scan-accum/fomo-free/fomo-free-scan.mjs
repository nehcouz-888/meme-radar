#!/usr/bin/env node
// DATA_SOURCE_MODE=fomo_free degraded scan (2026-10-16). READ-ONLY: no trading, no posting, no GMGN.
// Sources: FOMO API (existing key, loaded from file in code, never printed; credit-capped via monthly ledger)
//          + keyless GeckoTerminal / DexScreener / Jupiter lite / RugCheck, low frequency with backoff.
// GMGN-only risk fields (bundler, sniper, rat/insider, dev serial mints when Jupiter lacks them) are UNKNOWN:
// every candidate is capped at tier=watch and status=WAIT_RECHECK; nothing becomes "hot" in this mode.
// Smart money (SMART_RETENTION_MODE=score): only Fomo traders STILL HOLDING the token add points.
// 2026-10-24: narrative-early smartMoney.scoreCurrentHoldersOnly — never bonus historical aggregates; Fomo 10-person watch lives at /workspace/meme-radar-run/fomo-trader-watch/.
import fs from 'node:fs';
import path from 'node:path';
import fsExt from 'fs-ext';
import { washTemplateCheck } from '../../src/wash-template.mjs';
import { spilloverConfig, isLeader, pickFollowers, spilloverBonus, hardFilterConfig, evaluateEvmFollower, volumeCheck, solBundleCheck } from '../../src/spillover.mjs';
import { evaluateAgeWindow, ageWindowConfig } from '../../src/age-window.mjs';

const ROOT = process.env.MEME_RADAR_ROOT || '/workspace/meme-radar-run/meme-radar-branch';
const STATE = path.join(ROOT, 'state');
const OUT_DIR = process.env.REPORT_OUT_DIR || '/workspace/ebooks/out';
const LEDGER = path.join(STATE, 'fomo-credits-ledger.json');
const CHAINS = (process.env.FOMO_FREE_CHAINS || 'sol,bsc,base').split(',').map(s => s.trim()).filter(Boolean);
const MONTHLY_BUDGET = Number(process.env.FOMO_MONTHLY_CREDIT_BUDGET || 150000);
const HOLDERS_MAX = Number(process.env.FOMO_TOKEN_HOLDERS_MAX ?? 2);   // per scan, top candidates only
const STATS_MAX = Number(process.env.FOMO_TOKEN_STATS_MAX ?? 0);
const LB_MIN_AGE_MS = Number(process.env.FOMO_LEADERBOARD_MIN_AGE_MIN || 300) * 60_000; // reuse cache if fresher
const FREE_GAP_MS = Number(process.env.FREE_SOURCE_GAP_MS || 2500);
const RUGCHECK_MAX = Number(process.env.RUGCHECK_MAX || 8);
const STAMP = new Date().toISOString();
const log = (...a) => console.error(`[fomo_free ${new Date().toISOString()}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => (v === null || v === undefined || v === '' || typeof v === 'boolean') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
const errors = [];
const metrics = { requests: {}, rateLimits: 0 };

const GT = { sol: 'solana', bsc: 'bsc', base: 'base', robinhood: 'robinhood' };
const DS = { sol: 'solana', bsc: 'bsc', base: 'base', robinhood: 'robinhood' };
const SOL_NET = 1399811149;
const familyOf = a => /^0x[0-9a-fA-F]{40}$/.test(a || '') ? 'evm' : (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || '') ? 'sol' : null);

// ---------- generic polite fetch ----------
const lastHit = {};
async function getJson(src, url, { headers = {}, retries = 2, gap = FREE_GAP_MS } = {}) {
  for (let i = 0; i <= retries; i++) {
    const wait = (lastHit[src] || 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit[src] = Date.now();
    metrics.requests[src] = (metrics.requests[src] || 0) + 1;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 || res.status >= 500) {
        metrics.rateLimits += res.status === 429 ? 1 : 0;
        const ra = Number(res.headers.get('retry-after')) || 0;
        const back = Math.min(60_000, Math.max(ra * 1000, 4000 * 2 ** i));
        log(`${src} HTTP ${res.status}; backoff ${back}ms`); await sleep(back); continue;
      }
      if (!res.ok) { errors.push(`${src} HTTP ${res.status}`); return { ok: false, status: res.status, headers: res.headers }; }
      return { ok: true, body: await res.json(), headers: res.headers };
    } catch (e) { if (i === retries) { errors.push(`${src} ${e?.name || 'error'}`); return { ok: false }; } await sleep(3000 * 2 ** i); }
  }
  errors.push(`${src} gave up after retries`); return { ok: false };
}

// ---------- FOMO with credit ledger ----------
const monthKey = () => new Date().toISOString().slice(0, 7);
// ✅ Compatible with watcher reservation protocol
function readLedger() { try { const l = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); if (l.month === monthKey()) return l; } catch {} return { month: monthKey(), spent: 0, calls: 0, lastRemaining: null, log: [], reservations: {} }; }
const fomoRun = { calls: 0, credits: 0, remainingBefore: null, remainingAfter: null, skipped: [] };
function saveLedger(ledger) { ledger.log = ledger.log.slice(-200); fs.writeFileSync(LEDGER + '.tmp', JSON.stringify(ledger, null, 1)); fs.renameSync(LEDGER + '.tmp', LEDGER); }

/**
 * ✅ Atomic mkdir ledger lock (same as watcher)
 */
function acquireLedgerLock(timeoutMs = 5000) {
  const lockPath = LEDGER + '.lock';
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, 'w');
      try {
        fsExt.flockSync(fd, 'exnb');
        const info = JSON.stringify({ pid: process.pid, at: Date.now() });
        fs.writeSync(fd, info);
        fs.fsyncSync(fd);
        return { fd, lockPath };
      } catch (lockErr) {
        fs.closeSync(fd);
        if (lockErr.code === 'EAGAIN' || lockErr.code === 'EWOULDBLOCK') {
          const waitMs = Math.min(50 + Math.random() * 50, timeoutMs - (Date.now() - startTime));
          if (waitMs > 0) {
            const start = Date.now();
            while (Date.now() - start < waitMs) {}
          }
          continue;
        }
        throw lockErr;
      }
    } catch (e) {
      throw e;
    }
  }
  throw new Error(`Failed to acquire ledger flock after ${timeoutMs}ms`);
}
function releaseLedgerLock(lockObj) { try { try { fsExt.flockSync(lockObj.fd, 'un'); } catch {} fs.closeSync(lockObj.fd); } catch (e) { console.error(`Ledger lock release error:`, e.message); } }

async function fomo(pathq, estCost = 250) {
  // ✅ Atomic budget check with shared lock
  const reservationId = `scanner-${process.pid}-${Date.now()}`;
  const ledgerLock = acquireLedgerLock();
  
  try {
    let ledger = readLedger();
    
    // Calculate total reserved (including watcher reservations)
    let totalReserved = 0;
    for (const resId in ledger.reservations) {
      totalReserved += ledger.reservations[resId]?.amount || 0;
    }
    
    if (ledger.spent + totalReserved + estCost > MONTHLY_BUDGET) {
      fomoRun.skipped.push(`${pathq} (monthly budget ${MONTHLY_BUDGET}, spent=${ledger.spent}, reserved=${totalReserved})`);
      return null;
    }
    
    // Reserve
    ledger.reservations[reservationId] = { amount: estCost, pid: process.pid, at: Date.now(), path: pathq.split('?')[0] };
    saveLedger(ledger);
  } finally {
    releaseLedgerLock(ledgerLock);
  }
  
  let key = ''; try { key = fs.readFileSync(path.join(STATE, 'fomo-api-key'), 'utf8').trim(); } catch {}
  if (!key) { fomoRun.skipped.push(`${pathq} (no key file)`); return null; }
  
  const r = await getJson('fomo', `https://api.fomoapi.io${pathq}`, { headers: { authorization: `Bearer ${key}` }, retries: 1, gap: 1500 });
  key = '';
  
  const cost = num(r.headers?.get?.('x-credits-cost')) ?? (r.ok ? estCost : 0);
  const rem = num(r.headers?.get?.('x-credits-remaining'));
  
  // ✅ Settle reservation atomically
  const settleLock = acquireLedgerLock();
  try {
    ledger = readLedger();
    delete ledger.reservations[reservationId];
    
    if (rem !== null) { if (fomoRun.remainingBefore === null) fomoRun.remainingBefore = rem + cost; fomoRun.remainingAfter = rem; ledger.lastRemaining = rem; }
    if (rem !== null) ledger.spent = Math.max(ledger.spent, Number(process.env.FOMO_PLAN_CREDITS || 250000) - rem - cost);
    if (r.status === 402) { fomoRun.skipped.push(`${pathq} (402 out of credits)`); }
    fomoRun.calls++; fomoRun.credits += cost; ledger.spent += cost; ledger.calls++;
    ledger.log.push({ at: STAMP, path: pathq.split('?')[0], cost, remaining: rem, ok: !!r.ok });
    saveLedger(ledger);
  } finally {
    releaseLedgerLock(settleLock);
  }
  
  return r.ok ? r.body : null;
}

// ---------- 1. Fomo smart-money snapshot (still-holding) ----------
async function fomoSmart() {
  const cacheFile = path.join(STATE, 'fomo-leaderboard-full.json');
  let cache = null; try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  let traders = cache?.traders, fetchedAt = cache?.fetchedAt || 0, fresh = false;
  if (!traders || Date.now() - fetchedAt > LB_MIN_AGE_MS) {
    const b = await fomo('/v2/leaderboard/24h?limit=100');
    if (Array.isArray(b?.traders)) {
      traders = b.traders.map(t => ({ handle: String(t.handle || '').slice(0, 40), userId: t.userId, pnlUsd: num(t.pnlUsd),
        wallets: { solana: t.wallets?.solana || null, evm: t.wallets?.evm || null },
        topTokens: (t.topTokens || []).map(x => ({ tokenAddress: x.tokenAddress || x.address || x.token?.address, networkId: x.networkId, symbol: x.symbol || x.token?.symbol, valueUsd: num(x.valueUsd ?? x.value) })) }));
      fetchedAt = Date.now(); fresh = true;
      fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt, window: '24h', capturedAt: b.capturedAt || null, traders }, null, 1));
      // keep the legacy wallet file in sync (same shape the daemon writes)
      const wallets = []; for (const t of traders) for (const a of [t.wallets.solana, t.wallets.evm]) if (a) wallets.push({ address: a, handle: t.handle });
      fs.writeFileSync(path.join(STATE, 'fomo-leaderboard-wallets.json'), JSON.stringify({ fetchedAt, window: '24h', wallets }, null, 1));
    }
  }
  const holding = new Map(); // tokenAddress(lower for evm) -> Set(handle)
  for (const t of traders || []) for (const x of t.topTokens || []) {
    if (!x.tokenAddress) continue; const k = familyOf(x.tokenAddress) === 'evm' ? x.tokenAddress.toLowerCase() : x.tokenAddress;
    if (!holding.has(k)) holding.set(k, new Set()); holding.get(k).add(t.handle);
  }
  return { traders: traders || [], fetchedAt, fresh, holding };
}

// ---------- 2. discovery ----------
function chainOfFomo(t) {
  const n = String(t.network ?? t.networkId ?? t.chain ?? '').toLowerCase();
  if (n.includes('sol') || n === String(SOL_NET)) return 'sol';
  if (n.includes('bsc') || n.includes('bnb') || n === '56') return 'bsc';
  if (n.includes('base') || n === '8453') return 'base';
  return familyOf(t.token?.address) === 'sol' ? 'sol' : (n || null);
}
const cands = new Map();
function addCand(chain, address, patch) {
  if (!chain || !address || !CHAINS.includes(chain)) return;
  const k = `${chain}:${chain === 'sol' ? address : address.toLowerCase()}`;
  const c = cands.get(k) || { chain, address: chain === 'sol' ? address : address.toLowerCase(), sources: [], fomo: {} };
  for (const [a, b] of Object.entries(patch)) { if (a === 'source') { if (!c.sources.includes(b)) c.sources.push(b); } else if (a === 'fomo') Object.assign(c.fomo, b); else if (c[a] == null) c[a] = b; }
  cands.set(k, c);
}
async function discover(smart) {
  const tb = await fomo('/v2/leaderboard/tokens/trending?limit=50');
  for (const t of tb?.tokens || []) addCand(chainOfFomo(t), t.token?.address, { source: 'fomo:trending', symbol: t.token?.symbol, fomo: { trendingRank: num(t.rank), fomoHolders: num(t.holders) } });
  for (const t of smart.traders) for (const x of t.topTokens || []) {
    const ch = x.networkId === SOL_NET ? 'sol' : (familyOf(x.tokenAddress) === 'sol' ? 'sol' : null);
    if (ch) addCand(ch, x.tokenAddress, { source: 'fomo:leaderboard-holding', symbol: x.symbol });
  }
  for (const chain of CHAINS) for (const feed of ['new_pools', 'trending_pools']) {
    const r = await getJson('geckoterminal', `https://api.geckoterminal.com/api/v2/networks/${GT[chain]}/${feed}?page=1`);
    for (const p of r.body?.data || []) {
      const base = p.relationships?.base_token?.data?.id?.split('_').slice(1).join('_');
      if (base) addCand(chain, base, { source: `gecko:${feed}`, symbol: (p.attributes?.name || '').split(' / ')[0] });
    }
  }
  const boosts = await getJson('dexscreener', 'https://api.dexscreener.com/token-boosts/latest/v1');
  for (const b of Array.isArray(boosts.body) ? boosts.body : []) { const ch = Object.keys(DS).find(k => DS[k] === b.chainId); if (ch) addCand(ch, b.tokenAddress, { source: 'dexscreener:boosts' }); }
}

// ---------- 3. market enrich (DexScreener batch, 30/addr per call) ----------
async function enrichMarket() {
  for (const chain of CHAINS) {
    const list = [...cands.values()].filter(c => c.chain === chain);
    for (let i = 0; i < list.length; i += 30) {
      const chunk = list.slice(i, i + 30);
      const r = await getJson('dexscreener', `https://api.dexscreener.com/tokens/v1/${DS[chain]}/${chunk.map(c => c.address).join(',')}`, { gap: 1200 });
      const best = new Map();
      for (const p of Array.isArray(r.body) ? r.body : []) {
        const a = chain === 'sol' ? p.baseToken?.address : p.baseToken?.address?.toLowerCase();
        if (!a) continue; const cur = best.get(a); if (!cur || (num(p.liquidity?.usd) || 0) > (num(cur.liquidity?.usd) || 0)) best.set(a, p);
      }
      for (const c of chunk) { const p = best.get(c.address); if (!p) continue;
        c.symbol = c.symbol || p.baseToken?.symbol; c.name = p.baseToken?.name; c.pair = p.pairAddress; c.dex = p.dexId;
        c.liq = num(p.liquidity?.usd); c.mcap = num(p.marketCap ?? p.fdv); c.vol24 = num(p.volume?.h24); c.vol1h = num(p.volume?.h1);
        c.chg1h = num(p.priceChange?.h1); c.chg24 = num(p.priceChange?.h24); c.buys1h = num(p.txns?.h1?.buys); c.sells1h = num(p.txns?.h1?.sells);
        c.ageH = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3600_000 : null; c.url = p.url;
        c.dsTxns24 = (num(p.txns?.h24?.buys) || 0) + (num(p.txns?.h24?.sells) || 0); c.hasSocials = ((p.info?.socials || []).length + (p.info?.websites || []).length) > 0; }
    }
  }
}

// ---------- 4. risk enrich (Jupiter sol batch + RugCheck top N) ----------
async function enrichRisk(sorted) {
  const sol = sorted.filter(c => c.chain === 'sol').slice(0, 60);
  for (let i = 0; i < sol.length; i += 20) {
    const r = await getJson('jupiter', `https://lite-api.jup.ag/tokens/v2/search?query=${sol.slice(i, i + 20).map(c => c.address).join(',')}`, { gap: 1500 });
    const by = new Map((Array.isArray(r.body) ? r.body : []).map(t => [t.id, t]));
    for (const c of sol.slice(i, i + 20)) { const t = by.get(c.address); if (!t) continue; const a = t.audit || {};
      c.jup = { organicScore: num(t.organicScore), isSus: a.isSus === true, devMints: num(a.devMints), devBalancePct: num(a.devBalancePercentage),
        topHoldersPct: num(a.topHoldersPercentage), mintOff: typeof a.mintAuthorityDisabled === 'boolean' ? a.mintAuthorityDisabled : null,
        freezeOff: typeof a.freezeAuthorityDisabled === 'boolean' ? a.freezeAuthorityDisabled : null, holders: num(t.holderCount), launchpad: t.launchpad || null,
        createdAt: t.createdAt || t.firstPool?.createdAt || null, graduatedAt: t.graduatedAt || null, stats24h: t.stats24h || null, socials: Boolean(t.twitter || t.website || t.telegram) };
      if (c.ageH == null && t.createdAt) c.ageH = (Date.now() - Date.parse(t.createdAt)) / 3600_000; }
  }
  for (const c of sol.slice(0, RUGCHECK_MAX)) {
    const r = await getJson('rugcheck', `https://api.rugcheck.xyz/v1/tokens/${c.address}/report/summary`, { gap: 2000, retries: 1 });
    if (r.ok) c.rug = { score: num(r.body?.score_normalised ?? r.body?.score), risks: (r.body?.risks || []).map(x => ({ name: x.name, level: x.level })).slice(0, 8) };
  }
}

// ---------- 5. scoring (degraded) ----------
function score(c, smart) {
  const notes = [], flags = []; let s = 10, reject = null;
  const k = c.chain === 'sol' ? c.address : c.address.toLowerCase();
  const holders = smart.holding.get(k); const liveHolders = c.fomoHoldersLive; // from /token/{addr}/holders when called
  // live /holders lists every tracked Fomo user; only those in the smart set (24h leaderboard + KOL bridge) count
  const liveSmart = liveHolders != null ? liveHolders.filter(h => SMART_HANDLES.has(h.toLowerCase())) : null;
  const stillHolding = liveSmart != null ? new Set([...liveSmart, ...(holders || [])]).size : (holders ? holders.size : 0);
  c.smart = { stillHolding, fomoUsersHolding: liveHolders?.length ?? null, handles: (liveSmart != null ? [...new Set([...liveSmart, ...(holders || [])])] : [...(holders || [])]).slice(0, 8), src: liveHolders != null ? 'fomo:token-holders(live)' : 'fomo:leaderboard-topTokens' };
  if (c.liq == null) return { ...c, score: 0, tier: 'ignore', status: 'NO_MARKET_DATA', notes: ['DexScreener 无数据'], flags };
  if (c.liq < 5000) reject = 'liq<5k';
  s += c.liq < 10e3 ? 5 : c.liq < 50e3 ? 12 : c.liq < 200e3 ? 15 : 10;
  if (c.mcap != null) s += c.mcap >= 30e3 && c.mcap <= 1e6 ? 12 : c.mcap < 30e3 ? 4 : c.mcap <= 5e6 ? 6 : 0;
  if (c.vol24 != null && c.liq) { const r = c.vol24 / c.liq; s += r > 3 ? 10 : r > 1 ? 6 : 0; }
  if (c.buys1h != null && c.sells1h != null) { if (c.buys1h > 1.2 * c.sells1h) s += 6; if (c.buys1h + c.sells1h > 200) s += 5; }
  if (c.chg1h != null) { if (c.chg1h > 0) s += 4; if (c.chg1h < -30) { s -= 10; flags.push('1h跌>30%'); } }
  if (c.chg24 != null && c.chg24 > 50) s += 5;
  if (c.ageH != null) s += c.ageH < 24 ? 8 : c.ageH < 72 ? 5 : c.ageH > 720 ? -5 : 0;
  if (c.fomo.trendingRank != null) s += c.fomo.trendingRank <= 10 ? 8 : c.fomo.trendingRank <= 30 ? 5 : 2;
  if ((c.fomo.fomoHolders || 0) > 50) s += 4;
  const smartPts = Math.min(18, stillHolding * 6); s += smartPts; notes.push(`聪明钱[仍持仓${stillHolding}个(${c.smart.src})；计分+${smartPts}]${c.smart.fomoUsersHolding != null ? `；Fomo 用户持仓${c.smart.fomoUsersHolding}(不计分)` : ''}`);
  if (c.jup) {
    if (c.jup.isSus) reject = reject || 'jupiter isSus';
    if (c.jup.mintOff === false || c.jup.freezeOff === false) reject = reject || 'mint/freeze 权限未放弃';
    if (c.jup.organicScore != null && c.jup.organicScore >= 50) s += 5;
    if (c.jup.topHoldersPct != null) { if (c.jup.topHoldersPct > 60) reject = reject || `top持仓${c.jup.topHoldersPct.toFixed(0)}%>60%`; else if (c.jup.topHoldersPct > 40) { s -= 15; flags.push(`top持仓${c.jup.topHoldersPct.toFixed(0)}%`); } }
    if (c.jup.devMints != null && c.jup.devMints > 1000) notes.push(`devMints=${c.jup.devMints}(疑似 launchpad 部署者，不计)`);
    else if (c.jup.devMints != null && c.jup.devMints >= 5) { s -= 15; flags.push(`dev发币${c.jup.devMints}次(Jupiter)`); }
    if (c.jup.devBalancePct != null && c.jup.devBalancePct > 10) { s -= 10; flags.push(`dev持仓${c.jup.devBalancePct.toFixed(1)}%`); }
  }
  { const st = c.jup?.stats24h || {};
    const w = washTemplateCheck({ organicScore: c.jup?.organicScore, createdAt: c.jup?.createdAt, graduatedAt: c.jup?.graduatedAt, holders: c.jup?.holders, traders: st.numTraders,
      buyVol: st.buyVolume, sellVol: st.sellVolume, buyOrganicVol: st.buyOrganicVolume, sellOrganicVol: st.sellOrganicVolume, volume: c.vol24, txns: c.dsTxns24,
      rugRisks: c.rug ? c.rug.risks.map(r => r.name) : null, hasSocials: c.hasSocials === true || c.jup?.socials === true ? true : (c.jup || c.hasSocials === false) ? false : null });
    c.wash = w; if (w.reject) { reject = reject || `wash_trade_template: ${w.signals.join('/')}`; flags.push('wash_trade_template'); } }
  // ---- age window 15-90 min (2026-10-24 narrative early). AGE_WINDOW=0 disables ----
  { const w0 = c.wash; const aw = evaluateAgeWindow({
      ageH: c.ageH, createdAt: c.jup?.createdAt, holders: c.jup?.holders ?? c.jup?.holderCount, traders: (c.jup?.stats24h || {}).numTraders,
      holdersPrev: c.holdersPrev, tradersPrev: c.tradersPrev,
      smartHoldingCount: stillHolding, kolHoldingCount: (c.smart?.handles || []).filter(h => KOL_HANDLES.has(String(h).toLowerCase())).length,
      hasSocials: c.hasSocials === true || c.jup?.socials === true, hadSocialsPrev: c.hadSocialsPrev,
      washReject: Boolean(w0?.reject)
    }, ageWindowConfig());
    c.ageWindow = aw;
    if (aw.reject && !reject) { reject = aw.reject; }
    if (aw.inWindow || aw.reject) {
      if (aw.bonus && !aw.reject) { s += aw.bonus; notes.push(`早期窗15-90分+${aw.bonus}[${aw.why.join('; ')}]`); }
      else if (aw.why.length) notes.push(`早期窗15-90分[${aw.why.join('; ')}]`);
      for (const f of aw.flags) if (!flags.includes(f)) flags.push(f);
    }
  }
  if (c.rug?.risks?.some(r => r.level === 'danger')) reject = reject || `RugCheck danger: ${c.rug.risks.filter(r => r.level === 'danger').map(r => r.name).join('/')}`;
  if (c.goplus) { // BSC follower security (GoPlus, keyless) — honeypot / un-sellable / high tax => HARD_REJECT
    if (c.goplus.honeypot) reject = reject || 'GoPlus honeypot';
    else if (c.goplus.cannotSellAll) reject = reject || 'GoPlus cannot_sell_all';
    else if ((c.goplus.buyTax ?? 0) > 0.1 || (c.goplus.sellTax ?? 0) > 0.1) reject = reject || `GoPlus 税率 买${c.goplus.buyTax}/卖${c.goplus.sellTax}>10%`;
  }
  // ---- 2026-10-20 hard filter (SPILLOVER_HARD_FILTER=0 disables) ----
  const HF = hardFilterConfig(); let downgrade = [];
  if (HF.enabled && c.followerEval) { const fe = c.followerEval;
    if (fe.reject.length) reject = reject || `跟随者硬过滤: ${fe.reject.join('; ')}`;
    downgrade.push(...fe.downgrade); if (fe.penalty) { s -= fe.penalty; } notes.push(...fe.notes);
    if (fe.bonusCap0.length && c.spillover?.bonus) { notes.push(`外溢加分上限0: ${fe.bonusCap0.join('; ')}`); c.spillover.bonus = 0; } }
  if (HF.enabled && c.chain === 'sol') {
    const b = solBundleCheck(c.bundlePct ?? null, HF); if (b.reject) reject = reject || b.reject; if (b.penalty) s -= b.penalty; if (b.note) flags.push(b.note);
    for (const x of volumeCheck({ dsVol24: c.vol24, gtVol24: null, txns24: c.dsTxns24, liq: c.liq }, HF)) downgrade.push(`疑似刷量: ${x}`);
  }
  if (downgrade.length) { flags.push('降级仅提示'); notes.push(`降级(不给外溢加分、不进观察): ${downgrade.join('; ')}`); if (c.spillover?.bonus) c.spillover.bonus = 0; }
  if (c.spillover?.bonus) { s += c.spillover.bonus; notes.push(`跨链外溢+${c.spillover.bonus}[龙头 ${c.spillover.leaderSymbol} ${c.spillover.leaderChain}/${c.spillover.leaderCA} mcap=${c.spillover.leaderMcap}; ${c.spillover.why.join(',')}]`); }
  if (c.spilloverLeaderOf?.length) notes.push(`外溢龙头→跟随：${c.spilloverLeaderOf.join('、')}`);
  // ---- OG 萌芽 (2026-10-18): low mcap AND certainty (KOL / still-holding smart money). OG_ENABLED=0 disables ----
  c.og = null;
  if (OG.enabled && !reject && c.mcap != null && c.mcap >= OG.minMcap && c.mcap < OG.maxMcap) {
    const kolW = c.smart.handles.filter(h => KOL_HANDLES.has(String(h).toLowerCase()));
    const kolX = (KOL_MENTIONS.get(k) || []).filter(h => X_WATCH.has(h.toLowerCase()));
    const smartN = stillHolding; const why = [];
    if (kolX.length) why.push(`KOL提及/喊单(${kolX.slice(0, 4).join(',')})`);
    if (kolW.length) why.push(`KOL钱包仍持仓(${kolW.slice(0, 4).join(',')})`);
    if (smartN) why.push(`聪明钱仍持仓${smartN}`);
    if (!why.length) notes.push(`OG未触发：市值<${fmtK(OG.maxMcap)}但无KOL/聪明钱确定性条件（不加分）`);
    else if (c.liq < OG.minLiq) notes.push(`OG未触发：流动性${fmtK(c.liq)}<下限${fmtK(OG.minLiq)}`);
    else {
      let b = OG.bonus; if (kolX.length || kolW.length) b += 4; if (smartN >= 2) b += 3; b = Math.min(OG.maxBonus, b);
      s += b; c.og = { bonus: b, why }; flags.push('OG'); notes.push(`OG萌芽+${b}[市值${fmtK(c.mcap)}<${fmtK(OG.maxMcap)}; ${why.join('; ')}]`);
    }
  }
  s = Math.max(0, Math.min(100, Math.round(s)));
  const unknown = ['bundler', 'sniper', 'rat/insider'];
  if (!(c.jup && c.jup.devMints != null)) unknown.push('dev serial mints');
  if (!(c.jup && c.jup.topHoldersPct != null) && c.fomoStats?.top10HoldersPercent == null) unknown.push('holder concentration');
  if (!c.jup && !c.rug) { s = Math.min(s, 60); notes.push('无 Jupiter/RugCheck 风控数据 → 分数封顶60'); }
  const tooBig = c.mcap != null && c.mcap > 20e6;
  let tier = reject ? 'reject' : s >= 70 ? 'hot' : s >= Number(process.env.FOMO_WATCH_MIN || 60) ? 'watch' : 'ignore';
  if (downgrade.length && tier !== 'reject') tier = 'ignore';
  if (tooBig && tier !== 'reject') { tier = 'ignore'; notes.push('市值>$20M 非早期，不入观察'); }
  const rawTier = tier; if (tier === 'hot') { tier = 'watch'; notes.push('原始≥70 → 降级模式封顶观察'); }
  return { ...c, score: s, rawTier, tier, status: reject ? 'HARD_REJECT' : 'WAIT_RECHECK', rejectReason: reject, unknown, notes, flags };
}

// OG 萌芽 config + KOL sets (bridge entries >= minFollowersKol; optional local mentions file, absent = no X data)
const OG = { enabled: process.env.OG_ENABLED !== '0', maxMcap: Number(process.env.OG_MAX_MCAP || 100000), minLiq: Number(process.env.OG_MIN_LIQ || 10000), minMcap: Number(process.env.OG_MIN_MCAP || 10000),
  bonus: Number(process.env.OG_BONUS || 8), maxBonus: Number(process.env.OG_MAX_BONUS || 15), mentionsFile: process.env.OG_KOL_MENTIONS_FILE || path.join(STATE, 'x-kol-mentions.json') };
const KOL_HANDLES = new Set(), X_WATCH = new Set(), KOL_MENTIONS = new Map(); let OG_MENTIONS_STATUS = '无本地 X 提及数据文件';
try { const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/fomo-gmgn-kol-bridge.json'), 'utf8')); for (const e of b.entries || []) if (e.fomoHandle && e.enabled !== false && (e.followers ?? 0) >= (b.minFollowersKol || 10000)) KOL_HANDLES.add(String(e.fomoHandle).toLowerCase()); } catch {}
try { for (const a of JSON.parse(fs.readFileSync(path.join(ROOT, 'config/x-watchlist.json'), 'utf8')).accounts || []) if (a.enabled !== false && a.handle) X_WATCH.add(String(a.handle).toLowerCase()); } catch {}
try { const m = JSON.parse(fs.readFileSync(OG.mentionsFile, 'utf8')); // {mentions:[{handle, ca, at}]} — written by an agent/X pipeline, read-only here
  for (const x of m.mentions || []) { if (!x.ca || !x.handle) continue; const kk = familyOf(x.ca) === 'evm' ? x.ca.toLowerCase() : x.ca; if (!KOL_MENTIONS.has(kk)) KOL_MENTIONS.set(kk, []); KOL_MENTIONS.get(kk).push(String(x.handle)); }
  OG_MENTIONS_STATUS = `X 提及文件 ${KOL_MENTIONS.size} 个 CA`; } catch {}
// smart set for live-holder filtering
const SMART_HANDLES = new Set();
try { for (const e of JSON.parse(fs.readFileSync(path.join(ROOT, 'config/fomo-gmgn-kol-bridge.json'), 'utf8')).entries || []) if (e.fomoHandle && e.enabled !== false) SMART_HANDLES.add(String(e.fomoHandle).toLowerCase()); } catch {}
// ---------- main ----------
const t0 = Date.now();
log(`start chains=${CHAINS} budget=${MONTHLY_BUDGET} ledgerSpent=${ledger.spent} holdersMax=${HOLDERS_MAX} statsMax=${STATS_MAX}`);
const smart = await fomoSmart();
for (const t of smart.traders) if (t.handle) SMART_HANDLES.add(t.handle.toLowerCase());
log(`fomo smart: traders=${smart.traders.length} fresh=${smart.fresh} holdingTokens=${smart.holding.size}`);
await discover(smart);
log(`discovered ${cands.size}`);
await enrichMarket();
function fmtK(v) { return v == null ? '?' : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`; }
let pre = [...cands.values()].filter(c => c.liq != null && c.liq >= 5000).sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0));
await enrichRisk(pre);
let scored = [...cands.values()].map(c => score(c, smart));
// ---------- 4b. cross-chain spillover (2026-10-18) ----------
const SPILL = spilloverConfig(); const spillLog = [];
if (SPILL.enabled) {
  // leader-only discovery on extra chains (default robinhood / R链): GeckoTerminal trending + DexScreener batch, no Fomo
  const extraLeaders = [];
  for (const ch of SPILL.leaderExtraChains.filter(x => !CHAINS.includes(x) && GT[x])) {
    const r = await getJson('geckoterminal', `https://api.geckoterminal.com/api/v2/networks/${GT[ch]}/trending_pools?page=1`);
    const addrs = [...new Set((r.body?.data || []).map(p => p.relationships?.base_token?.data?.id?.split('_').slice(1).join('_')).filter(Boolean))].slice(0, 30);
    if (!addrs.length) continue;
    const d = await getJson('dexscreener', `https://api.dexscreener.com/tokens/v1/${DS[ch]}/${addrs.join(',')}`, { gap: 1200 });
    const best = new Map(); for (const p of Array.isArray(d.body) ? d.body : []) { const a = p.baseToken?.address?.toLowerCase(); if (a && (!best.has(a) || (num(p.liquidity?.usd) || 0) > (num(best.get(a).liquidity?.usd) || 0))) best.set(a, p); }
    for (const [a, p] of best) extraLeaders.push({ chain: ch, address: a, symbol: p.baseToken?.symbol, name: p.baseToken?.name, liq: num(p.liquidity?.usd), mcap: num(p.marketCap ?? p.fdv), vol24: num(p.volume?.h24), chg24: num(p.priceChange?.h24), ageH: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3600_000 : null, status: 'WAIT_RECHECK', fomo: {}, extraLeader: true });
  }
  log(`spillover extra-chain leaders pool=${extraLeaders.length}`);
  const leaders = scored.filter(c => !SPILL.followers.includes(c.chain) || SPILL.followers.length > 1).concat(extraLeaders).filter(c => !SPILL.followers.includes(c.chain) && isLeader(c, SPILL))
    .sort((a, b) => (b.mcap || 0) * Math.max(1, b.vol24 || 0) - (a.mcap || 0) * Math.max(1, a.vol24 || 0));
  { // round-robin across leader chains so one chain (e.g. robinhood trending) cannot crowd out sol
    const by = new Map(); for (const c of leaders) { if (!by.has(c.chain)) by.set(c.chain, []); by.get(c.chain).push(c); }
    const rr = []; for (let i = 0; rr.length < leaders.length; i++) for (const l of by.values()) if (l[i]) rr.push(l[i]);
    leaders.splice(0, leaders.length, ...rr); }
  const seenSym = new Set();
  for (const L0 of leaders) {
    if (spillLog.length >= SPILL.maxLeaders) break;
    const sym = String(L0.symbol).toUpperCase(); if (seenSym.has(sym)) continue; seenSym.add(sym);
    const r = await getJson('dexscreener', `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(L0.symbol)}`, { gap: 1200, retries: 1 });
    let pairs = r.body?.pairs || [];
    if (L0.name && String(L0.name).toUpperCase() !== sym) { const r2 = await getJson('dexscreener', `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(L0.name)}`, { gap: 1200, retries: 1 }); pairs = pairs.concat(r2.body?.pairs || []); }
    const fl = pickFollowers(L0, pairs, SPILL);
    const entry = { leader: { symbol: L0.symbol, chain: L0.chain, address: L0.address, mcap: L0.mcap, vol24: L0.vol24 }, followers: [] };
    for (const f of fl) {
      const b = spilloverBonus(L0, f, SPILL); const p = f.pair;
      addCand(f.chain, f.address, { source: `spillover:${L0.chain}:${L0.symbol}`, symbol: p.baseToken?.symbol });
      const c = cands.get(`${f.chain}:${f.address}`);
      if (c.liq == null) { c.name = p.baseToken?.name; c.pair = p.pairAddress; c.dex = p.dexId; c.liq = f.liqTotal; c.mcap = f.mcap; c.vol24 = num(p.volume?.h24); c.vol1h = num(p.volume?.h1);
        c.chg1h = num(p.priceChange?.h1); c.chg24 = num(p.priceChange?.h24); c.buys1h = num(p.txns?.h1?.buys); c.sells1h = num(p.txns?.h1?.sells);
        c.ageH = f.created ? (Date.now() - f.created) / 3600_000 : null; c.url = p.url; c.dsTxns24 = (num(p.txns?.h24?.buys) || 0) + (num(p.txns?.h24?.sells) || 0); c.hasSocials = ((p.info?.socials || []).length + (p.info?.websites || []).length) > 0; }
      if (f.chain === 'bsc' || f.chain === 'base') { const gid = f.chain === 'bsc' ? 56 : 8453;
        const g = await getJson('goplus', `https://api.gopluslabs.io/api/v1/token_security/${gid}?contract_addresses=${f.address}`, { gap: 1500, retries: 1 });
        const t = g.body?.result?.[f.address]; if (t) c.goplus = { honeypot: t.is_honeypot === '1', cannotSellAll: t.cannot_sell_all === '1', buyTax: num(t.buy_tax), sellTax: num(t.sell_tax) };
        if (hardFilterConfig().enabled) { const gt = await getJson('geckoterminal', `https://api.geckoterminal.com/api/v2/networks/${GT[f.chain]}/tokens/${f.address}`, { retries: 1 });
          c.followerEval = evaluateEvmFollower(t || null, p, { gtVol24: num(gt.body?.data?.attributes?.volume_usd?.h24), leaderDev: null }); } }
      c.spillover = { bonus: b.pts, ratio: b.ratio, why: b.why, match: f.match, copies: f.copies, leaderSymbol: L0.symbol, leaderChain: L0.chain, leaderCA: L0.address, leaderMcap: fmtK(L0.mcap) };
      const lc = cands.get(`${L0.chain}:${L0.address}`); if (lc) (lc.spilloverLeaderOf ||= []).push(`${f.chain}/${f.address}`);
      entry.followers.push({ chain: f.chain, address: f.address, symbol: p.baseToken?.symbol, mcap: f.mcap, liq: f.liqTotal, ratio: b.ratio, bonus: b.pts, match: f.match, copies: f.copies, createdAt: f.created ? new Date(f.created).toISOString() : null, goplus: c.goplus || null, hardFilter: c.followerEval || null });
    }
    spillLog.push(entry);
  }
  log(`spillover: leaders=${spillLog.length} followers=${spillLog.reduce((a, e) => a + e.followers.length, 0)}`);
  scored = [...cands.values()].map(c => score(c, smart));
}
// capped live Fomo per-token calls for the top non-rejected candidates
const top = scored.filter(x => x.status === 'WAIT_RECHECK').sort((a, b) => b.score - a.score);
for (const c of top.slice(0, HOLDERS_MAX)) {
  const b = await fomo(`/token/${c.address}/holders${c.chain === 'sol' ? `?networkId=${SOL_NET}` : ''}`);
  const rows = b?.holders || b?.traders || (Array.isArray(b) ? b : null);
  if (rows) { const src = cands.get(`${c.chain}:${c.address}`); src.fomoHoldersLive = rows.map(h => String(h.handle || h.username || h.userId || '?').slice(0, 30)); }
}
for (const c of top.slice(0, STATS_MAX)) { const b = await fomo(`/v2/token/${c.address}/stats`); if (b) cands.get(`${c.chain}:${c.address}`).fomoStats = { top10HoldersPercent: num(b.top10HoldersPercent), holders: num(b.holders), w1h: b.windows?.['1h'] || null }; }
scored = [...cands.values()].map(c => score(c, smart)).sort((a, b) => b.score - a.score);

// ---------- report ----------
const cst = d => new Date(d).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const fmt = v => v == null ? '?' : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`;
const valid = scored.filter(x => x.status !== 'NO_MARKET_DATA');
const byChain = CHAINS.map(ch => { const l = scored.filter(x => x.chain === ch); return { ch, disc: l.length, mkt: l.filter(x => x.liq != null).length, rej: l.filter(x => x.status === 'HARD_REJECT').length, watch: l.filter(x => x.tier === 'watch').length, hotRaw: l.filter(x => x.rawTier === 'hot').length }; });
const L = [];
L.push('# 金狗雷达全链只读扫描报告（降级模式 DATA_SOURCE_MODE=fomo_free）', '');
L.push('> **降级模式**：GMGN 不可用（AUTH_KEY_BLOCKED 自 2026-10-12 19:35 CST）。本报告只用 Fomo API + 免费公开源（GeckoTerminal / DexScreener / Jupiter / RugCheck）。', '> GMGN 独有风控字段（**bundler 捆绑、sniper 狙击、老鼠仓/insider**，以及 Jupiter 无数据时的 dev 连环发币、持仓集中度）= **未知**。所有候选**封顶「观察」档、状态 WAIT_RECHECK**，本模式下**不产生热门**。仅供研究，不交易、不发帖。', '');
L.push(`- **生成时间**：${cst(Date.now())} CST（耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s）`);
L.push(`- **链**：${CHAINS.join(', ')}`);
L.push('- **评分**：降级版 embryonicScore 0–100（流动性/市值/量价/年龄/Fomo 热度/仍持仓聪明钱/Jupiter+RugCheck 风控）；原始≥70 也封顶观察');
L.push(`- **聪明钱计分模式**：仅计仍持仓聪明钱（SMART_RETENTION_MODE=score）——来源 Fomo 24h 排行榜交易者当前 topTokens 持仓${HOLDERS_MAX ? `，前 ${HOLDERS_MAX} 名候选用 /token/{addr}/holders 实时复核` : ''}；不持仓/历史交易不加分`);
L.push(`- **Fomo 排行榜快照**：${smart.traders.length} 交易者，抓取于 ${smart.fetchedAt ? cst(smart.fetchedAt) : '无'} CST${smart.fresh ? '（本次新拉）' : '（缓存复用）'}`);
L.push(`- **Fomo credits**：本次 ${fomoRun.calls} 次调用 / ${fomoRun.credits} credits；剩余 ${fomoRun.remainingAfter ?? ledger.lastRemaining ?? '?'}；本月账本已用 ${ledger.spent}/${MONTHLY_BUDGET}${fomoRun.skipped.length ? `；跳过：${fomoRun.skipped.join('; ')}` : ''}`);
L.push(`- **合计**：热门 **0**（降级封顶）/ 观察 **${valid.filter(x => x.tier === 'watch').length}** / 已评分 **${valid.length}**（HARD_REJECT ${valid.filter(x => x.status === 'HARD_REJECT').length}）`, '');
L.push('## 链路结果一览', '', '| 链 | 发现 | 有行情 | 拒绝 | 观察 | 原始≥70(已封顶) |', '|---|---:|---:|---:|---:|---:|');
for (const b of byChain) L.push(`| ${b.ch} | ${b.disc} | ${b.mkt} | ${b.rej} | ${b.watch} | ${b.hotRaw} |`);
L.push('', '## 全局 Top 10（已排除 HARD_REJECT）', '');
valid.filter(x => x.status !== 'HARD_REJECT').slice(0, 10).forEach((x, i) => {
  L.push(`${i + 1}. ${x.og ? '[OG] ' : ''}**${x.symbol || '?'}** (\`${x.chain}\`) score=${x.score} tier=${x.tier} status=${x.status} mcap=${fmt(x.mcap)} liq=${fmt(x.liq)} vol24=${fmt(x.vol24)} age=${x.ageH == null ? '?' : x.ageH.toFixed(1) + 'h'} 1h=${x.chg1h ?? '?'}% src=${x.sources.join('+')}`);
  L.push(`   - ${x.notes.join('；')}${x.smart.handles.length ? ` (${x.smart.handles.join(', ')})` : ''}`);
  L.push(`   - 风控：${x.jup ? `Jupiter organic=${x.jup.organicScore ?? '?'} top持仓=${x.jup.topHoldersPct ?? '?'}% devMints=${x.jup.devMints ?? '?'} mint/freeze放弃=${x.jup.mintOff}/${x.jup.freezeOff}` : 'Jupiter 无'}${x.rug ? `；RugCheck score=${x.rug.score} risks=${x.rug.risks.map(r => r.name).join('/') || '无'}` : ''}${x.flags.length ? `；旗标：${x.flags.join('、')}` : ''}`);
  L.push(`   - 未知(GMGN 独有)：${x.unknown.join('、')}`);
  if (x.spillover) L.push(`   - 跨链外溢: 龙头 ${x.spillover.leaderSymbol} \`${x.spillover.leaderChain}\` CA \`${x.spillover.leaderCA}\` (mcap ${x.spillover.leaderMcap})，跟随/龙头市值比 ${x.spillover.ratio == null ? '?' : (x.spillover.ratio * 100).toFixed(1) + '%'}，加分 +${x.spillover.bonus}`);
  L.push(`   - \`${x.address}\``);
});
const rej = valid.filter(x => x.status === 'HARD_REJECT');
L.push('', `## HARD_REJECT（${rej.length}）`, '');
for (const x of rej.slice(0, 15)) L.push(`- ${x.symbol || '?'} (${x.chain}) — ${x.rejectReason}${x.flags.includes('wash_trade_template') && !String(x.rejectReason).startsWith('wash') ? ' [wash_trade_template]' : ''} \`${x.address}\``);
L.push('', `## 跨链外溢（SPILLOVER_ENABLED=${SPILL.enabled ? 1 : 0}，跟随链=${SPILL.followers.join(',')}，跟随币市值上限=${fmt(SPILL.followerMaxMcap)}，额外龙头链=${SPILL.leaderExtraChains.join(',') || '无'}）`, '');
if (!SPILL.enabled) L.push('- 已关闭');
else if (!spillLog.length) L.push('- 本次无符合条件的外链龙头（mcap≥$1M 且 24h量≥$500K，或 Fomo trending Top10）');
for (const e of spillLog) {
  L.push(`- 龙头 **${e.leader.symbol}** \`${e.leader.chain}\` CA \`${e.leader.address}\` mcap=${fmt(e.leader.mcap)} vol24=${fmt(e.leader.vol24)}`);
  if (!e.followers.length) L.push('  - 跟随链无合格同名币（流动性/市值比/年龄不达标）');
  for (const f of e.followers) { const r = scored.find(x => x.chain === f.chain && x.address === f.address);
    L.push(`  - → ${f.chain} **${f.symbol}** \`${f.address}\` mcap=${fmt(f.mcap)} liq=${fmt(f.liq)} 比值=${f.ratio == null ? '?' : (f.ratio * 100).toFixed(1) + '%'} 匹配=${f.match} 同名${f.copies}个 外溢+${f.bonus} → score=${r?.score ?? '?'} tier=${r?.tier ?? '?'} ${r?.status === 'HARD_REJECT' ? 'HARD_REJECT: ' + r.rejectReason : ''}${f.goplus ? ` GoPlus honeypot=${f.goplus.honeypot} tax=${f.goplus.buyTax}/${f.goplus.sellTax}` : ''}`); }
}
{ const ogl = valid.filter(x => x.og).sort((a, b) => b.score - a.score);
  const ageHits = scored.filter(x => x.ageWindow?.inWindow);
L.push('', `## 早期窗 15-90 分钟（AGE_WINDOW=${ageWindowConfig().enabled ? 1 : 0}，命中 ${ageHits.length}）`, '');
for (const x of ageHits.slice(0, 10)) L.push(`- ${x.symbol || '?'} (${x.chain}) age=${x.ageWindow.ageMinutes?.toFixed?.(1) ?? '?'}m bonus=+${x.ageWindow.bonus || 0} flags=${(x.ageWindow.flags || []).join(',') || '-'} \`${x.address}\``);
L.push('', `## OG 萌芽（OG_ENABLED=${OG.enabled ? 1 : 0}，市值<${fmtK(OG.maxMcap)} 且 KOL/聪明钱仍持仓，流动性>=${fmtK(OG.minLiq)}；${OG_MENTIONS_STATUS}）`, '');
  if (!OG.enabled) L.push('- 已关闭'); else if (!ogl.length) L.push('- 本次无 OG 候选');
  for (const x of ogl.slice(0, 15)) L.push(`- [OG] ${x.symbol || '?'} (${x.chain}) score=${x.score} tier=${x.tier} mcap=${fmt(x.mcap)} liq=${fmt(x.liq)} OG+${x.og.bonus}：${x.og.why.join('; ')} \`${x.address}\``); }
L.push('', '## 数据源健康', '', `- 请求数：${JSON.stringify(metrics.requests)}；429 次数：${metrics.rateLimits}`, `- 错误：${errors.length ? [...new Set(errors)].slice(0, 12).join('；') : '无'}`, '', '_回退到 GMGN：去掉 DATA_SOURCE_MODE（或设为 gmgn）即可，默认路径未改动。_', '');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'fullchain-scan-report.md'), L.join('\n'));
const strip = ({ fomoHoldersLive, ...x }) => x;
fs.writeFileSync(path.join(OUT_DIR, 'fullchain-scan-results.json'), JSON.stringify({ generatedAt: STAMP, mode: 'fomo_free', degraded: true, chains: CHAINS, fomo: { ...fomoRun, monthSpent: ledger.spent, monthBudget: MONTHLY_BUDGET, leaderboardFetchedAt: smart.fetchedAt }, metrics, errors: [...new Set(errors)], byChain, spillover: { enabled: SPILL.enabled, followers: SPILL.followers, log: spillLog }, results: scored.map(strip) }, null, 1));
console.log(JSON.stringify({ mode: 'fomo_free', discovered: cands.size, scored: valid.length, watch: valid.filter(x => x.tier === 'watch').length, reject: rej.length, top: valid.filter(x => x.status !== 'HARD_REJECT').slice(0, 5).map(x => `${x.symbol}:${x.chain}:${x.score}`), fomo: fomoRun, monthSpent: ledger.spent, requests: metrics.requests, errors: [...new Set(errors)].length }));
