"use client";

/**
 * Note Editor Component
 *
 * Full-featured Lexical editor for note-taking.
 * Includes auto-save and rich text editing.
 * Changes are auto-saved. The Save button persists immediately, then analyzes
 * the note for MemWal when memory credentials are configured.
 */

import { CodeHighlightNode, CodeNode } from "@lexical/code";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { TableCellNode, TableNode, TableRowNode } from "@lexical/table";
import { $getRoot, type EditorState, type SerializedEditorState } from "lexical";
import { useCallback, useState } from "react";

import { CHAT_TRANSFORMERS, ChatEditorTheme, CodeHighlightPlugin } from "@/feature/editor";
import { MarketingBorder } from "@/package/shared/components/border";
import { Button } from "@/shared/components/ui/button";
import { Check, Loader2, Save, XCircle } from "lucide-react";
import { useNote } from "../hook/use-note";

// ════════════════════════════════════════════════════════════════════════════
// EDITOR CONFIG
// ════════════════════════════════════════════════════════════════════════════

const editorConfig = {
  namespace: "NoteEditor",
  nodes: [
    HeadingNode,
    QuoteNode,
    CodeNode,
    CodeHighlightNode,
    LinkNode,
    AutoLinkNode,
    ListNode,
    ListItemNode,
    TableNode,
    TableCellNode,
    TableRowNode,
    HorizontalRuleNode,
  ],
  onError(error: Error) {
    console.error("Lexical error:", error);
  },
  theme: ChatEditorTheme,
};

// ════════════════════════════════════════════════════════════════════════════
// SAVE BUTTON (must be inside LexicalComposer)
// ════════════════════════════════════════════════════════════════════════════

type SaveNoteButtonProps = {
  onSaveToDb: (content: SerializedEditorState, plainText: string) => Promise<void>;
};

const SESSION_STORAGE_KEY = "zklogin:session:id";

function getSessionId(): string | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;

    const outer = JSON.parse(raw);
    const sessionData = outer?.value ?? outer;
    return sessionData?.sessionId ?? null;
  } catch {
    return null;
  }
}

function readEditorContent(editorState: EditorState) {
  let plainText = "";
  editorState.read(() => {
    plainText = $getRoot().getTextContent();
  });

  return {
    content: editorState.toJSON() as SerializedEditorState,
    plainText,
  };
}

function SaveNoteButton({ onSaveToDb }: SaveNoteButtonProps) {
  const [editor] = useLexicalComposerContext();
  const [status, setStatus] = useState<"idle" | "saving" | "analyzing" | "done" | "error">("idle");

  const handleSave = async () => {
    const { content, plainText } = readEditorContent(editor.getEditorState());

    setStatus("saving");
    try {
      await onSaveToDb(content, plainText);

      if (plainText.trim().length >= 10) {
        setStatus("analyzing");

        const sessionId = getSessionId();
        const res = await fetch("/api/memory/remember", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(sessionId ? { "x-session-id": sessionId } : {}),
          },
          body: JSON.stringify({ text: plainText }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to save to MemWal");
        }
      }

      setStatus("done");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (error) {
      console.error("[SaveNote] Error:", error);
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleSave}
      disabled={status === "saving" || status === "analyzing"}
    >
      {status === "saving" ? (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Saving...
        </>
      ) : status === "analyzing" ? (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Analyzing...
        </>
      ) : status === "done" ? (
        <>
          <Check className="h-4 w-4 mr-2 text-green-500" />
          Saved!
        </>
      ) : status === "error" ? (
        <>
          <XCircle className="h-4 w-4 mr-2 text-red-500" />
          Error
        </>
      ) : (
        <>
          <Save className="h-4 w-4 mr-2" />
          Save
        </>
      )}
    </Button>
  );
}

type AutoSavePluginProps = {
  onSave: (content: SerializedEditorState, plainText: string) => void;
};

function AutoSavePlugin({ onSave }: AutoSavePluginProps) {
  const handleChange = useCallback(
    (editorState: EditorState) => {
      const { content, plainText } = readEditorContent(editorState);
      onSave(content, plainText);
    },
    [onSave]
  );

  return (
    <OnChangePlugin
      onChange={handleChange}
      ignoreHistoryMergeTagChange
      ignoreSelectionChange
    />
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════

export interface NoteEditorProps {
  noteId: string;
}

export function NoteEditor({ noteId }: NoteEditorProps) {
  const { note, isLoading, error, save, saveImmediate } = useNote(noteId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-red-500">
          <p className="font-semibold">Error loading note</p>
          <p className="text-sm">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!note) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">
          <p className="font-semibold">Note not found</p>
          <p className="text-sm">ID: {noteId}</p>
        </div>
      </div>
    );
  }

  return (
    <LexicalComposer
      initialConfig={{
        ...editorConfig,
        editorState: note.content ? JSON.stringify(note.content) : undefined,
      }}
    >
      {/* Toolbar */}
      <div className="border-b p-4 flex items-center justify-start gap-3">
        <SaveNoteButton onSaveToDb={saveImmediate} />
      </div>

      {/* Editor */}
      <div className="flex-1 flex min-h-0">
        <div className="relative flex-1 overflow-auto">
          <RichTextPlugin
            contentEditable={
              <ContentEditable className="note-editor-content outline-none p-8 min-h-full" />
            }
            placeholder={
              <div className="absolute top-8 left-8 text-muted-foreground pointer-events-none">
                Start typing your note...
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />

          <HistoryPlugin />
          <ListPlugin />
          <LinkPlugin />
          <TablePlugin />
          <CheckListPlugin />
          <HorizontalRulePlugin />
          <CodeHighlightPlugin />
          <MarkdownShortcutPlugin transformers={CHAT_TRANSFORMERS} />
          <AutoSavePlugin onSave={save} />


          <MarketingBorder />
        </div>
      </div>
    </LexicalComposer>
  );
}
