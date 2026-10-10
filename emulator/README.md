# Emulator

Basilisk II runs System 7.5.3 headless on an Xvfb display. It is driven with `xdotool`
through `mac.sh` and observed through screenshots.

## Configuration

Matches the Windows setup the game was originally run under: Mac IIci model (`modelid 5`),
68040 CPU, FPU, 8 MB RAM, 1024×768 window. `prefs.template` holds the settings;
`setup.sh` fills in paths and writes `~/.config/BasiliskII/prefs`.

## Starting

```bash
emulator/setup.sh            # SC_EMU_WORK (default ~/sc-emu), SC_DISPLAY (default :9)
emulator/mac.sh shot boot 20 # wait 20 s, capture the Mac screen to $SC_EMU_WORK/shots/boot.png
```

If the previous session ended without a Mac shutdown, System 7.5 shows a
"not shut down properly" notice at boot; `mac.sh key Return` dismisses it.

## Layout of the Mac side

- `MacOS753:SC301:Strategic Conquest 3.01` is the game (copied in by `setup.sh`).
- `MacOS753:StrategicConquest:` holds Strategic Conquest Plus 2.055 from the original disk.
- The **Unix** volume on the desktop is `$SC_EMU_WORK/share` on the host. Saving games there
  makes them available immediately. Finder info is kept in `share/.finf/`.

## Screen coordinates (Mac coordinates, 1024×768)

| Item | Position |
|---|---|
| File menu title | 53, 9 |
| File > Resume Game… | 95, 43 |
| File > Save as… | 79, 75 |
| Open dialog: Open button | 430, 219 |
| Moves menu title | 137, 9 |
| Moves > Skip | 135, 155 |
| Options menu title | 263, 9 |
| Options > Auto Play | 276, 43 |
| Save dialog: Desktop button | 430, 144 |
| Save dialog: Save button | 430, 245 |
| Save dialog: name field | 259, 239 |
| Map cell centre (column c, row r), unscrolled, approx. | 11 + 16·c, 84 + 12·r |

## Game behavior relevant to automation

- **Save** and **Save as…** are deferred to the end of the round, after the computer moves.
  A notice appears first; the file dialog appears when the round ends.
- **Resume Game…** is also deferred to the end of the day, and is unavailable while the
  setup dialog is up: start a throwaway game first. Its prompt reads "A new game will be
  created after this day has completed"; OK then leads to the file dialog once the day ends.
- **Auto Play** starts the following day and plays the human side. About 50 days pass per
  minute at skill level 1. Selecting it again turns it off. The Auto Play state is saved with
  the game (save-file offset 9362); clearing that byte loads the game with Auto Play off.
- To load a save from the host, `emulator/put-save.sh <file.sav> [name]` copies it into the
  shared folder with the Finder info the game's file dialog needs.
- A new single-player game shows a setup dialog, then a production dialog at day 0,
  then advances to day 4 when the first Army is built.
