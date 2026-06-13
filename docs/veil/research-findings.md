# Research Findings

Comprehensive research on context management for LLM coding agents (June 2026).

---

## 1. Existing Context Management Solutions

### Letta / MemGPT
- OS virtual-memory analogy: context = RAM, external storage = disk
- LLM acts as scheduler, decides what to page in/out via function calls
- **Memory blocks**: labeled scratchpad sections (Human, Persona, custom)
- **Eviction**: FIFO queue oldest-first + agent-directed archival
- License: Apache 2.0 + Letta Cloud

### Zep / Graphiti
- **Bi-temporal knowledge graphs** - every edge carries `t_valid`/`t_invalid`
- Facts never deleted, just temporally invalidated
- Retrieval: vector similarity + full-text + graph traversal combined
- License: Graphiti Apache 2.0

### Mem0
- Three-tier hybrid: vector + graph + KV per memory scope
- LLM-driven Memory Manager for consolidation
- Claims 80% prompt token reduction
- Graph tier only on paid plan

### CWL (arxiv:2606.11213)
- **Structured eviction with dependency DAG**
- Deterministic priority: reasoning traces → bulk outputs → intermediates → full episodes
- Never removes: user turns, active episodes, system prompts, living dependents
- Best fit for coding agents

---

## 2. KG-Backed Memory Systems

### Key Patterns

**Zep bi-temporal model**:
- Every edge: `t_valid`, `t_invalid` (event time) + `t_created`, `t_expired` (ingestion time)
- Contradiction detection via embeddings, not LLM calls
- Old beliefs stay with validity intervals

**TKG with RDF-star qualifiers** (arxiv:2408.05861):
- Three qualifiers: `time_added`, `last_accessed`, `num_recalled`
- Enables FIFO/LRU/LFU eviction without LLM
- 4x higher QA accuracy than neural baselines

**Pointer hydration** (unnamed but practiced):
- Store node IDs in lightweight refs during traversal
- Expand only needed nodes into context
- Zep's selective constructor returns `fact` + timestamps, not full source

### On-Device Storage

| System | Graph | Vector | Notes |
|--------|-------|--------|-------|
| **AIngram** | SQLite CTE | sqlite-vec | Single file, WAL mode, RTX 4060 tested |
| **Cognee** | Kuzu | LanceDB | Zero infra, swappable to Neo4j/Qdrant |
| **MemoryGraph** | FalkorDBLite/SQLite | Native | 8 backend options |

### Lightweight Extraction (No Cloud LLM)

- **AIngram**: GLiNER 205M (entities), DeBERTa-v3 (contradiction), nomic-embed-text-v1.5
- **Neo4j Agent Memory**: spaCy + GLiNER + GLiREL, sentence-transformers
- **TKG**: Fully symbolic, no neural component needed

---

## 3. Harness Architectures

### Claude Code
- **System reminders**: silent turn-level injections from file reads/edits
- **Hooks**: 12 lifecycle events (PreToolUse, PostToolUse, UserPromptSubmit, SessionStart...)
- **CLAUDE.md hierarchy**: user-global → project-root → subdirectory
- MCP tools require explicit agent calls (not automatic injection)

### Gemini CLI - Progressive Skill Loading
- **Discovery**: only skill `name` + `description` loaded at startup
- **Activation**: full instructions loaded when task matches
- Avoids context saturation from preloading all schemas

### LangChain deepagents - Middleware Stack
- 6 hooks: `beforeAgent`, `beforeModel`, `wrapModelCall`, `afterModel`, `wrapToolCall`, `afterAgent`
- Each receives AgentState + Runtime, can mutate state or redirect control
- Closest to Express.js middleware in agent space

### MCP Limitations
- Retrieval is explicit (agent must call) not automatic
- No native session continuity
- No automatic eviction
- Single-user design in reference impl

---

## 4. Academic Papers (2024-2026)

### Context Management

