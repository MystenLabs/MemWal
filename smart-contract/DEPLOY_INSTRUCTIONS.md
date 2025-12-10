# Wallet Contract Deployment Instructions

## Current Blocker
**File Permission Error**: `sui client publish` fails with "Access is denied. (os error 5)"

## Workaround Options

### Option 1: Run PowerShell as Administrator (RECOMMENDED)
```powershell
# 1. Right-click PowerShell → "Run as Administrator"
# 2. Navigate to smart-contract directory
cd C:\Users\DrBrand\project\CommandOSS\personal_data_wallet\smart-contract

# 3. Verify environment
sui client active-env      # Should show: testnet
sui client active-address  # Should show: 0xc5e67f46e1b99b580da3a6cc69acf187d0c08dbe568f8f5a78959079c9d82a15

# 4. Build contract
sui move build --skip-fetch-latest-git-deps

# 5. Publish to testnet
sui client publish --gas-budget 500000000

# 6. Extract package ID from output (look for "Published Objects:")
# Example output:
# ╭────────────┬──────────────────────────────────────────────────────────────────╮
# │ PackageID  │ 0xNEW_PACKAGE_ID_HERE                                            │
# ╰────────────┴──────────────────────────────────────────────────────────────────╯
```

### Option 2: Fix Directory Permissions
```powershell
# Grant full control to your user account
icacls "C:\Users\DrBrand\project\CommandOSS\personal_data_wallet\smart-contract" /grant DrBrand:F /T

# Then retry publish
sui client publish --gas-budget 500000000
```

### Option 3: Clean Build Directory
```powershell
# Remove build artifacts
Remove-Item -Recurse -Force build/

# Rebuild and publish
sui move build --skip-fetch-latest-git-deps
sui client publish --gas-budget 500000000
```

### Option 4: Use Sui Explorer (Web-Based)
1. Go to https://suiexplorer.com/?network=testnet
2. Connect wallet with address: `0xc5e67f46e1b99b580da3a6cc69acf187d0c08dbe568f8f5a78959079c9d82a15`
3. Navigate to "Publish" section
4. Upload `sources/wallet.move` file
5. Deploy via web interface (bypasses local file permissions)

## After Successful Deployment

### 1. Update SDK Configuration
```bash
# Navigate to SDK directory
cd ..\packages\pdw-sdk

# Update .env.test with new package ID
# Replace: PACKAGE_ID=0x5bab30565143ff73b8945d2141cdf996fd901b9b2c68d6e9303bc265dab169fa
# With:    PACKAGE_ID=0xNEW_PACKAGE_ID_HERE
```

### 2. Regenerate TypeScript Bindings
```bash
# From packages/pdw-sdk directory
npm run codegen
```

This will update generated files in `src/generated/pdw/wallet.ts` with new package ID.

### 3. Update Default Config
Edit `packages/pdw-sdk/src/config/defaults.ts`:
```typescript
export const DEFAULT_CONFIG = {
  packageId: '0xNEW_PACKAGE_ID_HERE',  // Update this line
  // ...
};
```

### 4. Verify Deployment
```bash
# Check deployed package on-chain
sui client object 0xNEW_PACKAGE_ID_HERE

# Should show package details with wallet module
```

## Current Package IDs

| Component | Current Package ID | Status |
|-----------|-------------------|--------|
| **Wallet Contract** | `0x5bab30565143ff73b8945d2141cdf996fd901b9b2c68d6e9303bc265dab169fa` | OLD - Needs redeployment with dynamic fields |
| **Memory Module** | Same as above | Uses same package |
| **SEAL Access Control** | Same as above | Uses same package |

## Deployment Checklist
- [ ] Run PowerShell as Administrator OR fix permissions
- [ ] Build contract: `sui move build --skip-fetch-latest-git-deps`
- [ ] Publish contract: `sui client publish --gas-budget 500000000`
- [ ] Extract new package ID from output
- [ ] Update `packages/pdw-sdk/.env.test` → PACKAGE_ID
- [ ] Update `packages/pdw-sdk/src/config/defaults.ts` → packageId
- [ ] Regenerate bindings: `npm run codegen`
- [ ] Verify deployment: `sui client object 0xNEW_PACKAGE_ID`
- [ ] Run integration tests: `npm test`

## Expected Build Output
```
INCLUDING DEPENDENCY Sui
INCLUDING DEPENDENCY MoveStdlib
BUILDING PDW
```

## Expected Publish Output
```
╭────────────────────────────────────────────────────────────────────╮
│ Object Changes                                                      │
├────────────────────────────────────────────────────────────────────┤
│ Created Objects:                                                    │
│  ┌──                                                                │
│  │ PackageID: 0xNEW_PACKAGE_ID_HERE                                │
│  │ Version: 1                                                       │
│  │ Digest: ...                                                      │
│  └──                                                                │
╰────────────────────────────────────────────────────────────────────╯
```

## Troubleshooting

### "Access is denied" Error
- **Cause**: Windows file permissions blocking lock file write
- **Fix**: Run PowerShell as Administrator (Option 1 above)

### "Version mismatch" Warnings
- Client: 1.52.2, Server: 1.57.2 (not blocking)
- Optional: Upgrade CLI with `cargo install --locked --git https://github.com/MystenLabs/sui.git --branch testnet sui`

### "Git fetch failed" Error
- **Cause**: Network issues with Sui framework dependency
- **Fix**: Always use `--skip-fetch-latest-git-deps` flag

## Post-Deployment Testing
```bash
cd packages/pdw-sdk

# Test SEAL integration
npm run test:seal

# Test wallet services
npm test -- test/services/MainWalletService.test.ts
npm test -- test/services/ContextWalletService.test.ts

# Test cross-context access
npm test -- test/integration/cross-context-data-access.test.ts
```

## Contact
If deployment continues to fail, consider:
1. Upgrading Sui CLI to match server version (1.57.2)
2. Using Sui Explorer web interface for deployment
3. Checking Windows Defender/antivirus settings (may block file writes)
