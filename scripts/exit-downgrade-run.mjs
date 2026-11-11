#!/usr/bin/env node
// Exit/downgrade runner (direction 7). Reads watchlist snapshots, writes pending plain alerts.
// Free sources only when enriching; default uses fields already on watchlist items.
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
const watch = loadWatchlist(cfg.watchStateFile);
const items = watch.items || [];
let written = 0;
const results = [];

for (const item of items) {
  if (item.status === 'closed') continue;
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
  // roll prev* for next run if caller updated mcap/smart fields
  if (item.mcap != null) item.prevMcap = item.mcap;
  if (item.smartHoldingCount != null) item.prevSmartHoldingCount = item.smartHoldingCount;
}

saveWatchlist(cfg.watchStateFile, watch);
const summary = { ok: true, watched: items.length, alertsWritten: written, alertsDir: cfg.alertsDir };
console.log(JSON.stringify(summary, null, 2));
