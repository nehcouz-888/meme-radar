/**
 * End-to-End Test: Exit Monitoring Integration
 * 
 * Tests the full flow:
 * 1. Load/create watchlist
 * 2. Auto-register candidates
 * 3. Refresh holdings
 * 4. Detect exits/downgrades
 * 5. Send deduplicated alerts
 * 6. Save watchlist
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadWatchlist,
  saveWatchlist,
  writePendingAlert
} from '../scripts/exit-downgrade-run-integrated.mjs';

import {
  autoRegisterToWatchlist,
  createHoldingSnapshot,
  analyzeHoldingChange,
  shouldSendAlert,
  recordAlertSent
} from '../src/modules/exit-monitoring.mjs';

test('E2E: Watchlist auto-register → refresh → alert → dedupe', async () => {
  // Setup temp directories
  const testDir = path.join(tmpdir(), `exit-test-${Date.now()}`);
  const watchFile = path.join(testDir, 'watchlist.json');
  const alertsDir = path.join(testDir, 'alerts');
  const queueFile = path.join(testDir, 'queue.jsonl');
  
  fs.mkdirSync(testDir, { recursive: true });
  
  try {
    // Step 1: Create empty watchlist
    let watchlist = { version: 2, items: [], lastUpdatedAt: Date.now() };
    
    // Step 2: Auto-register a candidate
    const token = {
      chain: 'sol',
      address: 'TEST123ABC',
      symbol: 'TESTCOIN'
    };
    
    const r1 = autoRegisterToWatchlist(token, 'hot_board', watchlist);
    assert.equal(r1.registered, true);
    assert.equal(r1.watchlist.items.length, 1);
    
    watchlist = r1.watchlist;
    const item = watchlist.items[0];
    
    // Step 3: Add initial holding snapshot
    const snapshot1 = createHoldingSnapshot('fomo', {
      smartWallets: [
        { address: 'SMART_A', tags: ['smart_degen'] },
        { address: 'SMART_B', tags: ['smart_degen'] },
        { address: 'SMART_C', tags: ['smart_degen'] }
      ],
      totalSampleSize: 3,
      sampleComplete: true
    });
    
    item.snapshotHistory = [snapshot1];
    item.smartHoldingCount = 3;
    item.prevSmartHoldingCount = 3;
    
    // Step 4: Simulate refresh with holding decrease (complete sample)
    const snapshot2 = createHoldingSnapshot('fomo', {
      smartWallets: [
        { address: 'SMART_A', tags: ['smart_degen'] }
        // SMART_B and SMART_C exited
      ],
      totalSampleSize: 1,
      sampleComplete: true  // ✅ Complete sample
    });
    
    item.snapshotHistory.push(snapshot2);
    item.smartHoldingCount = 1;
    
    // Step 5: Analyze change
    const analysis = analyzeHoldingChange(snapshot1, snapshot2);
    
    assert.equal(analysis.conclusion, 'NET_SELLING_PRESSURE');
    assert.equal(analysis.exitedCount, 2);
    assert.equal(analysis.canConfirm, true);
    
    item.latestChangeAnalysis = analysis;
    
    // Step 6: Create alert
    const alert = {
      type: 'smart_money_reducing',
      chain: token.chain,
      address: token.address,
      severity: 'MEDIUM',
      message: `Smart money reducing: ${token.symbol} 3 → 1`
    };
    
    // Step 7: Check should send (first time)
    const should1 = shouldSendAlert(alert, item, 3600_000);
    assert.equal(should1, true);
    
    // Step 8: Write alert
    const cfg = { alertsDir, queueFile };
    const written = writePendingAlert(cfg, 'Alert text', {
      type: alert.type,
      chain: token.chain,
      address: token.address,
      symbol: token.symbol
    }, item);
    
    assert.ok(written.id);
    assert.ok(fs.existsSync(written.file));
    
    // Step 9: Record alert sent (after delivery)
    recordAlertSent(item, {
      ...alert,
      id: written.id
    });
    
    assert.equal(item.alerts.length, 1);
    assert.ok(item.alerts[0].sentAt);
    
    // Step 10: Check deduplication (same alert should not send again)
    const should2 = shouldSendAlert(alert, item, 3600_000);
    assert.equal(should2, false);
    
    // Step 11: Save watchlist
    saveWatchlist(watchFile, watchlist);
    assert.ok(fs.existsSync(watchFile));
    
    // Step 12: Load and verify
    const loaded = JSON.parse(fs.readFileSync(watchFile, 'utf8'));
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.items[0].symbol, 'TESTCOIN');
    assert.equal(loaded.items[0].snapshotHistory.length, 2);
    assert.equal(loaded.items[0].alerts.length, 1);
    
    // Verify queue file
    const queueLines = fs.readFileSync(queueFile, 'utf8').trim().split('\n');
    assert.equal(queueLines.length, 1);
    const queueEntry = JSON.parse(queueLines[0]);
    assert.equal(queueEntry.status, 'pending');  // ❌ NOT 'delivered'
    assert.ok(queueEntry.enqueuedAt);
    
  } finally {
    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('E2E: Sample incomplete → cannot confirm exit', () => {
  // Sample incomplete scenario
  const prev = createHoldingSnapshot('fomo', {
    smartWallets: [
      { address: 'SMART_A' },
      { address: 'SMART_B' }
    ],
    totalSampleSize: 2,
    sampleComplete: true
  });
  
  const curr = createHoldingSnapshot('fomo', {
    smartWallets: [],
    totalSampleSize: 0,
    sampleComplete: false  // ❌ Incomplete
  });
  
  const analysis = analyzeHoldingChange(prev, curr);
  
  // Should NOT confirm exit
  assert.equal(analysis.conclusion, 'INSUFFICIENT_DATA');
  assert.equal(analysis.canConfirm, false);
  assert.match(analysis.reason, /样本不完整/);
  assert.match(analysis.note, /样本缺失 ≠ 钱包清仓/);
});

test('E2E: Contradictory samples from fixture', () => {
  // From offline-samples.json: leaderboard says [A,B], live says [A]
  const leaderboardSnapshot = createHoldingSnapshot('fomo:leaderboard', {
    smartWallets: [
      { address: 'SMART_A' },
      { address: 'SMART_B' }
    ],
    totalSampleSize: 2,
    sampleComplete: false  // Leaderboard is partial
  });
  
  const liveSnapshot = createHoldingSnapshot('fomo:live', {
    smartWallets: [
      { address: 'SMART_A' }
      // SMART_B not in live sample
    ],
    totalSampleSize: 50,  // Total holders
    sampleComplete: false  // Only got partial sample
  });
  
  // Cannot determine if SMART_B exited or just not in sample
  const analysis = analyzeHoldingChange(leaderboardSnapshot, liveSnapshot);
  
  assert.equal(analysis.conclusion, 'INSUFFICIENT_DATA');
  assert.equal(analysis.canConfirm, false);
  
  // Need complete live sample to confirm
  const liveComplete = createHoldingSnapshot('fomo:live', {
    smartWallets: [
      { address: 'SMART_A' }
    ],
    totalSampleSize: 1,
    sampleComplete: true  // ✅ Complete
  });
  
  // Now can compare (but against unknown leaderboard completeness)
  const analysis2 = analyzeHoldingChange(leaderboardSnapshot, liveComplete);
  assert.equal(analysis2.conclusion, 'INSUFFICIENT_DATA');  // Still uncertain due to prev incomplete
});
