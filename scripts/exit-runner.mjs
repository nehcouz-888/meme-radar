#!/usr/bin/env node
/**
 * Exit Monitoring Runner - Production Entry Point
 * 
 * Auto-register from fomo-free scan → refresh holdings → analyze changes → write to queue
 * 
 * Deployment paths:
 * - This script: /workspace/meme-radar-run/meme-radar-branch/scripts/exit-runner.mjs
 * - Modules: /workspace/meme-radar-run/meme-radar-branch/src/modules/*
 * - Queue: /workspace/meme-radar-run/meme-radar-branch/exit-monitoring/alert-queue.jsonl
 * - Watchlist: /workspace/meme-radar-run/meme-radar-branch/state/exit-watchlist.json
 * 
 * Budget: Respects monthly Fomo budget, prefers free sources
 * Interval: Calculated from watchlist size and budget (typically 4-12h)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Adapt to deployment path
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MODULES_ROOT = path.join(REPO_ROOT, 'src/modules');

// Import modules with deployment-aware paths
const exitRunner = await import(path.join(MODULES_ROOT, 'exit-runner-production.mjs'));
const alertQueue = await import(path.join(MODULES_ROOT, 'alert-queue.mjs'));

const log = (...a) => console.error(`[exit_runner ${new Date().toISOString()}]`, ...a);

// Configuration
const STATE_DIR = process.env.EXIT_STATE_DIR || path.join(REPO_ROOT, 'state');
const EXIT_DIR = process.env.EXIT_DIR || path.join(REPO_ROOT, 'exit-monitoring');
const WATCHLIST_FILE = path.join(STATE_DIR, 'exit-watchlist.json');
const QUEUE_FILE = path.join(EXIT_DIR, 'alert-queue.jsonl');
const LEDGER_FILE = path.join(STATE_DIR, 'fomo-credits-ledger.json');
const SCAN_RESULTS_DIR = process.env.SCAN_RESULTS_DIR || path.join(REPO_ROOT, '../scan-accum/fomo-free');

const MONTHLY_BUDGET = Number(process.env.FOMO_MONTHLY_CREDIT_BUDGET || 150000);
const REFRESH_INTERVAL_HOURS = Number(process.env.EXIT_REFRESH_INTERVAL_HOURS || 0); // 0 = auto-calculate
const FREE_SOURCE_GAP_MS = Number(process.env.FREE_SOURCE_GAP_MS || 3000);

// Ensure directories
for (const dir of [STATE_DIR, EXIT_DIR, path.dirname(SCAN_RESULTS_DIR)]) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Load Fomo credit ledger
 */
function loadLedger() {
  try {
    const data = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    const monthKey = new Date().toISOString().slice(0, 7);
    if (data.month === monthKey) return data;
  } catch {}
  
  return {
    month: new Date().toISOString().slice(0, 7),
    spent: 0,
    calls: 0,
    lastRemaining: null,
    log: []
  };
}

function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_FILE + '.tmp', JSON.stringify(ledger, null, 2));
  fs.renameSync(LEDGER_FILE + '.tmp', LEDGER_FILE);
}

const ledger = loadLedger();

/**
 * Load latest scan results (if available)
 */
function loadLatestScanResults() {
  try {
    const files = fs.readdirSync(SCAN_RESULTS_DIR)
      .filter(f => f.startsWith('scan-') && f.endsWith('.json'))
      .sort()
      .reverse();
    
    if (files.length === 0) {
      log('No scan results found in', SCAN_RESULTS_DIR);
      return null;
    }
    
    const latest = files[0];
    const data = JSON.parse(fs.readFileSync(path.join(SCAN_RESULTS_DIR, latest), 'utf8'));
    log(`Loaded scan results: ${latest}, ${(data.candidates || []).length} candidates`);
    return data;
  } catch (error) {
    log('Failed to load scan results:', error.message);
    return null;
  }
}

/**
 * Budget check
 */
function checkBudget(estCost) {
  const remaining = MONTHLY_BUDGET - ledger.spent;
  return remaining >= estCost;
}

function recordCost(cost) {
  ledger.spent += cost;
  ledger.calls++;
  saveLedger(ledger);
}

/**
 * Free source: Mock GeckoTerminal top holders
 * Real implementation would call GET /networks/:network/tokens/:address
 */
const lastFreeCall = {};
async function getFreeHolders(chain, address) {
  const key = `${chain}:${address}`;
  const wait = (lastFreeCall[key] || 0) + FREE_SOURCE_GAP_MS - Date.now();
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  lastFreeCall[key] = Date.now();
  
  // Mock: in real implementation, call GeckoTerminal or DexScreener
  log(`[FREE] Mock call for ${chain}:${address} (rate-limited)`);
  
  // Return null to indicate no free data available (would use Fomo fallback)
  return null;
}

/**
 * Fomo source: /v2/tokens/{chain}:{address}/holders
 */
