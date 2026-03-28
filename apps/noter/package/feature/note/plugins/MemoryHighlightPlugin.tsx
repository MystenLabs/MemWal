/**
 * MEMORY HIGHLIGHT PLUGIN — Lexical plugin for memory highlights
 *
 * Provides commands to inject and update MemoryHighlightNodes in the editor.
 * Handles click events and hover previews for memory highlights.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect, useState, useCallback, useRef } from "react";
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  CLICK_COMMAND,
  createCommand,
  type LexicalCommand,
  type TextNode,
} from "lexical";
import {
  $createMemoryHighlightNode,
  $isMemoryHighlightNode,
  type MemoryHighlightNode,
  type MemoryStatus,
  type MemoryCategory,
} from "../nodes/MemoryHighlightNode";
import { MemoryHoverPreview } from "../ui/memory-hover-preview";
import type { MemoryData } from "@/shared/db/type";

// ═══════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════

export type InjectMemoryPayload = {
  text: string;
  category: MemoryCategory;
  importance: number;
  embedding?: number[];
};

export type UpdateMemoryStatusPayload = {
  memoryId: string;
  status: MemoryStatus;
  meta?: {
    memwalMemoryId?: string;
    memwalBlobId?: string;
    suiTxDigest?: string;
    errorMessage?: string;
  };
};

export type RemoveMemoryPayload = {
  memoryId: string;
};

export const INJECT_MEMORY_HIGHLIGHTS_COMMAND: LexicalCommand<InjectMemoryPayload[]> =
  createCommand("INJECT_MEMORY_HIGHLIGHTS_COMMAND");

export const UPDATE_MEMORY_STATUS_COMMAND: LexicalCommand<UpdateMemoryStatusPayload> =
  createCommand("UPDATE_MEMORY_STATUS_COMMAND");

export const REMOVE_MEMORY_HIGHLIGHT_COMMAND: LexicalCommand<RemoveMemoryPayload> =
  createCommand("REMOVE_MEMORY_HIGHLIGHT_COMMAND");

// ═══════════════════════════════════════════════════════════════
// PLUGIN
// ═══════════════════════════════════════════════════════════════

export interface MemoryHighlightPluginProps {
  onHighlightClick?: (memoryId: string) => void;
}

export function MemoryHighlightPlugin({
  onHighlightClick,
}: MemoryHighlightPluginProps) {
  const [editor] = useLexicalComposerContext();
  const [hoveredMemory, setHoveredMemory] = useState<MemoryData | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number } | null>(null);
  const [hoverTimeout, setHoverTimeout] = useState<NodeJS.Timeout | null>(null);
  const [hideTimeout, setHideTimeout] = useState<NodeJS.Timeout | null>(null);
  const currentMemoryIdRef = useRef<string | null>(null);

  useEffect(() => {
    // ───────────────────────────────────────────────────────────
    // COMMAND: Inject memory highlights into editor
    // ───────────────────────────────────────────────────────────

    const unregisterInject = editor.registerCommand(
      INJECT_MEMORY_HIGHLIGHTS_COMMAND,
      (memories: InjectMemoryPayload[]) => {
        editor.update(() => {
          const root = $getRoot();
          const fullText = root.getTextContent();
          // Track already-used positions to avoid matching the same text twice
          const usedPositions = new Set<number>();

          memories.forEach((memory, idx) => {
            // Trim memory text to handle whitespace differences
            const trimmedMemoryText = memory.text.trim();

            // Track which text version we actually matched
            let index = -1;
            let matchedText = memory.text;

            // Find all occurrences of the text, not just the first one
            // Prefer matches that align with word boundaries
            const findUnusedOccurrence = (searchText: string): number => {
              const candidates: Array<{ index: number; score: number }> = [];
              let searchIndex = 0;

              while (searchIndex < fullText.length) {
                const foundIndex = fullText.indexOf(searchText, searchIndex);
                if (foundIndex === -1) break;

                // Check if this position is already used
                if (!usedPositions.has(foundIndex)) {
                  // Score this match based on word boundary alignment
                  let score = 0;

                  // Check if it starts at a word boundary
                  const charBefore = foundIndex > 0 ? fullText[foundIndex - 1] : ' ';
                  const isWordStart = /[\s\n.,!?;:]/.test(charBefore) || foundIndex === 0;
                  if (isWordStart) score += 2;

                  // Check if it ends at a word boundary
                  const endIndex = foundIndex + searchText.length;
                  const charAfter = endIndex < fullText.length ? fullText[endIndex] : ' ';
                  const isWordEnd = /[\s\n.,!?;:]/.test(charAfter) || endIndex === fullText.length;
                  if (isWordEnd) score += 2;

                  candidates.push({ index: foundIndex, score });
                }

                // Move past this occurrence
                searchIndex = foundIndex + 1;
              }

              if (candidates.length === 0) return -1;

              // Return the candidate with the highest score (best word boundary alignment)
              candidates.sort((a, b) => b.score - a.score);

              if (candidates.length > 1) {              }

              return candidates[0].index;
            };

            // Try to find an unused occurrence with original text
            index = findUnusedOccurrence(memory.text);

            // If that fails, try with trimmed version
            if (index === -1) {
              index = findUnusedOccurrence(trimmedMemoryText);
              if (index !== -1) {
                matchedText = trimmedMemoryText;
              }
            }

            // If that fails, try fuzzy match: case-insensitive search,
            // then find the best overlapping substring between LLM text and editor text
            if (index === -1) {
              const lowerFull = fullText.toLowerCase();
              const lowerMemory = trimmedMemoryText.toLowerCase();

              // Strategy 1: case-insensitive exact match
              const ciIndex = lowerFull.indexOf(lowerMemory);
              if (ciIndex !== -1 && !usedPositions.has(ciIndex)) {
                index = ciIndex;
                matchedText = fullText.slice(ciIndex, ciIndex + trimmedMemoryText.length);
              }

              // Strategy 2: find longest common substring (min 10 chars)
              if (index === -1) {
                let best = { start: -1, len: 0 };
                for (let i = 0; i < lowerFull.length; i++) {
                  for (let j = 0; j < lowerMemory.length; j++) {
                    if (lowerFull[i] !== lowerMemory[j]) continue;
                    let k = 0;
                    while (i + k < lowerFull.length && j + k < lowerMemory.length && lowerFull[i + k] === lowerMemory[j + k]) {
                      k++;
                    }
                    if (k > best.len) {
                      best = { start: i, len: k };
                    }
                  }
                }
                if (best.len >= 10 && !usedPositions.has(best.start)) {
                  index = best.start;
                  matchedText = fullText.slice(best.start, best.start + best.len);
                }
              }
            }

            // If still not found, log detailed debug info
            if (index === -1) {
              console.warn(
                `[MemoryHighlightPlugin] Memory ${idx} text not found (all occurrences already used)`
              );
              console.warn(`Memory text:`, memory.text.substring(0, 50));
              return;
            }

            // Mark this position as used
            usedPositions.add(index);

            // Find text nodes containing this memory
            let currentOffset = 0;
            const textNodes = root.getAllTextNodes();

            for (const node of textNodes) {
              if (!$isTextNode(node) || $isMemoryHighlightNode(node)) {
                currentOffset += node.getTextContent().length;
                continue;
              }

              const nodeText = node.getTextContent();
              const nodeLength = nodeText.length;
              const nodeStart = currentOffset;
              const nodeEnd = currentOffset + nodeLength;

              // Check if this node contains the memory start
              if (index >= nodeStart && index < nodeEnd) {
                const relativeStart = index - nodeStart;
                const memoryEnd = index + matchedText.length; // Use the matched text length!
                const relativeEnd = Math.min(memoryEnd - nodeStart, nodeLength);

                // Verify what we're about to highlight
                const actualTextInEditor = fullText.substring(index, index + matchedText.length);
                if (actualTextInEditor !== matchedText) {
                  console.warn(
                    `[MemoryHighlightPlugin] TEXT MISMATCH at position ${index}!`,
                    `\nExpected: "${matchedText.substring(0, 50)}"`,
                    `\nActual: "${actualTextInEditor.substring(0, 50)}"`
                  );
                }
                // Create memory highlight node with the matched (trimmed) text
                const memoryNode = $createMemoryHighlightNode(
                  matchedText, // Use the actual matched text, not the original
                  crypto.randomUUID(), // Generate unique ID
                  "pending", // Initial status
                  memory.category,
                  memory.importance
                );

                if (memory.embedding) {
                  memoryNode.setEmbedding(memory.embedding);
                }

                // Replace text with memory node
                if (relativeStart === 0 && relativeEnd === nodeLength) {
                  // Entire node is the memory
                  node.replace(memoryNode);
                } else if (relativeStart === 0) {
                  // Memory at start of node
                  const [memoryPart, rest] = node.splitText(relativeEnd);
                  memoryPart.replace(memoryNode);
                } else if (relativeEnd === nodeLength) {
                  // Memory at end of node
                  const [before, memoryPart] = node.splitText(relativeStart);
                  memoryPart.replace(memoryNode);
                } else {
                  // Memory in middle of node
                  const [before, memoryPart, after] = node.splitText(
                    relativeStart,
                    relativeEnd
                  );
                  memoryPart.replace(memoryNode);
                }                break;
              }

              currentOffset += nodeLength;
            }
          });
        });

        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    // ───────────────────────────────────────────────────────────
    // COMMAND: Update memory status
    // ───────────────────────────────────────────────────────────

    const unregisterUpdate = editor.registerCommand(
      UPDATE_MEMORY_STATUS_COMMAND,
      (payload: UpdateMemoryStatusPayload) => {
        editor.update(() => {
          const root = $getRoot();
          const allNodes = root.getAllTextNodes();

          for (const node of allNodes) {
            if (
              $isMemoryHighlightNode(node) &&
              node.getMemoryId() === payload.memoryId
            ) {
              node.updateStatus(payload.status, payload.meta);              break;
            }
          }
        });

        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    // ───────────────────────────────────────────────────────────
    // COMMAND: Remove memory highlight
    // ───────────────────────────────────────────────────────────

    const unregisterRemove = editor.registerCommand(
      REMOVE_MEMORY_HIGHLIGHT_COMMAND,
      (payload: RemoveMemoryPayload) => {
        editor.update(() => {
          const root = $getRoot();
          const allNodes = root.getAllTextNodes();

          for (const node of allNodes) {
            if (
              $isMemoryHighlightNode(node) &&
              node.getMemoryId() === payload.memoryId
            ) {
              // Replace memory node with plain text
              const textNode = $createTextNode(node.getTextContent());
              node.replace(textNode);              break;
            }
          }
        });

        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    // ───────────────────────────────────────────────────────────
    // COMMAND: Handle clicks on memory highlights
    // ───────────────────────────────────────────────────────────

    const unregisterClick = editor.registerCommand(
      CLICK_COMMAND,
      (event: MouseEvent) => {
        const target = event.target as HTMLElement;
        const memoryId = target.getAttribute("data-memory-id");

        if (memoryId && onHighlightClick) {          onHighlightClick(memoryId);
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_LOW
    );

    // ───────────────────────────────────────────────────────────
    // HOVER HANDLING: Show preview on hover (anti-flicker logic)
    // ───────────────────────────────────────────────────────────

    const handleMouseOver = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const memoryId = target.getAttribute("data-memory-id");

      if (!memoryId) {
        return;
      }

      // If we're already showing this memory, don't restart the timeout
      if (currentMemoryIdRef.current === memoryId) {
        // Cancel any pending hide timeout since we're still hovering
        if (hideTimeout) {
          clearTimeout(hideTimeout);
          setHideTimeout(null);
        }
        return;
      }

      // Clear any pending show timeout
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
      }

      // Delay showing preview to avoid accidental triggers
      const timeout = setTimeout(() => {
        editor.getEditorState().read(() => {
          const memory = $getMemoryById(memoryId);
          if (memory) {
            const rect = target.getBoundingClientRect();
            currentMemoryIdRef.current = memoryId;
            setHoveredMemory(memory.getMemoryData());
            setHoverPosition({
              x: rect.left,
              y: rect.bottom + 8, // 8px below the highlight
            });
          }
        });
      }, 500); // 500ms delay to prevent accidental triggers

      setHoverTimeout(timeout);
    };

    const handleMouseOut = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const memoryId = target.getAttribute("data-memory-id");

      if (!memoryId) {
        return;
      }

      // Clear any pending show timeout
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        setHoverTimeout(null);
      }

      // Don't hide immediately - add a delay to allow moving to the preview card
      const timeout = setTimeout(() => {
        currentMemoryIdRef.current = null;
        setHoveredMemory(null);
        setHoverPosition(null);
      }, 200); // 200ms delay before hiding

      setHideTimeout(timeout);
    };

    // Get editor root element
    const editorElement = editor.getRootElement();
    if (editorElement) {
      editorElement.addEventListener("mouseover", handleMouseOver);
      editorElement.addEventListener("mouseout", handleMouseOut);
    }

    return () => {
      unregisterInject();
      unregisterUpdate();
      unregisterRemove();
      unregisterClick();

      // Clean up timeouts
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
      }
      if (hideTimeout) {
        clearTimeout(hideTimeout);
      }

      // Remove event listeners
      if (editorElement) {
        editorElement.removeEventListener("mouseover", handleMouseOver);
        editorElement.removeEventListener("mouseout", handleMouseOut);
      }
    };
  }, [editor, onHighlightClick, hoverTimeout, hideTimeout]);

  // Close hover preview handler
  const handleClosePreview = useCallback(() => {
    setHoveredMemory(null);
    setHoverPosition(null);
  }, []);

  return (
    <>
      <MemoryHoverPreview
        memory={hoveredMemory}
        position={hoverPosition}
        onClose={handleClosePreview}
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Get all memories from editor state
// ═══════════════════════════════════════════════════════════════

export function $getAllMemories(): MemoryHighlightNode[] {
  const root = $getRoot();
  const allNodes = root.getAllTextNodes();
  return allNodes.filter($isMemoryHighlightNode);
}

export function $getMemoryById(memoryId: string): MemoryHighlightNode | null {
  const memories = $getAllMemories();
  return memories.find((m) => m.getMemoryId() === memoryId) || null;
}
