# @insightsentry/mcp

MCP server and CLI for the [InsightSentry](https://insightsentry.com) financial data API.

Gives AI assistants direct access to real-time and historical market data for equities, futures, options, crypto, forex, and more — plus comprehensive documentation resources for building applications with the InsightSentry API and WebSocket feeds. Also usable as a standalone CLI for scripting and terminal workflows.

## Install

```bash
npm install -g @insightsentry/mcp
```

This gives you two commands:

| Command | Purpose |
|---------|---------|
| `insight` | CLI for terminal / scripting |
| `insight-mcp` | MCP server for AI assistants |

Get your API key from the [InsightSentry Dashboard](https://insightsentry.com/dashboard).

```bash
export INSIGHTSENTRY_API_KEY="your-api-key"
```

## MCP Server Setup

No global install needed — use npx in your MCP config.

### Claude Desktop

Add to your `claude_desktop_config.json`:

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

### Claude Code

Add to `.mcp.json` in your project root:

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

### Other MCP Clients

Any MCP client that supports stdio transport can use the server:

```bash
insight-mcp
```

## CLI Usage

```bash
insight --help                    # List all tools
insight <tool> --help             # Tool-specific parameters
insight <tool> [--param value]    # Call a tool
```

### Examples

```bash
# Search for a symbol
insight search_symbols --query "tesla"

# Get real-time quotes
insight get_quotes --codes "NASDAQ:AAPL,NASDAQ:MSFT"

# Daily OHLCV with JSONata filter
insight get_symbol_series --symbol "NASDAQ:AAPL" --bar_type day --dp 30 \
  --filter "{ \"last_close\": series[-1].close, \"avg_vol\": \$average(series.volume) }"

# Screen for high-cap stocks
insight screen_stocks --fields "close,volume,market_cap" \
  --exchanges "NYSE,NASDAQ" --sortBy market_cap --sortOrder desc

# Upcoming earnings
insight get_earnings --c US

# Options chain
insight list_options --code "NASDAQ:AAPL" --type call --range 10
```

All tools support `--filter <jsonata>` to transform/reduce the JSON response before output. See [JSONata docs](https://jsonata.org) for expression syntax.

## Available Tools (28)

### Market Data
| Tool | Description |
|------|-------------|
| `get_symbol_series` | Recent OHLCV data (up to 30k bars) with real-time option |
| `get_symbol_history` | Deep historical data (20+ years) |
| `get_quotes` | Real-time quotes for up to 10 symbols |
| `get_symbol_info` | Symbol metadata (type, sector, market cap, etc.) |
| `get_symbol_session` | Trading session details and hours |
| `get_symbol_contracts` | Futures contract list with settlement dates |

### Search
| Tool | Description |
|------|-------------|
| `search_symbols` | Search for symbols across all asset classes |

### Fundamentals
| Tool | Description |
|------|-------------|
| `get_symbol_fundamentals` | Company fundamentals (valuation, profitability, balance sheet) |
| `get_fundamentals_series` | Historical fundamental indicators |
| `get_fundamentals_meta` | Available fundamental/technical indicator IDs |

### Options
| Tool | Description |
|------|-------------|
| `list_options` | List available option contracts |
| `get_options_expiration` | Option chain by expiration date |
| `get_options_strike` | Option chain by strike price |

### Screeners
| Tool | Description |
|------|-------------|
| `screen_stocks` | Filter stocks with custom criteria |
| `screen_etfs` | Filter ETFs with custom criteria |
| `screen_bonds` | Filter bonds with custom criteria |
| `screen_crypto` | Filter crypto with custom criteria |
| `get_stock_screener_params` | Available stock screener fields |
| `get_etf_screener_params` | Available ETF screener fields |
| `get_bond_screener_params` | Available bond screener fields |
| `get_crypto_screener_params` | Available crypto screener fields |

### Calendar
| Tool | Description |
|------|-------------|
| `get_dividends` | Dividend calendar |
| `get_earnings` | Earnings calendar |
| `get_ipos` | IPO calendar |
| `get_events` | Economic events calendar |

### News & Documents
| Tool | Description |
|------|-------------|
| `get_newsfeed` | Financial news with keyword filtering |
| `get_documents` | List SEC filings and transcripts |
| `get_document` | Get specific document content |

## Documentation Resources

The MCP server also provides documentation resources that AI assistants can read to help you build applications:

| Resource | Content |
|----------|---------|
| `insightsentry://docs/rest-api` | Complete REST API reference |
| `insightsentry://docs/websocket` | WebSocket API: connection, subscriptions, data formats, code examples |
| `insightsentry://docs/screener` | Screener API: field discovery and filtering |
| `insightsentry://docs/options` | Options API: chains, Greeks, option codes |
| `insightsentry://docs/futures-history` | Futures historical data and contract month logic |

## Online Documentation

- API Docs: https://insightsentry.com/docs
- WebSocket Live Demo: https://insightsentry.com/test/realtime
- News Feed Demo: https://insightsentry.com/test/newsfeed
- OpenAPI Spec: https://insightsentry.com/openapi.json

## Development

```bash
npm install
npm run generate  # Generate tool definitions from OpenAPI spec
npm run build     # Generate + compile TypeScript
npm run dev       # Run MCP server with tsx (no build needed)
```

### Testing

```bash
npx tsx --test test/cli.test.ts   # CLI unit tests
```

## License

MIT
