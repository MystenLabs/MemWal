# Plan: Add PDF Parser Feature to PDW SDK

## Overview

Add PDF parsing capability to the Personal Data Wallet SDK, allowing users to upload PDF files and automatically convert them into chunked, searchable memories stored on blockchain + Walrus.

## Current State Analysis

### What Exists:
- `MemoryNamespace.create(content: string)` - Creates single memory from text
- `MemoryNamespace.createBatch(contents: string[])` - Creates multiple memories
- `BatchNamespace.createMany()` - Batch processing with progress tracking
- `EmbeddingService` - Generates 3072-dim embeddings (Google/OpenRouter)
- `StorageService.uploadMemoryPackage()` - Uploads to Walrus
- LangChain integration with `PDWVectorStore.addDocuments()`

### What's Missing:
- No PDF parsing library
- No text chunking/splitting utilities
- No document loader infrastructure

---

## Implementation Plan

### Phase 1: Core Utilities

#### 1.1 Create Text Chunking Utility
**File:** `packages/pdw-sdk/src/utils/textChunker.ts`

```typescript
export interface ChunkOptions {
  chunkSize?: number;      // Default: 1000 chars
  chunkOverlap?: number;   // Default: 200 chars
  separators?: string[];   // Default: ['\n\n', '\n', '. ', ' ']
}

export interface TextChunk {
  content: string;
  index: number;
  startChar: number;
  endChar: number;
  metadata?: Record<string, any>;
}

export function chunkText(text: string, options?: ChunkOptions): TextChunk[];
export function chunkByParagraphs(text: string): TextChunk[];
export function chunkBySentences(text: string, maxChunkSize?: number): TextChunk[];
```

#### 1.2 Create PDF Parser Utility
**File:** `packages/pdw-sdk/src/utils/pdfParser.ts`

```typescript
export interface PDFParseOptions {
  extractImages?: boolean;      // Future: extract images
  preserveFormatting?: boolean; // Keep line breaks
  pageRange?: [number, number]; // Parse specific pages
}

export interface PDFParseResult {
  text: string;
  pages: Array<{ pageNumber: number; content: string }>;
  metadata: {
    title?: string;
    author?: string;
    creationDate?: Date;
    pageCount: number;
    wordCount: number;
  };
}

export async function parsePDF(input: Buffer | Uint8Array | string, options?: PDFParseOptions): Promise<PDFParseResult>;
```

**Dependency:** `pdf-parse` (lightweight, works in Node.js)

---

### Phase 2: Document Namespace

#### 2.1 Create DocumentNamespace
**File:** `packages/pdw-sdk/src/client/namespaces/DocumentNamespace.ts`

```typescript
export interface DocumentOptions {
  category?: string;
  importance?: number;
  topic?: string;
  chunkOptions?: ChunkOptions;
  onProgress?: (stage: string, percent: number, message?: string) => void;
}

export interface DocumentResult {
  documentId: string;          // Unique ID for the document
  sourceFile?: string;         // Original filename
  totalChunks: number;
  memories: Array<{ id: string; blobId: string; chunkIndex: number }>;
  metadata: Record<string, any>;
}

export class DocumentNamespace {
  // Parse and store PDF as chunked memories
  async createFromPDF(
    input: Buffer | Uint8Array | string,
    options?: DocumentOptions
  ): Promise<DocumentResult>;

  // Parse and store plain text as chunked memories
  async createFromText(
    text: string,
    options?: DocumentOptions
  ): Promise<DocumentResult>;

  // Get all chunks for a document
  async getChunks(documentId: string): Promise<Memory[]>;

  // Delete all chunks for a document
  async deleteDocument(documentId: string): Promise<number>;

  // Search within a specific document
  async searchInDocument(documentId: string, query: string, limit?: number): Promise<SearchResult[]>;
}
```

---

### Phase 3: Integration

#### 3.1 Update SimplePDWClient
**File:** `packages/pdw-sdk/src/client/SimplePDWClient.ts`

Add new namespace:
```typescript
public readonly document: DocumentNamespace;

// In constructor:
this.document = new DocumentNamespace(this.services);
```

