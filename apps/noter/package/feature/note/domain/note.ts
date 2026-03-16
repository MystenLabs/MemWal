/**
 * DOMAIN LOGIC — Pure functions (no DB, no async)
 */

import type { SerializedEditorState, SerializedLexicalNode } from "lexical";

/**
 * Extract plain text from Lexical EditorState JSON
 * Recursively traverses the node tree and concatenates text content
 */
export const extractPlainText = (
  editorState: SerializedEditorState | any
): string => {
  if (!editorState || typeof editorState !== "object") {
    return "";
  }

  // Handle Lexical EditorState format
  const root = editorState.root || editorState;

  const extractFromNode = (node: SerializedLexicalNode | any): string => {
    if (!node) return "";

    // Text node
    if (node.type === "text" && node.text) {
      return node.text;
    }

    // Paragraph node with newline
    if (node.type === "paragraph" && node.children) {
      const text = node.children.map(extractFromNode).join("");
      return text + "\n";
    }

    // Heading node with newline
    if (node.type === "heading" && node.children) {
      const text = node.children.map(extractFromNode).join("");
      return text + "\n";
    }

    // Recursively process children
    if (node.children && Array.isArray(node.children)) {
      return node.children.map(extractFromNode).join("");
    }

    return "";
  };

  return extractFromNode(root).trim();
};

/**
 * Find text offset in Lexical EditorState
 * Returns start and end character positions for a given text snippet
 */
export const findTextOffset = (
  editorState: SerializedEditorState | any,
  searchText: string
): { startOffset: number; endOffset: number } => {
  const plainText = extractPlainText(editorState);
  const startOffset = plainText.indexOf(searchText);

  if (startOffset === -1) {
    // Text not found, return 0
    return { startOffset: 0, endOffset: 0 };
  }

  return {
    startOffset,
    endOffset: startOffset + searchText.length,
  };
};

/**
 * Generate note title from content
 * Takes first non-empty line or returns default
 */
export const generateNoteTitle = (
  editorState: SerializedEditorState | any,
  maxLength: number = 50
): string => {
  const plainText = extractPlainText(editorState);
  const lines = plainText.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return "Untitled Note";
  }

  const firstLine = lines[0].trim();

  if (firstLine.length <= maxLength) {
    return firstLine;
  }

  return firstLine.slice(0, maxLength) + "...";
};

/**
 * Check if note content is empty
 */
export const isNoteEmpty = (editorState: SerializedEditorState | any): boolean => {
  const plainText = extractPlainText(editorState);
  return plainText.trim().length === 0;
};

/**
 * Get word count from note content
 */
export const getWordCount = (editorState: SerializedEditorState | any): number => {
  const plainText = extractPlainText(editorState);
  const words = plainText
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  return words.length;
};
