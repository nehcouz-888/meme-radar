#!/usr/bin/env node
// INTEGRATED VERSION: fomo-free-scan with audit fixes
// Changes:
// - Market cap tiers (no <$100k hard limit)
// - Holder sample completeness tracking
// - Smart money scoring ONLY for confirmed still-holding (no historical fallback)

import fs from 'node:fs';
import path from 'node:path';

// Import audit fix modules
import { categorizeByMarketCap, marketCapScoreModifier, checkTierEvidenceRequirements } from '../src/modules/market-cap-tiers.mjs';
import { createHolderSample, scoreSmartMoneyWithCompleteness } from '../src/modules/holder-sample.mjs';

const ROOT = process.env.SCAN_ROOT || '/workspace/meme-radar-run/meme-radar-branch';
const STATE = path.join(ROOT, 'state');
const OUT_DIR = process.env.REPORT_OUT_DIR || '/workspace/ebooks/out';
const LEDGER = path.join(STATE, 'fomo-credits-ledger.json');
const CHAINS = (process.env.FOMO_FREE_CHAINS || 'sol,bsc,base').split(',').map(s => s.trim()).filter(Boolean);
const MONTHLY_BUDGET = Number(process.env.FOMO_MONTHLY_CREDIT_BUDGET || 150000);

// ❌ REMOVED: discoveryMaxMarketCap hard limit
// ✅ NEW: Market cap tiering with evidence requirements
const MARKET_CAP_TIERS_ENABLED = process.env.MARKET_CAP_TIERS_ENABLED !== '0';

const STAMP = new Date().toISOString();
const log = (...a) => console.error(`[fomo_free_integrated ${new Date().toISOString()}]`, ...a);
const num = v => (v === null || v === undefined || v === '' || typeof v === 'boolean') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);

const errors = [];
const metrics = { requests: {}, rateLimits: 0, tierDistribution: {} };
const cands = new Map();

// Smart money handles (simplified - would load from actual config)
const SMART_HANDLES = new Set();

/**
 * INTEGRATED SCORING with audit fixes
 */
