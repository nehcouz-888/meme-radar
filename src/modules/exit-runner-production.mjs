/**
 * Exit Runner Production (2026-11-12 Audit Fix #1 Complete)
 * 
 * Real exit monitoring loop:
 * 1. Auto-register from fomo-free scan candidates (chain:CA)
 * 2. Refresh holdings from free sources + Fomo budget-constrained
 * 3. Analyze changes (2→0 with evidence, net pressure, dropped from board)
 * 4. Write alerts to queue (parent handles delivery)
 * 5. Continue monitoring dropped tokens
 * 
 * Budget: Fomo monthly cap enforced, free sources rate-limited
 * Completeness: Sample incomplete → unknown, not assume exit
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const log = (...a) => console.error(`[exit_runner ${new Date().toISOString()}]`, ...a);

/**
 * Load watchlist with migration
 */
export function loadWatchlist(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    
    if (!data.version || data.version < 3) {
      return {
        version: 3,
        lastUpdatedAt: Date.now(),
        items: (data.items || []).map(item => ({
          ...item,
          snapshotHistory: item.snapshotHistory || [],
          alerts: item.alerts || [],
          status: item.status || 'watching',
          refreshAttempts: item.refreshAttempts || 0,
          lastRefreshSuccess: item.lastRefreshSuccess || null
        }))
      };
    }
    
    return data;
  } catch (error) {
    log('Watchlist not found, creating new');
    return {
      version: 3,
      lastUpdatedAt: Date.now(),
      items: []
    };
  }
}

/**
 * Save watchlist atomically
 */
