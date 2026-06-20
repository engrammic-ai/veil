# Fork Maintenance

Veil is a fork of [pi-mono](https://github.com/badlogic/pi-mono). This doc covers how to sync with upstream.

## Remotes

```
origin    → git@github.com:engrammic-ai/veil.git (our fork)
upstream  → https://github.com/badlogic/pi-mono.git (Pi)
```

## Syncing with Upstream Pi

When Pi has updates you want:

```bash
# Fetch upstream changes
git fetch upstream

# See what changed
git log HEAD..upstream/main --oneline

# Merge upstream (or rebase if you prefer)
git merge upstream/main

# Resolve conflicts if any, then push
git push origin main
```

## What to Sync vs Skip

**Sync (usually safe):**
- Bug fixes in packages/ai (LLM API)
- Bug fixes in packages/tui
- New provider support
- Security patches

**Review carefully:**
- Changes to packages/agent (agent loop) — may conflict with our context management
- Changes to packages/coding-agent/src/core/compaction — we replace this
- New extension hooks — might be useful

**Skip:**
- Branding changes (logos, docs about pi.dev)
- Pi-specific features we don't need
- `.github/workflows/issue-gate.yml` and similar Pi repo automation

**Keep (don't delete):**
- `packages/ai/src/models.generated.ts` - upstream code imports this
- `packages/ai/src/image-models.generated.ts` - upstream code imports this

## Conflict Zones

Files we heavily modify (expect conflicts):

```
packages/agent/src/agent.ts           # Context budget tracking
packages/agent/src/agent-loop.ts      # Eviction hooks
packages/coding-agent/src/core/       # Session + compaction changes
```

## TODO: Full Rebrand

Before first publish, rebrand all packages:

- [ ] `@earendil-works/pi-*` → `@engrammic/veil-*`
- [ ] Update all internal imports
- [ ] Rename CLI command `pi` → `veil`
- [ ] Update all docs referencing "pi"
- [ ] Update scripts (pi-test.sh → veil-test.sh) ✓ done

Track this in a separate PR to keep diffs clean.
