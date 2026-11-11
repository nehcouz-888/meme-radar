#!/usr/bin/env node
// Holdings verification priority test - tests the HI*/LOWW fixture scenario
// Verifies: prioritize "would-enter-watch" candidates over "high-hist-but-still-ignore" candidates

import { strict as assert } from 'node:assert';

console.log('=== Holdings Verification Priority Test ===\n');

// Simulate the sorting logic from fomo-free-scan.mjs
const WATCH_MIN = 60;

function computePriority(candidates, historicalHolders) {
  const withPotential = candidates.map(c => {
    const histCount = historicalHolders.get(c.address) || 0;
    const maxSmartPts = Math.min(18, histCount * 6);
    const potentialScore = c.score + maxSmartPts;
    // No-Jupiter cap: if no jup data, final score capped at 60
    const capped = c.hasJupiter ? potentialScore : Math.min(60, potentialScore);
    return { ...c, histCount, maxSmartPts, potentialScore: capped, wouldWatch: capped >= WATCH_MIN };
  });
  
  return withPotential.sort((a, b) => {
    if (a.wouldWatch !== b.wouldWatch) return b.wouldWatch - a.wouldWatch;
    if (a.potentialScore !== b.potentialScore) return b.potentialScore - a.potentialScore;
    return b.histCount - a.histCount;
  });
}

// Test 1: HI*/LOWW scenario - LOWW should be prioritized despite lower hist count
{
  console.log('Test 1: HI*/LOWW scenario - prioritize would-watch over high-hist-ignore');
  
  const candidates = [
    { address: 'HI1A', score: 27, hasJupiter: true },   // hist 5, +18 = 45 < 60 (ignore)
    { address: 'HI2A', score: 27, hasJupiter: true },   // hist 5, +18 = 45 < 60 (ignore)
    { address: 'HI3A', score: 27, hasJupiter: true },   // hist 5, +18 = 45 < 60 (ignore)
    { address: 'LOWW', score: 51, hasJupiter: false },  // hist 3, +18 = 69, capped 60 (watch!)
  ];
  
  const historicalHolders = new Map([
    ['HI1A', 5],
    ['HI2A', 5],
    ['HI3A', 5],
    ['LOWW', 3],  // hist 3, not 1, to reach +18 and enter watch after cap
  ]);
  
  const sorted = computePriority(candidates, historicalHolders);
  
  // LOWW should be first because wouldWatch=true (capped 60)
  // HI* should follow because wouldWatch=false (45 < 60)
  assert.equal(sorted[0].address, 'LOWW', 'LOWW should be first (would enter watch)');
  assert.equal(sorted[0].wouldWatch, true, 'LOWW should have wouldWatch=true');
  assert.equal(sorted[0].potentialScore, 60, 'LOWW capped at 60 (no Jupiter)');
  
  assert.equal(sorted[1].wouldWatch, false, 'HI1A should have wouldWatch=false');
  assert.equal(sorted[1].potentialScore, 45, 'HI1A potential 45 < 60');
  
  console.log('Sorted order:', sorted.map(c => c.address).join(' > '));
  console.log('✓ PASS: LOWW (hist 3, would watch) prioritized over HI* (hist 5, would ignore)\n');
}

