import { config } from './config.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Provider interface for fetching X/Twitter timelines
 * Implementations: twitter-cli (Cookie session), official, socialdata, sorsa, stub
 */

function readStateSecret(stateDir, fileName) {
  try {
    const file = path.join(stateDir, fileName);
    if (!fs.existsSync(file)) return '';
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return '';
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

export function resolveTwitterCliCredentials(settings = {}) {
  const stateDir = settings.stateDir || '';
  // Explicit empty strings in settings win (tests / forced disable).
  // Undefined falls back to env, then state files.
  const auth = settings.twitterAuthToken !== undefined
    ? String(settings.twitterAuthToken || '').trim()
    : (
        (process.env.TWITTER_AUTH_TOKEN || '').trim() ||
        (stateDir ? readStateSecret(stateDir, 'twitter-auth-token') : '')
      );
  const ct0 = settings.twitterCt0 !== undefined
    ? String(settings.twitterCt0 || '').trim()
    : (
        (process.env.TWITTER_CT0 || '').trim() ||
        (stateDir ? readStateSecret(stateDir, 'twitter-ct0') : '')
      );
  return { authToken: auth, ct0 };
}

// Official Twitter API v2 Provider
class OfficialProvider {
  constructor(bearerToken) {
    this.bearerToken = bearerToken;
    this.name = 'official';
  }

  isAvailable() {
    return Boolean(this.bearerToken);
  }

  async fetchTimeline(handle, { maxResults = 10, sinceId = null } = {}) {
    if (!this.isAvailable()) {
      throw new Error('X_BEARER_TOKEN not configured for official provider');
    }

    const userLookupUrl = `https://api.twitter.com/2/users/by/username/${handle}`;
    const userRes = await fetch(userLookupUrl, {
      headers: { Authorization: `Bearer ${this.bearerToken}` }
    });

    if (!userRes.ok) {
      throw new Error(`Twitter API user lookup failed: ${userRes.status}`);
    }

    const userData = await userRes.json();
    const userId = userData.data?.id;

    if (!userId) {
      return { tweets: [], meta: { provider: this.name, handle } };
    }

    const params = new URLSearchParams({
      max_results: String(maxResults),
      'tweet.fields': 'created_at,author_id,text'
    });
    if (sinceId) params.set('since_id', sinceId);

    const timelineUrl = `https://api.twitter.com/2/users/${userId}/tweets?${params}`;
    const timelineRes = await fetch(timelineUrl, {
      headers: { Authorization: `Bearer ${this.bearerToken}` }
    });

    if (!timelineRes.ok) {
      throw new Error(`Twitter API timeline failed: ${timelineRes.status}`);
    }

    const timelineData = await timelineRes.json();
    const tweets = (timelineData.data || []).map(tweet => ({
      id: tweet.id,
      text: tweet.text,
      createdAt: new Date(tweet.created_at).getTime(),
      authorId: tweet.author_id
    }));

    return {
      tweets,
      meta: {
        provider: this.name,
        handle,
        resultCount: tweets.length
      }
    };
  }
}

// SocialData.tools Provider
class SocialDataProvider {
  constructor(apiKey, baseUrl = 'https://api.socialdata.tools') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.name = 'socialdata';
  }

  isAvailable() {
    return Boolean(this.apiKey);
  }

  async fetchTimeline(handle, { maxResults = 10, sinceId = null } = {}) {
    if (!this.isAvailable()) {
      throw new Error('SOCIALDATA_API_KEY not configured for socialdata provider');
    }

    const params = new URLSearchParams({
      limit: String(maxResults)
    });
    if (sinceId) params.set('since_id', sinceId);

    const url = `${this.baseUrl}/twitter/user/${handle}/tweets?${params}`;

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (!res.ok) {
      if (res.status === 404) {
        return { tweets: [], meta: { provider: this.name, handle, error: 'not_found' } };
      }
      throw new Error(`SocialData API failed: ${res.status}`);
    }

    const data = await res.json();
    const rawTweets = data.tweets || data.data || [];

    const tweets = rawTweets.map(tweet => ({
      id: String(tweet.id || tweet.tweet_id || tweet.id_str),
      text: tweet.text || tweet.full_text || '',
      createdAt: tweet.created_at
        ? (typeof tweet.created_at === 'number' ? tweet.created_at : new Date(tweet.created_at).getTime())
        : Date.now(),
      authorId: tweet.user_id || tweet.author_id || handle
    }));

    return {
      tweets,
      meta: {
        provider: this.name,
        handle,
        resultCount: tweets.length
      }
    };
  }
}

class SorsaProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'sorsa';
  }

  isAvailable() {
    return Boolean(this.apiKey);
  }

  async fetchTimeline(handle, { maxResults = 10, sinceId = null } = {}) {
    if (!this.isAvailable()) {
      throw new Error('SORSA_API_KEY not configured for sorsa provider');
    }

    console.warn(`Sorsa provider not yet implemented for ${handle}`);
    return {
      tweets: [],
      meta: {
        provider: this.name,
        handle,
        error: 'not_implemented'
      }
    };
  }
}

class StubProvider {
  constructor() {
    this.name = 'stub';
    this.callCount = 0;
  }

