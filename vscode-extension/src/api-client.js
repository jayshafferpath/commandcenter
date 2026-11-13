// Thin HTTP client for the Command Center API's Pair Pal routes. No
// retry/backoff logic lives here — that's extension.js's long-poll loop,
// which already has its own backoff (see followState.js) and needs to tell
// "server said no new command yet" apart from "the request itself failed."

const DEFAULT_TIMEOUT_MS = 5_000;
// The server's own long-poll cap is ~25s (see api/vscode.js); this needs
// to comfortably outlast that, not match it, or a slow-but-healthy server
// response would look identical to a hung connection.
const LONG_POLL_TIMEOUT_MS = 30_000;

async function request(apiUrl, path, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const res = await fetch(`${apiUrl}${path}`, {
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    ...options,
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error || `${path} failed with ${res.status}`);
  }
  return body;
}

export function connectWorkspace(apiUrl, id, repo) {
  return request(apiUrl, `/api/vscode/${id}/connect`, {
    method: "POST",
    body: JSON.stringify({ repo }),
  });
}

export function pollCommands(apiUrl, id) {
  return request(apiUrl, `/api/vscode/${id}/commands`, { method: "GET" }, LONG_POLL_TIMEOUT_MS);
}

export function ackCommand(apiUrl, id, cmdId) {
  return request(apiUrl, `/api/vscode/${id}/commands/${cmdId}/ack`, { method: "POST" });
}
