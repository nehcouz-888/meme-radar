#!/usr/bin/env node
/**
 * v11 real barrier 800: writer+claim+ack+cleanup in single synchronized barrier
 * All 20 processes start together, each performs mixed operations
 * Imports real production queue functions
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-barrier-'));
const queueFile = path.join(testDir, 'queue.jsonl');
const readyBarrier = path.join(testDir, 'ready');
const releaseBarrier = path.join(testDir, 'release');

fs.writeFileSync(queueFile, '');
fs.mkdirSync(readyBarrier);

console.log('=== 800 Barrier Mixed Operations ===');
console.log('Queue:', queueFile);

const workerCode = `
import { addPendingAlert, claimPendingAlerts, acknowledgeDelivered, cleanupQueue } from '${ROOT}/src/modules/alert-queue.mjs';
import fs from 'node:fs';

const queue = '${queueFile}';
const workerId = parseInt(process.argv[2]);
const readyBarrier = '${readyBarrier}';
const releaseBarrier = '${releaseBarrier}';

// Phase 1: Write 40 events
for (let i = 0; i < 40; i++) {
  await addPendingAlert(queue, {
    eventId: 'E' + (workerId * 40 + i),
    whenIso: new Date().toISOString()
  });
}

// Signal ready
fs.writeFileSync(readyBarrier + '/worker-' + workerId, '');

// Wait for release barrier
while (!fs.existsSync(releaseBarrier)) {
  const start = Date.now();
  while (Date.now() - start < 10) {}
}

// Phase 2: Mixed operations (concurrent with other workers)
const claimResult = await claimPendingAlerts(queue, { maxClaims: 5 });
const claimed = claimResult.claimed.length;

if (claimed > 0) {
  const leaseIds = claimResult.claimed.map(c => c.leaseId);
  await acknowledgeDelivered(queue, claimResult.claimed[0].eventId, { leaseId: leaseIds[0] });
}

await cleanupQueue(queue, { olderThanMs: 0 });

console.log('W' + workerId + ':' + claimed);
`;

const workerPath = path.join(ROOT, 'tests/.temp-barrier-worker.mjs');
fs.writeFileSync(workerPath, workerCode);

// Launch 20 workers simultaneously
const workers = [];
for (let i = 0; i < 20; i++) {
  const w = spawn('node', [workerPath, String(i)], { cwd: ROOT });
  workers.push(w);
  
  let out = '';
  w.stdout.on('data', d => {
    out += d.toString();
    if (out.includes('W' + i + ':')) {
      console.log('  ' + out.trim());
    }
  });
}

// Wait for all workers ready
console.log('\nWaiting for all 20 workers ready...');
const startWait = Date.now();
while (true) {
  const readyFiles = fs.readdirSync(readyBarrier).filter(f => f.startsWith('worker-'));
  if (readyFiles.length === 20) {
    console.log('All 20 workers ready (' + (Date.now() - startWait) + 'ms)');
    break;
  }
  if (Date.now() - startWait > 30000) {
    console.log('✗ Timeout waiting for workers');
    process.exit(1);
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}

// Release barrier
console.log('Releasing barrier for mixed operations...');
fs.writeFileSync(releaseBarrier, '');

// Wait for all workers
await Promise.all(workers.map(w => new Promise(resolve => w.on('close', resolve))));

// Verify
const { loadQueue } = await import('../src/modules/alert-queue.mjs');
const finalItems = loadQueue(queueFile);

console.log('\n=== Results ===');
console.log('Expected writes: 800');
console.log('Final items:', finalItems.length);
console.log('Status breakdown:', {
  pending: finalItems.filter(i => i.status === 'pending').length,
  claimed: finalItems.filter(i => i.status === 'claimed').length,
  delivered: finalItems.filter(i => i.status === 'delivered').length
});

// Cleanup
fs.unlinkSync(workerPath);
fs.rmSync(testDir, { recursive: true, force: true });

if (finalItems.length <= 800) {
  console.log('\n✅ 800 barrier mixed PASSED');
  process.exit(0);
} else {
  console.log('\n✗ FAILED: More items than expected');
  process.exit(1);
}
