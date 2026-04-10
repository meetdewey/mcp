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

| Tool | Description |
|---|---|
| `dewey_list_collections` | List all collections in the project, including description and research instructions when set |
| `dewey_search` | Hybrid semantic + keyword search over chunk content |
| `dewey_scan_sections` | Lightweight search over section titles and summaries |
| `dewey_research` | Agentic research query with configurable depth — returns a grounded, cited answer |
| `dewey_list_documents` | List documents in a collection with their processing status |
| `dewey_get_section` | Fetch the full Markdown content of a section by ID |

### Research instructions

Collections can have natural-language instructions that are automatically injected into the research system prompt — for example, noting units, preferred sources, or how to handle missing information. These are set per-collection in the Dewey dashboard or via the API and apply transparently whenever `dewey_research` is called against that collection. No configuration is needed in the MCP server itself.

### Tool usage pattern

A typical agentic workflow uses the tools in this order:

1. `dewey_list_collections` — discover available collections and understand their purpose
2. `dewey_scan_sections` — quickly explore document structure to identify relevant sections
3. `dewey_get_section` — load full content of a specific section
4. `dewey_search` — retrieve the most relevant chunks for a focused question
5. `dewey_research` — run a full agentic research query for questions that need multi-step reasoning

## License

MIT
