/**
 * Chat Editor Component
 *
 * Minimal Lexical editor for chat input with coin mention support.
 * Simpler than the full doc editor - just plain text with mentions.
 */

'use client';

import '../style.css';

import { useEffect, useCallback, useState, useRef } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin';
import { HorizontalRulePlugin } from '@lexical/react/LexicalHorizontalRulePlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { $getRoot, $createParagraphNode, type EditorState, KEY_ENTER_COMMAND, COMMAND_PRIORITY_LOW, COMMAND_PRIORITY_EDITOR } from 'lexical';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { ListNode, ListItemNode } from '@lexical/list';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode';

import CodeHighlightPlugin from '../plugins/CodeHighlightPlugin';
import ChatEditorTheme from '../themes/ChatEditorTheme';
import { CHAT_TRANSFORMERS } from '../config/markdown-transformers';

// ════════════════════════════════════════════════════════════════════════════
// EDITOR CONFIG
// ════════════════════════════════════════════════════════════════════════════

const editorConfig = {
  namespace: 'ChatEditor',
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
    console.error('Lexical error:', error);
  },
  theme: ChatEditorTheme,
};

// ════════════════════════════════════════════════════════════════════════════
// HELPER PLUGINS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Plugin to handle Enter key submission
 */
function SubmitOnEnterPlugin({ onSubmit, disabled }: { onSubmit: () => void; disabled?: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event) return false;

        // Submit on Enter (without Shift)
        // Shift+Enter creates new line
        // Use COMMAND_PRIORITY_LOW so typeahead menu can intercept Enter first
        if (!event.shiftKey && !disabled) {
          event.preventDefault();
          onSubmit();
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_LOW // Lower priority - lets typeahead menu intercept first
    );
  }, [editor, onSubmit, disabled]);

  return null;
}

/**
 * Plugin to extract plain text content
 */
function TextContentPlugin({ onChange }: { onChange: (text: string) => void }) {
  const handleChange = useCallback(
    (editorState: EditorState) => {
      editorState.read(() => {
        const root = $getRoot();
        const text = root.getTextContent();
        onChange(text);
      });
    },
    [onChange]
  );

  return <OnChangePlugin onChange={handleChange} />;
}

/**
 * Plugin to clear editor content
 */
function ClearEditorPlugin({ shouldClear, onCleared }: { shouldClear: boolean; onCleared: () => void }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (shouldClear) {
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        paragraph.select();
      });
      onCleared();
    }
  }, [shouldClear, editor, onCleared]);

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════

interface ChatEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export function ChatEditor({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = 'Type a message...',
  className = '',
}: ChatEditorProps) {
  const [shouldClear, setShouldClear] = useState(false);

  // Trigger clear when value is empty and was previously not empty
  const previousValue = useRef(value);
  useEffect(() => {
    if (previousValue.current && !value) {
      setShouldClear(true);
    }
    previousValue.current = value;
  }, [value]);

  const handleCleared = useCallback(() => {
    setShouldClear(false);
  }, []);

  return (
    <LexicalComposer initialConfig={editorConfig}>
      <div className={`relative ${className}`}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="outline-none min-h-[44px] max-h-[200px] overflow-y-auto px-3 py-2 resize-none"
              style={{ wordBreak: 'break-word' }}
            />
          }
          placeholder={
            <div className="absolute top-2 left-3 text-muted-foreground pointer-events-none select-none">
              {placeholder}
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
        <TextContentPlugin onChange={onChange} />
        <SubmitOnEnterPlugin onSubmit={onSubmit} disabled={disabled} />
        <ClearEditorPlugin shouldClear={shouldClear} onCleared={handleCleared} />
      </div>
    </LexicalComposer>
  );
}
