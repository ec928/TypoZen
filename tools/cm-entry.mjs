// The parts of CodeMirror 6 that Source mode uses, bundled by tools/Update-CodeMirror.ps1
// into js/vendor/codemirror/codemirror.js as one classic script exposing window.TzCM.
//
// Deliberately absent (docs/archive/codemirror-source-plan.md, 5.2-5.4): CodeMirror's history
// (HistoryManager is the one undo), its search panel, autocomplete, and the markdown()
// helper, whose keymap binds Enter -- Source's Enter is TypoZen's own.
export {
    EditorState, EditorSelection, Compartment, StateField, StateEffect, Annotation,
    Transaction, Prec, RangeSetBuilder
} from '@codemirror/state';
export {
    EditorView, ViewPlugin, Decoration, keymap
} from '@codemirror/view';
export { standardKeymap } from '@codemirror/commands';
export { syntaxHighlighting, HighlightStyle, syntaxTree, ensureSyntaxTree } from '@codemirror/language';
export { markdownLanguage } from '@codemirror/lang-markdown';
export { tags } from '@lezer/highlight';
