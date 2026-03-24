/**
 * Markdown Transformers Configuration
 *
 * Extended transformers for chat editor
 */

import {
  TRANSFORMERS,
  type Transformer,
} from '@lexical/markdown';

// Use default transformers from Lexical
// Note: Table markdown parsing requires additional setup
export const CHAT_TRANSFORMERS: Array<Transformer> = TRANSFORMERS;
