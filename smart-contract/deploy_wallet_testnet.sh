#!/bin/bash

# Personal Data Wallet - Wallet Contract Deployment Script
# Deploys wallet.move contracts to Sui testnet

set -e

echo "🚀 Deploying Personal Data Wallet contracts to testnet..."

# Check if sui CLI is available
if ! command -v sui &> /dev/null; then
    echo "❌ Sui CLI not found. Please install Sui CLI first."
    exit 1
fi

# Check if we're connected to testnet
CURRENT_ENV=$(sui client active-env)
if [ "$CURRENT_ENV" != "testnet" ]; then
    echo "⚠️  Current environment is $CURRENT_ENV, switching to testnet..."
    sui client switch --env testnet
fi

# Get current address
DEPLOYER_ADDRESS=$(sui client active-address)
echo "📝 Deploying from address: $DEPLOYER_ADDRESS"

# Check balance
BALANCE=$(sui client balance --json | jq -r '.[] | select(.coinType=="0x2::sui::SUI") | .totalBalance')
if [ "$BALANCE" -lt 100000000 ]; then
    echo "⚠️  Low SUI balance: $BALANCE. You may need more SUI for deployment."
    echo "💡 Get testnet SUI from: https://faucet.testnet.sui.io/"
fi

echo "💰 Current SUI balance: $BALANCE"

# Deploy the package
echo "📦 Publishing package..."
DEPLOY_OUTPUT=$(sui client publish --gas-budget 100000000 --skip-dependency-verification --json)

# Extract package ID from deployment output
PACKAGE_ID=$(echo "$DEPLOY_OUTPUT" | jq -r '.objectChanges[] | select(.type=="published") | .packageId')

if [ "$PACKAGE_ID" = "null" ] || [ -z "$PACKAGE_ID" ]; then
    echo "❌ Failed to extract package ID from deployment output"
    echo "Raw output: $DEPLOY_OUTPUT"
    exit 1
fi

echo "✅ Package deployed successfully!"
echo "📋 Package ID: $PACKAGE_ID"

# Save package ID to file for easy reference
echo "$PACKAGE_ID" > ../packages/pdw-sdk/PACKAGE_ID_TESTNET.txt
echo "💾 Package ID saved to ../packages/pdw-sdk/PACKAGE_ID_TESTNET.txt"

# Extract other important object IDs
WALLET_REGISTRY_ID=$(echo "$DEPLOY_OUTPUT" | jq -r '.objectChanges[] | select(.objectType=="'"$PACKAGE_ID"'::wallet::WalletRegistry") | .objectId')

echo ""
echo "🎉 Deployment Summary:"
echo "=================="
echo "📦 Package ID: $PACKAGE_ID"
echo "🗃️  Wallet Registry ID: $WALLET_REGISTRY_ID"
echo "🌐 Network: testnet"
echo "👤 Deployer: $DEPLOYER_ADDRESS"
echo ""

# Create environment configuration
cat > ../packages/pdw-sdk/.env.testnet << EOF
# PDW SDK Testnet Configuration (Auto-generated)
NEXT_PUBLIC_PDW_PACKAGE_ID=$PACKAGE_ID
NEXT_PUBLIC_WALLET_REGISTRY_ID=$WALLET_REGISTRY_ID
NEXT_PUBLIC_SUI_NETWORK=testnet
PDW_TESTNET_DEPLOYED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PDW_DEPLOYED_BY=$DEPLOYER_ADDRESS
EOF

echo "📝 Environment configuration saved to ../packages/pdw-sdk/.env.testnet"

# Update SDK defaults configuration
echo "🔧 Updating SDK configuration..."

cat > temp_config_update.js << 'EOF'
const fs = require('fs');
const path = require('path');

const packageId = process.env.PACKAGE_ID;
const configPath = path.join(__dirname, '../packages/pdw-sdk/src/config/defaults.ts');

let configContent = fs.readFileSync(configPath, 'utf8');

// Update the packageId in the config
configContent = configContent.replace(
  /packageId:\s*['""][^'"]*['""],?/,
  `packageId: '${packageId}',`
);

fs.writeFileSync(configPath, configContent);
console.log('✅ Updated SDK configuration with new package ID');
EOF

PACKAGE_ID=$PACKAGE_ID node temp_config_update.js
rm temp_config_update.js

echo ""
echo "🎯 Next Steps:"
echo "============="
echo "1. Update your applications to use the new package ID: $PACKAGE_ID"
echo "2. Test wallet creation with: sui client call --package $PACKAGE_ID --module wallet --function create_main_wallet"
echo "3. Run SDK tests to verify integration: cd ../packages/pdw-sdk && npm test"
echo "4. Update frontend environment variables if needed"
echo ""
echo "🔗 View on Sui Explorer:"
echo "https://suiscan.xyz/testnet/object/$PACKAGE_ID"
echo ""
echo "✨ Deployment complete!"