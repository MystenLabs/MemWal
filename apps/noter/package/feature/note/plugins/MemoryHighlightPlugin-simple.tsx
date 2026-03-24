/**
 * MEMORY HIGHLIGHT PLUGIN — Simplified version using CSS overlays
 * Renders highlights as positioned overlays instead of manipulating Lexical nodes
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect, useState } from "react";
import { $getRoot } from "lexical";
import type { NoteMemoryHighlight } from "@/shared/db/type";

export type MemoryHighlightPluginProps = {
  highlights: NoteMemoryHighlight[];
  onHighlightClick?: (highlight: NoteMemoryHighlight) => void;
};

type HighlightBox = {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
  status: string;
  highlight: NoteMemoryHighlight;
};

const STATUS_COLORS: Record<string, string> = {
  preparing: "rgba(59, 130, 246, 0.3)", // blue
  pending: "rgba(234, 179, 8, 0.3)", // yellow
  signing: "rgba(168, 85, 247, 0.3)", // purple
  uploading: "rgba(99, 102, 241, 0.3)", // indigo
  indexing: "rgba(6, 182, 212, 0.3)", // cyan
  saved: "rgba(34, 197, 94, 0.3)", // green
  rejected: "rgba(156, 163, 175, 0.3)", // gray
  error: "rgba(239, 68, 68, 0.3)", // red
};

/**
 * Simpler plugin that uses CSS positioning for highlights
 */
export function MemoryHighlightPlugin({
  highlights,
  onHighlightClick,
}: MemoryHighlightPluginProps) {
  const [editor] = useLexicalComposerContext();
  const [boxes, setBoxes] = useState<HighlightBox[]>([]);

  useEffect(() => {
    if (!highlights || highlights.length === 0) {
      setBoxes([]);
      return;
    }

    // Get the editor's text content to calculate positions
    editor.getEditorState().read(() => {
      const root = $getRoot();
      const fullText = root.getTextContent();
      const newBoxes: HighlightBox[] = [];

      highlights.forEach((highlight) => {
        // Find the text in the editor
        const textToFind = highlight.extractedText?.trim();
        if (!textToFind) {
          console.warn("[MemoryHighlightPlugin] Highlight has no extractedText, skipping");
          return;
        }
        const foundIndex = fullText.indexOf(textToFind);

        if (foundIndex >= 0) {
          // For now, just mark that we found it
          // We'll implement visual positioning in the next step
          newBoxes.push({
            id: highlight.id,
            top: 0,
            left: 0,
            width: 100,
            height: 20,
            status: highlight.status,
            highlight,
          });
        } else {
          console.warn("[MemoryHighlightPlugin] Text not found:", textToFind.substring(0, 50));
        }
      });

      setBoxes(newBoxes);
    });
  }, [highlights, editor]);

  return (
    <div className="memory-highlights-overlay">
      {boxes.map((box) => (
        <div
          key={box.id}
          className="memory-highlight-indicator"
          style={{
            position: "absolute",
            top: box.top,
            left: box.left,
            width: box.width,
            height: box.height,
            backgroundColor: STATUS_COLORS[box.status] || STATUS_COLORS.pending,
            pointerEvents: "auto",
            cursor: "pointer",
            borderRadius: "2px",
          }}
          onClick={() => onHighlightClick?.(box.highlight)}
        >
          {/* Visual indicator */}
        </div>
      ))}
      <style jsx>{`
        .memory-highlights-overlay {
          position: relative;
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}
