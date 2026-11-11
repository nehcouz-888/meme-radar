/**
 * Holder Sample Completeness (2026-11-12 Audit Fix #2)
 * 
 * Fixes:
 * - Mark sample completeness explicitly
 * - Distinguish "ranked list" vs "current confirmed" vs "unknown" status
 * - ❌ Sample absence ≠ liquidation
 * - Provide transparency on coverage range
 */

/**
 * Create holder sample with completeness tracking
 */
export function createHolderSample(wallets, metadata = {}) {
  const sampledCount = wallets.length;
  const totalHolderCount = metadata.totalHolderCount || null;
  
  // Determine sample completeness
  let sampleComplete = false;
  let coverage = '';
  let coverageEn = '';
  
  if (totalHolderCount !== null && sampledCount >= totalHolderCount) {
    sampleComplete = true;
    coverage = '当前确认完整';
    coverageEn = 'Current confirmed complete';
  } else if (sampledCount >= 100) {
    // Configurable threshold - 100 wallets is considered representative
    sampleComplete = true;
    coverage = '榜单前100-足够代表性';
    coverageEn = 'Top 100 - sufficient representativeness';
  } else if (totalHolderCount !== null) {
    coverage = `部分样本${sampledCount}/${totalHolderCount}-未知覆盖`;
    coverageEn = `Partial sample ${sampledCount}/${totalHolderCount} - unknown coverage`;
  } else {
    coverage = `部分样本${sampledCount}个-未知总数`;
    coverageEn = `Partial sample ${sampledCount} - unknown total`;
  }
  
  return {
    wallets,
    totalHolderCount,
    sampledCount,
    sampleComplete,
    coverage,
    coverageEn,
    
    // Source and timestamp
    source: metadata.source || 'unknown',
    capturedAt: metadata.capturedAt || Date.now(),
    
    // Additional context
    context: {
      fetchMethod: metadata.fetchMethod || null,  // 'full_scan' | 'top_holders' | 'recent_trades'
      limitApplied: metadata.limitApplied || null,
      hasMore: metadata.hasMore || false
    }
  };
}

/**
 * Token status based on sample completeness
 * Three distinct states: onTopBoard, currentConfirmed, unknown
 */
export function determineTokenStatus(token, holderSample) {
  return {
    // Still appears in ranked list/board
    onTopBoard: token.rank !== null && token.rank !== undefined,
    
    // Current holding confirmed with complete sample
    currentConfirmed: holderSample?.sampleComplete === true,
    
    // Status unknown due to incomplete sample
    unknown: !holderSample || holderSample.sampleComplete === false,
    
    // Coverage info
    coverage: holderSample?.coverage || 'no sample',
    sampleSize: holderSample?.sampledCount || 0
  };
}

/**
 * Score smart money considering sample completeness
 * Three scoring paths: confirmed, unknown (degraded), or board-only
 */
export function scoreSmartMoneyWithCompleteness(token, holderSample, aggregateSmart = 0) {
  const status = determineTokenStatus(token, holderSample);
  const smartWallets = countSmartWallets(holderSample?.wallets || []);
  
  let score = 0;
  let confidence = 'UNKNOWN';
  let note = '';
  let noteEn = '';
  
  // Case 1: Sample complete and confirmed
  if (status.currentConfirmed) {
    score = calculateSmartScore(smartWallets);
    confidence = 'HIGH';
    note = `样本完整确认：${smartWallets}个聪明钱仍持仓`;
    noteEn = `Sample confirmed complete: ${smartWallets} smart wallets still holding`;
    
    if (smartWallets === 0 && aggregateSmart > 0) {
      note += ` (历史${aggregateSmart}个已全部退出)`;
      noteEn += ` (historical ${aggregateSmart} all exited)`;
    }
  }
  // Case 2: Sample incomplete - use degraded historical value
  else if (status.unknown) {
    score = aggregateSmart * 0.3;  // 30% weight for historical uncertain data
    confidence = 'LOW';
    note = `样本不完整(${status.coverage})，降权使用历史聚合${aggregateSmart}个`;
    noteEn = `Sample incomplete (${holderSample?.coverageEn || 'unknown'}), degraded historical aggregate ${aggregateSmart}`;
  }
  // Case 3: On board but no sample data
  else if (status.onTopBoard) {
    score = aggregateSmart * 0.5;  // 50% weight - better than unknown but not confirmed
    confidence = 'MEDIUM';
    note = `仍在榜但无当前样本，使用历史${aggregateSmart}个(降权)`;
    noteEn = `Still on board but no current sample, using historical ${aggregateSmart} (degraded)`;
  }
  
  return {
    smartWallets,
    score,
    confidence,
    status,
    note,
    noteEn,
    
    // Transparency fields
    sampleComplete: status.currentConfirmed,
    sampleSize: status.sampleSize,
    coverage: status.coverage,
    aggregateFallback: !status.currentConfirmed && aggregateSmart > 0
  };
}