// Test 2: Multiple would-watch candidates
{
  console.log('Test 2: Multiple would-watch candidates - sort by potential score');
  
  const candidates = [
    { address: 'LOW1', score: 48, hasJupiter: false },   // hist 2, +12 = 60, capped 60
    { address: 'LOW2', score: 51, hasJupiter: false },   // hist 1, +6 = 57, capped 60
    { address: 'HIGH', score: 50, hasJupiter: true },    // hist 3, +18 = 68 (no cap)
    { address: 'IGNORE', score: 30, hasJupiter: true },  // hist 10, +18 = 48 < 60
  ];
  
  const historicalHolders = new Map([
    ['LOW1', 2],
    ['LOW2', 1],
    ['HIGH', 3],
    ['IGNORE', 10],
  ]);
  
  const sorted = computePriority(candidates, historicalHolders);
  
  // All would-watch candidates first, sorted by potential score DESC
  assert.equal(sorted[0].address, 'HIGH', 'HIGH first (potential 68)');
  assert.equal(sorted[0].potentialScore, 68, 'HIGH potential 68');
  
  // LOW1 and LOW2 both capped at 60, tie-break by hist count
  assert.ok(['LOW1', 'LOW2'].includes(sorted[1].address), 'Second should be LOW1 or LOW2');
  assert.ok(['LOW1', 'LOW2'].includes(sorted[2].address), 'Third should be LOW1 or LOW2');
  
  // IGNORE last
  assert.equal(sorted[3].address, 'IGNORE', 'IGNORE last (would not watch)');
  assert.equal(sorted[3].wouldWatch, false, 'IGNORE wouldWatch=false');
  
  console.log('Sorted order:', sorted.map(c => c.address).join(' > '));
  console.log('✓ PASS: Would-watch candidates prioritized, sorted by potential score\n');
}

// Test 3: No-Jupiter cap affects priority
{
  console.log('Test 3: No-Jupiter cap affects wouldWatch determination');
  
  const candidates = [
    { address: 'NOJUP', score: 55, hasJupiter: false },  // hist 2, +12 = 67, capped 60 → watch
    { address: 'HASJUP', score: 50, hasJupiter: true },  // hist 2, +12 = 62, no cap → watch
  ];
  
  const historicalHolders = new Map([
    ['NOJUP', 2],
    ['HASJUP', 2],
  ]);
  
  const sorted = computePriority(candidates, historicalHolders);
  
  // Both would watch, HASJUP has higher uncapped potential
  assert.equal(sorted[0].address, 'HASJUP', 'HASJUP first (potential 62 > 60)');
  assert.equal(sorted[0].potentialScore, 62, 'HASJUP uncapped 62');
  
  assert.equal(sorted[1].address, 'NOJUP', 'NOJUP second (capped 60)');
  assert.equal(sorted[1].potentialScore, 60, 'NOJUP capped 60');
  
  console.log('✓ PASS: No-Jupiter cap correctly affects priority\n');
}

// Test 4: Edge case - exact WATCH_MIN threshold
{
  console.log('Test 4: Candidates exactly at WATCH_MIN threshold');
  
  const candidates = [
    { address: 'EXACT', score: 42, hasJupiter: true },   // hist 3, +18 = 60 (exact)
    { address: 'BELOW', score: 41, hasJupiter: true },   // hist 3, +18 = 59 < 60
    { address: 'ABOVE', score: 43, hasJupiter: true },   // hist 3, +18 = 61 > 60
  ];
  
  const historicalHolders = new Map([
    ['EXACT', 3],
    ['BELOW', 3],
    ['ABOVE', 3],
  ]);
  
  const sorted = computePriority(candidates, historicalHolders);
  
  // ABOVE and EXACT should be wouldWatch=true, BELOW should be false
  assert.equal(sorted[0].address, 'ABOVE', 'ABOVE first (61 > 60)');
  assert.equal(sorted[1].address, 'EXACT', 'EXACT second (60 == threshold)');
  assert.equal(sorted[2].address, 'BELOW', 'BELOW last (59 < 60)');
  
  assert.equal(sorted[0].wouldWatch, true, 'ABOVE wouldWatch');
  assert.equal(sorted[1].wouldWatch, true, 'EXACT wouldWatch (>= threshold)');
  assert.equal(sorted[2].wouldWatch, false, 'BELOW wouldNotWatch');
  
  console.log('✓ PASS: Threshold boundary handled correctly\n');
}

console.log('=== All Holdings Priority Tests PASSED ===');
console.log('Coverage: HI*/LOWW scenario, multi-watch sorting, no-Jupiter cap, threshold edge cases');
