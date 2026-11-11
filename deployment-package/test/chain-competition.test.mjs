import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChainCompetition, computeChainAffinityBonus } from '../src/chain-competition.mjs';

test('detectChainCompetition: no recent hits', () => {
  const hits = [];
  const watchlist = [
    { handle: 'solana', tier: 'chain_lead', chainAffinity: 'sol', displayName: 'Solana' }
  ];
  
  const result = detectChainCompetition(hits, watchlist, 6, Date.now());
  
  assert.strictEqual(result.active, false);
  assert.strictEqual(result.intensity, 0);
  assert.strictEqual(result.chains.length, 0);
});

test('detectChainCompetition: single chain with high-tier activity', () => {
  const nowMs = Date.now();
  const hits = [
    {
      tweetId: '1',
      handle: 'solana',
      displayName: 'Solana',
      tier: 'chain_lead',
      chainAffinity: 'sol',
      discoveredAt: nowMs - 60_000 // 1 minute ago
    },
    {
      tweetId: '2',
      handle: 'aeyakovenko',
      displayName: 'Anatoly',
      tier: 'chain_lead',
      chainAffinity: 'sol',
      discoveredAt: nowMs - 120_000 // 2 minutes ago
    }
  ];
  
  const watchlist = [
    { handle: 'solana', tier: 'chain_lead', chainAffinity: 'sol', displayName: 'Solana' },
    { handle: 'aeyakovenko', tier: 'chain_lead', chainAffinity: 'sol', displayName: 'Anatoly' }
  ];
  
  const result = detectChainCompetition(hits, watchlist, 6, nowMs);
  
  assert.strictEqual(result.active, true);
  assert.ok(result.intensity > 30);
  assert.strictEqual(result.chains.length, 1);
  assert.strictEqual(result.chains[0].chain, 'sol');
  assert.ok(result.chains[0].hasHighTier);
});

test('detectChainCompetition: cross-chain competition', () => {
  const nowMs = Date.now();
  const hits = [
    {
      tweetId: '1',
      handle: 'solana',
      displayName: 'Solana',
      tier: 'chain_lead',
      chainAffinity: 'sol',
      discoveredAt: nowMs - 60_000
    },
    {
      tweetId: '2',
      handle: 'base',
      displayName: 'Base',
      tier: 'chain_lead',
      chainAffinity: 'base',
      discoveredAt: nowMs - 90_000
    },
    {
      tweetId: '3',
      handle: 'bnbchain',
      displayName: 'BNB Chain',
      tier: 'chain_lead',
      chainAffinity: 'bsc',
      discoveredAt: nowMs - 120_000
    }
  ];
  
  const watchlist = [
    { handle: 'solana', tier: 'chain_lead', chainAffinity: 'sol', displayName: 'Solana' },
    { handle: 'base', tier: 'chain_lead', chainAffinity: 'base', displayName: 'Base' },
    { handle: 'bnbchain', tier: 'chain_lead', chainAffinity: 'bsc', displayName: 'BNB Chain' }
  ];
  
  const result = detectChainCompetition(hits, watchlist, 6, nowMs);
  
  assert.strictEqual(result.active, true);
  assert.ok(result.intensity >= 30);
  assert.ok(result.chains.length >= 3);
  assert.ok(result.signals.some(s => s.includes('Cross-chain')));
});

test('detectChainCompetition: old hits excluded', () => {
  const nowMs = Date.now();
  const windowHours = 1;
  const hits = [
    {
      tweetId: '1',
      handle: 'solana',
      displayName: 'Solana',
      tier: 'chain_lead',
      chainAffinity: 'sol',
      discoveredAt: nowMs - 3 * 60 * 60 * 1000 // 3 hours ago - outside window
    }
  ];
  
  const watchlist = [
    { handle: 'solana', tier: 'chain_lead', chainAffinity: 'sol', displayName: 'Solana' }
  ];
  
  const result = detectChainCompetition(hits, watchlist, windowHours, nowMs);
  
  assert.strictEqual(result.active, false);
  assert.strictEqual(result.recentHitCount, 0);
});

test('detectChainCompetition: multi-chain accounts contribute to all chains', () => {
  const nowMs = Date.now();
  const hits = [
    {
      tweetId: '1',
      handle: 'binance',
      displayName: 'Binance',
      tier: 'official',
      chainAffinity: 'multi',
      discoveredAt: nowMs - 60_000
    }
  ];
  
  const watchlist = [
    { handle: 'binance', tier: 'official', chainAffinity: 'multi', displayName: 'Binance' }
  ];
  
  const result = detectChainCompetition(hits, watchlist, 6, nowMs);
  
  assert.strictEqual(result.recentHitCount, 1);
  const multiChain = result.chains.find(c => c.chain === 'multi');
  assert.ok(multiChain, 'Should have multi-chain entry');
});

test('computeChainAffinityBonus: no competition', () => {
  const result = computeChainAffinityBonus('sol', null);
  assert.strictEqual(result.bonus, 0);
});

test('computeChainAffinityBonus: competition but below threshold', () => {
  const competition = {
    active: true,
    intensity: 30,
    chains: [{ chain: 'sol', intensity: 30, hasHighTier: false }]
  };
  
  const result = computeChainAffinityBonus('sol', competition);
  assert.strictEqual(result.bonus, 0);
});

test('computeChainAffinityBonus: token chain matches elevated competition', () => {
  const competition = {
    active: true,
    intensity: 70,
    chains: [{ chain: 'sol', intensity: 70, hasHighTier: true }]
  };
  
  const result = computeChainAffinityBonus('sol', competition);
  assert.ok(result.bonus > 0);
  assert.ok(result.bonus <= 20); // Capped at 20
  assert.ok(result.signalsCN.some(s => s.includes('竞争升温')));
});

test('computeChainAffinityBonus: token chain does not match', () => {
  const competition = {
    active: true,
    intensity: 70,
    chains: [{ chain: 'base', intensity: 70, hasHighTier: true }]
  };
  
  const result = computeChainAffinityBonus('sol', competition);
  assert.strictEqual(result.bonus, 0);
});

test('computeChainAffinityBonus: high intensity grants larger bonus', () => {
  const lowCompetition = {
    active: true,
    intensity: 50,
    chains: [{ chain: 'sol', intensity: 50, hasHighTier: false }]
  };
  
  const highCompetition = {
    active: true,
    intensity: 85,
    chains: [{ chain: 'sol', intensity: 85, hasHighTier: true }]
  };
  
  const lowResult = computeChainAffinityBonus('sol', lowCompetition);
  const highResult = computeChainAffinityBonus('sol', highCompetition);
  
  assert.ok(highResult.bonus > lowResult.bonus);
});
