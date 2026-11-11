#!/usr/bin/env node
// Narrative daily runner (direction 2). Reads local hot-events jsonl (Weibo+X), filters tokenizable.
// Parent/agent is responsible for appending hot events from free sources into the jsonl.
// ✅ 2026-11-12 audit fixes: TTL freshness, noise filtering, A-level disclaimer
import fs from 'node:fs';
import path from 'node:path';
import {
  narrativeDailyConfig, readHotEvents, filterTokenizableEvents, formatNarrativeDigest
} from '../src/narrative-daily.mjs';

const ROOT = '/workspace/meme-radar-run';
const CFG_PATH = path.join(ROOT, 'meme-radar-branch/config/narrative-early-discovery.json');

let cfgFile = {};
try {
  cfgFile = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
} catch {
  // ✅ 配置文件不存在时使用默认值
  console.error(`Config file not found at ${CFG_PATH}, using defaults`);
}

const nd = narrativeDailyConfig(cfgFile.narrativeDaily || {});
const eventsFile = nd.eventsFile || path.join(ROOT, 'scan-accum/narrative-early/state/hot-events.jsonl');
const outFile = nd.outFile || path.join(ROOT, 'scan-accum/narrative-early/out/narrative-daily.json');
const digestFile = path.join(ROOT, 'scan-accum/narrative-early/out/narrative-daily-digest.txt');

const events = readHotEvents(eventsFile);

// ✅ Fix (a): 传入当前时间用于TTL计算
const candidates = filterTokenizableEvents(events, nd, { now: Date.now() });

const digest = formatNarrativeDigest(candidates);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  enabled: nd.enabled,
  sources: nd.sources,
  // ✅ Fix (a): 添加TTL配置信息
  ttlDays: nd.ttlDays,
  eventsRead: events.length,
  candidatesCount: candidates.length,
  candidates
}, null, 2));

fs.writeFileSync(digestFile, digest);

console.log(JSON.stringify({ 
  ok: true, 
  events: events.length, 
  candidates: candidates.length, 
  ttlDays: nd.ttlDays,
  outFile, 
  digestFile 
}, null, 2));

if (candidates.length) {
  console.log('\n' + digest);
} else {
  console.log('\n今日无符合条件的新鲜叙事候选（TTL筛选后）。');
}
