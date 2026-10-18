# Build and release

This document describes the public distribution workflow for Simple Mix. GitHub Actions builds platform installers and publishes tagged releases.

## Current 2.1.4 artifacts

The release workflow builds Windows x64 (NSIS), macOS Apple Silicon (DMG) and Linux x64 (AppImage) installers. It also publishes the exact FFmpeg and LAME source archives and an SHA-256 manifest alongside the packages.

The configured Linux target is **AppImage**. Debian packages are intentionally not included. Release artifacts must be built on their target operating systems so the bundled FFmpeg executable and native dependencies match the target platform.

## Preparing a release

1. Update source and tests on the default branch. Run `npm ci` and `npm test` on the supported platforms, then review the release notes and known limitations.
2. Select the next version using the project rule `MAJOR.MINOR.BUILD`: build fixes increment BUILD; a minor feature increments MINOR and BUILD; a major release increments MAJOR and resets the other fields to zero. Keep `package.json`, `package-lock.json` and generated `src/shared/version.js` synchronized.
3. Verify the app version and test the installers on native Windows x64, macOS Apple Silicon and a supported Linux desktop.
4. Commit the release changes in English and create an annotated tag named `v<version>` that matches `package.json` exactly (for example `v2.1.4`). Push the branch and tag.
5. The `release.yml` workflow runs tests, builds platform-specific packages, and creates a GitHub Release with the generated installers. Review the release page and checksums after the workflow completes.

The workflow must never increment the version during packaging: it checks out the tagged source and invokes the build script with `--keep-version`. A failed release should be corrected and rebuilt from the same tag only after checking that no release assets were partially published.

## Platform targets

| Runner | Artifact | Status for 2.1.4 |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` installer | Built by tagged release workflow |
| macOS arm64 | `.dmg` | Built locally and by tagged release workflow |
| Ubuntu x64 | `.AppImage` | Built by tagged release workflow |

## Signing and permissions

The GitHub Actions packages are unsigned and macOS notarization has not been performed. Configure platform signing credentials as repository Actions secrets before a future signed release. Never commit certificates, passwords, tokens or private keys.

The release workflow requires the repository's `GITHUB_TOKEN` with `contents: write`. Pull-request validation must keep read-only permissions. Enable branch protection and require CI before accepting changes to the default branch.

## Public repository checklist

- Simple Mix source code is licensed under MIT. Review the third-party notices and bundled FFmpeg build configuration before each release.
- Packaging refuses FFmpeg builds compiled with `--enable-nonfree`, `--enable-gpl` or `--enable-version3`; it verifies required codecs and filters before bundling.
- Confirm the repository metadata and update download links before each release.
- Review bundled FFmpeg and other dependency notices in each platform package.
- Test installation, launch, audio output and a short export on each operating system.
- Attach checksums and accurate release notes; identify unsigned builds and known platform test gaps.
- Publish only assets produced from the reviewed tag.
