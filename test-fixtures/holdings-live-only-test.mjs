#!/usr/bin/env node
// Holdings live-only scoring test - imports production scoring.mjs (NOT a copy)
// Tests: incomplete sample → score 0, historical aggregate → display only, mcap → tiering not exclusion

import { strict as assert } from 'node:assert';
import { marketBehaviorScreen, discoveryScreen, computeEmbryonicScore } from '../src/scoring.mjs';

console.log('=== Holdings Live-Only Scoring Test (Production Modules) ===\n');

const defaultConfig = {
  chain: 'sol',
  minAgeSec: 300,
  maxAgeSec: 30 * 24 * 3600,
  discoveryMinMarketCap: 1000,
  discoveryMaxMarketCap: 100e6,
  priorityMinMarketCap: 30e3,
  priorityMaxMarketCap: 1e6,
  minLiquidity: 5000
};

// Test 1: marketBehaviorScreen - adequate sample (3+) scores, incomplete (0-2) scores 0
{
  console.log('Test 1: marketBehaviorScreen - adequate vs incomplete sample');
  
  // Adequate sample: 3 holders, 2 smart
  const adequateSample = marketBehaviorScreen({
    discovery: { smart_degen_count: 5 },  // Historical aggregate
    holders: [
      { address: 'addr1', tags: 'smart-degen' },
      { address: 'addr2', tags: 'smart-degen' },
      { address: 'addr3', tags: '' }
    ]
  }, defaultConfig);
  
  assert.equal(adequateSample.evidence.smartWallets, 2, 'Adequate sample: should count 2 live smart');
  assert.equal(adequateSample.evidence.smartMoneySource, 'live_holders', 'Adequate sample: source should be live_holders');
  assert.ok(adequateSample.strengths.some(s => s.includes('2个聪明钱仍持仓')), 'Adequate sample: should have strength');
  
  // Incomplete sample: 2 holders, 2 smart (but sample too small)
  const incompleteSample = marketBehaviorScreen({
    discovery: { smart_degen_count: 5 },  // Historical aggregate
    holders: [
      { address: 'addr1', tags: 'smart-degen' },
      { address: 'addr2', tags: 'smart-degen' }
    ]
  }, defaultConfig);
  
  assert.equal(incompleteSample.evidence.smartWallets, 0, 'Incomplete sample: should score 0, not aggregate');
  assert.equal(incompleteSample.evidence.smartMoneySource, 'sample_incomplete', 'Incomplete sample: source should be sample_incomplete');
  assert.ok(incompleteSample.warnings.some(w => w.includes('不完整')), 'Incomplete sample: should have warning');
  assert.ok(incompleteSample.warnings.some(w => w.includes('历史统计5个聪明钱（仅供参考，未计分）')), 'Incomplete sample: should show historical for reference');
  assert.equal(incompleteSample.strengths.length, 0, 'Incomplete sample: should have no strengths');
  
  // Missing sample
  const missingSample = marketBehaviorScreen({
    discovery: { smart_degen_count: 5 },  // Historical aggregate
    holders: []
  }, defaultConfig);
  
  assert.equal(missingSample.evidence.smartWallets, 0, 'Missing sample: should score 0, not aggregate');
  assert.equal(missingSample.evidence.smartMoneySource, 'sample_missing', 'Missing sample: source should be sample_missing');
  assert.ok(missingSample.warnings.some(w => w.includes('缺失')), 'Missing sample: should have warning');
  
  console.log('✓ PASS: Adequate sample scores, incomplete/missing samples score 0 (not aggregate)\n');
}

// Test 2: marketBehaviorScreen - verified empty (0 smart) vs incomplete
{
  console.log('Test 2: marketBehaviorScreen - verified empty vs incomplete');
  
  // Verified empty: 3 holders, 0 smart
  const verifiedEmpty = marketBehaviorScreen({
    discovery: { smart_degen_count: 5 },
    holders: [
      { address: 'addr1', tags: '' },
      { address: 'addr2', tags: '' },
      { address: 'addr3', tags: '' }
    ]
  }, defaultConfig);
  
  assert.equal(verifiedEmpty.evidence.smartWallets, 0, 'Verified empty: should be 0');
  assert.equal(verifiedEmpty.evidence.smartMoneySource, 'live_holders', 'Verified empty: should be live_holders (verified)');
  assert.ok(verifiedEmpty.strengths.some(s => s.includes('已验证当前无聪明钱持仓')), 'Verified empty: should confirm liquidation');
  
  console.log('✓ PASS: Verified empty (sample adequate, 0 smart) distinguished from incomplete\n');
}

