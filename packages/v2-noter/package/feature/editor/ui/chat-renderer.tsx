/**
 * Chat Renderer Component
 *
 * Read-only Lexical renderer for displaying chat messages with coin mentions.
 * Parses text and converts coin mentions ($BTC, $ETH, etc.) to CoinMentionNodes.
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
import { $getRoot, $createTextNode } from 'lexical';
import { $convertFromMarkdownString } from '@lexical/markdown';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { ListNode, ListItemNode } from '@lexical/list';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode';

import { CoinMentionNode, $createCoinMentionNode } from '../nodes/CoinMentionNode';
import { COINS } from '../constant';
import ChatEditorTheme from '../themes/ChatEditorTheme';
import CodeHighlightPlugin from '../plugins/CodeHighlightPlugin';
import { CHAT_TRANSFORMERS } from '../config/markdown-transformers';

// ════════════════════════════════════════════════════════════════════════════
// CONTENT PARSER PLUGIN
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse text and build editor state with markdown and coin mentions
 */
function parseTextToEditorState(text: string) {
  const root = $getRoot();
  root.clear();

  // First, convert markdown to Lexical nodes (including tables)
  $convertFromMarkdownString(text, CHAT_TRANSFORMERS);

  // Now walk through all text nodes and replace coin mentions
  const allNodes = root.getAllTextNodes();

  for (const textNode of allNodes) {
    const nodeText = textNode.getTextContent();
    const coinRegex = /\$([A-Z]{2,5})\b/g;

    let match;
    const matches: Array<{ index: number; symbol: string; length: number }> = [];

    // Find all coin mentions in this text node
    while ((match = coinRegex.exec(nodeText)) !== null) {
      matches.push({
        index: match.index,
        symbol: match[1],
        length: match[0].length,
      });
    }

    if (matches.length > 0) {
      // Process matches in reverse to maintain indices
      matches.reverse();

      for (const matchInfo of matches) {
        const coin = COINS.find(
          (c) => c.symbol.toUpperCase() === matchInfo.symbol.toUpperCase()
        );

        if (coin) {
          const beforeText = nodeText.slice(0, matchInfo.index);
          const afterText = nodeText.slice(matchInfo.index + matchInfo.length);

          // Split the text node
          const beforeNode = $createTextNode(beforeText);
          const coinNode = $createCoinMentionNode(coin);
          const afterNode = $createTextNode(afterText);

          // Copy formatting from original node
          if (textNode.hasFormat('bold')) {
            beforeNode.toggleFormat('bold');
            afterNode.toggleFormat('bold');
          }
          if (textNode.hasFormat('italic')) {
            beforeNode.toggleFormat('italic');
            afterNode.toggleFormat('italic');
          }
          if (textNode.hasFormat('code')) {
            beforeNode.toggleFormat('code');
            afterNode.toggleFormat('code');
          }

          // Replace original node with split nodes
          textNode.replace(beforeNode);
          if (beforeText) {
            beforeNode.insertAfter(coinNode);
            if (afterText) {
              coinNode.insertAfter(afterNode);
            }
          } else {
            beforeNode.replace(coinNode);
            if (afterText) {
              coinNode.insertAfter(afterNode);
            }
          }

          break; // Process one match at a time per node
        }
      }
    }
  }
}

/**
 * Plugin to update content when text changes (for streaming)
 */
function ContentUpdatePlugin({ text }: { text: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.update(() => {
      parseTextToEditorState(text);
    });
  }, [editor, text]);

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════

interface ChatRendererProps {
  text: string;
  className?: string;
}

export function ChatRenderer({ text, className = '' }: ChatRendererProps) {
  // Create config once, don't recreate on text change
  const rendererConfig = useMemo(() => ({
    namespace: 'ChatRenderer',
    nodes: [
      CoinMentionNode,
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
  }), []); // Empty deps - create once

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
