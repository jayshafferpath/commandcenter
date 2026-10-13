// Flat ticket list — plain Jira facts (status, due date, blockers), no
// inferred workflow state. Sorted by due date, same convention as
// TodoColumn, so "what needs attention soonest" means the same thing in
// both columns.

import { useState } from "react";
import { TicketDetail } from "./TicketDetail.jsx";
import { OpenInIterm } from "./SessionColumn.jsx";
import { IssueTypeIcon } from "./IssueTypeIcon.jsx";
import { daysUntil, dueTone, formatDue } from "./dueDate.js";

export function TicketColumn({ tickets, jiraBaseUrl, onSpawnAgent }) {
  const [expandedKey, setExpandedKey] = useState(null);

  const sorted = [...tickets].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  });

  return (
    <div className="focus-column focus-column--tickets">
      <div className="focus-column-head">
        <span className="focus-column-title">Tickets</span>
        <span className="focus-column-count">{sorted.length}</span>
      </div>

      <div className="focus-column-body">
        {sorted.length === 0 && (
          <div className="focus-column-empty">No active tickets.</div>
        )}
        {sorted.map((ticket) => {
          const isExpanded = expandedKey === ticket.key;
          const days = daysUntil(ticket.dueDate);
          const tone = dueTone(days);
          return (
            <div className="focus-item" key={ticket.key}>
              <div
                className="focus-item-row"
                role="button"
                tabIndex={0}
                onClick={() => setExpandedKey(isExpanded ? null : ticket.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setExpandedKey(isExpanded ? null : ticket.key);
                  }
                }}
              >
                <IssueTypeIcon issueType={ticket.issueType} />
                {jiraBaseUrl ? (
                  <a
                    href={`${jiraBaseUrl}/${ticket.key}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="focus-item-key"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {ticket.key}
                  </a>
                ) : (
                  <span className="focus-item-key">{ticket.key}</span>
                )}
                <span className="focus-item-summary">{ticket.summary}</span>
                {ticket.statusName && (
                  <span className="focus-item-status">{ticket.statusName}</span>
                )}
                {ticket.dueDate && (
                  <span className={`focus-item-due focus-item-due--${tone}`}>
                    {formatDue(ticket.dueDate, days)}
                  </span>
                )}
                {ticket.activeJobId ? (
                  <span onClick={(e) => e.stopPropagation()}>
                    <OpenInIterm jobId={ticket.activeJobId} />
                  </span>
                ) : (
                  <button
                    type="button"
                    className="focus-item-spawn-btn"
                    title="Spawn an agent on this ticket — asks headless or interactive first"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSpawnAgent(ticket);
                    }}
                  >
                    ⚡ agent
                  </button>
                )}
              </div>
              {isExpanded && <TicketDetail ticketKey={ticket.key} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
