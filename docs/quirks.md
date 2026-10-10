# Quirks, bugs and version differences

Each entry needs a decision: **reproduce** (match the original exactly) or **fix**.

| ID | Description | Source | Status | Decision |
|---|---|---|---|---|
| Q1 | Every piece created on a certain turn may move only one square on the turn it is created. Cause unknown to the developers. | 3.01 "Last Minute Notes": "We may have a bug that causes every piece created on a certain turn to only move one square on the turn that it's created. Call us if you figure out what causes it. (We may have fixed it, anyway.)" | Not yet located in code | Pending |
| Q2 | Combat and computer-opponent randomness is reseeded from the Mac's clock (seconds) at the end of every day, so outcomes depend on wall-clock time and a saved game does not continue the same random sequence. Proposed for the port: draw each day's seed from the server instead, which keeps the same distribution of outcomes and lets both browsers compute identical results. | `CODE 1 + 0x1F74`, see [findings.md](findings.md#randomness) | Confirmed in code | Pending |

| Q3 | Debug cheat: holding Option-W while an attack resolves forces a win; Option-L forces a loss. | `ResolveCombat`, `CODE 3 + 0x0004` (reads the keyboard with `_GetKeys`) | Confirmed in code | Pending (suggest: drop) |
| Q4 | When a Transport or Carrier in a city with an owner loses a fight, the code destroys the *first piece on that square in piece-table order* instead of the ship. If an Army or Fighter was created earlier and sits in the same city, it is destroyed and the ship survives. | `KillStack`, `CODE 3 + 0x0374`; reproduced in the emulator harness (Battleship sinks a Transport in its city: the Army in the city dies, the Transport survives) | Confirmed by running the original code | Pending (suggest: fix, destroy the ship) |
| Q5 | A Battleship-versus-Submarine column modifier is computed but never added, so Battleships get no bonus against Submarines. Probably a removed or unfinished rule; behavior is consistent either way. | `CODE 3 + 0x018C` | Confirmed in code | Pending (suggest: keep as is) |

| Q6 | When the piece table is full (449 pieces), the local player's new unit takes over the slot of an existing *opponent* piece: the highest-numbered one that is not spotted and is not an Army, Fighter or Destroyer. Single player only. | `CODE 4 + 0x22E2` | Confirmed in code; rarely reached | Pending (suggest: raise the limit, drop this) |
| Q7 | Two-player speedups are not applied consistently. Moves and build times use modes 1–3, but double repair and the faster Bomber radius use modes 1 and 2 only, so in an AppleTalk game the Slave machine's units may repair at the single-player rate. Hot seat (mode 1) is fully consistent. | `CODE 5 + 0x4110`, `CODE 4 + 0x20EE` vs `CODE 4 + 0x11BA`, `CODE 1 + 0x021C` | Confirmed in code | Pending (suggest: apply all speedups to both players in the port's two-player games) |

See [rules/combat.md](rules/combat.md) and [rules/units.md](rules/units.md).

## Open items (not yet classified)

- **Mover day-dependent random check** (`CODE 5 + 0x23C4`): random failures that begin on
  day 30 and reach 6 in 16 from day 60. What it gates is unknown. See
  [findings.md](findings.md#day-dependent-random-check-in-mover).
- **Every third day after day 20** (`CODE 1 + 0x199A`): the day loop does something extra.
  Not yet identified.
