/**
 * Position Analysis & Amount Clarification (2026-11-12 Audit Fix #6)
 * 
 * Problem: Watcher混淆了 tradeUsd (成交额), positionValueUsd (持仓市值), totalAssetsUsd (总资产)
 * Example MASK: tradeUsd=null, positionValue=399021, assets=388084 → 102.8% anomaly
 * 
 * Fixes:
 * - Distinguish transaction amount / position market value / asset coverage
 * - ❌ Cannot use positionValue as trade amount
 * - newPosition calculation requires real transaction amount
 * - Mark >100% anomalies explicitly
 * - ❌ Don't claim "5% new position" when unknown
 * - ⚠️ User-explicit $3000 fallback OK but need real amount + downgrade label
 */

/**
 * Three distinct concepts for wallet transactions
 */
export function analyzeTransaction(event) {
  const tx = {
    // 1. Transaction Amount - actual buy/sell amount
    tradeUsd: parseFloat(event.tradeUsd) || null,
    
    // 2. Position Value - current market value of holdings (post-transaction estimate)
    positionValueUsd: parseFloat(event.usdValue || event.positionValueUsd) || null,
    
    // 3. Total Assets - wallet's total asset value
    totalAssetsUsd: parseFloat(event.totalValueUsd || event.totalAssetsUsd || event.assets) || null,
    
    // Metadata
    eventId: event.eventId || event.id,
    timestamp: event.timestamp || Date.now(),
    wallet: event.wallet || event.address,
    token: event.token || event.tokenAddress
  };
  
  // Analyze position size
  const positionAnalysis = analyzePositionSize(tx, event);
  
  // Detect anomalies
  const anomalies = detectPositionAnomalies(tx);
  
  return {
    ...tx,
    ...positionAnalysis,
    anomalies,
    hasAnomalies: anomalies.length > 0
  };
}

/**
 * Analyze position size with proper logic
 * Returns newPosition confidence and qualification
 */
export function analyzePositionSize(tx, metadata = {}) {
  // Case 1: No trade amount → cannot determine
  if (tx.tradeUsd === null || tx.tradeUsd === undefined) {
    return {
      isNewPosition: false,
      reason: '无成交额数据 (No trade amount data)',
      confidence: 'UNKNOWN',
      qualifies5Percent: false,
      note: `仅有持仓市值$${tx.positionValueUsd || 'unknown'}，无实际成交额`,
      noteEn: `Only position value $${tx.positionValueUsd || 'unknown'}, no actual trade amount`,
      cannotDetermine: true
    };
  }
  
  // Case 2: Trade amount ≤ 0
  if (tx.tradeUsd <= 0) {
    return {
      isNewPosition: false,
      reason: '成交额为0或负数 (Trade amount zero or negative)',
      confidence: 'LOW',
      qualifies5Percent: false
    };
  }
  
  // Case 3: Has trade amount AND total assets → calculate ratio
  if (tx.totalAssetsUsd !== null && tx.totalAssetsUsd > 0) {
    const ratio = tx.tradeUsd / tx.totalAssetsUsd;
    
    // Sub-case: Anomaly - trade exceeds assets
    if (ratio > 1.0) {
      return {
        isNewPosition: true,  // Still consider as new position
        positionRatio: ratio,
        anomaly: 'TRADE_EXCEEDS_ASSETS',
        anomalyNote: `成交额$${tx.tradeUsd.toFixed(0)}超过总资产$${tx.totalAssetsUsd.toFixed(0)}`,
        anomalyNoteEn: `Trade amount $${tx.tradeUsd.toFixed(0)} exceeds total assets $${tx.totalAssetsUsd.toFixed(0)}`,
        confidence: 'LOW',
        qualifies5Percent: ratio >= 0.05,
        warning: '⚠️ 数据异常：可能的原因包括数据延迟、杠杆或报价差异'
      };
    }
    
    // Sub-case: Normal ratio calculation
    return {
      isNewPosition: ratio >= 0.05,
      positionRatio: ratio,
      positionPercent: (ratio * 100).toFixed(1),
      confidence: 'HIGH',
      qualifies5Percent: ratio >= 0.05,
      note: `成交${(ratio * 100).toFixed(1)}%资产`,
      noteEn: `Trade ${(ratio * 100).toFixed(1)}% of assets`,
      calculation: {
        tradeUsd: tx.tradeUsd,
        totalAssetsUsd: tx.totalAssetsUsd,
        ratio
      }
    };
  }
  
  // Case 4: Has trade amount, NO total assets → use fallback threshold
  if (tx.tradeUsd >= 3000) {
    // User-explicit $3000 fallback (documented in audit)
    return {
      isNewPosition: true,
      tradeUsd: tx.tradeUsd,
      confidence: 'MEDIUM',
      qualifies5Percent: 'ASSUMED',  // ⚠️ Explicit assumption marker
      fallbackUsed: true,
      fallbackThreshold: 3000,
      note: '总资产未知，使用$3000阈值fallback（用户明确）',
      noteEn: 'Total assets unknown, using $3000 threshold fallback (user-explicit)',
      warning: '⚠️ This is a fallback heuristic, actual position ratio unknown'
    };
  }
  
  // Case 5: Trade amount < $3000 and no total assets
  return {
    isNewPosition: false,
    reason: '成交额不足$3000且总资产未知 (Trade < $3000 and no asset data)',
    confidence: 'LOW',
    qualifies5Percent: false,
    tradeUsd: tx.tradeUsd,
    note: `成交额$${tx.tradeUsd.toFixed(0)}低于fallback阈值$3000`
  };
}

