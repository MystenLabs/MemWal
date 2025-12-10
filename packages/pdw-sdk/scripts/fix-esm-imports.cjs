#!/usr/bin/env node
/**
 * Fix ESM Directory Imports for Node.js Compatibility
 *
 * Node.js ESM doesn't support directory imports like:
 *   import { X } from './pipeline'
 *
 * They must be explicit:
 *   import { X } from './pipeline/index.js'
 *
 * This script runs after TypeScript compilation to fix all such imports
 * in the dist/ folder.
 */

const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');

// Directories that have index.js files
const knownDirectories = new Set([
  'pipeline',
  'vector',
  'batch',
  'graph',
  'retrieval',
  'config',
  'core/interfaces',
  'core/types',
  'core',
  'infrastructure/walrus',
  'infrastructure/sui',
  'infrastructure/seal',
  'client/signers',
  'client/namespaces',
  'types',
  'generated/utils',
]);

/**
 * Check if a path is a directory that needs /index.js appended
 */
function needsIndexJs(importPath, fromFile) {
  // Skip external packages
  if (!importPath.startsWith('.')) {
    return false;
  }

  // Already has .js extension
  if (importPath.endsWith('.js')) {
    return false;
  }

  // Resolve the absolute path
  const fromDir = path.dirname(fromFile);
  const absolutePath = path.resolve(fromDir, importPath);

  // Check if it's a directory with index.js
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
    const indexPath = path.join(absolutePath, 'index.js');
    return fs.existsSync(indexPath);
  }

  // Check if adding .js makes it a file
  const withJs = absolutePath + '.js';
  if (fs.existsSync(withJs)) {
    return false; // It's a file import, not directory
  }

  return false;
}

/**
 * Determine if import needs .js extension or /index.js
 */
function fixImportPath(importPath, fromFile) {
  // Skip external packages
  if (!importPath.startsWith('.')) {
    return importPath;
  }

  // Already has .js extension
  if (importPath.endsWith('.js')) {
    return importPath;
  }

  const fromDir = path.dirname(fromFile);
  const absolutePath = path.resolve(fromDir, importPath);

  // Check if it's a directory with index.js
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
    const indexPath = path.join(absolutePath, 'index.js');
    if (fs.existsSync(indexPath)) {
      return importPath + '/index.js';
    }
  }

  // Check if it's a file that needs .js
  const withJs = absolutePath + '.js';
  if (fs.existsSync(withJs)) {
    return importPath + '.js';
  }

  // Return as-is if we can't determine
  return importPath;
}

/**
 * Fix all imports in a file
 */
function fixFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const originalContent = content;

  // Match: import { X } from './path' or export { X } from './path'
  // Also match: import X from './path' and import * as X from './path'
  const importRegex = /(import|export)\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"](\.[^'"]+)['"]/g;

  content = content.replace(importRegex, (match, keyword, importPath) => {
    const fixedPath = fixImportPath(importPath, filePath);
    if (fixedPath !== importPath) {
      return match.replace(importPath, fixedPath);
    }
    return match;
  });

  // Fix: export * from './path' (re-export all)
  const reExportRegex = /export\s+\*\s+from\s+['"](\.[^'"]+)['"]/g;
  content = content.replace(reExportRegex, (match, importPath) => {
    const fixedPath = fixImportPath(importPath, filePath);
    if (fixedPath !== importPath) {
      return match.replace(importPath, fixedPath);
    }
    return match;
  });

  // Also fix dynamic imports: import('./path')
  const dynamicImportRegex = /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  content = content.replace(dynamicImportRegex, (match, importPath) => {
    const fixedPath = fixImportPath(importPath, filePath);
    if (fixedPath !== importPath) {
      return match.replace(importPath, fixedPath);
    }
    return match;
  });

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf8');
    const relativePath = path.relative(distDir, filePath);
    console.log(`Fixed: ${relativePath}`);
    return true;
  }
  return false;
}

/**
 * Recursively walk directory and fix all .js files
 */
function walkDir(dir) {
  let fixedCount = 0;
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      fixedCount += walkDir(filePath);
    } else if (file.endsWith('.js')) {
      if (fixFile(filePath)) {
        fixedCount++;
      }
    }
  }

  return fixedCount;
}

console.log('Fixing ESM imports for Node.js compatibility...');
console.log(`Processing: ${distDir}\n`);

if (!fs.existsSync(distDir)) {
  console.error('Error: dist/ directory not found. Run build first.');
  process.exit(1);
}

const fixedCount = walkDir(distDir);
console.log(`\nDone! Fixed ${fixedCount} file(s).`);
