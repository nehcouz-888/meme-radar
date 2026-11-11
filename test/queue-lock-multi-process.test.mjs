#!/usr/bin/env node
/**
 * 真实多进程队列锁并发测试
 * - 24并发claim（无重复）
 * - 8 writer 800 events + 8 claim/ack workers（数据完整性）
 * ✅ 验证：event总数、唯一ID数、status计数
 * ✅ 不依赖watcher，直接调用queue模块
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = resolve(__dirname, '../test-temp-lock-multiproc');

// 测试1: 24并发claim（无重复）
async function test24ConcurrentClaims() {
  console.log('\n=== Test 1: 24 Concurrent Claims (No Duplicates) ===');
  const queueFile = resolve(testDir, '24-claims-queue.jsonl');
  
  // 准备100个pending事件
  const setupCode = `
import { addPendingAlert } from '${resolve(__dirname, '../src/modules/alert-queue.mjs')}';
const queueFile = '${queueFile}';
for (let i = 0; i < 100; i++) {
  addPendingAlert(queueFile, { eventId: 'event-' + i, data: 'test' + i });
}
console.log('Setup: 100 pending events');
`;
  await runWorker(setupCode);
  
  // 24个claimant并发claim
  const claimCode = `
import { claimPendingAlerts } from '${resolve(__dirname, '../src/modules/alert-queue.mjs')}';
const queueFile = '${queueFile}';
const workerId = process.argv[2];
// ✅ Force now to 12:00 CST (04:00 UTC) to avoid quiet hours
const forcedNow = new Date('2024-01-01T04:00:00.000Z').getTime();
const result = claimPendingAlerts(queueFile, { maxClaims: 10, workerId, leaseDurationMs: 60000, now: forcedNow });
console.log(JSON.stringify({ workerId, claimed: result.claimed.map(a => a.eventId) }));
`;
  
  const workers = [];
  for (let i = 0; i < 24; i++) {
    workers.push(runWorker(claimCode, [`worker-${i}`]));
  }
  
  const results = await Promise.all(workers);
  
  // 验证：所有eventId唯一
  const allClaimed = new Set();
  for (const r of results) {
    const parsed = JSON.parse(r.trim().split('\n').pop());
    for (const id of parsed.claimed) {
      if (allClaimed.has(id)) {
        throw new Error(`❌ Duplicate claim detected: ${id}`);
      }
      allClaimed.add(id);
    }
  }
  
  console.log(`✅ 24 workers claimed ${allClaimed.size} unique events (expected 100)`);
  if (allClaimed.size !== 100) {
    throw new Error(`❌ Expected 100 unique claims, got ${allClaimed.size}`);
  }
}

// 测试2: 8 writer 800 events + 8 claim/ack workers（数据完整性）
async function testMixedConcurrency() {
  console.log('\n=== Test 2: 8 Writers (800 events) + 8 Claim/Ack Workers (Integrity) ===');
  const queueFile = resolve(testDir, 'mixed-concurrency-queue.jsonl');
  
  // 8个writer各写100个事件，并发启动
  const writers = [];
  for (let workerIdx = 0; workerIdx < 8; workerIdx++) {
    const writerCode = `
import { addPendingAlert } from '${resolve(__dirname, '../src/modules/alert-queue.mjs')}';
const queueFile = '${queueFile}';
const workerIdx = ${workerIdx};
let added = 0;
for (let i = 0; i < 100; i++) {
  const eventId = 'w' + workerIdx + '-evt-' + i;
  if (addPendingAlert(queueFile, { eventId, data: 'payload-w' + workerIdx + '-' + i })) {
    added++;
  }
}
console.log(JSON.stringify({ workerIdx, added }));
`;
    writers.push(runWorker(writerCode));
  }
  
  // 等待writer完成
  const writerResults = await Promise.all(writers);
  let totalAdded = 0;
  for (const r of writerResults) {
    const parsed = JSON.parse(r.trim().split('\n').pop());
    totalAdded += parsed.added;
  }
  console.log(`✅ Writers added ${totalAdded} events (expected 800)`);
  if (totalAdded !== 800) {
    throw new Error(`❌ Expected 800 events added, got ${totalAdded}`);
  }
  
  // ✅ Writers完成后再启动claim/ack workers
  const claimWorkers = [];
  for (let i = 0; i < 8; i++) {
    const claimAckCode = `
import { claimPendingAlerts, acknowledgeDelivered } from '${resolve(__dirname, '../src/modules/alert-queue.mjs')}';
const queueFile = '${queueFile}';
const workerId = 'claim-worker-${i}';
let totalClaimed = 0;
let totalAcked = 0;

// ✅ Force now to 12:00 CST to avoid quiet hours
const forcedNow = new Date('2024-01-01T04:00:00.000Z').getTime();

// 多次claim/ack直到没有pending
for (let round = 0; round < 20; round++) {
  const result = claimPendingAlerts(queueFile, { maxClaims: 10, workerId, leaseDurationMs: 60000, now: forcedNow });
  if (result.claimed.length === 0) break;
  totalClaimed += result.claimed.length;
  
  // ✅ acknowledgeDelivered需要为每个eventId单独ack（每个有自己的leaseId）
  for (const item of result.claimed) {
    const acked = acknowledgeDelivered(queueFile, [item.eventId], { now: forcedNow, leaseId: item.leaseId });
    totalAcked += acked.acknowledged.length;
  }
  
  // 模拟处理延迟
  await new Promise(r => setTimeout(r, 10));
}

console.log(JSON.stringify({ workerId, totalClaimed, totalAcked }));
`;
    claimWorkers.push(runWorker(claimAckCode));
  }
  
  // 等待claim/ack worker完成
  const claimResults = await Promise.all(claimWorkers);
  let totalClaimed = 0;
  let totalAcked = 0;
  for (const r of claimResults) {
    const parsed = JSON.parse(r.trim().split('\n').pop());
    totalClaimed += parsed.totalClaimed;
    totalAcked += parsed.totalAcked;
  }
  console.log(`✅ Claim workers claimed ${totalClaimed}, acked ${totalAcked}`);
  
  // 验证队列完整性
  const verifyCode = `
import { loadQueue } from '${resolve(__dirname, '../src/modules/alert-queue.mjs')}';
const items = loadQueue('${queueFile}');
const eventIds = new Set(items.map(i => i.eventId));
const statusCount = {};
for (const item of items) {
  statusCount[item.status] = (statusCount[item.status] || 0) + 1;
}
console.log(JSON.stringify({ total: items.length, unique: eventIds.size, statusCount }));
`;
  
  const verifyResult = await runWorker(verifyCode);
  const final = JSON.parse(verifyResult.trim().split('\n').pop());
  
  console.log(`✅ Final queue state: ${JSON.stringify(final)}`);
  
  // 严格断言
  if (final.unique !== 800) {
    throw new Error(`❌ Expected 800 unique events, got ${final.unique}`);
  }
  if (final.total !== 800) {
    throw new Error(`❌ Expected 800 total events (no loss), got ${final.total}`);
  }
  if (final.statusCount.delivered !== 800) {
    throw new Error(`❌ Expected 800 delivered, got ${JSON.stringify(final.statusCount)}`);
  }
  
  console.log('✅ Integrity verified: 800 unique events, all delivered, no loss');
}

// 工具：运行子进程worker
function runWorker(code, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--input-type=module', '--eval', code, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Worker failed (code ${code}):\n${stderr}\n${stdout}`));
      } else {
        resolve(stdout);
      }
    });
    
    child.on('error', reject);
  });
}

// 主入口
(async () => {
  try {
    // 清理并创建测试目录
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    
    await test24ConcurrentClaims();
    await testMixedConcurrency();
    
    console.log('\n✅ All multi-process lock tests passed\n');
    process.exit(0);
  } catch (e) {
    console.error(`\n❌ Test failed: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  } finally {
    // 清理
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  }
})();
