"""Odds of an attack, for each attacker and defender at full strength (docs/rules/combat.md).

Usage: python3 -I tools/analysis/combat_odds.py

Prints a Markdown grid: attackers down the side, defenders across the top, and in each cell
the chance (percent) that the attacker wins / is repelled / loses, from the strength ratio,
the column modifiers and the combat results table, with the die's six faces equally likely
(the game's generator gives each face 16-18% of the time). The defender is in the open (not
in a city, where ships are attacked at +4) and a Submarine defending is spotted.
"""
NAMES = ["Army", "Fighter", "Destroyer", "Submarine", "Carrier", "Transport", "Battleship", "Bomber"]
ARMY, FIGHTER, DESTROYER, SUBMARINE, CARRIER, TRANSPORT, BATTLESHIP, BOMBER = range(8)
STRENGTH = [1, 1, 4, 3, 10, 3, 18, 1]
SHIPS = {DESTROYER, SUBMARINE, CARRIER, TRANSPORT, BATTLESHIP}
WARSHIPS = {DESTROYER, SUBMARINE, CARRIER, BATTLESHIP}
AIRCRAFT = {FIGHTER, BOMBER}
# Combat results table by die (rows) and column: W attacker wins, L loses, R repelled.
CRT = ["LLLLLRR", "LLLLRRW", "LLLRRWW", "LLRRWWW", "LRRWWWW", "LRWWWWW"]


def column(a, d):
    ratio = (STRENGTH[a] * 10) // STRENGTH[d]
    col = 1 if ratio <= 1 else 2 if ratio == 2 else 3 if ratio <= 5 else 4 if ratio <= 10 \
        else 5 if ratio <= 20 else 6 if ratio <= 40 else 7
    if a == DESTROYER and d == TRANSPORT:
        col += 2
    if a == FIGHTER and d in (SUBMARINE, TRANSPORT, BOMBER):
        col += 1
    if a == SUBMARINE and d in SHIPS:
        col += 4
    if a == DESTROYER and d == SUBMARINE:
        col += 4
    if a == ARMY and d in WARSHIPS:
        col -= 1
    if a == BOMBER and d in AIRCRAFT:
        col -= 1
    if a == BOMBER and d in SHIPS:
        col = 1
    return min(7, max(1, col))


def cell(a, d):
    if a == TRANSPORT:
        return "can't attack"
    if a == ARMY and d == SUBMARINE:
        return "no fight"
    if a == SUBMARINE and d in AIRCRAFT:
        return "no fight"
    if a == SUBMARINE and d == ARMY:
        return "sub lost"
    if a == BOMBER and d not in AIRCRAFT:
        return "blast"
    col = column(a, d)
    results = [row[col - 1] for row in CRT]
    pct = [round(100 * results.count(k) / 6) for k in "WRL"]
    return "/".join(str(p) for p in pct)


def main():
    print("| Attacker ↓ Defender → | " + " | ".join(NAMES) + " |")
    print("|---" * (len(NAMES) + 1) + "|")
    for a in range(8):
        print(f"| **{NAMES[a]}** | " + " | ".join(cell(a, d) for d in range(8)) + " |")


if __name__ == "__main__":
    main()
