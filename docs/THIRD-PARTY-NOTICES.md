# Third-party notices

Simple Mix source code is licensed under the MIT License. Third-party software remains under its own license; this document records components used by the app and release pipeline.

## Electron and electron-builder

Electron and electron-builder are distributed under the MIT License. Their license texts and notices are included with their respective distributions.

## FFmpeg

Simple Mix runs FFmpeg as a separate command-line program for audio decoding, encoding and mastering. Packaged builds use FFmpeg 8.1.2 with LAME 3.100 for MP3 encoding. FFmpeg is built with LGPL-2.1-or-later components only; LAME is LGPL-2.0-or-later. Neither executable enables GPL, LGPLv3 or nonfree components. The app includes both license texts, the exact configuration and source checksums under `resources/ffmpeg/`. The corresponding source archives are published alongside each installer release.

Build automation is adapted from [acoustid/ffmpeg-build](https://github.com/acoustid/ffmpeg-build), licensed under MIT; its license is included in `scripts/ffmpeg-build/LICENSE`. Source download checksums are pinned in `scripts/build-ffmpeg.cjs`. See [FFmpeg legal considerations](https://ffmpeg.org/legal.html).
