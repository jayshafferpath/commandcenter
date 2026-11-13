// Pure decision logic for Follow Agent and the long-poll retry loop — kept
// free of `vscode`/`fetch` so it's unit-testable without an extension host.

// Follow Agent decides whether a `move` also scrolls Jay's viewport; it
// never affects whether the decoration itself updates (that always
// happens) or Jay's actual selection (never touched either way).
export function shouldReveal(followAgentEnabled, command) {
  return Boolean(followAgentEnabled) && command?.type === "move" && command?.reveal !== false;
}

// Exponential backoff, capped, for the long-poll loop's own retry after a
// network error (the server being down, a laptop asleep mid-poll) — not
// used for the server's own ~25s long-poll timeout, which is a normal,
// expected return rather than a failure.
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

export function nextBackoffMs(attempt) {
  const exponential = BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, MAX_BACKOFF_MS);
}
