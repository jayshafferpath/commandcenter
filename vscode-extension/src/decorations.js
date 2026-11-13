// Pure range/color math for the agent's presence decorations — no `vscode`
// import, so this is unit-testable with plain Vitest (the extension host
// itself has no test runner in this repo). extension.js turns the plain
// objects this returns into actual vscode.Range/DecorationRenderOptions.
//
// Violet, not blue/red-green/yellow: blue blends into VS Code's native
// selection and most themes' accent color, red/green are already
// load-bearing for diff add/remove (showing in the same window during a
// walkthrough), yellow/orange reads as a diagnostic or warning. See
// .plans/vscode-walkthrough-bridge.md's Open questions section.
export const CARET_COLOR = "#A371F7";
export const SELECTION_COLOR = "rgba(163, 55, 247, 0.12)";

// The server already defaults startCol/endLine/endCol (see api/vscode.js's
// moveCommand), but the extension treats the wire shape as untrusted input
// rather than assuming the server's defaulting never changes.
export function normalizeRange(command) {
  const startLine = command.startLine;
  const startCol = command.startCol ?? 1;
  const endLine = command.endLine ?? startLine;
  const endCol = command.endCol ?? 1;
  return { startLine, startCol, endLine, endCol };
}

// VS Code positions are 0-based; the wire format is 1-based (editor line
// numbers), matching what a human reads off the gutter.
export function toZeroBasedRange(command) {
  const { startLine, startCol, endLine, endCol } = normalizeRange(command);
  return {
    start: { line: Math.max(0, startLine - 1), character: Math.max(0, startCol - 1) },
    end: { line: Math.max(0, endLine - 1), character: Math.max(0, endCol - 1) },
  };
}

export function shouldShowPresence(command) {
  return command?.type === "move";
}

// A diff editor's modified side is its own entry in vscode.window.visibleTextEditors,
// not just the plain-editor case — so this covers both "already open as a normal
// tab" and "already open as the right-hand side of a diff" uniformly. Pure/testable
// against plain {document: {uri: {toString}}} doubles; extension.js passes the real
// vscode.window.visibleTextEditors array and a real uri.toString().
export function findVisibleEditorIndex(visibleEditors, targetUriString) {
  return visibleEditors.findIndex((editor) => editor.document?.uri?.toString() === targetUriString);
}

export function caretNameplate(command, fallbackLabel) {
  return command?.label || fallbackLabel;
}
