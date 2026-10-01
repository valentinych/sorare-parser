/**
 * Headed Playwright session for SorareInside lineups (separate Chrome profile).
 * Screenshots: `data/sorare/output/{tour}/{club}.png`
 */
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Response,
} from "playwright";
import { sanitizeSorareAnalystNote } from "../domain/sorareInsideNotes.js";
import {
  clubFileSlug,
  competitionAccordionRegex,
  accordionTextMatchesCompetition,
  displaySorareOutputDir,
  LINEUP_CLUB_FIND_SOURCE,
  LINEUP_ACCORDION_FIND_SOURCE,
  LINEUP_TEAM_LABELS_MATCH_SOURCE,
  isSorareInsideGamesApiUrl,
  loadSorareOutputDirConfig,
  mergeSorareInsideProbabilities,
  parseBenchAndDnpPlayerLists,
  parseProbabilitiesFromModalText,
  parseSorareInsideAnalystNotes,
  parseProbabilitiesFromPitchCards,
  pickBestPitchProbabilityParse,
  parseSorareInsideCaptureRequest,
  parseSorareInsideDiscoverRequest,
  parseSorareInsideExpandRequest,
  parseSorareInsideGamesPayload,
  parseSorareOutputDir,
  saveSorareOutputDirConfig,
  SORARE_OUTPUT_RELATIVE_ROOT,
  sorareTourClubGreenScreenshotPath,
  sorareTourClubScreenshotPath,
  type SorareInsideCaptureRequest,
  type SorareInsideLeague,
  type SorareInsideMatch,
  type SorareInsidePlayerProbability,
} from "../domain/sorareInsideScreenshot.js";
import {
  SI_EXTRACT_SECTION_TEXT_SCRIPT,
  SI_GREEN_CLIP_SCRIPT,
  SI_PREPARE_MODAL_SCRIPT,
  SI_REMARK_PITCH_SCRIPT,
} from "./sorareInsideCapturePrepare.js";
import {
  expected11LaunchOptions,
  installedChromeBinary,
} from "./runExpected11.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const chromeProfileDir = resolve(projectRoot, "data/sorare/chrome-profile");
const defaultOutputRoot = resolve(projectRoot, SORARE_OUTPUT_RELATIVE_ROOT);
const SORARE_LOGIN_URL = "https://sorareinside.com/auth/login";
/** Real Mantine spinners only — RingProgress / [role=progressbar] are % rings. */
const SI_SPINNER_SELECTOR =
  ".mantine-Loader-root, .mantine-LoadingOverlay-root, .mantine-LoadingOverlay-overlay";

export type SorareInsideSessionState =
  | "idle"
  | "running"
  | "waiting-login"
  | "ready"
  | "failed";

export type SorareInsideSessionStatus = {
  state: SorareInsideSessionState;
  message: string;
  gwSlug: string | null;
  lineupsUrl: string | null;
  leagueCount: number;
  matchCount: number;
  currentUrl: string | null;
  /** Max parallel capture tabs in the shared Chrome profile (1–3). */
  captureConcurrency: number;
  /** Captures currently holding a tab. */
  activeCaptures: number;
};

