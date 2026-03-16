/**
 * MEMORY HIGHLIGHT NODE — Custom Lexical node for memory highlights
 *
 * Stores all memory data directly in the EditorState (no separate DB table).
 * Extends TextNode to render highlighted text with status-based styling.
 */

import type {
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  EditorConfig,
  LexicalNode,
  NodeKey,
  SerializedTextNode,
  Spread,
} from "lexical";

import { $applyNodeReplacement, TextNode } from "lexical";

export type MemoryStatus =
  | "pending"    // Awaiting user approval
  | "signing"    // User signing in wallet
  | "uploading"  // Uploading to Walrus
  | "indexing"   // Adding to HNSW index
  | "saved"      // Successfully saved to blockchain
  | "error"      // Failed to save
  | "rejected";  // User rejected

export type MemoryCategory =
  | "note"
  | "fact"
  | "preference"
  | "todo"
  | "general";

export type SerializedMemoryHighlightNode = Spread<
  {
    memoryId: string;
    status: MemoryStatus;
    category: MemoryCategory;
    importance: number;
    embedding?: number[];
    memwalMemoryId?: string;
    memwalBlobId?: string;
    suiTxDigest?: string;
    createdAt: string;
    savedAt?: string;
    errorMessage?: string;
  },
  SerializedTextNode
>;

/**
 * Custom TextNode that represents a memory highlight
 */
export class MemoryHighlightNode extends TextNode {
  __memoryId: string;
  __status: MemoryStatus;
  __category: MemoryCategory;
  __importance: number;
  __embedding?: number[];
  __memwalMemoryId?: string;
  __memwalBlobId?: string;
  __suiTxDigest?: string;
  __createdAt: string;
  __savedAt?: string;
  __errorMessage?: string;

  static getType(): string {
    return "memory-highlight";
  }

  static clone(node: MemoryHighlightNode): MemoryHighlightNode {
    return new MemoryHighlightNode(
      node.__text,
      node.__memoryId,
      node.__status,
      node.__category,
      node.__importance,
      node.__key
    );
  }

  constructor(
    text: string,
    memoryId: string,
    status: MemoryStatus,
    category: MemoryCategory,
    importance: number,
    key?: NodeKey
  ) {
    super(text, key);
    this.__memoryId = memoryId;
    this.__status = status;
    this.__category = category;
    this.__importance = importance;
    this.__createdAt = new Date().toISOString();
  }

  // ════════════════════════════════════════════════════════════════
  // SERIALIZATION
  // ════════════════════════════════════════════════════════════════

  exportJSON(): SerializedMemoryHighlightNode {
    return {
      ...super.exportJSON(),
      type: "memory-highlight",
      version: 1,
      memoryId: this.__memoryId,
      status: this.__status,
      category: this.__category,
      importance: this.__importance,
      embedding: this.__embedding,
      memwalMemoryId: this.__memwalMemoryId,
      memwalBlobId: this.__memwalBlobId,
      suiTxDigest: this.__suiTxDigest,
      createdAt: this.__createdAt,
      savedAt: this.__savedAt,
      errorMessage: this.__errorMessage,
    };
  }

  static importJSON(
    serializedNode: SerializedMemoryHighlightNode
  ): MemoryHighlightNode {    const node = $createMemoryHighlightNode(
      serializedNode.text,
      serializedNode.memoryId,
      serializedNode.status,
      serializedNode.category,
      serializedNode.importance
    );
    node.setFormat(serializedNode.format);
    node.setDetail(serializedNode.detail);
    node.setMode(serializedNode.mode);
    node.setStyle(serializedNode.style);

    // Restore metadata
    const writable = node.getWritable();
    writable.__embedding = serializedNode.embedding;
    writable.__memwalMemoryId = serializedNode.memwalMemoryId;
    writable.__memwalBlobId = serializedNode.memwalBlobId;
    writable.__suiTxDigest = serializedNode.suiTxDigest;
    writable.__createdAt = serializedNode.createdAt;
    writable.__savedAt = serializedNode.savedAt;
    writable.__errorMessage = serializedNode.errorMessage;

    return node;
  }

