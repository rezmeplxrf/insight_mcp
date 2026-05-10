import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { docResources, fetchDocResourceContent } from "../src/resources.js";

describe("docResources", () => {
  it("contains the website documentation pages without embedded content", () => {
    assert.deepEqual(
      docResources.map((resource) => resource.uri),
      [
        "insightsentry://docs",
        "insightsentry://docs/parameters",
        "insightsentry://docs/ws",
        "insightsentry://docs/mcp",
        "insightsentry://docs/screener",
        "insightsentry://docs/options",
        "insightsentry://docs/organization",
        "insightsentry://docs/archive",
        "insightsentry://docs/futures-history",
        "insightsentry://docs/scalability",
        "insightsentry://docs/enterprise",
      ],
    );

    for (const resource of docResources) {
      assert.equal(resource.mimeType, "text/markdown");
      assert.ok(resource.url.startsWith("https://insightsentry.com/docs"));
      assert.equal("content" in resource, false);
    }
  });

  it("fetches doc page content as markdown on demand", async () => {
    const requested: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requested.push({ input: String(input), init });
      return new Response("# Markdown docs", { status: 200 });
    };

    const content = await fetchDocResourceContent(docResources[1], fetcher);

    assert.equal(content, "# Markdown docs");
    assert.deepEqual(requested, [
      {
        input: "https://insightsentry.com/docs/parameters",
        init: { headers: { Accept: "text/markdown" } },
      },
    ]);
  });

  it("reports the failed doc URL when a page cannot be fetched", async () => {
    const fetcher: typeof fetch = async () =>
      new Response("missing", { status: 404, statusText: "Not Found" });

    await assert.rejects(
      () => fetchDocResourceContent(docResources[1], fetcher),
      /Failed to fetch InsightSentry Common Parameters from https:\/\/insightsentry\.com\/docs\/parameters: 404 Not Found/,
    );
  });
});
