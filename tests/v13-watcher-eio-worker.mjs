#!/usr/bin/env node
/**
 * Worker for v13 EIO test - injects EIO on first saveLedger
 */

import fs from 'node:fs';
import fsExt from 'fs-ext';

// Monkey-patch writeFileSync to inject EIO on first .tmp write
let firstWrite = true;
const origWrite = fs.writeFileSync;
fs.writeFileSync = function(path, data, options) {
  if (firstWrite && path.endsWith('.tmp')) {
    firstWrite = false;
    const err = new Error('EIO: i/o error, write');
    err.code = 'EIO';
    err.errno = -5;
    err.syscall = 'write';
    throw err;
  }
  return origWrite.call(this, path, data, options);
};

const LEDGER = process.argv[2];
const LOCK_PATH = LEDGER + '.lock';

function acquireLedgerLock(timeoutMs = 5000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'w');
      try {
        fsExt.flockSync(fd, 'exnb');
        return { fd, lockPath: LOCK_PATH };
      } catch (lockErr) {
        fs.closeSync(fd);
        if (lockErr.code === 'EAGAIN' || lockErr.code === 'EWOULDBLOCK') {
          const sleepMs = 50;
          const start = Date.now();
          while (Date.now() - start < sleepMs) {}
          continue;
        }
        throw lockErr;
      }
    } catch (e) {
      throw e;
    }
  }
  throw new Error(`Failed to acquire ledger flock after ${timeoutMs}ms`);
}

function releaseLedgerLock(lockObj) {
  try {
    try { fsExt.flockSync(lockObj.fd, 'un'); } catch {}
    fs.closeSync(lockObj.fd);
  } catch (e) {
    console.error('Ledger lock release error:', e.message);
  }
}

function readLedger() {
  return JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
}

function saveLedger(ledger) {
  fs.writeFileSync(LEDGER + '.tmp', JSON.stringify(ledger));
  fs.renameSync(LEDGER + '.tmp', LEDGER);
}

// Track FD opens
let fdOpens = 0;
let fdCloses = 0;
const origOpenSync = fs.openSync;
const origCloseSync = fs.closeSync;
fs.openSync = function(...args) {
  fdOpens++;
  return origOpenSync.apply(this, args);
};
fs.closeSync = function(...args) {
  fdCloses++;
  return origCloseSync.apply(this, args);
};

// Attempt budget reservation (will fail on saveLedger)
let ledgerLock = null;
let error = null;

try {
  ledgerLock = acquireLedgerLock();
  
  try {
    const currentLedger = readLedger();
    currentLedger.reservations = currentLedger.reservations || {};
    currentLedger.reservations['test-res'] = { amount: 250, pid: process.pid, at: Date.now() };
    saveLedger(currentLedger);  // ← This will throw EIO
  } finally {
    if (ledgerLock !== null) {
      releaseLedgerLock(ledgerLock);
      ledgerLock = null;
    }
  }
} catch (err) {
  error = err;
}

// Report results
console.log(JSON.stringify({
  pid: process.pid,
  errorCode: error?.code,
  errorMessage: error?.message,
  fdOpens,
  fdCloses,
  lockReleased: ledgerLock === null
}));
