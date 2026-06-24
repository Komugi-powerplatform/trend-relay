# trend-relay

A tiny **egress relay** for the cloud `neta-trend-daily` Routine.

## Why

The cloud Routine runs from Anthropic's cloud egress IP, which Zenn's API,
HN's Algolia API, and Hatena Bookmark may **403-block** as datacenter / anti-bot
traffic. When that happens the Routine silently falls back to WebSearch, and the
ranked-feed signals collapse — Zenn いいね数 / HN points / はてブ bookmark counts
all become `-`, stale SEO articles get recycled, and some URLs break.

GitHub Actions runs from a **different egress IP** that these hosts allow. This
repo fetches the ranked data here and commits it to `data/latest.json`. The
cloud Routine then reads that file via `raw.githubusercontent.com` — a host it
*can* reach — instead of calling the blocked APIs directly.

```
GitHub Actions 06:50 JST → fetch Zenn/HN/Hatena (allowed IP) → commit data/latest.json
        ↓ raw.githubusercontent.com
cloud Routine 07:00 JST  → read latest.json (real scores) + WebSearch news + 採点 + Notion
```

## Read URL

```
https://raw.githubusercontent.com/Komugi-powerplatform/trend-relay/main/data/latest.json
```

## Schema

```jsonc
{
  "generated_at": "2026-06-24T21:50Z",
  "errors": [],                       // per-source failures, e.g. "zenn.trending: HTTP 403"
  "zenn": {
    "trending": [{ "title", "url", "likes" }],
    "topics": { "ai": [...], "typescript": [...], "security": [...] }
  },
  "hackernews": [{ "title", "url", "points", "comments" }],
  "hatena": { "it": [...], "ai": [...], "security": [...] }   // url, bookmarks
}
```

If `errors` is non-empty, that source's egress IP was blocked here too —
inspect and adjust (e.g. switch to an authenticated API). Reddit is intentionally
**not** included yet: it blocks datacenter IPs and needs OAuth (planned Phase 2).

## Run

- Scheduled daily at 06:50 JST.
- Manual / probe: Actions → **fetch-trends** → **Run workflow**, or
  `gh workflow run fetch-trends.yml`.
- No dependencies — Node 18+ native `fetch` only (`node fetch.mjs`).
