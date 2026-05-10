export interface DocResource {
  uri: string;
  name: string;
  description: string;
  mimeType: "text/markdown";
  url: string;
}

export const DOC_MARKDOWN_ACCEPT_HEADER = "text/markdown";

const DOCS_BASE_URL = "https://insightsentry.com/docs";

export const docResources: DocResource[] = [
  {
    uri: "insightsentry://docs",
    name: "InsightSentry Documentation",
    description:
      "Documentation index with links to InsightSentry API guides, references, and enterprise docs",
    mimeType: "text/markdown",
    url: DOCS_BASE_URL,
  },
  {
    uri: "insightsentry://docs/parameters",
    name: "InsightSentry Common Parameters",
    description: "Price adjustment, trading sessions, currency conversion, and bar type parameters",
    mimeType: "text/markdown",
    url: `${DOCS_BASE_URL}/parameters`,
  },
  {
    uri: "insightsentry://docs/ws",
    name: "InsightSentry WebSocket API",
    description:
      "Real-time data streaming: connection, authentication, message formats, and examples",
    mimeType: "text/markdown",
    url: `${DOCS_BASE_URL}/ws`,
  },
  {
    uri: "insightsentry://docs/mcp",
    name: "InsightSentry CLI/MCP",
    description: "InsightSentry CLI and MCP setup for Claude, Cursor, and other AI assistants",
    mimeType: "text/markdown",
    url: `${DOCS_BASE_URL}/mcp`,
  },
  {
    uri: "insightsentry://docs/screener",
    name: "InsightSentry Screener API",
    description: "Filter stocks, ETFs, bonds, and crypto with custom fields and exchange filters",
    mimeType: "text/markdown",
    url: `${DOCS_BASE_URL}/screener`,
  },
  {
    uri: "insightsentry://docs/options",
    name: "InsightSentry Options API",
    description: "Option chains, real-time quotes, historical data, symbol search, and discovery",
    mimeType: "text/markdown",
    url: `${DOCS_BASE_URL}/options`,
  },
  {
    uri: "insightsentry://docs/organization",
    name: "InsightSentry Organization API",
    description: "Manage organization members, subscription plans, proration, and credits",
    mimeType: "text/markdown",
    url: `${DOCS_BASE_URL}/organization`,
  },
  {
    uri: "insightsentry://docs/archive",
    name: "InsightSentry History Endpoints",
    description:
      "Intraday OHLCV history at second, minute, or hour granularity for popular exchanges",
    mimeType: "text/markdown",
    url: `${DOCS_BASE_URL}/archive`,
  },
  {
    uri: "insightsentry://docs/futures-history",
    name: "InsightSentry Futures History",
    description:
      "Historical futures data examples with contract month handling and Python workflows",
    mimeType: "text/markdown",
    url: `${DOCS_BASE_URL}/futures-history`,
  },
  {
    uri: "insightsentry://docs/scalability",
    name: "InsightSentry Scalability",
    description:
      "Scaling approaches with custom plans, Organization API volume discounts, and data packages",
    mimeType: "text/markdown",
    url: `${DOCS_BASE_URL}/scalability`,
  },
  {
    uri: "insightsentry://docs/enterprise",
    name: "InsightSentry Data Package",
    description: "Enterprise WebSocket and Pub/Sub data packages for high-volume symbol streaming",
    mimeType: "text/markdown",
    url: `${DOCS_BASE_URL}/enterprise`,
  },
];

export async function fetchDocResourceContent(
  resource: DocResource,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<string> {
  const response = await fetcher(resource.url, {
    headers: { Accept: DOC_MARKDOWN_ACCEPT_HEADER },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${resource.name} from ${resource.url}: ${response.status} ${response.statusText}`,
    );
  }

  return response.text();
}
