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
  LINEUP_TEAM_LABELS_MATCH_SOURCE,
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
};

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
        timeout: 20_000,
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
        timeout: 20_000,
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
    const deadline = Date.now() + 25_000;
    let pass = 0;
    while (Date.now() < deadline) {
      const percentCount = await percentLabels.count().catch(() => 0);
      // % rings use role=progressbar — do not treat them as a blocking spinner.
      if (percentCount >= 3) {
        await sleep(300);
        if ((await percentLabels.count().catch(() => 0)) >= 3) return;
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
    throw new Error(
      stillLoading
        ? `Timed out after 25s: lineup popup still shows a spinner (found ${percentCount} % label(s)).`
        : `Timed out after 25s waiting for lineup content in popup (found ${percentCount} probability label(s); need ≥3).`,
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

  /** True when a club/match row for this team is mounted on the lineups list. */
  private async lineupsTeamCardPresent(
    page: Page,
    teamName: string,
    opponentName?: string,
  ): Promise<boolean> {
    try {
      return await evaluateTimed<boolean>(
        page,
        this.lineupsTeamCardScript(teamName, "find", opponentName),
        8_000,
      );
    } catch {
      return false;
    }
  }

  /**
   * Find the Home-vs-Away match row (plain text, not a combobox option).
   * `find` only locates; `click` clicks the row itself — names are not buttons.
   */
  private lineupsTeamCardScript(
    teamName: string,
    mode: "find" | "click",
    opponentName?: string,
  ): string {
    return `() => {
      const match = ${LINEUP_TEAM_LABELS_MATCH_SOURCE};
      const want = ${JSON.stringify(teamName)};
      const opponent = ${JSON.stringify(opponentName || "")};
      const skipSel =
        "[data-combobox-dropdown], [data-combobox-option], [data-combobox-target], [role='combobox'], .mantine-Select-dropdown, .mantine-Combobox-dropdown, .mantine-Combobox-option, input, [data-modal-content], .mantine-Modal-content";
      const accordionSel =
        "[data-accordion-control], .mantine-Accordion-control";
      const textOf = (el) =>
        String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      let best = null;
      let bestScore = -1;
      const nodes = document.querySelectorAll(
        "div, li, article, section, a, button, tr, p, span, h3, h4, strong",
      );
      for (const el of nodes) {
        if (!(el instanceof HTMLElement) || el.closest(skipSel)) continue;
        if (el.matches(accordionSel)) continue;
        const t = textOf(el);
        if (t.length < 8 || t.length > 500) continue;
        if (!match(t, want)) continue;
        let score = Math.max(0, 220 - t.length);
        if (/\\bvs\\.?\\b/i.test(t)) score += 140;
        if (opponent && match(t, opponent)) score += 40;
        const r = el.getBoundingClientRect();
        if (r.width >= 4 && r.height >= 8) score += 20;
        if (el.closest("[data-accordion-panel], .mantine-Accordion-panel, .mantine-Accordion-content, .mantine-Accordion-item")) {
          score += 30;
        }
        if (el.closest(accordionSel)) score -= 120;
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }
      if (!best) return false;
      if (${mode === "click" ? "true" : "false"}) {
        let target = best;
        if (!/\\bvs\\.?\\b/i.test(textOf(best))) {
          let p = best.parentElement;
          for (let i = 0; i < 10 && p; i += 1) {
            const pt = textOf(p);
            if (/\\bvs\\.?\\b/i.test(pt) && pt.length <= 500 && match(pt, want)) {
              target = p;
              break;
            }
            p = p.parentElement;
          }
        }
        target.scrollIntoView({ block: "center", inline: "nearest" });
        let scroller = target.parentElement;
        while (scroller) {
          const cs = getComputedStyle(scroller);
          if (/(auto|scroll)/.test(cs.overflowY) && scroller.scrollHeight > scroller.clientHeight + 2) {
            const r = target.getBoundingClientRect();
            const pr = scroller.getBoundingClientRect();
            scroller.scrollTop += r.top - pr.top - pr.height / 2 + r.height / 2;
          }
          scroller = scroller.parentElement;
        }
        target.click();
        target.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }
      return true;
    }`;
  }

  private teamNameClickVariants(teamName: string): string[] {
    const raw = teamName.trim();
    const noFc = raw.replace(/\s+(fc|afc|cf|sc)\.?$/i, "").trim();
    const words = noFc.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    const add = (value: string) => {
      const t = value.trim();
      if (t.length < 4) return;
      if (!out.some((item) => item.toLowerCase() === t.toLowerCase())) out.push(t);
    };
    add(raw);
    add(noFc);
    if (words.length >= 2) add(words.slice(0, 2).join(" "));
    if (words.length >= 3 && words[0] && words[1]) {
      add(`${words[0]} ${words[1].slice(0, 4)}`.trim());
    }
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
    if (!present) {
      const league = options.leagueName ? ` in ${options.leagueName}` : "";
      throw new Error(
        `No clickable "${teamName}" match on the lineups list${league} after expanding the league.`,
      );
    }

    const clicked = await this.clickVisibleMatchRow(page, teamName);
    if (!clicked) {
      await evaluateTimed<boolean>(
        page,
        this.lineupsTeamCardScript(teamName, "click", options.opponentName),
        8_000,
      ).catch(() => false);
    }
    await sleep(400);
    const modal = page
      .locator("[data-modal-content], .mantine-Modal-content")
      .first();
    if (await modal.isVisible().catch(() => false)) return;
    throw new Error(
      `Clicked "${teamName}" on the lineups list but the lineup popup did not open.`,
    );
  }

  /** Click the visible vs-row that contains the club name (plain text is fine). */
  private async clickVisibleMatchRow(
    page: Page,
    teamName: string,
  ): Promise<boolean> {
    for (const label of this.teamNameClickVariants(teamName)) {
      const name = page.getByText(label, { exact: false }).first();
      if (!(await name.isVisible().catch(() => false))) continue;
      const row = name.locator(
        'xpath=ancestor::*[contains(translate(normalize-space(.), "VS", "vs"), " vs ")][1]',
      );
      const target = (await row.count().catch(() => 0)) > 0 ? row : name;
      await target
        .click({ timeout: 4_000, force: true })
        .catch(async () => {
          await target.evaluate(`(el) => {
            if (!(el instanceof HTMLElement)) return;
            el.click();
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          }`);
        });
      return true;
    }
    return false;
  }

  private leagueAccordionNeedles(league: SorareInsideLeague): string[] {
    const raw = [
      league.competitionName,
      league.label,
      league.competitionName.split(" ").slice(-2).join(" "),
    ];
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

  private leagueAccordionControl(
    page: Page,
    league: SorareInsideLeague,
  ): ReturnType<Page["locator"]> {
    const needles = this.leagueAccordionNeedles(league);
    const re = new RegExp(
      needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "i",
    );
    const item = page
      .locator("[data-accordion-item], .mantine-Accordion-item")
      .filter({ hasText: re })
      .first();
    return item
      .locator("[data-accordion-control], .mantine-Accordion-control")
      .first()
      .or(
        page
          .locator("[data-accordion-control], .mantine-Accordion-control")
          .filter({ hasText: re })
          .first(),
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
  ): Promise<void> {
    this.setStatus({
      state: "running",
      message: `Expanding ${league.competitionName}…`,
      currentUrl: page.url(),
    });

    await this.resetLineupsScroll(page);
    await this.scrollToLoadLazyContent(page, {
      message: `Scrolling to ${league.competitionName} to expand the league…`,
      untilCheck: async () =>
        (await this.leagueAccordionControl(page, league).count()) > 0,
      requireUntil: true,
      untilMissError: `Could not find "${league.competitionName}" league accordion on the lineups page.`,
    });

    const control = this.leagueAccordionControl(page, league);
    if (!(await control.count())) {
      throw new Error(
        `Could not find "${league.competitionName}" league accordion on the lineups page.`,
      );
    }
    const expanded = await control.getAttribute("aria-expanded");
    if (expanded !== "true") {
      await control.click({ timeout: 5_000 });
      await sleep(500);
    }
    const still = await control.getAttribute("aria-expanded");
    if (still === "false") {
      await control.click({ timeout: 5_000 }).catch(() => {});
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
      message: `Expanding league for ${teamName}…`,
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

      const league = this.leagues.find((item) => item.id === match.leagueId);
      if (!league) {
        throw new Error(
          `Unknown league for ${teamName}. Expand selected leagues first.`,
        );
      }
      await this.expandLeagueAccordion(page, league);

      const opponent =
        request.side === "home" ? match.away.teamName : match.home.teamName;
      await this.scrollToLoadLazyContent(page, {
        message: `Scrolling expanded ${league.competitionName} for ${teamName}…`,
        untilText: teamName,
        untilOpponent: opponent,
        requireUntil: true,
        untilMissError:
          `No clickable "${teamName}" match on the ${league.competitionName} lineups list after expanding the league.`,
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

let sharedSession: SorareInsideSession | null = null;

export function getSorareInsideSession(): SorareInsideSession {
  if (!sharedSession) sharedSession = new SorareInsideSession();
  return sharedSession;
}

export type { SorareInsideCaptureRequest };
