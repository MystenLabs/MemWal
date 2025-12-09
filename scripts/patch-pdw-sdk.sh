#!/bin/bash
# Patch personal-data-wallet-sdk v0.3.4 to fix top-level await issue

CONSENT_FILE="node_modules/personal-data-wallet-sdk/dist/permissions/ConsentRepository.js"

echo "🔧 Patching personal-data-wallet-sdk v0.3.4..."

if [ ! -f "$CONSENT_FILE" ]; then
  echo "❌ SDK not found. Run: pnpm install first"
  exit 1
fi

# Backup if not already backed up
if [ ! -f "$CONSENT_FILE.original" ]; then
  cp "$CONSENT_FILE" "$CONSENT_FILE.original"
  echo "📦 Created backup"
fi

# Apply the patch using Python
python3 << 'ENDPYTHON'
import re

file_path = 'node_modules/personal-data-wallet-sdk/dist/permissions/ConsentRepository.js'

with open(file_path + '.original', 'r') as f:
    content = f.read()

# Replace top-level await section
old_code = """if (typeof window === 'undefined') {
  try {
    // Use dynamic import for Node.js built-ins
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    fsPromises = require('fs/promises');
    pathModule = require('path');
  } catch (e) {
    // Browser or environment without these modules
    fsPromises = null;
    pathModule = null;
  }
}"""

new_code = """// PATCHED: Lazy initialization to avoid top-level await in Next.js
async function _initNodeModules() {
  if (fsPromises !== null) return;
  if (typeof window === 'undefined') {
    try {
      fsPromises = await import('fs/promises');
      pathModule = await import('path');
    } catch (e) {
      fsPromises = null;
      pathModule = null;
    }
  }
}"""

content = content.replace(old_code, new_code)

# Add init calls to methods
content = re.sub(
    r'(async save\(request\) \{)\s*const',
    r'\1\n        await _initNodeModules();\n        const',
    content
)

content = re.sub(
    r'(async readAll\(\) \{)\s*try',
    r'\1\n        await _initNodeModules();\n        try',
    content
)

content = re.sub(
    r'(async writeAll\(records\) \{)\s*const',
    r'\1\n        await _initNodeModules();\n        const',
    content
)

with open(file_path, 'w') as f:
    f.write(content)

print('✅ Patch applied successfully!')
ENDPYTHON

echo "✅ SDK patched! You can now use personal-data-wallet-sdk v0.3.4"
echo "⚠️  Note: Re-run this script after 'pnpm install' or SDK updates"
