import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { detectChainCompetition } from './chain-competition.mjs';
import { createXProvider } from './x-providers.mjs';

const SOLANA_ADDRESS_PATTERN = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;
const EVM_ADDRESS_PATTERN = /\b(0x[a-fA-F0-9]{40})\b/g;
const CASHTAG_PATTERN = /\$([A-Z][A-Z0-9]{1,10})\b/g;

function normalizeHandle(value) {
  const handle = String(value || '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : '';
}

/**
 * Load trigger keywords for soft mention detection
 */
export async function loadTriggerKeywords(path = config.xTriggerKeywordsPath) {
  try {
    const content = await fs.readFile(path, 'utf8');
    const data = JSON.parse(content);
    
    // Flatten global keywords into searchable array
    const globalKeywords = [];
    if (data.globalKeywords) {
      for (const category of Object.values(data.globalKeywords)) {
        if (Array.isArray(category.examples)) {
          globalKeywords.push(...category.examples);
        }
        if (Array.isArray(category.cn)) {
          globalKeywords.push(...category.cn);
        }
        if (Array.isArray(category.en)) {
          globalKeywords.push(...category.en);
        }
      }
    }
    
    return {
      globalKeywords: globalKeywords.map(k => String(k).toLowerCase()),
      accountSpecific: data.accountSpecificKeywords || {},
      softMentionTiers: data.softMentionTiers || ['official', 'founder', 'chain_lead'],
      alwaysAlertTiers: data.alwaysAlertTiers?.tiers || ['official', 'founder'],
      minTweetLength: data.alwaysAlertTiers?.minTweetLength || 20
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn('Trigger keywords file not found, using empty defaults');
      return {
        globalKeywords: [],
        accountSpecific: {},
        softMentionTiers: ['official', 'founder', 'chain_lead'],
        alwaysAlertTiers: ['official', 'founder'],
        minTweetLength: 20
      };
    }
    throw error;
  }
}

/**
 * Check if tweet text matches trigger keywords
 */
export function matchesTriggerKeywords(text, account, triggerKeywords) {
  if (!text || !triggerKeywords) return { matched: false, keywords: [] };
  
  const lowerText = text.toLowerCase();
  const matchedKeywords = [];
  
  // Check global keywords
  for (const keyword of triggerKeywords.globalKeywords || []) {
    if (lowerText.includes(keyword.toLowerCase())) {
      matchedKeywords.push(keyword);
    }
  }
  
  // Check account-specific keywords
  const accountConfig = triggerKeywords.accountSpecific?.[account.handle];
  if (accountConfig?.enabled && accountConfig.keywords) {
    for (const keyword of accountConfig.keywords) {
      if (lowerText.includes(keyword.toLowerCase()) && !matchedKeywords.includes(keyword)) {
        matchedKeywords.push(keyword);
      }
    }
  }
  
  return {
    matched: matchedKeywords.length > 0,
    keywords: matchedKeywords
  };
}

export async function loadWatchlist(path = config.xWatchlistPath, minFollowers = config.xMinFollowers) {
  try {
    const content = await fs.readFile(path, 'utf8');
    const data = JSON.parse(content);
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    return accounts
      .filter(account => {
        if (!account || !account.enabled || !normalizeHandle(account.handle)) return false;
        
        // Official, founder, and chain_lead accounts exempt from follower requirement
        const tier = String(account.tier || '').toLowerCase();
        if (['official', 'founder', 'chain_lead'].includes(tier)) return true;
        
        // Other tiers (kol_alpha, community, meme_whale) must meet follower threshold
        const followerCount = typeof account.followerCount === 'number' ? account.followerCount : null;
        if (followerCount === null) return false; // Require explicit follower count for non-exempt tiers
        
        return followerCount >= minFollowers;
      })
      .map(account => ({
        handle: normalizeHandle(account.handle),
        displayName: String(account.displayName || account.handle).slice(0, 80),
        category: String(account.category || 'unknown').slice(0, 32),
        tier: String(account.tier || 'kol_alpha').slice(0, 32),
        chainAffinity: account.chainAffinity || null,
        followerCount: typeof account.followerCount === 'number' ? account.followerCount : null,
        notes: String(account.notes || '').slice(0, 200)
      }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function extractContractAddresses(text) {
  const solanaAddresses = [...(text.matchAll(SOLANA_ADDRESS_PATTERN) || [])].map(m => m[1]).filter(addr => addr.length >= 32 && addr.length <= 44);
  const evmAddresses = [...(text.matchAll(EVM_ADDRESS_PATTERN) || [])].map(m => m[1].toLowerCase());
  const uniqueSolana = [...new Set(solanaAddresses)];
  const uniqueEvm = [...new Set(evmAddresses)];
  return { solana: uniqueSolana, evm: uniqueEvm, all: [...uniqueSolana, ...uniqueEvm] };
}

export function extractCashtags(text) {
  return [...new Set([...(text.matchAll(CASHTAG_PATTERN) || [])].map(m => m[1].toUpperCase()))];
}

export function inferChain(address) {
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'sol';
  if (/^0x[a-fA-F0-9]{40}$/i.test(address)) return 'evm';
  return null;
}

export class XMonitor {
  constructor({ settings = config, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    this.settings = settings;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.provider = null; // Will be set in init()
    this.triggerKeywords = null; // Will be set in init()
    this.watchlist = [];
    this.seenTweets = new Map();
    this.seenMints = new Map();
    this.lastPollAt = 0;
    this.nextPollAt = 0;
    this.running = false;
    this.stopped = false;
    this.timer = null;
    this.hits = [];
    this.pollCount = 0;
    this.mode = 'pending'; // Will be set in init()
  }

  async init() {
    this.watchlist = await loadWatchlist(this.settings.xWatchlistPath, this.settings.xMinFollowers);
    this.triggerKeywords = await loadTriggerKeywords(this.settings.xTriggerKeywordsPath);
    this.provider = createXProvider(this.settings);
    this.mode = this.provider.name;
    return this;
  }

  isDryRun() {
    return this.mode === 'stub';
  }

  async fetchTimeline(handle) {
    if (this.isDryRun()) {
      return {
        data: [],
        meta: { result_count: 0 },
        mode: 'stub',
        message: 'Dry-run mode: set X_BEARER_TOKEN environment variable to enable live Twitter API'
      };
    }

    const url = `https://api.twitter.com/2/users/by/username/${handle}`;
    const userResponse = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.settings.xBearerToken}`,
        'User-Agent': 'meme-radar-jindou/0.1.6'
      }
    });

    if (!userResponse.ok) {
      const error = new Error(`Twitter API user lookup failed: ${userResponse.status}`);
      error.code = 'X_API_ERROR';
      error.status = userResponse.status;
      throw error;
    }

    const userData = await userResponse.json();
    const userId = userData.data?.id;
    if (!userId) {
      const error = new Error(`User ${handle} not found`);
      error.code = 'X_USER_NOT_FOUND';
      throw error;
    }

    const timelineUrl = `https://api.twitter.com/2/users/${userId}/tweets?max_results=10&tweet.fields=created_at,text,entities`;
    const timelineResponse = await fetch(timelineUrl, {
      headers: {
        'Authorization': `Bearer ${this.settings.xBearerToken}`,
        'User-Agent': 'meme-radar-jindou/0.1.6'
      }
    });

    if (!timelineResponse.ok) {
      const error = new Error(`Twitter API timeline failed: ${timelineResponse.status}`);
      error.code = 'X_API_ERROR';
      error.status = timelineResponse.status;
      throw error;
    }

    const timelineData = await timelineResponse.json();
    return {
      data: timelineData.data || [],
      meta: timelineData.meta || { result_count: 0 },
      mode: 'api'
    };
  }

  processTweet(tweet, account) {
    const tweetId = String(tweet.id);
    const text = String(tweet.text || '');
    const createdAt = tweet.created_at ? new Date(tweet.created_at).getTime() : this.now();

    if (this.seenTweets.has(tweetId)) return null;

    const addresses = extractContractAddresses(text);
    const cashtags = extractCashtags(text);
    const tweetUrl = `https://twitter.com/${account.handle}/status/${tweetId}`;
    const hasAddresses = addresses.all.length > 0;
    
    // Check for soft mentions (keywords or high-tier account without CA)
    const keywordMatch = matchesTriggerKeywords(text, account, this.triggerKeywords);
    const isAlwaysAlertTier = this.triggerKeywords?.alwaysAlertTiers?.includes(account.tier);
    const meetsMinLength = text.length >= (this.triggerKeywords?.minTweetLength || 20);
    
    const isSoftMention = !hasAddresses && (
      keywordMatch.matched || 
      (isAlwaysAlertTier && meetsMinLength)
    );

    const hit = {
      tweetId,
      handle: account.handle,
      displayName: account.displayName,
      tier: account.tier,
      category: account.category,
      text: text.slice(0, 500),
      url: tweetUrl,
      createdAt,
      discoveredAt: this.now(),
      addresses,
      cashtags,
      hasAddresses,
      isSoftMention,
      matchedKeywords: keywordMatch.keywords || [],
      softMentionReason: isSoftMention 
        ? (keywordMatch.matched ? 'keyword_match' : 'high_tier_post')
        : null
    };

    this.seenTweets.set(tweetId, { at: this.now(), hit });
    return hit;
  }

  shouldEnqueueAddress(address, handle) {
    const key = `${address}:${handle}`;
    const seen = this.seenMints.get(key);
    if (seen && this.now() - seen.at < this.settings.webhookDedupeMs) return false;
    this.seenMints.set(key, { at: this.now(), address, handle });
    return true;
  }

  cleanupDedupe() {
    const cutoff = this.now() - this.settings.webhookDedupeMs;
    for (const [key, value] of this.seenTweets.entries()) {
      if (value.at < cutoff) this.seenTweets.delete(key);
    }
    for (const [key, value] of this.seenMints.entries()) {
      if (value.at < cutoff) this.seenMints.delete(key);
    }
  }

  async poll() {
    if (this.running || this.stopped) return;
    this.running = true;
    const at = this.now();
    this.lastPollAt = at;
    this.pollCount += 1;

    try {
      const newHits = [];
      for (const account of this.watchlist) {
        try {
          const result = await this.fetchTimeline(account.handle);
          const tweets = result.data || [];

          for (const tweet of tweets) {
            const hit = this.processTweet(tweet, account);
            if (hit) newHits.push(hit);
          }
        } catch (error) {
          console.error(`X monitor error for @${account.handle}:`, error.message);
        }
      }

      this.hits = [...newHits, ...this.hits].slice(0, 200);
      this.cleanupDedupe();

      return {
        success: true,
        newHits: newHits.length,
        totalHits: this.hits.length,
        mode: this.mode,
        watchlistSize: this.watchlist.length,
        polledAt: at
      };
    } catch (error) {
      console.error('X monitor poll error:', error);
      return {
        success: false,
        error: error.message,
        mode: this.mode
      };
    } finally {
      this.running = false;
      this.nextPollAt = this.now() + this.settings.xPollIntervalMs;
    }
  }

  snapshot() {
    const competition = detectChainCompetition(
      this.hits,
      this.watchlist,
      this.settings.xCompetitionWindowHours,
      this.now()
    );
    
    return {
      mode: this.mode,
      provider: this.provider?.name || 'none',
      enabled: !this.stopped,
      watchlistSize: this.watchlist.length,
      watchlist: this.watchlist.map(a => ({ 
        handle: a.handle, 
        displayName: a.displayName, 
        tier: a.tier, 
        category: a.category,
        chainAffinity: a.chainAffinity,
        followerCount: a.followerCount
      })),
      hits: this.hits.slice(0, 50),
      pollCount: this.pollCount,
      lastPollAt: this.lastPollAt,
      nextPollAt: this.nextPollAt,
      seenTweets: this.seenTweets.size,
      seenMints: this.seenMints.size,
      dryRun: this.isDryRun(),
      status: this.isDryRun() ? 'DRY_RUN' : 'READY',
      competition
    };
  }

  async start() {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      const started = this.now();

      if (!this.running && this.now() >= this.nextPollAt) {
        await this.poll();
      }

      if (!this.stopped) {
        const wait = Math.max(5000, this.nextPollAt - this.now());
        this.timer = this.schedule(() => { void tick(); }, wait);
        this.timer?.unref?.();
      }
    };
    await tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
  }
}
