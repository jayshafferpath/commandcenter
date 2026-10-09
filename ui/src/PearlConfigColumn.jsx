// Editor for SOUL.md — who Pearl is and how Jay wants her to work. Read
// fresh by pearl.js on every spin-up, so saving here changes her next
// session, not the one already running (she's a persistent tmux session;
// nothing re-reads this mid-conversation).

import { useCallback, useEffect, useState } from "react";

export function PearlConfigColumn({ name = "Pearl" }) {
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState(null);

  const fetchSoul = useCallback(async () => {
    try {
      const res = await fetch("/api/pearl/soul");
      const data = await res.json();
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setError(null);
      setContent(data.content);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    fetchSoul();
  }, [fetchSoul]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pearl/soul", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setSavedAt(Date.now());
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="focus-column focus-column--pearl-config">
      <div className="focus-column-head">
        <span className="focus-column-title">SOUL.md</span>
        <span className="focus-column-count">{name}</span>
      </div>

      {error && <div className="focus-column-error">{error}</div>}

      <div className="focus-column-body focus-column-body--pearl-config">
        <textarea
          className="pearl-soul-editor"
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setSavedAt(null);
          }}
          placeholder={loaded ? "" : "Loading…"}
          disabled={!loaded}
          spellCheck={false}
        />
        <div className="pearl-soul-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={save}
            disabled={!loaded || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {savedAt && <span className="pearl-soul-saved">Saved — takes effect next spin-up.</span>}
        </div>
      </div>
    </div>
  );
}
