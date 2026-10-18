# Contributing

Thanks for considering a contribution to Simple Mix. Please open an issue first for substantial changes so the scope and expected behavior can be discussed.

## Development

- Use Node.js 22 and npm.
- Install dependencies with `npm ci`.
- Run the desktop app with `npm start`.
- Run the test suite with `npm test` before submitting a change.
- Keep audio processing local and preserve portable project compatibility where practical.
- Update the English and Spanish message catalogs together when changing user-facing strings.

## Pull requests and commits

Write pull request titles, descriptions and commit messages in English. Use concise imperative commit subjects, for example `Document project portability` or `Fix release artifact naming`. Do not add co-author attribution trailers. Describe behavior changes and test coverage in the pull request.

## Releases

Release tags must match the application version (`vMAJOR.MINOR.BUILD`). See [Releasing](docs/RELEASING.md). Do not publish installers from an unreviewed or untested tag.

## License

Simple Mix source code is licensed under MIT. Third-party components retain their own licenses; see [Third-Party Notices](docs/THIRD-PARTY-NOTICES.md).
