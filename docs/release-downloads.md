# Fixed installer download URLs

The website uses these permanent links:

- Windows x64: https://github.com/ay27/Stela/releases/latest/download/Stela-windows-x64.exe
- Mac Apple Silicon: https://github.com/ay27/Stela/releases/latest/download/Stela-mac-arm64.dmg

Each platform job in `.github/workflows/release.yml` first runs electron-builder
and publishes its normal versioned artifacts. It then runs
`scripts/publish-stable-download.mjs` to copy the completed installer into
`release/stable/` and upload it to the same release with a fixed filename.
The macOS copy occurs after the existing signing and notarization process.
No versioned installer, blockmap or updater manifest is renamed or modified.

The release tag is derived from package.json as `v<version>`. Tag-triggered runs
reject a mismatch; manual workflow runs use the package version. Uploads use the
existing GITHUB_TOKEN and GITHUB_REPOSITORY, with `gh release upload --clobber`
so rerunning a job can replace that release's fixed-name copy.

The links become available after a release containing these new assets is
published. This change does not upload copies to previously published releases.
GitHub's latest-release selection determines which release the links serve.

Validate preparation locally with:

```sh
node --test scripts/publish-stable-download.test.mjs
```

The test uses temporary fixtures and does not upload anything. Actual publication
runs only in the release workflow (or by explicitly invoking the upload script
with the required release environment).
