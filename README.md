<p align="center">
  <a href="https://meetdewey.com">
    <img src="./logo.png" alt="Dewey" width="120" />
  </a>
</p>

# @meetdewey/mcp

[![CI](https://github.com/meetdewey/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/meetdewey/mcp/actions/workflows/ci.yml)

MCP server for [Dewey](https://meetdewey.com) — search and research your document collections from Claude, Cursor, and any MCP-compatible agent. See the [full API reference](https://meetdewey.com/docs) for details.

## Installation

Add to your `claude_desktop_config.json` (or equivalent MCP client config):

```json
{
  "mcpServers": {
    "dewey": {
      "command": "/bin/sh",
      "args": ["-lc", "npx -y @meetdewey/mcp"],
      "env": {
        "DEWEY_API_KEY": "dwy_live_...",
        "DEWEY_COLLECTION_ID": "..."
      }
    }
  }
}
```

> **Note for Windows users:** replace `"command": "/bin/sh"` and `"args": ["-lc", "npx -y @meetdewey/mcp"]` with `"command": "npx"` and `"args": ["-y", "@meetdewey/mcp"]` — the login-shell wrapper is only needed on macOS/Linux to pick up Homebrew and nvm PATH entries that Claude Desktop doesn't inherit.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DEWEY_API_KEY` | Yes | Your Dewey project API key |
| `DEWEY_COLLECTION_ID` | No | Default collection ID. When set, tools that accept `collection_id` will fall back to this value. |
| `DEWEY_API_URL` | No | Override the API base URL (default: `https://api.meetdewey.com/v1`) |

## Available tools

### Search & research

| Tool | Description |
|---|---|
| `dewey_list_collections` | List all collections in the project, including description and research instructions when set |
| `dewey_search` | Hybrid semantic + keyword search over chunk content |
| `dewey_scan_sections` | Lightweight search over section titles and summaries |
| `dewey_research` | Agentic research query with configurable depth — returns a grounded, cited answer |
| `dewey_get_section` | Fetch the full Markdown content of a section by ID |

### Document management

| Tool | Description |
|---|---|
| `dewey_list_documents` | List documents in a collection with their processing status |
| `dewey_get_document_sections` | List all sections in a document (table of contents with heading levels and IDs) |
| `dewey_get_document_markdown` | Fetch the full converted Markdown content of a document |
| `dewey_retry_document` | Retry a failed document — clears error state and re-queues processing |
| `dewey_delete_document` | Permanently delete a document and all its derived data |

### Claims & contradictions

| Tool | Description |
|---|---|
| `dewey_list_claims` | List extracted factual claims from a collection or specific document, filterable by importance (1–5) |
| `dewey_list_contradictions` | List detected contradictions — clusters of conflicting claims with explanations and suggested resolutions |
| `dewey_detect_contradictions` | Trigger an async contradiction detection run across all claims in a collection |
| `dewey_get_contradiction_run` | Get the status and stats of the latest contradiction detection run (use to poll after `dewey_detect_contradictions`) |
| `dewey_resolve_contradiction` | Apply a resolution instruction to a contradiction or dismiss it |

### Deduplication

| Tool | Description |
|---|---|
| `dewey_detect_duplicates` | Trigger an async deduplication run — identifies near-duplicate documents via MinHash signatures and marks one per cluster as canonical |
| `dewey_get_duplicate_run` | Get the status and stats of the latest deduplication run (use to poll after `dewey_detect_duplicates`) |
| `dewey_list_duplicate_groups` | List near-duplicate groups with canonical + members and coverage percentages |
| `dewey_promote_duplicate_canonical` | Promote a different member to canonical; old canonical becomes near_duplicate |
| `dewey_disband_duplicate_group` | Disband a group; former members rejoin retrieval as distinct documents |

Non-canonical documents are excluded from retrieval and contradiction detection. Requires `enableDeduplication: true` on the collection (set via `dewey_update_collection` or the Dewey dashboard).

### Collection settings

| Tool | Description |
|---|---|
| `dewey_get_collection_stats` | Get document count, storage, section/chunk/claim counts, and processing status breakdown |
| `dewey_update_collection` | Update collection name, description, research instructions, visibility, and feature flags |
| `dewey_recompute_summaries` | Re-run AI section summarization across all documents (e.g. after changing the LLM model) |
| `dewey_recompute_captions` | Re-run AI captioning for all images and tables across all documents |
| `dewey_delete_collection` | Permanently delete a collection and all its data |

### Research instructions

Collections can have natural-language instructions that are automatically injected into the research system prompt — for example, noting units, preferred sources, or how to handle missing information. They can be set in the Dewey dashboard, via the API, or directly through `dewey_update_collection`. When `dewey_resolve_contradiction` is used to apply a resolution, the suggested instruction is also appended here automatically.

### Tool usage pattern

A typical read-only research workflow:

1. `dewey_list_collections` — discover available collections and understand their purpose
2. `dewey_scan_sections` — quickly explore document structure to identify relevant sections
3. `dewey_get_section` — load full content of a specific section
4. `dewey_search` — retrieve the most relevant chunks for a focused question
5. `dewey_research` — run a full agentic research query for questions that need multi-step reasoning

For deeper analysis and curation:

1. `dewey_get_collection_stats` — assess how much content has been processed
2. `dewey_list_claims` — surface the most important facts across documents
3. `dewey_list_contradictions` — identify where documents disagree
4. `dewey_resolve_contradiction` — apply or dismiss each contradiction, updating collection instructions automatically

## License

MIT
