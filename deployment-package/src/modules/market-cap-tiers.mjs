/**
 * Market Cap Tiering System (2026-11-12 Audit Fix #1)
 * 
 * User Authorization Change:
 * ❌ REMOVED: <$100k as hard exclusion threshold
 * ✅ CHANGED: Market cap as reference/tiering factor only
 * ⚠️ MAINTAINED: Safety, risk, and evidence requirements remain strict
 * 
 * Goal: Early opportunity research + reliable exit alerts, not auto-trading/posting
 */

/**
 * Market cap tier definitions
 * Each tier has different minimum evidence requirements
 * Higher market cap = stricter evidence needed for same scoring
 */
export const MARKET_CAP_TIERS = Object.freeze({
  EMBRYONIC: {
    label: '萌芽期',
    labelEn: 'Embryonic',
    minMcap: 0,
    maxMcap: 50_000,
    minEvidence: 'MEDIUM',
    description: '超早期发现，需要中等证据置信度',
    descriptionEn: 'Very early discovery, requires medium evidence confidence'
  },
  
  EARLY: {
    label: '早期',
    labelEn: 'Early',
    minMcap: 50_000,
    maxMcap: 200_000,
    minEvidence: 'MEDIUM',
    description: '早期机会，需要中等证据',
    descriptionEn: 'Early opportunity, requires medium evidence'
  },
  
  GROWTH: {
    label: '成长期',
    labelEn: 'Growth',
    minMcap: 200_000,
    maxMcap: 1_000_000,
    minEvidence: 'HIGH',
    description: '成长阶段，需要高证据置信度',
    descriptionEn: 'Growth stage, requires high evidence confidence'
  },
  
  ESTABLISHED: {
    label: '存量期',
    labelEn: 'Established',
    minMcap: 1_000_000,
    maxMcap: 20_000_000,
    minEvidence: 'STRICT',
    requireCrossValidation: true,
    description: '存量币，需要严格跨源验证',
    descriptionEn: 'Established token, requires strict cross-source validation'
  },
  
  LARGE_CAP: {
    label: '大市值',
    labelEn: 'Large Cap',
    minMcap: 20_000_000,
    maxMcap: Infinity,
    minEvidence: 'STRICT',
    requireCrossValidation: true,
    requireMultiSource: true,
    description: '大盘，需要严格验证且多源确认',
    descriptionEn: 'Large cap, requires strict validation and multi-source confirmation'
  }
});

/**
 * Categorize a token by its market cap
 * Returns tier info with evidence requirements
 */
export function categorizeByMarketCap(marketCap, ageHours = null) {
  const mc = Number(marketCap) || 0;
  
  if (mc < 50_000) {
    return {
      tier: 'EMBRYONIC',
      tierDef: MARKET_CAP_TIERS.EMBRYONIC,
      marketCapBand: '$0-5万',
      marketCapBandEn: '$0-50k',
      minEvidence: 'MEDIUM'
    };
  } else if (mc < 200_000) {
    return {
      tier: 'EARLY',
      tierDef: MARKET_CAP_TIERS.EARLY,
      marketCapBand: '$5万-20万',
      marketCapBandEn: '$50k-200k',
      minEvidence: 'MEDIUM'
    };
  } else if (mc < 1_000_000) {
    return {
      tier: 'GROWTH',
      tierDef: MARKET_CAP_TIERS.GROWTH,
      marketCapBand: '$20万-100万',
      marketCapBandEn: '$200k-1M',
      minEvidence: 'HIGH',
      note: '成长期需要更高证据置信度',
      noteEn: 'Growth stage requires higher evidence confidence'
    };
  } else if (mc < 20_000_000) {
    return {
      tier: 'ESTABLISHED',
      tierDef: MARKET_CAP_TIERS.ESTABLISHED,
      marketCapBand: '$100万-2000万',
      marketCapBandEn: '$1M-20M',
      minEvidence: 'STRICT',
      requireCrossValidation: true,
      note: '存量期必须跨源验证',
      noteEn: 'Established stage requires cross-source validation'
    };
  } else {
    return {
      tier: 'LARGE_CAP',
      tierDef: MARKET_CAP_TIERS.LARGE_CAP,
      marketCapBand: '>$2000万',
      marketCapBandEn: '>$20M',
      minEvidence: 'STRICT',
      requireCrossValidation: true,
      requireMultiSource: true,
      note: '大盘必须多源确认',
      noteEn: 'Large cap requires multi-source confirmation'
    };
  }
}

/**
 * Market cap score modifier
 * Higher market cap requires stronger evidence to achieve same score
 * This prevents established/large caps from dominating early discovery rankings
 */
export function marketCapScoreModifier(tier) {
  const modifiers = {
    EMBRYONIC: 1.0,       // No penalty for very early stage
    EARLY: 1.0,           // No penalty for early stage
    GROWTH: 0.85,         // Slight reduction (needs stronger evidence to compensate)
    ESTABLISHED: 0.7,     // Significant reduction
    LARGE_CAP: 0.5        // Heavy reduction (much stronger evidence needed)
  };
  
  return modifiers[tier] || 0.7;
}

/**
 * Check if token meets minimum evidence requirements for its tier
 * Returns { qualified: boolean, reason?: string, recommendations?: string[] }
 */
export function checkTierEvidenceRequirements(token, tierInfo) {
  const checks = {
    qualified: true,
    warnings: [],
    recommendations: []
  };
  
  // Check cross-validation requirement
  if (tierInfo.requireCrossValidation && !token.crossValidated) {
    checks.qualified = false;
    checks.warnings.push(`${tierInfo.tierDef.label}需要跨源验证`);
    checks.recommendations.push('需要至少2个独立数据源确认');
  }
  
  // Check multi-source requirement for large caps
  if (tierInfo.requireMultiSource && (token.sourceCount || 0) < 2) {
    checks.qualified = false;
    checks.warnings.push(`${tierInfo.tierDef.label}需要多源确认`);
    checks.recommendations.push('需要至少2个独立来源');
  }
  
  // Evidence confidence check
  if (tierInfo.minEvidence === 'HIGH' && token.evidenceConfidence !== 'HIGH') {
    checks.warnings.push('证据置信度未达HIGH级别');
    checks.recommendations.push('需要完整样本或多次确认');
  }
  
  if (tierInfo.minEvidence === 'STRICT' && token.evidenceConfidence !== 'HIGH') {
    checks.qualified = false;
    checks.warnings.push('证据置信度不足STRICT要求');
    checks.recommendations.push('需要严格验证流程');
  }
  
  return checks;
}

/**
 * Legacy compatibility: check if token would have been rejected under old rules
 * This helps identify tokens that are now qualified but wouldn't have been before
 */
export function wouldHaveBeenRejectedUnderOldRules(marketCap) {
  return marketCap > 200_000;  // Old hard limit was $200k
}

export default {
  MARKET_CAP_TIERS,
  categorizeByMarketCap,
  marketCapScoreModifier,
  checkTierEvidenceRequirements,
  wouldHaveBeenRejectedUnderOldRules
};
