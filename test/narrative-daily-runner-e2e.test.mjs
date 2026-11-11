#!/usr/bin/env node
/**
 * End-to-end test for narrative-daily-run with offline fixtures
 * ✅ 固定时钟: 2026-11-11
 * ✅ 测试真实入口逻辑
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('narrative-daily-run E2E: processes fixture with TTL and noise filtering', async () => {
  // 创建临时fixture目录
  const tmpDir = path.join(__dirname, '../.tmp-narrative-e2e-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    // 创建fixture hot-events.jsonl
    const eventsFile = path.join(tmpDir, 'hot-events.jsonl');
    const fixtures = [
      // ✅ 旧事件 (11/3, 超过7天TTL)
      {
        source: 'x_hot',
        title: 'OLDCOIN',
        rank: 1,
        at: '2026-11-03T12:00:00Z'
      },
      // ✅ 噪声 (Good Thursday)
      {
        source: 'x_hot',
        title: 'Good Thursday',
        rank: 2,
        at: '2026-11-11T10:00:00Z'
      },
      // ✅ 噪声 (gm)
      {
        source: 'weibo_hot',
        title: 'gm',
        rank: 3,
        at: '2026-11-11T10:00:00Z'
      },
      // ✅ 真实新词 (MAGA)
      {
        source: 'x_hot',
        title: 'MAGA',
        rank: 4,
        at: '2026-11-10T12:00:00Z'
      },
      // ✅ 真实新词 (Pepe)
      {
        source: 'x_hot',
        title: 'Pepe',
        rank: 5,
        at: '2026-11-11T08:00:00Z'
      },
      // ✅ 重复事件 (MAGA再次出现)
      {
        source: 'weibo_hot',
        title: 'MAGA',
        rank: 2,
        at: '2026-11-11T09:00:00Z'
      }
    ];
    
    for (const f of fixtures) {
      fs.appendFileSync(eventsFile, JSON.stringify(f) + '\n');
    }
    
    // 创建配置
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const configFile = path.join(configDir, 'narrative-early-discovery.json');
    fs.writeFileSync(configFile, JSON.stringify({
      narrativeDaily: {
        enabled: true,
        sources: ['x_hot', 'weibo_hot'],
        ttlDays: 7,
        maxCandidates: 100,
        eventsFile: eventsFile,
        outFile: path.join(tmpDir, 'out/narrative-daily.json')
      }
    }, null, 2));
    
    // 创建临时runner脚本
    const runnerScript = `
import fs from 'node:fs';
import path from 'node:path';
import {
  narrativeDailyConfig, readHotEvents, filterTokenizableEvents, formatNarrativeDigest
} from '${path.resolve(__dirname, '../src/narrative-daily.mjs')}';

const CFG_PATH = '${configFile}';
const cfgFile = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const nd = narrativeDailyConfig(cfgFile.narrativeDaily || {});
const events = readHotEvents(nd.eventsFile);

// 固定时钟: 2026-11-11 12:00 UTC
const now = new Date('2026-11-11T12:00:00Z').getTime();
const candidates = filterTokenizableEvents(events, nd, { now });
const digest = formatNarrativeDigest(candidates);

fs.mkdirSync(path.dirname(nd.outFile), { recursive: true });
fs.writeFileSync(nd.outFile, JSON.stringify({
  generatedAt: new Date(now).toISOString(),
  enabled: nd.enabled,
  sources: nd.sources,
  ttlDays: nd.ttlDays,
  eventsRead: events.length,
  candidatesCount: candidates.length,
  candidates
}, null, 2));

console.log(JSON.stringify({ 
  ok: true, 
  events: events.length, 
  candidates: candidates.length, 
  ttlDays: nd.ttlDays
}, null, 2));
`;
    
    const runnerFile = path.join(tmpDir, 'runner.mjs');
    fs.writeFileSync(runnerFile, runnerScript);
    
    // 运行runner
    const { execSync } = await import('node:child_process');
    const output = execSync(`node ${runnerFile}`, { encoding: 'utf8' });
    const result = JSON.parse(output);
    
    // ✅ 验证结果
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.events, 6);  // 读取6个事件
    assert.strictEqual(result.candidates, 2);  // 只有2个有效候选
    assert.strictEqual(result.ttlDays, 7);
    
    // 读取输出文件
    const outFile = path.join(tmpDir, 'out/narrative-daily.json');
    const outputData = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    
    // ✅ OLDCOIN (11/3) 被TTL过滤
    assert.ok(!outputData.candidates.some(c => c.name === 'OLDCOIN'));
    
    // ✅ Good Thursday 被噪声过滤
    assert.ok(!outputData.candidates.some(c => c.name === 'Good Thursday'));
    
    // ✅ gm 被噪声过滤
    assert.ok(!outputData.candidates.some(c => c.name === 'gm'));
    
    // ✅ MAGA 保留
    const maga = outputData.candidates.find(c => c.name === 'MAGA');
    assert.ok(maga);
    assert.strictEqual(maga.kind, 'abbrev');
    assert.ok(maga.sources.includes('x_hot'));
    assert.ok(maga.sources.includes('weibo_hot'));
    
    // ✅ MAGA的first_seen应该是首次时间
    assert.strictEqual(maga.first_seen, '2026-11-10T12:00:00Z');
    
    // ✅ MAGA的last_seen应该是最新时间
    assert.strictEqual(maga.last_seen, '2026-11-11T09:00:00Z');
    
    // ✅ Pepe 保留
    const pepe = outputData.candidates.find(c => c.name === 'Pepe');
    assert.ok(pepe);
    assert.strictEqual(pepe.kind, 'meme_name');
    
    // ✅ 排序：MAGA更新应该在Pepe之前（按last_seen降序）
    // MAGA last_seen: 2026-11-11T09:00:00Z
    // Pepe last_seen: 2026-11-11T08:00:00Z
    assert.strictEqual(outputData.candidates[0].name, 'MAGA');
    assert.strictEqual(outputData.candidates[1].name, 'Pepe');
    
  } finally {
    // 清理
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('narrative-daily-run E2E: handles zero candidates gracefully', async () => {
  const tmpDir = path.join(__dirname, '../.tmp-narrative-e2e-zero-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  
  try {
    // 创建只有噪声的fixture
    const eventsFile = path.join(tmpDir, 'hot-events.jsonl');
    const fixtures = [
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
        title: 'hello',
        rank: 3,
        at: '2026-11-11T10:00:00Z'
      }
    ];
    
    for (const f of fixtures) {
      fs.appendFileSync(eventsFile, JSON.stringify(f) + '\n');
    }
    
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const configFile = path.join(configDir, 'narrative-early-discovery.json');
    fs.writeFileSync(configFile, JSON.stringify({
      narrativeDaily: {
        enabled: true,
        sources: ['x_hot'],
        ttlDays: 7,
        eventsFile: eventsFile,
        outFile: path.join(tmpDir, 'out/narrative-daily.json')
      }
    }, null, 2));
    
    const runnerScript = `
import fs from 'node:fs';
import path from 'node:path';
import {
  narrativeDailyConfig, readHotEvents, filterTokenizableEvents, formatNarrativeDigest
} from '${path.resolve(__dirname, '../src/narrative-daily.mjs')}';

const CFG_PATH = '${configFile}';
const cfgFile = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const nd = narrativeDailyConfig(cfgFile.narrativeDaily || {});
const events = readHotEvents(nd.eventsFile);
const now = new Date('2026-11-11T12:00:00Z').getTime();
const candidates = filterTokenizableEvents(events, nd, { now });

fs.mkdirSync(path.dirname(nd.outFile), { recursive: true });
fs.writeFileSync(nd.outFile, JSON.stringify({
  generatedAt: new Date(now).toISOString(),
  enabled: nd.enabled,
  candidatesCount: candidates.length,
  candidates
}, null, 2));

console.log(JSON.stringify({ candidates: candidates.length }));
`;
    
    const runnerFile = path.join(tmpDir, 'runner.mjs');
    fs.writeFileSync(runnerFile, runnerScript);
    
    const { execSync } = await import('node:child_process');
    const output = execSync(`node ${runnerFile}`, { encoding: 'utf8' });
    const result = JSON.parse(output);
    
    // ✅ 允许零候选
    assert.strictEqual(result.candidates, 0);
    
    const outFile = path.join(tmpDir, 'out/narrative-daily.json');
    const outputData = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.strictEqual(outputData.candidatesCount, 0);
    assert.strictEqual(outputData.candidates.length, 0);
    
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