/** Clamp SORAREINSIDE_CAPTURE_CONCURRENCY to 1–3 (default 3). */
export function parseSorareCaptureConcurrency(
  raw: string | undefined = process.env.SORAREINSIDE_CAPTURE_CONCURRENCY,
): number {
  const n = Number(raw ?? 3);
  if (!Number.isFinite(n)) return 3;
  return Math.min(3, Math.max(1, Math.trunc(n)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluateTimed<T>(
  page: Page,
  script: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate(script) as Promise<T>,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`evaluate timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resetChromeSessionRestore(profileDir: string): Promise<void> {
  const defaultDir = resolve(profileDir, "Default");
  for (const name of ["Current Session", "Last Session", "Current Tabs", "Last Tabs"]) {
    await unlink(resolve(defaultDir, name)).catch(() => {});
  }
}

async function hasAccessCookie(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies("https://sorareinside.com");
  return cookies.some(
    (cookie) =>
      cookie.name === "userAccessTokenV3" && Boolean(cookie.value?.trim()),
  );
}

async function looksLoggedIn(page: Page, context: BrowserContext): Promise<boolean> {
  if (await hasAccessCookie(context)) return true;
  const url = page.url();
  if (/\/auth\/(login|signup)/i.test(url)) return false;
  const hasAccordion = await page
    .locator("[data-accordion-control], .mantine-Accordion-control")
    .count()
    .catch(() => 0);
  if (hasAccordion > 0) return true;
  const paywall = await page
    .getByText(/sign in|log in|subscribe|get access/i)
    .first()
    .isVisible()
    .catch(() => false);
  return !paywall && /\/lineups/i.test(url);
}

function isHeadless(): boolean {
  return (
    process.env.SORAREINSIDE_HEADLESS === "1" ||
    process.env.EXPECTED11_HEADLESS === "1" ||
    (process.platform === "linux" && !process.env.DISPLAY)
  );
}

export class SorareInsideSession {
  /** Discover / login exclusive lock (not held by captures). */
  private busy = false;
  private activeCaptures = 0;
  private readonly activeCaptureLabels = new Set<string>();
  private readonly captureConcurrency = parseSorareCaptureConcurrency();
  /** Serialize league-row expand across parallel tabs (Chrome thrash / virtualized list). */
  private expandChain: Promise<void> = Promise.resolve();
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private continueLogin: (() => void) | null = null;
  private gwSlug: string | null = null;
  private lineupsUrl: string | null = null;
  private leagues: SorareInsideLeague[] = [];
  private matches: SorareInsideMatch[] = [];
  private leagueRounds = new Map<string, number>();
  private outputRootAbs =
    loadSorareOutputDirConfig(projectRoot) ?? defaultOutputRoot;
  /** True after the lineups page has been scrolled to mount lazy match rows. */
  private lineupsFullyLoaded = false;
  private status: SorareInsideSessionStatus = {
    state: "idle",
    message: "Ready",
    gwSlug: null,
    lineupsUrl: null,
    leagueCount: 0,
    matchCount: 0,
    currentUrl: null,
    captureConcurrency: parseSorareCaptureConcurrency(),
    activeCaptures: 0,
  };

  getStatus(): SorareInsideSessionStatus {
    return {
      ...this.status,
      captureConcurrency: this.captureConcurrency,
      activeCaptures: this.activeCaptures,
    };
  }

  getLeagues(): SorareInsideLeague[] {
    return this.leagues.map((league) => ({ ...league }));
  }

  getMatches(leagueIds?: string[]): SorareInsideMatch[] {
    const want = leagueIds?.length ? new Set(leagueIds) : null;
    return this.matches
      .filter((match) => (want ? want.has(match.leagueId) : true))
      .map((match) => ({
        ...match,
        home: { ...match.home },
        away: { ...match.away },
      }));
  }

  getLeagueRound(leagueId: string): number | undefined {
    return this.leagueRounds.get(leagueId);
  }

  getOutputRootAbs(): string {
    return this.outputRootAbs;
  }

  getOutputRootDisplay(): string {
    return displaySorareOutputDir(this.outputRootAbs, projectRoot);
  }

  setOutputRoot(value: string): string {
    this.outputRootAbs = parseSorareOutputDir(value, projectRoot);
    saveSorareOutputDirConfig(projectRoot, this.outputRootAbs);
    return this.outputRootAbs;
  }

  continueAfterLogin(): boolean {
    if (!this.continueLogin) return false;
    this.continueLogin();
    return true;
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.continueLogin = null;
    if (context) await context.close().catch(() => {});
  }

  private setStatus(
    patch: Partial<SorareInsideSessionStatus> &
      Pick<SorareInsideSessionStatus, "state" | "message">,
  ) {
    this.status = {
      ...this.status,
      ...patch,
      leagueCount: this.leagues.length,
      matchCount: this.matches.length,
      gwSlug: this.gwSlug,
      lineupsUrl: this.lineupsUrl,
      captureConcurrency: this.captureConcurrency,
      activeCaptures: this.activeCaptures,
    };
  }

  private captureStatusMessage(fallback: string): string {
    if (this.activeCaptureLabels.size === 0) return fallback;
    const labels = [...this.activeCaptureLabels].slice(0, 4);
    const more =
      this.activeCaptureLabels.size > labels.length
        ? ` +${this.activeCaptureLabels.size - labels.length}`
        : "";
    return `Capturing ${this.activeCaptures}/${this.captureConcurrency}: ${labels.join(", ")}${more}`;
  }

  /** Run fn while holding the expand lock (parallel captures take turns expanding). */
  private async withExpandLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.expandChain;
    this.expandChain = prev.then(() => gate);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * New SorareInside UI: competition title + "N LINEUPS" are sibling columns;
   * bare title clicks often only paint a green border. Click the row chevron.
   */
  private async forceClickLeagueRowChevron(
    page: Page,
    league: SorareInsideLeague,
  ): Promise<boolean> {
    const competition = league.competitionName.trim();
    const region = league.regionName.trim();
    if (!competition) return false;
    // Italy Serie A shares the bare "Serie A" / "20 LINEUPS" sibling layout with
    // Brazil — prefer an explicit title+LINEUPS Y-band click under Italy.
    if (/ital/i.test(region) && /^serie\s*a$/i.test(competition)) {
      const italyHit = await this.forceClickItalySerieARow(page);
      if (italyHit) return true;
    }
    if (region) {
      const heading = page.getByText(region, { exact: true }).first();
      if (await heading.count().catch(() => 0)) {
        await heading.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(250);
        // Small nudge so the competition chip under the region heading mounts.
        // Large wheels scroll past Germany's 1. Bundesliga onto 2. BL / next region.
        await page.mouse.wheel(0, 120).catch(() => {});
        await sleep(200);
      }
    }
    const hit = await evaluateTimed<{ ok?: boolean; text?: string }>(
      page,
      `(() => {
        const fold = (value) =>
          String(value || "")
            .normalize("NFKD")
            .replace(/[\\u0300-\\u036f]/g, "")
            .replace(/\\u0131/g, "i")
            .replace(/\\u0130/g, "i")
            .toLowerCase()
            .replace(/\\s+/g, " ")
            .trim();
        const textOf = (el) =>
          String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
        const wantComp = fold(${JSON.stringify(competition)});
        const wantRegion = fold(${JSON.stringify(region)});
        const isTopBl = wantComp === "bundesliga";
        const matchesComp = (raw) => {
          const f = fold(raw);
          if (!f.includes(wantComp)) return false;
          // "Bundesliga" must not steal Germany's "2. Bundesliga" row.
          if (isTopBl && /(?:^|\\s)2\\.\\s*bundesliga\\b/.test(f)) return false;
          if (isTopBl && /bundesliga\\s*2\\b/.test(f)) return false;
          return true;
        };
        let regionY = 0;
        if (wantRegion) {
          for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,div,span,p")) {
            const t = fold(textOf(el));
            if (t !== wantRegion && !t.startsWith(wantRegion + " ")) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 20 && r.height > 8 && r.height < 80) {
              regionY = r.y;
              break;
            }
          }
        }
        let best = null;
        let bestY = Infinity;
        for (const el of document.querySelectorAll("div, button, section, article, li")) {
          const t = textOf(el);
          if (t.length < 8 || t.length > 200) continue;
          if (!matchesComp(t)) continue;
          if (!/\\d+\\s+lineups/i.test(t)) continue;
          const r = el.getBoundingClientRect();
          if (regionY && (r.y < regionY - 8 || r.y > regionY + 900)) continue;
          if (r.height > 140) continue;
          // Prefer "1. Bundesliga" over bare "Bundesliga" when both sit under Germany.
          const prefer =
            isTopBl && /(?:^|\\s)1\\.\\s*bundesliga\\b/.test(fold(t)) ? -40 : 0;
          const rank = r.y + prefer;
          if (rank < bestY) {
            bestY = rank;
            best = el;
          }
        }
        // Sibling-column layout: title and LINEUPS are not in the same text node.
        if (!best && regionY) {
          for (const el of document.querySelectorAll("div, button, section, article")) {
            const t = textOf(el);
            if (!/^\\d+\\s+lineups$/i.test(t)) continue;
            const r = el.getBoundingClientRect();
            if (r.y < regionY - 8 || r.y > regionY + 900) continue;
            let row = el.parentElement;
            for (let d = 0; d < 5 && row; d++) {
              const kids = [...row.children].map((c) => fold(textOf(c))).join(" | ");
              const rowFold = fold(textOf(row));
              if (matchesComp(kids) || matchesComp(rowFold)) {
                best = row;
                break;
              }
              row = row.parentElement;
            }
            if (best) break;
            // Türkiye / Germany / Italy: first matching LINEUPS chip under the region
            // heading when title lives in a sibling column.
            if (/t[uü]rk/i.test(${JSON.stringify(region)})) {
              best = el.closest("div, button, section, article") || el;
              break;
            }
            if (/ital/i.test(${JSON.stringify(region)})) {
              // Prefer Serie A over Serie B under Italy (same sibling layout).
              let probe = el.parentElement;
              let skipB = false;
              for (let d = 0; d < 6 && probe; d++) {
                const kids = [...probe.children].map((c) => fold(textOf(c))).join(" | ");
                const rowFold = fold(textOf(probe));
                if (wantComp === "serie a" && /serie\s*b\b/.test(kids + " " + rowFold) && !/serie\s*a\b/.test(kids + " " + rowFold)) {
                  skipB = true;
                  break;
                }
                if (matchesComp(kids) || matchesComp(rowFold)) {
                  best = probe;
                  break;
                }
                probe = probe.parentElement;
              }
              if (skipB) continue;
              if (best) break;
              // First LINEUPS under Italy is usually Serie A.
              if (wantComp === "serie a") {
                best = el.closest("div, button, section, article") || el;
                break;
              }
            }
            if (/german/i.test(${JSON.stringify(region)}) && isTopBl) {
              let probe = el.parentElement;
              let skip = false;
              for (let d = 0; d < 5 && probe; d++) {
                const kids = [...probe.children].map((c) => fold(textOf(c))).join(" | ");
                if (/(?:^|\\s)2\\.\\s*bundesliga\\b/.test(kids) || /bundesliga\\s*2\\b/.test(kids)) {
                  skip = true;
                  break;
                }
                if (/(?:^|\\s)1\\.\\s*bundesliga\\b/.test(kids) || /(?:^|\\|\\s)bundesliga(?:\\s|\\|)/.test(kids)) {
                  best = probe;
                  break;
                }
                probe = probe.parentElement;
              }
              if (skip) continue;
              if (best) break;
            }
          }
        }
        if (!best) return { ok: false, text: "no-row" };
        best.scrollIntoView({ block: "center", inline: "nearest" });
        const buttons = [...best.querySelectorAll("button, [role='button']")];
        const chevron =
          [...buttons].reverse().find((b) => {
            const bt = textOf(b);
            return bt.length < 8 || /svg|chevron|arrow/i.test(b.innerHTML || "");
          }) || null;
        const target = chevron || best;
        if (typeof target.click === "function") target.click();
        return { ok: true, text: textOf(best).slice(0, 120) };
      })()`,
      12_000,
    ).catch(() => null);
    return Boolean(hit?.ok);
  }

  /**
   * Click Italy's Serie A row (not Brazil / Serie B). Title and "N LINEUPS"
   * sit in sibling columns — match them by Y-band under the Italy heading.
   */
  private async forceClickItalySerieARow(page: Page): Promise<boolean> {
    const heading = page.getByText("Italy", { exact: true }).first();
    if (!(await heading.count().catch(() => 0))) return false;
    await heading.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(300);
    await page.mouse.wheel(0, 140).catch(() => {});
    await sleep(250);
    const headingY =
      (await heading.boundingBox().catch(() => null))?.y ?? 0;
    if (!headingY) return false;

    // Bound the search: stop before Serie B under Italy when possible.
    let maxY = headingY + 700;
    const serieB = page.getByText("Serie B", { exact: true });
    const serieBN = await serieB.count().catch(() => 0);
    for (let i = 0; i < serieBN; i += 1) {
      const box = await serieB.nth(i).boundingBox().catch(() => null);
      if (!box) continue;
      if (box.y > headingY + 20 && box.y < maxY) maxY = box.y - 4;
    }

    const titles = page.getByText("Serie A", { exact: true });
    const titleN = await titles.count().catch(() => 0);
    let titleY = 0;
    let titleLoc: ReturnType<Page["locator"]> | null = null;
    for (let i = 0; i < titleN; i += 1) {
      const loc = titles.nth(i);
      const box = await loc.boundingBox().catch(() => null);
      if (!box) continue;
      if (box.y < headingY - 8 || box.y > maxY) continue;
      titleY = box.y;
      titleLoc = loc;
      break;
    }
    if (!titleLoc || !titleY) return false;

    const lineups = page.getByText(/\d+\s+LINEUPS/i);
    const lineupsN = await lineups.count().catch(() => 0);
    let lineupLoc: ReturnType<Page["locator"]> | null = null;
    let bestDy = Number.POSITIVE_INFINITY;
    for (let i = 0; i < lineupsN; i += 1) {
      const loc = lineups.nth(i);
      const box = await loc.boundingBox().catch(() => null);
      if (!box) continue;
      if (box.y < headingY - 8 || box.y > maxY) continue;
      const dy = Math.abs(box.y - titleY);
      if (dy < bestDy && dy <= 60) {
        bestDy = dy;
        lineupLoc = loc;
      }
    }

    // Prefer chevron/button on the LINEUPS chip; fall back to title click.
    if (lineupLoc) {
      await lineupLoc.scrollIntoViewIfNeeded().catch(() => {});
      const clickable = lineupLoc
        .locator(
          "xpath=ancestor-or-self::*[self::button or @role='button' or contains(@class,'Card') or contains(@class,'Accordion')][1]",
        )
        .first();
      if (await clickable.count().catch(() => 0)) {
        await clickable.click({ force: true, timeout: 4_000 }).catch(async () => {
          await lineupLoc!.click({ force: true, timeout: 4_000 }).catch(() => {});
        });
      } else {
        await lineupLoc.click({ force: true, timeout: 4_000 }).catch(() => {});
      }
    }
    await titleLoc.click({ force: true, timeout: 4_000 }).catch(() => {});
    // Second pass: click a tiny trailing button in the same Y-band (chevron).
    await evaluateTimed(
      page,
      `(() => {
        const titleY = ${JSON.stringify(titleY)};
        const headingY = ${JSON.stringify(headingY)};
        const maxY = ${JSON.stringify(maxY)};
        const buttons = [...document.querySelectorAll("button, [role='button']")];
        let best = null;
        let bestScore = Infinity;
        for (const b of buttons) {
          const r = b.getBoundingClientRect();
          if (r.y < headingY - 8 || r.y > maxY) continue;
          if (Math.abs(r.y - titleY) > 50) continue;
          if (r.width > 64 || r.height > 64) continue;
          const score = Math.abs(r.y - titleY) + (r.x > 400 ? 0 : 40);
          if (score < bestScore) {
            bestScore = score;
            best = b;
          }
        }
        if (best && typeof best.click === "function") best.click();
        return { ok: Boolean(best) };
      })()`,
      6_000,
    ).catch(() => null);
    await sleep(600);
    return true;
  }

  private async openCapturePage(): Promise<Page> {
    await this.ensureBrowser();
    if (!this.context) {
      throw new Error("Chrome context is not open.");
    }
    const page = await this.context.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(60_000);
    return page;
  }

  private async ensureBrowser(): Promise<Page> {
    if (this.context && this.page && !this.page.isClosed()) {
      return this.page;
    }
    // Don't tear down in-flight capture tabs if only the discover page died.
    if (this.context && this.activeCaptures > 0) {
      const live = this.context.pages().find((p) => !p.isClosed());
      this.page = live ?? (await this.context.newPage());
      this.page.setDefaultTimeout(30_000);
      this.page.setDefaultNavigationTimeout(60_000);
      return this.page;
    }
    await this.close();
    const headless = isHeadless();
    await mkdir(chromeProfileDir, { recursive: true });
    await resetChromeSessionRestore(chromeProfileDir);
    const useChrome = Boolean(installedChromeBinary());
    this.context = await chromium.launchPersistentContext(
      chromeProfileDir,
      expected11LaunchOptions(headless, useChrome),
    );
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.page.setDefaultTimeout(30_000);
    this.page.setDefaultNavigationTimeout(60_000);
    return this.page;
  }

  private async waitForManualLogin(page: Page): Promise<void> {
    if (!this.context) return;
    if (await looksLoggedIn(page, this.context)) return;

    await page.goto(SORARE_LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

    await new Promise<void>((resolve) => {
      this.setStatus({
        state: "waiting-login",
        message:
          "Sign in to SorareInside in Chrome, then click Login complete — continue.",
        currentUrl: page.url(),
      });
      this.continueLogin = () => {
        this.continueLogin = null;
        this.setStatus({
          state: "running",
          message: "Login confirmed; loading lineups…",
          currentUrl: page.url(),
        });
        resolve();
      };
    });

    // Give cookie/session a moment to settle after the user finishes.
    for (let i = 0; i < 20; i += 1) {
      if (await looksLoggedIn(page, this.context)) return;
      await sleep(250);
    }
  }

  /**
   * Wait until SorareInside finishes its "Getting latest saved lineups…"
   * banner and leagues are available (accordion UI and/or /games payload).
   */
  private async waitForLineupsLoaded(
    page: Page,
    getPayload: () => unknown,
  ): Promise<void> {
    this.setStatus({
      state: "running",
      message: "Waiting for SorareInside to finish loading lineups…",
      currentUrl: page.url(),
    });

    const loadingText = page.getByText(/Getting latest saved lineups/i);
    const leagueRows = page.locator(
      "[data-accordion-control], .mantine-Accordion-control, .mantine-Accordion-item",
    );
    const deadline = Date.now() + 120_000;
    let sawLoading = false;

    while (Date.now() < deadline) {
      if (this.context && !(await looksLoggedIn(page, this.context))) {
        throw new Error(
          "Not signed in to SorareInside (missing access cookie / paywall).",
        );
      }

      const loadingVisible = await loadingText
        .first()
        .isVisible()
        .catch(() => false);
      if (loadingVisible) sawLoading = true;

      const leagueCount = await leagueRows.count().catch(() => 0);
      const payload = getPayload();
      const parsedLeagues =
        payload != null ? parseSorareInsideGamesPayload(payload).leagues.length : 0;

      // Prefer: loading gone AND (UI leagues OR API leagues).
      if (!loadingVisible && (leagueCount > 0 || parsedLeagues > 0)) {
        // Brief settle after the banner disappears so accordion finishes painting.
        await sleep(500);
        const stillLoading = await loadingText
          .first()
          .isVisible()
          .catch(() => false);
        if (!stillLoading) return;
      }

      // If we never saw the banner but leagues are already present, we're done.
      if (!sawLoading && !loadingVisible && leagueCount > 0) return;

      await sleep(400);
    }

    const stillLoading = await loadingText
      .first()
      .isVisible()
      .catch(() => false);
    throw new Error(
      stillLoading
        ? 'Timed out after 120s: SorareInside still shows "Getting latest saved lineups…".'
        : "Timed out after 120s waiting for SorareInside leagues (no accordion / empty /games payload).",
    );
  }

  private async collectGamesPayload(
    page: Page,
    lineupsUrl: string,
  ): Promise<unknown> {
    let payload: unknown = null;
    const onResponse = async (response: Response) => {
      if (!isSorareInsideGamesApiUrl(response.url())) return;
      if (response.status() !== 200) return;
      try {
        const json = await response.json();
        // Prefer nested region/competition payloads over flat-list responses.
        const nextLeagues = parseSorareInsideGamesPayload(json).leagues.length;
        const curLeagues =
          payload != null ? parseSorareInsideGamesPayload(payload).leagues.length : 0;
        if (payload == null || nextLeagues >= curLeagues) {
          payload = json;
        }
      } catch {
        /* ignore non-JSON / unexpected shapes */
      }
    };
    page.on("response", onResponse);
    try {
      await page.goto(lineupsUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      // Soft network settle; do not fail if the SPA keeps polling.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

      await this.waitForLineupsLoaded(page, () => payload);
      await this.scrollLineupsPageToLoadAll(page);
      this.lineupsFullyLoaded = true;

      if (!payload) {
        throw new Error(
          "Timed out waiting for SorareInside /games response. Check login and gwSlug.",
        );
      }
      return payload;
    } finally {
      page.off("response", onResponse);
    }
  }

  /** Starts discover in the background; returns false if already busy. */
  startDiscover(body: unknown): boolean {
    if (this.busy || this.activeCaptures > 0) return false;
    const request = parseSorareInsideDiscoverRequest(body);
    this.busy = true;
    this.leagues = [];
    this.matches = [];
    this.leagueRounds.clear();
    this.lineupsFullyLoaded = false;
    this.gwSlug = request.gwSlug;
    this.lineupsUrl = request.url;
    this.setStatus({
      state: "running",
      message: "Opening SorareInside lineups…",
      currentUrl: request.url,
    });

    void this.runDiscover(request.url)
      .catch((error: unknown) => {
        this.setStatus({
          state: "failed",
          message: error instanceof Error ? error.message : String(error),
          currentUrl: this.page?.url() ?? null,
        });
      })
      .finally(() => {
        this.busy = false;
        this.continueLogin = null;
      });

    return true;
  }

  private async runDiscover(lineupsUrl: string): Promise<void> {
    const page = await this.ensureBrowser();
    await this.waitForManualLogin(page);
    this.setStatus({
      state: "running",
      message: "Waiting for SorareInside to finish loading lineups…",
      currentUrl: lineupsUrl,
    });
    const payload = await this.collectGamesPayload(page, lineupsUrl);
    const parsed = parseSorareInsideGamesPayload(payload);
    if (!parsed.leagues.length) {
      throw new Error(
        "SorareInside finished loading but returned no leagues. Check gwSlug / filters.",
      );
    }
    this.leagues = parsed.leagues;
    this.matches = parsed.matches;
    this.setStatus({
      state: "ready",
      message: `Loaded ${this.leagues.length} leagues · ${this.matches.length} matches.`,
      currentUrl: page.url(),
    });
  }

  expand(body: unknown): {
    status: SorareInsideSessionStatus;
    matches: SorareInsideMatch[];
    leagues: Array<{ id: string; round: number; label: string }>;
  } {
    const request = parseSorareInsideExpandRequest(body);
    if (!this.leagues.length) {
      throw new Error("Discover leagues first (paste a gwSlug URL and load).");
    }
    this.leagueRounds.clear();
    const selected: Array<{ id: string; round: number; label: string }> = [];
    for (const entry of request.leagues) {
      const league = this.leagues.find((item) => item.id === entry.id);
      if (!league) {
        throw new Error(`Unknown league id: ${entry.id}`);
      }
      this.leagueRounds.set(entry.id, entry.round);
      selected.push({ id: entry.id, round: entry.round, label: league.label });
    }
    const matches = this.getMatches(selected.map((item) => item.id));
    this.setStatus({
      state: "ready",
      message: `Expanded ${selected.length} league(s) → ${matches.length} match(es).`,
      currentUrl: this.page?.url() ?? this.lineupsUrl,
    });
    return { status: this.getStatus(), matches, leagues: selected };
  }

  private async closeModal(page: Page): Promise<void> {
    const modal = page
      .locator("[data-modal-content], .mantine-Modal-content")
      .first();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await modal.isVisible().catch(() => false))) break;
      const close = page
        .locator(
          '[data-modal-content] button[aria-label*="Close" i], .mantine-Modal-close, [data-modal-content] button:has-text("Close")',
        )
        .first();
      if (await close.isVisible().catch(() => false)) {
        await close.click({ timeout: 3_000 }).catch(() => {});
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
      await sleep(350);
    }
    await page.keyboard.press("Escape").catch(() => {});
    await page
      .locator(".mantine-Modal-overlay, [data-modal-overlay], .mantine-Modal-content")
      .first()
      .waitFor({ state: "hidden", timeout: 2_500 })
      .catch(() => {});
  }

  /**
   * Capture pitch + Bench + DNP (full) and green pitch only.
   * Hides Comments / Starting % Key / other chrome. Bench unlabeled → 10%, DNP → out (JSON).
   */
  private async screenshotFullModal(
    page: Page,
    modal: ReturnType<Page["locator"]>,
    filePath: string,
    greenFilePath: string,
  ): Promise<{
    pitch: string;
    pitchCards: string[];
    bench: string;
    dnp: string;
    notes: {
      teamAnalysis: string;
      injuriesAndRecovery: string;
      suspensionsAndIneligibilities: string;
    };
  }> {
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    let sectionText = {
      pitch: "",
      pitchCards: [] as string[],
      bench: "",
      dnp: "",
      notes: {
        teamAnalysis: "",
        injuriesAndRecovery: "",
        suspensionsAndIneligibilities: "",
      },
    };

    this.setStatus({
      state: "running",
      message: "Scrolling popup for Bench / DNP / % labels…",
      currentUrl: page.url(),
    });

    await this.scrollToLoadLazyContent(page, {
      message: "Scrolling popup to the bottom to load Bench / DNP / %…",
      rootSelector: "[data-modal-content], .mantine-Modal-content",
    });
    await this.waitForModalLoadersGone(modal, 20_000);
    await this.ensureBenchDnpVisible(modal);
    await this.scrollToLoadLazyContent(page, {
      message: "Re-scrolling popup after Bench / DNP mounted…",
      rootSelector: "[data-modal-content], .mantine-Modal-content",
    });
    await this.waitForModalLoadersGone(modal, 20_000);
    await modal.evaluate(`(root) => {
      for (const el of window.__siModalScrollers || []) {
        try { el.scrollTop = 0; } catch (_) {}
      }
      try { delete window.__siModalScrollers; } catch (_) {}
      try { root.scrollTop = 0; } catch (_) {}
    }`);
    await sleep(300);

    // Prepare hides body siblings (visibility:hidden). Any throw after that
    // MUST hit the finally restore — otherwise the lineups list stays invisible
    // and every later side fails with "accordion not mounted".
    try {
      const prepared = (await page.evaluate(SI_PREPARE_MODAL_SCRIPT)) as {
        modal?: { width: number; height: number };
        hasPitch?: boolean;
        hasBench?: boolean;
        hasDnp?: boolean;
        pctInModal?: number;
        sample?: unknown;
        error?: string;
      };

      if (!prepared || prepared.error || !prepared.modal?.width) {
        throw new Error(`Could not prepare modal: ${JSON.stringify(prepared)}`);
      }
      if (!prepared.hasPitch) {
        throw new Error(
          `Could not locate green formation pitch` +
            ` (modal % labels=${prepared.pctInModal ?? 0}` +
            `, candidates=${JSON.stringify(prepared.sample ?? [])})`,
        );
      }

      // Do NOT setViewportSize here. Growing the viewport remounts SorareInside
      // modals (esp. Türkiye Süper Lig) as an empty title shell → remark fails
      // with no-tight-green / pctInModal=0. Element screenshots capture the
      // prepared modal even when taller than the current viewport.
      await page.evaluate(`(() => {
        const root = document.querySelector("[data-si-modal], [data-modal-content], .mantine-Modal-content");
        if (!(root instanceof HTMLElement)) return;
        root.setAttribute("data-si-modal", "1");
        root.style.setProperty("position", "fixed", "important");
        root.style.setProperty("top", "0", "important");
        root.style.setProperty("left", "0", "important");
        root.style.setProperty("transform", "none", "important");
      })()`);

      await page.evaluate(`(() => {
        const root = document.querySelector("[data-si-modal]");
        if (!root) return Promise.resolve();
        const imgs = Array.from(root.querySelectorAll("img"));
        return Promise.all(
          imgs.map((img) => {
            if (img.complete && img.naturalWidth > 0) return null;
            return new Promise((resolve) => {
              const done = () => resolve(null);
              img.addEventListener("load", done, { once: true });
              img.addEventListener("error", done, { once: true });
              setTimeout(done, 2500);
            });
          }),
        );
      })()`);
      await sleep(400);
      await this.waitForModalLoadersGone(modal, 15_000);

      let remarked = (await page.evaluate(SI_REMARK_PITCH_SCRIPT)) as {
        ok: boolean;
        reason?: string;
        pctInModal?: number;
        sample?: Array<Record<string, unknown>>;
        width?: number;
        height?: number;
        pct?: number;
        hasBench?: boolean;
        hasDnp?: boolean;
      };

      if (!remarked?.ok) {
        await sleep(600);
        remarked = (await page.evaluate(SI_REMARK_PITCH_SCRIPT)) as typeof remarked;
      }

      // Prepare already marked data-si-pitch; if remark fails but the mark
      // survived (no remount), keep going with the prepared pitch.
      if (!remarked?.ok) {
        const pitched = await page.locator("[data-si-pitch]").count().catch(() => 0);
        if (pitched > 0) {
          const box = await page
            .locator("[data-si-pitch]")
            .first()
            .boundingBox()
            .catch(() => null);
          remarked = {
            ok: true,
            width: box ? Math.round(box.width) : prepared.modal.width,
            height: box ? Math.round(box.height) : prepared.modal.height,
            pct: prepared.pctInModal ?? 0,
            hasBench: Boolean(prepared.hasBench),
            hasDnp: Boolean(prepared.hasDnp),
          };
        }
      }

      if (!remarked?.ok) {
        await page
          .screenshot({
            path: resolve(projectRoot, "data/sorare/debug-modal-pitch.png"),
            type: "png",
            animations: "disabled",
          })
          .catch(() => {});
        const modalSample = await modal
          .innerText()
          .then((t) => t.replace(/\s+/g, " ").trim().slice(0, 400))
          .catch(() => "");
        await writeFile(
          resolve(projectRoot, "data/sorare/debug-modal-pitch.json"),
          `${JSON.stringify(
            {
              remarked,
              prepared,
              modalSample,
              at: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
        ).catch(() => {});
        throw new Error(
          `Could not locate green formation pitch after layout settle` +
            (remarked?.reason ? ` (${remarked.reason}` : "") +
            (remarked?.pctInModal != null
              ? `, modal % labels=${remarked.pctInModal}`
              : "") +
            (remarked?.sample
              ? `, candidates=${JSON.stringify(remarked.sample)}`
              : "") +
            (remarked?.reason ? ")" : ""),
        );
      }

      await sleep(500);

      // Grab % text BEFORE screenshots — React often clears data-si-* marks
      // during Playwright screenshot / layout thrash, leaving PNGs OK but JSON empty.
      const readSections = async () => {
        const raw = (await page
          .evaluate(SI_EXTRACT_SECTION_TEXT_SCRIPT)
          .catch(() => null)) as {
          pitch?: string;
          pitchCards?: string[];
          bench?: string;
          dnp?: string;
          notes?: {
            teamAnalysis?: string;
            injuriesAndRecovery?: string;
            suspensionsAndIneligibilities?: string;
          };
        } | null;
        return {
          pitch: raw?.pitch || "",
          pitchCards: Array.isArray(raw?.pitchCards) ? raw!.pitchCards! : [],
          bench: raw?.bench || "",
          dnp: raw?.dnp || "",
          notes: {
            teamAnalysis: raw?.notes?.teamAnalysis || "",
            injuriesAndRecovery: raw?.notes?.injuriesAndRecovery || "",
            suspensionsAndIneligibilities:
              raw?.notes?.suspensionsAndIneligibilities || "",
          },
        };
      };
      sectionText = await readSections();
      const sectionsWeak =
        sectionText.pitchCards.length < 8 ||
        (!sectionText.bench.trim() && !sectionText.dnp.trim());
      if (sectionsWeak) {
        await page.evaluate(SI_REMARK_PITCH_SCRIPT).catch(() => null);
        await sleep(200);
        const retry = await readSections();
        if (
          retry.pitchCards.length > sectionText.pitchCards.length ||
          (retry.bench.trim() && !sectionText.bench.trim()) ||
          (retry.dnp.trim() && !sectionText.dnp.trim())
        ) {
          sectionText = retry;
        }
      }

      this.setStatus({
        state: "running",
        message:
          `Capturing pitch` +
          (remarked.hasBench ? " + Bench" : "") +
          (remarked.hasDnp ? " + DNP" : "") +
          ` (${remarked.width}x${remarked.height})…`,
        currentUrl: page.url(),
      });

      // Re-mark right before shots — layout settle can wipe attributes.
      await page.evaluate(SI_REMARK_PITCH_SCRIPT).catch(() => null);
      await sleep(150);

      const modalShot = page.locator("[data-si-modal]").first();
      await modalShot.waitFor({ state: "visible", timeout: 10_000 });
      await mkdir(dirname(filePath), { recursive: true });
      await modalShot.screenshot({
        path: filePath,
        type: "png",
        animations: "disabled",
        timeout: 20_000,
      });

      await page.evaluate(SI_REMARK_PITCH_SCRIPT).catch(() => null);
      const pitchShot = page.locator("[data-si-pitch]").first();
      if ((await pitchShot.count()) < 1) {
        throw new Error(
          "Could not locate green formation pitch (data-si-pitch) inside the popup.",
        );
      }
      await mkdir(dirname(greenFilePath), { recursive: true });
      // Prefer a viewport clip that reaches up to the club title above the pitch.
      // Only when the full clip fits the current viewport — otherwise element
      // screenshot (pitch may sit below the fold after prepare layout).
      const greenClip = (await page
        .evaluate(SI_GREEN_CLIP_SCRIPT)
        .catch(() => null)) as {
        ok?: boolean;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        titleIncluded?: boolean;
      } | null;
      const vp = page.viewportSize() ?? { width: 1280, height: 720 };
      const clipFits =
        greenClip?.ok &&
        greenClip.x != null &&
        greenClip.y != null &&
        greenClip.width != null &&
        greenClip.height != null &&
        greenClip.width >= 80 &&
        greenClip.height >= 120 &&
        greenClip.x >= 0 &&
        greenClip.y >= 0 &&
        greenClip.x + greenClip.width <= vp.width + 1 &&
        greenClip.y + greenClip.height <= vp.height + 1;
      if (clipFits) {
        await page.screenshot({
          path: greenFilePath,
          type: "png",
          animations: "disabled",
          timeout: 20_000,
          clip: {
            x: Math.floor(greenClip!.x!),
            y: Math.floor(greenClip!.y!),
            width: Math.ceil(greenClip!.width!),
            height: Math.ceil(greenClip!.height!),
          },
        });
      } else {
        await pitchShot.screenshot({
          path: greenFilePath,
          type: "png",
          animations: "disabled",
          timeout: 20_000,
        });
      }
    } finally {
      // Restore first — prepare() hides body siblings with visibility:hidden.
      // Closing the modal before restore can leave the lineups list invisible
      // for the next home/away capture (accordion "not mounted").
      await page
        .evaluate(`(() => {
          if (typeof window.__siRestoreModalStyles === "function") {
            window.__siRestoreModalStyles();
          }
          try { delete window.__siRestoreModalStyles; } catch (_) {}
          // Safety: unhide any body children left invisible by a failed restore.
          for (const child of Array.from(document.body.children)) {
            if (!(child instanceof HTMLElement)) continue;
            if (child.style.getPropertyValue("visibility") === "hidden") {
              child.style.removeProperty("visibility");
            }
            if (child.style.getPropertyValue("display") === "none" &&
                /mantine-Modal|modal-overlay|Overlay/i.test(child.className || "")) {
              child.remove();
            }
          }
          // Drop leftover modal overlays that block LINEUPS clicks.
          for (const el of document.querySelectorAll(
            ".mantine-Modal-overlay, [data-modal-overlay], .mantine-Modal-root",
          )) {
            if (el instanceof HTMLElement) el.remove();
          }
        })()`)
        .catch(() => {});
      const current = page.viewportSize();
      if (
        current &&
        (current.width !== viewport.width || current.height !== viewport.height)
      ) {
        await page.setViewportSize(viewport).catch(() => {});
      }
      await this.closeModal(page).catch(() => {});
    }
    return sectionText;
  }

  /** Scroll until Bench Players / DNP headings mount (lazy lists). */
  private async ensureBenchDnpVisible(
    modal: ReturnType<Page["locator"]>,
  ): Promise<void> {
    const deadline = Date.now() + 15_000;
    let pass = 0;
    while (Date.now() < deadline) {
      const bench = await modal.getByText(/Bench Players/i).count().catch(() => 0);
      const dnp = await modal.getByText(/DNP Players/i).count().catch(() => 0);
      if (bench > 0 && dnp > 0) {
        this.setStatus({
          state: "running",
          message: "Bench + DNP sections loaded",
          currentUrl: this.page?.url() ?? null,
        });
        return;
      }
      await this.scrollModalContent(modal, { reset: pass % 2 === 1 });
      pass += 1;
      await sleep(350);
    }
    this.setStatus({
      state: "running",
      message:
        "Scroll did not reveal Bench + DNP after 15s. Capturing currently loaded popup content.",
      currentUrl: this.page?.url() ?? null,
    });
  }

  /**
   * Step-scroll window + overflow panes (or a modal root) so infinite-scroll
   * content mounts. Stops when height is stable AND panes are at the bottom,
   * or when `untilText` is visible. Finite: warns via status if it never settles.
   */
  private async scrollToLoadLazyContent(
    page: Page,
    options: {
      message: string;
      rootSelector?: string;
      untilText?: string;
      untilOpponent?: string;
      untilCheck?: () => Promise<boolean>;
      requireUntil?: boolean;
      untilMissError?: string;
      maxPasses?: number;
    },
  ): Promise<boolean> {
    const maxPasses = options.maxPasses ?? 40;
    const rootSelector = options.rootSelector ?? "";
    this.setStatus({
      state: "running",
      message: options.message,
      currentUrl: page.url(),
    });

    const untilText = options.untilText?.trim() || "";
    const hasUntil = Boolean(untilText || options.untilCheck);
    const untilReached = async (): Promise<boolean> => {
      if (untilText) {
        return this.lineupsTeamCardPresent(
          page,
          untilText,
          options.untilOpponent,
        );
      }
      if (options.untilCheck) return options.untilCheck();
      return false;
    };
    const failIfRequired = (detail: string): never => {
      throw new Error(options.untilMissError || detail);
    };

    const stepScript = `() => {
      const rootSel = ${JSON.stringify(rootSelector)};
      const scope = rootSel ? document.querySelector(rootSel) : document;
      if (!scope) return { height: 0, remaining: 0 };
      const nodes = [];
      const seen = new Set();
      const add = (el) => {
        if (!(el instanceof HTMLElement) || seen.has(el)) return;
        seen.add(el);
        nodes.push(el);
      };
      if (scope instanceof Document) {
        add(document.scrollingElement);
        add(document.documentElement);
        add(document.body);
      } else {
        add(scope);
      }
      const searchRoot = scope instanceof Document ? document : scope;
      for (const el of searchRoot.querySelectorAll(
        ".mantine-ScrollArea-viewport, .mantine-Modal-body, [data-radix-scroll-area-viewport]",
      )) {
        add(el);
      }
      let scanned = 0;
      for (const el of searchRoot.querySelectorAll("*")) {
        if (++scanned > 200) break;
        if (!(el instanceof HTMLElement)) continue;
        const cs = getComputedStyle(el);
        if (
          /(auto|scroll)/.test(cs.overflowY) &&
          el.scrollHeight > el.clientHeight + 8
        ) {
          add(el);
        }
      }
      let maxHeight = 0;
      let remaining = 0;
      for (const el of nodes) {
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const step = Math.max(180, Math.floor(el.clientHeight * 0.85) || 180);
        el.scrollTop = Math.min(max, el.scrollTop + step);
        maxHeight = Math.max(maxHeight, el.scrollHeight);
        remaining = Math.max(remaining, max - el.scrollTop);
      }
      if (scope instanceof Document) {
        window.scrollBy(0, Math.max(window.innerHeight * 0.85, 400));
        remaining = Math.max(
          remaining,
          Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
          ) - (window.scrollY + window.innerHeight),
        );
      }
      return {
        height: Math.max(
          maxHeight,
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
        ),
        remaining,
      };
    }`;

    let lastHeight = 0;
    let stable = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      if (hasUntil && (await untilReached())) {
        this.setStatus({
          state: "running",
          message: untilText
            ? `Found ${untilText} after scrolling.`
            : options.message,
          currentUrl: page.url(),
        });
        return true;
      }
      const result = await evaluateTimed<{
        height: number;
        remaining: number;
      }>(page, stepScript, 8_000);
      await sleep(350);
      const height = result?.height ?? 0;
      const remaining = result?.remaining ?? 0;
      const atBottom = remaining <= 8;
      if (height <= lastHeight && atBottom) {
        stable += 1;
        if (stable >= 2 && pass >= 2) {
          if (hasUntil) {
            if (await untilReached()) return true;
            const miss = untilText
              ? `Scroll settled but "${untilText}" is not on the expanded lineups list.`
              : "Scroll settled but the target was not found on the lineups list.";
            if (options.requireUntil) failIfRequired(miss);
            console.warn(`[sorare-inside] ${miss} Continuing anyway.`);
            this.setStatus({
              state: "running",
              message: miss,
              currentUrl: page.url(),
            });
            return false;
          }
          return true;
        }
      } else {
        stable = 0;
        lastHeight = Math.max(lastHeight, height);
      }
    }

    const warn = untilText
      ? `Scroll did not settle after ${maxPasses} passes (height=${lastHeight}); "${untilText}" is not on the expanded lineups list.`
      : `Scroll did not settle after ${maxPasses} passes (height=${lastHeight}).`;
    if (options.requireUntil) failIfRequired(warn);
    console.warn(`[sorare-inside] ${warn} Continuing anyway.`);
    this.setStatus({
      state: "running",
      message: `${warn} Continuing anyway.`,
      currentUrl: page.url(),
    });
    return false;
  }

  /**
   * Step-scroll the lineups page (window + overflow panes) so lazy match rows
   * mount before screenshot capture starts.
   */
  private async scrollLineupsPageToLoadAll(page: Page): Promise<void> {
    await this.scrollToLoadLazyContent(page, {
      message: "Scrolling lineups to the bottom to load all matches…",
    });
  }

  /**
   * Incrementally scroll every overflow container inside the modal so lazy
   * lineup/% content mounts without waiting for a human to drag the scrollbar.
   */
  private async scrollModalContent(
    modal: ReturnType<Page["locator"]>,
    options: { reset?: boolean } = {},
  ): Promise<void> {
    const reset = options.reset !== false;
    await Promise.race([
      modal.evaluate(`(root) => {
      const scrollers = [];
      const consider = (el) => {
        if (!(el instanceof HTMLElement)) return;
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2) {
          scrollers.push(el);
        }
      };
      consider(root);
      for (const node of root.querySelectorAll("*")) consider(node);
      if (!scrollers.length) scrollers.push(root);
      window.__siModalScrollers = scrollers;
      for (const el of scrollers) {
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        if (max <= 0) continue;
        const step = Math.max(120, Math.floor(el.clientHeight * 0.7));
        el.scrollTop = Math.min(max, el.scrollTop + step);
      }
    }`),
      sleep(8_000).then(() => {
        throw new Error("modal scroll evaluate timed out after 8000ms");
      }),
    ]);
    await sleep(450);
    if (reset) {
      await modal.evaluate(`(root) => {
        for (const el of window.__siModalScrollers || []) {
          try { el.scrollTop = 0; } catch (_) {}
        }
        try { delete window.__siModalScrollers; } catch (_) {}
        try { root.scrollTop = 0; } catch (_) {}
      }`);
    }
  }

  /** Wait until no Mantine loaders remain inside the modal. */
  private async waitForModalLoadersGone(
    modal: ReturnType<Page["locator"]>,
    timeoutMs: number,
  ): Promise<void> {
    const loader = modal.locator(SI_SPINNER_SELECTOR);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const visible = await loader
        .first()
        .isVisible()
        .catch(() => false);
      if (!visible) {
        await sleep(300);
        const again = await loader
          .first()
          .isVisible()
          .catch(() => false);
        if (!again) return;
      }
      await sleep(250);
    }
  }

  /**
   * After the match/team modal is open, wait until the green Mantine loader is
   * gone AND lineup content (probability % labels) is present — not just the
   * "Team vs Team" header.
   *
   * Important: reliability RingProgress chips in the modal chrome also contain
   * "NN%" text. Requiring only ≥3 % labels false-positives on an empty body
   * (Türkiye Süper Lig shell with title + reliability rings, no pitch).
   */
  private async waitForModalLineupLoaded(page: Page): Promise<void> {
    const modal = page.locator("[data-modal-content], .mantine-Modal-content").first();
    await modal.waitFor({ state: "visible", timeout: 20_000 });

    this.setStatus({
      state: "running",
      message: "Scrolling lineup popup to load % labels…",
      currentUrl: page.url(),
    });

    await this.scrollToLoadLazyContent(page, {
      message: "Scrolling lineup popup to the bottom to load all content…",
      rootSelector: "[data-modal-content], .mantine-Modal-content",
      maxPasses: 16,
    });

    const percentLabels = modal.getByText(/\d{1,3}\s*%/);
    const bench = modal.getByText(/Bench Players/i);
    const deadline = Date.now() + 35_000;
    let pass = 0;
    while (Date.now() < deadline) {
      const percentCount = await percentLabels.count().catch(() => 0);
      const hasBench = (await bench.count().catch(() => 0)) > 0;
      const bodyPctRaw = await modal
        .evaluate(`(root) => {
          if (!root) return { headerPct: 0, bodyPct: 0, hasPitchWord: false, bodyLen: 0 };
          const header = root.querySelector(".mantine-Modal-header");
          const textOf = (el) => String(el?.innerText || el?.textContent || "");
          const headerText = header ? textOf(header) : "";
          const all = textOf(root);
          const body = headerText && all.startsWith(headerText)
            ? all.slice(headerText.length)
            : all;
          const headerPct = (headerText.match(/\\b\\d{1,3}\\s*%/g) || []).length;
          const bodyPct = (body.match(/\\b\\d{1,3}\\s*%/g) || []).length;
          const hasPitchWord = /RELIABILITY|SorareInside/i.test(body) && bodyPct >= 5;
          return {
            headerPct,
            bodyPct,
            hasPitchWord,
            bodyLen: body.replace(/\\s+/g, " ").trim().length,
          };
        }`)
        .catch(() => null);
      const bodyPct = bodyPctRaw ?? {
        headerPct: 0,
        bodyPct: 0,
        hasPitchWord: false,
        bodyLen: 0,
      };
      // Real lineup: Bench section, enough % outside the header chrome, or a
      // dense % count (Bayern/Union often leave a spinner chip while 30+ %
      // labels are already painted — bodyPct evaluate can also return null).
      if (
        hasBench ||
        (bodyPct.bodyPct >= 8 && bodyPct.bodyLen >= 200) ||
        percentCount >= 11
      ) {
        await sleep(300);
        return;
      }
      await this.scrollModalContent(modal, { reset: pass % 3 === 2 });
      pass += 1;
      await sleep(280);
    }

    const stillLoading = await modal
      .locator(SI_SPINNER_SELECTOR)
      .first()
      .isVisible()
      .catch(() => false);
    const percentCount = await percentLabels.count().catch(() => 0);
    const bodyHint = await modal
      .innerText()
      .then((t) => t.replace(/\s+/g, " ").trim().slice(0, 160))
      .catch(() => "");
    throw new Error(
      stillLoading
        ? `Timed out after 35s: lineup popup still shows a spinner (found ${percentCount} % label(s)).`
        : `Timed out after 35s waiting for lineup content in popup (found ${percentCount} probability label(s); need Bench Players or ≥8 body % labels). Modal: ${bodyHint}`,
    );
  }

  private async openLineupPopup(
    page: Page,
    match: SorareInsideMatch,
    side: "home" | "away",
  ): Promise<void> {
    const team = side === "home" ? match.home : match.away;
    if (!team.lineupId) {
      throw new Error(`No lineup published for ${team.teamName}.`);
    }

    await this.closeModal(page);

    const opponent = side === "home" ? match.away : match.home;
    const league = this.leagues.find((item) => item.id === match.leagueId);
    await this.clickMatchOnLineupsList(page, team.teamName, {
      opponentName: opponent.teamName,
      leagueName: league?.competitionName ?? match.leagueLabel,
    });

    await this.waitForModalLineupLoaded(page);
  }

  /** True when a visible club name anchor is mounted on the expanded list. */
  private async lineupsTeamCardPresent(
    page: Page,
    teamName: string,
    _opponentName?: string,
  ): Promise<boolean> {
    try {
      const found = await evaluateTimed<{ ok?: boolean }>(
        page,
        this.lineupsTeamCardScript(teamName, "find"),
        8_000,
      );
      return Boolean(found?.ok);
    } catch {
      return false;
    }
  }

  /**
   * After a league chevron expand, late fixtures (Monza, Sassuolo, …) often sit
   * below the fold / outside the virtualized window. Scroll before failing.
   */
  private async waitForTeamInExpandedList(
    page: Page,
    teamName: string,
    opponentName: string | undefined,
    label: string,
  ): Promise<boolean> {
    if (await this.lineupsTeamCardPresent(page, teamName, opponentName)) {
      return true;
    }
    // Start near the competition region so we don't scroll Argentina forever.
    if (/italy/i.test(label)) {
      const heading = page.getByText("Italy", { exact: true }).first();
      if (await heading.count().catch(() => 0)) {
        await heading.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(200);
        await page.mouse.wheel(0, 180).catch(() => {});
        await sleep(200);
      }
    }
    // Coarse mouse-wheel scan: overflow-pane step scrolling often settles inside
    // a prior region (Argentina) before Serie A late fixtures enter the viewport.
    for (let pass = 0; pass < 40; pass += 1) {
      if (await this.lineupsTeamCardPresent(page, teamName, opponentName)) {
        return true;
      }
      // Off-screen club nodes still match — scroll them into view.
      const scrolled = await evaluateTimed<{ ok?: boolean }>(
        page,
        `(() => {
          const match = ${LINEUP_TEAM_LABELS_MATCH_SOURCE};
          const skipSel =
            "[data-combobox-option], [data-combobox-dropdown], [role='combobox']";
          for (const el of document.querySelectorAll(
            "a.mantine-Anchor-root, p.mantine-Text-root",
          )) {
            if (el.closest(skipSel)) continue;
            const t = String(el.innerText || el.textContent || "")
              .replace(/\\s+/g, " ")
              .trim();
            if (!t || t.length > 80 || !match(t, ${JSON.stringify(teamName)})) {
              continue;
            }
            const target = el.closest("a.mantine-Anchor-root") || el;
            if (target.scrollIntoView) {
              target.scrollIntoView({ block: "center", inline: "nearest" });
            }
            return { ok: true };
          }
          return { ok: false };
        })()`,
        6_000,
      ).catch(() => null);
      if (scrolled?.ok) {
        await sleep(250);
        if (await this.lineupsTeamCardPresent(page, teamName, opponentName)) {
          return true;
        }
      }
      await page.mouse.wheel(0, 900).catch(() => {});
      await sleep(220);
    }
    await this.scrollToLoadLazyContent(page, {
      message: `Scrolling expanded ${label} for ${teamName}…`,
      untilText: teamName,
      untilOpponent: opponentName,
      requireUntil: false,
      maxPasses: 16,
    }).catch(() => {});
    return this.lineupsTeamCardPresent(page, teamName, opponentName);
  }

  /**
   * Click `a.mantine-Anchor-root` for the club (live Championship DOM).
   * Never uses the header Select / hidden combobox options.
   */
  private lineupsTeamCardScript(
    teamName: string,
    mode: "find" | "click",
  ): string {
    return `(() => {
      const find = ${LINEUP_CLUB_FIND_SOURCE};
      return find(${JSON.stringify(teamName)}, ${JSON.stringify(mode)}, true);
    })()`;
  }

  private teamNameClickVariants(teamName: string): string[] {
    const raw = teamName.trim();
    const folded = raw
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ı/g, "i")
      .replace(/İ/g, "i");
    const noFc = raw.replace(/\s+(fc|afc|cf|sc)\.?$/i, "").trim();
    const stripped = folded
      .replace(/^\d+\.\s*/i, "")
      .replace(/\b(fc|afc|cf|sc|sv|tsg|fsv)\b\.?/gi, " ")
      .replace(/\bsport-?club\b/gi, " ")
      .replace(/\b(kul[uü]b[uü]|spor|futbol|jimnastik)\b/gi, " ")
      .replace(/\b\d{2,4}\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = stripped.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    const add = (value: string) => {
      const t = value.trim();
      if (t.length < 4) return;
      if (!out.some((item) => item.toLowerCase() === t.toLowerCase())) out.push(t);
    };
    add(raw);
    add(folded);
    add(noFc);
    add(stripped);
    if (words.length >= 2) add(words.slice(-2).join(" "));
    if (words.length >= 1) add(words[words.length - 1] || "");
    return out;
  }

  /** Click the match row that contains the club. Never uses team search. */
  private async clickMatchOnLineupsList(
    page: Page,
    teamName: string,
    options: { opponentName?: string; leagueName?: string } = {},
  ): Promise<void> {
    this.setStatus({
      state: "running",
      message: `Clicking ${teamName} on the lineups list…`,
      currentUrl: page.url(),
    });

    const present = await this.lineupsTeamCardPresent(
      page,
      teamName,
      options.opponentName,
    );
    const clubDump = await evaluateTimed<{
      hit?: { ok?: boolean; text?: string | null; tag?: string | null; cls?: string | null };
      anchors?: string[];
    }>(
      page,
      `(() => {
        const find = ${LINEUP_CLUB_FIND_SOURCE};
        const hit = find(${JSON.stringify(teamName)}, "find", false);
        const skipSel =
          "[data-combobox-option], [data-combobox-dropdown], [role='combobox']";
        const anchors = [];
        for (const el of document.querySelectorAll("a.mantine-Anchor-root")) {
          if (el.closest(skipSel)) continue;
          const t = String(el.innerText || el.textContent || "")
            .replace(/\\s+/g, " ")
            .trim();
          if (t && t.length <= 80) anchors.push(t);
          if (anchors.length >= 24) break;
        }
        return { hit, anchors };
      })()`,
      8_000,
    ).catch(() => null);
    await writeFile(
      resolve(projectRoot, "data/sorare/debug-club-hit.json"),
      `${JSON.stringify(
        { teamName, present, dump: clubDump, at: new Date().toISOString() },
        null,
        2,
      )}\n`,
    ).catch(() => {});
    if (!present) {
      const league = options.leagueName ? ` in ${options.leagueName}` : "";
      const visible = clubDump?.anchors?.length
        ? ` Visible clubs: ${clubDump.anchors.join(" · ")}.`
        : " No visible a.mantine-Anchor-root clubs.";
      throw new Error(
        `No clickable "${teamName}" match on the lineups list${league} after expanding the league.${visible}`,
      );
    }

    const modal = page
      .locator("[data-modal-content], .mantine-Modal-content")
      .first();
    for (let attempt = 0; attempt < 4; attempt++) {
      const clicked = await this.clickVisibleMatchRow(page, teamName, options.opponentName);
      if (!clicked) {
        await evaluateTimed<{ ok?: boolean }>(
          page,
          this.lineupsTeamCardScript(teamName, "click"),
          8_000,
        ).catch(() => false);
      }
      await sleep(attempt === 0 ? 500 : 700 + attempt * 150);
      if (await modal.isVisible().catch(() => false)) return;

      // Some Bundesliga cards (esp. tonight's Bayern row) ignore the club
      // Anchor — click the surrounding `_game_` / vs-row container instead.
      if (attempt >= 1) {
        const rowClicked = await evaluateTimed<{ ok?: boolean }>(
          page,
          `(() => {
            const labelsMatch = ${LINEUP_TEAM_LABELS_MATCH_SOURCE};
            const skipSel =
              "[data-combobox-option], [data-combobox-dropdown], [role='combobox']";
            const want = ${JSON.stringify(teamName)};
            const opp = ${JSON.stringify(options.opponentName || "")};
            const textOf = (el) =>
              String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
            let best = null;
            for (const el of document.querySelectorAll(
              "div[class*='_game_'], div.mantine-Stack-root, article, section, li",
            )) {
              if (el.closest(skipSel)) continue;
              const t = textOf(el);
              if (!t || t.length > 500) continue;
              if (!labelsMatch(t, want)) continue;
              if (opp && !labelsMatch(t, opp) && !t.toLowerCase().includes(opp.toLowerCase().slice(0, 10))) {
                continue;
              }
              const r = el.getBoundingClientRect();
              if (r.width < 80 || r.height < 40 || r.height > 420) continue;
              if (r.bottom < 8 || r.top > (window.innerHeight || 800) - 8) continue;
              best = el;
              break;
            }
            if (!best) return { ok: false };
            best.scrollIntoView({ block: "center", inline: "nearest" });
            const btn = best.querySelector(
              "button.mantine-Button-root, button[type='button']",
            );
            const target = btn || best;
            if (typeof target.click === "function") target.click();
            return { ok: true };
          })()`,
          8_000,
        ).catch(() => null);
        if (rowClicked?.ok) {
          await sleep(800);
          if (await modal.isVisible().catch(() => false)) return;
        }
      }

      // Previous capture can leave overlay / collapsed row — Escape + reclick.
      await this.closeModal(page);
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(300);
    }
    throw new Error(
      `Clicked "${teamName}" on the lineups list but the lineup popup did not open.`,
    );
  }

  /** Click the visible club `a.mantine-Anchor-root`, never a hidden Select option. */
  private async clickVisibleMatchRow(
    page: Page,
    teamName: string,
    opponentName?: string,
  ): Promise<boolean> {
    const labels = this.teamNameClickVariants(teamName);
    for (const label of labels) {
      let anchor = page
        .locator("a.mantine-Anchor-root")
        .filter({ hasNot: page.locator("xpath=ancestor::*[@data-combobox-option]") })
        .filter({ hasText: label })
        .locator("visible=true");
      // Prefer the match row that also shows the opponent (home+away pair).
      if (opponentName) {
        const withOpponent = page
          .locator("div, li, article, section, a")
          .filter({ hasText: label })
          .filter({ hasText: opponentName })
          .locator("a.mantine-Anchor-root")
          .filter({ hasText: label })
          .locator("visible=true")
          .first();
        if (await withOpponent.isVisible().catch(() => false)) {
          anchor = withOpponent;
        } else {
          anchor = anchor.first();
        }
      } else {
        anchor = anchor.first();
      }
      if (!(await anchor.isVisible().catch(() => false))) continue;
      await anchor.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(150);
      await anchor.click({ timeout: 4_000, force: true }).catch(async () => {
        await anchor.evaluate(`(el) => {
          if (!(el instanceof HTMLElement)) return;
          el.scrollIntoView({ block: "center", inline: "nearest" });
          el.click();
        }`);
      });
      return true;
    }
    return false;
  }

  /**
   * Prefer region-qualified labels. Never OR bare "Serie A" with "Italy - Serie A"
   * — that makes `.first()` expand Brazil before Italy (same for Premier League, etc.).
   */
  private leagueAccordionNeedles(league: SorareInsideLeague): string[] {
    const competition = league.competitionName.trim();
    const raw = [
      league.label,
      [league.regionName, competition].filter(Boolean).join(" - "),
      [league.regionName, competition].filter(Boolean).join(" "),
      competition,
    ];
    // Live German top-flight accordion is often "1. Bundesliga", not "Bundesliga".
    if (/^bundesliga$/i.test(competition)) {
      raw.push("1. Bundesliga");
      if (league.regionName.trim()) {
        raw.push(`${league.regionName.trim()} - 1. Bundesliga`);
      }
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      const t = item.trim();
      if (t.length < 4) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }

  private leagueAccordionFindScript(
    league: SorareInsideLeague,
    mode: "find" | "click",
  ): string {
    return `(() => {
      const find = ${LINEUP_ACCORDION_FIND_SOURCE};
      return find(
        ${JSON.stringify(league.competitionName)},
        ${JSON.stringify(league.regionName)},
        ${JSON.stringify(league.label)},
        ${JSON.stringify(mode)},
      );
    })()`;
  }

  private async findLeagueAccordionInPage(
    page: Page,
    league: SorareInsideLeague,
    mode: "find" | "click",
  ): Promise<{ ok: boolean; text?: string | null; count?: number } | null> {
    const competition = league.competitionName.trim();
    const region = league.regionName.trim();
    if (region) {
      const heading = page.getByText(region, { exact: true }).first();
      if (await heading.count()) {
        await heading.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(300);
        // Virtualized lists often mount the region label before the competition
        // / LINEUPS chip under it — small nudge so Süper Lig / 1. Bundesliga can
        // paint. Large wheels jump past Germany onto 2. BL or the next region.
        await page.mouse.wheel(0, 160).catch(() => {});
        await sleep(250);
      }
    }

    const cards = page
      .locator("button, [role='button']")
      .filter({ hasText: /\d+\s+LINEUPS/i })
      .filter({ hasText: competitionAccordionRegex(competition) });
    let n = await cards.count().catch(() => 0);
    if (!n) {
      n = await page.getByText(/\d+\s+LINEUPS/i).count().catch(() => 0);
    }
    let bestIndex = -1;
    let bestText: string | null = null;
    let bestY = Number.POSITIVE_INFINITY;
    let headingY = 0;
    if (region) {
      headingY =
        (await page.getByText(region, { exact: true }).first().boundingBox().catch(() => null))
          ?.y ?? 0;
    }

    const lineups = page.getByText(/\d+\s+LINEUPS/i);
    const lineupsN = await lineups.count().catch(() => 0);
    for (let i = 0; i < lineupsN; i += 1) {
      const loc = lineups.nth(i);
      const t = (
        (await loc
          .evaluate(
            `(el, competition) => {
              const fold = (s) => String(s || "").replace(/\\s+/g, " ").trim();
              const re = new RegExp(competition.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"), "i");
              let n = el;
              let short = "";
              let any = "";
              for (let i = 0; i < 10 && n; i++) {
                const s = fold(n.innerText || n.textContent || "");
                if (/LINEUPS/i.test(s) && re.test(s)) {
                  if (s.length >= 8 && s.length <= 220 && !short) short = s;
                  if (s.length >= 8 && !any) any = s.slice(0, 160);
                }
                // Compact label: competition on one sibling, LINEUPS on another
                // (Türkiye Süper Lig / similar).
                if (n.parentElement) {
                  const kids = [...n.parentElement.children].map((c) => fold(c.textContent || ""));
                  const joined = kids.filter(Boolean).join(" | ");
                  if (/LINEUPS/i.test(joined) && re.test(joined) && joined.length <= 220 && !short) {
                    short = joined;
                  }
                }
                const prev = n.previousElementSibling;
                if (prev && re.test(fold(prev.innerText || prev.textContent || ""))) {
                  const combo = fold(prev.innerText || prev.textContent || "") + " | " + s;
                  if (combo.length <= 220 && !short) short = combo;
                }
                const parentPrev = n.parentElement?.previousElementSibling;
                if (
                  parentPrev &&
                  re.test(fold(parentPrev.innerText || parentPrev.textContent || ""))
                ) {
                  const combo =
                    fold(parentPrev.innerText || parentPrev.textContent || "") + " | " + s;
                  if (combo.length <= 220 && !short) short = combo;
                }
                n = n.parentElement;
              }
              return short || any || fold(el.innerText || el.textContent || "");
            }`,
            competition,
          )
          .catch(() => "")) || ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (!t || t.length > 500) continue;
      if (!accordionTextMatchesCompetition(t, competition) && !t.toLowerCase().includes(competition.toLowerCase())) {
        continue;
      }
      if (
        /^bundesliga$/i.test(competition) &&
        /2\.\s*Bundesliga/i.test(t) &&
        !/1\.\s*Bundesliga/i.test(t)
      ) {
        continue;
      }
      const box = await loc.boundingBox().catch(() => null);
      const y = box?.y ?? 0;
      if (region && headingY && y < headingY - 8) continue;
      // Shared names (Serie A, Premier League, …): prefer the row under the
      // region heading. Without a heading Y, skip rows whose fold text names a
      // different region (otherwise Brazil "Serie A" wins over Italy).
      if (region && !headingY) {
        const fold = t.toLowerCase();
        const regionFold = region.toLowerCase();
        if (!fold.includes(regionFold)) {
          const otherRegion =
            /\b(brazil|italy|england|spain|germany|france|portugal|netherlands|belgium|turkey|argentina|usa|mexico|scotland)\b/i.exec(
              t,
            )?.[1];
          if (otherRegion && otherRegion.toLowerCase() !== regionFold) {
            continue;
          }
        }
      }
      // Prefer region-qualified text when several LINEUPS rows match.
      const regionBonus =
        region && t.toLowerCase().includes(region.toLowerCase()) ? -40 : 0;
      const rank = y + regionBonus;
      if (rank < bestY) {
        bestY = rank;
        bestIndex = i;
        bestText = t.slice(0, 120);
        if (region && headingY && y >= headingY && y < headingY + 280) break;
      }
    }

    if (bestIndex < 0 && (await cards.count().catch(() => 0)) === 1) {
      bestIndex = 0;
      bestText = ((await cards.first().innerText().catch(() => "")) || "").replace(/\s+/g, " ");
    }
    if (bestIndex < 0) {
      // Debug: dump every LINEUPS row text so we can see why Serie A missed.
      try {
        const samples: string[] = [];
        for (let i = 0; i < Math.min(lineupsN, 40); i += 1) {
          const raw = ((await lineups.nth(i).innerText().catch(() => "")) || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160);
          samples.push(raw);
        }
        await writeFile(
          resolve(projectRoot, "data/sorare/debug-lineups-rows.json"),
          `${JSON.stringify({ competition, region, headingY, samples }, null, 2)}\n`,
        );
      } catch {
        /* ignore */
      }

      // New lineups UI: the "20 LINEUPS" leaf often has no competition name in
      // its parent chain (name sits in a sibling column). Fall back to clicking
      // the competition title under the region heading (Italy → Serie A).
      if (region && competition) {
        if (!headingY) {
          const heading = page.getByText(region, { exact: true }).first();
          if (await heading.count().catch(() => 0)) {
            await heading.scrollIntoViewIfNeeded().catch(() => {});
            await sleep(250);
            headingY =
              (await heading.boundingBox().catch(() => null))?.y ?? 0;
          }
        }
        const titles = page.getByText(competition, { exact: true });
        // Exact often fails when the chip text is "Süper Lig Updated 2 hours ago".
        const looseTitles = page.getByText(competitionAccordionRegex(competition));
        const titleLocators = [titles, looseTitles];
        let bestTitleLoc: ReturnType<Page["locator"]> | null = null;
        let bestTitleY = Number.POSITIVE_INFINITY;
        for (const titleLoc of titleLocators) {
          const titleN = await titleLoc.count().catch(() => 0);
          for (let i = 0; i < titleN; i += 1) {
            const loc = titleLoc.nth(i);
            const label = ((await loc.innerText().catch(() => "")) || "")
              .replace(/\s+/g, " ")
              .trim();
            // Prefer short labels ("Süper Lig"), skip giant section blobs.
            if (!label || label.length > 64) continue;
            if (
              !accordionTextMatchesCompetition(label, competition) &&
              label.toLowerCase() !== competition.toLowerCase() &&
              !label.toLowerCase().startsWith(competition.toLowerCase())
            ) {
              continue;
            }
            const box = await loc.boundingBox().catch(() => null);
            if (!box) continue;
            if (headingY && box.y < headingY - 8) continue;
            if (headingY && box.y > headingY + 900) continue;
            if (box.y < bestTitleY) {
              bestTitleY = box.y;
              bestTitleLoc = loc;
            }
          }
          if (bestTitleLoc) break;
        }
        if (bestTitleLoc) {
          if (mode === "click") {
            await bestTitleLoc.scrollIntoViewIfNeeded().catch(() => {});
            await bestTitleLoc.click({ timeout: 4_000 }).catch(async () => {
              await bestTitleLoc!
                .click({ force: true, timeout: 4_000 })
                .catch(() => {});
            });
          }
          return {
            ok: true,
            text: `${region} - ${competition}`,
            count: 1,
          };
        }

        // Last resort: click the LINEUPS count nearest below the region heading
        // whose preceding sibling / row text mentions the competition.
        let bestLineup = -1;
        let bestLineupY = Number.POSITIVE_INFINITY;
        for (let i = 0; i < lineupsN; i += 1) {
          const loc = lineups.nth(i);
          const box = await loc.boundingBox().catch(() => null);
          if (!box) continue;
          if (headingY && box.y < headingY - 8) continue;
          if (headingY && box.y > headingY + 900) continue;
          const rowText = await loc
            .evaluate(
              `(el, competition) => {
                const fold = (s) => String(s || "").replace(/\\s+/g, " ").trim();
                const re = new RegExp(
                  competition.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"),
                  "i",
                );
                let n = el;
                for (let d = 0; d < 8 && n; d++) {
                  const kids = n.parentElement
                    ? [...n.parentElement.children].map((c) =>
                        fold(c.innerText || c.textContent || ""),
                      )
                    : [];
                  const joined = kids.filter(Boolean).join(" | ");
                  if (re.test(joined) || re.test(fold(n.innerText || ""))) {
                    return joined.slice(0, 200);
                  }
                  // Previous sibling column often holds "Serie A" / "Süper Lig".
                  const prev = n.previousElementSibling;
                  if (prev && re.test(fold(prev.innerText || prev.textContent || ""))) {
                    return fold(prev.innerText || prev.textContent || "");
                  }
                  const parentPrev = n.parentElement?.previousElementSibling;
                  if (
                    parentPrev &&
                    re.test(fold(parentPrev.innerText || parentPrev.textContent || ""))
                  ) {
                    return fold(parentPrev.innerText || parentPrev.textContent || "");
                  }
                  // Walk up one more: grandparent's previous sibling column.
                  const gp = n.parentElement?.parentElement;
                  const gpPrev = gp?.previousElementSibling;
                  if (
                    gpPrev &&
                    re.test(fold(gpPrev.innerText || gpPrev.textContent || ""))
                  ) {
                    return fold(gpPrev.innerText || gpPrev.textContent || "");
                  }
                  n = n.parentElement;
                }
                return "";
              }`,
              competition,
            )
            .catch(() => "");
          if (!rowText) continue;
          if (box.y < bestLineupY) {
            bestLineupY = box.y;
            bestLineup = i;
          }
        }
        if (bestLineup >= 0) {
          if (mode === "click") {
            const loc = lineups.nth(bestLineup);
            await loc.scrollIntoViewIfNeeded().catch(() => {});
            const clickable = loc
              .locator(
                "xpath=ancestor-or-self::button[1] | ancestor-or-self::*[@role='button'][1] | ancestor-or-self::a[1]",
              )
              .first();
            if (await clickable.count().catch(() => 0)) {
              await clickable.click({ timeout: 4_000 }).catch(async () => {
                await loc.click({ force: true, timeout: 4_000 }).catch(() => {});
              });
            } else {
              await loc.click({ force: true, timeout: 4_000 }).catch(() => {});
            }
          }
          return {
            ok: true,
            text: `${region} - ${competition}`,
            count: lineupsN,
          };
        }

        // Türkiye / similar: competition title + "18 LINEUPS" sit in sibling
        // columns so parent-text never contains "Süper Lig". Click the first
        // LINEUPS count just under the region heading.
        if (headingY) {
          // Region headers can sit well above the LINEUPS chip (subtitle /
          // "Updated …" rows). Keep a wider window for Türkiye / Germany
          // (1. + 2. Bundesliga cards under one region heading).
          const maxBelow = /t[uü]rk|german|ital/i.test(region) ? 900 : 420;
          let nearest = -1;
          let nearestY = Number.POSITIVE_INFINITY;
          for (let i = 0; i < lineupsN; i += 1) {
            const loc = lineups.nth(i);
            const box = await loc.boundingBox().catch(() => null);
            if (!box) continue;
            if (box.y < headingY - 8) continue;
            if (box.y > headingY + maxBelow) continue;
            if (box.y < nearestY) {
              nearestY = box.y;
              nearest = i;
            }
          }
          if (nearest >= 0) {
            if (mode === "click") {
              const loc = lineups.nth(nearest);
              await loc.scrollIntoViewIfNeeded().catch(() => {});
              // Prefer clicking the competition title in the same row band —
              // bare "18 LINEUPS" text often does not toggle the chevron.
              const titles = page.getByText(competition, { exact: true });
              const titleN = await titles.count().catch(() => 0);
              let clickedTitle = false;
              for (let ti = 0; ti < titleN; ti += 1) {
                const tLoc = titles.nth(ti);
                const tBox = await tLoc.boundingBox().catch(() => null);
                if (!tBox) continue;
                if (tBox.y < headingY - 8 || tBox.y > headingY + maxBelow) continue;
                if (Math.abs(tBox.y - nearestY) > 80) continue;
                await tLoc.click({ force: true, timeout: 4_000 }).catch(() => {});
                clickedTitle = true;
                break;
              }
              if (!clickedTitle) {
                const clickable = loc
                  .locator(
                    "xpath=ancestor-or-self::*[self::button or @role='button' or contains(@class,'Card') or contains(@class,'Accordion')][1]",
                  )
                  .first();
                if (await clickable.count().catch(() => 0)) {
                  await clickable.click({ force: true, timeout: 4_000 }).catch(async () => {
                    await loc.click({ force: true, timeout: 4_000 }).catch(() => {});
                  });
                } else {
                  await loc.click({ force: true, timeout: 4_000 }).catch(() => {});
                }
              }
            }
            return {
              ok: true,
              text: `${region} - ${competition}`,
              count: lineupsN,
            };
          }
        }
      }

      const script = this.leagueAccordionFindScript(league, mode);
      for (const frame of page.frames()) {
        const hit = (await frame.evaluate(script).catch(() => null)) as {
          ok?: boolean;
          text?: string | null;
          count?: number;
        } | null;
        if (hit?.ok) return hit;
      }
      return null;
    }
    if (mode === "click") {
      const loc = lineups.nth(bestIndex);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const clickable = loc
        .locator("xpath=ancestor-or-self::button[1] | ancestor-or-self::*[@role='button'][1]")
        .first();
      if (await clickable.count().catch(() => 0)) {
        await clickable.click({ timeout: 4_000 }).catch(async () => {
          await loc.click({ force: true, timeout: 4_000 }).catch(() => {});
        });
      } else {
        await loc.click({ timeout: 4_000 }).catch(async () => {
          await loc.click({ force: true, timeout: 4_000 }).catch(() => {});
        });
      }
    }
    return { ok: true, text: bestText, count: lineupsN };
  }

  private leagueAccordionItems(
    page: Page,
    league: SorareInsideLeague,
  ): ReturnType<Page["locator"]> {
    const competition = league.competitionName.trim();
    if (competition.length < 2) {
      return page.locator("[data-accordion-item], .mantine-Accordion-item").nth(-1);
    }
    // Exact title: "Bundesliga" must not match "Bundesliga 2" / "2. Bundesliga".
    const re = competitionAccordionRegex(competition);
    return page
      .locator("[data-accordion-item], .mantine-Accordion-item")
      .filter({ hasText: re });
  }

  private async accordionItemMatchesRegion(
    item: ReturnType<Page["locator"]>,
    league: SorareInsideLeague,
  ): Promise<boolean> {
    const region = league.regionName.trim();
    const code = league.regionCode.trim();
    if (!region && !code) return true;
    return item.evaluate(
      (el, hints: { region: string; code: string; label: string }) => {
        const hay = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
        if (hints.label && hay.includes(hints.label.toLowerCase())) return true;
        if (hints.region && hay.includes(hints.region.toLowerCase())) return true;
        for (const node of el.querySelectorAll("[aria-label], img, svg, [title]")) {
          const bits = [
            node.getAttribute("aria-label") || "",
            node.getAttribute("alt") || "",
            node.getAttribute("title") || "",
            node.getAttribute("src") || "",
            node.textContent || "",
          ]
            .join(" ")
            .toLowerCase();
          if (hints.region && bits.includes(hints.region.toLowerCase())) return true;
          if (hints.code) {
            const c = hints.code.toLowerCase();
            if (
              bits === c ||
              bits.includes(`/${c}/`) ||
              bits.includes(`/${c}.`) ||
              bits.includes(`_${c}_`) ||
              bits.includes(`-${c}-`) ||
              bits.includes(`flag-${c}`) ||
              bits.includes(`flags/${c}`) ||
              bits.includes(` ${c} `)
            ) {
              return true;
            }
          }
        }
        return false;
      },
      {
        region,
        code,
        label: league.label.trim(),
      },
    );
  }

  /**
   * Resolve the correct league accordion control. Shared names (Serie A, Premier
   * League, Bundesliga, Primera División) must be disambiguated by region.
   */
  private async resolveLeagueAccordionControl(
    page: Page,
    league: SorareInsideLeague,
  ): Promise<ReturnType<Page["locator"]> | null> {
    for (const needle of this.leagueAccordionNeedles(league)) {
      // Skip bare competitionName here when a region exists — handled below.
      if (
        league.regionName.trim() &&
        needle.toLowerCase() === league.competitionName.trim().toLowerCase()
      ) {
        continue;
      }
      // Exact title boundaries so "Germany - Bundesliga" ≠ "Germany - Bundesliga 2".
      const re = competitionAccordionRegex(needle);
      const control = page
        .locator("[data-accordion-control], .mantine-Accordion-control")
        .filter({ hasText: re })
        .first();
      if (await control.count()) return control;
    }

    const items = this.leagueAccordionItems(page, league);
    const count = await items.count();
    if (!count) return null;

    // When region is known, never accept the first lone "Serie A" / "Premier League"
    // while the sibling league may still be below the fold (Brazil before Italy).
    for (let i = 0; i < count; i += 1) {
      const item = items.nth(i);
      if (await this.accordionItemMatchesRegion(item, league)) {
        return item
          .locator("[data-accordion-control], .mantine-Accordion-control")
          .first();
      }
    }

    if (!league.regionName.trim() && count === 1) {
      return items
        .first()
        .locator("[data-accordion-control], .mantine-Accordion-control")
        .first();
    }

    // Ambiguous shared competition name without a region cue yet — keep scrolling.
    return null;
  }

  private async setAccordionExpanded(
    control: ReturnType<Page["locator"]>,
    expanded: boolean,
  ): Promise<void> {
    const current = await control.getAttribute("aria-expanded");
    const want = expanded ? "true" : "false";
    if (current === want) return;
    await control.click({ timeout: 5_000 }).catch(() => {});
    await sleep(400);
    const still = await control.getAttribute("aria-expanded");
    if (still !== want) {
      await control.click({ timeout: 5_000 }).catch(() => {});
      await sleep(300);
    }
  }

  private async dumpLineupsDom(page: Page): Promise<{
    url: string;
    title: string;
    accordionControls: number;
    accordionItems: number;
    accordionLike: number;
    bundesligaHits: string[];
    bodySample: string;
  }> {
    const dump =
      (await evaluateTimed<{
        title: string;
        accordionControls: number;
        accordionItems: number;
        accordionLike: number;
        bundesligaHits: string[];
        bodySample: string;
      }>(
        page,
        `() => {
          const textOf = (el) =>
            String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
          const bundesligaHits = [];
          for (const el of document.querySelectorAll("button, [role='button'], h2, h3, p, a")) {
            const t = textOf(el);
            if (/bundesliga/i.test(t) && t.length < 80) bundesligaHits.push(t.slice(0, 80));
            if (bundesligaHits.length >= 12) break;
          }
          return {
            title: document.title || "",
            accordionControls: document.querySelectorAll(
              "[data-accordion-control], .mantine-Accordion-control",
            ).length,
            accordionItems: document.querySelectorAll(
              "[data-accordion-item], .mantine-Accordion-item",
            ).length,
            accordionLike: document.querySelectorAll("[class*='ccordion']").length,
            bundesligaHits,
            bodySample: String(document.body && document.body.innerText || "")
              .replace(/\\s+/g, " ")
              .trim()
              .slice(0, 500),
          };
        }`,
        8_000,
      ).catch(() => null)) || {
        title: "",
        accordionControls: 0,
        accordionItems: 0,
        accordionLike: 0,
        bundesligaHits: [],
        bodySample: "",
      };
    const out = { url: page.url(), ...dump };
    await writeFile(
      resolve(projectRoot, "data/sorare/debug-accordion.json"),
      `${JSON.stringify(out, null, 2)}\n`,
    ).catch(() => {});
    await page
      .screenshot({
        path: resolve(projectRoot, "data/sorare/debug-lineups.png"),
        fullPage: false,
      })
      .catch(() => {});
    return out;
  }

  private async listAccordionTitles(page: Page): Promise<string[]> {
    return (
      (await evaluateTimed<string[]>(
        page,
        `() => [...document.querySelectorAll("[data-accordion-control], .mantine-Accordion-control, [class*='Accordion-control']")]
          .map((el) => String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim())
          .filter(Boolean)`,
        8_000,
      ).catch(() => [])) || []
    );
  }

  private async resetLineupsScroll(page: Page): Promise<void> {
    await evaluateTimed(
      page,
      `() => {
        window.scrollTo(0, 0);
        const se = document.scrollingElement;
        if (se) se.scrollTop = 0;
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        for (const el of document.querySelectorAll(
          ".mantine-ScrollArea-viewport, [data-radix-scroll-area-viewport]",
        )) {
          if (el instanceof HTMLElement) el.scrollTop = 0;
        }
      }`,
      8_000,
    ).catch(() => {});
  }

  private async expandLeagueAccordion(
    page: Page,
    league: SorareInsideLeague,
    options: { teamName?: string; opponentName?: string } = {},
  ): Promise<void> {
    const label = league.label || league.competitionName;
    this.setStatus({
      state: "running",
      message: `Expanding ${label}…`,
      currentUrl: page.url(),
    });

    await this.resetLineupsScroll(page);

    // If the match card is already visible, the league is expanded.
    if (
      options.teamName &&
      (await this.lineupsTeamCardPresent(
        page,
        options.teamName,
        options.opponentName,
      ))
    ) {
      return;
    }

    // Bring the region heading into the DOM (virtualized list) before looking
    // for competition / LINEUPS rows — otherwise Türkiye is missed after a
    // prior capture left the scroll near another region.
    const regionName = league.regionName.trim();
    if (regionName) {
      await this.scrollToLoadLazyContent(page, {
        message: `Scrolling to ${regionName}…`,
        untilCheck: async () => {
          const heading = page.getByText(regionName, { exact: true }).first();
          if (!(await heading.count().catch(() => 0))) return false;
          await heading.scrollIntoViewIfNeeded().catch(() => {});
          return Boolean(await heading.boundingBox().catch(() => null));
        },
        requireUntil: false,
        maxPasses: 24,
      }).catch(() => {});
    }

    // New UI: click the competition title text itself (not a Mantine control).
    // Shared names (Serie A, Premier League, Bundesliga, …) appear once per
    // region — never use `.first()` when a region is set, or Austria/Brazil wins.
    const competition = league.competitionName.trim();
    const sharedCompetition =
      /^(serie\s*a|premier\s*league|primera\s*divisi[oó]n|liga|championship|eredivisie|bundesliga)$/i.test(
        competition,
      );

    // Direct expand for unique region+competition cards (Türkiye / Süper Lig).
    // Prefer a Playwright locator over evaluate — the green-bordered row often
    // ignores bare title clicks. Skip shared titles: Austria "Bundesliga" sorts
    // above Germany and would steal `.first()`.
    if (regionName && competition && !sharedCompetition) {
      const row = page
        .locator("div, button, section, article")
        .filter({ hasText: competitionAccordionRegex(competition) })
        .filter({ hasText: /\d+\s+LINEUPS/i })
        .first();
      if ((await row.count().catch(() => 0)) > 0) {
        await row.scrollIntoViewIfNeeded().catch(() => {});
        // Click the compact row (not a giant ancestor): prefer elements whose
        // own text is short enough to be the league card.
        const box = await row.boundingBox().catch(() => null);
        if (box && box.height <= 120) {
          await row.click({ force: true, timeout: 5_000 }).catch(() => {});
        } else {
          await page
            .getByText(competition, { exact: true })
            .first()
            .click({ force: true, timeout: 5_000 })
            .catch(() => {});
        }
        await sleep(800);
        if (
          !options.teamName ||
          (await this.lineupsTeamCardPresent(
            page,
            options.teamName,
            options.opponentName,
          ))
        ) {
          return;
        }
        // Highlight-only: force the chevron before other fallbacks.
        await this.forceClickLeagueRowChevron(page, league);
        await sleep(700);
        if (
          !options.teamName ||
          (await this.lineupsTeamCardPresent(
            page,
            options.teamName,
            options.opponentName,
          ))
        ) {
          return;
        }
      }
    }

    // Shared titles (Bundesliga, Serie A, …): region-scoped LINEUPS chevron first.
    if (regionName && sharedCompetition) {
      await this.forceClickLeagueRowChevron(page, league);
      await sleep(700);
      if (
        !options.teamName ||
        (await this.waitForTeamInExpandedList(
          page,
          options.teamName,
          options.opponentName,
          label,
        ))
      ) {
        return;
      }
      const clicked = await this.findLeagueAccordionInPage(page, league, "click");
      if (clicked?.ok) {
        await sleep(500);
        if (
          !options.teamName ||
          (await this.waitForTeamInExpandedList(
            page,
            options.teamName,
            options.opponentName,
            label,
          ))
        ) {
          return;
        }
        await this.forceClickLeagueRowChevron(page, league);
        await sleep(700);
        if (
          !options.teamName ||
          (await this.waitForTeamInExpandedList(
            page,
            options.teamName,
            options.opponentName,
            label,
          ))
        ) {
          return;
        }
      }
    }

    // Evaluate fallback: click the DOM node that owns competition + LINEUPS
    // under the region heading.
    if (regionName && competition) {
      const domClick = await evaluateTimed<{ ok?: boolean; text?: string }>(
        page,
        `(() => {
          const fold = (v) => String(v || "")
            .normalize("NFKD")
            .replace(/[\\u0300-\\u036f]/g, "")
            .replace(/\\u0131/g, "i")
            .replace(/\\u0130/g, "i")
            .toLowerCase()
            .replace(/\\s+/g, " ")
            .trim();
          const wantComp = fold(${JSON.stringify(competition)});
          const wantRegion = fold(${JSON.stringify(regionName)});
          const isTopBl = wantComp === "bundesliga";
          const matchesComp = (raw) => {
            const f = fold(raw);
            if (!f.includes(wantComp)) return false;
            if (isTopBl && /(?:^|\\s)2\\.\\s*bundesliga\\b/.test(f)) return false;
            if (isTopBl && /bundesliga\\s*2\\b/.test(f)) return false;
            return true;
          };
          const textOf = (el) => String(el.innerText || el.textContent || "")
            .replace(/\\s+/g, " ")
            .trim();
          let regionEl = null;
          for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,div,span,p,button")) {
            const t = fold(textOf(el));
            if (t === wantRegion || t.startsWith(wantRegion + " ")) {
              const r = el.getBoundingClientRect();
              if (r.width > 20 && r.height > 8 && r.height < 80) {
                regionEl = el;
                break;
              }
            }
          }
          if (!regionEl) return { ok: false, text: "no-region" };
          const regionY = regionEl.getBoundingClientRect().y;
          let best = null;
          let bestY = Infinity;
          for (const el of document.querySelectorAll("div, button, section, article, li")) {
            const t = textOf(el);
            if (t.length < 8 || t.length > 160) continue;
            if (!matchesComp(t)) continue;
            if (!/\\d+\\s+lineups/i.test(t)) continue;
            const r = el.getBoundingClientRect();
            if (r.y < regionY - 8 || r.y > regionY + 900) continue;
            const prefer =
              isTopBl && /(?:^|\\s)1\\.\\s*bundesliga\\b/.test(fold(t)) ? -40 : 0;
            const rank = r.y + prefer;
            if (rank < bestY) {
              bestY = rank;
              best = el;
            }
          }
          if (!best) return { ok: false, text: "no-row" };
          best.scrollIntoView({ block: "center", inline: "nearest" });
          const buttons = [...best.querySelectorAll("button, [role='button']")];
          const chevron =
            [...buttons].reverse().find((b) => {
              const bt = textOf(b);
              return bt.length < 8 || /svg|chevron|arrow/i.test(b.innerHTML || "");
            }) || null;
          const clickable =
            chevron ||
            best.closest("button, [role='button'], [data-accordion-control]") ||
            best;
          if (typeof clickable.click === "function") clickable.click();
          return { ok: true, text: textOf(best).slice(0, 120) };
        })()`,
        10_000,
      ).catch(() => null);
      if (domClick?.ok) {
        await sleep(700);
        if (
          !options.teamName ||
          (await this.lineupsTeamCardPresent(
            page,
            options.teamName,
            options.opponentName,
          ))
        ) {
          return;
        }
      }
    }

    if (competition && !(sharedCompetition && regionName)) {
      const title = page.getByText(competition, { exact: true }).first();
      if ((await title.count().catch(() => 0)) > 0) {
        await title.scrollIntoViewIfNeeded().catch(() => {});
        await title.click({ timeout: 4_000 }).catch(async () => {
          await title.click({ force: true, timeout: 4_000 }).catch(() => {});
        });
        await sleep(600);
        if (
          !options.teamName ||
          (await this.lineupsTeamCardPresent(
            page,
            options.teamName,
            options.opponentName,
          ))
        ) {
          return;
        }
      }
    } else if (competition && regionName) {
      // Click "Serie A" that sits under the region heading (Italy, not Brazil).
      const regionHeading = page.getByText(regionName, { exact: true }).first();
      if (await regionHeading.count().catch(() => 0)) {
        await regionHeading.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(300);
      }
      const regionalTitle = page
        .getByText(competition, { exact: true })
        .filter({
          has: page.locator(
            `xpath=ancestor::*[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'${regionName.toLowerCase()}') or preceding::*[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'${regionName.toLowerCase()}')][1]]`,
          ),
        })
        .first();
      // Fallback: lineups row finder (region-aware) rather than brittle xpath.
      const clicked = await this.findLeagueAccordionInPage(page, league, "click");
      if (clicked?.ok) {
        await sleep(500);
        if (
          !options.teamName ||
          (await this.lineupsTeamCardPresent(
            page,
            options.teamName,
            options.opponentName,
          ))
        ) {
          return;
        }
      } else if ((await regionalTitle.count().catch(() => 0)) > 0) {
        await regionalTitle.click({ timeout: 4_000 }).catch(() => {});
        await sleep(600);
        if (
          !options.teamName ||
          (await this.lineupsTeamCardPresent(
            page,
            options.teamName,
            options.opponentName,
          ))
        ) {
          return;
        }
      }
    }

    // Prefer modern LINEUPS rows via shared finder (handles expanded long text).
    if (competition) {
      const clicked = await this.findLeagueAccordionInPage(page, league, "click");
      if (clicked?.ok) {
        await sleep(500);
        if (
          !options.teamName ||
          (await this.lineupsTeamCardPresent(
            page,
            options.teamName,
            options.opponentName,
          ))
        ) {
          return;
        }
      }
    }

    await page
      .locator(
        "[data-accordion-control], .mantine-Accordion-control, [class*='Accordion-control']",
      )
      .first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .catch(() => {});
    const missAccordion = async (detail: string): Promise<never> => {
      const dump = await this.dumpLineupsDom(page);
      const titles = await this.listAccordionTitles(page);
      const lineupsRows = await page.getByText(/LINEUPS/i).count().catch(() => 0);
      const visible = titles.length
        ? ` Visible accordions: ${titles.slice(0, 40).join(" · ")}.`
        : dump.bundesligaHits.length
          ? ` No accordion controls; Bundesliga text: ${dump.bundesligaHits.join(" · ")}.`
          : ` No accordion controls were mounted (${dump.accordionLike} *ccordion, ${lineupsRows} LINEUPS rows). ${dump.bodySample}`;
      throw new Error(`${detail}${visible}`);
    };
    await this.scrollToLoadLazyContent(page, {
      message: `Scrolling to ${label} to expand the league…`,
      untilCheck: async () => {
        if (
          options.teamName &&
          (await this.lineupsTeamCardPresent(
            page,
            options.teamName,
            options.opponentName,
          ))
        ) {
          return true;
        }
        // Only detect the league row here — clicking every scroll pass can
        // thrash/crash the headed Chrome profile mid-capture.
        if (await this.findLeagueAccordionInPage(page, league, "find")) {
          return true;
        }
        if (await this.resolveLeagueAccordionControl(page, league)) return true;
        return false;
      },
      requireUntil: true,
      untilMissError: `Could not find "${label}" league accordion on the lineups page.`,
    }).catch(async (error: unknown) => {
      if (options.teamName) {
        await this.scrollToLoadLazyContent(page, {
          message: `Scrolling for ${options.teamName} without accordion…`,
          untilText: options.teamName,
          untilOpponent: options.opponentName,
          requireUntil: false,
        }).catch(() => {});
        if (
          await this.lineupsTeamCardPresent(
            page,
            options.teamName,
            options.opponentName,
          )
        ) {
          return;
        }
      }
      // Hard recovery: lineups list often left scrolled / half-hidden after a
      // prior modal capture. Reload once, then retry region scroll + find.
      if (this.lineupsUrl) {
        this.setStatus({
          state: "running",
          message: `Reloading lineups to find ${label}…`,
          currentUrl: this.lineupsUrl,
        });
        await page.goto(this.lineupsUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await sleep(1_500);
        this.lineupsFullyLoaded = false;
        await this.scrollToLoadLazyContent(page, {
          message: `Scrolling reloaded lineups for ${label}…`,
          untilCheck: async () =>
            Boolean(await this.findLeagueAccordionInPage(page, league, "find")),
          requireUntil: false,
          maxPasses: 28,
        }).catch(() => {});
        const retried = await this.findLeagueAccordionInPage(page, league, "click");
        if (retried?.ok) {
          await sleep(500);
          if (
            !options.teamName ||
            (await this.lineupsTeamCardPresent(
              page,
              options.teamName,
              options.opponentName,
            ))
          ) {
            return;
          }
        }
        if (
          options.teamName &&
          (await this.lineupsTeamCardPresent(
            page,
            options.teamName,
            options.opponentName,
          ))
        ) {
          return;
        }
      }
      const base = error instanceof Error ? error.message : String(error);
      await missAccordion(base);
    });

    const clicked = await this.findLeagueAccordionInPage(page, league, "click");
    if (clicked?.ok) {
      await sleep(400);
      if (!options.teamName) return;
      // Türkiye often highlights the row (green border) without expanding —
      // retry the competition title click a few times until clubs appear.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (
          await this.lineupsTeamCardPresent(
            page,
            options.teamName,
            options.opponentName,
          )
        ) {
          return;
        }
        if (attempt === 1 || attempt === 3) {
          await this.forceClickLeagueRowChevron(page, league);
        } else {
          await this.findLeagueAccordionInPage(page, league, "click");
        }
        await sleep(500 + attempt * 200);
      }
    }

    const control = await this.resolveLeagueAccordionControl(page, league);
    if (control && (await control.count())) {
      await this.setAccordionExpanded(control, true);
      if (!options.teamName) return;
      if (
        await this.lineupsTeamCardPresent(
          page,
          options.teamName,
          options.opponentName,
        )
      ) {
        return;
      }
      await this.setAccordionExpanded(control, false);
    }

    // Last resort / no region cue in the DOM: try each namesake accordion.
    const items = this.leagueAccordionItems(page, league);
    const count = await items.count();
    if (!count) {
      // New UI has LINEUPS chips, not Mantine accordion controls. Force the
      // row chevron before giving up — parallel tabs often only green-border.
      const lineupsN = await page.getByText(/\d+\s+LINEUPS/i).count().catch(() => 0);
      if (lineupsN > 0) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await this.forceClickLeagueRowChevron(page, league);
          await sleep(700 + attempt * 200);
          if (
            !options.teamName ||
            (await this.waitForTeamInExpandedList(
              page,
              options.teamName,
              options.opponentName,
              label,
            ))
          ) {
            return;
          }
        }
        if (this.lineupsUrl) {
          this.setStatus({
            state: "running",
            message: this.captureStatusMessage(
              `Reloading to expand ${label} via LINEUPS chevron…`,
            ),
            currentUrl: this.lineupsUrl,
          });
          await page.goto(this.lineupsUrl, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          await sleep(1_500);
          if (league.regionName.trim()) {
            await this.scrollToLoadLazyContent(page, {
              message: `Scrolling to ${league.regionName} after reload…`,
              untilCheck: async () => {
                const heading = page
                  .getByText(league.regionName.trim(), { exact: true })
                  .first();
                if (!(await heading.count().catch(() => 0))) return false;
                await heading.scrollIntoViewIfNeeded().catch(() => {});
                return Boolean(await heading.boundingBox().catch(() => null));
              },
              requireUntil: false,
              maxPasses: 24,
            }).catch(() => {});
          }
          await this.forceClickLeagueRowChevron(page, league);
          await sleep(900);
          if (
            !options.teamName ||
            (await this.waitForTeamInExpandedList(
              page,
              options.teamName,
              options.opponentName,
              label,
            ))
          ) {
            return;
          }
        }
        throw new Error(
          `Could not expand "${label}" LINEUPS row (clubs never appeared after chevron clicks).`,
        );
      }
      await missAccordion(
        `Could not find "${label}" league accordion on the lineups page.`,
      );
    }
    if (!options.teamName) {
      await this.setAccordionExpanded(
        items
          .first()
          .locator("[data-accordion-control], .mantine-Accordion-control")
          .first(),
        true,
      );
      return;
    }
    for (let i = 0; i < count; i += 1) {
      const candidate = items
        .nth(i)
        .locator("[data-accordion-control], .mantine-Accordion-control")
        .first();
      await this.setAccordionExpanded(candidate, true);
      const present = await this.lineupsTeamCardPresent(
        page,
        options.teamName,
        options.opponentName,
      );
      if (present) return;
      await this.setAccordionExpanded(candidate, false);
    }
    throw new Error(
      `Could not find "${options.teamName}" under any "${league.competitionName}" accordion (wanted ${label}).`,
    );
  }

  async capture(body: unknown): Promise<{
    status: SorareInsideSessionStatus;
    file: {
      path: string;
      relativePath: string;
      greenPath: string;
      greenRelativePath: string;
      tour: number;
      teamName: string;
      clubSlug: string;
      gameId: string;
      side: "home" | "away";
    };
    probabilities: SorareInsidePlayerProbability[];
  }> {
    if (this.busy) {
      throw new Error("A SorareInside operation is already running.");
    }
    if (this.activeCaptures >= this.captureConcurrency) {
      throw new Error(
        `All ${this.captureConcurrency} capture slots are busy. Retry or lower SORAREINSIDE_CAPTURE_CONCURRENCY.`,
      );
    }
    const request = parseSorareInsideCaptureRequest(body);
    const match = this.matches.find((item) => item.gameId === request.gameId);
    if (!match) {
      throw new Error(
        `Unknown gameId ${request.gameId}. Expand selected leagues first.`,
      );
    }
    const sideTeam = request.side === "home" ? match.home : match.away;
    const teamName = (request.teamName || sideTeam.teamName).trim();
    if (!teamName || teamName === "TBD") {
      throw new Error("teamName is required to build the screenshot path.");
    }
    if (!(request.lineupId || sideTeam.lineupId)) {
      throw new Error(`No lineup id for ${teamName}.`);
    }

    this.activeCaptures += 1;
    this.activeCaptureLabels.add(teamName);
    this.setStatus({
      state: "running",
      message: this.captureStatusMessage(`Expanding league for ${teamName}…`),
      currentUrl: this.page?.url() ?? this.lineupsUrl,
    });

    let page: Page | null = null;
    try {
      // Own tab per capture so up to N can run in one Chrome profile (shared login).
      page = await this.openCapturePage();
      if (!(this.context && (await looksLoggedIn(page, this.context)))) {
        throw new Error(
          "Not signed in. Run Load leagues first and complete login if prompted.",
        );
      }
      // Always start from a clean lineups list. Modal prepare() can leave the
      // virtualized page scrolled/poisoned so later Türkiye LINEUPS rows miss.
      if (this.lineupsUrl) {
        await page.goto(this.lineupsUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await sleep(1_200);
      }
      // Recover from a prior capture that hid body siblings and never restored
      // (prepare() threw outside try/finally). Invisible list → false accordion misses.
      await page
        .evaluate(`(() => {
          if (typeof window.__siRestoreModalStyles === "function") {
            window.__siRestoreModalStyles();
          }
          try { delete window.__siRestoreModalStyles; } catch (_) {}
          for (const child of Array.from(document.body.children)) {
            if (!(child instanceof HTMLElement)) continue;
            if (child.style.getPropertyValue("visibility") === "hidden") {
              child.style.removeProperty("visibility");
            }
          }
          for (const el of document.querySelectorAll(
            ".mantine-Modal-overlay, [data-modal-overlay], .mantine-Modal-root",
          )) {
            if (el instanceof HTMLElement) el.remove();
          }
        })()`)
        .catch(() => {});
      const accordionSel =
        "[data-accordion-control], .mantine-Accordion-control, [class*='Accordion-control']";
      let accordionCount = await page.locator(accordionSel).count().catch(() => 0);
      const lineupsRows = await page.getByText(/\d+\s+LINEUPS/i).count().catch(() => 0);
      // After a capture, LINEUPS chips can remain while the list is still half-
      // poisoned. Prefer a clean reload whenever the prior modal left no
      // visible region headings for this league.
      if (this.lineupsUrl && accordionCount === 0 && lineupsRows === 0) {
        this.setStatus({
          state: "running",
          message: this.captureStatusMessage(
            `Reloading lineups so ${teamName}'s league row can mount…`,
          ),
          currentUrl: this.lineupsUrl,
        });
        await page.goto(this.lineupsUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await sleep(1_500);
        await page
          .getByText(/\d+\s+LINEUPS/i)
          .first()
          .waitFor({ state: "visible", timeout: 20_000 })
          .catch(() => {});
        accordionCount = await page.locator(accordionSel).count().catch(() => 0);
      } else if (this.lineupsUrl && accordionCount === 0 && lineupsRows > 0) {
        // New SorareInside UI: league rows are not Mantine accordions.
        // Keep the page as-is and expand via LINEUPS row click below.
      } else if (this.lineupsUrl && accordionCount === 0) {
        this.setStatus({
          state: "running",
          message: this.captureStatusMessage(
            `Reloading lineups so ${teamName}'s league accordion can mount…`,
          ),
          currentUrl: this.lineupsUrl,
        });
        await page.goto(this.lineupsUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await sleep(1_500);
        await page
          .locator(accordionSel)
          .first()
          .waitFor({ state: "visible", timeout: 20_000 })
          .catch(() => {});
        accordionCount = await page.locator(accordionSel).count().catch(() => 0);
      }

      const league = this.leagues.find((item) => item.id === match.leagueId);
      if (!league) {
        throw new Error(
          `Unknown league for ${teamName}. Expand selected leagues first.`,
        );
      }
      const opponent =
        request.side === "home" ? match.away.teamName : match.home.teamName;
      await this.withExpandLock(async () => {
        await this.expandLeagueAccordion(page, league, {
          teamName,
          opponentName: opponent,
        });
      });

      await this.scrollToLoadLazyContent(page, {
        message: `Scrolling expanded ${league.label || league.competitionName} for ${teamName}…`,
        untilText: teamName,
        untilOpponent: opponent,
        requireUntil: true,
        untilMissError:
          `No clickable "${teamName}" match on the ${league.label || league.competitionName} lineups list after expanding the league.`,
      });

      await this.openLineupPopup(page, match, request.side);

      const modal = page.locator("[data-modal-content], .mantine-Modal-content").first();
      const relativePath = sorareTourClubScreenshotPath(request.round, teamName);
      const greenRelativePath = sorareTourClubGreenScreenshotPath(
        request.round,
        teamName,
      );
      const filePath = resolve(this.outputRootAbs, relativePath);
      const greenFilePath = resolve(this.outputRootAbs, greenRelativePath);
      await mkdir(dirname(filePath), { recursive: true });
      const sections = await this.screenshotFullModal(
        page,
        modal,
        filePath,
        greenFilePath,
      );

      const pitchText = sections.pitch || "";
      const benchText = sections.bench || "";
      const dnpText = sections.dnp || "";
      const modalText =
        pitchText || benchText || dnpText
          ? `${pitchText}\n${benchText}\n${dnpText}`
          : (await modal.innerText().catch(() => "")) || "";
      const fromCards = parseProbabilitiesFromPitchCards(
        sections.pitchCards ?? [],
      );
      const fromPitchText = parseProbabilitiesFromModalText(
        pitchText || modalText,
      );
      // Prefer the parse with more high-% starters. Alt-only leaf cards used to
      // win on length alone and publish grey backups as the Starting XI.
      const starting = pickBestPitchProbabilityParse(fromCards, fromPitchText);
      // Ensure section headers exist for the bench/dnp parser.
      const benchAndDnp = parseBenchAndDnpPlayerLists(
        [
          benchText ? `Bench Players\n${benchText}` : "",
          dnpText ? `DNP Players\n${dnpText}` : "",
        ]
          .filter(Boolean)
          .join("\n") || modalText,
      );
      const probabilities = mergeSorareInsideProbabilities(starting, benchAndDnp);
      const parsedNotes = parseSorareInsideAnalystNotes(
        [
          sections.notes?.teamAnalysis
            ? `Team Analysis\n${sections.notes.teamAnalysis}`
            : "",
          sections.notes?.injuriesAndRecovery
            ? `Injuries & Recovery Status\n${sections.notes.injuriesAndRecovery}`
            : "",
          sections.notes?.suspensionsAndIneligibilities
            ? `Suspensions & Ineligibilities\n${sections.notes.suspensionsAndIneligibilities}`
            : "",
          modalText,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      const notes = {
        teamAnalysis: sanitizeSorareAnalystNote(
          sections.notes?.teamAnalysis || parsedNotes.teamAnalysis || "",
        ),
        injuriesAndRecovery: sanitizeSorareAnalystNote(
          sections.notes?.injuriesAndRecovery ||
            parsedNotes.injuriesAndRecovery ||
            "",
        ),
        suspensionsAndIneligibilities: sanitizeSorareAnalystNote(
          sections.notes?.suspensionsAndIneligibilities ||
            parsedNotes.suspensionsAndIneligibilities ||
            "",
        ),
      };

      const clubSlug = clubFileSlug(teamName);
      const jsonPath = resolve(this.outputRootAbs, relativePath.replace(/\.png$/i, ".json"));
      await writeFile(
        jsonPath,
        `${JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            gameId: match.gameId,
            side: request.side,
            teamName,
            clubSlug,
            round: request.round,
            leagueId: match.leagueId,
            leagueLabel: match.leagueLabel,
            lineupId: request.lineupId || sideTeam.lineupId,
            screenshot: relativePath,
            greenScreenshot: greenRelativePath,
            outputRoot: this.getOutputRootDisplay(),
            probabilities,
            notes,
          },
          null,
          2,
        )}\n`,
      );

      this.setStatus({
        state: this.activeCaptures > 1 ? "running" : "ready",
        message:
          this.activeCaptures > 1
            ? this.captureStatusMessage(`Saved ${teamName}`)
            : `Saved ${relativePath} + ${greenRelativePath}` +
              (probabilities.length ? ` · ${probabilities.length} player %` : ""),
        currentUrl: page.url(),
      });

      return {
        status: this.getStatus(),
        file: {
          path: filePath,
          relativePath,
          greenPath: greenFilePath,
          greenRelativePath,
          tour: request.round,
          teamName,
          clubSlug,
          gameId: match.gameId,
          side: request.side,
        },
        probabilities,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({
        state: this.activeCaptures > 1 ? "running" : "failed",
        message:
          this.activeCaptures > 1
            ? `${this.captureStatusMessage("capturing")} · failed ${teamName}: ${message}`
            : message,
        currentUrl: page?.url() ?? this.page?.url() ?? null,
      });
      throw error;
    } finally {
      if (page) {
        await this.closeModal(page).catch(() => {});
        await page.close().catch(() => {});
      }
      this.activeCaptureLabels.delete(teamName);
      this.activeCaptures = Math.max(0, this.activeCaptures - 1);
      if (this.activeCaptures === 0 && !this.busy) {
        if (this.status.state === "running") {
          this.setStatus({
            state: "ready",
            message: `Ready · ${this.leagues.length} leagues · ${this.matches.length} matches.`,
            currentUrl: this.page?.url() ?? this.lineupsUrl,
          });
        } else {
          this.setStatus({
            state: this.status.state,
            message: this.status.message,
            currentUrl: this.status.currentUrl,
          });
        }
      } else if (this.activeCaptures > 0) {
        this.setStatus({
          state: "running",
          message: this.captureStatusMessage("Capturing…"),
          currentUrl: this.page?.url() ?? this.lineupsUrl,
        });
      }
      this.continueLogin = null;
    }
  }
}

let sharedSession: SorareInsideSession | null = null;

export function getSorareInsideSession(): SorareInsideSession {
  if (!sharedSession) sharedSession = new SorareInsideSession();
  return sharedSession;
}

export type { SorareInsideCaptureRequest };