function scoreWithAuditFixes(c, smartLeaderboard) {
  const notes = [], flags = [];
  let baseScore = 10;
  let reject = null;
  
  // 1. Market cap tiering (Fix #1)
  const tierInfo = categorizeByMarketCap(c.mcap || 0);
  c.marketCapTier = tierInfo.tier;
  c.marketCapBand = tierInfo.marketCapBand;
  metrics.tierDistribution[tierInfo.tier] = (metrics.tierDistribution[tierInfo.tier] || 0) + 1;
  
  // Check tier evidence requirements
  const evidenceCheck = checkTierEvidenceRequirements({
    marketCap: c.mcap,
    crossValidated: c.crossValidated || false,
    sourceCount: (c.sources || []).length,
    evidenceConfidence: c.evidenceConfidence || 'UNKNOWN'
  }, tierInfo);
  
  if (!evidenceCheck.qualified) {
    notes.push(...evidenceCheck.warnings);
    flags.push('INSUFFICIENT_EVIDENCE');
  }
  
  // 2. Basic filters (unchanged)
  if (c.liq == null) {
    return { 
      ...c, 
      score: 0, 
      tier: 'ignore', 
      status: 'NO_MARKET_DATA', 
      notes: ['DexScreener 无数据'], 
      flags,
      marketCapTier: tierInfo.tier
    };
  }
  
  if (c.liq < 5000) {
    reject = 'liq<5k';
  }
  
  // 3. Smart money scoring with holder sample completeness (Fix #2 & #3)
  const k = c.chain === 'sol' ? c.address : c.address.toLowerCase();
  const leaderboardHolders = smartLeaderboard.holding.get(k);
  
  // Create holder sample
  const liveHolders = c.fomoHoldersLive; // from /token/{addr}/holders when called
  const holderSample = liveHolders ? createHolderSample(
    liveHolders.map(h => ({ 
      address: h, 
      tags: SMART_HANDLES.has(h.toLowerCase()) ? ['smart_degen'] : [] 
    })),
    {
      totalHolderCount: liveHolders.length,
      source: 'fomo:token-holders',
      sampleComplete: true  // Live API gives complete list
    }
  ) : (leaderboardHolders ? createHolderSample(
    [...leaderboardHolders].map(h => ({ address: h, tags: ['smart_degen'] })),
    {
      totalHolderCount: null,  // Unknown from leaderboard
      source: 'fomo:leaderboard-topTokens',
      sampleComplete: false  // Partial from topTokens
    }
  ) : null);
  
  // Score smart money (Fix #3: NO historical fallback scoring)
  const aggregateSmart = 0;  // We don't use aggregate for scoring anymore
  const smartScore = holderSample ? scoreSmartMoneyWithCompleteness(
    { rank: c.fomo?.trendingRank },
    holderSample,
    aggregateSmart
  ) : { score: 0, smartWallets: 0, confidence: 'UNKNOWN', note: 'No holder data' };
  
  // Add smart money score
  baseScore += smartScore.score;
  
  // Store smart money info
  c.smart = {
    stillHolding: smartScore.smartWallets,
    score: smartScore.score,
    confidence: smartScore.confidence,
    sampleComplete: holderSample?.sampleComplete || false,
    coverage: holderSample?.coverage || 'no sample',
    note: smartScore.note,
    // For transparency
    source: holderSample?.source || 'none',
    fomoUsersHolding: liveHolders?.length ?? null
  };
  
  notes.push(smartScore.note);
  
  // 4. Liquidity scoring
  baseScore += c.liq < 10e3 ? 5 : c.liq < 50e3 ? 12 : c.liq < 200e3 ? 15 : 10;
  
  // 5. Market cap scoring (tiered, not binary)
  if (c.mcap != null) {
    // Different scoring for different tiers
    if (tierInfo.tier === 'EMBRYONIC') {
      baseScore += c.mcap >= 10e3 && c.mcap <= 50e3 ? 12 : 4;
    } else if (tierInfo.tier === 'EARLY') {
      baseScore += c.mcap >= 50e3 && c.mcap <= 200e3 ? 12 : 6;
    } else if (tierInfo.tier === 'GROWTH') {
      baseScore += c.mcap >= 200e3 && c.mcap <= 1e6 ? 10 : 4;
    } else {
      // ESTABLISHED and LARGE_CAP get lower base scoring
      baseScore += 4;
    }
  }
  
  // 6. Volume/txn scoring
  if (c.vol24 != null && c.liq) {
    const r = c.vol24 / c.liq;
    baseScore += r > 3 ? 10 : r > 1 ? 6 : 0;
  }
  
  if (c.buys1h != null && c.sells1h != null) {
    if (c.buys1h > 1.2 * c.sells1h) baseScore += 6;
    if (c.buys1h + c.sells1h > 200) baseScore += 5;
  }
  
  // 7. Price change
  if (c.chg1h != null) {
    if (c.chg1h > 0) baseScore += 4;
    if (c.chg1h < -30) {
      baseScore -= 10;
      flags.push('1h跌>30%');
    }
  }
  
  if (c.chg24 != null && c.chg24 > 50) baseScore += 5;
  
  // 8. Apply market cap tier modifier
  const modifier = marketCapScoreModifier(tierInfo.tier);
  const adjustedScore = Math.round(baseScore * modifier);
  
  // 9. Determine tier and status
  let tier = 'ignore';
  let status = 'WAIT_RECHECK';
  
  if (reject) {
    tier = 'ignore';
    status = `HARD_REJECT:${reject}`;
  } else if (adjustedScore >= 70) {
    tier = 'watch';
    status = 'WAIT_RECHECK';  // Degraded mode: always WAIT_RECHECK
  } else if (adjustedScore >= 50) {
    tier = 'monitor';
    status = 'WEAK';
  }
  
  return {
    ...c,
    score: adjustedScore,
    baseScore,
    marketCapModifier: modifier,
    tier,
    status,
    notes,
    flags,
    evidenceCheck
  };
}

/**
 * Main scoring entry point
 */
function score(c, smart) {
  return scoreWithAuditFixes(c, smart);
}

// Export for testing
export {
  scoreWithAuditFixes,
  score
};

// Main execution would go here (simplified for integration)
if (import.meta.url === `file://${process.argv[1]}`) {
  log('Integrated fomo-free-scan started');
  log('Market cap tiers enabled:', MARKET_CAP_TIERS_ENABLED);
  log('Chains:', CHAINS.join(', '));
  
  // Would run full scan here
  log('⚠️ This is integrated version - call from actual entry point');
}
