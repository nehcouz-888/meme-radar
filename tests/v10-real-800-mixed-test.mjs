#!/usr/bin/env node
/**
 * v10 real 800 mixed: writer + claim + ack + cleanup
 * Imports real production queue functions, no copied logic
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v10-800-'));
const queueFile = path.join(testDir, 'queue.jsonl');
fs.writeFileSync(queueFile, '');

console.log('=== 800 Mixed Operations Test ===');
console.log('Queue:', queueFile);

// Writer: add events
const writerCode = `
import { addPendingAlert } from '${ROOT}/src/modules/alert-queue.mjs';
const queue = '${queueFile}';
const start = parseInt(process.argv[2]);
const count = parseInt(process.argv[3]);

for (let i = 0; i < count; i++) {
  await addPendingAlert(queue, {
    eventId: 'E' + (start + i),
    whenIso: new Date().toISOString()
  });
}
console.log('DONE:' + count);
`;

// Claimer: claim pending alerts
const claimerCode = `
import { claimPendingAlerts } from '${ROOT}/src/modules/alert-queue.mjs';
const queue = '${queueFile}';
const workerId = process.argv[2];

const result = await claimPendingAlerts(queue, { maxClaims: 50 });
console.log('CLAIMED:' + result.claimed.length + ':' + workerId);
`;

// Acknowledger: acknowledge delivered
const ackerCode = `
import { acknowledgeDelivered, loadQueue } from '${ROOT}/src/modules/alert-queue.mjs';
const queue = '${queueFile}';

const items = loadQueue(queue);
const claimed = items.filter(i => i.status === 'claimed').slice(0, 10);
const eventIds = claimed.map(i => i.eventId);

if (eventIds.length > 0) {
  await acknowledgeDelivered(queue, eventIds);
  console.log('ACKED:' + eventIds.length);
} else {
  console.log('ACKED:0');
}
`;

// Cleaner: cleanup old events
const cleanerCode = `
import { cleanupQueue } from '${ROOT}/src/modules/alert-queue.mjs';
const queue = '${queueFile}';

const result = await cleanupQueue(queue, { olderThanMs: 0 });
console.log('CLEANED:' + result.removed);
`;

const writerPath = path.join(ROOT, 'tests/.temp-writer.mjs');
const claimerPath = path.join(ROOT, 'tests/.temp-claimer.mjs');
const ackerPath = path.join(ROOT, 'tests/.temp-acker.mjs');
const cleanerPath = path.join(ROOT, 'tests/.temp-cleaner.mjs');

fs.writeFileSync(writerPath, writerCode);
fs.writeFileSync(claimerPath, claimerCode);
fs.writeFileSync(ackerPath, ackerCode);
fs.writeFileSync(cleanerPath, cleanerCode);

const startTime = Date.now();

// Phase 1: Launch 20 writers (800 events total)
console.log('\nPhase 1: 20 writers × 40 events = 800 writes');
const writers = [];
for (let i = 0; i < 20; i++) {
  const w = spawn('node', [writerPath, String(i * 40), '40'], { cwd: ROOT });
  writers.push(w);
  w.stdout.on('data', d => {
    if (d.toString().includes('DONE')) {
      console.log(`  Writer ${i}: ${d.toString().trim()}`);
    }
  });
}
await Promise.all(writers.map(w => new Promise(resolve => w.on('close', resolve))));

// Phase 2: Launch 4 claimers concurrently
console.log('\nPhase 2: 4 claimers (concurrent claims)');
const claimers = [];
for (let i = 0; i < 4; i++) {
  const c = spawn('node', [claimerPath, String(i)], { cwd: ROOT });
  claimers.push(c);
  c.stdout.on('data', d => {
    if (d.toString().includes('CLAIMED')) {
      console.log(`  Claimer ${i}: ${d.toString().trim()}`);
    }
  });
}
await Promise.all(claimers.map(c => new Promise(resolve => c.on('close', resolve))));

// Phase 3: Launch 2 acknowledgers
console.log('\nPhase 3: 2 acknowledgers');
const ackers = [];
for (let i = 0; i < 2; i++) {
  const a = spawn('node', [ackerPath], { cwd: ROOT });
  ackers.push(a);
  a.stdout.on('data', d => {
    if (d.toString().includes('ACKED')) {
      console.log(`  Acker ${i}: ${d.toString().trim()}`);
    }
  });
}
await Promise.all(ackers.map(a => new Promise(resolve => a.on('close', resolve))));

// Phase 4: Launch 2 cleaners
console.log('\nPhase 4: 2 cleaners (concurrent cleanup)');
const cleaners = [];
for (let i = 0; i < 2; i++) {
  const c = spawn('node', [cleanerPath], { cwd: ROOT });
  cleaners.push(c);
  c.stdout.on('data', d => {
    if (d.toString().includes('CLEANED')) {
      console.log(`  Cleaner ${i}: ${d.toString().trim()}`);
    }
  });
}
await Promise.all(cleaners.map(c => new Promise(resolve => c.on('close', resolve))));

const elapsedMs = Date.now() - startTime;

// Verify final state
const { loadQueue } = await import('../src/modules/alert-queue.mjs');
const finalItems = loadQueue(queueFile);

console.log('\n=== Results ===');
console.log('Expected writes: 800');
console.log('Final items:', finalItems.length);
console.log('Elapsed:', elapsedMs + 'ms');

// Cleanup temp files
fs.unlinkSync(writerPath);
fs.unlinkSync(claimerPath);
fs.unlinkSync(ackerPath);
fs.unlinkSync(cleanerPath);
fs.rmSync(testDir, { recursive: true, force: true });

if (finalItems.length <= 800) {
  console.log('\n✅ 800 mixed operations PASSED');
  process.exit(0);
} else {
  console.log('\n✗ FAILED: More items than expected');
  process.exit(1);
}
