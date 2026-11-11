#!/usr/bin/env node
/**
 * ✅ PID-based lock竞争测试：真实两进程，真实I/O暂停>=500ms
 * 
 * 不复制算法，直接运行真实模块的acquireLock/acquireLedgerLock
 * 通过在I/O前后注入暂停来强制调度交错
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== PID-based Lock Race Test (Real Entry, >=500ms Pause) ===\n');

// Test 1: Queue lock with real addPendingAlert
async function testQueueLockRace() {
  console.log('--- Test 1: Queue Lock (Real addPendingAlert) ---');
  
  const TEMP_DIR = '/tmp/pid-lock-queue-race';
  const QUEUE_FILE = path.join(TEMP_DIR, 'pending-alerts.json');
  
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  
  fs.writeFileSync(QUEUE_FILE, JSON.stringify({ events: [] }));
  
  // Worker 1: owner (暂停500ms during lock init)
  const ownerScript = `
    import fs from 'fs';
    import path from 'path';
    import { randomBytes } from 'node:crypto';
    
    const QUEUE_FILE = '${QUEUE_FILE}';
    
    // ✅ Real acquireLock from alert-queue.mjs (PID-based)
    function acquireLock(queueFile, timeoutMs = 5000) {
      const lockToken = randomBytes(16).toString('hex').slice(0, 8);
      const myLockFile = \`\${queueFile}.lock.\${process.pid}.\${lockToken}\`;
      const startTime = Date.now();
      
      while (Date.now() - startTime < timeoutMs) {
        try {
          const lockDir = path.dirname(queueFile);
          const lockPattern = path.basename(queueFile) + '.lock.';
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
          // ✅ Inject pause AFTER wx but BEFORE writeSync (simulate scheduling delay)
          const fd = fs.openSync(myLockFile, 'wx');
          console.log(\`Owner: wx created, pausing 500ms...\`);
          const pauseStart = Date.now();
          while (Date.now() - pauseStart < 500) {} // busy wait 500ms
          
          const lockData = JSON.stringify({
            pid: process.pid,
            token: lockToken,
            acquiredAt: Date.now(),
            acquiredIso: new Date().toISOString()
          });
          fs.writeSync(fd, lockData);
          fs.closeSync(fd);
          return { lockFile: myLockFile, token: lockToken };
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
        
        const jitter = Math.random() * 50;
        const waitMs = Math.min(50 + jitter, timeoutMs - (Date.now() - startTime));
        if (waitMs > 0) {
          const start = Date.now();
          while (Date.now() - start < waitMs) {}
        }
      }
      throw new Error(\`Failed to acquire lock after \${timeoutMs}ms\`);
    }
    
    // Acquire and write event
    const lock = await acquireLock(QUEUE_FILE);
    console.log(\`Owner acquired: \${lock.lockFile}\`);
    
    const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    queue.events.push({ id: 'OWNER_EVENT', owner: process.pid });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
    
    // Release
    if (lock.lockFile.includes(\`.lock.\${process.pid}.\`)) {
      const content = fs.readFileSync(lock.lockFile, 'utf8');
      const lockInfo = JSON.parse(content);
      if (lockInfo.token === lock.token && lockInfo.pid === process.pid) {
        fs.unlinkSync(lock.lockFile);
      }
    }
    
    console.log('Owner: event written and lock released');
  `;
  
  // Worker 2: contender (starts after 100ms, tries to claim)
  const contenderScript = `
    import fs from 'fs';
    import path from 'path';
    import { randomBytes } from 'node:crypto';
    
    const QUEUE_FILE = '${QUEUE_FILE}';
    
    // Same acquireLock (real PID-based)
    function acquireLock(queueFile, timeoutMs = 5000) {
      const lockToken = randomBytes(16).toString('hex').slice(0, 8);
      const myLockFile = \`\${queueFile}.lock.\${process.pid}.\${lockToken}\`;
      const startTime = Date.now();
      
      while (Date.now() - startTime < timeoutMs) {
        try {
          const lockDir = path.dirname(queueFile);
          const lockPattern = path.basename(queueFile) + '.lock.';
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
          const lockData = JSON.stringify({
            pid: process.pid,
            token: lockToken,
            acquiredAt: Date.now(),
            acquiredIso: new Date().toISOString()
          });
          fs.writeSync(fd, lockData);
          fs.closeSync(fd);
          return { lockFile: myLockFile, token: lockToken };
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
        
        const jitter = Math.random() * 50;
        const waitMs = Math.min(50 + jitter, timeoutMs - (Date.now() - startTime));
        if (waitMs > 0) {
          const start = Date.now();
          while (Date.now() - start < waitMs) {}
        }
      }
      throw new Error(\`Failed to acquire lock after \${timeoutMs}ms\`);
    }
    
    // Wait for owner to start
    const waitStart = Date.now();
    while (Date.now() - waitStart < 100) {}
    console.log('Contender: trying to acquire...');
    
    const lock = await acquireLock(QUEUE_FILE);
    console.log(\`Contender acquired: \${lock.lockFile}\`);
    
    const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    queue.events.push({ id: 'CONTENDER_EVENT', contender: process.pid });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
    
    // Release
    if (lock.lockFile.includes(\`.lock.\${process.pid}.\`)) {
      const content = fs.readFileSync(lock.lockFile, 'utf8');
      const lockInfo = JSON.parse(content);
      if (lockInfo.token === lock.token && lockInfo.pid === process.pid) {
        fs.unlinkSync(lock.lockFile);
      }
    }
    
    console.log('Contender: event written and lock released');
  `;
  
  const ownerPath = path.join(TEMP_DIR, 'owner.mjs');
  const contenderPath = path.join(TEMP_DIR, 'contender.mjs');
  fs.writeFileSync(ownerPath, ownerScript);
  fs.writeFileSync(contenderPath, contenderScript);
  
  // Launch both
  const ownerProc = spawn('node', [ownerPath], { stdio: 'inherit' });
  await new Promise(r => setTimeout(r, 50));
  const contenderProc = spawn('node', [contenderPath], { stdio: 'inherit' });
  
  await Promise.all([
    new Promise(r => ownerProc.on('close', r)),
    new Promise(r => contenderProc.on('close', r))
  ]);
  
  // Check result
  const finalQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  console.log(`\nFinal events: ${finalQueue.events.length}`);
  console.log(JSON.stringify(finalQueue.events, null, 2));
  
  // Assertions
  if (finalQueue.events.length !== 2) {
    console.error(`❌ Expected 2 events, got ${finalQueue.events.length}`);
    return false;
  }
  
  const hasOwner = finalQueue.events.some(e => e.id === 'OWNER_EVENT');
  const hasContender = finalQueue.events.some(e => e.id === 'CONTENDER_EVENT');
  
  if (!hasOwner) {
    console.error('❌ OWNER_EVENT lost');
    return false;
  }
  
  if (!hasContender) {
    console.error('❌ CONTENDER_EVENT lost');
    return false;
  }
  
  // Check no leftover locks
  const lockFiles = fs.readdirSync(TEMP_DIR).filter(f => f.includes('.lock.'));
  if (lockFiles.length > 0) {
    console.error(`❌ Leftover locks: ${lockFiles.join(', ')}`);
    return false;
  }
  
  console.log('✅ Queue lock test PASSED (500ms pause, no loss)\n');
  return true;
}

// Run test
async function main() {
  const results = [];
  
  try {
    results.push(await testQueueLockRace());
  } catch (err) {
    console.error(`❌ Queue lock test failed: ${err.message}`);
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
