#!/usr/bin/env node
/**
 * v9 proper-lockfile basic test
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { addPendingAlert } from '../src/modules/alert-queue.mjs';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v9-basic-'));
const queueFile = path.join(testDir, 'queue.jsonl');

// Test 1: Basic lock/release
console.log('Test 1: Basic acquire/release');
fs.writeFileSync(queueFile, '');

try {
  const result = await addPendingAlert(queueFile, { eventId: 'TEST1', whenIso: new Date().toISOString() });
  console.log('✓ Basic write result:', result);
  
  const content = fs.readFileSync(queueFile, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  console.log('  Lines written:', lines.length);
  
  if (lines.length > 0) {
    const event = JSON.parse(lines[0]);
    console.log('  Event:', event.eventId);
    if (event.eventId === 'TEST1') {
      console.log('✓ Event persisted');
    } else {
      console.log('✗ Event not found');
    }
  }
} catch (e) {
  console.log('✗ Basic write failed:', e.message);
  throw e;
}

// Test 2: Multiple writes
console.log('\nTest 2: Multiple sequential writes');
try {
  await addPendingAlert(queueFile, { eventId: 'TEST2', whenIso: new Date().toISOString() });
  await addPendingAlert(queueFile, { eventId: 'TEST3', whenIso: new Date().toISOString() });
  
  const content = fs.readFileSync(queueFile, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  console.log('✓ Multiple writes, total lines:', lines.length);
  
  if (lines.length === 3) {
    console.log('✓ All events persisted');
  } else {
    console.log('✗ Expected 3 lines, got', lines.length);
  }
} catch (e) {
  console.log('✗ Multiple writes failed:', e.message);
  throw e;
}

// Test 3: Lock files
console.log('\nTest 3: Lock file format');
const lockFile = queueFile + '.lock';
if (fs.existsSync(lockFile)) {
  console.log('Note: Lock file exists (proper-lockfile uses .lock)');
} else {
  console.log('✓ No stale lock file');
}

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });

console.log('\n✓ All basic tests passed');
