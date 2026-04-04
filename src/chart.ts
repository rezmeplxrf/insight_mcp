import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import type { ChartConfiguration } from "chart.js";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 400;

// Cache canvases by dimension to avoid re-creating them
const canvasCache = new Map<string, ChartJSNodeCanvas>();

function getCanvas(width: number, height: number): ChartJSNodeCanvas {
  const key = `${width}x${height}`;
  let canvas = canvasCache.get(key);
  if (!canvas) {
    canvas = new ChartJSNodeCanvas({
      width,
      height,
      backgroundColour: "white",
    });
    canvasCache.set(key, canvas);
  }
  return canvas;
}

export async function renderChart(
  config: ChartConfiguration,
  width: number = DEFAULT_WIDTH,
  height: number = DEFAULT_HEIGHT,
): Promise<{ base64: string; filePath: string }> {
  const canvas = getCanvas(width, height);
  const buffer = await canvas.renderToBuffer(config);
  const base64 = buffer.toString("base64");

  // Save to a temp file so the LLM can pass the path directly to the user
  const fileName = `insightsentry_chart_${Date.now()}.png`;
  const filePath = join(tmpdir(), fileName);
  writeFileSync(filePath, buffer);

  return { base64, filePath };
}
