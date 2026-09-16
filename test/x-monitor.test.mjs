import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWatchlist, extractContractAddresses, extractCashtags, inferChain } from '../src/x-monitor.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('loadWatchlist: loads and filters enabled accounts with follower requirements', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'x-watchlist-test-'));
  const watchlistPath = path.join(tempDir, 'test-watchlist.json');
  
  const testWatchlist = {
    version: 2,
    minFollowers: 10000,
    accounts: [
      { handle: 'binance', displayName: 'Binance', category: 'official', tier: 'official', followerCount: null, enabled: true, notes: 'Test' },
      { handle: 'low_kol', displayName: 'Low Follower', category: 'kol_alpha', tier: 'kol_alpha', followerCount: 5000, enabled: true, notes: 'Below threshold' },
      { handle: 'high_kol', displayName: 'High Follower', category: 'kol_alpha', tier: 'kol_alpha', followerCount: 50000, enabled: true, notes: 'Above threshold' },
      { handle: 'disabled_acc', displayName: 'Disabled', category: 'kol_alpha', tier: 'kol_alpha', followerCount: 100000, enabled: false, notes: '' },
      { handle: 'cz_binance', displayName: 'CZ', category: 'founder', tier: 'founder', followerCount: null, enabled: true, notes: 'Test' },
      { handle: 'solana', displayName: 'Solana', category: 'chain_lead', tier: 'chain_lead', followerCount: null, enabled: true, notes: 'Test' }
    ]
  };
  
  await fs.writeFile(watchlistPath, JSON.stringify(testWatchlist));
  
  const accounts = await loadWatchlist(watchlistPath, 10000);
  
  assert.ok(accounts.length >= 4, 'Should load accounts meeting criteria');
  assert.ok(accounts.some(a => a.handle === 'binance'), 'Should include official (exempt)');
  assert.ok(accounts.some(a => a.handle === 'cz_binance'), 'Should include founder (exempt)');
  assert.ok(accounts.some(a => a.handle === 'solana'), 'Should include chain_lead (exempt)');
  assert.ok(accounts.some(a => a.handle === 'high_kol'), 'Should include KOL with sufficient followers');
  assert.ok(!accounts.some(a => a.handle === 'low_kol'), 'Should exclude KOL below threshold');
  assert.ok(!accounts.some(a => a.handle === 'disabled_acc'), 'Should not include disabled');
  
  // Check follower count is preserved
  const highFollowerAccount = accounts.find(a => a.handle === 'high_kol');
  assert.equal(highFollowerAccount.followerCount, 50000, 'Should preserve follower count');
  
  await fs.rm(tempDir, { recursive: true });
});

test('loadWatchlist: returns empty array for missing file', async () => {
  const accounts = await loadWatchlist('/nonexistent/path/watchlist.json');
  assert.deepEqual(accounts, []);
});

test('extractContractAddresses: extracts Solana addresses', () => {
  const text = 'Check out this token: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU and another one 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const result = extractContractAddresses(text);
  
  assert.equal(result.solana.length, 2);
  assert.ok(result.solana.includes('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'));
  assert.ok(result.solana.includes('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'));
  assert.equal(result.evm.length, 0);
});

test('extractContractAddresses: extracts EVM addresses', () => {
  const text = 'New token at 0x1234567890123456789012345678901234567890 and 0xABCDEF1234567890123456789012345678901234';
  const result = extractContractAddresses(text);
  
  assert.equal(result.evm.length, 2);
  assert.ok(result.evm.includes('0x1234567890123456789012345678901234567890'));
  assert.ok(result.evm.includes('0xabcdef1234567890123456789012345678901234'));
  assert.equal(result.solana.length, 0);
});

test('extractContractAddresses: handles mixed addresses', () => {
  const text = 'SOL: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU ETH: 0x1234567890123456789012345678901234567890';
  const result = extractContractAddresses(text);
  
  assert.equal(result.solana.length, 1);
  assert.equal(result.evm.length, 1);
  assert.equal(result.all.length, 2);
});

test('extractContractAddresses: deduplicates addresses', () => {
  const text = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU twice 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const result = extractContractAddresses(text);
  
  assert.equal(result.solana.length, 1);
});

test('extractCashtags: extracts ticker symbols', () => {
  const text = 'Bullish on $DOGE and $PEPE! Also watching $BTC';
  const result = extractCashtags(text);
  
  assert.equal(result.length, 3);
  assert.ok(result.includes('DOGE'));
  assert.ok(result.includes('PEPE'));
  assert.ok(result.includes('BTC'));
});

test('extractCashtags: deduplicates cashtags', () => {
  const text = '$DOGE to the moon! $DOGE $doge';
  const result = extractCashtags(text);
  
  assert.equal(result.length, 1);
  assert.equal(result[0], 'DOGE');
});

test('inferChain: identifies Solana addresses', () => {
  assert.equal(inferChain('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), 'sol');
  assert.equal(inferChain('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'), 'sol');
});

test('inferChain: identifies EVM addresses', () => {
  assert.equal(inferChain('0x1234567890123456789012345678901234567890'), 'evm');
  assert.equal(inferChain('0xABCDEF1234567890123456789012345678901234'), 'evm');
});

test('inferChain: returns null for invalid addresses', () => {
  assert.equal(inferChain('not-an-address'), null);
  assert.equal(inferChain('0x123'), null);
  assert.equal(inferChain(''), null);
});
