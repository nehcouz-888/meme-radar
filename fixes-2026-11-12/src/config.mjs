import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}


function readOptionalStateFile(fileName) {
  try {
    const file = path.join(ROOT, 'state', fileName);
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

// 2026-09-26 upgrade flags: every new behaviour is switchable by env (default shown).
function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}
function envNumber(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

const twitterAuthToken = (process.env.TWITTER_AUTH_TOKEN || readOptionalStateFile('twitter-auth-token') || '').trim();
const twitterCt0 = (process.env.TWITTER_CT0 || readOptionalStateFile('twitter-ct0') || '').trim();
const twitterCliReady = Boolean(twitterAuthToken && twitterCt0);

export const config = Object.freeze({
  chain: 'sol',
  supportedChains: Object.freeze(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']),
  port: boundedInteger(process.env.RADAR_PORT, 3791, 1024, 65_535),
  scanIntervalMs: boundedInteger(process.env.SCAN_INTERVAL_MS, 120_000, 30_000, 30 * 60_000),
  maxDeepAuditsPerCycle: boundedInteger(process.env.MAX_DEEP_AUDITS_PER_CYCLE, 6, 1, 12),
  auditCycleBudgetMs: 80_000,
  outcomeReadsPerCycle: 4,
  // Smart-money retention (src/smart-retention.mjs): 'off' | 'shadow' (compute + report,
  // legacy aggregate boost) | 'score' (DEFAULT since 2026-09-26: only live still-holding smart
  // wallets add points; aggregate counts are display/penalty only). Revert: SMART_RETENTION_MODE=shadow.
  smartRetentionMode: ['off', 'shadow', 'score'].includes(process.env.SMART_RETENTION_MODE) ? process.env.SMART_RETENTION_MODE : 'score',
  xReviewMode: 'manual',
  // --- 2026-09-26 upgrades (revert any one with the env flag = 0) ---
  // SOL: GMGN is_open_source is always 0 for SPL tokens -> not required on sol; baseline is
  // mint + freeze authority renounced plus the existing honeypot/bundler/top-holder rules.
  solOpenSourceExempt: flag('SOL_OPENSOURCE_EXEMPT', true),
  // With the exemption, a sol token whose Jupiter audit could not be fetched waits (never auto-cleared).
  solExemptRequireJupiter: flag('SOL_EXEMPT_REQUIRE_JUPITER', true),
  // Extra discovery feeds: near-completion bonding curve, 1m trending (full scans; daemon has its own).
  discoveryExtraFeeds: flag('DISCOVERY_EXTRA_FEEDS', true),
  // "Late strong" watch tier: 1h/6h rankings above the discovery band up to lateTierMaxMarketCap.
  lateTierEnabled: flag('LATE_TIER', true),
  lateTierMaxMarketCap: envNumber('LATE_TIER_MAX_MCAP', 2_000_000, 200_000, 20_000_000),
  lateTierMaxAgeSec: envNumber('LATE_TIER_MAX_AGE_H', 72, 1, 168) * 3600,
  lateTierAlerts: flag('LATE_TIER_ALERTS', false),
  // Market-wide GMGN track smartmoney/kol + watchlist/Fomo/KOL-bridge wallets as a discovery source.
  smartFlowDiscovery: flag('SMART_FLOW_DISCOVERY', true),
  // Shared discovery queue written by the light daemon (scan-accum/discovery-daemon.mjs).
  discoveryQueueFeed: flag('DISCOVERY_QUEUE_FEED', true),
  discoveryQueueTtlMs: envNumber('DISCOVERY_QUEUE_TTL_MIN', 60, 5, 24 * 60) * 60_000,
  discoveryQueueMaxPerCycle: envNumber('DISCOVERY_QUEUE_MAX_PER_CYCLE', 60, 0, 500),
  // Momentum-ordered audit queue + rate-limit-failed audits retried first.
  queueMomentumPriority: flag('QUEUE_MOMENTUM', true),
  // V/L and FLOW (5m*12/1h volume) modest score terms.
  momentumScoring: flag('MOMENTUM_SCORING', true),
  // Jupiter Tokens API v2 (free lite endpoint) enrichment for sol.
  jupiterEnrich: flag('JUPITER_ENRICH', true),
  // Skip the per-token smart_degen traders read when there is no smart signal at all
  // (aggregate <=1 and no track/watchlist hits); cross-process cache for repeats.
  smartTradersAuto: flag('SMART_TRADERS_AUTO', true),
  smartTradersCacheMs: envNumber('SMART_TRADERS_CACHE_MIN', 8, 0, 60) * 60_000,
  // 2026-09-29 bundler penalty (embryonicScore). 'heavy' (DEFAULT): graded score penalty by GMGN bundler
  // supply share + heavy/severe bundler capped below hot unless >=BUNDLER_HOT_CAP_MIN_SMART still-holding
  // smart wallets. 'legacy': old behaviour (no score penalty; only the deepScreen >15% hard-reject rule).
  bundlerPenaltyMode: ['heavy', 'legacy'].includes(String(process.env.BUNDLER_PENALTY_MODE || '').trim().toLowerCase())
    ? String(process.env.BUNDLER_PENALTY_MODE).trim().toLowerCase() : 'heavy',
  bundlerHotCap: flag('BUNDLER_HOT_CAP', true),
  bundlerHotCapMinSmart: envNumber('BUNDLER_HOT_CAP_MIN_SMART', 2, 1, 50),
  bundlerPenaltyScale: envNumber('BUNDLER_PENALTY_SCALE', 1, 0, 3),
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
  // X/Twitter monitoring
  xWatchlistPath: path.join(ROOT, 'config', 'x-watchlist.json'),
  xTriggerKeywordsPath: path.join(ROOT, 'config', 'x-trigger-keywords.json'),
  xBearerToken: process.env.X_BEARER_TOKEN || '',
  xProvider: process.env.X_PROVIDER || (twitterCliReady ? 'twitter-cli' : ''), // twitter-cli | official | socialdata | sorsa | stub
  xPollIntervalMs: boundedInteger(
    process.env.X_POLL_INTERVAL_MS,
    // Default: 3-5 minutes for cheap providers (Ai Boom architecture), 2 minutes for official
    process.env.SOCIALDATA_API_KEY || process.env.SORSA_API_KEY ? 240_000 : 120_000,
    60_000,
    30 * 60_000
  ),
  xMinFollowers: boundedInteger(process.env.X_MIN_FOLLOWERS, 10_000, 0, 10_000_000),
  xCompetitionWindowHours: boundedInteger(process.env.X_COMPETITION_WINDOW_HOURS, 6, 1, 24),
  xCompetitionThreshold: boundedInteger(process.env.X_COMPETITION_THRESHOLD, 60, 0, 100),
  xSoftMentionTiers: (process.env.X_SOFT_MENTION_TIERS || 'official,founder,chain_lead').split(',').map(s => s.trim()),
  xEnabled: Boolean(twitterCliReady || process.env.X_BEARER_TOKEN || process.env.SOCIALDATA_API_KEY || process.env.SORSA_API_KEY),
  
  twitterAuthToken,
  twitterCt0,
  // Third-party X providers
  socialDataApiKey: process.env.SOCIALDATA_API_KEY || '',
  socialDataBaseUrl: process.env.SOCIALDATA_BASE_URL || 'https://api.socialdata.tools',
  sorsaApiKey: process.env.SORSA_API_KEY || ''
});
