# Simple Mix 2.1.4

Simple Mix 2.1.4 packages the desktop app for Windows x64, macOS Apple Silicon and macOS Intel. This build includes per-track loudness matching alongside the multitrack editing and export workflow.

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
| Windows x64 | Previously built; not published |
| macOS Apple Silicon | Previously built; not published |
| macOS Intel | Previously built; not published |
| Linux x64 | No 2.1.4 installer was built. AppImage is the configured future release target; Debian packages are not included. |

The earlier Windows and macOS packages are withheld while the bundled FFmpeg build configurations and corresponding source are reviewed. No installer is available from this repository. The earlier macOS Apple Silicon app was smoke-tested; native Windows and Intel Mac installation tests remain pending.

Automatic BPM and key analysis are estimates and may need manual correction. The optional mastering stage is not a substitute for listening to the complete exported mix.
