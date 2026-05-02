const STICKY_GUTTER_CSS = `
:host {
  --craft-diff-opaque-bg: var(--background, var(--diffs-bg));
}

/*
 * @pierre/diffs uses a transparent theme background so it can inherit the app
 * surface. When long lines are scrolled horizontally, the code column can paint
 * underneath the sticky line-number gutter. Keep the gutter as an opaque,
 * clipped stacking layer so code text never shows through line numbers.
 */
[data-overflow="scroll"] [data-code] {
  isolation: isolate;
  max-width: 100%;
}

[data-overflow="scroll"] [data-gutter] {
  position: sticky;
  left: 0;
  z-index: 20;
  overflow: hidden;
  clip-path: inset(0);
  background: var(--craft-diff-opaque-bg);
  box-shadow:
    1px 0 0 var(--craft-diff-opaque-bg),
    2px 0 0 color-mix(in lab, var(--craft-diff-opaque-bg) 85%, var(--diffs-fg));
}

[data-overflow="scroll"] [data-gutter] [data-line-type="context"][data-column-number],
[data-overflow="scroll"] [data-gutter] [data-line-type="context-expanded"][data-column-number],
[data-overflow="scroll"] [data-gutter] [data-gutter-buffer="annotation"] {
  background: var(--craft-diff-opaque-bg);
}

[data-overflow="scroll"] [data-gutter] [data-column-number],
[data-overflow="scroll"] [data-gutter] [data-gutter-buffer],
[data-overflow="scroll"] [data-gutter] [data-line-number-content] {
  position: relative;
  z-index: 21;
}

[data-overflow="scroll"] [data-gutter] [data-separator="line-info"] [data-separator-wrapper] {
  /*
   * Pierre renders collapsed-context labels in both the sticky line-number
   * gutter and the scrollable content column. The gutter copy is clipped to the
   * line-number width, which leaves fragments like "123 unm" visible. Hide the
   * gutter label and let the content copy render the full localized text.
   */
  display: none;
}

[data-overflow="scroll"] [data-content] {
  position: relative;
  z-index: 1;
  min-width: max-content;
}

[data-unmodified-lines][data-craft-unmodified-label] {
  color: transparent;
}

[data-unmodified-lines][data-craft-unmodified-label]::before {
  content: attr(data-craft-unmodified-label);
  color: var(--diffs-fg-number);
}

[data-overflow="scroll"] [data-line] {
  position: relative;
  z-index: 1;
}
`

export function getDiffViewerUnsafeCss(onFileHeaderClick?: boolean): string {
  const headerCss = onFileHeaderClick
    ? '[data-diffs-header] { cursor: pointer; } [data-diffs-header]:hover [data-title] { text-decoration: underline; }'
    : ''

  return [headerCss, STICKY_GUTTER_CSS].filter(Boolean).join('\n')
}
