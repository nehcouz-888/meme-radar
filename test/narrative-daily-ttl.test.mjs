#!/usr/bin/env node
/**
 * Narrative daily TTL and noise filtering tests
 * ✅ 固定时钟测试：11/3旧事件在11/11不可出现
 * ✅ Good Thursday被过滤
 * ✅ 真实新词保留
 * ✅ 重复事件更新时间但不篡改首次见
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  narrativeDailyConfig,
  classifyTokenizable,
  filterTokenizableEvents,
  formatNarrativeDigest
} from '../src/narrative-daily.mjs';

test('classifyTokenizable: filters greeting noise (gm, gn, Good Thursday)', () => {
  const cfg = narrativeDailyConfig();
  
  assert.strictEqual(classifyTokenizable('gm', cfg).ok, false);
  assert.strictEqual(classifyTokenizable('gm', cfg).reason, 'stopword');
  
  assert.strictEqual(classifyTokenizable('gn', cfg).ok, false);
  assert.strictEqual(classifyTokenizable('gn', cfg).reason, 'stopword');
  
  assert.strictEqual(classifyTokenizable('Good Thursday', cfg).ok, false);
  assert.strictEqual(classifyTokenizable('Good Thursday', cfg).reason, 'greeting_noise');
  
  assert.strictEqual(classifyTokenizable('Good Monday', cfg).ok, false);
  assert.strictEqual(classifyTokenizable('Good Friday', cfg).ok, false);
  
  assert.strictEqual(classifyTokenizable('hello', cfg).ok, false);
  assert.strictEqual(classifyTokenizable('hello', cfg).reason, 'stopword');
});

test('classifyTokenizable: accepts real tokenizable names', () => {
  const cfg = narrativeDailyConfig();
  
  // 缩写
  const abbrev = classifyTokenizable('MAGA', cfg);
  assert.strictEqual(abbrev.ok, true);
  assert.strictEqual(abbrev.kind, 'abbrev');
  
  // 已知meme
  const meme = classifyTokenizable('Pepe', cfg);
  assert.strictEqual(meme.ok, true);
  assert.strictEqual(meme.kind, 'meme_name');
  
  // 人物
  const person = classifyTokenizable('特朗普', cfg);
  assert.strictEqual(person.ok, true);
  assert.strictEqual(person.kind, 'person');
  
  // 品牌
  const brand = classifyTokenizable('OpenAI Inc', cfg);
  assert.strictEqual(brand.ok, true);
  assert.strictEqual(brand.kind, 'brand');
});

test('classifyTokenizable: rejects names without tokenizable evidence', () => {
  const cfg = narrativeDailyConfig();
  
  // 通用词汇，无代币化特征
  const result = classifyTokenizable('天气很好', cfg);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no_tokenizable_evidence');
});

test('filterTokenizableEvents: TTL filtering (7 days default)', () => {
  const cfg = narrativeDailyConfig({ ttlDays: 7 });
  
  // 固定时钟: 2026-11-11 12:00 UTC
  const now = new Date('2026-11-11T12:00:00Z').getTime();
  
  // 旧事件: 2026-11-03 (8天前，超过TTL)
  const oldEvent = {
    source: 'x_hot',
    title: 'PEPE',
    rank: 1,
    at: '2026-11-03T12:00:00Z'
  };
  
  // 新事件: 2026-11-10 (1天前，在TTL内)
  const newEvent = {
    source: 'x_hot',
    title: 'DOGE',
    rank: 2,
    at: '2026-11-10T12:00:00Z'
  };
  
  const events = [oldEvent, newEvent];
  const result = filterTokenizableEvents(events, cfg, { now });
  
  // ✅ 只有新事件保留
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].name, 'DOGE');
});

test('filterTokenizableEvents: tracks first_seen and last_seen', () => {
  const cfg = narrativeDailyConfig();
  const now = new Date('2026-11-11T12:00:00Z').getTime();
  
  // 同一事件在不同时间出现
  const events = [
    {
      source: 'x_hot',
      title: 'TRUMP',
      rank: 5,
      at: '2026-11-09T10:00:00Z'  // 首次见到
    },
    {
      source: 'weibo_hot',
      title: 'TRUMP',
      rank: 3,
      at: '2026-11-10T15:00:00Z'  // 第二次见到
    },
    {
      source: 'x_hot',
      title: 'TRUMP',
      rank: 2,
      at: '2026-11-11T08:00:00Z'  // 第三次见到
    }
  ];
  
  const result = filterTokenizableEvents(events, cfg, { now });
  
  assert.strictEqual(result.length, 1);
  const item = result[0];
  
  // ✅ first_seen应该是最早时间
  assert.strictEqual(item.first_seen, '2026-11-09T10:00:00Z');
  
  // ✅ last_seen应该是最晚时间
  assert.strictEqual(item.last_seen, '2026-11-11T08:00:00Z');
  
  // ✅ 来源应该合并
  assert.ok(item.sources.includes('x_hot'));
  assert.ok(item.sources.includes('weibo_hot'));
  
  // ✅ rank应该保留最优（最小）
  assert.strictEqual(item.rank, 2);
});

test('filterTokenizableEvents: sorts by last_seen (freshness), not historical rank', () => {
  const cfg = narrativeDailyConfig();
  const now = new Date('2026-11-11T12:00:00Z').getTime();
  
  const events = [
    {
      source: 'x_hot',
      title: 'OLDCOIN',
      rank: 1,  // 历史最佳rank
      at: '2026-11-08T12:00:00Z'  // 较旧
    },
    {
      source: 'x_hot',
      title: 'NEWCOIN',
      rank: 10,  // 较差rank
      at: '2026-11-11T10:00:00Z'  // 最新
    }
  ];
  
  const result = filterTokenizableEvents(events, cfg, { now });
  
  // ✅ 最新的事件应该排在前面，即使rank更差
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].name, 'NEWCOIN');  // 最新的在前
  assert.strictEqual(result[1].name, 'OLDCOIN');  // 历史rank虽好但旧
});

test('filterTokenizableEvents: allows zero candidates (no 40-padding)', () => {
  const cfg = narrativeDailyConfig({ ttlDays: 7 });
  const now = new Date('2026-11-11T12:00:00Z').getTime();
  
  // 所有事件都是噪声或过期
  const events = [
    {
      source: 'x_hot',
      title: 'Good Thursday',
      rank: 1,
      at: '2026-11-11T10:00:00Z'
    },
    {
      source: 'x_hot',
      title: 'gm',
      rank: 2,
      at: '2026-11-11T10:00:00Z'
    },
    {
      source: 'x_hot',
      title: 'OLDCOIN',
      rank: 3,
      at: '2026-11-01T10:00:00Z'  // 超过7天TTL
    }
  ];
  
  const result = filterTokenizableEvents(events, cfg, { now });
  
  // ✅ 允许零候选，不填充
  assert.strictEqual(result.length, 0);
});

test('formatNarrativeDigest: includes A-level disclaimer', () => {
  const candidates = [
    {
      name: 'PEPE',
      kind: 'meme_name',
      sources: 'x_hot',
      rank: 1,
      first_seen: '2026-11-10T10:00:00Z',
      last_seen: '2026-11-11T10:00:00Z'
    }
  ];
  
  const digest = formatNarrativeDigest(candidates);
  
  // ✅ A级disclaimer存在
  assert.ok(digest.includes('A级：仅叙事匹配，非链上安全验证'));
  assert.ok(digest.includes('仿盘不共享主币评级'));
  
  // ✅ 包含首见/末见时间
  assert.ok(digest.includes('首见:2026-11-10'));
  assert.ok(digest.includes('末见:2026-11-11'));
});

test('formatNarrativeDigest: handles zero candidates gracefully', () => {
  const digest = formatNarrativeDigest([]);
  
  // ✅ 零候选时有明确提示
  assert.ok(digest.includes('共 0 条'));
  assert.ok(digest.includes('今日无符合条件的新鲜叙事候选'));
});

test('end-to-end: 11/3 old events filtered out on 11/11', () => {
  const cfg = narrativeDailyConfig({ ttlDays: 7 });
  const now = new Date('2026-11-11T12:00:00Z').getTime();
  
  const events = [
    {
      source: 'x_hot',
      title: 'ANCIENT',  // 11/3事件，超过7天
      rank: 1,
      at: '2026-11-03T12:00:00Z'
    },
    {
      source: 'x_hot',
      title: 'Good Thursday',  // 噪声
      rank: 2,
      at: '2026-11-11T10:00:00Z'
    },
    {
      source: 'x_hot',
      title: 'FRESH',  // 真实新词
      rank: 3,
      at: '2026-11-10T12:00:00Z'
    }
  ];
  
  const result = filterTokenizableEvents(events, cfg, { now });
  
  // ✅ 只有FRESH保留
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].name, 'FRESH');
  
  // ✅ ANCIENT（11/3）被TTL过滤
  assert.ok(!result.some(r => r.name === 'ANCIENT'));
  
  // ✅ Good Thursday被噪声过滤
  assert.ok(!result.some(r => r.name === 'Good Thursday'));
});

test('repeated events: updates last_seen but preserves first_seen', () => {
  const cfg = narrativeDailyConfig();
  const now = new Date('2026-11-11T12:00:00Z').getTime();
  
  const events = [
    {
      source: 'x_hot',
      title: 'MEME',
      rank: 10,
      at: '2026-11-09T08:00:00Z'  // 首次
    },
    {
      source: 'x_hot',
      title: 'MEME',
      rank: 5,
      at: '2026-11-10T12:00:00Z'  // 第二次
    },
    {
      source: 'weibo_hot',
      title: 'MEME',
      rank: 3,
      at: '2026-11-11T10:00:00Z'  // 第三次
    }
  ];
  
  const result = filterTokenizableEvents(events, cfg, { now });
  
  assert.strictEqual(result.length, 1);
  const item = result[0];
  
  // ✅ first_seen不被篡改，保持最早时间
  assert.strictEqual(item.first_seen, '2026-11-09T08:00:00Z');
  
  // ✅ last_seen更新为最新时间
  assert.strictEqual(item.last_seen, '2026-11-11T10:00:00Z');
  
  // ✅ rank保留最优
  assert.strictEqual(item.rank, 3);
});
