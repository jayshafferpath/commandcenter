// Pearl: a persistent supervisor session, not an in-app chat. This button
// just ensures she exists (spawning her, briefed, on first click) and opens
// a real iTerm2 window attached to her — no transcript rendered here, no
// polling. You drive her directly in the terminal from there.

import { useState } from "react";

export function PearlButton({ actionsEnabled, name = "Pearl" }) {
  const [state, setState] = useState("idle"); // idle | opening | refreshing | error
  const [error, setError] = useState(null);
  const busy = state === "opening" || state === "refreshing";

  const open = async () => {
    setState("opening");
    setError(null);
    try {
      const res = await fetch("/api/pearl/open", { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        setState("error");
        setError(data.error);
        return;
      }
      setState("idle");
    } catch (err) {
      setState("error");
      setError(err.message);
    }
  };

  // Discards whatever she's mid-conversation about, so this asks first —
  // same confirm-before-destroy as closing a live session elsewhere in the
  // dashboard, just native rather than a modal since it's a single yes/no.
  const refresh = async () => {
    const confirmed = window.confirm(
      `Restart ${name}? Her current conversation will be lost; she'll reload SOUL.md and the briefing.`,
    );
    if (!confirmed) return;

    setState("refreshing");
    setError(null);
    try {
      const res = await fetch("/api/pearl/refresh", { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        setState("error");
        setError(data.error);
        return;
      }
      setState("idle");
    } catch (err) {
      setState("error");
      setError(err.message);
    }
  };

  return (
    <span className="pearl-button-wrap">
      <button
        type="button"
        className="btn pearl-toggle"
        onClick={open}
        disabled={!actionsEnabled || busy}
        title={
          !actionsEnabled
            ? `${name} is disabled (set DASHBOARD_ALLOW_ACTIONS=true)`
            : `Open ${name} — creates her session if it doesn't exist yet`
        }
      >
        ● {state === "opening" ? "opening…" : name}
      </button>
      <button
        type="button"
        className="btn pearl-refresh"
        onClick={refresh}
        disabled={!actionsEnabled || busy}
        title={`Restart ${name} — she'll reload SOUL.md and the briefing, losing her current conversation`}
      >
        {state === "refreshing" ? "restarting…" : "↻"}
      </button>
      {state === "error" && <span className="pearl-error-inline">{error}</span>}
    </span>
  );
}