async function getFomoHolders(chain, address) {
  const estCost = 250;
  
  if (!checkBudget(estCost)) {
    log(`Budget exhausted (${ledger.spent}/${MONTHLY_BUDGET}), skipping Fomo call`);
    return null;
  }
  
  // Load API key
  let apiKey = '';
  try {
    const keyFile = path.join(STATE_DIR, 'fomo-api-key');
    apiKey = fs.readFileSync(keyFile, 'utf8').trim();
  } catch {
    log('No Fomo API key file found');
    return null;
  }
  
  if (!apiKey) {
    log('Fomo API key empty');
    return null;
  }
  
  log(`[FOMO] Calling /v2/tokens/${chain}:${address}/holders (est. ${estCost} credits)`);
  
  // Real API call would go here
  // For offline testing, return null
  log('[OFFLINE] Skipping real Fomo API call');
  
  // Mock response for testing
  return null;
}

/**
 * Main execution
 */
async function main() {
  log('=== Exit Monitoring Runner Start ===');
  log('Config:', {
    watchlistFile: WATCHLIST_FILE,
    queueFile: QUEUE_FILE,
    scanResultsDir: SCAN_RESULTS_DIR,
    monthlyBudget: MONTHLY_BUDGET,
    currentSpent: ledger.spent,
    remaining: MONTHLY_BUDGET - ledger.spent
  });
  
  // 1. Load watchlist
  const watchlist = exitRunner.loadWatchlist(WATCHLIST_FILE);
  log(`Loaded watchlist: ${watchlist.items.length} items`);
  
  // 2. Load scan results and register new candidates
  const scanResults = loadLatestScanResults();
  if (scanResults && scanResults.candidates) {
    const result = exitRunner.registerFromScanResults(scanResults, watchlist);
    
    if (result.registered.length > 0) {
      log(`Registered ${result.registered.length} new tokens to watchlist`);
      for (const entry of result.registered) {
        log(`  - ${entry.chain}:${entry.symbol} (${entry.address.slice(0, 8)}...)`);
      }
    }
    
    // Mark dropped from board
    exitRunner.markDroppedFromBoard(result.watchlist, scanResults.candidates);
    
    // Save updated watchlist
    exitRunner.saveWatchlist(WATCHLIST_FILE, result.watchlist);
    log(`Watchlist updated: ${result.total} total items`);
  }
  
  // 3. Calculate refresh interval
  const interval = exitRunner.calculateRefreshInterval(
    watchlist.items.length,
    MONTHLY_BUDGET - ledger.spent
  );
  log('Recommended interval:', interval);
  
  const effectiveInterval = REFRESH_INTERVAL_HOURS || interval.intervalHours;
  log(`Using interval: ${effectiveInterval}h (${REFRESH_INTERVAL_HOURS ? 'manual' : 'calculated'})`);
  
  // 4. Refresh holdings for items that need it
  const currentWatchlist = exitRunner.loadWatchlist(WATCHLIST_FILE);
  const cutoff = Date.now() - (effectiveInterval * 3600_000);
  const needRefresh = currentWatchlist.items.filter(
    item => (item.lastRefreshedAt || 0) < cutoff
  );
  
  log(`${needRefresh.length} items need refresh (last refresh > ${effectiveInterval}h ago)`);
  
  let refreshed = 0;
  let budgetExhausted = false;
  
  for (const item of needRefresh) {
    if (budgetExhausted && !getFreeHolders) {
      log('Budget exhausted and no free source, stopping refresh');
      break;
    }
    
    const getters = {
      getFreeHolders,
      getFomoHolders: budgetExhausted ? null : getFomoHolders,
      checkBudget: () => !budgetExhausted && checkBudget(250)
    };
    
    const result = await exitRunner.refreshHoldings(item, getters, ledger);
    
    if (result.success) {
      refreshed++;
      log(`Refreshed ${item.chain}:${item.symbol} (${item.snapshotHistory.length} snapshots)`);
      
      // 5. Analyze changes and create alerts
      const alerts = exitRunner.analyzeAndCreateAlerts(item);
      
      if (alerts.length > 0) {
        log(`Generated ${alerts.length} alerts for ${item.chain}:${item.symbol}`);
        
        // 6. Write to queue (not send directly)
        const writeResult = exitRunner.writeAlertsToQueue(alerts, QUEUE_FILE);
        log(`Wrote ${writeResult.written} alerts to queue`);
      }
    } else {
      log(`Failed to refresh ${item.chain}:${item.symbol}: ${result.reason}`);
      
      if (result.reason === 'budget_exhausted') {
        budgetExhausted = true;
      }
    }
    
    // Rate limit between items
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // 7. Save updated watchlist with new snapshots
  exitRunner.saveWatchlist(WATCHLIST_FILE, currentWatchlist);
  
  // 8. Summary
  log('=== Exit Monitoring Runner Complete ===');
  log('Summary:', {
    watchlistTotal: currentWatchlist.items.length,
    refreshed,
    budgetRemaining: MONTHLY_BUDGET - ledger.spent,
    queueFile: QUEUE_FILE
  });
  
  // 9. Show queue stats
  try {
    const stats = alertQueue.getQueueStats(QUEUE_FILE);
    log('Queue stats:', stats);
  } catch {
    log('Queue file not yet created');
  }
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
