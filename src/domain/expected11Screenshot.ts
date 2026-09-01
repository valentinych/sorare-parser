/** Screenshot helpers for the local Expected11 parser (green pitch / window clip). */

export type ScreenshotClip = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ScreenshotMode = "green" | "coords";

export type ScreenshotRequest = {
  mode: ScreenshotMode;
  /** Required for mode=coords; viewport/window-relative pixels. */
  clip?: ScreenshotClip;
  /** Optional Expected11 match URL; opens in the headed Chrome profile. */
  url?: string;
  /** Which green lineup sides to capture when mode=green. */
  sides?: Array<"home" | "away" | "all">;
  /** Selected Mantra/Expected11 tour — files saved as `{tour}/{club}.png`. */
  tour?: number;
};

export type GreenRegionHit = {
  side: "home" | "away" | "unknown";
  /** Team name from HTML (aria-label / match-view labels). */
  teamName: string | null;
  selector: string;
  box: ScreenshotClip;
};

/** `Millwall FC` → `millwall`; safe for `{tour}/{club}.png`. */
export function clubFileSlug(teamName: string): string {
  const cleaned = teamName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+(fc|afc|cf|sc)\.?$/i, "")
    .replace(/&/g, " and ");
  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!slug) {
    throw new Error(`Could not build club slug from team name: ${teamName}`);
  }
  return slug;
}

export function parseScreenshotTour(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const tour = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(tour) || tour < 1 || tour > 99) {
    throw new Error("tour must be an integer from 1 to 99.");
  }
  return tour;
}

export const EXPECTED11_GREEN_LINEUP_SELECTORS = [
  ".lineup--home",
  ".lineup--away",
  '.lineup[aria-label*="starting lineup"]',
  ".lineup",
] as const;

export function parseScreenshotClip(value: unknown): ScreenshotClip {
  if (!value || typeof value !== "object") {
    throw new Error("clip must be an object with x, y, width, height.");
  }
  const raw = value as Record<string, unknown>;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) {
    throw new Error("clip.x/y/width/height must be finite numbers.");
  }
  if (width < 1 || height < 1) {
    throw new Error("clip.width and clip.height must be >= 1.");
  }
  if (x < 0 || y < 0) {
    throw new Error("clip.x and clip.y must be >= 0 (viewport coordinates).");
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function parseScreenshotRequest(body: unknown): ScreenshotRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be an object.");
  }
  const raw = body as Record<string, unknown>;
  const mode = raw.mode;
  if (mode !== "green" && mode !== "coords") {
    throw new Error('mode must be "green" or "coords".');
  }

  let url: string | undefined;
  if (raw.url !== undefined) {
    if (typeof raw.url !== "string" || !raw.url.trim()) {
      throw new Error("url must be a non-empty string when provided.");
    }
    url = raw.url.trim();
  }

  const tour = parseScreenshotTour(raw.tour);

  if (mode === "coords") {
    return { mode, url, tour, clip: parseScreenshotClip(raw.clip) };
  }

  let sides: ScreenshotRequest["sides"];
  if (raw.sides !== undefined) {
    if (!Array.isArray(raw.sides) || raw.sides.length === 0) {
      throw new Error('sides must be a non-empty array of "home" | "away" | "all".');
    }
    sides = [];
    for (const side of raw.sides) {
      if (side !== "home" && side !== "away" && side !== "all") {
        throw new Error('sides entries must be "home", "away", or "all".');
      }
      sides.push(side);
    }
  }

  return { mode, url, tour, sides };
}

/** Relative path under `data/expected11/output`, e.g. `3/millwall.png`. */
export function tourClubScreenshotPath(tour: number, teamName: string): string {
  return `${tour}/${clubFileSlug(teamName)}.png`;
}

/** Browser-side finder: known lineup selectors, then largest green-tinted box. */
export function greenRegionFinderSource(): string {
  return `(() => {
    const selectors = ${JSON.stringify([...EXPECTED11_GREEN_LINEUP_SELECTORS])};
    const hits = [];
    const seen = new Set();
    const labelText = (sel) => {
      const el = document.querySelector(sel);
      return el ? String(el.textContent || "").replace(/\\s+/g, " ").trim() : "";
    };
    const homeLabel = labelText(".match-view__team-label--home");
    const awayLabel = labelText(".match-view__team-label--away");
    const teamNameFor = (el, side) => {
      const aria = String(el.getAttribute("aria-label") || "").trim();
      const fromAria = aria.replace(/\\s+starting lineup$/i, "").trim();
      if (fromAria && fromAria.toLowerCase() !== "home" && fromAria.toLowerCase() !== "away") {
        return fromAria;
      }
      if (side === "home") return homeLabel || null;
      if (side === "away") return awayLabel || null;
      return homeLabel || awayLabel || null;
    };
    const push = (el, side, selector) => {
      if (!(el instanceof Element) || seen.has(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) return;
      seen.add(el);
      hits.push({
        side,
        teamName: teamNameFor(el, side),
        selector,
        box: {
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    };

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const side = el.classList.contains("lineup--home")
          ? "home"
          : el.classList.contains("lineup--away")
            ? "away"
            : /home/i.test(el.getAttribute("aria-label") || "")
              ? "home"
              : /away/i.test(el.getAttribute("aria-label") || "")
                ? "away"
                : "unknown";
        push(el, side, selector);
      }
    }
    if (hits.length) return hits;

    // Fallback: largest visible element with a green-ish background in the viewport.
    let best = null;
    for (const el of document.querySelectorAll("div, section, article, main")) {
      if (!(el instanceof Element)) continue;
      const style = getComputedStyle(el);
      const bg = style.backgroundColor || "";
      const m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/i);
      if (!m) continue;
      const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
      if (!(g > r + 25 && g > b + 25 && g > 80)) continue;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area < 20_000) continue;
      if (rect.bottom < 0 || rect.right < 0) continue;
      if (rect.top > innerHeight || rect.left > innerWidth) continue;
      if (!best || area > best.area) {
        best = {
          area,
          hit: {
            side: "unknown",
            teamName: homeLabel || awayLabel || null,
            selector: "green-bg",
            box: {
              x: Math.max(0, Math.round(rect.x)),
              y: Math.max(0, Math.round(rect.y)),
              width: Math.round(Math.min(rect.width, innerWidth - Math.max(0, rect.x))),
              height: Math.round(Math.min(rect.height, innerHeight - Math.max(0, rect.y))),
            },
          },
        };
      }
    }
    return best ? [best.hit] : [];
  })()`;
}

export function filterGreenHits(
  hits: GreenRegionHit[],
  sides?: ScreenshotRequest["sides"],
): GreenRegionHit[] {
  if (!sides || sides.includes("all")) return hits;
  const want = new Set(sides.filter((s) => s === "home" || s === "away"));
  return hits.filter((hit) => want.has(hit.side as "home" | "away"));
}
