# Simple Mix 2.1.4

Simple Mix 2.1.4 packages the desktop app for Windows x64, macOS Apple Silicon and Linux x64. This build includes per-track loudness matching alongside the multitrack editing and export workflow.

## Highlights

- Analyze and match loudness across the session or selected tracks, with a configurable working target or a reduce-only mode. Review proposed gains before applying them; changes are reversible and do not modify source files.
- Check overlapping transitions against the proposed gains and locate areas with limited peak headroom.
- Detect BPM and beat grids, correct tempo manually, zoom into waveforms, move multiple tracks together, and create multiple fade points per track.
- Estimate musical key and show Camelot compatibility suggestions.
- Save projects with managed audio assets and export WAV, FLAC or MP3. Optional normalization and mastering are separate from track loudness matching.
- Use the interface in English or Spanish.

## Downloads

| Platform | Package |
| --- | --- |
| Windows x64 | NSIS installer (`.exe`) |
| macOS Apple Silicon | Disk image (`.dmg`) |
| Linux x64 | AppImage (`.AppImage`) |

The installers use FFmpeg 8.1.2 and LAME 3.100 built with LGPL-compatible options. Their corresponding source archives, licenses, checksums and installer checksums are included with the release. These builds are not notarized or code-signed for public distribution; consult the platform installation prompts before opening them.

Automatic BPM and key analysis are estimates and may need manual correction. The optional mastering stage is not a substitute for listening to the complete exported mix.
