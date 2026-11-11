/**
 * Exit Monitoring & Watchlist Management (2026-11-12 Audit Fix #1)
 * 
 * Fixes:
 * - Auto-register candidates to watchlist (was: items always [])
 * - Continuous holding snapshot refresh
 * - Distinguish real position decrease vs sample gaps
 * - Deduped exit alerts with delivery tracking
 * - ❌ Never marks delivered before actual delivery
 */

import crypto from 'node:crypto';

/**
 * Auto-register token to watchlist
 * Uses chain:CA as fixed identity for tracking
 */
export function autoRegisterToWatchlist(token, reason, prevWatchlist = { items: [] }) {
  const key = `${token.chain}:${token.address}`;
  
  const existing = (prevWatchlist.items || []).find(
    item => item.chain === token.chain && item.address === token.address
  );
  
  if (existing) {
    // Update last seen time
    existing.lastSeenAt = Date.now();
    existing.seenCount = (existing.seenCount || 0) + 1;
    return { 
      watchlist: prevWatchlist, 
      registered: false, 
      updated: true,
      entry: existing
    };
  }
  
  // Create new entry
  const entry = {
    id: crypto.randomUUID(),
    chain: token.chain,
    address: token.address,
    symbol: token.symbol || 'UNKNOWN',
    
    // Registration info
    registeredAt: Date.now(),
    registeredReason: reason,  // 'hot_board' | 'user_manual' | 'narrative_match'
    lastSeenAt: Date.now(),
    lastRefreshedAt: 0,
    seenCount: 1,
    
    // Holding snapshot history
    snapshotHistory: [],
    
    // Alert deduplication
    alerts: [],
    
    // Status
    status: 'watching'  // 'watching' | 'exited' | 'downgraded'
  };
  
  const updated = {
    version: prevWatchlist.version || 1,
    lastUpdatedAt: Date.now(),
    items: [...(prevWatchlist.items || []), entry]
  };
  
  return { 
    watchlist: updated, 
    registered: true, 
    newEntry: entry 
  };
}

/**
 * Create holding snapshot
 * Marks sample completeness explicitly
 */
export function createHoldingSnapshot(source, data) {
  const smartWallets = (data.smartWallets || []).map(w => ({
    address: w.address,
    tags: w.tags || [],
    amount: w.amount !== undefined ? w.amount : null,  // null = unknown
    amountUsd: w.amountUsd !== undefined ? w.amountUsd : null
  }));
  
  const totalSampleSize = data.totalSampleSize || smartWallets.length;
  const sampleComplete = Boolean(data.sampleComplete);
  
  return {
    capturedAt: Date.now(),
    source,  // 'fomo' | 'gmgn_on_demand' | 'free_scanner'
    
    smartWallets,
    totalSampleSize,
    sampleComplete,
    
    // Explicit completeness note
    completenessNote: sampleComplete 
      ? '样本完整 (Sample complete)'
      : `部分样本${totalSampleSize}个-覆盖未知 (Partial sample, coverage unknown)`,
      
    // Additional metadata
    metadata: {
      totalHolderCount: data.totalHolderCount || null,
      sampledCount: smartWallets.length,
      threshold: data.threshold || null
    }
  };
}

/**
 * Analyze holding change between two snapshots
 * Key: Distinguish real decrease vs sample gaps
 */
