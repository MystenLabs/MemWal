/**
 * MemWal V2 — Usage Examples
 *
 * Shows how to use the MemWal SDK with Ed25519 delegate key auth.
 * The SDK only needs a single key — server derives owner from onchain lookup.
 */

import { MemWal } from "@cmdoss/memwal-v2";

// ============================================================
// Basic Usage: Remember + Recall
// ============================================================

async function basicExample() {
    // Only one key needed — your Ed25519 delegate key (hex)
    const memwal = MemWal.create({
        key: process.env.MEMWAL_KEY!,
        serverUrl: "http://localhost:3001",
    });

    // Check server health
    const health = await memwal.health();
    console.log("Server:", health);

    // Remember something
    // Server: verify → embed → encrypt → Walrus upload → store
    const result = await memwal.remember("I'm allergic to peanuts");
    console.log("Saved:", result);
    // → { id: "...", blobId: "TY8mW...", owner: "0x3103..." }

    // Recall memories
    // Server: verify → embed query → search → Walrus download → decrypt
    const memories = await memwal.recall("food allergies");
    console.log("Found:", memories.total, "memories");
    for (const m of memories.results) {
        console.log(`  - ${m.text} (relevance: ${(1 - m.distance).toFixed(2)})`);
    }
    // → "I'm allergic to peanuts" (relevance: 0.92)
}

// ============================================================
// AI SDK Integration: withMemWal middleware
// ============================================================

import { generateText } from "ai";
import { withMemWal } from "@cmdoss/memwal-v2/ai";
// import { openai } from "@ai-sdk/openai";

async function aiExample() {
    // Wrap any Vercel AI SDK model with MemWal
    // The middleware automatically:
    //   BEFORE: recalls memories → injects into system prompt
    //   AFTER:  saves user message as memory (fire-and-forget)

    // const model = withMemWal(openai("gpt-4o"), {
    //     key: process.env.MEMWAL_KEY!,
    //     maxMemories: 5,     // inject up to 5 memories (default)
    //     autoSave: true,     // save user messages as memories (default)
    //     minRelevance: 0.3,  // minimum similarity to include (default)
    // });
    //
    // // First conversation — saves memory
    // await generateText({
    //     model,
    //     messages: [
    //         { role: "user", content: "I'm allergic to peanuts and I live in Hanoi" }
    //     ]
    // });
    //
    // // Later conversation — recalls memory automatically
    // const result = await generateText({
    //     model,
    //     messages: [
    //         { role: "user", content: "What foods should I avoid?" }
    //     ]
    // });
    // → LLM prompt includes: "User is allergic to peanuts"
    // → Response uses this context automatically
}

// ============================================================
// Multiple memories example
// ============================================================

async function multiMemoryExample() {
    const memwal = MemWal.create({ key: process.env.MEMWAL_KEY! });

    // Save multiple facts
    await memwal.remember("I prefer dark mode in all apps");
    await memwal.remember("My favorite programming language is Rust");
    await memwal.remember("I'm working on a blockchain project called MemWal");
    await memwal.remember("I usually code between 10pm and 3am");

    // Semantic search — finds relevant memories even with different wording
    const coding = await memwal.recall("what language do I use for development?");
    console.log(coding.results[0].text);
    // → "My favorite programming language is Rust"

    const schedule = await memwal.recall("when am I most productive?");
    console.log(schedule.results[0].text);
    // → "I usually code between 10pm and 3am"
}
