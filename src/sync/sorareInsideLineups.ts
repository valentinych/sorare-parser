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
import {
  clubFileSlug,
  displaySorareOutputDir,
  isSorareInsideGamesApiUrl,
  loadSorareOutputDirConfig,
  mergeSorareInsideProbabilities,
  parseBenchAndDnpPlayerLists,
  parseProbabilitiesFromModalText,
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
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  private busy = false;
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
  };

  getStatus(): SorareInsideSessionStatus {
    return { ...this.status };
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
    };
  }

  private async ensureBrowser(): Promise<Page> {
    if (this.context && this.page && !this.page.isClosed()) {
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
    if (this.busy) return false;
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
    const close = page
      .locator(
        '[data-modal-content] button[aria-label*="Close" i], .mantine-Modal-close, [data-modal-content] button:has-text("Close")',
      )
      .first();
    if (await close.isVisible().catch(() => false)) {
      await close.click({ timeout: 3_000 }).catch(() => {});
      await sleep(300);
      return;
    }
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(300);
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
  ): Promise<{ pitch: string; bench: string; dnp: string }> {
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    let sectionText = { pitch: "", bench: "", dnp: "" };

    this.setStatus({
      state: "running",
      message: "Scrolling popup for Bench / DNP / % labels…",
      currentUrl: page.url(),
    });

    await this.scrollModalContent(modal, { reset: false });
    await this.waitForModalLoadersGone(modal, 20_000);
    await this.ensureBenchDnpVisible(modal);
    await this.scrollModalContent(modal, { reset: false });
    await this.waitForModalLoadersGone(modal, 20_000);
    await modal.evaluate(`(root) => {
      for (const el of window.__siModalScrollers || []) {
        try { el.scrollTop = 0; } catch (_) {}
      }
      try { delete window.__siModalScrollers; } catch (_) {}
      try { root.scrollTop = 0; } catch (_) {}
    }`);
    await sleep(300);

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

    try {
      const w = Math.min(1800, Math.max(400, prepared.modal.width + 48));
      const h = Math.min(5000, Math.max(400, prepared.modal.height + 64));
      await page.setViewportSize({ width: w, height: h });
      await sleep(250);

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
      await sleep(600);
      await this.waitForModalLoadersGone(modal, 15_000);

      const remarked = (await page.evaluate(SI_REMARK_PITCH_SCRIPT)) as {
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

      this.setStatus({
        state: "running",
        message:
          `Capturing pitch` +
          (remarked.hasBench ? " + Bench" : "") +
          (remarked.hasDnp ? " + DNP" : "") +
          ` (${remarked.width}x${remarked.height})…`,
        currentUrl: page.url(),
      });

      const modalShot = page.locator("[data-si-modal]").first();
      await modalShot.waitFor({ state: "visible", timeout: 10_000 });
      await mkdir(dirname(filePath), { recursive: true });
      await modalShot.screenshot({
        path: filePath,
        type: "png",
        animations: "disabled",
      });

      const pitchShot = page.locator("[data-si-pitch]").first();
      if ((await pitchShot.count()) < 1) {
        throw new Error(
          "Could not locate green formation pitch (data-si-pitch) inside the popup.",
        );
      }
      await mkdir(dirname(greenFilePath), { recursive: true });
      await pitchShot.screenshot({
        path: greenFilePath,
        type: "png",
        animations: "disabled",
      });

      sectionText = ((await page
        .evaluate(SI_EXTRACT_SECTION_TEXT_SCRIPT)
        .catch(() => null)) ?? sectionText) as {
        pitch: string;
        bench: string;
        dnp: string;
      };
    } finally {
      await page
        .evaluate(`(() => {
          if (typeof window.__siRestoreModalStyles === "function") {
            window.__siRestoreModalStyles();
          }
          try { delete window.__siRestoreModalStyles; } catch (_) {}
        })()`)
        .catch(() => {});
      const current = page.viewportSize();
      if (
        current &&
        (current.width !== viewport.width || current.height !== viewport.height)
      ) {
        await page.setViewportSize(viewport).catch(() => {});
      }
    }
    return sectionText;
  }

  /** Scroll until Bench Players / DNP headings mount (lazy lists). */
  private async ensureBenchDnpVisible(
    modal: ReturnType<Page["locator"]>,
  ): Promise<void> {
    const deadline = Date.now() + 45_000;
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
  }

  /**
   * Step-scroll the lineups page (window + overflow panes) so lazy match rows
   * mount before screenshot capture starts.
   */
  private async scrollLineupsPageToLoadAll(page: Page): Promise<void> {
    this.setStatus({
      state: "running",
      message: "Scrolling lineups to the bottom to load all matches…",
      currentUrl: page.url(),
    });
    let lastHeight = 0;
    let stable = 0;
    for (let pass = 0; pass < 40; pass += 1) {
      const height = (await page.evaluate(`() => {
        const nodes = [];
        const add = (el) => {
          if (el instanceof HTMLElement) nodes.push(el);
        };
        add(document.scrollingElement);
        add(document.documentElement);
        add(document.body);
        for (const el of document.querySelectorAll("*")) {
          if (!(el instanceof HTMLElement)) continue;
          const cs = getComputedStyle(el);
          if (
            /(auto|scroll)/.test(cs.overflowY) &&
            el.scrollHeight > el.clientHeight + 8
          ) {
            nodes.push(el);
          }
        }
        let maxHeight = 0;
        for (const el of nodes) {
          const max = Math.max(0, el.scrollHeight - el.clientHeight);
          const step = Math.max(180, Math.floor(el.clientHeight * 0.85) || 180);
          el.scrollTop = Math.min(max, el.scrollTop + step);
          maxHeight = Math.max(maxHeight, el.scrollHeight);
        }
        window.scrollBy(0, Math.max(window.innerHeight * 0.85, 400));
        return Math.max(
          maxHeight,
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
        );
      }`)) as number;
      await sleep(350);
      if (height <= lastHeight) {
        stable += 1;
        if (stable >= 2 && pass >= 2) break;
      } else {
        stable = 0;
        lastHeight = height;
      }
    }
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
    await modal.evaluate(`(root) => {
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
        for (let y = 0; y <= max; y += step) {
          el.scrollTop = Math.min(y, max);
        }
        el.scrollTop = max;
      }
    }`);
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
    const loader = modal.locator(
      ".mantine-Loader-root, .mantine-LoadingOverlay-root, [class*='mantine-Loader'], [role='progressbar']",
    );
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
   */
  private async waitForModalLineupLoaded(page: Page): Promise<void> {
    const modal = page.locator("[data-modal-content], .mantine-Modal-content").first();
    await modal.waitFor({ state: "visible", timeout: 20_000 });

    this.setStatus({
      state: "running",
      message: "Waiting for lineup popup (auto-scrolling to load % labels)…",
      currentUrl: page.url(),
    });

    const percentLabels = modal.getByText(/\d{1,3}\s*%/);
    const deadline = Date.now() + 90_000;

    let pass = 0;
    while (Date.now() < deadline) {
      await this.waitForModalLoadersGone(modal, Math.min(5_000, deadline - Date.now()));
      // Keep scrolling during the wait — % labels often mount only after the
      // popup body is scrolled (otherwise we idle for up to 90s).
      await this.scrollModalContent(modal, { reset: pass % 2 === 1 });
      pass += 1;
      const percentCount = await percentLabels.count().catch(() => 0);
      const hasLineupContent = percentCount >= 3;

      if (hasLineupContent) {
        await sleep(600);
        const stillReady =
          (await percentLabels.count().catch(() => 0)) >= 3;
        const stillLoading = await modal
          .locator(
            ".mantine-Loader-root, .mantine-LoadingOverlay-root, [class*='mantine-Loader'], [role='progressbar']",
          )
          .first()
          .isVisible()
          .catch(() => false);
        if (!stillLoading && stillReady) return;
      }

      await sleep(250);
    }

    const stillLoading = await modal
      .locator(
        ".mantine-Loader-root, .mantine-LoadingOverlay-root, [class*='mantine-Loader'], [role='progressbar']",
      )
      .first()
      .isVisible()
      .catch(() => false);
    const percentCount = await percentLabels.count().catch(() => 0);
    throw new Error(
      stillLoading
        ? "Timed out after 90s: lineup popup still shows loading spinner."
        : `Timed out after 90s waiting for lineup content in popup (found ${percentCount} probability label(s); need ≥3).`,
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

    const opened = await this.clickTeamToOpenPopup(page, team.teamName);
    if (!opened) {
      throw new Error(
        `Could not open lineup popup for ${team.teamName}. Expand the league accordion first.`,
      );
    }

    await this.waitForModalLineupLoaded(page);
  }

  /** Click team name in accordion; scroll + JS click when Playwright viewport check fails. */
  private async clickTeamToOpenPopup(
    page: Page,
    teamName: string,
  ): Promise<boolean> {
    const teamLink = page
      .locator("button, a, [role='button'], p, span")
      .filter({ hasText: new RegExp(`^${escapeRegExp(teamName)}$`) })
      .first();

    if (await teamLink.isVisible().catch(() => false)) {
      await teamLink
        .evaluate(`(el) => {
          if (!(el instanceof HTMLElement)) return;
          el.scrollIntoView({ block: "center", inline: "nearest" });
          let p = el.parentElement;
          while (p) {
            const cs = getComputedStyle(p);
            if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 2) {
              const r = el.getBoundingClientRect();
              const pr = p.getBoundingClientRect();
              p.scrollTop += r.top - pr.top - pr.height / 2 + r.height / 2;
            }
            p = p.parentElement;
          }
        }`)
        .catch(() => {});
      await sleep(250);
      try {
        await teamLink.click({ timeout: 5_000 });
      } catch {
        // Sticky headers / accordion overflow: Playwright says "outside viewport".
        await teamLink
          .evaluate(`(el) => {
            if (!(el instanceof HTMLElement)) return;
            const target =
              el.closest("button, a, [role='button']") || el;
            if (target instanceof HTMLElement) target.click();
          }`)
          .catch(() => {});
      }
      await sleep(400);
      const modal = page
        .locator("[data-modal-content], .mantine-Modal-content")
        .first();
      if (await modal.isVisible().catch(() => false)) return true;
    }

    // Fallback: searchable team select on the lineups page.
    const select = page
      .getByPlaceholder(/Select from|Select a team|search/i)
      .first();
    if (!(await select.isVisible().catch(() => false))) return false;
    await select.click();
    await select.fill(teamName);
    await sleep(400);
    await page
      .locator("[data-combobox-option], .mantine-Select-option, [role='option']")
      .filter({ hasText: teamName })
      .first()
      .click({ timeout: 8_000 });
    await sleep(400);
    return page
      .locator("[data-modal-content], .mantine-Modal-content")
      .first()
      .isVisible()
      .catch(() => false);
  }

  private async expandLeagueAccordion(
    page: Page,
    league: SorareInsideLeague,
  ): Promise<void> {
    const control = page
      .locator("[data-accordion-control], .mantine-Accordion-control")
      .filter({ hasText: league.competitionName })
      .first();
    if (!(await control.count())) {
      // Competition name alone; try full label fragment.
      const alt = page
        .locator("[data-accordion-control], .mantine-Accordion-control")
        .filter({ hasText: league.competitionName.split(" ").slice(-2).join(" ") })
        .first();
      if (await alt.count()) {
        const expanded = await alt.getAttribute("aria-expanded");
        if (expanded !== "true") await alt.click();
        await sleep(400);
        return;
      }
      return;
    }
    const expanded = await control.getAttribute("aria-expanded");
    if (expanded !== "true") {
      await control.click();
      await sleep(400);
    }
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

    this.busy = true;
    this.setStatus({
      state: "running",
      message: `Opening lineup popup for ${teamName}…`,
      currentUrl: this.page?.url() ?? this.lineupsUrl,
    });

    try {
      const page = await this.ensureBrowser();
      if (!(this.context && (await looksLoggedIn(page, this.context)))) {
        throw new Error(
          "Not signed in. Run Load leagues first and complete login if prompted.",
        );
      }
      if (this.lineupsUrl && !/\/lineups/i.test(page.url())) {
        await page.goto(this.lineupsUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await sleep(1_500);
        this.lineupsFullyLoaded = false;
      }
      if (!this.lineupsFullyLoaded) {
        await this.scrollLineupsPageToLoadAll(page);
        this.lineupsFullyLoaded = true;
      }

      const league = this.leagues.find((item) => item.id === match.leagueId);
      if (league) await this.expandLeagueAccordion(page, league);

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
      const starting = parseProbabilitiesFromModalText(pitchText || modalText);
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
          },
          null,
          2,
        )}\n`,
      );

      this.setStatus({
        state: "ready",
        message:
          `Saved ${relativePath} + ${greenRelativePath}` +
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
      this.setStatus({
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
        currentUrl: this.page?.url() ?? null,
      });
      throw error;
    } finally {
      this.busy = false;
      this.continueLogin = null;
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let sharedSession: SorareInsideSession | null = null;

export function getSorareInsideSession(): SorareInsideSession {
  if (!sharedSession) sharedSession = new SorareInsideSession();
  return sharedSession;
}

export type { SorareInsideCaptureRequest };
