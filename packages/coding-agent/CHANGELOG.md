# Changelog

All notable changes to Veil will be documented in this file.

## [0.1.8] - 2026-06-19

### Changed

- Header cat now shows full ASCII art (3-line cat) instead of just emoticon
- Statusline shows cat emoticon: (z.z), (o.o), (~.~), (^.^), (*.*), (!.!)
- Both header cat and statusline emoticon update with memory state

## [0.1.7] - 2026-06-19

### Added

- Header cat widget - colored cat face in header that animates with memory state
- Cat states: sleeping (z.z), watching (o.o), remembering (~.~), learned (^.^), recalled (*.*), conflict (!.!)

### Changed

- Bumped version to 0.1.7 (decoupled from Pi's 0.79.x versioning)

## [0.1.6] - 2026-06-19

### Changed

- Replaced Pi changelog with Veil-specific changelog
- Fixed /changelog to show newest entries first
- Updated GitHub links to engrammic-ai/veil

## [0.1.5] - 2026-06-19

### Changed

- Switched to bun:sqlite for compiled binaries, better-sqlite3 for Node.js development
- Fixed changelog display order (newest first)

### Fixed

- Fixed native SQLite module loading in Bun compiled binaries

## [0.1.4] - 2026-06-18

### Fixed

- Fixed installer platform detection for binary selection
- Fixed release workflow to use build script

## [0.1.3] - 2026-06-18

### Added

- Added beta release channel support

## [0.1.2] - 2026-06-18

### Fixed

- Fixed theme file bundling in release archives

## [0.1.1] - 2026-06-18

### Fixed

- Fixed binary asset paths for compiled releases

## [0.1.0] - 2026-06-18

### Added

- Initial Veil release (Pi fork with episodic memory)
- veil-memory package with FSRS spaced repetition
- Version vectors for distributed memory sync
- SQLite-based context caching
- Cat widget demo for memory visualization

## [0.0.1] - 2026-06-17

### Added

- Initial fork from Pi
- Renamed CLI to `veil`
- Added engrammic memory integration scaffolding
