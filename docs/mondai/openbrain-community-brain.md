# OB1 (OpenBrain) — Community Brain Evaluation

**Repo:** https://github.com/NateBJones-Projects/OB1  
**Evaluated:** 2026-04-27  
**Purpose:** Assess OB1 as a foundation for a CryptoMondays community knowledge brain — per-member nodes, collectively searchable by the MonDAI agent.

---

## What OB1 Is

A persistent AI memory layer: vector-embedded "thoughts" stored in PostgreSQL/pgvector, exposed via MCP tools. Any AI agent (Claude, ChatGPT, etc.) plugs in via MCP and can read/write the knowledge store.

**Tech stack:**
- PostgreSQL + pgvector (Supabase-hosted or self-hosted K8s)
- OpenAI `text-embedding-3-small` via OpenRouter for embeddings
- `gpt-4o-mini` for metadata extraction (topics, people, action items, dates)
- Deno-based MCP server (Supabase Edge Functions or K8s)
- Optional SvelteKit/Next.js dashboard

**Core data model:**
```
thoughts
  id          UUID
  content     TEXT
  embedding   VECTOR[1536]
  metadata    JSONB  { topics, people, action_items, dates_mentioned, type, source }
  created_at, updated_at
  [+ extension columns per module]
```

**MCP tools exposed:**
- `search_thoughts` — semantic search (cosine similarity, threshold + limit)
- `list_thoughts` — filter by type/topic/person/date
- `capture_thought` — save + auto-embed + extract metadata
- `thought_stats` — aggregate counts by type/topic/person

---

## Personal → Professional Adaptation

OB1 is explicitly single-user today. Every table has `user_id` and RLS enforces `auth.uid() = user_id`. The changes to support community use are mechanical, not architectural.

**Required schema changes:**
```sql
ALTER TABLE thoughts ADD COLUMN community_id UUID;
ALTER TABLE thoughts ADD COLUMN visibility TEXT DEFAULT 'private'
  CHECK (visibility IN ('private', 'community', 'public'));

CREATE TABLE communities (
  id UUID PRIMARY KEY, name TEXT, slug TEXT,
  created_by UUID, created_at TIMESTAMPTZ
);

CREATE TABLE community_members (
  community_id UUID, user_id UUID,
  role TEXT CHECK (role IN ('member', 'curator', 'moderator', 'admin')),
  PRIMARY KEY (community_id, user_id)
);
```

**Updated RLS:**
```sql
CREATE POLICY "community-scoped read"
  ON thoughts FOR SELECT USING (
    auth.uid() = user_id
    OR visibility = 'public'
    OR (visibility = 'community' AND community_id IN (
      SELECT community_id FROM community_members WHERE user_id = auth.uid()
    ))
  );
```

**Estimated effort:** ~16–24 hours total (schema + RPC rewrites + membership management).

---

## Per-User Nodes + Collective Search

**Recommended architecture: Option A — shared multi-tenant database**

One Supabase project, one `thoughts` table, tagged by `user_id` + `visibility`. A single MCP server queries across all members' shared thoughts filtered by community membership. Results carry attribution (which member contributed what).

Scales cleanly to ~5K users. At 10K+ would need read replicas or sharding.

**What needs to change in search RPCs:**
- Current: `search_thoughts()` filters by `user_id`
- Needed: `search_community_thoughts()` variant that checks `visibility = 'community'` + community membership
- Results should include `user_id` / display name for attribution

**Alternative: Option C (hybrid)** — shared DB for curated community knowledge + per-member private schemas. Better privacy guarantees, more ops complexity.

---

## Management Complexity

**Low ongoing burden with Supabase-hosted:**

| Cadence | Work |
|---------|------|
| Monthly | Monitor AI API costs, error logs |
| Quarterly | Schema review, pgvector index performance |
| Annually | Major version upgrades |

**Grows as extensions are added:** each OB1 extension adds 3–5 tables and 6–10 RLS policies. After 5–6 extensions: ~20 tables, ~60 policies. Manageable with Git-versioned SQL migrations.

---

## Resource & Cost Estimate

**Assumptions:** 500–1,000 active members, ~10–50 thoughts captured per member per month.

| Component | 500 users/mo | 1,000 users/mo |
|-----------|-------------|----------------|
| Supabase + hosting | $100–150 | $150–250 |
| Embeddings (OpenRouter) | ~$12 | ~$25 |
| AI synthesis agent (optional, daily) | ~$50 | ~$100 |
| **Total** | **~$160–210** | **~$275–375** |

**Per-user cost:** ~$0.30–0.38/month, declining with scale.

**Per-operation costs:**
- Capture a thought: ~$0.00035 (1 embed + 1 metadata extraction)
- Search: ~$0.0002 (1 embed of the query)
- Community synthesis agent: ~$0.005+ per call depending on context size

**Scaling limits:**
- 500 users: no issues
- 5K users: approaching Supabase connection limits; consider read replicas
- 10K+: shard or move to federated per-team deployments

---

## Integration with NanoClaw / MonDAI

OB1's MCP server pattern maps directly onto how MonDAI already works — `get_events`, `search_members`, `search_knowledge_base` are all MCP tools. Adding a community brain would be another MCP tool group:

- `capture_thought` — member saves something to their brain
- `search_community_thoughts` — agent searches across all shared member knowledge
- `get_thought_connections` — graph traversal to find related thoughts

The agent could surface relevant community knowledge proactively during conversations.

---

## Recommendation

**OB1 is a strong starting point.** The architecture (pgvector + RLS + MCP) fits the stack. Building the same thing from scratch would take longer and land in the same place.

**Suggested path:**
1. Fork OB1, add `community_id` + `visibility` columns
2. Rewrite search RPCs for cross-member queries
3. Register as a new MCP tool group in the MonDAI agent container
4. Start with Option A (shared DB); move to hybrid if per-member privacy becomes a requirement

**Open questions:**
- Should member brains be opt-in (default private) or opt-out (default shared with community)?
- Who can capture community-level knowledge — all members, curators only?
- Should the agent proactively suggest capturing something, or only on explicit request?
