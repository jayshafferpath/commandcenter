// Pair Pal: the agent's own simulated presence in Jay's editor. Decoration
// APIs only — never editor.selection, never revealRange outside Follow
// Agent, never anything that could move Jay's real cursor or steal focus.
// See .plans/vscode-walkthrough-bridge.md Phase A.
import * as vscode from "vscode";
import { ackCommand, connectWorkspace, pollCommands } from "./src/api-client.js";
import { CARET_COLOR, SELECTION_COLOR, shouldShowPresence, toZeroBasedRange } from "./src/decorations.js";
import { nextBackoffMs, shouldReveal } from "./src/followState.js";

const FALLBACK_LABEL = "Command Center";

let statusBarItem;
let caretDecorationType;
let selectionDecorationType;
let followAgentEnabled = true;
let polling = false;
let lastCommandId = null;

export function activate(context) {
  caretDecorationType = vscode.window.createTextEditorDecorationType({
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: CARET_COLOR,
    after: {
      contentText: "",
      backgroundColor: CARET_COLOR,
      color: "#1a1a1a",
      margin: "0 0 0 4px",
    },
  });
  selectionDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: SELECTION_COLOR,
  });

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "pairPal.toggleFollowAgent";
  renderStatusBar();
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    caretDecorationType,
    selectionDecorationType,
    vscode.commands.registerCommand("pairPal.toggleFollowAgent", () => {
      followAgentEnabled = !followAgentEnabled;
      renderStatusBar();
    }),
  );

  startPolling(context);
}

export function deactivate() {
  polling = false;
}

function renderStatusBar() {
  statusBarItem.text = followAgentEnabled ? "$(eye) Pair Pal: Following" : "$(eye-closed) Pair Pal: Not following";
  statusBarItem.tooltip = "Click to toggle whether your view follows the agent's position";
}

function config() {
  const cfg = vscode.workspace.getConfiguration("commandCenter");
  return {
    apiUrl: cfg.get("apiUrl") || "http://localhost:3789",
    sessionId: cfg.get("sessionId") || "",
  };
}

async function startPolling(context) {
  const { apiUrl, sessionId } = config();
  if (!sessionId) {
    // Nothing to connect to yet — Phase A has no session-id handoff from a
    // walkthrough job, so this is set by hand for smoke testing until that
    // lands. No error shown: an uninstalled/unconfigured Pair Pal degrades
    // silently, same failure mode as the extension not being installed.
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  try {
    await connectWorkspace(apiUrl, sessionId, folder?.uri.fsPath || "");
  } catch (err) {
    vscode.window.showWarningMessage(`Pair Pal: couldn't connect to Command Center — ${err.message}`);
    return;
  }

  polling = true;
  context.subscriptions.push({ dispose: () => { polling = false; } });

  let attempt = 0;
  while (polling) {
    try {
      const { pendingCommand } = await pollCommands(apiUrl, sessionId);
      attempt = 0;
      if (pendingCommand && pendingCommand.id !== lastCommandId) {
        await applyCommand(pendingCommand, folder);
        lastCommandId = pendingCommand.id;
        await ackCommand(apiUrl, sessionId, pendingCommand.id);
      }
    } catch (err) {
      attempt += 1;
      await sleep(nextBackoffMs(attempt));
    }
  }
}

async function applyCommand(command, folder) {
  if (!shouldShowPresence(command)) {
    clearDecorations();
    return;
  }

  const uri = folder ? vscode.Uri.joinPath(folder.uri, command.file) : vscode.Uri.file(command.file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });

  const zeroBased = toZeroBasedRange(command);
  const start = new vscode.Position(zeroBased.start.line, zeroBased.start.character);
  const end = new vscode.Position(zeroBased.end.line, zeroBased.end.character);
  const range = new vscode.Range(start, end);

  editor.setDecorations(caretDecorationType, [
    { range: new vscode.Range(start, start), renderOptions: { after: { contentText: command.label || FALLBACK_LABEL } } },
  ]);
  editor.setDecorations(selectionDecorationType, [range]);

  if (shouldReveal(followAgentEnabled, command)) {
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

function clearDecorations() {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(caretDecorationType, []);
    editor.setDecorations(selectionDecorationType, []);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
