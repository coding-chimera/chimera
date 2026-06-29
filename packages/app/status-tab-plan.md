# Web UI status tab plan

## Goal

Replace the narrow review-only sidebar tab with a persistent status tab that summarizes session health and related operational state in one place.

## User decisions

- Provider balance should not live in the prompt model/variant controls.
- Provider balance does not need its own sidebar tab.
- The existing review tab should become a persistent status tab.
- The status tab should include Git changes, Current Work Brief, and detailed provider balance state.
- Compact Codex quota summaries should show the lower remaining percentage between the weekly and 5h windows, because either exhausted window makes Codex unavailable.
- Implement the work in separate commits by step.

## Steps

### 1. Status tab shell and Git changes

- Rename the sidebar review tab to status.
- Make the status tab available on desktop independently of whether review changes exist.
- Preserve the existing review panel and Git changes behavior inside the status tab.
- Reuse the existing file-tree changes list where possible.

### 2. Work brief data and status section

- Add Web sync state for the current session work brief.
- Load the work brief for the active session.
- Update Web sync from `work_brief.updated` events.
- Add a status section that summarizes intent, open questions, relevant evidence, and closeout.

### 3. Provider balance status section

- Move provider balance display out of prompt controls.
- Add a provider balance status section in the status tab.
- Show complete quota/balance details in the panel.
- Show compact quota summaries with the lowest Codex remaining window when space is constrained.

### 4. Verification and packaging readiness

- Run Chimera propagation audit after code mutations.
- Run `bun typecheck` from `packages/app`.
- Run focused app tests for touched sync/status code when available.
- Commit any verification fixes separately if needed.
