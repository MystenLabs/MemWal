# Testing PDW SDK v0.3.4

## ✅ SDK Fixed!

The SDK author fixed the packaging issue in v0.3.4:
- ✅ Added `.js` extensions to directory imports
- ✅ Line 18 now: `from './pipeline/index.js'` (was: `from './pipeline'`)

---

## 🧪 How to Test

### 1. Restart Dev Server
```bash
# Kill old server (if running)
pkill -f "next dev"

# Clear cache
rm -rf .next

# Start fresh
pnpm run dev
```

### 2. Visit Showcase
Open: http://localhost:3000/showcase

### 3. Test Personal Data Detection

**Test 1: Name**
```
User: "My name is Alex and I'm 28 years old"
```
Expected:
- ✅ Console shows: "✅ PDW SDK loaded successfully!"
- ✅ Console shows: "🔍 Personal data detected - storing on blockchain..."
- ✅ Console shows: "✅ Memory stored on blockchain!"
- ✅ Console shows memory ID and blob ID
- ✅ UI shows the memory in the memories panel

**Test 2: Preferences**
```
User: "I love pizza and hate broccoli"
```
Expected:
- ✅ Detects as "preference" category
- ✅ Stores on blockchain
- ✅ Shows importance rating (stars)

**Test 3: RAG (Retrieval)**
```
User: "What do you know about me?"
```
Expected:
- ✅ Searches blockchain for memories
- ✅ Finds previous conversations
- ✅ AI responds with personal information
- ✅ Console shows: "✅ Found X relevant memories for RAG"

---

## 🔍 What to Look For in Console

### Success Indicators:
```
✅ PDW SDK loaded successfully!
✅ PDW Client initialized successfully
📍 Wallet Address: 0xb59f00b2...
🌐 Network: testnet
🔍 Personal data detected - storing on blockchain...
✅ Memory stored on blockchain!
📍 Memory ID: 0x...
🗄️ Blob ID: ...
📊 Category: fact / preference / personal_info
⭐ Importance: 1-10
🕸️ Knowledge Graph extracted: ...
✅ Found X relevant memories for RAG
```

### Error Indicators (if still broken):
```
❌ Failed to load PDW SDK
❌ Failed to import PDW SDK
❌ SDK Packaging Issue
```

---

## 🎯 Expected Behavior

| Action | Expected Result |
|--------|-----------------|
| **Send personal info** | Detects → Stores on Sui → Shows in UI |
| **Ask "What's my name?"** | Searches blockchain → Retrieves memory → AI responds |
| **Refresh page** | Memories persist (loaded from blockchain) |
| **Click "Refresh from Blockchain"** | Re-fetches all memories |

---

## 📊 Blockchain Verification

After storing a memory:
1. Copy the **Memory ID** from console (e.g., `0xc42287ae...`)
2. Visit: https://suiexplorer.com/?network=testnet
3. Paste the Memory ID
4. Should see your transaction on Sui blockchain!

---

## 🐛 If Still Not Working

1. **Clear everything:**
   ```bash
   rm -rf .next
   rm -rf node_modules
   pnpm install
   pnpm run dev
   ```

2. **Check SDK version:**
   ```bash
   cat package.json | grep personal-data-wallet-sdk
   # Should show: "personal-data-wallet-sdk": "^0.3.4"
   ```

3. **Verify .env file:**
   - Make sure all variables are set
   - Check SUI_PRIVATE_KEY format
   - Verify GEMINI_API_KEY is valid

4. **Report to SDK author:**
   - If v0.3.4 still has issues
   - Include console error logs
   - Mention you updated from v0.3.3

---

## 🎉 Success!

Once you see:
- ✅ "PDW SDK loaded successfully!"
- ✅ Memories storing on blockchain
- ✅ RAG working (AI retrieves past conversations)

**Your personal data wallet integration is complete! 🚀**

---

## 📝 Next Steps After Success

1. **Test different personal data types:**
   - Names, ages, locations
   - Preferences (likes/dislikes)
   - Work information
   - Hobbies and interests

2. **Test RAG:**
   - Store multiple memories
   - Ask questions about yourself
   - See AI retrieve relevant context

3. **Check blockchain:**
   - Verify transactions on Sui Explorer
   - See Walrus blob IDs
   - Confirm data persistence

4. **Celebrate! 🎊**
   - Your chatbot now has a decentralized memory system
   - Personal data is encrypted and stored on blockchain
   - AI can retrieve context for personalized responses
