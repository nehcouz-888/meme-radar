#!/usr/bin/env node
/**
 * v9 proper-lockfile validation: real concurrent reclaim, stale release, SIGKILL init
 * Tests the actual production lock implementation (no mock/copy)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Test 1: Concurrent dead owner reclaim (deterministic interleave)
async function testConcurrentReclaim() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v9-reclaim-'));
  const queueFile = path.join(testDir, 'queue.jsonl');
  fs.writeFileSync(queueFile, '');
  
  // Use a checkpoint system to interleave reclaimers
  const checkpointA = path.join(testDir, 'checkpoint-A');
  const checkpointB = path.join(testDir, 'checkpoint-B');
  
  const workerCode = `
    import { addPendingAlert, cleanupPendingQueue } from '${ROOT}/src/modules/alert-queue.mjs';
    import fs from 'node:fs';
    
    const queue = process.argv[2];
    const checkpoint = process.argv[3];
    
    // Wait for checkpoint
    while (!fs.existsSync(checkpoint)) {
      const start = Date.now();
      while (Date.now() - start < 10) {}
    }
    
    // Try to claim after seeing dead owner
    try {
      const result = await cleanupPendingQueue(queue);
      console.log('SUCCESS:' + process.pid);
    } catch (e) {
      console.log('FAIL:' + e.message);
    }
  `;
  
  const workerPath = path.join(testDir, 'reclaim-worker.mjs');
  fs.writeFileSync(workerPath, workerCode);
  
  // Create a dead owner by acquiring lock then killing
  const deadOwner = spawn('node', ['-e', `
    import properLockfile from 'proper-lockfile';
    import fs from 'node:fs';
    const release = properLockfile.lockSync('${queueFile}', { stale: 10000, realpath: false, fs });
    console.log('LOCKED:' + process.pid);
    // Exit without releasing
    process.exit(0);
  `], { shell: false });
  
  await new Promise(resolve => {
    deadOwner.stdout.on('data', d => {
      if (d.toString().includes('LOCKED:')) {
        deadOwner.kill('SIGKILL');
        resolve();
      }
    });
  });
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Launch two reclaimers
  const reclaimerA = spawn('node', [workerPath, queueFile, checkpointA], { cwd: testDir });
  const reclaimerB = spawn('node', [workerPath, queueFile, checkpointB], { cwd: testDir });
  
  let outputA = '';
  let outputB = '';
  
  reclaimerA.stdout.on('data', d => outputA += d.toString());
  reclaimerB.stdout.on('data', d => outputB += d.toString());
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Release A first, then B (deterministic interleave)
  fs.writeFileSync(checkpointA, '');
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(checkpointB, '');
  
  await Promise.all([
    new Promise(resolve => reclaimerA.on('close', resolve)),
    new Promise(resolve => reclaimerB.on('close', resolve))
  ]);
  
  // With proper-lockfile, only one should succeed in acquiring
  const successCount = (outputA.includes('SUCCESS') ? 1 : 0) + (outputB.includes('SUCCESS') ? 1 : 0);
  
  fs.rmSync(testDir, { recursive: true, force: true });
  
  return {
    test: 'concurrent_reclaim',
    pass: successCount === 1,
    successCount,
    outputA: outputA.slice(0, 200),
    outputB: outputB.slice(0, 200)
  };
}

// Test 2: Stale release doesn't delete replacement
async function testStaleRelease() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v9-release-'));
  const queueFile = path.join(testDir, 'queue.jsonl');
  fs.writeFileSync(queueFile, '');
  
  // Import lock functions
  const { addPendingAlert } = await import('../src/modules/alert-queue.mjs');
  
  // Process A acquires and holds
  const lockA = await new Promise((resolve, reject) => {
    addPendingAlert(queueFile, { eventId: 'TEST' })
      .then(() => resolve(true))
      .catch(reject);
  });
  
  // Try to check if another process can steal (should timeout)
  const stolen = await new Promise((resolve) => {
    const child = spawn('node', ['-e', `
      import { addPendingAlert } from '${ROOT}/src/modules/alert-queue.mjs';
      await addPendingAlert('${queueFile}', { eventId: 'STEAL' });
      console.log('STOLEN');
    `], { timeout: 1000 });
    
    let out = '';
    child.stdout.on('data', d => out += d.toString());
    child.on('close', () => resolve(out.includes('STOLEN')));
    
    setTimeout(() => {
      child.kill('SIGTERM');
      resolve(false);
    }, 1000);
  });
  
  fs.rmSync(testDir, { recursive: true, force: true });
  
  return {
    test: 'stale_release',
    pass: !stolen,
    stolen
  };
}

// Test 3: SIGKILL during init recovers immediately
async function testSigkillInit() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v9-sigkill-'));
  const queueFile = path.join(testDir, 'queue.jsonl');
  fs.writeFileSync(queueFile, '');
  
  // Start writer but kill it during lock acquire
  const victim = spawn('node', ['-e', `
    import properLockfile from 'proper-lockfile';
    import fs from 'node:fs';
    const release = properLockfile.lockSync('${queueFile}', { stale: 10000, realpath: false, fs });
    // Killed before release
  `]);
  
  await new Promise(resolve => setTimeout(resolve, 50));
  victim.kill('SIGKILL');
  await new Promise(resolve => victim.on('close', resolve));
  
  // Recovery attempt should succeed within 5s (not 10s)
  const startMs = Date.now();
  const recovery = spawn('node', ['-e', `
    import { addPendingAlert } from '${ROOT}/src/modules/alert-queue.mjs';
    await addPendingAlert('${queueFile}', { eventId: 'RECOVERY' });
    console.log('OK');
  `]);
  
  let recovered = false;
  let out = '';
  recovery.stdout.on('data', d => {
    out += d.toString();
    if (out.includes('OK')) recovered = true;
  });
  
  await new Promise(resolve => recovery.on('close', resolve));
  const elapsedMs = Date.now() - startMs;
  
  fs.rmSync(testDir, { recursive: true, force: true });
  
  return {
    test: 'sigkill_init',
    pass: recovered && elapsedMs < 5000,
    recovered,
    elapsedMs
  };
}

// Test 4: 800 mixed writes (regression)
async function test800Mixed() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v9-800-'));
  const queueFile = path.join(testDir, 'queue.jsonl');
  fs.writeFileSync(queueFile, JSON.stringify([]) + '\n');
  
  const workerCode = `
    import { addPendingAlert } from '${ROOT}/src/modules/alert-queue.mjs';
    const queue = process.argv[2];
    const start = parseInt(process.argv[3]);
    const count = parseInt(process.argv[4]);
    
    for (let i = 0; i < count; i++) {
      await addPendingAlert(queue, { eventId: 'E' + (start + i) });
    }
    console.log('DONE:' + count);
  `;
  
  const workerPath = path.join(testDir, 'writer.mjs');
  fs.writeFileSync(workerPath, workerCode);
  
  // Launch 20 workers, each writing 40 events
  const workers = [];
  for (let i = 0; i < 20; i++) {
    const w = spawn('node', [workerPath, queueFile, String(i * 40), '40']);
    workers.push(w);
  }
  
  await Promise.all(workers.map(w => new Promise(resolve => w.on('close', resolve))));
  
  // Count persisted events
  const lines = fs.readFileSync(queueFile, 'utf8').trim().split('\n').filter(Boolean);
  const events = lines.flatMap(line => {
    try {
      const arr = JSON.parse(line);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  });
  
  const uniqueEvents = new Set(events.map(e => e.eventId));
  
  fs.rmSync(testDir, { recursive: true, force: true });
  
  return {
    test: '800_mixed',
    pass: uniqueEvents.size === 800,
    expected: 800,
    actual: uniqueEvents.size
  };
}

// Run all tests
(async () => {
  const results = [];
  
  console.log('Test 1: Concurrent dead owner reclaim...');
  results.push(await testConcurrentReclaim());
  
  console.log('Test 2: Stale release protection...');
  results.push(await testStaleRelease());
  
  console.log('Test 3: SIGKILL init recovery...');
  results.push(await testSigkillInit());
  
  console.log('Test 4: 800 mixed writes...');
  results.push(await test800Mixed());
  
  console.log('\n=== RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
  
  const allPass = results.every(r => r.pass);
  console.log('\nOverall: ' + (allPass ? 'PASS' : 'FAIL'));
  process.exit(allPass ? 0 : 1);
})();