  // ════════════════════════════════════════════════════════════════
  // DOM RENDERING
  // ════════════════════════════════════════════════════════════════

  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);

    // Add memory highlight classes
    element.classList.add("memory-highlight");
    element.classList.add(`memory-highlight--${this.__status}`);

    // Store memory data attributes for styling and interaction
    element.setAttribute("data-memory-id", this.__memoryId);
    element.setAttribute("data-memory-status", this.__status);
    element.setAttribute("data-memory-category", this.__category);
    element.setAttribute("data-importance", this.__importance.toString());

    // Add aria attributes for accessibility
    element.setAttribute("role", "mark");
    element.setAttribute("aria-label", `Memory: ${this.__category}, importance ${this.__importance}/10, status: ${this.__status}`);
    element.setAttribute("tabindex", "0");

    // Make clickable
    element.style.cursor = "pointer";

    return element;
  }

  updateDOM(
    prevNode: MemoryHighlightNode,
    dom: HTMLElement,
    config: EditorConfig
  ): boolean {
    const isUpdated = super.updateDOM(prevNode as this, dom, config);

    // Update classes and attributes if status changed
    if (prevNode.__status !== this.__status) {
      dom.classList.remove(`memory-highlight--${prevNode.__status}`);
      dom.classList.add(`memory-highlight--${this.__status}`);
      dom.setAttribute("data-memory-status", this.__status);
      dom.setAttribute("aria-label", `Memory: ${this.__category}, importance ${this.__importance}/10, status: ${this.__status}`);

      // Trigger status change animation
      dom.classList.add("status-changing");
      setTimeout(() => {
        dom.classList.remove("status-changing");
      }, 500);
    }

    return isUpdated;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("mark");
    element.textContent = this.__text;
    element.className = `memory-highlight memory-highlight--${this.__status}`;
    element.setAttribute("data-memory-id", this.__memoryId);
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      mark: (node: Node) => ({
        conversion: convertMemoryHighlightElement,
        priority: 1,
      }),
    };
  }

  // ════════════════════════════════════════════════════════════════
  // MEMORY-SPECIFIC METHODS
  // ════════════════════════════════════════════════════════════════

  getMemoryId(): string {
    return this.__memoryId;
  }

  getStatus(): MemoryStatus {
    return this.__status;
  }

  getCategory(): MemoryCategory {
    return this.__category;
  }

  getImportance(): number {
    return this.__importance;
  }

  getEmbedding(): number[] | undefined {
    return this.__embedding;
  }

  getMemwalData(): {
    memoryId?: string;
    blobId?: string;
    txDigest?: string;
  } {
    return {
      memoryId: this.__memwalMemoryId,
      blobId: this.__memwalBlobId,
      txDigest: this.__suiTxDigest,
    };
  }

  /**
   * Update memory status (pending → signing → uploading → saved)
   */
  updateStatus(
    status: MemoryStatus,
    meta?: {
      memwalMemoryId?: string;
      memwalBlobId?: string;
      suiTxDigest?: string;
      errorMessage?: string;
    }
  ): void {
    const writable = this.getWritable();
    writable.__status = status;

    if (meta?.memwalMemoryId) writable.__memwalMemoryId = meta.memwalMemoryId;
    if (meta?.memwalBlobId) writable.__memwalBlobId = meta.memwalBlobId;
    if (meta?.suiTxDigest) writable.__suiTxDigest = meta.suiTxDigest;
    if (meta?.errorMessage) writable.__errorMessage = meta.errorMessage;

    if (status === "saved") {
      writable.__savedAt = new Date().toISOString();
    }
  }

  /**
   * Set embedding data (from AI extraction)
   */
  setEmbedding(embedding: number[]): void {
    const writable = this.getWritable();
    writable.__embedding = embedding;
  }

  /**
   * Check if memory is saved to blockchain
   */
  isSaved(): boolean {
    return this.__status === "saved" && !!this.__memwalMemoryId;
  }

  /**
   * Check if memory is pending approval
   */
  isPending(): boolean {
    return this.__status === "pending";
  }

  /**
   * Get full memory data for display/export
   */
  getMemoryData() {
    return {
      id: this.__memoryId,
      text: this.getTextContent(),
      status: this.__status,
      category: this.__category,
      importance: this.__importance,
      embedding: this.__embedding,
      memwalMemoryId: this.__memwalMemoryId,
      memwalBlobId: this.__memwalBlobId,
      suiTxDigest: this.__suiTxDigest,
      createdAt: this.__createdAt,
      savedAt: this.__savedAt,
      errorMessage: this.__errorMessage,
    };
  }
}

// ════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════

function convertMemoryHighlightElement(
  domNode: Node
): DOMConversionOutput | null {
  const element = domNode as HTMLElement;
  const memoryId = element.getAttribute("data-memory-id");

  if (!memoryId) {
    return null;
  }

  const text = element.textContent || "";
  const status = (element.getAttribute("data-memory-status") as MemoryStatus) || "pending";
  const category = (element.getAttribute("data-memory-category") as MemoryCategory) || "general";

  const node = $createMemoryHighlightNode(text, memoryId, status, category, 5);

  return { node };
}

/**
 * Create a new MemoryHighlightNode
 */
export function $createMemoryHighlightNode(
  text: string,
  memoryId: string,
  status: MemoryStatus,
  category: MemoryCategory,
  importance: number
): MemoryHighlightNode {
  return $applyNodeReplacement(
    new MemoryHighlightNode(text, memoryId, status, category, importance)
  );
}

/**
 * Type guard to check if a node is a MemoryHighlightNode
 */
export function $isMemoryHighlightNode(
  node: LexicalNode | null | undefined
): node is MemoryHighlightNode {
  return node instanceof MemoryHighlightNode;
}
