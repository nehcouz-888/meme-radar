#!/usr/bin/env node
/**
 * Narrative A-level report generator
 * ✅ 真实A级出口：只有经过验证的A级叙事才带A级disclaimer
 * 区别于日筛40条候选（无A级标签）
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 生成A级叙事报告
 * @param {Array} candidates - 已验证的A级叙事候选
 * @param {Object} options - 配置选项
 */
export function generateALevelReport(candidates, options = {}) {
  const {
    title = 'A级叙事候选',
    includeDisclaimer = true
  } = options;
  
  const lines = [title, ''];
  
  // ✅ A级disclaimer只在真实A级出口显示
  if (includeDisclaimer) {
    lines.push('⚠️  A级说明：');
    lines.push('- 仅叙事匹配，非链上安全验证');
    lines.push('- 仿盘不共享主币评级');
    lines.push('- 需自行验证合约安全、持仓分布等');
    lines.push('');
  }
  
  if (candidates.length === 0) {
    lines.push('暂无A级叙事候选。');
  } else {
    lines.push(`共 ${candidates.length} 条A级叙事：`);
    lines.push('');
    
    candidates.forEach((c, i) => {
      const timeInfo = c.first_seen && c.last_seen 
        ? ` 首见:${c.first_seen.split('T')[0]} 末见:${c.last_seen.split('T')[0]}`
        : '';
      const verificationInfo = c.verificationStatus ? ` [${c.verificationStatus}]` : '';
      lines.push(`${i + 1}. ${c.name} [${c.kind}]${verificationInfo}`);
      lines.push(`   来源: ${c.sources || c.source}${c.rank != null ? ` 排名:${c.rank}` : ''}${timeInfo}`);
      
      // 如果有链上数据，显示
      if (c.onChainData) {
        const { chain, address, marketCap, liquidity } = c.onChainData;
        lines.push(`   链: ${chain} | 地址: ${address}`);
        if (marketCap) lines.push(`   市值: $${marketCap.toLocaleString()}`);
        if (liquidity) lines.push(`   流动性: $${liquidity.toLocaleString()}`);
      }
      
      lines.push('');
    });
  }
  
  lines.push('仅研究参考，不构成投资建议。');
  
  return lines.join('\n');
}

/**
 * 过滤A级叙事候选
 * @param {Array} candidates - 所有叙事候选
 * @param {Function} verifier - 验证函数
 */
export function filterALevelCandidates(candidates, verifier) {
  const aLevelCandidates = [];
  
  for (const candidate of candidates) {
    const verification = verifier ? verifier(candidate) : { isALevel: false };
    
    if (verification.isALevel) {
      aLevelCandidates.push({
        ...candidate,
        verificationStatus: verification.status || 'A级',
        verificationTime: new Date().toISOString(),
        onChainData: verification.onChainData || null
      });
    }
  }
  
  return aLevelCandidates;
}

// CLI用法示例
if (import.meta.url === `file://${process.argv[1]}`) {
  const candidatesFile = process.argv[2];
  const outputFile = process.argv[3];
  
  if (!candidatesFile || !outputFile) {
    console.error('Usage: node report.mjs <candidates.json> <output.txt>');
    process.exit(1);
  }
  
  const candidates = JSON.parse(fs.readFileSync(candidatesFile, 'utf8'));
  
  // 默认验证器：需要外部实现
  const defaultVerifier = (candidate) => {
    // 这里应该调用链上数据验证
    // 目前返回false，需要实际验证逻辑
    return { isALevel: false };
  };
  
  const aLevelCandidates = filterALevelCandidates(
    Array.isArray(candidates) ? candidates : candidates.candidates || [],
    defaultVerifier
  );
  
  const report = generateALevelReport(aLevelCandidates);
  
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, report);
  
  console.log(JSON.stringify({
    ok: true,
    total: candidates.length,
    aLevel: aLevelCandidates.length,
    outputFile
  }));
}