/**
 * Detect position anomalies
 * Returns array of anomaly objects
 */
export function detectPositionAnomalies(tx) {
  const anomalies = [];
  
  // Anomaly 1: Position value exceeds total assets
  if (tx.positionValueUsd !== null && 
      tx.totalAssetsUsd !== null && 
      tx.totalAssetsUsd > 0) {
    const ratio = tx.positionValueUsd / tx.totalAssetsUsd;
    
    if (ratio > 1.0) {
      anomalies.push({
        type: 'POSITION_EXCEEDS_ASSETS',
        ratio: ratio,
        positionPercent: (ratio * 100).toFixed(1),
        severity: ratio > 2.0 ? 'HIGH' : ratio > 1.5 ? 'MEDIUM' : 'LOW',
        message: `单币种仓位${(ratio * 100).toFixed(1)}%超过总资产`,
        messageEn: `Single token position ${(ratio * 100).toFixed(1)}% exceeds total assets`,
        note: '可能的原因：数据延迟、杠杆、或报价差异',
        noteEn: 'Possible causes: data lag, leverage, or price discrepancy',
        recommendation: '⚠️ 标记异常但不指控钱包造假'
      });
    }
  }
  
  // Anomaly 2: Missing trade amount (only have position value)
  if (tx.tradeUsd === null && tx.positionValueUsd !== null) {
    anomalies.push({
      type: 'MISSING_TRADE_AMOUNT',
      severity: 'LOW',
      message: '仅有持仓市值，无实际成交额',
      messageEn: 'Only position value available, no actual trade amount',
      impact: '无法确认买入规模 (Cannot confirm buy size)',
      recommendation: 'Cannot use position value as trade amount'
    });
  }
  
  // Anomaly 3: Trade amount significantly different from position value
  if (tx.tradeUsd !== null && 
      tx.positionValueUsd !== null && 
      tx.tradeUsd > 0) {
    const diff = Math.abs(tx.positionValueUsd - tx.tradeUsd);
    const diffRatio = diff / tx.tradeUsd;
    
    if (diffRatio > 0.5) {  // >50% difference
      anomalies.push({
        type: 'TRADE_POSITION_MISMATCH',
        severity: 'INFO',
        tradeUsd: tx.tradeUsd,
        positionValueUsd: tx.positionValueUsd,
        difference: diff,
        diffPercent: (diffRatio * 100).toFixed(1),
        message: `成交额与持仓估值差异${(diffRatio * 100).toFixed(1)}%`,
        messageEn: `Trade amount vs position value differs by ${(diffRatio * 100).toFixed(1)}%`,
        note: '可能因价格变动或其他持仓累加',
        recommendation: '使用成交额而非持仓估值'
      });
    }
  }
  
  return anomalies;
}

/**
 * Format anomalies for display
 */
export function formatAnomalies(anomalies) {
  if (!anomalies || anomalies.length === 0) {
    return {
      hasAnomalies: false,
      summary: '无异常 (No anomalies)',
      displayText: ''
    };
  }
  
  const lines = ['⚠️ 数据异常检测 (Data Anomalies):'];
  
  for (const anomaly of anomalies) {
    lines.push(`  - [${anomaly.severity}] ${anomaly.message}`);
    if (anomaly.recommendation) {
      lines.push(`    ${anomaly.recommendation}`);
    }
  }
  
  return {
    hasAnomalies: true,
    count: anomalies.length,
    highSeverityCount: anomalies.filter(a => a.severity === 'HIGH').length,
    summary: `${anomalies.length}个异常`,
    displayText: lines.join('\n')
  };
}

/**
 * Legacy compatibility: check if using old buggy logic
 * Old logic: tradeAmount = tradeUsd || usdValue || positionValueUsd (WRONG!)
 */
export function wouldHaveUsedPositionValueAsTrade(event) {
  const hasNoTradeUsd = !event.tradeUsd;
  const hasPositionValue = Boolean(event.usdValue || event.positionValueUsd);
  
  if (hasNoTradeUsd && hasPositionValue) {
    return {
      wouldHaveUsed: true,
      wrongValue: event.usdValue || event.positionValueUsd,
      warning: '⚠️ 旧逻辑会错误使用持仓市值当成交额 (Old logic would incorrectly use position value as trade amount)'
    };
  }
  
  return {
    wouldHaveUsed: false
  };
}

export default {
  analyzeTransaction,
  analyzePositionSize,
  detectPositionAnomalies,
  formatAnomalies,
  wouldHaveUsedPositionValueAsTrade
};
