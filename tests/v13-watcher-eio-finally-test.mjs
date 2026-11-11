#!/usr/bin/env node
/**
 * v13: Test watcher first saveLedger EIO with finally fix
 * 
 * This test injects a synthetic EIO error into the first saveLedger call
 * during budget reservation, then verifies:
 * 1. The lock FD is properly released (closed)
 * 2. Another process can acquire the lock after the error
 * 3. FD count matches (all opened FDs are closed)
 */

import fs from 'node:fs';
import fsExt from 'fs-ext';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TEST_DIR = '/tmp/v13-watcher-eio-test';
const LEDGER = path.join(TEST_DIR, 'ledger.json');
const LOCK_PATH = LEDGER + '.lock';

// Setup
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
fs.mkdirSync(TEST_DIR, { recursive: true });
fs.writeFileSync(LEDGER, JSON.stringify({ month: '2026-11', spent: 0, calls: 0, log: [], reservations: {} }));

console.log('[v13-watcher-eio-finally-test] Starting...');

// Run worker and wait for result
const worker = spawn(process.execPath, [path.join('/workspace/tests/v13-watcher-eio-worker.mjs'), LEDGER], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env }
});

let stdout = '';
let stderr = '';

worker.stdout.on('data', data => { stdout += data.toString(); });
worker.stderr.on('data', data => { stderr += data.toString(); });

await new Promise((resolve) => {
  worker.on('close', async (code) => {
    console.log('[v13-watcher-eio-finally-test] Worker exited with code:', code);
    console.log('[v13-watcher-eio-finally-test] Worker stdout:', stdout);
    if (stderr) console.log('[v13-watcher-eio-finally-test] Worker stderr:', stderr);
    
    try {
      const result = JSON.parse(stdout.trim());
      console.log('[v13-watcher-eio-finally-test] Worker result:', result);
      
      // Verify
      if (result.errorCode !== 'EIO') {
        console.error('[FAIL] Expected EIO error, got:', result.errorCode);
        process.exit(1);
      }
      
      if (result.fdOpens !== result.fdCloses) {
        console.error('[FAIL] FD leak detected:', result.fdOpens, 'opens,', result.fdCloses, 'closes');
        process.exit(1);
      }
      
      if (!result.lockReleased) {
        console.error('[FAIL] Lock not released');
        process.exit(1);
      }
      
      // Try to acquire lock from main process (should succeed immediately)
      const startProbe = Date.now();
      let probeFd = null;
      try {
        probeFd = fs.openSync(LOCK_PATH, 'w');
        fsExt.flockSync(probeFd, 'exnb');
        const probeMs = Date.now() - startProbe;
        console.log('[v13-watcher-eio-finally-test] Main process acquired lock in', probeMs, 'ms');
        
        if (probeMs > 100) {
          console.error('[FAIL] Lock acquisition took too long (', probeMs, 'ms), suggests FD not released');
          process.exit(1);
        }
        
        fsExt.flockSync(probeFd, 'un');
        fs.closeSync(probeFd);
      } catch (err) {
        console.error('[FAIL] Main process could not acquire lock:', err.code, err.message);
        process.exit(1);
      }
      
      console.log('[PASS] v13 watcher EIO finally fix verified:');
      console.log('  - EIO error thrown from saveLedger');
      console.log('  - All FDs closed (', result.fdOpens, 'opens,', result.fdCloses, 'closes)');
      console.log('  - Lock released in finally block');
      console.log('  - Main process acquired lock immediately after worker exit');
      
      process.exit(0);
    } catch (err) {
      console.error('[FAIL] Could not parse worker output:', err.message);
      console.error('stdout:', stdout);
      console.error('stderr:', stderr);
      process.exit(1);
    }
    
    resolve();
  });
});
