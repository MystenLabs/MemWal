# MemWal Stress Tests

## Install k6
```bash
choco install k6
```

## Run Tests

```bash
# Smoke test (verify system works)
k6 run -e SCENARIO=smoke stress-tests/chat-api.js

# Load test (normal load)
k6 run stress-tests/chat-api.js

# Stress test (find breaking point)
k6 run -e SCENARIO=stress stress-tests/chat-api.js

# Memory leak detection (30min soak)
k6 run -e SCENARIO=soak stress-tests/full-flow.js
```

## Test Scripts
- `chat-api.js` - Chat endpoint
- `memory-api.js` - Memory save/prepare
- `full-flow.js` - Complete flow (best for memory leak detection)

## Custom Options
```bash
k6 run -e BASE_URL=http://localhost:3000 -e SCENARIO=stress stress-tests/chat-api.js
```

## Results
Output saved to `./stress-tests/results/`
