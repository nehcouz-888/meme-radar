#!/usr/bin/env node
/**
 * Real 24-worker concurrency test with cross-process lock
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '../test-fixtures/concurrency-24workers');
const QUEUE_FILE = path.join(FIXTURE_DIR, 'queue.jsonl');

// Setup
if (fs.existsSync(FIXTURE_DIR)) {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
}
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

// Create 10 pending alerts
const alerts = [];
for (let i = 0; i < 10; i++) {
  alerts.push({
    eventId: `C_${i}`,
    status: 'pending',
    whenIso: new Date().toISOString(),
    alertContent: `Test alert ${i}`
  });
}
fs.writeFileSync(QUEUE_FILE, alerts.map(a => JSON.stringify(a)).join('\n') + '\n');

console.log('=== Real 24-Worker Concurrency Test ===');
console.log(`Queue: ${QUEUE_FILE}`);
console.log(`Initial pending: ${alerts.length}\n`);

// Launch 24 workers simultaneously
const workers = [];
const startTime = Date.now();

for (let i = 0; i < 24; i++) {
  const worker = spawn('node', [
    path.join(__dirname, '../scripts-production/claim-pending-alerts.mjs'),
    QUEUE_FILE,
    '--max=3',
    '--lease-min=10'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  let stdout = '';
  let stderr = '';
  worker.stdout.on('data', d => { stdout += d.toString(); });
  worker.stderr.on('data', d => { stderr += d.toString(); });
  
  workers.push(new Promise(resolve => {
    worker.on('close', code => {
      resolve({ worker: i, code, stdout, stderr });
    });
  }));
}

// Wait for all workers
const results = await Promise.all(workers);
const elapsed = Date.now() - startTime;

console.log(`All 24 workers completed in ${elapsed}ms\n`);

// Analyze results
const successful = results.filter(r => r.code === 0 || r.code === 1); // 0=claimed, 1=none
const failed = results.filter(r => r.code !== 0 && r.code !== 1);

const allClaims = [];
for (const r of successful) {
  try {
    if (r.stdout.trim()) {
      const json = JSON.parse(r.stdout);
      if (json.claimed && json.claimed.length > 0) {
        allClaims.push(...json.claimed.map(c => c.eventId));
      }
    }
  } catch {}
}

const uniqueClaimed = new Set(allClaims);
const duplicates = allClaims.length - uniqueClaimed.size;

console.log(`Workers: ${workers.length}`);
console.log(`Successful: ${successful.length}`);
console.log(`Failed: ${failed.length}`);
console.log(`Total claims returned: ${allClaims.length}`);
console.log(`Unique claimed IDs: ${uniqueClaimed.size}`);
console.log(`Duplicate claims: ${duplicates}\n`);

// Check persisted state
const finalQueue = fs.readFileSync(QUEUE_FILE, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const persistedClaimed = finalQueue.filter(i => i.status === 'claimed');

console.log(`Persisted queue items: ${finalQueue.length}`);
console.log(`Persisted claimed: ${persistedClaimed.length}`);
console.log(`Persisted pending: ${finalQueue.filter(i => i.status === 'pending').length}\n`);

// Verify no duplicates
if (duplicates === 0 && persistedClaimed.length === uniqueClaimed.size) {
  console.log('✅ PASS: No duplicate claims, lock working correctly');
  process.exit(0);
} else {
  console.error(`❌ FAIL: ${duplicates} duplicate claims or persisted≠unique`);
  console.error(`Claimed IDs: ${Array.from(uniqueClaimed).join(', ')}`);
  console.error(`Duplicates: ${allClaims.filter((id, i, arr) => arr.indexOf(id) !== i).join(', ')}`);
  process.exit(1);
}