  isAvailable() {
    return true;
  }

  async fetchTimeline(handle, { maxResults = 10, sinceId = null } = {}) {
    this.callCount++;

    const demoTweets = [
      {
        id: `stub_${this.callCount}_1`,
        text: `Demo tweet from @${handle} - Check out this token: DemoTokenAddr123456789012345678901234`,
        createdAt: Date.now() - 60_000,
        authorId: handle
      },
      {
        id: `stub_${this.callCount}_2`,
        text: `Another demo tweet from @${handle} with cashtag $DEMO`,
        createdAt: Date.now() - 120_000,
        authorId: handle
      }
    ].slice(0, maxResults);

    return {
      tweets: demoTweets,
      meta: {
        provider: this.name,
        handle,
        resultCount: demoTweets.length,
        isDryRun: true
      }
    };
  }
}

// twitter-cli Provider (Cookie session). Read-only timeline fetch only.
class TwitterCliProvider {
  constructor({ authToken, ct0, bin = 'twitter' } = {}) {
    this.authToken = authToken || '';
    this.ct0 = ct0 || '';
    this.bin = bin || process.env.TWITTER_CLI_BIN || 'twitter';
    this.name = 'twitter-cli';
  }

  isAvailable() {
    return Boolean(this.authToken && this.ct0);
  }

  async fetchTimeline(handle, { maxResults = 10, sinceId = null } = {}) {
    if (!this.isAvailable()) {
      throw new Error('TWITTER_AUTH_TOKEN / TWITTER_CT0 not configured for twitter-cli provider');
    }

    const cleanHandle = String(handle || '').replace(/^@/, '').trim();
    if (!cleanHandle) {
      return { tweets: [], meta: { provider: this.name, handle, error: 'empty_handle' } };
    }

    const n = Math.max(1, Math.min(Number(maxResults) || 10, 40));
    const raw = await this.#runJson(['user-posts', cleanHandle, '-n', String(n), '--json']);
    const rows = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []);

    let tweets = rows.map((tweet) => {
      const id = String(tweet.id || tweet.id_str || '');
      const created = tweet.createdAtISO || tweet.created_at || tweet.createdAt || tweet.time || null;
      const createdAt = created ? Date.parse(created) : Date.now();
      return {
        id,
        text: tweet.text || tweet.full_text || '',
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        authorId: tweet.author?.id || tweet.author?.screenName || cleanHandle
      };
    }).filter((t) => t.id);

    if (sinceId) {
      const since = BigInt(String(sinceId));
      tweets = tweets.filter((t) => {
        try { return BigInt(t.id) > since; } catch { return true; }
      });
    }

    return {
      tweets,
      meta: {
        provider: this.name,
        handle: cleanHandle,
        resultCount: tweets.length
      }
    };
  }

  #runJson(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        env: {
          ...process.env,
          TWITTER_AUTH_TOKEN: this.authToken,
          TWITTER_CT0: this.ct0
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`twitter-cli exit ${code}: ${(stderr || stdout).slice(0, 300)}`));
          return;
        }
        const brace = stdout.indexOf('{');
        const bracket = stdout.indexOf('[');
        let start = -1;
        if (brace >= 0 && bracket >= 0) start = Math.min(brace, bracket);
        else start = brace >= 0 ? brace : bracket;
        if (start < 0) {
          reject(new Error(`twitter-cli returned no JSON: ${(stderr || stdout).slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.slice(start)));
        } catch (error) {
          reject(new Error(`twitter-cli JSON parse failed: ${error.message}`));
        }
      });
    });
  }
}

/**
 * Create appropriate provider based on configuration
 */
export function createXProvider(settings = config) {
  const providerType = (settings.xProvider || '').toLowerCase();
  const cliCreds = resolveTwitterCliCredentials(settings);

  if ((providerType === 'twitter-cli' || providerType === 'twittercli' || providerType === 'cookie') && cliCreds.authToken && cliCreds.ct0) {
    return new TwitterCliProvider(cliCreds);
  }

  if (providerType === 'official' && settings.xBearerToken) {
    return new OfficialProvider(settings.xBearerToken);
  }

  if (providerType === 'socialdata' && settings.socialDataApiKey) {
    return new SocialDataProvider(settings.socialDataApiKey, settings.socialDataBaseUrl);
  }

  if (providerType === 'sorsa' && settings.sorsaApiKey) {
    return new SorsaProvider(settings.sorsaApiKey);
  }

  if (providerType === 'stub') {
    return new StubProvider();
  }

  // Auto-detection: prefer Cookie CLI (no paid X API credits), then third-party, then official
  if (cliCreds.authToken && cliCreds.ct0) {
    return new TwitterCliProvider(cliCreds);
  }

  if (settings.socialDataApiKey) {
    return new SocialDataProvider(settings.socialDataApiKey, settings.socialDataBaseUrl);
  }

  if (settings.xBearerToken) {
    return new OfficialProvider(settings.xBearerToken);
  }

  if (settings.sorsaApiKey) {
    return new SorsaProvider(settings.sorsaApiKey);
  }

  return new StubProvider();
}

export { OfficialProvider, SocialDataProvider, SorsaProvider, StubProvider, TwitterCliProvider };
