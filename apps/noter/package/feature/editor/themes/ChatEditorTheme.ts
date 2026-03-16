/**
 * Chat Editor Theme Configuration
 * Based on Lexical PlaygroundEditorTheme
 */

import type { EditorThemeClasses } from 'lexical';
import './ChatEditorTheme.css';

const theme: EditorThemeClasses = {
  ltr: 'ChatEditorTheme__ltr',
  rtl: 'ChatEditorTheme__rtl',
  paragraph: 'ChatEditorTheme__paragraph',
  quote: 'ChatEditorTheme__quote',
  heading: {
    h1: 'ChatEditorTheme__h1',
    h2: 'ChatEditorTheme__h2',
    h3: 'ChatEditorTheme__h3',
    h4: 'ChatEditorTheme__h4',
  },
  list: {
    ul: 'ChatEditorTheme__ul',
    ol: 'ChatEditorTheme__ol1',
    olDepth: [
      'ChatEditorTheme__ol1',
      'ChatEditorTheme__ol2',
      'ChatEditorTheme__ol3',
    ],
    listitem: 'ChatEditorTheme__listItem',
    listitemChecked: 'ChatEditorTheme__listItemChecked',
    listitemUnchecked: 'ChatEditorTheme__listItemUnchecked',
    nested: {
      listitem: 'ChatEditorTheme__nestedListItem',
    },
  },
  text: {
    bold: 'ChatEditorTheme__textBold',
    italic: 'ChatEditorTheme__textItalic',
    underline: 'ChatEditorTheme__textUnderline',
    strikethrough: 'ChatEditorTheme__textStrikethrough',
    code: 'ChatEditorTheme__textCode',
  },
  code: 'ChatEditorTheme__code',
  codeHighlight: {
    atrule: 'ChatEditorTheme__tokenAttr',
    attr: 'ChatEditorTheme__tokenAttr',
    boolean: 'ChatEditorTheme__tokenProperty',
    builtin: 'ChatEditorTheme__tokenSelector',
    cdata: 'ChatEditorTheme__tokenComment',
    char: 'ChatEditorTheme__tokenSelector',
    class: 'ChatEditorTheme__tokenFunction',
    'class-name': 'ChatEditorTheme__tokenFunction',
    comment: 'ChatEditorTheme__tokenComment',
    constant: 'ChatEditorTheme__tokenProperty',
    deleted: 'ChatEditorTheme__tokenProperty',
    doctype: 'ChatEditorTheme__tokenComment',
    entity: 'ChatEditorTheme__tokenOperator',
    function: 'ChatEditorTheme__tokenFunction',
    important: 'ChatEditorTheme__tokenVariable',
    inserted: 'ChatEditorTheme__tokenSelector',
    keyword: 'ChatEditorTheme__tokenAttr',
    namespace: 'ChatEditorTheme__tokenVariable',
    number: 'ChatEditorTheme__tokenProperty',
    operator: 'ChatEditorTheme__tokenOperator',
    prolog: 'ChatEditorTheme__tokenComment',
    property: 'ChatEditorTheme__tokenProperty',
    punctuation: 'ChatEditorTheme__tokenPunctuation',
    regex: 'ChatEditorTheme__tokenVariable',
    selector: 'ChatEditorTheme__tokenSelector',
    string: 'ChatEditorTheme__tokenSelector',
    symbol: 'ChatEditorTheme__tokenProperty',
    tag: 'ChatEditorTheme__tokenProperty',
    url: 'ChatEditorTheme__tokenOperator',
    variable: 'ChatEditorTheme__tokenVariable',
  },
  link: 'ChatEditorTheme__link',
  hr: 'ChatEditorTheme__hr',
  indent: 'ChatEditorTheme__indent',
  table: 'ChatEditorTheme__table',
  tableCell: 'ChatEditorTheme__tableCell',
  tableCellHeader: 'ChatEditorTheme__tableCellHeader',
  tableRowStriping: 'ChatEditorTheme__tableRowStriping',
};

export default theme;
