#!/bin/bash
#
# PDW SDK Benchmark Script
# Tests all major features via curl commands
#
# Usage: bash scripts/benchmark-curl.sh [BASE_URL]
# Example: bash scripts/benchmark-curl.sh http://localhost:3000
#

BASE_URL="${1:-http://localhost:3000}"
RESULTS_FILE="benchmark-results-$(date +%Y%m%d-%H%M%S).json"

echo "═══════════════════════════════════════════════════════════════════════"
echo "  PDW SDK Benchmark Suite"
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Base URL:   $BASE_URL"
echo "  Timestamp:  $(date -Iseconds)"
echo "  Results:    $RESULTS_FILE"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

# Initialize results JSON
echo '{"benchmarks": [], "summary": {}}' > "$RESULTS_FILE"

# Helper function to measure request time
# Returns only the duration in ms (last line)
benchmark() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local data="$4"

    echo "🔄 Testing: $name" >&2

    start_time=$(date +%s%3N)

    if [ "$method" = "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" "$BASE_URL$endpoint" 2>/dev/null)
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$BASE_URL$endpoint" 2>/dev/null)
    fi

    end_time=$(date +%s%3N)
    duration=$((end_time - start_time))

    http_code=$(echo "$response" | tail -n1)

    # Status indicator
    if [ "$http_code" = "200" ]; then
        status="✅"
    else
        status="❌"
    fi

    echo "   $status Status: $http_code | Duration: ${duration}ms" >&2

    # Return ONLY the duration (to stdout for capture)
    echo "$duration"
}

echo ""
echo "┌─────────────────────────────────────────────────────────────────────┐"
echo "│  1. CHAT & SEARCH BENCHMARKS                                        │"
echo "└─────────────────────────────────────────────────────────────────────┘"
echo ""

# Test 1: Simple chat (triggers vector search)
chat_simple_time=$(benchmark "Chat - Simple Query" "POST" "/api/chat" '{
    "messages": [{"role": "user", "content": "hello, what is my name?"}]
}')

# Test 2: Chat with memory save command
chat_save_time=$(benchmark "Chat - Save Memory" "POST" "/api/chat" '{
    "messages": [{"role": "user", "content": "remember that I love coffee"}]
}')

# Test 3: Chat with general knowledge query
chat_knowledge_time=$(benchmark "Chat - General Knowledge" "POST" "/api/chat" '{
    "messages": [{"role": "user", "content": "what is the distance from Ho Chi Minh to Hanoi?"}]
}')

echo ""
echo "┌─────────────────────────────────────────────────────────────────────┐"
echo "│  2. MEMORY MANAGEMENT BENCHMARKS                                    │"
echo "└─────────────────────────────────────────────────────────────────────┘"
echo ""

# Test 4: List memories
list_time=$(benchmark "List Memories" "GET" "/api/memories/list" "")

# Test 5: Memory extraction (background)
extract_time=$(benchmark "Extract Memory" "POST" "/api/chat/extract-memory" '{
    "userMessage": "My favorite programming language is TypeScript",
    "assistantMessage": "Great choice! TypeScript is excellent."
}')

echo ""
echo "┌─────────────────────────────────────────────────────────────────────┐"
echo "│  3. INDEX MANAGEMENT BENCHMARKS                                     │"
echo "└─────────────────────────────────────────────────────────────────────┘"
echo ""

# Test 6: Index rebuild (expensive operation)
echo "⚠️  Skipping index rebuild (expensive). Run manually with:"
echo "    curl -X POST $BASE_URL/api/index/rebuild"
rebuild_time="N/A"

echo ""
echo "┌─────────────────────────────────────────────────────────────────────┐"
echo "│  4. BATCH OPERATIONS BENCHMARKS                                     │"
echo "└─────────────────────────────────────────────────────────────────────┘"
echo ""

# Test 7: Batch memory save (via chat with multiple memories)
batch_time=$(benchmark "Chat - Batch Save (2 items)" "POST" "/api/chat" '{
    "messages": [{"role": "user", "content": "remember: benchmark test 1, and also benchmark test 2"}]
}')

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  BENCHMARK RESULTS SUMMARY"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
echo "┌────────────────────────────────┬────────────┬──────────────────────┐"
echo "│ Test                           │ Time (ms)  │ Status               │"
echo "├────────────────────────────────┼────────────┼──────────────────────┤"
printf "│ %-30s │ %10s │ %-20s │\n" "Chat - Simple Query" "$chat_simple_time" "Vector Search"
printf "│ %-30s │ %10s │ %-20s │\n" "Chat - Save Memory" "$chat_save_time" "Create + Index"
printf "│ %-30s │ %10s │ %-20s │\n" "Chat - General Knowledge" "$chat_knowledge_time" "RAG + LLM"
printf "│ %-30s │ %10s │ %-20s │\n" "List Memories" "$list_time" "Blockchain Query"
printf "│ %-30s │ %10s │ %-20s │\n" "Extract Memory" "$extract_time" "AI Classification"
printf "│ %-30s │ %10s │ %-20s │\n" "Batch Save (2 items)" "$batch_time" "Quilt Upload"
echo "└────────────────────────────────┴────────────┴──────────────────────┘"
echo ""

# Calculate averages (with fallback for non-numeric values)
chat_simple_time=${chat_simple_time:-0}
chat_knowledge_time=${chat_knowledge_time:-0}
list_time=${list_time:-0}
extract_time=${extract_time:-0}
chat_save_time=${chat_save_time:-0}
batch_time=${batch_time:-0}

total=$((chat_simple_time + chat_knowledge_time + list_time + extract_time))
avg=$((total / 4))

echo "📊 Performance Metrics:"
echo "   • Average query time: ${avg}ms"
echo "   • Chat (with search): ${chat_simple_time}ms"
echo "   • Memory operations: ${chat_save_time}ms"
echo ""

# Option A+ check
if [ "$chat_simple_time" -lt 5000 ] 2>/dev/null; then
    echo "✅ Option A+ appears to be working (search < 5s)"
    echo "   Local content retrieval is enabled"
else
    echo "⚠️  Search taking > 5s - may be fetching from Walrus"
    echo "   Consider running: curl -X POST $BASE_URL/api/index/rebuild"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Benchmark complete! Results saved to: $RESULTS_FILE"
echo "═══════════════════════════════════════════════════════════════════════"

# Save JSON results
cat > "$RESULTS_FILE" << EOF
{
  "timestamp": "$(date -Iseconds)",
  "baseUrl": "$BASE_URL",
  "results": {
    "chatSimple": {"timeMs": $chat_simple_time, "description": "Vector search + RAG"},
    "chatSaveMemory": {"timeMs": $chat_save_time, "description": "Create memory + index"},
    "chatKnowledge": {"timeMs": $chat_knowledge_time, "description": "General knowledge query"},
    "listMemories": {"timeMs": $list_time, "description": "Blockchain query"},
    "extractMemory": {"timeMs": $extract_time, "description": "AI classification"},
    "batchSave": {"timeMs": $batch_time, "description": "Quilt batch upload"}
  },
  "summary": {
    "averageQueryMs": $avg,
    "optionAPlusWorking": $([ "$chat_simple_time" -lt 5000 ] 2>/dev/null && echo "true" || echo "false")
  }
}
EOF

echo ""
echo "📄 JSON output:"
cat "$RESULTS_FILE"
