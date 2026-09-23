import { config } from './config.mjs';

const TIER_WEIGHTS = {
  official: 10,
  founder: 10,
  chain_lead: 7,
  meme_whale: 4,
  community: 3,
  kol_alpha: 2
};

export function detectChainCompetition(hits, watchlist, windowHours = 6, nowMs = Date.now()) {
  const windowMs = windowHours * 60 * 60 * 1000;
  const cutoffTime = nowMs - windowMs;
  
  // Build account lookup map with affinity info
  const accountMap = new Map(watchlist.map(acc => [
    acc.handle.toLowerCase(),
    { tier: acc.tier, chainAffinity: acc.chainAffinity || null, displayName: acc.displayName }
  ]));
  
  // Filter recent hits and enhance with account metadata
  const recentHits = (hits || [])
    .filter(hit => hit.discoveredAt >= cutoffTime)
    .map(hit => {
      const accountInfo = accountMap.get(hit.handle.toLowerCase()) || {};
      return {
        ...hit,
        tier: accountInfo.tier || hit.tier,
        chainAffinity: accountInfo.chainAffinity,
        accountDisplayName: accountInfo.displayName || hit.displayName
      };
    })
    .filter(hit => hit.chainAffinity); // Only consider hits from accounts with known chain affinity
  
  if (recentHits.length === 0) {
    return {
      active: false,
      intensity: 0,
      chains: [],
      signals: [],
      recentHitCount: 0
    };
  }
  
  // Group by chain affinity
  const byChain = new Map();
  for (const hit of recentHits) {
    const chains = hit.chainAffinity === 'multi' ? ['multi'] : [hit.chainAffinity];
    for (const chain of chains) {
      if (!byChain.has(chain)) {
        byChain.set(chain, { hits: [], weightedScore: 0, accounts: new Set() });
      }
      const chainData = byChain.get(chain);
      chainData.hits.push(hit);
      chainData.accounts.add(hit.handle);
      
      // Weight by tier
      const weight = TIER_WEIGHTS[hit.tier] || 1;
      chainData.weightedScore += weight;
    }
  }
  
  // Calculate intensity for each chain
  const chainIntensities = [];
  for (const [chain, data] of byChain.entries()) {
    const intensity = Math.min(100, data.weightedScore * 2); // Scale up, cap at 100
    chainIntensities.push({
      chain,
      intensity,
      hitCount: data.hits.length,
      uniqueAccounts: data.accounts.size,
      weightedScore: data.weightedScore,
      topTier: Math.max(...data.hits.map(h => TIER_WEIGHTS[h.tier] || 0)),
      hits: data.hits
    });
  }
  
  // Sort by intensity
  chainIntensities.sort((a, b) => b.intensity - a.intensity);
  
  // Overall intensity: max of any single chain, or elevated if multiple chains competing
  let overallIntensity = chainIntensities.length > 0 ? chainIntensities[0].intensity : 0;
  
  // Bonus if multiple chains are active (cross-chain competition)
  const activeChains = chainIntensities.filter(c => c.intensity >= 30);
  if (activeChains.length >= 2) {
    overallIntensity = Math.min(100, overallIntensity + 15);
  }
  
  // Generate signals
  const signals = [];
  const signalsCN = [];
  
  if (activeChains.length >= 2) {
    const chainList = activeChains.map(c => c.chain.toUpperCase()).join(' vs ');
    signals.push(`Cross-chain competition: ${chainList}`);
    signalsCN.push(`跨链竞争：${chainList}`);
  }
  
  for (const chainData of chainIntensities.slice(0, 3)) {
    if (chainData.intensity >= 40) {
      const highTierAccounts = chainData.hits.filter(h => ['official', 'founder', 'chain_lead'].includes(h.tier));
      if (highTierAccounts.length > 0) {
        signals.push(`${chainData.chain.toUpperCase()}: ${highTierAccounts.length} high-tier accounts active`);
        signalsCN.push(`${chainData.chain.toUpperCase()}：${highTierAccounts.length}个高层级账号活跃`);
      }
    }
  }
  
  if (overallIntensity >= 60) {
    signals.push('Elevated chain narrative competition');
    signalsCN.push('链叙事竞争升温');
  }
  
  return {
    active: overallIntensity >= 30,
    intensity: Math.round(overallIntensity),
    chains: chainIntensities.map(c => ({
      chain: c.chain,
      intensity: Math.round(c.intensity),
      hitCount: c.hitCount,
      uniqueAccounts: c.uniqueAccounts,
      hasHighTier: c.topTier >= 7
    })),
    signals,
    signalsCN,
    recentHitCount: recentHits.length,
    windowHours,
    detectedAt: nowMs
  };
}

export function computeChainAffinityBonus(tokenChain, competition) {
  if (!competition || !competition.active || competition.intensity < 40) {
    return { bonus: 0, signals: [], signalsCN: [] };
  }
  
  // Find if token's chain has elevated competition
  const tokenChainData = competition.chains.find(c => c.chain === tokenChain || c.chain === 'multi');
  
  if (!tokenChainData || tokenChainData.intensity < 40) {
    return { bonus: 0, signals: [], signalsCN: [] };
  }
  
  // Bonus based on competition intensity and whether high-tier accounts are involved
  let bonus = 5; // Base bonus
  
  if (tokenChainData.intensity >= 60) bonus += 5;
  if (tokenChainData.intensity >= 80) bonus += 5;
  if (tokenChainData.hasHighTier) bonus += 10;
  
  const signals = [
    `Chain narrative heating up (${tokenChain.toUpperCase()})`,
    'Official/ecosystem accounts active'
  ];
  
  const signalsCN = [
    `所属链竞争升温（${tokenChain.toUpperCase()}）`,
    '链官方或嫡系KOL同向'
  ];
  
  return {
    bonus: Math.min(20, bonus), // Cap at +20
    signals,
    signalsCN
  };
}
