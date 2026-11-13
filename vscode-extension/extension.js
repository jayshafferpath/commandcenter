// Pair Pal: the agent's own simulated presence in Jay's editor. Decoration
// APIs only — never editor.selection, never revealRange outside Follow
// Agent, never anything that could move Jay's real cursor or steal focus.
// See .plans/vscode-walkthrough-bridge.md Phase A.
import * as vscode from "vscode";
import { ackCommand, connectWorkspace, discoverReview, pollCommands } from "./src/api-client.js";
import {
  CARET_COLOR,
  findVisibleEditorIndex,
  SELECTION_COLOR,
  shouldShowPresence,
  toZeroBasedRange,
} from "./src/decorations.js";
import { ambiguityKey, DISCOVERY_IDLE_MS, nextConnectionStep } from "./src/discovery.js";
import { nextBackoffMs, shouldReveal } from "./src/followState.js";

const FALLBACK_LABEL = "Command Center";

let outputChannel;
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

  outputChannel = vscode.window.createOutputChannel("Pair Pal");

  context.subscriptions.push(
    outputChannel,
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
  const folder = vscode.workspace.workspaceFolders?.[0];
  polling = true;
  context.subscriptions.push({ dispose: () => { polling = false; } });

  if (sessionId) {
    await runManualSession(apiUrl, sessionId, folder);
    return;
  }
  if (!folder) return;
  await runDiscovery(apiUrl, folder);
}

// commandCenter.sessionId set by hand: an override for smoke testing or a
// review discovery can't pick (several walkthroughs on one repo). Connects
// once and never re-checks whether the review is still in progress.
async function runManualSession(apiUrl, sessionId, folder) {
  try {
    await connectWorkspace(apiUrl, sessionId, folder?.uri.fsPath || "");
  } catch (err) {
    vscode.window.showWarningMessage(`Pair Pal: couldn't connect to Command Center — ${err.message}`);
    return;
  }

  let attempt = 0;
  while (polling) {
    try {
      await pollOnce(apiUrl, sessionId, folder);
      attempt = 0;
    } catch (err) {
      attempt += 1;
      await sleep(nextBackoffMs(attempt));
    }
  }
}

// Re-checks discovery before every long poll, so a walkthrough that ends
// (round completed, review abandoned, session gone) disconnects within one
// long-poll cycle. Nothing is ever written into the workspace to hand off
// the review id: a .vscode/settings.json in the reviewed repo would dirty
// its tree, and ADVANCE_ROUND refuses a dirty tree.
async function runDiscovery(apiUrl, folder) {
  const repo = folder.uri.fsPath;
  let connectedId = null;
  let lastAmbiguity = null;
  let attempt = 0;
  while (polling) {
    try {
      const discovery = await discoverReview(apiUrl, repo);

      const ambiguity = ambiguityKey(discovery);
      if (ambiguity && ambiguity !== lastAmbiguity) {
        log(`Several walkthroughs in progress for ${repo} (${ambiguity}); connecting to none. Set commandCenter.sessionId to pick one.`);
      }
      lastAmbiguity = ambiguity;

      const step = nextConnectionStep(connectedId, discovery);
      if (step.disconnect) {
        log(`Walkthrough for review ${connectedId} is no longer in progress; disconnecting.`);
        disconnect();
        connectedId = null;
      }
      if (step.connectTo) {
        await connectWorkspace(apiUrl, step.connectTo, repo);
        connectedId = step.connectTo;
        log(`Connected to review ${connectedId}.`);
      }

      if (connectedId) {
        await pollOnce(apiUrl, connectedId, folder);
      } else {
        await sleep(DISCOVERY_IDLE_MS);
      }
      attempt = 0;
    } catch (err) {
      attempt += 1;
      await sleep(nextBackoffMs(attempt));
    }
  }
}

async function pollOnce(apiUrl, sessionId, folder) {
  const { pendingCommand } = await pollCommands(apiUrl, sessionId);
  if (pendingCommand && pendingCommand.id !== lastCommandId) {
    await applyCommand(pendingCommand, folder);
    lastCommandId = pendingCommand.id;
    await ackCommand(apiUrl, sessionId, pendingCommand.id);
  }
}

function disconnect() {
  clearDecorations();
  lastCommandId = null;
}

function log(message) {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

async function applyCommand(command, folder) {
  if (!shouldShowPresence(command)) {
    clearDecorations();
    return;
  }

  const uri = folder ? vscode.Uri.joinPath(folder.uri, command.file) : vscode.Uri.file(command.file);
  // The walkthrough skill already opened this file as a diff before sending the
  // move; opening it again with showTextDocument puts a second, raw editor on top
  // of that diff. If it's already visible anywhere — including as the modified
  // side of a diff editor — decorate that one instead of opening a new tab.
  const existingIndex = findVisibleEditorIndex(vscode.window.visibleTextEditors, uri.toString());
  const editor =
    existingIndex >= 0
      ? vscode.window.visibleTextEditors[existingIndex]
      : await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
          preserveFocus: true,
          preview: false,
        });

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
