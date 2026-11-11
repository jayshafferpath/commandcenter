// Free-form agent dispatch with no ticket context — per-ticket work is
// spawned directly from a ticket row's own button, which carries the full
// ticket context server-side. This bar is for everything else: a general
// instruction against DEV_ROOT. Headless vs. interactive is asked via the
// shared DispatchModeDialog once this is submitted, not decided here — same
// choice, same place it's asked, regardless of where an agent started.

import { useState } from "react";

export function DispatchBar({ onDispatch, error }) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [brain, setBrain] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!prompt.trim() || sending) return;

    setSending(true);
    const ok = await onDispatch(prompt, brain);
    setSending(false);
    if (ok) setPrompt("");
  };

  return (
    <form className="dispatch-bar" onSubmit={submit}>
      <div className="dispatch-bar-row">
        <textarea
          className="dispatch-input"
          placeholder="Dispatch a general agent…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(e);
            }
          }}
          disabled={sending}
          rows={2}
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={sending || !prompt.trim()}
        >
          {sending ? "…" : "Dispatch"}
        </button>
      </div>
      <label className="dispatch-brain-toggle">
        <input
          type="checkbox"
          checked={brain}
          onChange={(e) => setBrain(e.target.checked)}
          disabled={sending}
        />
        Brain view — give it a live canvas to think out loud on
      </label>
      {error && <span className="action-error">{error}</span>}
    </form>
  );
}
