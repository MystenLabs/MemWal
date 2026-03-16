import { streamText, convertToModelMessages, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { withMemWal } from "@cmdoss/memwal/ai";
import { DEFAULT_MODEL } from "@/shared/lib/ai/constant";
import { createTools } from "@/shared/lib/ai/tools";
import { db } from "@/shared/lib/db";
import { zkLoginSessions, walletSessions, users } from "@/shared/db/schema";
import { eq } from "drizzle-orm";

// OpenRouter provider
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY || "",
});

/**
 * Get a language model, optionally wrapped with MemWal memory layer.
 * Same pattern as v2-test's getMemWalModel.
 */
function getModel(modelId: string) {
  const baseModel = openrouter.chat(modelId);

  const memwalKey = process.env.MEMWAL_KEY;
  if (!memwalKey) {
    console.warn("[AI] MEMWAL_KEY not set — memory layer disabled");
    return baseModel;
  }

  return withMemWal(baseModel, {
    key: memwalKey,
    serverUrl: process.env.MEMWAL_SERVER_URL || "http://localhost:8000",
    maxMemories: 5,
    autoSave: true,
    minRelevance: 0.3,
  });
}

const SYSTEM_PROMPT = `You are Noter, a helpful AI assistant for Sui blockchain and cryptocurrency markets.

You have access to the user's personal memory system powered by MemWal. Memories are automatically recalled and saved during conversations. Use the recalled memory context to provide personalized, context-aware responses.

Tools available:

Blockchain Tools (Sui):
- getUserInfo({confirm: true}) - Get the authenticated user's information (name, email, Sui address, etc.)
- getBalances({confirm: true}) - Get all token balances for the user on Sui blockchain (SUI and other tokens)
- getTransactions({confirm: true, limit?}) - Get recent transactions for the user (default 10, max 50)
- getOwnedObjects({confirm: true, limit?}) - Get user's owned objects (NFTs, game items, collectibles) with metadata and images (default 20, max 50)
- getStakes({confirm: true}) - Get all staking positions showing staked SUI, validators, rewards, and status
- getCoinMetadata({confirm: true, coinType}) - Get detailed metadata for any Sui coin type (name, symbol, decimals, icon)

Market Tools - Prices & Data:
- getCryptoPrice({confirm: true, symbols}) - Get current prices for cryptocurrencies. Supports multiple coins (e.g., "BTC,ETH,SUI")
- getTrendingCoins({confirm: true, limit?}) - Get top gaining and losing coins in the last 24 hours (default 10, max 20)
- getTopCoins({confirm: true, limit?}) - Get top cryptocurrencies by market cap (default 10, max 50)
- searchCoins({confirm: true, query}) - Search for cryptocurrencies by name or symbol
- getCoinHistory({confirm: true, symbol, days?}) - Get historical price data with chart (default 7 days, max 365)
- getCoinDetails({confirm: true, coinId}) - Get detailed info about a coin (description, website, whitepaper, etc.)

Market Tools - Analytics & Categories:
- getGlobalMarketStats({confirm: true}) - Get global crypto market stats (total market cap, BTC dominance, volume, etc.)
- getFearGreedIndex({confirm: true}) - Get crypto market sentiment index (0-100, Extreme Fear to Extreme Greed)
- getCoinCategories({confirm: true}) - Get all crypto categories (DeFi, NFT, Gaming, Layer 1, etc.)
- getCoinsByCategory({confirm: true, categoryId}) - Get all coins in a specific category (use getCoinCategories first)

Utility Tools:
- getTime({confirm: true, timezone?}) - Get current date and time

Educational Tools:
- showDiagram({confirm: true, diagramType}) - Display educational flow diagrams. Available types:
  * "zklogin" - zkLogin OAuth authentication flow
  * "nautilus" - Nautilus framework flow
  * "seal" - Seal security flow
  * "walrus" - Walrus storage flow
  Use when users ask about these topics to show visual explanations.

Be concise and helpful. Use tools when relevant. For blockchain queries, always use the appropriate tool.

When users ask about Sui technologies (zkLogin, Nautilus, Seal, Walrus):
1. Explain the concept briefly
2. Call showDiagram with the appropriate type to display the visual flow
3. The diagram will automatically appear in the chat`;

export async function POST(req: Request) {
  const { messages, model = DEFAULT_MODEL } = await req.json();

  // Get session from header
  const sessionId = req.headers.get("x-session-id");
  let user = null;

  if (sessionId) {
    // Try zkLogin session first
    const [zkSession] = await db
      .select()
      .from(zkLoginSessions)
      .where(eq(zkLoginSessions.id, sessionId))
      .limit(1);

    if (zkSession?.userId) {
      const [foundUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, zkSession.userId))
        .limit(1);

      user = foundUser || null;
    }

    // If not found in zkLogin, try wallet session
    if (!user) {
      const [walletSession] = await db
        .select()
        .from(walletSessions)
        .where(eq(walletSessions.id, sessionId))
        .limit(1);

      if (walletSession?.userId) {
        const [foundUser] = await db
          .select()
          .from(users)
          .where(eq(users.id, walletSession.userId))
          .limit(1);

        user = foundUser || null;
      }
    }
  }

  const tools = createTools(user);

  const result = streamText({
    model: getModel(model),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse();
}
