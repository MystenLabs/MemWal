#!/usr/bin/env node
/**
 * Fix Windows backslash paths in generated TypeScript files
 *
 * This script fixes a bug in @mysten/codegen on Windows where it generates
 * import paths with backslashes instead of forward slashes.
 *
 * Run after: npm run codegen
 */

const fs = require('fs');
const path = require('path');

const generatedDir = path.join(__dirname, '..', 'src', 'generated');

function fixFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const originalContent = content;

  // Calculate relative path from current file to utils folder
  const relativeToPdw = path.relative(path.dirname(filePath), path.join(generatedDir, 'pdw'));
  const relativeToUtils = path.relative(path.dirname(filePath), path.join(generatedDir, 'utils'));

  // Fix all backslashes in import paths
  content = content.replace(/from\s+['"]([^'"]+)['"]/g, (match, importPath) => {
    let fixed = importPath.replace(/\\/g, '/');
    return `from '${fixed}'`;
  });

  // Fix import * as with backslashes
  content = content.replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g, (match, alias, importPath) => {
    let fixed = importPath.replace(/\\/g, '/');
    return `import * as ${alias} from '${fixed}'`;
  });

  // Fix ~root alias - replace with correct relative path
  // For files in pdw folder: ~root/deps -> ./deps
  // For files in pdw/deps/sui folder: ~root -> ../../
  content = content.replace(/'~root\/([^']+)'/g, (match, relativePath) => {
    // ~root points to the pdw folder
    const currentDir = path.dirname(filePath);
    const pdwDir = path.join(generatedDir, 'pdw');
    const relPath = path.relative(currentDir, pdwDir).replace(/\\/g, '/');

    if (relPath === '' || relPath === '.') {
      return `'./${relativePath}'`;
    } else {
      return `'${relPath}/${relativePath}'`;
    }
  });

  // Fix '../utils' paths for files in deps/sui folder
  // They should be '../../../utils' not '../utils'
  const currentDir = path.dirname(filePath);
  if (currentDir.includes('deps')) {
    const utilsRelPath = path.relative(currentDir, path.join(generatedDir, 'utils')).replace(/\\/g, '/');
    content = content.replace(/'\.\.\/utils\/index\.js'/g, `'${utilsRelPath}/index.js'`);
  }

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed: ${path.relative(generatedDir, filePath)}`);
  }
}

function walkDir(dir) {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      walkDir(filePath);
    } else if (file.endsWith('.ts')) {
      fixFile(filePath);
    }
  }
}

console.log('Fixing codegen paths...');
walkDir(generatedDir);
console.log('Done!');