**Active Context Compression** (arxiv:2601.07190)
- Agent autonomously consolidates into "knowledge block" and prunes history
- SWE-bench Lite: 22.7% avg token reduction, up to 57%
- Key: "capable models can self-regulate context when given appropriate tools"

**Contextual Memory Virtualisation** (arxiv:2602.22402)
- Models agent state as DAG, trimming respects dependencies
- Critical for coding: edits, tests, errors form chains

### Episodic Memory

**EM-LLM** (arxiv:2407.09450) - DeepMind/UCL
- Organizes tokens into episodic events via Bayesian surprise
- Two-stage retrieval: similarity + temporally contiguous
- Handles 10M token contexts

**A-MEM** (arxiv:2502.12110) - NeurIPS 2025
- Zettelkasten-inspired atomic notes with auto-linking
- Bidirectional evolution: new memories trigger updates to existing

### Architecture

**MemTier** (arxiv:2605.03675)
- **Cognitive weight**: -1 to +1 scalar tracking success/failure contribution
- Three tiers: episodic (per-agent JSONL) → semantic (shared) → procedural
- 33pp improvement on LongMemEval-S
- Key: "architecture, not model size, is the ceiling"

**Codified Context** (arxiv:2602.20478)
- Three-tier for 108K-line C# codebase:
  - Hot: ~660-line constitution always loaded
  - Warm: 19 domain-expert specs via trigger tables
  - Cold: 34 on-demand specs via MCP keyword search
- "Over half of agent spec content is project knowledge, not instructions"

---

## 5. Heuristic Eviction (No LLM Calls)

### Signal Families

**Temporal (time-based)**:
- TTL eviction with timestamps
- Zep bi-temporal invalidation
- AIngram importance decay per clock tick

**Frequency + Recency**:
- TKG: `time_added`, `last_accessed`, `num_recalled` → FIFO/LRU/LFU
- Composite: `score = α·recency + β·frequency`

**Graph Structural**:
- Eigenvector centrality: peripheral nodes evict first
- Spreading activation (SYNAPSE): nodes not activated decay
- Vestige FSRS-6: 21-param forgetting curves

### Recommended Cascade

1. Hard evict: >2h untouched AND access_count == 1
2. Soft evict: score < 0.3, summarize if >500 tokens
3. Demote to cold: warm items >24h → KG-link and purge
4. Rot sweep: weekly `confidence *= 0.95`, prune at 0.1

---

## 6. Gaps / Opportunities

1. **Anticipatory loading** without LLM - keyword → action rules from past sessions
2. **Cross-session episode chains** - "relates to yesterday's refactor" via KG edges
3. **Confidence-aware retrieval** - surface uncertainty instead of hallucinating
4. **AST-aware compression** - `{signature} + [IMPL:hash]`
5. **Decay calibration from feedback** - auto-tune when users re-request evicted info
6. **First-class coding ontology** - no system has AST/symbol-table-aware KG structure

---

## Sources

### Papers
- arxiv:2601.07190 - Active Context Compression
- arxiv:2606.11213 - CWL Structured Eviction
- arxiv:2408.05861 - TKG RDF-star Qualifiers
- arxiv:2407.09450 - EM-LLM Episodic Memory
- arxiv:2502.12110 - A-MEM Zettelkasten
- arxiv:2605.03675 - MemTier Tiered Architecture
- arxiv:2602.20478 - Codified Context
- arxiv:2501.13956 - Zep Temporal KG
- arxiv:2601.03236 - MAGMA Multi-Graph Memory
- arxiv:2603.05344 - Building AI Coding Agents

### Projects
- https://github.com/letta-ai/letta
- https://github.com/getzep/graphiti
- https://github.com/mem0ai/mem0
- https://github.com/bozbuilds/AIngram
- https://github.com/badlogic/pi-mono
- https://github.com/modelcontextprotocol/servers/tree/main/src/memory

### Blog Posts
- https://lucumr.pocoo.org/2026/1/31/pi/ - Pi Agent Philosophy
- https://lucumr.pocoo.org/2026/5/24/pi-oss/ - Building Pi With Pi
