#!/bin/bash
# Builds a Basilisk II environment from originals/ and boots it headless on an Xvfb display.
#
# Environment:
#   SC_EMU_WORK  working directory for the disk image, shared folder and screenshots (default ~/sc-emu)
#   SC_DISPLAY   X display to use (default :9)
#
# The System 7.5.3 disk gets a folder "SC301" containing Strategic Conquest 3.01.
# The host folder $SC_EMU_WORK/share appears on the Mac desktop as the "Unix" volume;
# saving games there makes them immediately available on the host.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
ORIG="$REPO/originals"
WORK=${SC_EMU_WORK:-$HOME/sc-emu}
DISP=${SC_DISPLAY:-:9}

for pkg in basilisk2:BasiliskII xdotool:xdotool imagemagick:import hfsutils:hcopy xvfb:Xvfb unar:unar; do
    command -v "${pkg#*:}" >/dev/null || apt-get install -y "${pkg%%:*}" >/dev/null
done
python3 -c "import rsrcfork, capstone" 2>/dev/null || pip install --break-system-packages -q -r "$REPO/tools/requirements.txt"

mkdir -p "$WORK/share" "$WORK/shots"

if [ ! -f "$WORK/MacOS753.image" ]; then
    python3 -I "$REPO/tools/analysis/unzip_sparse.py" "$ORIG/MacOS753.zip" MacOS753.image "$WORK/MacOS753.image"
    "$REPO/tools/extract.sh"
    python3 -I "$REPO/tools/analysis/ad2macbin.py" \
        "$REPO/build/unpacked/StratCon 3.0/Strategic Conquest 3.01.rsrc" "Strategic Conquest 3.01" "$WORK/sc301.bin"
    hmount "$WORK/MacOS753.image" >/dev/null
    hmkdir ':SC301' 2>/dev/null || true
    hcopy -m "$WORK/sc301.bin" ':SC301:'
    humount
fi

mkdir -p "$HOME/.config/BasiliskII"
sed -e "s#@ROM@#$ORIG/MacIIci.ROM#" -e "s#@DISK@#$WORK/MacOS753.image#" -e "s#@SHARE@#$WORK/share#" \
    "$REPO/emulator/prefs.template" > "$HOME/.config/BasiliskII/prefs"

if ! DISPLAY="$DISP" xdotool getdisplaygeometry >/dev/null 2>&1; then
    setsid Xvfb "$DISP" -screen 0 1100x820x24 </dev/null >"$WORK/xvfb.log" 2>&1 &
    sleep 1
fi
cd "$WORK"
DISPLAY="$DISP" setsid BasiliskII </dev/null >"$WORK/basilisk.log" 2>&1 &
echo "Basilisk II starting on display $DISP; working directory $WORK"