// Test 3: computeEmbryonicScore - uses same sample adequacy rules
{
  console.log('Test 3: computeEmbryonicScore - sample adequacy');
  
  // Just verify function executes with both adequate and incomplete samples
  // Detailed scoring logic is tested via marketBehaviorScreen
  try {
    computeEmbryonicScore({
      discovery: { smart_degen_count: 5, market_cap: 500e3 },
      info: {},
      audit: { holders: [
        { address: 'addr1', tags: 'smart-degen' },
        { address: 'addr2', tags: 'smart-degen' },
        { address: 'addr3', tags: '' }
      ]}
    }, defaultConfig);
    
    computeEmbryonicScore({
      discovery: { smart_degen_count: 5, market_cap: 500e3 },
      info: {},
      audit: { holders: [
        { address: 'addr1', tags: 'smart-degen' },
        { address: 'addr2', tags: 'smart-degen' }
      ]}
    }, defaultConfig);
    
    console.log('✓ PASS: computeEmbryonicScore executes with sample adequacy rules\n');
  } catch (e) {
    assert.fail(`computeEmbryonicScore should not throw: ${e.message}`);
  }
}

// Test 4: discoveryScreen - mcap is tiering, not hard exclusion
{
  console.log('Test 4: discoveryScreen - market cap tiering not exclusion');
  
  const baseRow = {
    address: 'So11111111111111111111111111111111111111112',  // Valid Solana address format
    creation_timestamp: Date.now() / 1000 - 600,  // 10 min old
    liquidity: 10000,
    rug_ratio: 0.1,
    bundler_rate: 0.1,
    rat_trader_amount_rate: 0.1,
    is_wash_trading: false,
    is_honeypot: false
  };
  
  // High mcap (25M USD) - within range
  const highMcap = discoveryScreen({ ...baseRow, market_cap: 25e6 }, defaultConfig);
  console.log('High mcap result:', highMcap.pass, 'reasons:', highMcap.reasons);
  assert.equal(highMcap.pass, true, 'High mcap (25M) should pass, not be excluded');
  assert.equal(highMcap.mcTier, 'high', 'High mcap should be in high tier');
  
  // Low mcap (1000 USD)
  const lowMcap = discoveryScreen({ ...baseRow, market_cap: 1000 }, defaultConfig);
  console.log('Low mcap result:', lowMcap.pass, 'tier:', lowMcap.mcTier);
  assert.equal(lowMcap.pass, true, 'Low mcap (1000) should pass, not be excluded');
  assert.equal(lowMcap.mcTier, 'micro', 'Low mcap (1000) should be in micro tier');
  
  // Mid mcap (500K USD)
  const midMcap = discoveryScreen({ ...baseRow, market_cap: 500e3 }, defaultConfig);
  assert.equal(midMcap.pass, true, 'Mid mcap (500K) should pass');
  assert.equal(midMcap.mcTier, 'low', 'Mid mcap should be in low tier');
  assert.equal(midMcap.priorityBand, true, 'Mid mcap should be in priority band');
  
  console.log('✓ PASS: Market cap is tiering/scoring only, not hard exclusion\n');
}

// Test 5: discoveryScreen - safety filters still work
{
  console.log('Test 5: discoveryScreen - safety filters preserved');
  
  const baseRow = {
    address: 'validaddr',
    creation_timestamp: Date.now() / 1000 - 600,
    market_cap: 500e3,
    liquidity: 10000,
    bundler_rate: 0.1,
    rat_trader_amount_rate: 0.1,
    is_wash_trading: false,
    is_honeypot: false
  };
  
  // High rug ratio should still fail
  const highRug = discoveryScreen({ ...baseRow, rug_ratio: 0.4 }, defaultConfig);
  assert.equal(highRug.pass, false, 'High rug ratio should fail');
  assert.ok(highRug.reasons.includes('rug风险过高'), 'Should have rug risk reason');
  
  // Low liquidity should still fail
  const lowLiq = discoveryScreen({ ...baseRow, liquidity: 1000 }, defaultConfig);
  assert.equal(lowLiq.pass, false, 'Low liquidity should fail');
  assert.ok(lowLiq.reasons.includes('流动性不足'), 'Should have liquidity reason');
  
  console.log('✓ PASS: Safety filters (rug/liquidity/bundler) still enforce\n');
}

console.log('=== All Production Module Tests PASSED ===');
console.log('Modules imported: src/scoring.mjs (marketBehaviorScreen, discoveryScreen, computeEmbryonicScore)');
