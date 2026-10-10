#!/bin/bash
# Unpacks the Strategic Conquest 3.01 StuffIt archive from originals/ and writes the
# application's raw resource fork to build/sc301.rsrc for the analysis tools.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
SIT="$REPO/originals/StrategicConquest-3.01.sit"
OUT="$REPO/build"

command -v unar >/dev/null || apt-get install -y unar >/dev/null
python3 -c "import rsrcfork, capstone" 2>/dev/null || pip install --break-system-packages -q -r "$REPO/tools/requirements.txt"

rm -rf "$OUT/unpacked" && mkdir -p "$OUT/unpacked"
unar -q -forks visible -o "$OUT/unpacked" "$SIT"
python3 -I "$REPO/tools/analysis/appledouble.py" \
    "$OUT/unpacked/StratCon 3.0/Strategic Conquest 3.01.rsrc" "$OUT/sc301.rsrc"
sha256sum "$OUT/sc301.rsrc"
