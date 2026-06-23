<div align="center">

<img src=".github/media/banner.svg" alt="Veil" width="800" />

[![npm version](https://img.shields.io/npm/v/@engrammic/veil?style=flat-square&color=c2410c)](https://www.npmjs.com/package/@engrammic/veil)
[![license](https://img.shields.io/npm/l/@engrammic/veil?style=flat-square&color=92400e)](LICENSE)

[Install](#install) ·
[Why Veil](#why-veil) ·
[Features](#features) ·
[Docs](#documentation)

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

<table>
<tr>
<td width="50%">

### Self-Tuning Eviction
*AIMD control*

Context pressure triggers eviction. Success grows the window, failure shrinks it. No manual cleanup.

</td>
<td width="50%">

### Failure Memory
*Loops converge*

Failed approaches are remembered. The agent doesn't grind — it learns what didn't work and moves on.

</td>
</tr>
<tr>
<td width="50%">

### Worldview
*Structural + behavioral*

Persistent understanding of the codebase and your patterns. Survives compaction.

</td>
<td width="50%">

### Compression
*Intelligent decay*

Code, config, and conversations compress based on relevance. Old context fades, important context persists.

</td>
</tr>
</table>

---

## Architecture

```mermaid
flowchart TB
    subgraph AGENT["Agent Loop (Pi fork)"]
        direction TB
        A[Tool Call] --> H[VeilHarness]
    end

    subgraph CONTEXT["Context Management"]
        direction TB
        H --> CM[ContextManager]
        CM --> S[Scorer]
        CM --> E[Eviction]
        CM --> I[Injection]
    end

    subgraph STORAGE["Storage"]
        direction LR
        W[(SQLite + sqlite-vec<br/>Warm Tier)]
        C[(Cold Tier<br/>Optional)]
    end

    CONTEXT --> W
    W -.-> C

    style AGENT fill:#1c1917,stroke:#c2410c,color:#fef3c7
    style CONTEXT fill:#1c1917,stroke:#92400e,color:#fef3c7
    style STORAGE fill:#292524,stroke:#c2410c,color:#fef3c7
```

| Path | Behavior |
|------|----------|
| **Fast** | Deterministic scorer + eviction. Every turn, sub-10ms. Never blocks. |
| **Slow** | Reads event log, writes policy. Between turns, off critical path. |

---

## Documentation

| Doc | Purpose |
|-----|---------|
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guidelines |

---

## Development

```bash
git clone https://github.com/engrammic/veil
cd veil
npm install --ignore-scripts
npm run build
./veil-test.sh
```

---

## Credits

Built on [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner. MIT licensed.

Part of the [Engrammic](https://engrammic.ai) ecosystem.

---

<p align="center">
  <img src=".github/media/footer.svg" width="800">
</p>

<p align="center">
  <sub>Engrammic · 2026</sub>
</p>
