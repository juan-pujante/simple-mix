# Simple Mix User Guide

Simple Mix is a local multitrack editor for preparing DJ and techno sessions. This guide covers the main workflow; the interface also includes tooltips for individual controls.

## 1. Create a session and add tracks

Choose **New** to start a session. Use **Add track** to import an audio file, then repeat for each track. The waveform appears in the timeline. The track list provides per-track controls such as mute, solo, level and tempo.

Imported audio is copied into the project's managed audio storage. When saving, keep the `.simplemix` project file together with its `Audio` folder. Move or back up the complete project folder so its media remains available. **Portable Copy** creates a single project file with its audio included.

## 2. Set tempo and align beats

Use **AUTO** on a track to estimate its BPM and beat grid. The displayed automatic tempo is rounded to a whole BPM, while the internal estimate retains precision for playback. The result is a suggestion: verify the downbeat and beat spacing against the waveform and by listening.

Set a track's BPM manually when needed. Lowering its target BPM slows the audio; raising it speeds the audio. The session BPM control sets a global target for linked tracks while preserving their musical timeline positions. Use the track's sync/link control to choose which tracks follow it.

Zoom with the timeline controls or Ctrl/Cmd+mouse wheel. Drag clips freely by default. Enable **Beat** snapping if you want grid alignment. Select multiple tracks with Ctrl/Cmd-click or a range with Shift-click, then drag or nudge them together. Arrow keys make precise moves; adjust the fine step shown in the interface. The waveform and current zoom remain in place while editing.

## 3. Shape transitions

Select a track and add volume automation points to create fades. A track starts without an automatic fade; add only the points you need. Move points to shape one or more fade-ins and fade-outs within the same track. Choose the curve style for the selected segment where available.

Use mute and solo to audition transitions. Track level and EQ controls help balance overlapping material. **Session → Match track loudness** analyzes the selected tracks or the whole session and proposes gain adjustments. Review the measurements and listen before applying them. The adjustment can be undone and does not alter the imported audio files.

## 4. Check musical key

Simple Mix estimates each track's musical key and displays its Camelot code when the analysis has enough evidence. Open **Harmony** for compatible-track suggestions. Key analysis can be ambiguous, particularly on percussive or atonal material; use manual correction when needed and treat recommendations as guidance rather than a guarantee of a good transition.

## 5. Save and recover work

Use **Save** (Ctrl/Cmd+S). The first save asks for a project location; subsequent saves update the active project. **Save As** creates a separate project copy. The title bar identifies the active project. **Undo** (Ctrl/Cmd+Z) and **Redo** (Ctrl/Cmd+Shift+Z) cover session edits. If the app finds a recovery copy after an unexpected close, review it before continuing.

Keep the `.simplemix` file and its `Audio` folder together. Do not rename or delete individual managed audio files. Older application versions may not support newer project formats, so keep a backup before opening a project in an older build.

## 6. Export a mix

Open **Export Mix**, choose the full session or an A–B range, then select the output format and quality. WAV and FLAC support uncompressed/lossless delivery; MP3 offers selectable bitrates. The operating-system file dialog is used only to choose the destination.

Normalization and mastering are optional export stages. Normalization adjusts the output peak. Mastering applies the chosen processing profile and measures the encoded result, including loudness and true peak. Track loudness matching is a separate mix-balancing step. Listen to the exported file before distributing or burning it.

For an audio CD master, export stereo WAV at 44.1 kHz and 16-bit depth. A CUE sheet can include session markers. Burning a physical disc requires separate disc-burning software and a CD-R or CD-RW drive. For USB playback, copy the exported audio file to the drive using your operating system.

## Keyboard shortcuts

| Action | Windows/Linux | macOS |
| --- | --- | --- |
| New session | Ctrl+N | Cmd+N |
| Save | Ctrl+S | Cmd+S |
| Save As | Ctrl+Shift+S | Cmd+Shift+S |
| Undo | Ctrl+Z | Cmd+Z |
| Redo | Ctrl+Shift+Z | Cmd+Shift+Z |
| Play/Pause | Space | Space |

Some shortcuts are disabled while a text field is being edited, so normal text editing continues to work.

## Troubleshooting

- **A track is missing after moving the project:** restore the complete project folder, including `Audio`, to the same relative layout.
- **BPM or key seems wrong:** run the relevant analysis again, then correct the value manually and check the beat grid by ear.
- **Audio crackles or playback is interrupted:** reduce the number of simultaneous heavy processing operations, check the selected audio output in Preferences, and try again.
- **An installer shows an unidentified developer warning:** the 2.1.4 packages are unsigned and macOS packages are not notarized. Only install software from a source you trust.
- **Linux launch fails:** use a supported desktop session and ensure required audio libraries are installed. Linux packaging is currently configured for AppImage; Debian packages are not part of this release.
