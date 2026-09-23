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
