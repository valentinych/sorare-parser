import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import {
  clubFileSlug,
  filterGreenHits,
  greenRegionFinderSource,
  tourClubScreenshotPath,
  type GreenRegionHit,
  type ScreenshotClip,
  type ScreenshotRequest,
} from "../domain/expected11Screenshot.js";
import {
  expected11LaunchOptions,
  installedChromeBinary,
  parseExpected11MatchUrl,
} from "./runExpected11.js";

export type CapturedScreenshot = {
  path: string;
  /** Relative to `data/expected11/output`, e.g. `3/millwall.png`. */
  relativePath: string;
  mode: ScreenshotRequest["mode"];
  side?: GreenRegionHit["side"];
  teamName?: string | null;
  clubSlug?: string | null;
  clip: ScreenshotClip;
};

function expected11OutputRoot(projectRoot: string): string {
  return resolve(projectRoot, "data/expected11/output");
}

function screenshotsStampDir(projectRoot: string, stamp?: string): string {
  const folder = stamp
    ? `screenshots-${stamp.replace(/[:.]/g, "-")}`
    : "screenshots";
  return resolve(expected11OutputRoot(projectRoot), folder);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clipScreenshot(
  page: Page,
  clip: ScreenshotClip,
  filePath: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await page.screenshot({
    path: filePath,
    type: "png",
    clip,
    animations: "disabled",
  });
}

function fileNameForHit(hit: GreenRegionHit, index: number): string {
  if (hit.teamName) {
    try {
      return `${clubFileSlug(hit.teamName)}.png`;
    } catch {
      /* fall through */
    }
  }
  return `green-${hit.side}-${index}.png`;
}

export async function captureGreenRegionsOnPage(
  page: Page,
  options: {
    /** Absolute output root (`data/expected11/output`) or stamp folder when no tour. */
    outputRoot: string;
    /** When set, files go to `{outputRoot}/{tour}/{club}.png`. */
    tour?: number;
    sides?: ScreenshotRequest["sides"];
  },
): Promise<CapturedScreenshot[]> {
  const hits = filterGreenHits(
    (await page.evaluate(greenRegionFinderSource())) as GreenRegionHit[],
    options.sides,
  );
  if (!hits.length) {
    throw new Error(
      "No green lineup region found on the page. Open a match with visible pitches, or use mode=coords.",
    );
  }

  const captured: CapturedScreenshot[] = [];
  let index = 0;
  for (const hit of hits) {
    index += 1;
    let relativePath: string;
    let clubSlug: string | null = null;
    if (options.tour != null && hit.teamName) {
      relativePath = tourClubScreenshotPath(options.tour, hit.teamName);
      clubSlug = clubFileSlug(hit.teamName);
    } else {
      const name = fileNameForHit(hit, index);
      relativePath =
        options.tour != null ? `${options.tour}/${name}` : name;
      if (hit.teamName) {
        try {
          clubSlug = clubFileSlug(hit.teamName);
        } catch {
          clubSlug = null;
        }
      }
    }
    const filePath = resolve(options.outputRoot, relativePath);
    await clipScreenshot(page, hit.box, filePath);
    captured.push({
      path: filePath,
      relativePath,
      mode: "green",
      side: hit.side,
      teamName: hit.teamName,
      clubSlug,
      clip: hit.box,
    });
  }
  return captured;
}

export async function captureCoordsOnPage(
  page: Page,
  outputRoot: string,
  clip: ScreenshotClip,
  tour?: number,
): Promise<CapturedScreenshot[]> {
  const relativePath =
    tour != null ? `${tour}/coords-clip.png` : "coords-clip.png";
  const filePath = resolve(outputRoot, relativePath);
  await clipScreenshot(page, clip, filePath);
  return [
    {
      path: filePath,
      relativePath,
      mode: "coords",
      clip,
    },
  ];
}

/**
 * Capture screenshots for a match URL using the Expected11 Chrome profile.
 * Close any other Expected11 Chrome window that locks the same profile first.
 * With `tour`, green captures are saved as `{tour}/{club}.png`.
 */
export async function captureExpected11Screenshot(
  request: ScreenshotRequest,
): Promise<{ outputDir: string; files: CapturedScreenshot[] }> {
  if (request.mode === "coords" && !request.clip) {
    throw new Error("coords mode requires clip.");
  }
  if (!request.url) {
    throw new Error("url is required to capture a screenshot.");
  }

  const url = parseExpected11MatchUrl(request.url);
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const stamp = new Date().toISOString();
  const outputRoot = expected11OutputRoot(projectRoot);
  const outputDir =
    request.tour != null
      ? resolve(outputRoot, String(request.tour))
      : screenshotsStampDir(projectRoot, stamp);

  const headless =
    process.env.EXPECTED11_HEADLESS === "1" ||
    (process.platform === "linux" && !process.env.DISPLAY);
  const chromeProfileDir = resolve(projectRoot, "data/expected11/chrome-profile");
  await mkdir(chromeProfileDir, { recursive: true });

  const useChrome = Boolean(installedChromeBinary());
  const context = await chromium.launchPersistentContext(
    chromeProfileDir,
    expected11LaunchOptions(headless, useChrome),
  );

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await sleep(1_800);

    const files =
      request.mode === "green"
        ? await captureGreenRegionsOnPage(page, {
            outputRoot,
            tour: request.tour,
            sides: request.sides,
          })
        : await captureCoordsOnPage(
            page,
            request.tour != null ? outputRoot : outputDir,
            request.clip!,
            request.tour,
          );

    await writeFile(
      resolve(outputDir, "manifest.json"),
      `${JSON.stringify(
        {
          capturedAt: stamp,
          url,
          mode: request.mode,
          tour: request.tour ?? null,
          files: files.map((f) => ({
            path: f.path,
            relativePath: f.relativePath,
            side: f.side ?? null,
            teamName: f.teamName ?? null,
            clubSlug: f.clubSlug ?? null,
            clip: f.clip,
          })),
        },
        null,
        2,
      )}\n`,
    );

    return { outputDir, files };
  } finally {
    await context.close();
  }
}

/** During a parser run: dump green pitches for the current page as `{tour}/{club}.png`. */
export async function captureGreenDuringRun(
  page: Page,
  matchUrl: string,
  extractedAt: string,
  tour?: number,
): Promise<CapturedScreenshot[]> {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const outputRoot = expected11OutputRoot(projectRoot);
  try {
    if (tour != null) {
      return await captureGreenRegionsOnPage(page, { outputRoot, tour });
    }
    const id = new URL(matchUrl).pathname.match(/\/match\/(\d+)/)?.[1] ?? "match";
    const stampRoot = screenshotsStampDir(projectRoot, extractedAt);
    return await captureGreenRegionsOnPage(page, {
      outputRoot: resolve(stampRoot, id),
    });
  } catch (error) {
    console.warn(
      `Screenshot skipped for ${matchUrl}:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}
