#!/usr/bin/env node
/**
 * Fomo-Free Scan Integration with Exit Watchlist Registration
 * 
 * This is a production deployment adapter that:
 * 1. Scans for top tokens (existing fomo-free logic would go here)
 * 2. Registers discovered candidates to exit watchlist (chain:CA)
 * 3. Saves scan results for exit-runner to consume
 * 
 * Deployment path: /workspace/meme-radar-run/scan-accum/fomo-free/fomo-free-scan.mjs
 * Watchlist path: /workspace/meme-radar-run/meme-radar-branch/state/exit-watchlist.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Production paths
const REPO_ROOT = path.resolve(__dirname, '../../../meme-radar-branch');
const MODULES_ROOT = path.join(REPO_ROOT, 'src/modules');
const STATE_DIR = path.join(REPO_ROOT, 'state');
const SCAN_RESULTS_DIR = __dirname;

// Dynamically import exit-runner module
const exitRunnerPath = path.join(MODULES_ROOT, 'exit-runner-production.mjs');
let exitRunner;

try {
  exitRunner = await import(exitRunnerPath);
} catch (error) {
  console.error(`Failed to load exit-runner from ${exitRunnerPath}:`, error.message);
  console.error('Falling back to repo-relative path for development...');
  
  // Fallback to repo-relative path for development/testing
  const fallbackPath = new URL('../../../src/modules/exit-runner-production.mjs', import.meta.url).pathname;
  exitRunner = await import(fallbackPath);
}

const log = (...args) => console.error(`[fomo_free_scan ${new Date().toISOString()}]`, ...args);

/**
 * Mock scan function - in real production this would:
 * - Load Fomo API key
 * - Call Fomo discovery endpoints
 * - Apply filters (market cap, liquidity, holder quality)
 * - Score and rank candidates
 * 
 * For now, returns empty to demonstrate integration
 */
async function scanForTopTokens() {
  log('Scanning for top tokens...');
  
  // In production, this would call real Fomo API
  // For now, return empty or load from offline samples
  
  return {
    scannedAt: new Date().toISOString(),
    source: 'fomo_free',
    candidates: []  // Real implementation would populate this
  };
}

/**
 * Register scan results to exit watchlist
 */
function registerToExitWatchlist(scanResults) {
  const watchlistFile = path.join(STATE_DIR, 'exit-watchlist.json');
  
  // Ensure state directory exists
  fs.mkdirSync(STATE_DIR, { recursive: true });
  
  // Load current watchlist
  const watchlist = exitRunner.loadWatchlist(watchlistFile);
  
  // Register candidates
  const result = exitRunner.registerFromScanResults(scanResults, watchlist, 'fomo_free');
  
  // Save updated watchlist
  exitRunner.saveWatchlist(watchlistFile, result.watchlist);
  
  log(`Registered ${result.registered.length} new tokens to exit watchlist`);
  for (const entry of result.registered) {
    log(`  - ${entry.chain}:${entry.symbol} (${entry.address.slice(0, 8)}...)`);
  }
  
  return result;
}

/**
 * Save scan results for exit-runner consumption
 */
function saveScanResults(scanResults) {
  const filename = `scan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filepath = path.join(SCAN_RESULTS_DIR, filename);
  
  fs.writeFileSync(filepath, JSON.stringify(scanResults, null, 2));
  log(`Saved scan results: ${filepath}`);
  
  // Clean up old scan results (keep last 10)
  try {
    const files = fs.readdirSync(SCAN_RESULTS_DIR)
      .filter(f => f.startsWith('scan-') && f.endsWith('.json'))
      .sort()
      .reverse();
    
    for (const file of files.slice(10)) {
      fs.unlinkSync(path.join(SCAN_RESULTS_DIR, file));
      log(`Cleaned up old scan result: ${file}`);
    }
  } catch (error) {
    log('Failed to clean up old scan results:', error.message);
  }
}

/**
 * Main execution
 */
async function main() {
  log('=== Fomo-Free Scan Start ===');
  log('Config:', {
    repoRoot: REPO_ROOT,
    stateDir: STATE_DIR,
    scanResultsDir: SCAN_RESULTS_DIR,
    exitRunnerLoaded: !!exitRunner
  });
  
  try {
    // 1. Scan for top tokens
    const scanResults = await scanForTopTokens();
    log(`Scan complete: ${scanResults.candidates.length} candidates`);
    
    // 2. Register to exit watchlist
    if (scanResults.candidates.length > 0) {
      const registerResult = registerToExitWatchlist(scanResults);
      log(`Watchlist updated: ${registerResult.total} total tokens`);
    } else {
      log('No candidates to register');
    }
    
    // 3. Save scan results for exit-runner
    saveScanResults(scanResults);
    
    log('=== Fomo-Free Scan Complete ===');
  } catch (error) {
    log('Fatal error:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

export { scanForTopTokens, registerToExitWatchlist, saveScanResults };
