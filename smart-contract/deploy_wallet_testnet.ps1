# Personal Data Wallet - Wallet Contract Deployment Script
# Deploys wallet.move contracts to Sui testnet (PowerShell version)

$ErrorActionPreference = "Stop"

Write-Host "🚀 Deploying Personal Data Wallet contracts to testnet..." -ForegroundColor Cyan

# Check if sui CLI is available
if (-not (Get-Command sui -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Sui CLI not found. Please install Sui CLI first." -ForegroundColor Red
    exit 1
}

# Check if we're connected to testnet
$currentEnv = sui client active-env
if ($currentEnv -ne "testnet") {
    Write-Host "⚠️  Current environment is $currentEnv, switching to testnet..." -ForegroundColor Yellow
    sui client switch --env testnet
}

# Get current address
$deployerAddress = sui client active-address
Write-Host "📝 Deploying from address: $deployerAddress" -ForegroundColor Green

# Check balance
$balanceJson = sui client balance --json | ConvertFrom-Json
$suiBalance = ($balanceJson | Where-Object { $_.coinType -eq "0x2::sui::SUI" }).totalBalance
if ($suiBalance -lt 100000000) {
    Write-Host "⚠️  Low SUI balance: $suiBalance. You may need more SUI for deployment." -ForegroundColor Yellow
    Write-Host "💡 Get testnet SUI from: https://faucet.testnet.sui.io/" -ForegroundColor Cyan
}

Write-Host "💰 Current SUI balance: $suiBalance" -ForegroundColor Green

# Deploy the package
Write-Host "📦 Publishing package..." -ForegroundColor Cyan
$deployOutput = sui client publish --gas-budget 100000000 --skip-dependency-verification --json | ConvertFrom-Json

# Extract package ID from deployment output
$packageId = ($deployOutput.objectChanges | Where-Object { $_.type -eq "published" }).packageId

if (-not $packageId) {
    Write-Host "❌ Failed to extract package ID from deployment output" -ForegroundColor Red
    Write-Host "Raw output: $($deployOutput | ConvertTo-Json -Depth 10)" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Package deployed successfully!" -ForegroundColor Green
Write-Host "📋 Package ID: $packageId" -ForegroundColor Cyan

# Save package ID to file for easy reference
$packageId | Out-File -FilePath "../packages/pdw-sdk/PACKAGE_ID_TESTNET.txt" -Encoding UTF8
Write-Host "💾 Package ID saved to ../packages/pdw-sdk/PACKAGE_ID_TESTNET.txt" -ForegroundColor Green

# Extract WalletRegistry ID
$walletRegistryId = ($deployOutput.objectChanges | Where-Object { 
    $_.objectType -like "*::wallet::WalletRegistry" 
}).objectId

Write-Host ""
Write-Host "🎉 Deployment Summary:" -ForegroundColor Green
Write-Host "==================" -ForegroundColor Green
Write-Host "📦 Package ID: $packageId" -ForegroundColor Cyan
Write-Host "🗃️  Wallet Registry ID: $walletRegistryId" -ForegroundColor Cyan
Write-Host "🌐 Network: testnet" -ForegroundColor Cyan
Write-Host "👤 Deployer: $deployerAddress" -ForegroundColor Cyan
Write-Host ""

# Create environment configuration
$envContent = @"
# PDW SDK Testnet Configuration (Auto-generated)
NEXT_PUBLIC_PDW_PACKAGE_ID=$packageId
NEXT_PUBLIC_WALLET_REGISTRY_ID=$walletRegistryId
NEXT_PUBLIC_SUI_NETWORK=testnet
PDW_TESTNET_DEPLOYED_AT=$(Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
PDW_DEPLOYED_BY=$deployerAddress
"@

$envContent | Out-File -FilePath "../packages/pdw-sdk/.env.testnet" -Encoding UTF8
Write-Host "📝 Environment configuration saved to ../packages/pdw-sdk/.env.testnet" -ForegroundColor Green

# Update .env.test with new values
$envTestPath = "../packages/pdw-sdk/.env.test"
if (Test-Path $envTestPath) {
    $envTestContent = Get-Content $envTestPath -Raw
    
    # Update PACKAGE_ID
    $envTestContent = $envTestContent -replace 'PACKAGE_ID=.*', "PACKAGE_ID=$packageId"
    
    # Update WALLET_REGISTRY_ID
    $envTestContent = $envTestContent -replace 'WALLET_REGISTRY_ID=.*', "WALLET_REGISTRY_ID=$walletRegistryId"
    
    $envTestContent | Out-File -FilePath $envTestPath -Encoding UTF8 -NoNewline
    Write-Host "🔧 Updated .env.test with new deployment addresses" -ForegroundColor Green
}

# Update SDK defaults configuration
Write-Host "🔧 Updating SDK configuration..." -ForegroundColor Cyan

$defaultsPath = "../packages/pdw-sdk/src/config/defaults.ts"
if (Test-Path $defaultsPath) {
    $defaultsContent = Get-Content $defaultsPath -Raw
    
    # Update the packageId in the config
    $defaultsContent = $defaultsContent -replace "packageId:\s*['\x22][^\x22']*['\x22],?", "packageId: '$packageId',"
    
    $defaultsContent | Out-File -FilePath $defaultsPath -Encoding UTF8 -NoNewline
    Write-Host "✅ Updated SDK configuration with new package ID" -ForegroundColor Green
}

Write-Host ""
Write-Host "🎯 Next Steps:" -ForegroundColor Yellow
Write-Host "=============" -ForegroundColor Yellow
Write-Host "1. Run SDK tests: cd ../packages/pdw-sdk; npm test -- test/services/WalletManagementService.test.ts" -ForegroundColor White
Write-Host "2. Test wallet creation with: sui client call --package $packageId --module wallet --function create_main_wallet" -ForegroundColor White
Write-Host "3. Update frontend environment variables if needed" -ForegroundColor White
Write-Host ""
Write-Host "🔗 View on Sui Explorer:" -ForegroundColor Cyan
Write-Host "https://suiscan.xyz/testnet/object/$packageId" -ForegroundColor Blue
Write-Host ""
Write-Host "✨ Deployment complete!" -ForegroundColor Green