export function analyzeHoldingChange(prevSnapshot, currSnapshot) {
  // No snapshots available
  if (!prevSnapshot || !currSnapshot) {
    return {
      conclusion: 'INSUFFICIENT_DATA',
      reason: '缺少前后快照 (Missing before/after snapshots)',
      canConfirm: false
    };
  }
  
  // Sample incomplete → cannot confirm
  if (!prevSnapshot.sampleComplete || !currSnapshot.sampleComplete) {
    return {
      conclusion: 'INSUFFICIENT_DATA',
      reason: '样本不完整，无法确认清仓或减仓 (Sample incomplete, cannot confirm exit)',
      canConfirm: false,
      prevComplete: prevSnapshot.sampleComplete,
      currComplete: currSnapshot.sampleComplete,
      note: '❌ 样本缺失 ≠ 钱包清仓 (Sample absence ≠ wallet exit)'
    };
  }
  
  // Both complete → can compare
  const prevAddresses = new Set(
    prevSnapshot.smartWallets.map(w => w.address)
  );
  const currAddresses = new Set(
    currSnapshot.smartWallets.map(w => w.address)
  );
  
  const exited = [...prevAddresses].filter(a => !currAddresses.has(a));
  const entered = [...currAddresses].filter(a => !prevAddresses.has(a));
  const netChange = entered.length - exited.length;
  
  // Full exit (all smart wallets gone)
  if (exited.length === prevAddresses.size && currAddresses.size === 0) {
    return {
      conclusion: 'CONFIRMED_FULL_EXIT',
      exitedCount: exited.length,
      exitedWallets: exited,
      severity: 'CRITICAL',
      canConfirm: true,
      message: '✅ 确认完整样本：所有聪明钱已退出 (Confirmed: All smart money exited)'
    };
  }
  
  // Net selling pressure
  if (exited.length > 0 && netChange < 0) {
    return {
      conclusion: 'NET_SELLING_PRESSURE',
      exitedCount: exited.length,
      enteredCount: entered.length,
      netChange,
      exitedWallets: exited,
      enteredWallets: entered,
      severity: exited.length >= 3 ? 'HIGH' : exited.length >= 2 ? 'MEDIUM' : 'LOW',
      canConfirm: true,
      message: `净卖压：${exited.length}个退出，${entered.length}个新进，净变化${netChange}`
    };
  }
  
  // Stable or growing
  return {
    conclusion: 'STABLE_OR_GROWING',
    exitedCount: exited.length,
    enteredCount: entered.length,
    netChange,
    exitedWallets: exited,
    enteredWallets: entered,
    canConfirm: true,
    message: `持稳或增长：${exited.length}个退出，${entered.length}个新进，净变化${netChange}`
  };
}

/**
 * Refresh watchlist holdings
 * Fetches latest data and creates new snapshots
 */
export async function refreshWatchlistHoldings(watchlist, dataSourceGetter) {
  const updated = { 
    ...watchlist, 
    items: [],
    lastRefreshedAt: Date.now()
  };
  
  for (const item of (watchlist.items || [])) {
    try {
      // Get latest holding data
      const freshData = await dataSourceGetter(item.chain, item.address);
      
      if (freshData) {
        const snapshot = createHoldingSnapshot(freshData.source || 'unknown', freshData);
        
        // Add to history (keep last 10 snapshots)
        const history = [...(item.snapshotHistory || []), snapshot].slice(-10);
        
        // Analyze change if we have previous snapshot
        const prevSnapshot = item.snapshotHistory?.[item.snapshotHistory.length - 1];
        let changeAnalysis = null;
        if (prevSnapshot) {
          changeAnalysis = analyzeHoldingChange(prevSnapshot, snapshot);
        }
        
        updated.items.push({
          ...item,
          lastRefreshedAt: Date.now(),
          snapshotHistory: history,
          latestChangeAnalysis: changeAnalysis
        });
      } else {
        // Refresh failed, keep original
        updated.items.push(item);
      }
    } catch (error) {
      console.error(`Failed to refresh ${item.chain}:${item.address}:`, error.message);
      updated.items.push(item);
    }
  }
  
  return updated;
}

/**
 * Alert deduplication key
 */
export function alertDedupeKey(alert) {
  return `${alert.type}:${alert.chain}:${alert.address}:${alert.severity || 'default'}`;
}

/**
 * Check if alert should be sent (deduplication)
 * Only send if not sent recently within window
 */
export function shouldSendAlert(alert, item, dedupeWindowMs = 3600_000) {
  const key = alertDedupeKey(alert);
  const now = Date.now();
  
  // Check alert history
  const recentAlerts = (item.alerts || []).filter(a => {
    const matchesKey = alertDedupeKey(a) === key;
    const withinWindow = (now - a.sentAt) < dedupeWindowMs;
    return matchesKey && withinWindow;
  });
  
  return recentAlerts.length === 0;
}

/**
 * Record alert sent
 * ⚠️ Only call this AFTER actual delivery, not before
 */
export function recordAlertSent(item, alert) {
  if (!item.alerts) {
    item.alerts = [];
  }
  
  const alertRecord = {
    ...alert,
    sentAt: Date.now(),  // ✅ Actual delivery time
    dedupeKey: alertDedupeKey(alert)
  };
  
  // Keep last 50 alerts
  item.alerts = [...item.alerts, alertRecord].slice(-50);
  
  return item;
}

export default {
  autoRegisterToWatchlist,
  createHoldingSnapshot,
  analyzeHoldingChange,
  refreshWatchlistHoldings,
  alertDedupeKey,
  shouldSendAlert,
  recordAlertSent
};
