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
| `dewey_list_collections` | List all collections in the project |
| `dewey_search` | Hybrid semantic + keyword search over chunk content |
| `dewey_scan_sections` | Lightweight search over section titles and summaries |
| `dewey_research` | Agentic research query with configurable depth — returns a grounded, cited answer |
| `dewey_list_documents` | List documents in a collection with their processing status |
| `dewey_get_section` | Fetch the full Markdown content of a section by ID |

## License

MIT