export function saveWatchlist(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Auto-register candidates from scan results
 * Uses chain:CA as stable identity
 */
export function registerFromScanResults(scanOutput, currentWatchlist, source = 'fomo_free') {
  const registered = [];
  const updated = { ...currentWatchlist };
  
  for (const candidate of (scanOutput.candidates || [])) {
    if (!candidate.chain || !candidate.address) continue;
    
    const key = `${candidate.chain}:${candidate.address}`;
    const existing = updated.items.find(
      item => item.chain === candidate.chain && item.address === candidate.address
    );
    
    if (existing) {
      // Update last seen
      existing.lastSeenAt = Date.now();
      existing.seenCount = (existing.seenCount || 0) + 1;
      existing.lastSeenOnBoard = candidate.rank || existing.lastSeenOnBoard;
    } else {
      // Register new
      const entry = {
        id: crypto.randomUUID(),
        chain: candidate.chain,
        address: candidate.address,
        symbol: candidate.symbol || 'UNKNOWN',
        
        registeredAt: Date.now(),
        registeredSource: source,
        registeredRank: candidate.rank || null,
        lastSeenAt: Date.now(),
        lastSeenOnBoard: candidate.rank || null,
        lastRefreshedAt: 0,
        lastRefreshSuccess: null,
        seenCount: 1,
        refreshAttempts: 0,
        
        snapshotHistory: [],
        alerts: [],
        
        status: 'watching',
        droppedFromBoard: false,
        droppedAt: null
      };
      
      updated.items.push(entry);
      registered.push(entry);
    }
  }
  
  updated.lastUpdatedAt = Date.now();
  
  return { watchlist: updated, registered, total: updated.items.length };
}

/**
 * Mark tokens that dropped from board (continue monitoring)
 */
export function markDroppedFromBoard(watchlist, currentBoardTokens) {
  const boardKeys = new Set(
    currentBoardTokens.map(t => `${t.chain}:${t.address}`)
  );
  
  for (const item of watchlist.items) {
    const key = `${item.chain}:${item.address}`;
    const onBoard = boardKeys.has(key);
    
    if (!onBoard && !item.droppedFromBoard && item.seenCount > 0) {
      item.droppedFromBoard = true;
      item.droppedAt = Date.now();
      log(`Dropped from board: ${item.chain}:${item.symbol}`);
    } else if (onBoard && item.droppedFromBoard) {
      // Re-appeared on board
      item.droppedFromBoard = false;
      item.droppedAt = null;
      log(`Re-appeared on board: ${item.chain}:${item.symbol}`);
    }
  }
  
  return watchlist;
}

/**
 * Refresh holdings with budget tracking
 * 
 * Strategy:
 * - Free sources first (GeckoTerminal top holders if available)
 * - Fomo as backup with budget check
 * - Track coverage explicitly
 */
export async function refreshHoldings(item, getters, budget) {
  const { getFreeHolders, getFomoHolders, checkBudget } = getters;
  
  item.refreshAttempts = (item.refreshAttempts || 0) + 1;
  
  try {
    // Try free source first
    let data = null;
    let source = null;
    
    if (getFreeHolders) {
      data = await getFreeHolders(item.chain, item.address);
      source = 'free';
    }
    
    // Fallback to Fomo if free fails and budget allows
    if (!data && getFomoHolders && checkBudget) {
      const estCost = 250; // /v2/tokens/{id}/holders estimate
      if (checkBudget(estCost)) {
        data = await getFomoHolders(item.chain, item.address);
        source = 'fomo';
      } else {
        log(`Budget exhausted, skipping Fomo for ${item.chain}:${item.symbol}`);
      }
    }
    
    if (data) {
      const snapshot = {
        capturedAt: Date.now(),
        source,
        
        smartWallets: (data.smartWallets || []).map(w => ({
          address: w.address,
          tags: w.tags || [],
          amount: w.amount !== undefined ? w.amount : null,
          amountUsd: w.amountUsd !== undefined ? w.amountUsd : null
        })),
        
        totalSampleSize: data.totalSampleSize || (data.smartWallets || []).length,
        sampleComplete: Boolean(data.sampleComplete),
        
        completenessNote: data.sampleComplete 
          ? '样本完整 (Sample complete)'
          : `部分样本 (Partial sample, coverage unknown)`,
        
        metadata: {
          totalHolderCount: data.totalHolderCount || null,
          sampledCount: (data.smartWallets || []).length,
          source
        }
      };
      
      // Add to history (keep last 20 for deep analysis)
      item.snapshotHistory = [...(item.snapshotHistory || []), snapshot].slice(-20);
      item.lastRefreshedAt = Date.now();
      item.lastRefreshSuccess = Date.now();
      
      return { success: true, snapshot };
    } else {
      log(`No data for ${item.chain}:${item.symbol} after ${item.refreshAttempts} attempts`);
      return { success: false, reason: 'no_data' };
    }
  } catch (error) {
    log(`Refresh failed for ${item.chain}:${item.symbol}:`, error.message);
    return { success: false, reason: error.message };
  }
}

/**
 * Analyze holdings change and generate alert events
 * Returns array of alert events (to be written to queue, not sent directly)
 */
export function analyzeAndCreateAlerts(item) {
  const alerts = [];
  
  // Event 3: Dropped from board (independent of snapshots)
  if (item.droppedFromBoard && !item.droppedAlertSent) {
    alerts.push({
      type: 'DROPPED_FROM_BOARD',
      chain: item.chain,
      address: item.address,
      symbol: item.symbol,
      severity: 'INFO',
      message: `跌出榜单 ${item.symbol}，继续监控持仓变化`,
      messageEn: `${item.symbol} dropped from board, continuing monitoring`,
      evidence: {
        lastSeenOnBoard: item.lastSeenOnBoard,
        droppedAt: item.droppedAt
      },
      eventTime: item.droppedAt || Date.now()
    });
    item.droppedAlertSent = true;
  }
  
  // Need at least 2 snapshots for holding change analysis
  if ((item.snapshotHistory || []).length < 2) {
    // First refresh, establish baseline (no alert for holdings)
    return alerts;
  }
  
  const prev = item.snapshotHistory[item.snapshotHistory.length - 2];
  const curr = item.snapshotHistory[item.snapshotHistory.length - 1];
  
  // Sample incomplete → cannot confirm exit
  if (!prev.sampleComplete || !curr.sampleComplete) {
    log(`Sample incomplete for ${item.chain}:${item.symbol}, cannot confirm changes`);
    return alerts;
  }
  
  // Analyze wallet changes
  const prevAddresses = new Set(prev.smartWallets.map(w => w.address));
  const currAddresses = new Set(curr.smartWallets.map(w => w.address));
  
  const exited = [...prevAddresses].filter(a => !currAddresses.has(a));
  const entered = [...currAddresses].filter(a => !prevAddresses.has(a));
  const holderCountChange = entered.length - exited.length;
  
  // Event 1: Full exit (2→0 with complete samples AND balance evidence)
  if (exited.length === prevAddresses.size && currAddresses.size === 0 && prevAddresses.size > 0) {
    // ✅ FULL_EXIT requires balance evidence (not just holder count)
    // Check if we have actual balance/amount changes
    const prevTotalAmount = prev.smartWallets.reduce((sum, w) => sum + (w.amount || 0), 0);
    const currTotalAmount = curr.smartWallets.reduce((sum, w) => sum + (w.amount || 0), 0);
    
    // If no amount data, mark as incomplete evidence
    if (prevTotalAmount === 0 || !prev.smartWallets.every(w => w.amount !== undefined)) {
      log(`FULL_EXIT skipped for ${item.chain}:${item.symbol} - no balance evidence (holder count only)`);
      return alerts;
    }
    
    alerts.push({
      type: 'FULL_EXIT',
      chain: item.chain,
      address: item.address,
      symbol: item.symbol,
      severity: 'CRITICAL',
      exitedCount: exited.length,
      balanceChange: {
        prev: prevTotalAmount,
        curr: currTotalAmount,
        percentChange: -100
      },
      message: `完整样本确认：所有${exited.length}个聪明钱已退出 ${item.symbol}（余额由${prevTotalAmount.toFixed(0)}归零）`,
      messageEn: `Confirmed: All ${exited.length} smart money exited ${item.symbol} (balance from ${prevTotalAmount.toFixed(0)} to 0)`,
      evidence: {
        prevSnapshot: { count: prevAddresses.size, totalAmount: prevTotalAmount, complete: true },
        currSnapshot: { count: currAddresses.size, totalAmount: currTotalAmount, complete: true },
        exitedWallets: exited.slice(0, 5) // First 5 for privacy
      },
      eventTime: curr.capturedAt
    });
  }
  // Event 2: Holder count change (NOT net selling pressure - that requires trade volume)
  else if (exited.length > 0 && holderCountChange < 0) {
    alerts.push({
      type: 'HOLDER_COUNT_DECLINE',
      chain: item.chain,
      address: item.address,
      symbol: item.symbol,
      severity: exited.length >= 3 ? 'MEDIUM' : 'LOW',
      exitedCount: exited.length,
      enteredCount: entered.length,
      holderCountChange,
      message: `持仓人数下降 ${item.symbol}: ${exited.length}退出, ${entered.length}新进, 净${holderCountChange}人`,
      messageEn: `Holder count decline ${item.symbol}: ${exited.length} out, ${entered.length} in, net ${holderCountChange}`,
      evidence: {
        exitedWallets: exited.slice(0, 3),
        enteredWallets: entered.slice(0, 3)
      },
      note: '持仓人数变动，非净卖压（净卖压需要成交量数据）',
      eventTime: curr.capturedAt
    });
  }
  
  // Event 2b: Net selling pressure (requires actual trade volume data)
  // ❌ Currently NOT implemented - requires integration with trade volume sources
  // TODO: Integrate with Fomo trade history or DEX transaction data for real buy/sell volumes
  // Sample structure (for future implementation):
  // if (prev.tradeVolume && curr.tradeVolume) {
  //   const sellVolume = curr.tradeVolume.sell - prev.tradeVolume.sell;
  //   const buyVolume = curr.tradeVolume.buy - prev.tradeVolume.buy;
  //   if (sellVolume > buyVolume * 1.5) {
  //     alerts.push({ type: 'NET_SELLING_PRESSURE', ... });
  //   }
  // }
  
  return alerts;
}

/**
 * Write alerts to queue (not send directly)
 * Parent process will claim and deliver
 */
export function writeAlertsToQueue(alerts, queueFile) {
  if (!alerts || alerts.length === 0) return { written: 0 };
  
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });
  
  let written = 0;
  for (const alert of alerts) {
    const queueEntry = {
      eventId: crypto.randomUUID(),
      status: 'pending',
      type: 'exit_monitoring',
      alertType: alert.type,
      whenIso: new Date(alert.eventTime || Date.now()).toISOString(),
      createdAt: new Date().toISOString(),
      
      chain: alert.chain,
      address: alert.address,
      symbol: alert.symbol,
      severity: alert.severity,
      
      text: alert.message,
      textEn: alert.messageEn,
      
      evidence: alert.evidence,
      
      // Deduplication
      dedupeKey: `exit:${alert.type}:${alert.chain}:${alert.address}:${alert.severity}`
    };
    
    fs.appendFileSync(queueFile, JSON.stringify(queueEntry) + '\n');
    written++;
  }
  
  log(`Wrote ${written} alerts to queue: ${queueFile}`);
  return { written };
}

