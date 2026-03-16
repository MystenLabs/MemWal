# Editor Feature - Shared Lexical Components

Shared Lexical-based rich text editing components for chat and notes with crypto coin mentions.

## Overview

This feature provides shared Lexical-powered rich text editing components used across chat and note features, with full markdown support, tables, code blocks, and crypto coin mentions.

**Key Features:**
- ✅ Full markdown rendering (bold, italic, code, lists, headings, quotes, links)
- ✅ Tables with proper styling
- ✅ Syntax-highlighted code blocks
- ✅ Horizontal rules
- ✅ Checklists / task lists
- ✅ Coin mentions with `$` trigger (e.g., `$BTC`, `$ETH`)
- ✅ Live markdown shortcuts in editor
- ✅ Clean, professional styling based on Lexical PlaygroundEditorTheme

## Components

### ChatEditor

Main editor component for chat/note input. Replaces the standard textarea with a Lexical-powered editor.

**Usage:**
```tsx
import { ChatEditor } from '@/feature/editor';

<ChatEditor
  value={input}
  onChange={setInput}
  onSubmit={handleSubmit}
  disabled={isLoading}
  placeholder="Type a message..."
/>
```

**Props:**
- `value: string` - Current editor content (plain text)
- `onChange: (value: string) => void` - Called when content changes
- `onSubmit: () => void` - Called when Enter is pressed (without Shift)
- `disabled?: boolean` - Disable editor interaction
- `placeholder?: string` - Placeholder text
- `className?: string` - Additional CSS classes

### ChatRenderer

Read-only Lexical renderer for displaying chat messages with coin mentions. Automatically parses text and converts `$SYMBOL` patterns to interactive coin mention chips.

**Usage:**
```tsx
import { ChatRenderer } from '@/feature/editor';

<ChatRenderer
  text="Check out $BTC and $ETH prices today!"
  className="text-sm"
/>
```

**Props:**
- `text: string` - Message text to render (supports coin mentions like $BTC, $ETH)
- `className?: string` - Additional CSS classes

**Features:**
- Auto-detects coin symbols (e.g., `$BTC`, `$ETH`, `$SUI`)
- Converts recognized symbols to styled coin mention chips
- Preserves regular text and formatting
- Read-only, non-editable display
- Supports all 10 pre-defined coins

### CoinMentionNode

Lexical DecoratorNode for displaying crypto coin mentions. Renders as a styled chip with the coin symbol.

**Data structure:**
```ts
interface CoinMentionData {
  id: string;
  symbol: string;
  name: string;
  color?: string;
}
```

### CoinMentionPlugin

Lexical plugin that provides typeahead functionality for mentioning coins with `$` trigger.

**Features:**
- Triggered by `$` character
- Shows dropdown with matching coins
- Filters by symbol or name
- Keyboard navigation
- Click to select

## Static Data

The feature includes 10 pre-defined crypto coins:
- Bitcoin (BTC)
- Ethereum (ETH)
- Sui (SUI)
- Solana (SOL)
- Cardano (ADA)
- Polkadot (DOT)
- Avalanche (AVAX)
- Polygon (MATIC)
- Chainlink (LINK)
- Uniswap (UNI)

**API:**
```ts
import { COINS, searchCoins } from '@/feature/editor';

// Get all coins
const allCoins = COINS;

// Search by symbol or name
const filtered = searchCoins('btc'); // Returns Bitcoin
```

## Markdown Support

Both the editor and renderer support full markdown syntax:

### Text Formatting
- `**bold**` or `__bold__` → **bold**
- `*italic*` or `_italic_` → *italic*
- `` `code` `` → `code`
- `~~strikethrough~~` → ~~strikethrough~~

### Lists
- `- item` or `* item` → Unordered list
- `1. item` → Ordered list

### Headings
- `# Heading 1`
- `## Heading 2`
- `### Heading 3`

### Tables
- Markdown tables are fully supported
- Rendered with borders, headers, and striping

### Checklists
- `- [ ] unchecked` → Unchecked task
- `- [x] checked` → Checked task

### Other
- `> quote` → Block quote
- `` ```code``` `` → Code block with syntax highlighting
- `[text](url)` → Link
- `---` → Horizontal rule

### Coin Mentions
- `$BTC`, `$ETH`, `$SUI` → Styled coin chips

## Keyboard Shortcuts

- **Enter** - Submit message (calls `onSubmit`)
- **Shift + Enter** - New line
- **$** - Trigger coin mention dropdown
- **Arrow Up/Down** - Navigate dropdown
- **Enter/Click** - Select coin from dropdown
- **Escape** - Close dropdown

### Markdown Shortcuts (in Editor)
- Type markdown syntax and press Space or Enter to auto-format
- Example: `**bold**` + Space → formats as bold
- Example: `- ` at line start → creates bullet list
- Example: `1. ` at line start → creates numbered list

## Styling

The editor uses a custom theme based on Lexical's PlaygroundEditorTheme:
- **ChatEditorTheme.css** - All styling in dedicated CSS file
- **ChatEditorTheme.ts** - Theme configuration mapping
- Uses CSS custom properties for theming (works with light/dark mode)
- Optimized spacing for compact chat messages

## Future Enhancements

- [ ] Fetch coin data from API (CoinGecko - API key available)
- [ ] Add coin price display in hover/tooltip
- [ ] Support for other mentions (users, hashtags)
- [x] Rich text formatting (bold, italic, links) ✅
- [x] Markdown rendering ✅
- [x] Professional styling based on PlaygroundEditorTheme ✅
- [x] Code syntax highlighting ✅
- [ ] Message history navigation (Up/Down arrows)
- [ ] Draft persistence to localStorage
- [ ] Image paste support
- [ ] File attachments
