# AI Research Assistant with Remember & Recall

This example shows how the [Researcher App](https://github.com/CommandOSSLabs/MemWal/tree/v2/apps/researcher) uses MemWal to give an AI chatbot **persistent memory across conversations**. The app only uses two SDK methods — `remember()` to store research findings and `recall()` to retrieve them later by meaning.

The Researcher App introduces **sprints** — snapshots of research conversations stored in MemWal. After a research session, the app summarizes the findings into a structured report and stores it with `remember()`. When the user starts a new chat, the app retrieves relevant past findings with `recall()` and feeds them into the AI's context. The user never interacts with MemWal directly — the app handles all the calls behind the scenes.

## Setup

```typescript
import { MemWal } from "@cmdoss/memwal"

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY,  // Ed25519 delegate key (hex)
  serverUrl: process.env.MEMWAL_SERVER_URL,
})
```

The same Ed25519 key is used for both user authentication and MemWal signing. Each user's memories are isolated — you can only recall what you remembered.

## Step 1: Remember — Saving Research Findings

After the user finishes a research conversation, the app saves it as a sprint. Here's what happens behind the scenes:

1. The app uses an LLM to generate a structured report from the chat history
2. The report is formatted as a single text document with title, findings, citations, and sources
3. That text is sent to MemWal via `remember()`

```typescript
// --- App generates a structured report (pseudo code) ---
// report = LLM analyzes chat transcript and produces:
//   title:      "OAuth 2.0 Security Analysis"
//   content:    markdown report with [1], [2] citation markers
//   references: "[1] OWASP Guide — Token Storage (https://...)"
//   sources:    "OWASP Guide, RFC 6749, Web Security Book"

// --- Format the report as a single document ---
const fullText =
  `Sprint Report: ${report.title}\n\n` +
  `${report.content}\n\n` +
  `References:\n${report.references}\n\n` +
  `Sources: ${report.sources}`

// --- Store in MemWal ---
const result = await memwal.remember(fullText)
console.log("Stored:", result.blob_id)
// The server embeds the text, encrypts it, and uploads to Walrus.
// The blob_id is saved to the app's database for reference.
```

**Why structured text?** When the text is recalled later via semantic search, the result includes everything — the report title, the actual findings, which sources they came from, and specific section references. A query like `"token storage best practices"` returns the full structured report, giving the AI rich context to answer with.

**Why not store raw chat transcripts?** Chat transcripts are noisy — they contain back-and-forth dialogue, tool call outputs, failed searches, and tangential discussion. An LLM-generated report distills this into clean, focused findings that recall much better.

## Step 2: Recall — Retrieving Past Research

When the user starts a new chat and selects past sprints to load, the app needs to retrieve those findings from MemWal. A single query might miss important content, so the app generates **multiple diverse queries** per sprint:

```typescript
// --- LLM generates diverse queries from sprint metadata (pseudo code) ---
// Input:  title="OAuth 2.0 Security Analysis", tags=["OWASP", "tokens", "XSS"]
// Output: ["OAuth token storage httpOnly cookies localStorage",
//          "refresh token rotation theft prevention",
//          "XSS cross-site scripting OAuth browser security"]

// --- Execute each query against MemWal ---
for (const query of queries) {
  const result = await memwal.recall(query, 5)

  for (const hit of result.results) {
    console.log(hit.text)      // the remembered text
    console.log(hit.distance)  // lower = more similar (0.0 = exact match)
  }
}
```

The app then deduplicates results (same text from different queries), filters out weak matches (distance too high), and assembles everything into a context block that gets injected into the new chat's system prompt.

**Why multiple queries?** A query like `"OAuth security"` might surface the general findings but miss specific content about refresh tokens or XSS. By generating queries that each target a different angle of the research, the app gets much broader coverage of what was stored.

## Step 3: Recall On-Demand — AI Tool During Chat

Beyond the pre-loaded context, the app also registers `recall()` as a tool the AI can use during conversation. This lets the AI fetch specific past findings when the user asks a question the pre-loaded context doesn't cover:

```typescript
// --- Register as an AI tool (pseudo code) ---
// name: "recallSprint"
// description: "Search long-term memory for past research findings"
// parameters: { query: string, limit: number }

// --- When the AI invokes the tool, execute recall ---
async function onRecallToolCall({ query, limit }) {
  const result = await memwal.recall(query, limit)

  return result.results.map(hit => ({
    text: hit.text,
    relevance: 1 - hit.distance,  // convert to 0-1 scale (higher = better)
  }))
}
```

For example, if the user asks *"What did my research say about refresh tokens?"*, the AI constructs a targeted query and calls the tool:

```
User:  What did my research say about refresh tokens?
AI:    → calls recallSprint("refresh token rotation OAuth security")
       ← MemWal returns the stored sprint report (relevance: 0.87)
AI:    Based on your previous research, RFC 6749 Section 10.4 recommends
       refresh token rotation to reduce the impact of compromised tokens...
```

## How It All Fits Together

```
 
   1. RESEARCH                                                 
      User chats with AI, which searches source documents      
                                                               
   2. SAVE SPRINT                                              
      LLM generates report → memwal.remember(reportText)       
      blob_id saved to database                                
                                                               
   3. NEW CHAT WITH PAST SPRINTS                               
      LLM generates diverse queries from sprint metadata       
      memwal.recall(query, 5) × multiple queries               
      Deduplicate + filter → inject into system prompt          
                                                               
   4. CHAT WITH MEMORY                                         
      Pre-loaded sprint context in every message                
      + recallSprint tool for on-demand queries                 
      AI can always reach back into MemWal when needed          

```

The app only makes **one `remember()` call** per sprint save, and **a handful of `recall()` calls** when preparing a new chat. During the actual conversation, recall is only triggered when the AI decides it needs more detail — most messages are served from the pre-loaded context alone.

## Summary

| What the app does | MemWal method | When it happens |
|---|---|---|
| Save research findings | `memwal.remember(text)` | User clicks "Save Sprint" after a research chat |
| Pre-load past findings | `memwal.recall(query, limit)` | User starts a new chat with sprints selected |
| On-demand memory lookup | `memwal.recall(query, limit)` | AI decides it needs more detail during chat |

Everything else — report generation, query construction, context assembly — is application logic built on top of these two methods.
