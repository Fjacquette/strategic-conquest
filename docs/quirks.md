# Quirks, bugs and version differences

Each entry needs a decision: **reproduce** (match the original exactly) or **fix**.

| ID | Description | Source | Status | Decision |
|---|---|---|---|---|
| Q1 | Every piece created on a certain turn may move only one square on the turn it is created. Cause unknown to the developers. | 3.01 "Last Minute Notes": "We may have a bug that causes every piece created on a certain turn to only move one square on the turn that it's created. Call us if you figure out what causes it. (We may have fixed it, anyway.)" | Not yet located in code | Pending |

## Open items (not yet classified)

- **Mover turn-dependent random check** (`CODE 5 + 0x23C4`): random failures that begin when
  an unidentified counter reaches 30. What it gates is unknown. See
  [findings.md](findings.md#turn-dependent-random-check-in-mover).
