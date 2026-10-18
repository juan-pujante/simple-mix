# Third-party notices

Simple Mix source code is licensed under the MIT License. Third-party software remains under its own license; this document records components used by the app and release pipeline.

## Electron and electron-builder

Electron and electron-builder are distributed under the MIT License. Their license texts and notices are included with their respective distributions.

## FFmpeg

Simple Mix runs FFmpeg as a separate command-line program for audio decoding, encoding and mastering. The development tool `ffmpeg-static` is licensed under GPL-3.0-or-later and is used only to locate a local build-time executable. Packaged app builds ship the FFmpeg executable and its notices as separate resources; they do not include the `ffmpeg-static` package.

FFmpeg's default license is LGPL 2.1 or later. Enabling GPL components changes the applicable FFmpeg license to GPL; enabling `--enable-version3` changes it to LGPLv3; enabling `--enable-nonfree` makes that binary non-redistributable. The currently cached macOS ARM executable enables all three options, so it must not be shipped. The packager blocks all three configurations until we have vetted builds and included their applicable licenses and corresponding source. See [FFmpeg legal considerations](https://ffmpeg.org/legal.html).
