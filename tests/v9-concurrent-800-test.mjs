#!/usr/bin/env node
/**
 * v9 proper-lockfile: 800 concurrent mixed writes (regression test from v7/v8)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v9-800-'));
const queueFile = path.join(testDir, 'queue.jsonl');
fs.writeFileSync(queueFile, '');

console.log('=== 800 Mixed Writers Test ===');
console.log('Queue:', queueFile);

const workerCode = `
import { addPendingAlert } from '${ROOT}/src/modules/alert-queue.mjs';
const queue = '${queueFile}';
const start = parseInt(process.argv[2]);
const count = parseInt(process.argv[3]);

let successes = 0;
for (let i = 0; i < count; i++) {
  const result = await addPendingAlert(queue, {
    eventId: 'E' + (start + i),
    whenIso: new Date().toISOString()
  });
  if (result) successes++;
}
console.log('DONE:' + successes);
`;

const workerPath = path.join(testDir, 'writer.mjs');
fs.writeFileSync(workerPath, workerCode);

const startTime = Date.now();

// Launch 20 workers, each writing 40 events
const workers = [];
for (let i = 0; i < 20; i++) {
  const w = spawn('node', [workerPath, String(i * 40), '40']);
  workers.push(w);
  
  w.stdout.on('data', (d) => {
    const match = d.toString().match(/DONE:(\d+)/);
    if (match) {
      console.log(`Worker ${i} completed: ${match[1]}/40 writes`);
    }
  });
  
  w.stderr.on('data', (d) => {
    console.error(`Worker ${i} error:`, d.toString().slice(0, 200));
  });
}

await Promise.all(workers.map(w => new Promise(resolve => w.on('close', resolve))));

const elapsedMs = Date.now() - startTime;

// Count persisted events
const content = fs.readFileSync(queueFile, 'utf8');
const lines = content.trim().split('\n').filter(Boolean);
const events = lines.map((line, idx) => {
  try {
    return JSON.parse(line);
  } catch {
    console.error(`Invalid line ${idx}:`, line.slice(0, 100));
    return null;
  }
}).filter(Boolean);

const uniqueEvents = new Set(events.map(e => e.eventId));

console.log('\n=== Results ===');
console.log('Expected writes: 800');
console.log('Persisted lines:', lines.length);
console.log('Valid events:', events.length);
console.log('Unique events:', uniqueEvents.size);
console.log('Elapsed:', elapsedMs + 'ms');

// Check for duplicates
const duplicates = events.length - uniqueEvents.size;
if (duplicates > 0) {
  console.log('⚠ Duplicates found:', duplicates);
}

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });

if (uniqueEvents.size === 800 && duplicates === 0) {
  console.log('\n✅ 800 concurrent writes PASSED');
  process.exit(0);
} else {
  console.log('\n✗ 800 concurrent writes FAILED');
  process.exit(1);
}
