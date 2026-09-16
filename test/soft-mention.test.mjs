import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTriggerKeywords, matchesTriggerKeywords } from '../src/x-monitor.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('loadTriggerKeywords: loads and parses keyword config', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-keywords-test-'));
  const keywordsPath = path.join(tempDir, 'keywords.json');
  
  const testConfig = {
    globalKeywords: {
      animals: { examples: ['dog', 'cat'] },
      food: { examples: ['broccoli'] }
    },
    accountSpecificKeywords: {
      'test_user': {
        enabled: true,
        keywords: ['blockchain', 'crypto']
      }
    },
    softMentionTiers: ['official', 'founder'],
    alwaysAlertTiers: { tiers: ['official'], minTweetLength: 20 }
  };
  
  await fs.writeFile(keywordsPath, JSON.stringify(testConfig));
  
  const result = await loadTriggerKeywords(keywordsPath);
  
  assert.ok(result.globalKeywords.includes('dog'));
  assert.ok(result.globalKeywords.includes('cat'));
  assert.ok(result.globalKeywords.includes('broccoli'));
  assert.strictEqual(result.accountSpecific.test_user.keywords.length, 2);
  assert.deepStrictEqual(result.softMentionTiers, ['official', 'founder']);
  assert.deepStrictEqual(result.alwaysAlertTiers, ['official']);
  assert.strictEqual(result.minTweetLength, 20);
  
  await fs.rm(tempDir, { recursive: true });
});

test('loadTriggerKeywords: returns defaults when file not found', async () => {
  const result = await loadTriggerKeywords('/nonexistent/keywords.json');
  
  assert.ok(Array.isArray(result.globalKeywords));
  assert.strictEqual(result.globalKeywords.length, 0);
  assert.deepStrictEqual(result.softMentionTiers, ['official', 'founder', 'chain_lead']);
});

test('matchesTriggerKeywords: matches global keywords', () => {
  const triggerKeywords = {
    globalKeywords: ['dog', 'broccoli', 'ai agent'],
    accountSpecific: {}
  };
  
  const account = { handle: 'test_user', tier: 'kol_alpha' };
  
  const result1 = matchesTriggerKeywords('I love my dog', account, triggerKeywords);
  assert.strictEqual(result1.matched, true);
  assert.ok(result1.keywords.includes('dog'));
  
  const result2 = matchesTriggerKeywords('Broccoli is great!', account, triggerKeywords);
  assert.strictEqual(result2.matched, true);
  assert.ok(result2.keywords.includes('broccoli'));
  
  const result3 = matchesTriggerKeywords('Check out this AI Agent', account, triggerKeywords);
  assert.strictEqual(result3.matched, true);
  
  const result4 = matchesTriggerKeywords('No keywords here', account, triggerKeywords);
  assert.strictEqual(result4.matched, false);
  assert.strictEqual(result4.keywords.length, 0);
});

test('matchesTriggerKeywords: case insensitive matching', () => {
  const triggerKeywords = {
    globalKeywords: ['blockchain'],
    accountSpecific: {}
  };
  
  const account = { handle: 'test', tier: 'kol' };
  
  const result = matchesTriggerKeywords('BLOCKCHAIN is the future', account, triggerKeywords);
  assert.strictEqual(result.matched, true);
  assert.ok(result.keywords.includes('blockchain'));
});

test('matchesTriggerKeywords: matches account-specific keywords', () => {
  const triggerKeywords = {
    globalKeywords: [],
    accountSpecific: {
      'cz_binance': {
        enabled: true,
        keywords: ['SAFU', 'build']
      }
    }
  };
  
  const czAccount = { handle: 'cz_binance', tier: 'founder' };
  const otherAccount = { handle: 'other_user', tier: 'kol' };
  
  const result1 = matchesTriggerKeywords('Funds are SAFU', czAccount, triggerKeywords);
  assert.strictEqual(result1.matched, true);
  assert.ok(result1.keywords.includes('SAFU'));
  
  const result2 = matchesTriggerKeywords('Funds are SAFU', otherAccount, triggerKeywords);
  assert.strictEqual(result2.matched, false); // Not CZ's account
});

test('matchesTriggerKeywords: combines global and account-specific', () => {
  const triggerKeywords = {
    globalKeywords: ['dog'],
    accountSpecific: {
      'test_user': {
        enabled: true,
        keywords: ['cat']
      }
    }
  };
  
  const account = { handle: 'test_user', tier: 'kol' };
  
  const result = matchesTriggerKeywords('My dog and cat', account, triggerKeywords);
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.keywords.length, 2);
  assert.ok(result.keywords.includes('dog'));
  assert.ok(result.keywords.includes('cat'));
});

test('matchesTriggerKeywords: deduplicates keywords', () => {
  const triggerKeywords = {
    globalKeywords: ['dog', 'dog'],
    accountSpecific: {
      'test': {
        enabled: true,
        keywords: ['dog']
      }
    }
  };
  
  const account = { handle: 'test', tier: 'kol' };
  
  const result = matchesTriggerKeywords('dog dog dog', account, triggerKeywords);
  assert.strictEqual(result.matched, true);
  // Should not have duplicate 'dog' entries
  assert.strictEqual(result.keywords.filter(k => k === 'dog').length, 1);
});

test('matchesTriggerKeywords: handles disabled account-specific keywords', () => {
  const triggerKeywords = {
    globalKeywords: [],
    accountSpecific: {
      'test': {
        enabled: false,
        keywords: ['disabled']
      }
    }
  };
  
  const account = { handle: 'test', tier: 'kol' };
  
  const result = matchesTriggerKeywords('This is disabled', account, triggerKeywords);
  assert.strictEqual(result.matched, false);
});

test('matchesTriggerKeywords: returns no match for empty text', () => {
  const triggerKeywords = {
    globalKeywords: ['test'],
    accountSpecific: {}
  };
  
  const account = { handle: 'test', tier: 'kol' };
  
  const result = matchesTriggerKeywords('', account, triggerKeywords);
  assert.strictEqual(result.matched, false);
});
