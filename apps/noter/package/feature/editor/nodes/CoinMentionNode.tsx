/**
 * CoinMentionNode
 *
 * A Lexical DecoratorNode for mentioning crypto coins.
 * Triggered by $ in the editor, renders as a clickable chip with coin symbol.
 *
 * Uses DecoratorNode pattern similar to MemberMentionNode.
 */

'use client';

import { cn } from '@/shared/lib/utils';
import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import * as React from 'react';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

export interface CoinMentionData {
  id: string;
  symbol: string;
  name: string;
  color?: string;
}

export type SerializedCoinMentionNode = Spread<
  { coin: CoinMentionData },
  SerializedLexicalNode
>;

// ════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ════════════════════════════════════════════════════════════════════════════

interface CoinMentionComponentProps {
  coin: CoinMentionData;
  nodeKey: string;
}

function CoinMentionComponent({
  coin,
}: CoinMentionComponentProps): React.ReactElement {
  const handleClick = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Future: Navigate to coin details page or open modal
  }, [coin]);

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick(e as unknown as React.MouseEvent);
    }
  }, [handleClick]);

  return (
    <span
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex items-center gap-1 cursor-pointer',
        'bg-primary/10 hover:bg-primary/20 text-primary text-sm font-medium transition-colors'
      )}
      role="button"
      tabIndex={0}
      title={coin.name}
    >
      <span className="font-bold">${coin.symbol}</span>
    </span>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// DOM CONVERSION
// ════════════════════════════════════════════════════════════════════════════

function $convertCoinMentionElement(
  domNode: HTMLElement
): DOMConversionOutput | null {
  const coinJson = domNode.getAttribute('data-coin');

  if (coinJson) {
    try {
      const coin = JSON.parse(coinJson) as CoinMentionData;
      const node = $createCoinMentionNode(coin);
      return { node };
    } catch {
      return null;
    }
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// NODE CLASS
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_COIN: CoinMentionData = {
  id: '',
  symbol: '',
  name: '',
};

export class CoinMentionNode extends DecoratorNode<React.ReactElement> {
  __coin: CoinMentionData;

  static getType(): string {
    return 'coin-mention';
  }

  static clone(node: CoinMentionNode): CoinMentionNode {
    return new CoinMentionNode(node.__coin, node.__key);
  }

  static importJSON(serializedNode: SerializedCoinMentionNode): CoinMentionNode {
    return $createCoinMentionNode(serializedNode.coin);
  }

  // IMPORTANT: All constructor args have defaults for Yjs compatibility
  constructor(coin: CoinMentionData = DEFAULT_COIN, key?: NodeKey) {
    super(key);
    this.__coin = coin;
  }

  exportJSON(): SerializedCoinMentionNode {
    return {
      ...super.exportJSON(),
      coin: this.__coin,
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.className = 'coin-mention-wrapper';
    return span;
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span');
    element.setAttribute('data-lexical-coin-mention', 'true');
    element.setAttribute('data-coin', JSON.stringify(this.__coin));
    element.textContent = `$${this.__coin.symbol}`;
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-lexical-coin-mention')) {
          return null;
        }
        return {
          conversion: $convertCoinMentionElement,
          priority: 1,
        };
      },
    };
  }

  decorate(): React.ReactElement {
    return (
      <CoinMentionComponent
        coin={this.__coin}
        nodeKey={this.__key}
      />
    );
  }

  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  // Getters
  getCoin(): CoinMentionData {
    return this.__coin;
  }

  getCoinId(): string {
    return this.__coin.id;
  }

  getCoinSymbol(): string {
    return this.__coin.symbol;
  }

  getCoinName(): string {
    return this.__coin.name;
  }

  getTextContent(): string {
    return `$${this.__coin.symbol}`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FACTORY & TYPE GUARD
// ════════════════════════════════════════════════════════════════════════════

export function $createCoinMentionNode(
  coin: CoinMentionData
): CoinMentionNode {
  return $applyNodeReplacement(new CoinMentionNode(coin));
}

export function $isCoinMentionNode(
  node: LexicalNode | null | undefined
): node is CoinMentionNode {
  return node instanceof CoinMentionNode;
}
