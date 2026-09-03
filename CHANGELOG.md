# Changelog

## Unreleased

### Fixed

- **Khmer subscript-consonant (coeng) text rendering in export.** FFmpeg's `drawtext` and the libass
  `subtitles=` filter both fail to correctly stack certain Khmer subscript-consonant clusters — a
  genuine HarfBuzz shaping limitation, not fixable via font swap or a newer FFmpeg build. Khmer-script
  text clips now render through a headless-Chromium (Puppeteer) pre-pass that reuses the exact
  preview-rendering code (`drawTextFrame`/`drawAnimatedTextFrame`), producing pre-rendered PNG windows
  that export composites in as an image overlay instead of asking FFmpeg to shape the text itself. Every
  `textAnimation` shape (plain, `bounce`/`pulse`, `typewriter`, `wordHighlight`) and rotation are
  supported; a keyframed text style or a real text crop still fall back to the plain `drawtext` path
  (not yet covered by the render harness).

### Changed

- Renamed from **VStudio** to **VCut** — package name, directories, mobile/desktop bundle identifiers,
  and every user-facing string. No functional change.
