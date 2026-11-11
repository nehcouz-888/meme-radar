import { config } from './config.mjs';

/**
 * Provider interface for fetching X/Twitter timelines
 * Implementations: official (Twitter API v2), socialdata (SocialData.tools), sorsa (stub), stub (dry-run)
 */

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

    // Twitter API v2: GET /2/tweets/search/recent or user timeline
    // For simplicity, using user timeline by handle
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

    // Fetch user tweets
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
// API docs: https://api.socialdata.tools/docs (User Tweets endpoint)
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

    // SocialData API: GET /twitter/user/{username}/tweets
    // Best-effort implementation based on typical REST API patterns
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
      // Don't throw on 404 - account may not exist or no tweets
      if (res.status === 404) {
        return { tweets: [], meta: { provider: this.name, handle, error: 'not_found' } };
      }
      throw new Error(`SocialData API failed: ${res.status}`);
    }

    const data = await res.json();
    
    // Adapt SocialData response to our format
    // Expected shape: { tweets: [...], meta: {...} } or { data: [...] }
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

// Sorsa Provider (stub for future implementation)
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

    // TODO: Implement when Sorsa API is available
    // For now, return empty to avoid breaking monitoring
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

// Stub Provider (dry-run/demo mode)
class StubProvider {
  constructor() {
    this.name = 'stub';
    this.callCount = 0;
  }

  isAvailable() {
    return true; // Always available as fallback
  }

  async fetchTimeline(handle, { maxResults = 10, sinceId = null } = {}) {
    this.callCount++;
    
    // Return demo tweets for testing
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

/**
 * Create appropriate provider based on configuration
 */
export function createXProvider(settings = config) {
  // Explicit provider selection
  const providerType = (settings.xProvider || '').toLowerCase();
  
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
  
  // Auto-detection when no explicit provider set
  if (settings.socialDataApiKey) {
    return new SocialDataProvider(settings.socialDataApiKey, settings.socialDataBaseUrl);
  }
  
  if (settings.xBearerToken) {
    return new OfficialProvider(settings.xBearerToken);
  }
  
  if (settings.sorsaApiKey) {
    return new SorsaProvider(settings.sorsaApiKey);
  }
  
  // Fallback to stub
  return new StubProvider();
}

export { OfficialProvider, SocialDataProvider, SorsaProvider, StubProvider };
