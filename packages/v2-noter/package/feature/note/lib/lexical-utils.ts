/**
 * LEXICAL UTILITIES — Helper functions for Lexical editor
 */

import type { LexicalEditor, TextNode } from "lexical";
import { $getRoot, $getSelection, $isRangeSelection } from "lexical";

/**
 * Insert a node at a specific character offset in the editor
 */
export const insertNodeAtOffset = (
  editor: LexicalEditor,
  node: any,
  offset: number
) => {
  editor.update(() => {
    const root = $getRoot();
    let currentOffset = 0;

    // Traverse nodes to find the target position
    const textNodes = root.getAllTextNodes();

    for (const textNode of textNodes) {
      const textLength = textNode.getTextContent().length;

      if (currentOffset + textLength >= offset) {
        // Found the target text node
        const relativeOffset = offset - currentOffset;

        // Split the text node at the offset
        textNode.select(relativeOffset, relativeOffset);
        const selection = $getSelection();

        if ($isRangeSelection(selection)) {
          selection.insertNodes([node]);
        }

        return;
      }

      currentOffset += textLength;
    }
  });
};

/**
 * Get the current cursor position in the editor
 */
export const getCursorOffset = (editor: LexicalEditor): number | null => {
  let offset: number | null = null;

  editor.getEditorState().read(() => {
    const selection = $getSelection();

    if (!$isRangeSelection(selection)) {
      return;
    }

    const anchor = selection.anchor;
    const root = $getRoot();
    const textNodes = root.getAllTextNodes();

    let currentOffset = 0;

    for (const textNode of textNodes) {
      if (textNode.getKey() === anchor.key) {
        offset = currentOffset + anchor.offset;
        break;
      }

      currentOffset += textNode.getTextContent().length;
    }
  });

  return offset;
};

/**
 * Highlight text in the editor by wrapping it with a custom node
 */
export const highlightTextRange = (
  editor: LexicalEditor,
  startOffset: number,
  endOffset: number,
  highlightNode: any
) => {
  editor.update(() => {
    const root = $getRoot();
    const textNodes = root.getAllTextNodes();

    let currentOffset = 0;

    for (const textNode of textNodes) {
      const textLength = textNode.getTextContent().length;
      const nodeStart = currentOffset;
      const nodeEnd = currentOffset + textLength;

      // Check if this text node intersects with the highlight range
      if (nodeStart < endOffset && nodeEnd > startOffset) {
        const highlightStart = Math.max(0, startOffset - currentOffset);
        const highlightEnd = Math.min(textLength, endOffset - currentOffset);

        // Select the range to highlight
        textNode.select(highlightStart, highlightEnd);
        const selection = $getSelection();

        if ($isRangeSelection(selection)) {
          // Wrap selection with highlight node
          selection.insertNodes([highlightNode]);
        }

        return;
      }

      currentOffset += textLength;
    }
  });
};

/**
 * Remove all highlights from the editor
 */
export const clearHighlights = (
  editor: LexicalEditor,
  highlightNodeType: string
) => {
  editor.update(() => {
    const root = $getRoot();
    const allNodes = root.getAllTextNodes();

    for (const node of allNodes) {
      const parent = node.getParent();

      if (parent && parent.getType() === highlightNodeType) {
        // Replace highlight node with its text content
        parent.replace(node);
      }
    }
  });
};
