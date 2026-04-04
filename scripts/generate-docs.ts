/**
 * Extracts documentation from the website's TSX doc pages into LLM-friendly markdown
 * using Claude CLI to intelligently parse JSX into clean documentation.
 *
 * This MCP targets InsightSentry direct subscribers only — RapidAPI is not supported.
 * RapidAPI-specific content (/v2/websocket-key, key rotation, x-rapidapi-key headers)
 * is excluded during extraction.
 *
 * Generates src/resources.ts with all documentation resources.
 *
 * Prerequisites: Claude CLI installed (`claude` command available)
 * Run with: npx tsx scripts/generate-docs.ts
 */
import { writeFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, "../../website/src/app/docs");

// Directories to skip (not API documentation for MCP users)
const SKIP_DIRS = new Set(["demo", "test", "openapi", "enterprise", "mcp", "organization"]);

// Static resources preserved from existing file (not extracted from TSX)
const STATIC_URIS = [
  "insightsentry://docs/rest-api",
  "insightsentry://docs/workflows",
];

/**
 * Auto-discover doc pages by scanning subdirectories of /docs.
 * Each subdirectory with a page.tsx becomes a documentation resource.
 */
function discoverDocPages(): Array<{
  dirName: string;
  filePath: string;
}> {
  const pages: Array<{ dirName: string; filePath: string }> = [];

  for (const entry of readdirSync(DOCS_DIR)) {
    if (SKIP_DIRS.has(entry)) continue;

    const dirPath = resolve(DOCS_DIR, entry);
    if (!statSync(dirPath).isDirectory()) continue;

    const pagePath = resolve(dirPath, "page.tsx");
    try {
      statSync(pagePath);
      pages.push({ dirName: entry, filePath: pagePath });
    } catch {
      // No page.tsx in this directory
    }
  }

  return pages;
}

// ─── Claude CLI extraction ───────────────────────────────────────────────────

function extractWithClaude(filePath: string, dirName: string): {
  content: string;
  name: string;
  description: string;
} | null {
  const prompt = `Read the file at ${filePath} and extract ALL documentation content into clean, LLM-friendly markdown.

Rules:
- Extract ALL text content, code examples, parameter descriptions, tables, and notes
- Convert JSX/HTML headings to markdown headings (##, ###, etc.)
- Convert <CodeBlock language="X" code={\`...\`} /> to markdown code blocks
- Convert tables to markdown table format
- Convert lists to markdown lists
- Preserve all code examples exactly as written
- Remove all React/JSX/Tailwind markup, component wrappers, and styling classes
- Remove all JavaScript logic (useState, useEffect, event handlers, etc.)
- Keep only the documentation content that a developer would need
- Add "Full documentation: https://insightsentry.com/docs" after the title
- This MCP is only for InsightSentry direct subscribers (not RapidAPI users). The same API key from the InsightSentry dashboard is used for both REST and WebSocket APIs.
- EXCLUDE all RapidAPI-specific content: /v2/websocket-key endpoint, WebSocket API key rotation, key expiration, RapidAPI headers (x-rapidapi-key), and any references to rapidapi.com URLs.
- Replace any "WebSocket API key" references with just "API key" since it's the same key for both REST and WebSocket.

Output format — your response MUST start with exactly these two lines, then the markdown:
NAME: <short name for this doc, e.g. "InsightSentry WebSocket API Guide">
DESCRIPTION: <one-line description of what this doc covers>

Then a blank line, then the full markdown content. Nothing else.`;

  try {
    const result = execSync(
      `claude -p ${JSON.stringify(prompt)} --allowedTools "Read"`,
      {
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const output = result.trim();
    const nameMatch = output.match(/^NAME:\s*(.+)$/m);
    const descMatch = output.match(/^DESCRIPTION:\s*(.+)$/m);

    // Extract content after the NAME/DESCRIPTION lines
    let content = output
      .replace(/^NAME:.*$/m, "")
      .replace(/^DESCRIPTION:.*$/m, "")
      .trim();

    const name = nameMatch?.[1]?.trim() || `InsightSentry ${dirName} Guide`;
    const description = descMatch?.[1]?.trim() || `Documentation for ${dirName}`;

    return { content, name, description };
  } catch (error: any) {
    console.error(`  ERROR extracting ${filePath}: ${error.message}`);
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function generate(): Promise<void> {
  // 1. Discover and extract docs from TSX pages using Claude
  const pages = discoverDocPages();
  console.log(`  Found ${pages.length} doc pages (skipping: ${[...SKIP_DIRS].join(", ")})`);

  const extractedDocs: Array<{
    uri: string;
    name: string;
    description: string;
    content: string;
  }> = [];

  for (const page of pages) {
    console.log(`  Extracting ${page.dirName}/page.tsx...`);
    const result = extractWithClaude(page.filePath, page.dirName);

    if (!result || result.content.length < 100) {
      console.warn(`  WARN: Extraction failed or too short for ${page.dirName}, skipping`);
      continue;
    }

    const uri = `insightsentry://docs/${page.dirName}`;

    extractedDocs.push({
      uri,
      name: result.name,
      description: result.description,
      content: result.content,
    });

    console.log(`  ${page.dirName}/page.tsx → ${uri} (${result.content.length} chars)`);
  }

  // 2. Preserve static resources from existing resources.ts
  const existingPath = resolve(__dirname, "../src/resources.ts");
  const staticResources: typeof extractedDocs = [];

  try {
    const { docResources: existing } = await import(existingPath);
    for (const uri of STATIC_URIS) {
      const found = existing.find((r: any) => r.uri === uri);
      if (found && found.content.length > 100) {
        staticResources.push({
          uri: found.uri,
          name: found.name,
          description: found.description,
          content: found.content,
        });
        console.log(`  [preserved] ${uri} (${found.content.length} chars)`);
      } else {
        console.warn(`  WARN: No existing content for ${uri} — add it manually`);
      }
    }
  } catch {
    console.warn("  WARN: Could not import existing resources.ts — static resources need manual addition.");
  }

  // 3. Combine and generate resources.ts
  const allResources = [...staticResources, ...extractedDocs];

  const resourceEntries = allResources
    .map(
      (r) => `  {
    uri: ${JSON.stringify(r.uri)},
    name: ${JSON.stringify(r.name)},
    description: ${JSON.stringify(r.description)},
    mimeType: "text/markdown",
    content: \`${r.content.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\`,
  }`,
    )
    .join(",\n");

  const output = `// AUTO-GENERATED by scripts/generate-docs.ts (using Claude CLI)
// Static resources (rest-api, workflows) are preserved from the previous version.
// Extracted resources are regenerated from website TSX doc pages.
// To regenerate: npm run generate:docs

export interface DocResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  content: string;
}

export const docResources: DocResource[] = [
${resourceEntries}
];
`;

  writeFileSync(existingPath, output, "utf-8");
  console.log(`\nGenerated ${allResources.length} resources → src/resources.ts`);
}

generate();
