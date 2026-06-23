<div align="center">

# Veil

**Stop Babysitting Your Context.**

[![npm version](https://img.shields.io/npm/v/@engrammic/veil?style=flat-square&color=c2410c)](https://www.npmjs.com/package/@engrammic/veil)
[![license](https://img.shields.io/npm/l/@engrammic/veil?style=flat-square&color=92400e)](https://github.com/engrammic-ai/veil/blob/main/LICENSE)

[Install](#install) ·
[Why Veil](#why-veil) ·
[Features](#features) ·
[Docs](https://github.com/engrammic-ai/veil)

</div>

---

## Install

```bash
# npm
npm install -g @engrammic/veil

# or curl
curl -sSL https://veil.engrammic.ai/install | sh
```

Then run in any project:

```bash
veil
```

---

## Why Veil

Context that governs itself, so you stop thinking about it.

Veil is a coding agent with **self-managing context** — stale context fades automatically, the system learns what matters from its own mistakes, and failures are remembered so loops converge instead of grinding.

No LLM in the memory loop. Pure deterministic scoring on the hot path.

---

## Features

| Feature | Description |
|---------|-------------|
| **Self-Tuning Eviction** | AIMD control — context pressure triggers eviction, success grows the window, failure shrinks it |
| **Failure Memory** | Failed approaches are remembered so loops converge instead of grinding |
| **Worldview** | Persistent structural + behavioral understanding that survives compaction |
| **Compression** | Code, config, and conversations compress based on relevance |

---

## Architecture

| Path | Behavior |
|------|----------|
| **Fast** | Deterministic scorer + eviction. Every turn, sub-10ms. Never blocks. |
| **Slow** | Reads event log, writes policy. Between turns, off critical path. |
| **Warm** | SQLite + sqlite-vec. Local-first, no network. |
| **Cold** | Optional cross-session, cross-device persistence. |

---

## Credits

Built on [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner. MIT licensed.

Part of the [Engrammic](https://engrammic.ai) ecosystem.

---

<p align="center">
  <sub>Engrammic · 2026</sub>
</p>