/**
 * Calculate recommended refresh interval
 * Based on watchlist size and budget
 * 
 * @param {number} watchlistSize - Number of tokens in watchlist
 * @param {number} monthlyBudget - Monthly credit budget (NOT dollars, Fomo API credits)
 * @param {Object} options - Configuration options
 * @param {number} options.avgCostPerToken - Average cost per token refresh (default: 250 credits)
 * @param {number} options.freeCoverageRatio - Expected coverage from free sources 0-1 (default: 0.5)
 * @param {number} options.exitBudgetShare - Share of monthly budget for exit monitoring 0-1 (default: 0.3)
 * @returns {Object} Interval calculation with formula
 */
export function calculateRefreshInterval(watchlistSize, monthlyBudget, options = {}) {
  const {
    avgCostPerToken = 250,
    freeCoverageRatio = Number(process.env.EXIT_FREE_COVERAGE_RATIO || 0.5),
    exitBudgetShare = Number(process.env.EXIT_BUDGET_SHARE || 0.3)
  } = options;
  
  // ✅ Explicit budget allocation (not /2 to hide expansion)
  // Exit monitoring gets configured share of total budget
  // Remaining budget stays available for scan operations
  const exitMonthlyBudget = Math.floor(monthlyBudget * exitBudgetShare);
  
  // Effective cost after free source coverage
  const effectiveCost = avgCostPerToken * (1 - freeCoverageRatio);
  
  // Monthly capacity for exit monitoring only
  const monthlyRefreshes = Math.floor(exitMonthlyBudget / effectiveCost);
  const perTokenRefreshesPerMonth = Math.floor(monthlyRefreshes / Math.max(1, watchlistSize));
  
  // Convert to hours interval
  const hoursPerMonth = 30 * 24;
  const intervalHours = Math.max(4, Math.floor(hoursPerMonth / Math.max(1, perTokenRefreshesPerMonth)));
  
  return {
    intervalHours,
    perTokenRefreshesPerMonth,
    exitBudgetAllocated: exitMonthlyBudget,
    exitBudgetShare,
    freeCoverageRatio,
    monthlyBudgetUsed: perTokenRefreshesPerMonth * watchlistSize * effectiveCost,
    formula: `${monthlyBudget} credits * ${exitBudgetShare} exit_share = ${exitMonthlyBudget} → ${exitMonthlyBudget} / (${avgCostPerToken} * ${1-freeCoverageRatio} effective) / ${watchlistSize} tokens = ${perTokenRefreshesPerMonth} refreshes/token/month = every ${intervalHours}h`
  };
}

export default {
  loadWatchlist,
  saveWatchlist,
  registerFromScanResults,
  markDroppedFromBoard,
  refreshHoldings,
  analyzeAndCreateAlerts,
  writeAlertsToQueue,
  calculateRefreshInterval
};
