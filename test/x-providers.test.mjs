import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createXProvider, OfficialProvider, SocialDataProvider, SorsaProvider, StubProvider } from '../src/x-providers.mjs';

test('createXProvider: returns StubProvider when no credentials', () => {
  const provider = createXProvider({
    xProvider: '',
    xBearerToken: '',
    socialDataApiKey: '',
    sorsaApiKey: ''
  });
  
  assert.ok(provider instanceof StubProvider);
  assert.strictEqual(provider.name, 'stub');
});

test('createXProvider: prefers SocialData when API key is set', () => {
  const provider = createXProvider({
    xProvider: '',
    xBearerToken: '',
    socialDataApiKey: 'test-key',
    socialDataBaseUrl: 'https://api.socialdata.tools',
    sorsaApiKey: ''
  });
  
  assert.ok(provider instanceof SocialDataProvider);
  assert.strictEqual(provider.name, 'socialdata');
});

test('createXProvider: uses official when only X_BEARER_TOKEN is set', () => {
  const provider = createXProvider({
    xProvider: '',
    xBearerToken: 'test-bearer',
    socialDataApiKey: '',
    sorsaApiKey: ''
  });
  
  assert.ok(provider instanceof OfficialProvider);
  assert.strictEqual(provider.name, 'official');
});

test('createXProvider: respects explicit X_PROVIDER=official', () => {
  const provider = createXProvider({
    xProvider: 'official',
    xBearerToken: 'test-bearer',
    socialDataApiKey: 'test-socialdata-key',
    sorsaApiKey: ''
  });
  
  assert.ok(provider instanceof OfficialProvider);
  assert.strictEqual(provider.name, 'official');
});

test('createXProvider: respects explicit X_PROVIDER=socialdata', () => {
  const provider = createXProvider({
    xProvider: 'socialdata',
    xBearerToken: 'test-bearer',
    socialDataApiKey: 'test-socialdata-key',
    sorsaApiKey: ''
  });
  
  assert.ok(provider instanceof SocialDataProvider);
  assert.strictEqual(provider.name, 'socialdata');
});

test('createXProvider: returns Sorsa when X_PROVIDER=sorsa', () => {
  const provider = createXProvider({
    xProvider: 'sorsa',
    xBearerToken: '',
    socialDataApiKey: '',
    sorsaApiKey: 'test-sorsa-key'
  });
  
  assert.ok(provider instanceof SorsaProvider);
  assert.strictEqual(provider.name, 'sorsa');
});

test('createXProvider: returns Stub when X_PROVIDER=stub', () => {
  const provider = createXProvider({
    xProvider: 'stub',
    xBearerToken: 'test-bearer',
    socialDataApiKey: 'test-key',
    sorsaApiKey: ''
  });
  
  assert.ok(provider instanceof StubProvider);
  assert.strictEqual(provider.name, 'stub');
});

test('StubProvider: always available and returns demo tweets', async () => {
  const provider = new StubProvider();
  
  assert.strictEqual(provider.isAvailable(), true);
  
  const result = await provider.fetchTimeline('testuser', { maxResults: 5 });
  
  assert.ok(result.tweets);
  assert.ok(result.tweets.length <= 5);
  assert.strictEqual(result.meta.provider, 'stub');
  assert.strictEqual(result.meta.isDryRun, true);
  
  // Check tweet structure
  const tweet = result.tweets[0];
  assert.ok(tweet.id);
  assert.ok(tweet.text);
  assert.ok(typeof tweet.createdAt === 'number');
  assert.strictEqual(tweet.authorId, 'testuser');
});

test('OfficialProvider: isAvailable only when bearer token set', () => {
  const withToken = new OfficialProvider('test-token');
  const withoutToken = new OfficialProvider('');
  
  assert.strictEqual(withToken.isAvailable(), true);
  assert.strictEqual(withoutToken.isAvailable(), false);
});

test('SocialDataProvider: isAvailable only when API key set', () => {
  const withKey = new SocialDataProvider('test-key');
  const withoutKey = new SocialDataProvider('');
  
  assert.strictEqual(withKey.isAvailable(), true);
  assert.strictEqual(withoutKey.isAvailable(), false);
});

test('SorsaProvider: isAvailable only when API key set', () => {
  const withKey = new SorsaProvider('test-key');
  const withoutKey = new SorsaProvider('');
  
  assert.strictEqual(withKey.isAvailable(), true);
  assert.strictEqual(withoutKey.isAvailable(), false);
});

test('SocialDataProvider: constructs correct URL and headers', async () => {
  let capturedRequest = null;
  
  // Mock fetch
  global.fetch = async (url, options) => {
    capturedRequest = { url, options };
    return {
      ok: true,
      json: async () => ({ tweets: [], data: [] })
    };
  };
  
  const provider = new SocialDataProvider('test-api-key', 'https://api.socialdata.tools');
  await provider.fetchTimeline('testuser', { maxResults: 10 });
  
  assert.ok(capturedRequest);
  assert.ok(capturedRequest.url.includes('api.socialdata.tools'));
  assert.ok(capturedRequest.url.includes('testuser'));
  assert.ok(capturedRequest.url.includes('limit=10'));
  assert.strictEqual(capturedRequest.options.headers.Authorization, 'Bearer test-api-key');
  assert.strictEqual(capturedRequest.options.headers.Accept, 'application/json');
  
  // Cleanup
  delete global.fetch;
});

test('SocialDataProvider: handles 404 gracefully', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 404
  });
  
  const provider = new SocialDataProvider('test-key');
  const result = await provider.fetchTimeline('nonexistent');
  
  assert.strictEqual(result.tweets.length, 0);
  assert.strictEqual(result.meta.error, 'not_found');
  
  delete global.fetch;
});

test('SocialDataProvider: adapts various response formats', async () => {
  const testCases = [
    {
      name: 'tweets array format',
      response: {
        tweets: [
          { id: '123', text: 'Test tweet', created_at: '2026-01-01T00:00:00Z', user_id: 'user1' }
        ]
      }
    },
    {
      name: 'data array format',
      response: {
        data: [
          { tweet_id: '456', full_text: 'Another tweet', created_at: 1704067200000, author_id: 'user2' }
        ]
      }
    }
  ];
  
  for (const testCase of testCases) {
    global.fetch = async () => ({
      ok: true,
      json: async () => testCase.response
    });
    
    const provider = new SocialDataProvider('test-key');
    const result = await provider.fetchTimeline('testuser');
    
    assert.strictEqual(result.tweets.length, 1, `Failed for: ${testCase.name}`);
    assert.ok(result.tweets[0].id, `Missing id for: ${testCase.name}`);
    assert.ok(result.tweets[0].text, `Missing text for: ${testCase.name}`);
    assert.ok(typeof result.tweets[0].createdAt === 'number', `Invalid createdAt for: ${testCase.name}`);
  }
  
  delete global.fetch;
});

test('SorsaProvider: returns not_implemented error', async () => {
  const provider = new SorsaProvider('test-key');
  const result = await provider.fetchTimeline('testuser');
  
  assert.strictEqual(result.tweets.length, 0);
  assert.strictEqual(result.meta.error, 'not_implemented');
  assert.strictEqual(result.meta.provider, 'sorsa');
});
