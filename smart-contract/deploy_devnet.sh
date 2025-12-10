#!/bin/bash

# Script to deploy the PDW contract to Sui devnet

echo "Building the contract..."
sui move build

if [ $? -ne 0 ]; then
    echo "Build failed. Exiting."
    exit 1
fi

echo "Publishing the contract to devnet..."
PUBLISH_OUTPUT=$(sui client publish --gas-budget 100000000 --json)
echo "Raw publish output:"
echo "$PUBLISH_OUTPUT"

# Try multiple patterns to extract package ID
PACKAGE_ID=$(echo "$PUBLISH_OUTPUT" | grep -o '"packageId":"0x[a-fA-F0-9]*"' | head -1 | cut -d '"' -f 4)

if [ -z "$PACKAGE_ID" ]; then
    # Try alternative pattern
    PACKAGE_ID=$(echo "$PUBLISH_OUTPUT" | grep -o '"objectId":"0x[a-fA-F0-9]*"' | head -1 | cut -d '"' -f 4)
fi

if [ -z "$PACKAGE_ID" ]; then
    # Try another alternative pattern for newer CLI versions
    PACKAGE_ID=$(echo "$PUBLISH_OUTPUT" | jq -r '.effects.created[] | select(.owner == "Immutable") | .reference.objectId' 2>/dev/null | head -1)
fi

if [ -z "$PACKAGE_ID" ]; then
    echo "Failed to extract package ID. Exiting."
    exit 1
fi

echo "Package published successfully with ID: $PACKAGE_ID"

# Get the current address
ADDRESS=$(sui client active-address)
echo "Using address: $ADDRESS"

echo "Testing chat_sessions::create_session..."
SESSION_TX=$(sui client call --package "$PACKAGE_ID" --module "chat_sessions" --function "create_session" --args "gemini-1.5-pro" --gas-budget 10000000 --json)
echo "Raw session creation output:"
echo "$SESSION_TX"

# Try multiple patterns to extract session ID
SESSION_ID=$(echo "$SESSION_TX" | grep -o '"objectId":"0x[a-fA-F0-9]*"' | head -1 | cut -d '"' -f 4)

if [ -z "$SESSION_ID" ]; then
    # Try alternative pattern for newer CLI versions
    SESSION_ID=$(echo "$SESSION_TX" | jq -r '.effects.created[] | select(.owner.AddressOwner) | .reference.objectId' 2>/dev/null | head -1)
fi

if [ -z "$SESSION_ID" ]; then
    echo "Failed to create session. Exiting."
    exit 1
fi

echo "Session created with ID: $SESSION_ID"

echo "Testing chat_sessions::add_message_to_session..."
sui client call --package "$PACKAGE_ID" --module "chat_sessions" --function "add_message_to_session" --args "$SESSION_ID" "user" "Hello, this is a test message" --gas-budget 10000000

echo "Testing chat_sessions::save_session_summary..."
sui client call --package "$PACKAGE_ID" --module "chat_sessions" --function "save_session_summary" --args "$SESSION_ID" "Test session with one user message" --gas-budget 10000000

echo "Testing chat_sessions::delete_session..."
sui client call --package "$PACKAGE_ID" --module "chat_sessions" --function "delete_session" --args "$SESSION_ID" --gas-budget 10000000

echo "Testing memory::create_memory_index..."
INDEX_TX=$(sui client call --package "$PACKAGE_ID" --module "memory" --function "create_memory_index" --args "test-index-blob" "test-graph-blob" --gas-budget 10000000 --json)
echo "Raw memory index creation output:"
echo "$INDEX_TX"

# Try multiple patterns to extract index ID
INDEX_ID=$(echo "$INDEX_TX" | grep -o '"objectId":"0x[a-fA-F0-9]*"' | head -1 | cut -d '"' -f 4)

if [ -z "$INDEX_ID" ]; then
    # Try alternative pattern for newer CLI versions
    INDEX_ID=$(echo "$INDEX_TX" | jq -r '.effects.created[] | select(.owner.AddressOwner) | .reference.objectId' 2>/dev/null | head -1)
fi

if [ -z "$INDEX_ID" ]; then
    echo "Failed to create memory index. Exiting."
    exit 1
fi

echo "Memory index created with ID: $INDEX_ID"

echo "Testing memory::update_memory_index..."
sui client call --package "$PACKAGE_ID" --module "memory" --function "update_memory_index" --args "$INDEX_ID" "1" "updated-index-blob" "updated-graph-blob" --gas-budget 10000000

echo "Testing memory::create_memory_record..."
MEMORY_TX=$(sui client call --package "$PACKAGE_ID" --module "memory" --function "create_memory_record" --args "test-category" "42" "test-blob-id" --gas-budget 10000000 --json)
echo "Raw memory record creation output:"
echo "$MEMORY_TX"

# Try multiple patterns to extract memory ID
MEMORY_ID=$(echo "$MEMORY_TX" | grep -o '"objectId":"0x[a-fA-F0-9]*"' | head -1 | cut -d '"' -f 4)

if [ -z "$MEMORY_ID" ]; then
    # Try alternative pattern for newer CLI versions
    MEMORY_ID=$(echo "$MEMORY_TX" | jq -r '.effects.created[] | select(.owner.AddressOwner) | .reference.objectId' 2>/dev/null | head -1)
fi

if [ -z "$MEMORY_ID" ]; then
    echo "Failed to create memory record. Exiting."
    exit 1
fi

echo "Memory record created with ID: $MEMORY_ID"

echo "All tests completed successfully!"
echo "Contract package ID: $PACKAGE_ID"
echo ""
echo "Please add the following to your .env.local file:"
echo "NEXT_PUBLIC_SUI_PACKAGE_ID=$PACKAGE_ID"
echo "NEXT_PUBLIC_SUI_NETWORK=devnet"
echo "NEXT_PUBLIC_SUI_API_URL=https://fullnode.devnet.sui.io:443"