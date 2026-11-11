#!/usr/bin/env node
/**
 * ✅ Ledger PID-based lock竞争测试：真实两watcher，>=500ms暂停
 * 
 * 验证：149750起点，两个watcher竞争，最终spent<=150000
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== Ledger PID-based Lock Race Test (>=500ms Pause) ===\n');

async function testLedgerLockRace() {
  console.log('--- Test: Ledger Lock (Two Watchers, 149750 start) ---');
  
  const TEMP_DIR = '/tmp/pid-lock-ledger-race';
  const LEDGER_FILE = path.join(TEMP_DIR, 'fomo-credits-ledger.json');
  
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  
  // Initial ledger: 149750 spent (near limit)
  fs.writeFileSync(LEDGER_FILE, JSON.stringify({
    month: '2026-11',
    spent: 149750,
    calls: 0,
    lastRemaining: null,
    log: [],
    reservations: {}
  }));
  
  // Watcher script (simulates budget check + request)
  const makeWatcherScript = (workerId, pauseMs = 0) => `
    import fs from 'fs';
    import path from 'path';
    
    const LEDGER_FILE = '${LEDGER_FILE}';
    const MONTHLY_BUDGET = 150000;
    const EST_COST = 250;
    const WORKER_ID = ${workerId};
    
    function acquireLedgerLock(timeoutMs = 5000) {
      const lockToken = Math.random().toString(36).slice(2, 10);
      const myLockFile = \`\${LEDGER_FILE}.lock.\${process.pid}.\${lockToken}\`;
      const startTime = Date.now();
      
      while (Date.now() - startTime < timeoutMs) {
        try {
          const lockDir = path.dirname(LEDGER_FILE);
          const lockPattern = path.basename(LEDGER_FILE) + '.lock.';
          const existingLocks = fs.readdirSync(lockDir).filter(f => f.startsWith(lockPattern));
          
          for (const lockName of existingLocks) {
            const lockPath = path.join(lockDir, lockName);
            const match = lockName.match(/\\.lock\\.(\\d+)\\./);
            if (!match) {
              try {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > 10000) {
                  fs.unlinkSync(lockPath);
                }
              } catch {}
              continue;
            }
            
            const ownerPid = parseInt(match[1], 10);
            let processAlive = false;
            try {
              process.kill(ownerPid, 0);
              processAlive = true;
            } catch {}
            
            if (!processAlive) {
              try {
                fs.unlinkSync(lockPath);
              } catch {}
            }
          }
        } catch {}
        
        try {
          const fd = fs.openSync(myLockFile, 'wx');
          ${pauseMs > 0 ? `
          console.log(\`W\${WORKER_ID}: wx created, pausing ${pauseMs}ms...\`);
          const pauseStart = Date.now();
          while (Date.now() - pauseStart < ${pauseMs}) {}
          ` : ''}
          const lockData = JSON.stringify({ pid: process.pid, token: lockToken, at: Date.now() });
          fs.writeSync(fd, lockData);
          fs.closeSync(fd);
          return { lockFile: myLockFile, token: lockToken };
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
        
        const waitMs = Math.min(50 + Math.random() * 50, timeoutMs - (Date.now() - startTime));
        if (waitMs > 0) {
          const start = Date.now();
          while (Date.now() - start < waitMs) {}
        }
      }
      throw new Error(\`Failed to acquire ledger lock after \${timeoutMs}ms\`);
    }
    
    function releaseLedgerLock(lockObj) {
      try {
        if (!lockObj.lockFile.includes(\`.lock.\${process.pid}.\`)) {
          return;
        }
        const content = fs.readFileSync(lockObj.lockFile, 'utf8');
        const lockInfo = JSON.parse(content);
        if (lockInfo.token === lockObj.token && lockInfo.pid === process.pid) {
          fs.unlinkSync(lockObj.lockFile);
        }
      } catch {}
    }
    
    function readLedger() {
      const l = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
      return l;
    }
    
    function saveLedger(ledger) {
      fs.writeFileSync(LEDGER_FILE + '.tmp', JSON.stringify(ledger, null, 1));
      fs.renameSync(LEDGER_FILE + '.tmp', LEDGER_FILE);
    }
    
    // Budget check and reserve
    const reservationId = \`w\${WORKER_ID}-\${process.pid}-\${Date.now()}\`;
    const lock = acquireLedgerLock();
    
    const ledger = readLedger();
    ledger.reservations = ledger.reservations || {};
    
    let totalReserved = 0;
    for (const resId in ledger.reservations) {
      totalReserved += ledger.reservations[resId].amount || 0;
    }
    
    console.log(\`W\${WORKER_ID}: spent=\${ledger.spent}, reserved=\${totalReserved}\`);
    
    if (ledger.spent + totalReserved + EST_COST > MONTHLY_BUDGET) {
      releaseLedgerLock(lock);
      console.log(\`W\${WORKER_ID}: REJECTED (budget exceeded)\`);
      process.exit(0);
    }
    
    // Reserve
    ledger.reservations[reservationId] = { amount: EST_COST, pid: process.pid, at: Date.now() };
    saveLedger(ledger);
    releaseLedgerLock(lock);
    
    console.log(\`W\${WORKER_ID}: RESERVED \${EST_COST}\`);
    
    // Simulate request
    const reqStart = Date.now();
    while (Date.now() - reqStart < 50) {}
    
    // Settle
    const settleLock = acquireLedgerLock();
    const finalLedger = readLedger();
    delete finalLedger.reservations[reservationId];
    finalLedger.spent += EST_COST;
    finalLedger.calls++;
    saveLedger(finalLedger);
    releaseLedgerLock(settleLock);
    
    console.log(\`W\${WORKER_ID}: SETTLED \${EST_COST}, final spent=\${finalLedger.spent}\`);
  `;
  
  const watcher1Path = path.join(TEMP_DIR, 'watcher1.mjs');
  const watcher2Path = path.join(TEMP_DIR, 'watcher2.mjs');
  
  // W1: pause 500ms during lock init
  fs.writeFileSync(watcher1Path, makeWatcherScript(1, 500));
  // W2: no pause
  fs.writeFileSync(watcher2Path, makeWatcherScript(2, 0));
  
  // Launch W1
  const w1Proc = spawn('node', [watcher1Path], { stdio: 'inherit' });
  
  // Wait 100ms then launch W2 (during W1's pause)
  await new Promise(r => setTimeout(r, 100));
  const w2Proc = spawn('node', [watcher2Path], { stdio: 'inherit' });
  
  await Promise.all([
    new Promise(r => w1Proc.on('close', r)),
    new Promise(r => w2Proc.on('close', r))
  ]);
  
  // Check result
  const finalLedger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  console.log(`\nFinal ledger: spent=${finalLedger.spent}, calls=${finalLedger.calls}`);
  console.log(`Reservations: ${JSON.stringify(finalLedger.reservations)}`);
  
  // Assertions
  if (finalLedger.spent > 150000) {
    console.error(`❌ Budget exceeded: ${finalLedger.spent} > 150000`);
    return false;
  }
  
  if (finalLedger.calls === 0) {
    console.error(`❌ No requests made (both rejected?)`);
    return false;
  }
  
  if (finalLedger.calls > 1) {
    console.error(`❌ Expected max 1 call, got ${finalLedger.calls}`);
    return false;
  }
  
  const totalReserved = Object.values(finalLedger.reservations).reduce((sum, r) => sum + (r.amount || 0), 0);
  if (totalReserved > 0) {
    console.error(`❌ Reservations not cleaned: ${totalReserved}`);
    return false;
  }
  
  // Check no leftover locks
  const lockFiles = fs.readdirSync(TEMP_DIR).filter(f => f.includes('.lock.'));
  if (lockFiles.length > 0) {
    console.error(`❌ Leftover locks: ${lockFiles.join(', ')}`);
    return false;
  }
  
  console.log(`✅ Ledger lock test PASSED (500ms pause, spent=${finalLedger.spent}<=150000)\n`);
  return true;
}

// Run test
async function main() {
  const results = [];
  
  try {
    results.push(await testLedgerLockRace());
  } catch (err) {
    console.error(`❌ Ledger lock test failed: ${err.message}`);
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
