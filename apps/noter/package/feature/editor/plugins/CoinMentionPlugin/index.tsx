/**
 * CoinMentionPlugin
 *
 * Lexical plugin for mentioning crypto coins with $ trigger.
 * Displays a typeahead menu with matching coins from the static list.
 *
 * Usage:
 * <CoinMentionPlugin />
 */

'use client';

import type { JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  type MenuTextMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { $createTextNode, TextNode } from 'lexical';
import { useCallback, useMemo, useState } from 'react';
import * as ReactDOM from 'react-dom';

import { $createCoinMentionNode } from '../../nodes/CoinMentionNode';
import { searchCoins, type CoinData } from '../../constant';

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

// Trigger: $ followed by characters
const CoinMentionRegex = new RegExp(
  '(^|\\s)(\\$)([^$\\s]{0,50})$'
);

const SUGGESTION_LIST_LENGTH_LIMIT = 10;

// ════════════════════════════════════════════════════════════════════════════
// TYPEAHEAD OPTION CLASS
// ════════════════════════════════════════════════════════════════════════════

class CoinTypeaheadOption extends MenuOption {
  coin: CoinData;

  constructor(coin: CoinData) {
    super(coin.id);
    this.coin = coin;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MENU ITEM COMPONENT
// ════════════════════════════════════════════════════════════════════════════

function CoinTypeaheadMenuItem({
  index,
  isSelected,
  onClick,
  onMouseEnter,
  option,
}: {
  index: number;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  option: CoinTypeaheadOption;
}) {
  const { coin } = option;

  return (
    <li
      key={option.key}
      tabIndex={-1}
      className={`px-3 py-2 cursor-pointer flex items-center gap-2 ${
        isSelected ? 'bg-accent' : 'hover:bg-accent/50'
      }`}
      ref={option.setRefElement}
      role="option"
      aria-selected={isSelected}
      id={`typeahead-item-${index}`}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    >
      <span className="h-3 w-3 shrink-0 rounded-full bg-primary" />
      <span className="font-bold text-sm">{coin.symbol}</span>
      <span className="text-xs text-muted-foreground">{coin.name}</span>
    </li>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// TRIGGER MATCHING
// ════════════════════════════════════════════════════════════════════════════

function checkForCoinMentionMatch(text: string): MenuTextMatch | null {
  const match = CoinMentionRegex.exec(text);

  if (match !== null) {
    const maybeLeadingWhitespace = match[1];
    const trigger = match[2]; // $
    const matchingString = match[3]; // search query (after $)

    return {
      leadOffset: match.index + maybeLeadingWhitespace.length,
      matchingString,
      replaceableString: trigger + matchingString,
    };
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// PLUGIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════

export default function CoinMentionPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [queryString, setQueryString] = useState<string | null>(null);

  // Search matching coins
  const coins = useMemo(
    () => searchCoins(queryString || ''),
    [queryString]
  );

  // Convert to typeahead options
  const options = useMemo(
    () =>
      coins
        .map((coin) => new CoinTypeaheadOption(coin))
        .slice(0, SUGGESTION_LIST_LENGTH_LIMIT),
    [coins]
  );

  // Handle selection
  const onSelectOption = useCallback(
    (
      selectedOption: CoinTypeaheadOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void
    ) => {
      editor.update(() => {
        const { coin } = selectedOption;
        const mentionNode = $createCoinMentionNode(coin);
        if (nodeToReplace) {
          nodeToReplace.replace(mentionNode);
        }
        // Insert a space after the mention and move cursor there
        const spaceNode = $createTextNode(' ');
        mentionNode.insertAfter(spaceNode);
        spaceNode.select();
        closeMenu();
      });
    },
    [editor]
  );

  // Trigger function
  const checkForMentionMatch = useCallback((text: string) => {
    return checkForCoinMentionMatch(text);
  }, []);

  return (
    <LexicalTypeaheadMenuPlugin<CoinTypeaheadOption>
      onQueryChange={setQueryString}
      onSelectOption={onSelectOption}
      triggerFn={checkForMentionMatch}
      options={options}
      menuRenderFn={(
        anchorElementRef,
        { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }
      ) => {
        if (!anchorElementRef.current || coins.length === 0) {
          return null;
        }

        // Calculate position to ensure menu stays within viewport
        const anchorRect = anchorElementRef.current.getBoundingClientRect();
        const menuHeight = Math.min(300, options.length * 40); // Approximate height
        const menuWidth = 300;

        // Check if menu would go off bottom of screen
        const spaceBelow = window.innerHeight - anchorRect.bottom;
        const spaceAbove = anchorRect.top;
        const shouldRenderAbove = spaceBelow < menuHeight && spaceAbove > spaceBelow;

        // Check if menu would go off right of screen
        const spaceRight = window.innerWidth - anchorRect.left;
        const shouldAlignRight = spaceRight < menuWidth;

        const style: React.CSSProperties = {
          position: 'fixed',
          zIndex: 9999, // Higher than chat input (which is sticky)
          minWidth: '200px',
          maxWidth: '300px',
          maxHeight: '300px',
        };

        // Position vertically
        if (shouldRenderAbove) {
          style.bottom = `${window.innerHeight - anchorRect.top}px`;
        } else {
          style.top = `${anchorRect.bottom}px`;
        }

        // Position horizontally
        if (shouldAlignRight) {
          style.right = `${window.innerWidth - anchorRect.right}px`;
        } else {
          style.left = `${anchorRect.left}px`;
        }

        return ReactDOM.createPortal(
          <div
            className="bg-popover border border-border rounded-md shadow-lg overflow-hidden overflow-y-auto"
            style={style}
          >
            <ul>
              {options.map((option, i: number) => (
                <CoinTypeaheadMenuItem
                  index={i}
                  isSelected={selectedIndex === i}
                  onClick={() => {
                    setHighlightedIndex(i);
                    selectOptionAndCleanUp(option);
                  }}
                  onMouseEnter={() => {
                    setHighlightedIndex(i);
                  }}
                  key={option.key}
                  option={option}
                />
              ))}
            </ul>
          </div>,
          document.body
        );
      }}
    />
  );
}

export { CoinMentionPlugin };
