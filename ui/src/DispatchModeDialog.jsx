// One shared choice, asked the same way everywhere an agent gets spun up —
// a ticket row's spawn button and the general dispatch bar both go through
// this instead of each having their own toggle/button-pair, so "how do I
// start an agent" means the same thing regardless of where you started it.

export function DispatchModeDialog({ label, onChoose, onCancel }) {
  return (
    <div className="dispatch-mode-overlay" onClick={onCancel}>
      <div className="dispatch-mode-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dispatch-mode-dialog-label">{label}</div>
        <div className="dispatch-mode-dialog-options">
          <button
            type="button"
            className="dispatch-mode-dialog-option"
            onClick={() => onChoose("headless")}
          >
            <span className="dispatch-mode-dialog-option-title">Headless</span>
            <span className="dispatch-mode-dialog-option-desc">
              Runs unattended, finishes on its own. Check back later.
            </span>
          </button>
          <button
            type="button"
            className="dispatch-mode-dialog-option"
            onClick={() => onChoose("interactive")}
          >
            <span className="dispatch-mode-dialog-option-title">Interactive</span>
            <span className="dispatch-mode-dialog-option-desc">
              Opens a terminal immediately so you can keep talking to it.
            </span>
          </button>
        </div>
        <button type="button" className="dispatch-mode-dialog-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