/**
 * Count smart wallets in sample
 */
function countSmartWallets(wallets) {
  if (!Array.isArray(wallets)) return 0;
  
  const smartTags = new Set([
    'smart_degen',
    'smart_money',
    'whale',
    'sniper',
    'smart_trader'
  ]);
  
  return wallets.filter(w => {
    const tags = w.tags || [];
    return tags.some(tag => smartTags.has(tag));
  }).length;
}

/**
 * Calculate smart money score
 * Bands: ≥3→+20pts, 2→+10pts, 1→+5pts, 0→0pts
 */
function calculateSmartScore(count) {
  if (count >= 3) return 20;
  if (count === 2) return 10;
  if (count === 1) return 5;
  return 0;
}

/**
 * Merge holders from different sources
 * ⚠️ Keep provenance separate, don't label both as live-confirmed
 */
export function mergeHolderSources(leaderboardHolders, liveSample) {
  // liveSample can be either a holder sample object or array of wallets
  const liveSampleWallets = liveSample?.wallets || (Array.isArray(liveSample) ? liveSample : []);
  const isSampleComplete = liveSample?.sampleComplete === true;
  
  const merged = {
    fromLeaderboard: leaderboardHolders || [],
    fromLiveSample: liveSampleWallets,
    
    // Union for maximum coverage
    unionCount: new Set([
      ...(leaderboardHolders || []).map(w => w.address),
      ...liveSampleWallets.map(w => w.address)
    ]).size,
    
    // Confirmed only from complete live sample
    confirmedCount: isSampleComplete 
      ? liveSampleWallets.length 
      : null,
    
    // Warning if using union
    warning: !isSampleComplete 
      ? '⚠️ 未完整样本，使用并集会虚高 (Incomplete sample, union inflates count)'
      : null
  };
  
  return merged;
}

/**
 * Compare contradictory samples (for testing)
 * E.g., leaderboard says [SMART_A, SMART_B], live says only [SMART_A]
 */
export function detectContradictorySamples(leaderboardHolders, liveSample) {
  if (!liveSample?.sampleComplete) {
    return {
      contradictory: false,
      reason: 'Live sample incomplete, cannot determine contradiction'
    };
  }
  
  const leaderboardSet = new Set((leaderboardHolders || []).map(w => w.address));
  const liveSet = new Set((liveSample.wallets || []).map(w => w.address));
  
  const onlyInLeaderboard = [...leaderboardSet].filter(a => !liveSet.has(a));
  const onlyInLive = [...liveSet].filter(a => !leaderboardSet.has(a));
  
  if (onlyInLeaderboard.length > 0 || onlyInLive.length > 0) {
    return {
      contradictory: true,
      onlyInLeaderboard,
      onlyInLive,
      note: `Leaderboard shows ${leaderboardSet.size}, live confirms ${liveSet.size}`,
      recommendation: 'Use live confirmed count only'
    };
  }
  
  return {
    contradictory: false,
    reason: 'Samples consistent'
  };
}

export default {
  createHolderSample,
  determineTokenStatus,
  scoreSmartMoneyWithCompleteness,
  mergeHolderSources,
  detectContradictorySamples
};
