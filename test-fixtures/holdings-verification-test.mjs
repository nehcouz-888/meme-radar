#!/usr/bin/env node
// Holdings verification test fixture (offline, no paid API calls)
// Tests: source conflicts, incomplete samples, historical union, missed verification, sample absence != liquidation

import { strict as assert } from 'node:assert';

// Mock SMART_HANDLES set
const SMART_HANDLES = new Set(['alice', 'bob', 'charlie', 'david', 'eve']);

// Simulated score function (simplified from scanner)
function score(candidate, smartMoneySnapshot) {
  const k = candidate.chain === 'sol' ? candidate.address : candidate.address.toLowerCase();
  const historicalHolders = smartMoneySnapshot.holding.get(k);
  const liveHolders = candidate.fomoHoldersLive;
  
  const liveSmart = liveHolders != null ? liveHolders.filter(h => SMART_HANDLES.has(h.toLowerCase())) : null;
  const stillHolding = liveSmart != null ? liveSmart.length : 0;
  const historicalCount = historicalHolders ? historicalHolders.size : 0;
  
  const smartPts = liveSmart != null ? Math.min(18, stillHolding * 6) : 0;
  
  return {
    ...candidate,
    smart: {
      stillHolding,
      historicalCount,
      handles: liveSmart != null ? liveSmart.slice(0, 8) : [...(historicalHolders || [])].slice(0, 8),
      src: liveHolders != null ? 'fomo:token-holders(live)' : 'fomo:leaderboard-topTokens(historical,no-score)',
      liveVerified: liveHolders != null
    },
    smartPts,
    score: 10 + smartPts  // simplified
  };
}

// Test cases
console.log('=== Holdings Verification Test ===\n');

// Test 1: Historical holders present, live verification shows none (liquidated)
{
  const smartSnapshot = { holding: new Map([['token1', new Set(['alice', 'bob'])]]) };
  const candidate = { chain: 'sol', address: 'token1', fomoHoldersLive: ['frank', 'grace'] };  // Different users
  const result = score(candidate, smartSnapshot);
  
  console.log('Test 1: Historical present, live shows none (liquidated)');
  assert.equal(result.smart.stillHolding, 0, 'Should have 0 live smart holders');
  assert.equal(result.smart.historicalCount, 2, 'Should show 2 historical holders for display');
  assert.equal(result.smartPts, 0, 'Should score 0 points (live verified, none holding)');
  assert.equal(result.smart.liveVerified, true, 'Should be marked as live verified');
  console.log('✓ PASS: Live verification overrides historical, liquidated → 0 points\n');
}

// Test 2: Historical holders present, live verification returns null (incomplete sample)
{
  const smartSnapshot = { holding: new Map([['token2', new Set(['alice', 'bob'])]]) };
  const candidate = { chain: 'sol', address: 'token2', fomoHoldersLive: null };  // API incomplete
  const result = score(candidate, smartSnapshot);
  
  console.log('Test 2: Historical present, live sample incomplete (null)');
  assert.equal(result.smart.stillHolding, 0, 'Should have 0 live smart holders (unverified)');
  assert.equal(result.smart.historicalCount, 2, 'Should show 2 historical holders');
  assert.equal(result.smartPts, 0, 'Should score 0 points (unverified, not assumed liquidated)');
  assert.equal(result.smart.liveVerified, false, 'Should be marked as NOT live verified');
  assert.deepEqual(result.smart.handles, ['alice', 'bob'], 'Should show historical handles for reference');
  console.log('✓ PASS: Incomplete sample → 0 points, but shows historical for reference\n');
}

