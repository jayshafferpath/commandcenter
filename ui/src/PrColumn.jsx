// Every open GitHub PR you authored or are assigned on, across every repo —
// a dedicated section, not something bolted onto a ticket's detail view.
// Ticket-linked PRs show up here too if you authored/are assigned on them;
// this column doesn't care whether a PR traces back to a Jira ticket.
//
// Not focusable/dispatchable — only tickets can be the context for a
// dispatched agent, so this has no onFocus/focusedContext wiring.

import { useCallback, useEffect, useState } from "react";

const ROLE_LABEL = { author: "mine", assignee: "assigned" };

export function PrColumn() {
  const [prs, setPrs] = useState([]);
  const [error, setError] = useState(null);

  const fetchPrs = useCallback(async () => {
    try {
      const res = await fetch("/api/prs");
      const data = await res.json();
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setError(null);
      setPrs(data.prs || []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    fetchPrs();
    const interval = setInterval(fetchPrs, 60000);
    return () => clearInterval(interval);
  }, [fetchPrs]);

  return (
    <div className="focus-column focus-column--prs">
      <div className="focus-column-head">
        <span className="focus-column-title">Pull Requests</span>
        <span className="focus-column-count">{prs.length}</span>
      </div>

      {error && <div className="focus-column-error">{error}</div>}

      <div className="focus-column-body">
        {prs.length === 0 && !error && (
          <div className="focus-column-empty">No open PRs.</div>
        )}
        {prs.map((pr) => (
          <div className="focus-item" key={pr.url}>
            <div className="focus-item-row">
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="focus-item-key"
              >
                {pr.repo}#{pr.number}
              </a>
              <span className="focus-item-summary">{pr.title}</span>
              {pr.isDraft && <span className="focus-item-status">draft</span>}
              {pr.roles.map((role) => (
                <span className="focus-item-status" key={role}>
                  {ROLE_LABEL[role] || role}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
