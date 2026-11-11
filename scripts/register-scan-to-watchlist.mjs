#!/usr/bin/env node
/**
 * Register scan results to watchlist for exit monitoring
 * Reads fullchain-scan-results.json, adds tier=watch to watchlist.json
 */
import fs from 'node:fs';
import path from 'node:path';

const RESULTS_FILE = process.env.SCAN_RESULTS_FILE || '/workspace/ebooks/out/fullchain-scan-results.json';
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || '/workspace/meme-radar-run/scan-accum/narrative-early/state/watchlist.json';

function loadWatchlist() {
  try {
    return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
  } catch {
    return { version: 1, items: [] };
  }
}

function saveWatchlist(data) {
  fs.mkdirSync(path.dirname(WATCHLIST_FILE), { recursive: true });
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(data, null, 2));
}

// Load scan results
if (!fs.existsSync(RESULTS_FILE)) {
  console.error(`Scan results not found: ${RESULTS_FILE}`);
  process.exit(1);
}

const results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
const watchlist = loadWatchlist();

let added = 0;
let updated = 0;
const existing = new Map(watchlist.items.map(i => [i.key || `${i.chain}:${i.address}`, i]));

for (const candidate of results.results || []) {
  // Only register tier=watch (not rejected, not already closed)
  if (candidate.tier !== 'watch') continue;
  
  const key = `${candidate.chain}:${candidate.address}`;
  
  if (existing.has(key)) {
    // Update existing entry
    const item = existing.get(key);
    item.prevMcap = item.mcap;
    item.mcap = candidate.mcap;
    item.prevSmartHoldingCount = item.smartHoldingCount;
    item.smartHoldingCount = candidate.smart?.count || 0;
    item.symbol = candidate.symbol;
    item.url = candidate.url;
    item.isLeader = candidate.isLeader || false;
    item.updatedAt = new Date().toISOString();
    updated++;
  } else {
    // Add new entry
    watchlist.items.push({
      key,
      chain: candidate.chain,
      address: candidate.address,
      symbol: candidate.symbol,
      mcap: candidate.mcap,
      prevMcap: null,
      smartHoldingCount: candidate.smart?.count || 0,
      prevSmartHoldingCount: null,
      isLeader: candidate.isLeader || false,
      url: candidate.url,
      status: 'active',
      addedAt: new Date().toISOString(),
      scanScore: candidate.score,
      tier: candidate.tier,
      alerted: {}
    });
    added++;
  }
}

saveWatchlist(watchlist);

console.log(JSON.stringify({
  ok: true,
  scanResults: results.results?.length || 0,
  watchCandidates: results.results?.filter(r => r.tier === 'watch').length || 0,
  added,
  updated,
  total: watchlist.items.length,
  watchlistFile: WATCHLIST_FILE
}, null, 2));
