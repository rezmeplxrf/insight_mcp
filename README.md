# @insightsentry/mcp

MCP server and CLI for the InsightSentry financial data API.

## Install

```bash
npm install -g @insightsentry/mcp
```

Commands:

| Command | Purpose |
|---------|---------|
| `insight` | CLI for terminal use and scripts |
| `insight-mcp` | MCP server for AI clients |
| `mcp` | Alias for `insight-mcp` |

## Authentication

Set an API key for the current shell:

```bash
export INSIGHTSENTRY_API_KEY="your-api-key"
```

Or save one locally for the CLI:

```bash
insight login --key "your-api-key"
insight whoami
insight logout
```

`whoami` parses the configured JWT locally and prints `uuid`, falling back to `email` then `sub`.

## MCP Setup

Use `npx` in your MCP config:

```json
{
  "mcpServers": {
    "insightsentry": {
      "command": "npx",
      "args": ["-y", "@insightsentry/mcp"],
      "env": {
        "INSIGHTSENTRY_API_KEY": "your-api-key"
      }
    }
  }
}
```

The MCP server also falls back to the key saved by `insight login` when `INSIGHTSENTRY_API_KEY` is not set.
Set `INSIGHTSENTRY_CONFIG_DIR` to force the CLI and MCP server to read the same saved-login directory when they run with different home directories.

## CLI Usage

```bash
insight --help
insight <tool> --help
insight <tool> [--param value]
```

Examples:

```bash
insight whoami
insight search_symbols --query "tesla"
insight get_quotes --codes "NASDAQ:AAPL,NASDAQ:MSFT"
insight get_symbol_series --symbol "NASDAQ:AAPL" --bar_type day --dp 30
insight screen_stocks --fields "close,volume,market_cap" --exchanges "NYSE,NASDAQ" --sortBy market_cap --sortOrder desc
insight download_history --symbol "NASDAQ:AAPL" --bar_type day --from 2024-01-01 --to 2024-06-30 --output_dir ./history
```

Symbol codes must use `EXCHANGE:SYMBOL` format. Use `search_symbols` before calling symbol tools.

All API tools support:

```bash
--filter '<jsonata-expression>'
--store json --output_file ./response.json
--store json --output_dir ./responses
```

`get_symbol_series` also supports CSV storage:

```bash
insight get_symbol_series --symbol "NASDAQ:AAPL" --bar_type day --store csv --output_file ./aapl.csv
```

## Tools

Auth and files:

| Tool | Purpose |
|------|---------|
| `whoami` | Print the configured user's `uuid`/email from the API key JWT |
| `download_history` | Download date ranges to JSON/CSV files |
| `get_symbol_history` | Same as `download_history`; downloads history to files |
| `render_chart` | Render Chart.js configs as PNG images |

Market data:

| Tool | Purpose |
|------|---------|
| `search_symbols` | Find valid `EXCHANGE:SYMBOL` codes |
| `get_quotes` | Real-time quotes |
| `get_symbol_series` | Recent OHLCV series |
| `get_symbol_info` | Symbol metadata |
| `get_symbol_session` | Trading hours and session details |
| `get_symbol_contracts` | Futures contract list |

Fundamentals, options, screeners, calendars, documents:

| Tool | Purpose |
|------|---------|
| `get_symbol_fundamentals` | Company fundamentals |
| `get_fundamentals_series` | Historical fundamental indicators |
| `get_fundamentals_meta` | Available fundamental/technical IDs |
| `get_options_contracts` | Option contract metadata and codes |
| `get_options_quotes` | Option quote rows with bid/ask and Greeks |
| `screen_stocks`, `screen_etfs`, `screen_bonds`, `screen_crypto` | Screen assets |
| `get_stock_screener_params`, `get_etf_screener_params`, `get_bond_screener_params`, `get_crypto_screener_params` | Screener fields |
| `get_dividends`, `get_earnings`, `get_ipos`, `get_events` | Calendars |
| `get_newsfeed` | Financial news |
| `get_documents`, `get_document` | Filings and transcripts |
