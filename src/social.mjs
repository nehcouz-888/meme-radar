import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// FUTURE X/KOL INTEGRATION NOTES:
// The x-monitor.mjs module now handles Twitter/X watchlist monitoring.
// This module (social.mjs) can be extended to:
// 1. Aggregate X hits with on-chain discoveries for unified scoring
// 2. Cross-reference KOL calls with contract addresses found on-chain
// 3. Compute "social momentum" scores based on multiple KOL mentions
// 4. Track historical KOL call accuracy for weighted scoring
//
// Current X monitoring features (implemented in x-monitor.mjs):
// - Watchlist of Binance officials, CZ, He Yi, chain leads, and alpha KOLs
// - Twitter API v2 integration with dry-run mode when no bearer token
// - Contract address extraction (Solana + EVM) from tweets
// - Enqueue discovered addresses into candidate pipeline
// - Social alert webhooks for non-CA tweets
// - 30-minute deduplication for tweets and mint+account pairs
//
// Integration points for future enhancement:
// - socialGate() could check if a token was mentioned by watched accounts
// - Add "xMentions" count and tier breakdown (official/founder/kol_alpha)
// - Boost embryonic score for tokens with high-tier KOL endorsement
// - Track time-to-mention: tokens called by KOLs before major price moves

export async function xCapability() {
  try {
    const { stdout } = await execFileAsync('agent-reach', ['doctor', '--json'], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    const result = JSON.parse(stdout)?.twitter || {};
    return {
      available: result.status === 'ok' && Boolean(result.active_backend),
      backend: result.active_backend || '',
      reason: result.active_backend ? result.message || '' : '未配置可用的X只读后端'
    };
  } catch {
    return { available: false, backend: '', reason: 'X只读检查暂时不可用，候选只能进入人工复核' };
  }
}

export function socialGate({ twitter, followerCount = 0, duplicateSocial = null, capability }) {
  if (!twitter) return { status: 'FAIL', score: 0, reason: '没有X账号' };
  if (duplicateSocial === true) return { status: 'FAIL', score: 0, reason: '社媒链接疑似复用' };
  if (!capability?.available) {
    return { status: 'UNVERIFIED', score: 0, reason: capability?.reason || '无法读取X评论，不能确认真人社区' };
  }
  return {
    status: 'UNVERIFIED', score: 0,
    reason: `已检测到X后端${capability.backend}，评论真实性解析器尚未完成联调`
  };
}
