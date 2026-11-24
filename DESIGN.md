# TabCurb interface

The popup is a keyboard-first tab switcher. Search stays directly above the scrollable tab list. The navy header groups the memory source, usage, budget and tab counts. Settings uses the same navy for section navigation. Labels sit beside numeric values and above longer inputs.

Use the system font and the light and dark colors in `src/shared/ui.css`. Cobalt marks actions and keyboard selection. Use red for errors and memory over budget. Keep fonts and icons in the extension package so opening either screen works offline.

The extension mark is a browser tab with a crescent cut into its face. Generate the toolbar icons and favicon with `bun run icons` after editing `scripts/generate-icons.ts`. All sizes share a 16 px drawing grid.
