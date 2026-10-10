#!/bin/bash
# Drives the headless Basilisk II window with xdotool.
# Coordinates are Mac screen coordinates (0,0 = top-left of the 1024x768 Mac screen);
# OX/OY give the emulator window's offset on the X display.
#
#   mac.sh click X Y              single click
#   mac.sh dclick X Y             double click
#   mac.sh drag X1 Y1 X2 Y2       press at X1,Y1, move to X2,Y2, release
#   mac.sh menu MX MY IX IY       press on menu title MX,MY, release on item IX,IY
#   mac.sh key KEYSYM...          xdotool key names
#   mac.sh type TEXT              type text
#   mac.sh shot NAME [DELAY]      wait DELAY seconds (default 1), save $SHOTS/NAME.png of the Mac screen
export DISPLAY=${SC_DISPLAY:-:9}
OX=${OX:-38}; OY=${OY:-26}
SHOTS=${SHOTS:-${SC_EMU_WORK:-$HOME/sc-emu}/shots}
cmd=$1; shift
case $cmd in
  click)  xdotool mousemove $(( $1 + OX )) $(( $2 + OY )); sleep 0.3; xdotool click 1 ;;
  dclick) xdotool mousemove $(( $1 + OX )) $(( $2 + OY )); sleep 0.3; xdotool click --repeat 2 --delay 120 1 ;;
  drag)   xdotool mousemove $(( $1 + OX )) $(( $2 + OY )); sleep 0.3; xdotool mousedown 1; sleep 0.3
          xdotool mousemove $(( $3 + OX )) $(( $4 + OY )); sleep 0.5; xdotool mouseup 1 ;;
  menu)   xdotool mousemove $(( $1 + OX )) $(( $2 + OY )); sleep 0.3; xdotool mousedown 1; sleep 0.6
          xdotool mousemove $(( $3 + OX )) $(( $4 + OY )); sleep 0.6; xdotool mouseup 1 ;;
  key)    xdotool key "$@" ;;
  type)   xdotool type --delay 80 "$*" ;;
  shot)   mkdir -p "$SHOTS"; sleep "${2:-1}"
          import -window root -crop 1024x768+${OX}+${OY} +repage "$SHOTS/$1.png" && echo "$SHOTS/$1.png" ;;
  *)      echo "unknown command: $cmd" >&2; exit 1 ;;
esac
