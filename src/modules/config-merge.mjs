/**
 * 配置增量合并：仅合并新规则字段，保留真实ID/secret
 */

import fs from 'node:fs';

/**
 * 增量合并配置
 * @param {Object} target - 目标配置（线上配置）
 * @param {Object} source - 源配置（新配置）
 * @param {Object} options - 配置
 * @returns {Object} 合并后的配置
 */
export function mergeConfig(target, source, options = {}) {
  const {
    preserveFields = ['userId', 'userIds', 'apiKey', 'apiSecret', 'token', 'webhookUrl'],
    allowNewRules = true,
    allowNewFields = true
  } = options;
  
  const merged = JSON.parse(JSON.stringify(target)); // 深拷贝
  
  // 合并alert rules（仅新增规则）
  if (allowNewRules && source.alertRules && Array.isArray(source.alertRules)) {
    merged.alertRules = merged.alertRules || [];
    
    for (const newRule of source.alertRules) {
      const exists = merged.alertRules.some(r => 
        r.name === newRule.name || 
        (r.minBuyUsd === newRule.minBuyUsd && r.minNewPositionPct === newRule.minNewPositionPct)
      );
      
      if (!exists) {
        // 新规则：保留脱敏占位符，不安装
        const ruleCopy = JSON.parse(JSON.stringify(newRule));
        if (ruleCopy.userId && (ruleCopy.userId === '[REDACTED]' || ruleCopy.userId === 'PLACEHOLDER')) {
          delete ruleCopy.userId; // 删除脱敏字段
        }
        merged.alertRules.push(ruleCopy);
      }
    }
  }
  
  // 合并其他字段（非敏感字段）
  for (const key in source) {
    if (key === 'alertRules') continue; // 已处理
    
    if (preserveFields.includes(key)) {
      // 保留目标中的敏感字段
      continue;
    }
    
    if (allowNewFields || key in merged) {
      if (typeof source[key] === 'object' && !Array.isArray(source[key]) && source[key] !== null) {
        // 递归合并对象
        merged[key] = mergeConfig(merged[key] || {}, source[key], options);
      } else {
        // 直接覆盖非对象字段
        merged[key] = source[key];
      }
    }
  }
  
  return merged;
}

/**
 * 安全合并配置文件
 * @param {string} targetFile - 目标配置文件路径
 * @param {string} sourceFile - 源配置文件路径
 * @param {Object} options - 配置
 */
export function mergeConfigFiles(targetFile, sourceFile, options = {}) {
  const { dryRun = false, backup = true } = options;
  
  // 检查目标文件是否存在
  const targetExists = fs.existsSync(targetFile);
  if (!targetExists) {
    console.log(`Target config not found, no merge needed: ${targetFile}`);
    return {
      merged: false,
      reason: 'target_not_exists',
      message: '线上配置不存在，无需合并'
    };
  }
  
  // 读取配置
  const targetConfig = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  const sourceConfig = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  
  // 检查是否有需要合并的内容
  const hasNewRules = sourceConfig.alertRules && 
    sourceConfig.alertRules.some(newRule => {
      return !targetConfig.alertRules?.some(r => r.name === newRule.name);
    });
  
  if (!hasNewRules) {
    console.log('No new rules to merge, skipping config update');
    return {
      merged: false,
      reason: 'no_new_rules',
      message: '无新规则需要合并，保留线上配置'
    };
  }
  
  // 合并配置
  const mergedConfig = mergeConfig(targetConfig, sourceConfig, options);
  
  if (dryRun) {
    return {
      merged: false,
      dryRun: true,
      targetConfig,
      sourceConfig,
      mergedConfig,
      newRules: mergedConfig.alertRules.length - (targetConfig.alertRules?.length || 0)
    };
  }
  
  // 备份原配置
  if (backup) {
    const backupFile = `${targetFile}.backup-${Date.now()}`;
    fs.copyFileSync(targetFile, backupFile);
    console.log(`Backed up config to: ${backupFile}`);
  }
  
  // 写入合并后的配置
  fs.writeFileSync(targetFile, JSON.stringify(mergedConfig, null, 2), 'utf8');
  
  return {
    merged: true,
    targetFile,
    newRules: mergedConfig.alertRules.length - (targetConfig.alertRules?.length || 0),
    preservedFields: options.preserveFields
  };
}

/**
 * 验证配置是否包含脱敏占位符
 */
export function hasRedactedFields(config) {
  const configStr = JSON.stringify(config);
  return configStr.includes('[REDACTED]') || configStr.includes('PLACEHOLDER');
}
