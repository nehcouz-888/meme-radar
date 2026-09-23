import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEmbryonicScore } from '../src/scoring.mjs';

const baseConfig = {
  embryonicMinMarketCap: 10_000,
  embryonicMaxMarketCap: 200_000,
  embryonicOptimalMinMarketCap: 30_000,
  embryonicOptimalMaxMarketCap: 150_000,
  embryonicHotThreshold: 70,
  embryonicWatchThreshold: 50
};

test('embryonicScore: optimal early stage token should score hot', () => {
  const discovery = {
    market_cap: 80_000,
    liquidity: 15_000,
    creation_timestamp: Date.now() / 1000 - 2 * 3600, // 2 hours old
    smart_degen_count: 5,
    holder_count: 150,
    volume_5m: 8_000,
    website: 'https://example.com',
    twitter_username: 'example_token'
  };
  
  const result = computeEmbryonicScore({ discovery, info: {}, audit: {}, nowMs: Date.now() }, baseConfig);
  
  assert.ok(result.embryonicScore >= baseConfig.embryonicHotThreshold, 'Optimal token should score hot');
  assert.equal(result.embryonicTier, 'hot');
  assert.ok(result.embryonicSignals.length > 0, 'Should have signals');
  assert.ok(result.embryonicSignalsCN.length > 0, 'Should have Chinese signals');
});

test('embryonicScore: borderline token should score watch', () => {
  const discovery = {
    market_cap: 50_000,
    liquidity: 8_000,
    creation_timestamp: Date.now() / 1000 - 12 * 3600, // 12 hours old
    smart_degen_count: 2,
    holder_count: 60
  };
  
  const result = computeEmbryonicScore({ discovery, info: {}, audit: {}, nowMs: Date.now() }, baseConfig);
  
  assert.ok(result.embryonicScore >= baseConfig.embryonicWatchThreshold, 'Should score at least watch');
  assert.ok(result.embryonicScore < baseConfig.embryonicHotThreshold, 'Should not reach hot');
  assert.equal(result.embryonicTier, 'watch');
});

test('embryonicScore: poor quality token should score ignore', () => {
  const discovery = {
    market_cap: 250_000, // Too high
    liquidity: 1_000, // Too low
    creation_timestamp: Date.now() / 1000 - 3 * 86400, // 3 days old
    smart_degen_count: 0,
    holder_count: 20
  };
  
  const result = computeEmbryonicScore({ discovery, info: {}, audit: {}, nowMs: Date.now() }, baseConfig);
  
  assert.ok(result.embryonicScore < baseConfig.embryonicWatchThreshold, 'Should score below watch');
  assert.equal(result.embryonicTier, 'ignore');
  assert.ok(result.embryonicSignals.some(s => s.includes('too high') || s.includes('low')), 'Should have negative signals');
});

test('embryonicScore: very fresh token gets bonus', () => {
  const discovery = {
    market_cap: 100_000,
    liquidity: 20_000,
    creation_timestamp: Date.now() / 1000 - 1800, // 30 minutes old
    smart_degen_count: 3,
    holder_count: 100
  };
  
  const result = computeEmbryonicScore({ discovery, info: {}, audit: {}, nowMs: Date.now() }, baseConfig);
  
  assert.ok(result.embryonicScore >= baseConfig.embryonicHotThreshold, 'Fresh optimal token should score hot');
  assert.ok(result.embryonicSignals.some(s => s.includes('ideal') || s.includes('fresh')), 'Should mention freshness');
});

test('embryonicScore: smart money multiplier', () => {
  const baseDiscovery = {
    market_cap: 80_000,
    liquidity: 15_000,
    creation_timestamp: Date.now() / 1000 - 3600,
    holder_count: 100
  };
  
  const noSmartMoney = computeEmbryonicScore({ 
    discovery: { ...baseDiscovery, smart_degen_count: 0 }, 
    info: {}, audit: {}, nowMs: Date.now() 
  }, baseConfig);
  
  const withSmartMoney = computeEmbryonicScore({ 
    discovery: { ...baseDiscovery, smart_degen_count: 5 }, 
    info: {}, audit: {}, nowMs: Date.now() 
  }, baseConfig);
  
  assert.ok(withSmartMoney.embryonicScore > noSmartMoney.embryonicScore + 15, 'Smart money should significantly boost score');
  assert.ok(withSmartMoney.embryonicSignals.some(s => s.includes('smart money')), 'Should mention smart money');
});

test('embryonicScore: handles missing fields gracefully', () => {
  const discovery = {
    market_cap: 80_000
    // Missing most fields
  };
  
  const result = computeEmbryonicScore({ discovery, info: {}, audit: {}, nowMs: Date.now() }, baseConfig);
  
  assert.ok(typeof result.embryonicScore === 'number', 'Should return a score');
  assert.ok(result.embryonicScore >= 0 && result.embryonicScore <= 100, 'Score should be 0-100');
  assert.ok(['ignore', 'watch', 'hot'].includes(result.embryonicTier), 'Should return valid tier');
  assert.ok(result.embryonicSignals.some(s => s.includes('unknown')), 'Should note unknown fields');
});

