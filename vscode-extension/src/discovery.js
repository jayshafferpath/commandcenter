// Pure decision logic for automatic review discovery — kept free of
// `vscode`/`fetch` so it's unit-testable without an extension host, same as
// followState.js. extension.js feeds it each GET /api/vscode/discover
// response and acts on the step it returns.

// Idle re-check interval while nothing matches. Short, because the agent's
// first `move` 404s until this loop has connected — a long idle interval
// would lose the first few elements of every walkthrough.
export const DISCOVERY_IDLE_MS = 2_000;

// `disconnect` and `connectTo` can both be set: a different review taking
// over the same workspace drops the old one's decorations before connecting
// to the new one.
export function nextConnectionStep(connectedId, discovery) {
  const matchedId = discovery?.match?.reviewId ?? null;
  if (matchedId === connectedId) return { disconnect: false, connectTo: null };
  return { disconnect: Boolean(connectedId), connectTo: matchedId };
}

// Lets the extension log an ambiguous match once when it appears, not on
// every idle re-check while it persists.
export function ambiguityKey(discovery) {
  const ids = discovery?.ambiguous ?? [];
  return ids.length > 1 ? [...ids].sort().join(",") : null;
}
