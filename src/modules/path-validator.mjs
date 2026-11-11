/**
 * 路径安全验证：防止symlink遍历攻击
 */

import fs from 'node:fs';
import path from 'node:path';

// 白名单：允许的根目录
const ALLOWED_ROOTS = [
  '/workspace/meme-radar-run/meme-radar-branch',
  '/workspace/test-temp-lock-multiproc',
  '/tmp/meme-radar-',
  '/opt/cursor/artifacts'
];

/**
 * 验证路径是否安全
 * @param {string} targetPath - 目标路径
 * @param {Object} options - 配置
 * @returns {Object} { safe: boolean, reason?: string, realPath?: string }
 */
export function validatePath(targetPath, options = {}) {
  const { allowedRoots = ALLOWED_ROOTS, checkExists = false } = options;
  
  try {
    // 1. 解析为绝对路径
    const absPath = path.resolve(targetPath);
    
    // 2. 检查是否在白名单内
    const inWhitelist = allowedRoots.some(root => {
      const normalizedRoot = path.resolve(root);
      return absPath === normalizedRoot || absPath.startsWith(normalizedRoot + path.sep);
    });
    
    if (!inWhitelist) {
      return {
        safe: false,
        reason: 'path_not_in_whitelist',
        attemptedPath: absPath,
        allowedRoots
      };
    }
    
    // 3. 检查父目录链（防止中间有symlink指向外部）
    let current = absPath;
    const visited = new Set();
    
    while (current !== '/' && current !== path.dirname(current)) {
      if (visited.has(current)) {
        return {
          safe: false,
          reason: 'circular_symlink',
          path: current
        };
      }
      visited.add(current);
      
      // 检查当前是否为symlink
      if (fs.existsSync(current)) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(current);
          const realTarget = path.resolve(path.dirname(current), linkTarget);
          
          // 验证symlink目标也在白名单内
          const targetInWhitelist = allowedRoots.some(root => {
            const normalizedRoot = path.resolve(root);
            return realTarget === normalizedRoot || realTarget.startsWith(normalizedRoot + path.sep);
          });
          
          if (!targetInWhitelist) {
            return {
              safe: false,
              reason: 'symlink_points_outside_whitelist',
              symlink: current,
              target: realTarget,
              allowedRoots
            };
          }
        }
      }
      
      current = path.dirname(current);
    }
    
    // 4. 可选：检查目标存在性
    if (checkExists && !fs.existsSync(absPath)) {
      return {
        safe: false,
        reason: 'path_not_exists',
        path: absPath
      };
    }
    
    // 5. 解析真实路径（跟随所有symlink）
    let realPath = absPath;
    if (fs.existsSync(absPath)) {
      realPath = fs.realpathSync(absPath);
      
      // 验证真实路径也在白名单内
      const realInWhitelist = allowedRoots.some(root => {
        const normalizedRoot = path.resolve(root);
        return realPath === normalizedRoot || realPath.startsWith(normalizedRoot + path.sep);
      });
      
      if (!realInWhitelist) {
        return {
          safe: false,
          reason: 'real_path_outside_whitelist',
          requestedPath: absPath,
          realPath,
          allowedRoots
        };
      }
    }
    
    return {
      safe: true,
      absPath,
      realPath
    };
    
  } catch (e) {
    return {
      safe: false,
      reason: 'validation_error',
      error: e.message
    };
  }
}

/**
 * 批量验证多个路径
 */
export function validatePaths(paths, options = {}) {
  const results = [];
  let allSafe = true;
  
  for (const p of paths) {
    const result = validatePath(p, options);
    results.push({ path: p, ...result });
    if (!result.safe) {
      allSafe = false;
    }
  }
  
  return { allSafe, results };
}

/**
 * 安全读取文件（带路径验证）
 */
export function safeReadFile(filePath, options = {}) {
  const validation = validatePath(filePath, { checkExists: true, ...options });
  if (!validation.safe) {
    throw new Error(`Path validation failed: ${validation.reason} (${filePath})`);
  }
  return fs.readFileSync(validation.realPath, 'utf8');
}

/**
 * 安全写入文件（带路径验证）
 */
export function safeWriteFile(filePath, data, options = {}) {
  const validation = validatePath(filePath, options);
  if (!validation.safe) {
    throw new Error(`Path validation failed: ${validation.reason} (${filePath})`);
  }
  
  // 确保父目录存在
  const dir = path.dirname(validation.absPath);
  const dirValidation = validatePath(dir, options);
  if (!dirValidation.safe) {
    throw new Error(`Parent directory validation failed: ${dirValidation.reason} (${dir})`);
  }
  
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(validation.absPath, data, 'utf8');
  return validation.absPath;
}
