#!/usr/bin/env node
/**
 * 简单锁测试：验证atomic mkdir基本功能
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QUEUE_MODULE = path.join(__dirname, '../src/modules/alert-queue.mjs');

console.log('=== Simple Lock Test ===\n');

async function testBasicLock() {
  console.log('--- Test: Basic Lock Acquire/Release ---');
  
  const TEMP_DIR = '/tmp/simple-lock-test';
  const QUEUE_FILE = path.join(TEMP_DIR, 'test.jsonl');
  
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  
  // Empty file for jsonlines
  fs.writeFileSync(QUEUE_FILE, '');
  
  // Test script
  const testScript = `
    import { addPendingAlert } from '${QUEUE_MODULE}';
    
    const QUEUE_FILE = '${QUEUE_FILE}';
    
    try {
      const event = { eventId: 'test1', data: {} };
      const added = addPendingAlert(QUEUE_FILE, event);
      console.log('SUCCESS:', added);
    } catch (err) {
      console.error('ERROR:', err.message);
    }
  `;
  
  const testPath = path.join(TEMP_DIR, 'test.mjs');
  fs.writeFileSync(testPath, testScript);
  
  const proc = spawn('node', [testPath], { stdio: 'inherit' });
  
  await new Promise((resolve) => {
    proc.on('close', resolve);
  });
  
  // Check queue (jsonlines format)
  const content = fs.readFileSync(QUEUE_FILE, 'utf8');
  const lines = content.trim().split('\n').filter(l => l.length > 0);
  const events = lines.map(l => JSON.parse(l));
  console.log(`\nEvents in queue: ${events.length}`);
  
  // Check locks
  const lockDirs = fs.readdirSync(TEMP_DIR).filter(f => f.includes('.lock'));
  console.log(`Leftover locks: ${lockDirs.length}`);
  
  if (events.length !== 1) {
    console.error(`❌ Expected 1 event, got ${events.length}`);
    return false;
  }
  
  if (lockDirs.length > 0) {
    console.error(`❌ Lock not released: ${lockDirs.join(', ')}`);
    return false;
  }
  
  console.log('✅ Basic lock test PASSED\n');
  return true;
}

async function testTwoSequential() {
  console.log('--- Test: Two Sequential Writes ---');
  
  const TEMP_DIR = '/tmp/simple-lock-seq';
  const QUEUE_FILE = path.join(TEMP_DIR, 'test.jsonl');
  
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  
  fs.writeFileSync(QUEUE_FILE, '');
  
  const testScript = `
    import { addPendingAlert } from '${QUEUE_MODULE}';
    
    const QUEUE_FILE = '${QUEUE_FILE}';
    const ID = process.env.ID;
    
    const event = { eventId: \`event_\${ID}\`, data: {} };
    const added = addPendingAlert(QUEUE_FILE, event);
    console.log(\`ID \${ID}: \${added}\`);
  `;
  
  const testPath = path.join(TEMP_DIR, 'test.mjs');
  fs.writeFileSync(testPath, testScript);
  
  // Run sequentially
  for (let i = 0; i < 2; i++) {
    const proc = spawn('node', [testPath], {
      env: { ...process.env, ID: String(i) },
      stdio: 'inherit'
    });
    await new Promise((resolve) => {
      proc.on('close', resolve);
    });
  }
  
  const content = fs.readFileSync(QUEUE_FILE, 'utf8');
  const lines = content.trim().split('\n').filter(l => l.length > 0);
  const events = lines.map(l => JSON.parse(l));
  console.log(`\nEvents: ${events.length}`);
  
  if (events.length !== 2) {
    console.error(`❌ Expected 2 events, got ${events.length}`);
    return false;
  }
  
  console.log('✅ Sequential writes test PASSED\n');
  return true;
}

// Run
async function main() {
  const results = [];
  
  try {
    results.push(await testBasicLock());
  } catch (err) {
    console.error(`❌ Basic test failed: ${err.message}`);
    results.push(false);
  }
  
  try {
    results.push(await testTwoSequential());
  } catch (err) {
    console.error(`❌ Sequential test failed: ${err.message}`);
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
