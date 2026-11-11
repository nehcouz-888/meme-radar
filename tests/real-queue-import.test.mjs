#!/usr/bin/env node
/**
 * ✅ 真实队列模块import测试（不内联算法）
 * 
 * Import真实addPendingAlert和claimPendingAlerts
 * 验证800并发写入+claim互斥
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Import真实queue模块
const QUEUE_MODULE = path.join(__dirname, '../src/modules/alert-queue.mjs');
const CLAIM_SCRIPT = path.join(__dirname, '../scripts-production/claim-pending-alerts.mjs');

console.log('=== Real Queue Import Test ===\n');

async function test800ConcurrentWrites() {
  console.log('--- Test: 800 Concurrent Writes + Claims ---');
  
  const TEMP_DIR = '/tmp/real-queue-import-test';
  const QUEUE_FILE = path.join(TEMP_DIR, 'pending-alerts.json');
  
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  
  fs.writeFileSync(QUEUE_FILE, JSON.stringify({ events: [] }));
  
  // Worker script: import real addPendingAlert
  const writerScript = `
    import { addPendingAlert } from '${QUEUE_MODULE}';
    
    const QUEUE_FILE = '${QUEUE_FILE}';
    const WORKER_ID = process.env.WORKER_ID;
    const WRITES_PER_WORKER = 40;
    
    const results = [];
    
    for (let i = 0; i < WRITES_PER_WORKER; i++) {
      const event = {
        eventId: \`W\${WORKER_ID}_\${i}\`,
        data: { worker: WORKER_ID, index: i }
      };
      
      const added = addPendingAlert(QUEUE_FILE, event);
      results.push(added);
    }
    
    console.log(JSON.stringify({ worker: WORKER_ID, results: results.filter(r => r === true).length }));
  `;
  
  const writerPath = path.join(TEMP_DIR, 'writer.mjs');
  fs.writeFileSync(writerPath, writerScript);
  
  // Launch 20 writers (20 * 40 = 800 writes)
  const writers = [];
  for (let i = 0; i < 20; i++) {
    const proc = spawn('node', [writerPath], {
      env: { ...process.env, WORKER_ID: String(i) },
      stdio: 'pipe'
    });
    
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    
    writers.push(new Promise((resolve) => {
      proc.on('close', code => resolve({ code, stdout }));
    }));
  }
  
  const results = await Promise.all(writers);
  
  // Count successful writes
  let totalTrue = 0;
  for (const { stdout } of results) {
    try {
      const data = JSON.parse(stdout);
      totalTrue += data.results;
    } catch {}
  }
  
  console.log(`Writers returned true: ${totalTrue}/800`);
  
  // Check final queue
  const finalQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  const persisted = finalQueue.events.length;
  console.log(`Persisted events: ${persisted}`);
  
  // Check no leftover locks
  const lockDirs = fs.readdirSync(TEMP_DIR).filter(f => f.includes('.lock'));
  console.log(`Leftover locks: ${lockDirs.length}`);
  
  // Assertions
  if (totalTrue !== 800) {
    console.error(`❌ Expected 800 true returns, got ${totalTrue}`);
    return false;
  }
  
  if (persisted !== 800) {
    console.error(`❌ Expected 800 persisted, got ${persisted}`);
    return false;
  }
  
  if (lockDirs.length > 0) {
    console.error(`❌ Leftover locks: ${lockDirs.join(', ')}`);
    return false;
  }
  
  console.log('✅ 800 concurrent writes test PASSED\n');
  return true;
}

async function testSimultaneousClaims() {
  console.log('--- Test: Simultaneous Claims (No Duplicate) ---');
  
  const TEMP_DIR = '/tmp/real-claim-test';
  const QUEUE_FILE = path.join(TEMP_DIR, 'pending-alerts.json');
  
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  
  // Setup queue with one event
  fs.writeFileSync(QUEUE_FILE, JSON.stringify({
    events: [{
      eventId: 'ORIGINAL',
      status: 'pending',
      whenIso: new Date().toISOString()
    }]
  }));
  
  // Launch 2 claims simultaneously
  const claims = [];
  for (let i = 0; i < 2; i++) {
    const proc = spawn('node', [CLAIM_SCRIPT, '--queue', QUEUE_FILE, '--lease-min', '5'], {
      stdio: 'pipe'
    });
    
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    
    claims.push(new Promise((resolve) => {
      proc.on('close', code => resolve({ code, stdout }));
    }));
  }
  
  const results = await Promise.all(claims);
  
  // Parse claim results
  const claimedEvents = [];
  for (const { stdout } of results) {
    try {
      const data = JSON.parse(stdout);
      if (data.claimed) {
        claimedEvents.push(...data.claimed.map(e => e.eventId));
      }
    } catch {}
  }
  
  console.log(`Total claimed: ${claimedEvents.length}`);
  console.log(`Claimed events: ${JSON.stringify(claimedEvents)}`);
  
  // Count ORIGINAL
  const originalCount = claimedEvents.filter(id => id === 'ORIGINAL').length;
  console.log(`ORIGINAL claimed by: ${originalCount} claims`);
  
  // Assertions
  if (originalCount > 1) {
    console.error(`❌ ORIGINAL claimed ${originalCount} times (duplicate)`);
    return false;
  }
  
  if (originalCount === 0) {
    console.error(`❌ ORIGINAL not claimed`);
    return false;
  }
  
  console.log('✅ Simultaneous claims test PASSED (no duplicate)\n');
  return true;
}

// Run tests
async function main() {
  const results = [];
  
  try {
    results.push(await test800ConcurrentWrites());
  } catch (err) {
    console.error(`❌ 800 writes test failed: ${err.message}`);
    results.push(false);
  }
  
  try {
    results.push(await testSimultaneousClaims());
  } catch (err) {
    console.error(`❌ Claims test failed: ${err.message}`);
    results.push(false);
  }
  
  const passed = results.filter(r => r === true).length;
  const failed = results.filter(r => r === false).length;
  
  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}/${results.length}`);
  console.log(`Failed: ${failed}/${results.length}`);
  
  if (failed > 0) {
    process.exit(1);
  }
  
  console.log('\n✅ All tests passed');
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
