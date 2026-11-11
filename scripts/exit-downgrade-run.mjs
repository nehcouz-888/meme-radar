#!/usr/bin/env node
// Exit/downgrade runner (direction 7). Reads watchlist snapshots, writes pending plain alerts.
// Runner self-refreshes current mcap and smart holdings before evaluating exit conditions.
import fs from 'node:fs';
import path from 'node:path';
import {
  exitDowngradeConfig, loadWatchlist, saveWatchlist, evaluateExitDowngrade,
  formatExitAlertPlain, writePendingAlert, markWatchDowngrade
} from '../src/exit-downgrade.mjs';

const ROOT = '/workspace/meme-radar-run';
const CFG_PATH = path.join(ROOT, 'meme-radar-branch/config/narrative-early-discovery.json');
const cfgFile = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const cfg = exitDowngradeConfig(cfgFile.exitDowngrade || {});

// Smart money handles (from Fomo leaderboard)
const SMART_HANDLES = new Set();
const SMART_FILE = path.join(ROOT, 'scan-accum/narrative-early/state/fomo-leaderboard-full.json');
try {
  const cache = JSON.parse(fs.readFileSync(SMART_FILE, 'utf8'));
  for (const t of cache?.traders || []) if (t.handle) SMART_HANDLES.add(String(t.handle).toLowerCase());
} catch {}

// DexScreener chain mappings
const DS_CHAINS = { sol: 'solana', bsc: 'bsc', base: 'base', eth: 'ethereum', arb: 'arbitrum' };
const SOL_NET = 901; // Fomo network ID for Solana

const n = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastFomoCall = 0, lastDexCall = 0;

/** Refresh current mcap from DexScreener */
async function refreshMcap(chain, address) {
  const wait = lastDexCall + 1200 - Date.now();
  if (wait > 0) await sleep(wait);
  lastDexCall = Date.now();
  
  try {
    const dsChain = DS_CHAINS[chain];
    if (!dsChain) return null;
    
    const url = `https://api.dexscreener.com/tokens/v1/${dsChain}/${address}`;
    const res = await fetch(url, { 
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    });
    
    if (!res.ok) return null;
    const pairs = await res.json();
    if (!Array.isArray(pairs)) return null;
    
    // Pick highest liquidity pair
    let best = null;
    for (const p of pairs) {
      const liq = n(p.liquidity?.usd);
      if (liq && (!best || liq > n(best.liquidity?.usd))) best = p;
    }
    
    if (!best) return null;
    return n(best.marketCap ?? best.fdv);
  } catch (e) {
    console.error(`refreshMcap error for ${chain}:${address}:`, e.message);
    return null;
  }
}

/** Refresh current smart holdings from Fomo (live-verified only) */
async function refreshSmartHoldings(chain, address) {
  const wait = lastFomoCall + 1200 - Date.now();
  if (wait > 0) await sleep(wait);
  lastFomoCall = Date.now();
  
  try {
    const netParam = chain === 'sol' ? `?networkId=${SOL_NET}` : '';
    const url = `https://api.fomo.fund/token/${address}/holders${netParam}`;
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    });
    
    if (!res.ok) return { count: null, verified: false };
    const body = await res.json();
    const holders = body?.holders || body?.traders || (Array.isArray(body) ? body : null);
    
    if (!holders) {
      // Sample incomplete - do NOT assume liquidated
      return { count: null, verified: false };
    }
    
    // Count smart money holders (live-verified only)
    const smartCount = holders.filter(h => {
      const handle = String(h.handle || h.username || h.userId || '').toLowerCase();
      return SMART_HANDLES.has(handle);
    }).length;
    
    return { count: smartCount, verified: true };
  } catch (e) {
    console.error(`refreshSmartHoldings error for ${chain}:${address}:`, e.message);
    return { count: null, verified: false };
  }
}

const watch = loadWatchlist(cfg.watchStateFile);
const items = watch.items || [];
let written = 0, refreshed = 0, refreshErrors = 0;
const results = [];

for (const item of items) {
  if (item.status === 'closed') continue;
  
  // Self-refresh current mcap and smart holdings
  const [mcap, smart] = await Promise.allSettled([
    refreshMcap(item.chain, item.address),
    refreshSmartHoldings(item.chain, item.address)
  ]);
  
  // Update current values (only if refresh succeeded)
  if (mcap.status === 'fulfilled' && mcap.value !== null) {
    item.mcap = mcap.value;
    refreshed++;
  } else {
    refreshErrors++;
  }
  
  if (smart.status === 'fulfilled' && smart.value.verified) {
    item.smartHoldingCount = smart.value.count;
    refreshed++;
  } else {
    refreshErrors++;
    // Sample incomplete - keep previous value, do NOT write as liquidated
  }
  
  const snap = {
    chain: item.chain,
    address: item.address,
    symbol: item.symbol,
    mcap: item.mcap,
    prevMcap: item.prevMcap,
    smartHoldingCount: item.smartHoldingCount,
    prevSmartHoldingCount: item.prevSmartHoldingCount,
    buyVol1h: item.buyVol1h,
    sellVol1h: item.sellVol1h,
    isLeader: item.isLeader,
    url: item.url
  };
  
  const ev = evaluateExitDowngrade(snap, cfg);
  results.push({ key: item.key || `${item.chain}:${item.address}`, ev });
  
  for (const alert of ev.alerts) {
    const dedupe = `${alert.type}:${item.key || item.address}:${alert.band || alert.type}:${item.mcap || ''}`;
    item.alerted = item.alerted || {};
    if (item.alerted[dedupe]) continue;
    const text = formatExitAlertPlain(alert, snap);
    const w = writePendingAlert(cfg, text, { type: alert.type, key: item.key, symbol: item.symbol });
    item.alerted[dedupe] = { at: new Date().toISOString(), id: w.id };
    written++;
  }
  
  if (ev.downgrade) markWatchDowngrade(watch, item.key || `${item.chain}:${item.address}`, ev.reasons);
  
  // Roll prev* for next run (use refreshed current values)
  if (item.mcap != null) item.prevMcap = item.mcap;
  if (item.smartHoldingCount != null) item.prevSmartHoldingCount = item.smartHoldingCount;
}

saveWatchlist(cfg.watchStateFile, watch);
const summary = { ok: true, watched: items.length, refreshed, refreshErrors, alertsWritten: written, alertsDir: cfg.alertsDir };
console.log(JSON.stringify(summary, null, 2));
