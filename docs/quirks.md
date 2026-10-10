# Quirks, bugs and version differences

Each entry needs a decision: **reproduce** (match the original exactly) or **fix**.

| ID | Description | Source | Status | Decision |
|---|---|---|---|---|
| Q1 | Every piece created on a certain turn may move only one square on the turn it is created. Cause unknown to the developers. | 3.01 "Last Minute Notes": "We may have a bug that causes every piece created on a certain turn to only move one square on the turn that it's created. Call us if you figure out what causes it. (We may have fixed it, anyway.)" | Not yet located in code | Pending |
| Q2 | Combat and computer-opponent randomness is reseeded from the Mac's clock (seconds) at the end of every day, so outcomes depend on wall-clock time and a saved game does not continue the same random sequence. Proposed for the port: draw each day's seed from the server instead, which keeps the same distribution of outcomes and lets both browsers compute identical results. | `CODE 1 + 0x1F74`, see [findings.md](findings.md#randomness) | Confirmed in code | Pending |

## Open items (not yet classified)

- **Mover day-dependent random check** (`CODE 5 + 0x23C4`): random failures that begin on
  day 30 and reach 6 in 16 from day 60. What it gates is unknown. See
  [findings.md](findings.md#day-dependent-random-check-in-mover).
- **Every third day after day 20** (`CODE 1 + 0x199A`): the day loop does something extra.
  Not yet identified.
