#!/usr/bin/env node
/**
 * Watchlist Path Migration Script
 * Migrate from old path to new path and update consumers
 * 
 * Old: scan-accum/narrative-early/state/watchlist.json
 * New: branch/state/exit-watchlist.json
 */
import fs from 'node:fs';
import path from 'node:path';

const OLD_BASE = '/workspace/meme-radar-run/scan-accum/narrative-early';
const NEW_BASE = '/workspace/meme-radar-run/meme-radar-branch';

const OLD_WATCHLIST = path.join(OLD_BASE, 'state/watchlist.json');
const NEW_WATCHLIST = path.join(NEW_BASE, 'state/exit-watchlist.json');
const OLD_SCAN_OUTPUT = '/workspace/ebooks/out/fullchain-scan-results.json';
const NEW_SCAN_DIR = path.join(OLD_BASE, '../fomo-free');

console.log('Watchlist Path Migration');
console.log('========================');
console.log('');

// 1. Check if old watchlist exists
if (fs.existsSync(OLD_WATCHLIST)) {
  console.log(`✅ Found old watchlist: ${OLD_WATCHLIST}`);
  
  try {
    const oldData = JSON.parse(fs.readFileSync(OLD_WATCHLIST, 'utf8'));
    console.log(`   Items: ${(oldData.items || []).length}`);
    
    // Check if new watchlist exists
    let needMigration = true;
    if (fs.existsSync(NEW_WATCHLIST)) {
      const newData = JSON.parse(fs.readFileSync(NEW_WATCHLIST, 'utf8'));
      console.log(`⚠️  New watchlist already exists: ${NEW_WATCHLIST}`);
      console.log(`   Items: ${(newData.items || []).length}`);
      
      // Ask for confirmation (in real use, would prompt)
      console.log('   Skipping migration to avoid overwrite');
      console.log('   To force migration, delete new watchlist first');
      needMigration = false;
    }
    
    if (needMigration) {
      // Ensure target directory
      fs.mkdirSync(path.dirname(NEW_WATCHLIST), { recursive: true });
      
      // Migrate with version update
      const migratedData = {
        ...oldData,
        version: 3,
        migratedFrom: OLD_WATCHLIST,
        migratedAt: new Date().toISOString()
      };
      
      fs.writeFileSync(NEW_WATCHLIST, JSON.stringify(migratedData, null, 2));
      console.log(`✅ Migrated to: ${NEW_WATCHLIST}`);
    }
  } catch (error) {
    console.error(`❌ Migration failed: ${error.message}`);
  }
} else {
  console.log(`ℹ️  Old watchlist not found: ${OLD_WATCHLIST}`);
  console.log('   No migration needed');
}

console.log('');

// 2. Check scan output format
if (fs.existsSync(OLD_SCAN_OUTPUT)) {
  console.log(`✅ Found old scan output: ${OLD_SCAN_OUTPUT}`);
  try {
    const scanData = JSON.parse(fs.readFileSync(OLD_SCAN_OUTPUT, 'utf8'));
    console.log(`   Results: ${(scanData.results || []).length}`);
    console.log(`   Format: fullchain-scan-results.json`);
  } catch (error) {
    console.error(`❌ Failed to read old scan output: ${error.message}`);
  }
} else {
  console.log(`ℹ️  Old scan output not found: ${OLD_SCAN_OUTPUT}`);
}

// Check new scan format
const newScanFiles = fs.existsSync(NEW_SCAN_DIR) 
  ? fs.readdirSync(NEW_SCAN_DIR).filter(f => f.startsWith('scan-') && f.endsWith('.json'))
  : [];

if (newScanFiles.length > 0) {
  console.log(`✅ Found new scan format: ${NEW_SCAN_DIR}/scan-*.json`);
  console.log(`   Files: ${newScanFiles.length}`);
  
  const latest = newScanFiles.sort().reverse()[0];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(NEW_SCAN_DIR, latest), 'utf8'));
    console.log(`   Latest: ${latest}`);
    console.log(`   Candidates: ${(data.candidates || []).length}`);
  } catch (error) {
    console.error(`❌ Failed to read new scan: ${error.message}`);
  }
} else {
  console.log(`ℹ️  No new scan files found in: ${NEW_SCAN_DIR}`);
}

console.log('');
console.log('Migration check complete');
console.log('');
console.log('Next steps:');
console.log('1. Update consumers to read from new watchlist path');
console.log('2. Update exit-runner to use new scan format');
console.log('3. Test end-to-end flow');