#### 3.2 Export new utilities
**File:** `packages/pdw-sdk/src/index.ts`

```typescript
// Utils
export { chunkText, chunkByParagraphs, chunkBySentences } from './utils/textChunker';
export { parsePDF } from './utils/pdfParser';
export type { ChunkOptions, TextChunk, PDFParseOptions, PDFParseResult } from './utils/textChunker';

// Namespace
export { DocumentNamespace } from './client/namespaces/DocumentNamespace';
export type { DocumentOptions, DocumentResult } from './client/namespaces/DocumentNamespace';
```

---

### Phase 4: Dependencies

Add PDF parsing library:
```bash
pnpm add pdf-parse
pnpm add -D @types/pdf-parse
```

---

## API Usage Examples

### Basic PDF Upload
```typescript
const pdw = new SimplePDWClient({ ... });
await pdw.ready();

// Upload PDF and create memories
const result = await pdw.document.createFromPDF(pdfBuffer, {
  topic: 'research-paper',
  category: 'note',
  chunkOptions: { chunkSize: 1000, chunkOverlap: 200 },
  onProgress: (stage, percent) => console.log(`${stage}: ${percent}%`)
});

console.log(`Created ${result.totalChunks} memories from PDF`);
// Created 25 memories from PDF
```

### Search within document
```typescript
const results = await pdw.document.searchInDocument(
  result.documentId,
  'machine learning algorithms',
  5
);
```

### Low-level chunking
```typescript
import { parsePDF, chunkText } from 'personal-data-wallet-sdk';

const pdfResult = await parsePDF(pdfBuffer);
const chunks = chunkText(pdfResult.text, { chunkSize: 500 });

// Manual batch create
const memories = await pdw.memory.createBatch(
  chunks.map(c => c.content),
  { category: 'document' }
);
```

---

## File Structure

```
packages/pdw-sdk/src/
├── utils/
│   ├── index.ts              # Export utilities
│   ├── textChunker.ts        # NEW: Text chunking
│   └── pdfParser.ts          # NEW: PDF parsing
├── client/
│   ├── namespaces/
│   │   ├── DocumentNamespace.ts  # NEW: Document handling
│   │   └── ...
│   └── SimplePDWClient.ts    # UPDATE: Add document namespace
└── index.ts                  # UPDATE: Export new modules
```

---

## Implementation Order

1. **textChunker.ts** - Core chunking logic (no dependencies)
2. **pdfParser.ts** - PDF extraction (add pdf-parse dependency)
3. **DocumentNamespace.ts** - High-level API
4. **SimplePDWClient.ts** - Integration
5. **index.ts** - Exports
6. **README.md** - Documentation
7. **Tests** - Unit tests for chunking and parsing

---

## Estimated Changes

| File | Action | Lines |
|------|--------|-------|
| `utils/textChunker.ts` | CREATE | ~150 |
| `utils/pdfParser.ts` | CREATE | ~100 |
| `client/namespaces/DocumentNamespace.ts` | CREATE | ~250 |
| `client/SimplePDWClient.ts` | UPDATE | ~10 |
| `index.ts` | UPDATE | ~10 |
| `utils/index.ts` | UPDATE | ~5 |
| `package.json` | UPDATE | ~2 |

**Total:** ~530 lines of new code

---

## Design Decisions

1. **PDF Library**: `pdf-parse` (Node.js only, lightweight ~50KB)
   - Can add browser support with `pdfjs-dist` in future version

2. **Default chunk size**: 1000 chars with 200 char overlap
   - Balanced approach for RAG use cases
   - Configurable via `ChunkOptions`

3. **Chunk metadata**: Yes, include page metadata by default
   - Each chunk tagged with `{ page: number, chunkIndex: number, documentId: string }`
   - Enables document-scoped search and chunk navigation

---

## Ready for Implementation

This plan is complete and ready to execute. Implementation order:
1. Add `pdf-parse` dependency
2. Create `textChunker.ts`
3. Create `pdfParser.ts`
4. Create `DocumentNamespace.ts`
5. Integrate into `SimplePDWClient.ts`
6. Update exports
7. Update README with documentation
