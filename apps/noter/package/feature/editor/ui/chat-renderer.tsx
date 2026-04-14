/**
 * Chat Renderer Component
 *
 * Read-only Lexical renderer for displaying chat messages with markdown.
 */

'use client';

import '../style.css';

import { useMemo, useEffect } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin';
import { HorizontalRulePlugin } from '@lexical/react/LexicalHorizontalRulePlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $convertFromMarkdownString } from '@lexical/markdown';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { ListNode, ListItemNode } from '@lexical/list';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode';

import ChatEditorTheme from '../themes/ChatEditorTheme';
import CodeHighlightPlugin from '../plugins/CodeHighlightPlugin';
import { CHAT_TRANSFORMERS } from '../config/markdown-transformers';

/** Plugin to update content when text changes (for streaming). */
function ContentUpdatePlugin({ text }: { text: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromMarkdownString(text, CHAT_TRANSFORMERS);
    });
  }, [editor, text]);

  return null;
}

interface ChatRendererProps {
  text: string;
  className?: string;
}

export function ChatRenderer({ text, className = '' }: ChatRendererProps) {
  const rendererConfig = useMemo(() => ({
    namespace: 'ChatRenderer',
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
    editable: false,
    onError(error: Error) {
      console.error('Lexical renderer error:', error);
    },
    theme: ChatEditorTheme,
  }), []);

  return (
    <LexicalComposer initialConfig={rendererConfig}>
      <div className={`chat-renderer ${className}`}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="outline-none"
              style={{
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
              }}
            />
          }
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <ListPlugin />
        <LinkPlugin />
        <TablePlugin />
        <CheckListPlugin />
        <HorizontalRulePlugin />
        <CodeHighlightPlugin />
        <ContentUpdatePlugin text={text} />
      </div>
    </LexicalComposer>
  );
}
