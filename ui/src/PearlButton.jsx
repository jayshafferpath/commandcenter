// Pearl: a persistent supervisor session, not an in-app chat. This button
// just ensures she exists (spawning her, briefed, on first click) and opens
// a real iTerm2 window attached to her — no transcript rendered here, no
// polling. You drive her directly in the terminal from there.

import { useState } from "react";

export function PearlButton({ actionsEnabled, name = "Pearl" }) {
  const [state, setState] = useState("idle"); // idle | opening | error
  const [error, setError] = useState(null);

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

  return (
    <span className="pearl-button-wrap">
      <button
        type="button"
        className="btn pearl-toggle"
        onClick={open}
        disabled={!actionsEnabled || state === "opening"}
        title={
          !actionsEnabled
            ? `${name} is disabled (set DASHBOARD_ALLOW_ACTIONS=true)`
            : `Open ${name} — creates her session if it doesn't exist yet`
        }
      >
        ● {state === "opening" ? "opening…" : name}
      </button>
      {state === "error" && <span className="pearl-error-inline">{error}</span>}
    </span>
  );
}