// Test 3: Historical holders union with live must NOT be marked as live
{
  const smartSnapshot = { holding: new Map([['token3', new Set(['alice', 'bob'])]]) };
  const candidate = { chain: 'sol', address: 'token3', fomoHoldersLive: ['charlie'] };
  const result = score(candidate, smartSnapshot);
  
  console.log('Test 3: Historical union with live must NOT inflate count');
  assert.equal(result.smart.stillHolding, 1, 'Should count only live-verified holder (charlie)');
  assert.equal(result.smart.historicalCount, 2, 'Historical count separate for display');
  assert.equal(result.smartPts, 6, 'Should score 6 points (1 * 6), not union');
  assert.deepEqual(result.smart.handles, ['charlie'], 'Should show only live handles');
  assert.equal(result.smart.src, 'fomo:token-holders(live)', 'Should be marked as live source');
  console.log('✓ PASS: No historical union, live only\n');
}

// Test 4: Address not in sample should NOT assume liquidation
{
  const smartSnapshot = { holding: new Map([['token4', new Set(['alice'])]]) };
  const candidate = { chain: 'sol', address: 'token4', fomoHoldersLive: [] };  // Empty but present
  const result = score(candidate, smartSnapshot);
  
  console.log('Test 4: Address found but no smart holders in sample');
  assert.equal(result.smart.stillHolding, 0, 'Should have 0 live smart holders');
  assert.equal(result.smartPts, 0, 'Should score 0 points');
  assert.equal(result.smart.liveVerified, true, 'Should be marked as live verified (sample was returned)');
  console.log('✓ PASS: Empty sample (found but no smart holders) → 0 points, live verified\n');
}

// Test 5: Historical only (not in verification batch)
{
  const smartSnapshot = { holding: new Map([['token5', new Set(['alice', 'bob', 'charlie'])]]) };
  const candidate = { chain: 'sol', address: 'token5' };  // No fomoHoldersLive field
  const result = score(candidate, smartSnapshot);
  
  console.log('Test 5: Historical snapshot only (no live verification performed)');
  assert.equal(result.smart.stillHolding, 0, 'Should have 0 counted holders (unverified)');
  assert.equal(result.smart.historicalCount, 3, 'Should show 3 historical holders');
  assert.equal(result.smartPts, 0, 'Should score 0 points (historical only, no score)');
  assert.equal(result.smart.liveVerified, false, 'Should be marked as NOT live verified');
  assert.equal(result.smart.src, 'fomo:leaderboard-topTokens(historical,no-score)', 'Should indicate historical no-score source');
  console.log('✓ PASS: Historical snapshot → display only, 0 points\n');
}

// Test 6: Multiple smart holders still holding
{
  const smartSnapshot = { holding: new Map([['token6', new Set(['alice', 'bob'])]]) };
  const candidate = { chain: 'sol', address: 'token6', fomoHoldersLive: ['alice', 'bob', 'frank'] };
  const result = score(candidate, smartSnapshot);
  
  console.log('Test 6: Multiple smart holders confirmed live');
  assert.equal(result.smart.stillHolding, 2, 'Should have 2 live smart holders');
  assert.equal(result.smartPts, 12, 'Should score 12 points (2 * 6)');
  assert.deepEqual(result.smart.handles, ['alice', 'bob'], 'Should show live smart handles');
  assert.equal(result.smart.liveVerified, true, 'Should be marked as live verified');
  console.log('✓ PASS: Multiple holders confirmed → correct points\n');
}

// Test 7: Cap at 18 points (3+ holders)
{
  const smartSnapshot = { holding: new Map([['token7', new Set(['alice', 'bob', 'charlie', 'david'])]]) };
  const candidate = { chain: 'sol', address: 'token7', fomoHoldersLive: ['alice', 'bob', 'charlie', 'david'] };
  const result = score(candidate, smartSnapshot);
  
  console.log('Test 7: Smart holders capped at 18 points');
  assert.equal(result.smart.stillHolding, 4, 'Should have 4 live smart holders');
  assert.equal(result.smartPts, 18, 'Should score 18 points (capped, not 24)');
  console.log('✓ PASS: Points capped at 18\n');
}

console.log('=== All Holdings Verification Tests PASSED ===');
