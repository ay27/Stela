# Website validation — copy and placeholder revision, 2026-09-15

- Confirmed Chinese copy applied; English rewritten to match.
- Six feature rows and seven empty image placeholders, including the hero.
- Main content loads no product images. No image captions, lightbox handlers,
  screenshot gallery links, Pi introduction or local-first promotion remain.
- Chinese and English checked in Chrome at 1440, 1000 and 390 px.
- No page overflow, text/image-column overlap or missing translation text.
- Language selection survives reload. Static asset content hashes prevent stale
  cached scripts from being mixed with the updated page.
- Local links, translation keys and unique IDs pass static checks.
- JavaScript syntax and git diff whitespace checks pass.
- The source images and README were not changed in this revision.

## Fixed platform downloads

- Windows and Mac buttons use fixed latest/download asset URLs without an API request.
- Each platform release job uploads an additional fixed-name copy after packaging.
- Preparation tests cover byte preservation, unchanged updater metadata, reruns,
  tag mismatch, unsupported platforms and missing/empty installers.
- No GitHub release was triggered or modified locally. Live links require the
  next published release containing these fixed-name assets.
