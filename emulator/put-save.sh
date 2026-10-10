#!/bin/bash
# Copies a save file into the emulator's shared "Unix" volume with Strategic Conquest 3.01
# Finder info (type 'SC∂ ', creator 'SCÆ '), so the game's Resume Game dialog lists it.
#
#   put-save.sh <file.sav> [name-on-mac]
set -euo pipefail
SRC=$1
NAME=${2:-$(basename "$SRC" .sav)}
SHARE=${SC_EMU_WORK:-$HOME/sc-emu}/share
mkdir -p "$SHARE/.finf"
cp "$SRC" "$SHARE/$NAME"
# FInfo: type, creator, flags 0x0100, location (-1,-1), folder 0
printf 'SC\xb6 SC\xc6 \x01\x00\xff\xff\xff\xff\x00\x00' > "$SHARE/.finf/$NAME"
echo "$SHARE/$NAME"