test('embryonicScore: AURACAT fix - prefers live still-holding over historical aggregate', () => {
  const baseDiscovery = {
    market_cap: 80_000,
    liquidity: 15_000,
    creation_timestamp: Date.now() / 1000 - 3600,
    smart_degen_count: 36, // Historical aggregate
    renowned_count: 5,
    holder_count: 100
  };
  
  // Scenario 1: Aggregate shows 36 smart wallets, but all have exited (0 still holding)
  const auracatCase = computeEmbryonicScore({
    discovery: baseDiscovery,
    info: { wallet_tags_stat: { smart_wallets: 36, renowned_wallets: 5 } },
    audit: {
      holders: [
        // No smart_degen tags - all exited
        { address: '0x1111111111111111111111111111111111111111', tags: [] },
        { address: '0x2222222222222222222222222222222222222222', tags: [] },
        { address: '0x3333333333333333333333333333333333333333', tags: [] },
        { address: '0x4444444444444444444444444444444444444444', tags: [] }
      ]
    },
    nowMs: Date.now()
  }, { ...baseConfig, chain: 'robinhood' });
  
  assert.equal(auracatCase.embryonicFields.liveSmartHolding, 0, 'Should detect 0 live smart holders');
  assert.equal(auracatCase.embryonicFields.aggregateSmartWallets, 36, 'Should preserve aggregate');
  assert.equal(auracatCase.embryonicFields.smartMoneySource, 'live_holders', 'Should use live source');
  assert.equal(auracatCase.embryonicFields.smartWallets, 0, 'Should score from live count (0) not aggregate (36)');
  assert.ok(auracatCase.embryonicSignalsCN.some(s => s.includes('历史36个')), 'Should mention historical aggregate when 0 live');
  
  // The key fix: WITHOUT this fix, using aggregate (36) would give +20 bonus
  // WITH the fix, live (0) correctly gives 0 bonus
  assert.ok(auracatCase.embryonicScore < 75, 
    'AURACAT case should NOT get smart money bonus (aggregate 36 but live 0)');
  
  // Compare to fallback case that WOULD use the aggregate
  const oldBehavior = computeEmbryonicScore({
    discovery: baseDiscovery,
    info: {},
    audit: { holders: [] }, // No holders data forces aggregate fallback
    nowMs: Date.now()
  }, baseConfig);
  
  assert.equal(oldBehavior.embryonicFields.smartMoneySource, 'aggregate_fallback', 'Fallback uses aggregate');
  assert.equal(oldBehavior.embryonicFields.smartWallets, 36, 'Fallback gets inflated aggregate');
  assert.ok(oldBehavior.embryonicScore >= auracatCase.embryonicScore + 15,
    'Old aggregate behavior would falsely score 20+ points higher');
  
  // Scenario 2: 3 smart wallets still holding
  const liveHoldingCase = computeEmbryonicScore({
    discovery: baseDiscovery,
    info: { wallet_tags_stat: { smart_wallets: 36, renowned_wallets: 5 } },
    audit: {
      holders: [
        { address: '0x1111111111111111111111111111111111111111', tags: ['smart_degen'] },
        { address: '0x2222222222222222222222222222222222222222', tags: ['smart_degen'] },
        { address: '0x3333333333333333333333333333333333333333', tags: ['smart_degen'] },
        { address: '0x4444444444444444444444444444444444444444', tags: [] }
      ]
    },
    nowMs: Date.now()
  }, { ...baseConfig, chain: 'robinhood' });
  
  assert.equal(liveHoldingCase.embryonicFields.liveSmartHolding, 3, 'Should detect 3 live smart holders');
  assert.equal(liveHoldingCase.embryonicFields.smartWallets, 3, 'Should use live count');
  assert.ok(liveHoldingCase.embryonicSignalsCN.some(s => s.includes('仍持仓')), 'Should say "still holding"');
  assert.ok(liveHoldingCase.embryonicScore >= auracatCase.embryonicScore + 18, 
    'Live holding should get +20 smart money bonus');
  
  // Scenario 3: No holders data - fall back to aggregate
  const fallbackCase = computeEmbryonicScore({
    discovery: baseDiscovery,
    info: {},
    audit: { holders: [] },
    nowMs: Date.now()
  }, baseConfig);
  
  assert.equal(fallbackCase.embryonicFields.smartMoneySource, 'aggregate_fallback', 'Should fall back when no holders');
  assert.equal(fallbackCase.embryonicFields.smartWallets, 36, 'Should use aggregate when no live data');
});
