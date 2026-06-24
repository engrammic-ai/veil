# Veil TODO

## Rebrand Status ✅

All done. Internal packages stay `@earendil-works/pi-*` for upstream compatibility.

## API Endpoints (engrammic.ai)

> Implement these backend services to replace disabled pi.dev endpoints

- [ ] `GET /api/latest-version` — returns `{ version, packageName?, note? }`
- [ ] `GET /api/report-install` — install telemetry (or decide to skip)
- [ ] Session viewer at `/session/#<gist_id>` — renders shared sessions
- [ ] Changelog page at `/changelog`

---

## Completed

- **Phase 1-3**: Core context, cold storage, integration — all done
- **Distribution**: Bun binaries, Go installer, GCS + GitHub Releases + npm — done 2026-06-23

## Remaining Integration

- [x] Add context lifecycle events to extension system (`context_eviction`, `context_checkpoint`)

## Phase 4: Polish

- [x] `/context` command for visibility (with search: `/context <query>`)
- [x] Eviction-aware compaction (`/compact` runs Veil eviction first, `/compact full` for LLM summarization)
- [ ] CLI flags for context config (`--context-budget`, `--eviction-threshold`)
- [ ] `/veil` command for memory management
- [ ] Documentation
- [ ] Test harness end-to-end with API key

## Housekeeping

(None pending)
