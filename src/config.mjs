import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export const config = Object.freeze({
  chain: 'sol',
  supportedChains: Object.freeze(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']),
  port: boundedInteger(process.env.RADAR_PORT, 3791, 1024, 65_535),
  scanIntervalMs: boundedInteger(process.env.SCAN_INTERVAL_MS, 120_000, 30_000, 30 * 60_000),
  maxDeepAuditsPerCycle: boundedInteger(process.env.MAX_DEEP_AUDITS_PER_CYCLE, 6, 1, 12),
  auditCycleBudgetMs: 80_000,
  outcomeReadsPerCycle: 4,
  xReviewMode: 'manual',
  minAgeSec: 5 * 60,
  maxAgeSec: 7 * 86400,
  discoveryMinMarketCap: 10_000,
  discoveryMaxMarketCap: 200_000,
  priorityMinMarketCap: 20_000,
  priorityMaxMarketCap: 80_000,
  minLiquidity: 3_000,
  strictLiquidity: 8_000,
  maxRugRatio: 0.20,
  maxTop10Rate: 0.30,
  maxInsiderRate: 0.15,
  maxBundlerRate: 0.15,
  maxSniperHoldRate: 0.08,
  maxBotHoldRate: 0.20,
  maxLinkedHoldRate: 0.10,
  maxBuyTax: 0.05,
  maxSellTax: 0.05,
  maxTaxAsymmetry: 0.02,
  minLpLockedRate: 0.80,
  minOrdinaryWallets: 8,
  dynamicRecheckMs: 2 * 60_000,
  chainPassRecheckMs: 5 * 60_000,
  hardRejectRecheckMs: 6 * 60 * 60_000,
  queueRetentionMs: 24 * 60 * 60_000,
  candidateRetentionMs: 2 * 60 * 60_000,
  staleCandidateMs: 10 * 60_000,
  outcomeRetentionMs: 7 * 24 * 60 * 60_000,
  stateDir: path.join(ROOT, 'state'),
  publicDir: path.join(ROOT, 'public'),
  configDir: path.join(ROOT, 'config'),
  embryonicMinMarketCap: 10_000,
  embryonicMaxMarketCap: 200_000,
  embryonicOptimalMinMarketCap: 30_000,
  embryonicOptimalMaxMarketCap: 150_000,
  embryonicHotThreshold: 70,
  embryonicWatchThreshold: 50,
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookMinTier: process.env.WEBHOOK_MIN_TIER || 'hot',
  webhookEnabled: Boolean(process.env.WEBHOOK_URL),
  webhookDedupeMs: 30 * 60_000,
  xWatchlistPath: path.join(ROOT, 'config', 'x-watchlist.json'),
  xBearerToken: process.env.X_BEARER_TOKEN || '',
  xPollIntervalMs: boundedInteger(process.env.X_POLL_INTERVAL_MS, 120_000, 60_000, 10 * 60_000),
  xMinFollowers: boundedInteger(process.env.X_MIN_FOLLOWERS, 10_000, 0, 10_000_000),
  xEnabled: Boolean(process.env.X_BEARER_TOKEN)
});
