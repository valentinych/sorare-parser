import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  collectExpected11Snapshot,
  normalizeExpected11Snapshot,
  type Expected11Match,
  type Expected11Snapshot,
} from "../domain/expected11.js";

const usage = `Usage:
  npm run expected11 -- [--diagnostic] [--screenshot] <expected11-match-url> [more-match-urls...]

Example:
  npm run expected11 -- --diagnostic --screenshot https://expected11.com/match/19729166/wolverhampton-wanderers-vs-blackburn-rovers`;

export function parseExpected11MatchUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Not an expected11.com match URL: ${value}`);
  }
  if (
    url.protocol !== "https:" ||
    !["expected11.com", "www.expected11.com"].includes(url.hostname) ||
    Boolean(url.username || url.password || url.port) ||
    !/^\/match\/\d+(?:\/|$)/.test(url.pathname)
  ) {
    throw new Error(`Not an expected11.com match URL: ${value}`);
  }
  url.hash = "";
  return url.toString();
}

function defaultHeadless(): boolean {
  if (process.env.EXPECTED11_HEADLESS === "1") return true;
  if (process.env.EXPECTED11_HEADLESS === "0") return false;
  return process.platform === "linux" && !process.env.DISPLAY;
}

const MAC_CHROME_BINARY =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_CDP_PORT = 9222;
export const EXPECTED11_SIGN_IN_URL = "https://expected11.com/sign-in";
export const EXPECTED11_GOOGLE_AUTH_PATTERN =
  "google|gmail|accounts\\.google";
export const EXPECTED11_PASSWORD_AUTH_PATTERN =
  "email|e-mail|password|парол|почт|sign in with email|continue with email|use email|use password";

type Expected11Context = {
  pages(): readonly Page[];
  newPage(): Promise<Page>;
  close(): Promise<void>;
};

export function isExpected11BrowserUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /executable doesn't exist|browserType\.launch|playwright.*chromium|Chrome remote debugging|Google Chrome exited/i.test(
    message,
  );
}

function isChromeChannelMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Chromium distribution ['"]chrome['"] is not found/i.test(message);
}

export function installedChromeBinary(): string | null {
  return existsSync(MAC_CHROME_BINARY) ? MAC_CHROME_BINARY : null;
}

export function isExpected11GoogleAuthControl(label: string): boolean {
  return new RegExp(EXPECTED11_GOOGLE_AUTH_PATTERN, "i").test(label);
}

export function isExpected11PasswordAuthControl(label: string): boolean {
  if (isExpected11GoogleAuthControl(label)) return false;
  return new RegExp(EXPECTED11_PASSWORD_AUTH_PATTERN, "i").test(label);
}

export type Expected11AuthSignals = {
  url: string;
  cookieNames: string[];
  signedOutVisible: boolean;
  signedInVisible: boolean;
  passwordFieldVisible: boolean;
};

export function isExpected11SessionCookieName(name: string): boolean {
  return /session|__session|^sid$|ssid|auth_token|access_token|refresh_token|sb-.*-auth|clerk|next-auth\.session|authjs\.session/i.test(
    name,
  );
}

export function isExpected11LoggedIn(signals: Expected11AuthSignals): boolean {
  if (/accounts\.google\.com/i.test(signals.url)) return false;
  if (signals.passwordFieldVisible || signals.signedOutVisible) return false;

  let onExpected11 = false;
  let onSignIn = false;
  try {
    const url = new URL(signals.url);
    onExpected11 =
      url.protocol === "https:" &&
      ["expected11.com", "www.expected11.com"].includes(url.hostname);
    onSignIn = onExpected11 && /^\/sign-in(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
  if (!onExpected11) return false;
  const hasSessionCookie = signals.cookieNames.some(isExpected11SessionCookieName);
  if (signals.signedInVisible || (hasSessionCookie && !onSignIn)) return true;
  if (onSignIn) return false;
  return true;
}

export function expected11LaunchOptions(headless: boolean, useInstalledChrome: boolean) {
  return {
    ...(useInstalledChrome ? { channel: "chrome" as const } : {}),
    headless,
    viewport: headless ? { width: 1400, height: 900 } : null,
    timeout: 45_000,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-restore-last-session",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--disable-blink-features=AutomationControlled",
      ...(headless ? ["--headless=new"] : []),
    ],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resetChromeSessionRestore(profileDir: string): Promise<void> {
  const defaultDir = resolve(profileDir, "Default");
  for (const name of ["Current Session", "Last Session", "Current Tabs", "Last Tabs"]) {
    await unlink(resolve(defaultDir, name)).catch(() => {});
  }
  const sessionFiles = await readdir(resolve(defaultDir, "Sessions")).catch(() => []);
  for (const file of sessionFiles) {
    await unlink(resolve(defaultDir, "Sessions", file)).catch(() => {});
  }
  try {
    const prefsPath = resolve(defaultDir, "Preferences");
    const prefs = JSON.parse(await readFile(prefsPath, "utf8")) as {
      profile?: { exit_type?: string; exited_cleanly?: boolean };
    };
    if (!prefs.profile) return;
    prefs.profile.exit_type = "Normal";
    prefs.profile.exited_cleanly = true;
    await writeFile(prefsPath, JSON.stringify(prefs));
  } catch {
    // Fresh profiles have no Preferences yet.
  }
}

async function closeExtraPages(context: Expected11Context, keep: Page): Promise<void> {
  for (const extra of [...context.pages()]) {
    if (extra === keep || extra.isClosed()) continue;
    await extra.close().catch(() => {});
  }
}

async function keepSinglePage(context: Expected11Context): Promise<Page> {
  const deadline = Date.now() + 2_500;
  let lastCount = -1;
  let stableAt = Date.now();
  while (Date.now() < deadline) {
    const count = context.pages().length;
    if (count !== lastCount) {
      lastCount = count;
      stableAt = Date.now();
    } else if (count > 0 && Date.now() - stableAt >= 400) {
      break;
    }
    await sleep(150);
  }
  const page = context.pages()[0] ?? (await context.newPage());
  await closeExtraPages(context, page);
  return page;
}

async function readAuthSignals(page: Page): Promise<Expected11AuthSignals> {
  let cookieNames: string[] = [];
  try {
    cookieNames = (await page.context().cookies("https://expected11.com")).map(
      (cookie) => cookie.name,
    );
  } catch {
    cookieNames = [];
  }
  const emptyDom = {
    signedOutVisible: false,
    signedInVisible: false,
    passwordFieldVisible: false,
  };
  const dom = (await page
    .evaluate(
      `({
        signedOutVisible: Boolean(
          document.querySelector(
            'a[href="/sign-in"], a[href^="/sign-in?"], .layout-auth-controls__signed-out'
          )
        ),
        signedInVisible: Boolean(
          document.querySelector(
            '.layout-auth-controls__signed-in, a[href="/account"], a[href="/profile"], [class*="user-menu"], [aria-label*="account" i], [aria-label*="profile" i]'
          )
        ),
        passwordFieldVisible: Boolean(document.querySelector('input[type="password"]'))
      })`,
    )
    .catch(() => emptyDom)) as typeof emptyDom;
  return { url: page.url(), cookieNames, ...dom };
}

async function pageIsLoggedIn(page: Page): Promise<boolean> {
  try {
    if (/expected11\.com\/match\//i.test(page.url())) return false;
    return isExpected11LoggedIn(await readAuthSignals(page));
  } catch {
    return false;
  }
}

async function openExpected11SignIn(page: Page): Promise<void> {
  if (/expected11\.com\/sign-in/i.test(page.url())) return;
  await page.goto(EXPECTED11_SIGN_IN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
}

async function waitForExpected11Login(
  page: Page,
  context: Expected11Context,
  waitForManualLogin: (url: string) => Promise<void>,
): Promise<void> {
  if (await pageIsLoggedIn(page)) return;

  let stop = false;
  const detected = (async () => {
    while (!stop) {
      await closeExtraPages(context, page);
      if (/expected11\.com\/match\//i.test(page.url())) {
        await openExpected11SignIn(page).catch(() => {});
        await sleep(400);
        continue;
      }
      if (await pageIsLoggedIn(page)) return;
      await sleep(400);
    }
  })();

  await Promise.race([
    detected,
    waitForManualLogin(EXPECTED11_SIGN_IN_URL).finally(() => {
      stop = true;
    }),
  ]);
  stop = true;
  await closeExtraPages(context, page);
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function pickCdpPort(): Promise<number> {
  if (await isPortFree(DEFAULT_CDP_PORT)) return DEFAULT_CDP_PORT;
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.once("error", reject);
  });
}

async function waitForCdp(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Chrome remote debugging did not start on port ${port}: ${lastError}`);
}

async function stopChrome(chrome: ChildProcess): Promise<void> {
  if (chrome.exitCode != null || chrome.signalCode != null) return;
  chrome.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (chrome.exitCode == null && chrome.signalCode == null) {
        chrome.kill("SIGKILL");
      }
      resolve();
    }, 4_000);
    chrome.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function wrapCdpContext(
  context: BrowserContext,
  browser: Browser,
  chrome: ChildProcess,
): Expected11Context {
  return {
    pages: () => context.pages(),
    newPage: () => context.newPage(),
    close: async () => {
      try {
        await browser.close();
      } catch {
        // Disconnect can fail if Chrome already exited.
      }
      await stopChrome(chrome);
    },
  };
}

async function launchInstalledChromeOverCdp(
  chromeBinary: string,
  chromeProfileDir: string,
  initialUrl: string,
): Promise<Expected11Context> {
  const port = await pickCdpPort();
  const chrome = spawn(
    chromeBinary,
    [
      `--user-data-dir=${chromeProfileDir}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-restore-last-session",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      initialUrl,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    await waitForCdp(port);
    if (chrome.exitCode != null || chrome.signalCode != null) {
      throw new Error(
        `Google Chrome exited before CDP was ready (${chrome.exitCode ?? chrome.signalCode})`,
      );
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Chrome CDP connected but has no browser context.");
    }
    process.stdout.write(
      `Connected to installed Google Chrome over CDP on port ${port}.\n`,
    );
    return wrapCdpContext(context, browser, chrome);
  } catch (error) {
    await stopChrome(chrome);
    throw error;
  }
}

async function launchExpected11Context(
  projectRoot: string,
  headless: boolean,
  openSignIn: boolean,
): Promise<Expected11Context> {
  const chromeProfileDir = resolve(projectRoot, "data/expected11/chrome-profile");
  const chromeBinary = installedChromeBinary();
  const initialUrl = openSignIn ? EXPECTED11_SIGN_IN_URL : "about:blank";
  process.stdout.write(
    `Launching Expected11 Google Chrome (${headless ? "headless" : "headed"})…\n`,
  );
  await mkdir(chromeProfileDir, { recursive: true });
  await resetChromeSessionRestore(chromeProfileDir);
  if (!headless && chromeBinary) {
    try {
      return await launchInstalledChromeOverCdp(
        chromeBinary,
        chromeProfileDir,
        initialUrl,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`CDP Chrome failed (${message}); using Playwright fallback…\n`);
    }
  }
  try {
    return await chromium.launchPersistentContext(
      chromeProfileDir,
      expected11LaunchOptions(headless, true),
    );
  } catch (error) {
    if (process.platform !== "linux" || !isChromeChannelMissing(error)) {
      throw error;
    }
    process.stdout.write(
      "Installed Chrome not found; falling back to bundled Chromium…\n",
    );
    return await chromium.launchPersistentContext(
      resolve(projectRoot, "data/expected11/profile"),
      expected11LaunchOptions(headless, false),
    );
  }
}

async function revealExpected11PasswordForm(page: Page): Promise<void> {
  await page.evaluate(
    `(() => {
      const googleRe = new RegExp(${JSON.stringify(EXPECTED11_GOOGLE_AUTH_PATTERN)}, "i");
      const passwordRe = new RegExp(${JSON.stringify(EXPECTED11_PASSWORD_AUTH_PATTERN)}, "i");
      if (document.querySelector('input[type="password"]')) return;
      const controls = [...document.querySelectorAll("a, button, [role='button']")];
      for (const element of controls) {
        const label = [
          element.textContent,
          element.getAttribute("href"),
          element.getAttribute("aria-label"),
          element.getAttribute("data-provider"),
        ].filter(Boolean).join(" ");
        if (passwordRe.test(label) && !googleRe.test(label) && element instanceof HTMLElement) {
          element.click();
          return;
        }
      }
    })()`,
  );
}

export async function prepareExpected11PasswordLogin(page: Page): Promise<void> {
  const currentUrl = page.url();
  if (
    /accounts\.google\.com/i.test(currentUrl) ||
    !/expected11\.com\/sign-in/i.test(currentUrl)
  ) {
    await page.goto(EXPECTED11_SIGN_IN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
  }
  await revealExpected11PasswordForm(page);

  const email = page
    .locator(
      'input[type="email"], input[name="email"], input[autocomplete="username"]',
    )
    .first();
  const password = page.locator('input[type="password"]').first();
  try {
    await email.waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    // Site may still be rendering; user can finish in the headed window.
  }
  if (!(await password.isVisible().catch(() => false))) {
    await revealExpected11PasswordForm(page);
    try {
      await password.waitFor({ state: "visible", timeout: 8_000 });
    } catch {
      // Leave the headed sign-in page as-is for manual password entry.
    }
  }

  const envEmail = process.env.EXPECTED11_EMAIL?.trim();
  const envPassword = process.env.EXPECTED11_PASSWORD;
  if (envEmail && (await email.isVisible().catch(() => false))) {
    await email.fill(envEmail);
  }
  if (envPassword && (await password.isVisible().catch(() => false))) {
    await password.fill(envPassword);
  }
  if (await password.isVisible().catch(() => false)) {
    await password.focus();
  } else if (await email.isVisible().catch(() => false)) {
    await email.focus();
  }
  process.stdout.write(
    "Opened Expected11 email/password sign-in. Do not use Continue with Google.\n",
  );
}

type MatchReadyState = {
  loading: boolean;
  playerCount: number;
  percentageSignature: string;
  signIn: boolean;
  accessCta: boolean;
};

async function matchReadyState(page: Page): Promise<MatchReadyState> {
  return page.evaluate(`({
    loading: Boolean(
      document.querySelector(
        ".match-view--loading, [aria-label='Loading home team squad'], [aria-label='Loading away team squad']"
      )
    ),
    playerCount: document.querySelectorAll('a[href*="/player/"]').length,
    percentageSignature: Array.from(document.querySelectorAll("span"))
      .map((el) => (el.textContent || "").replace(/\\s+/g, ""))
      .filter((text) => /^\\d+(?:\\.\\d+)?%$/.test(text))
      .join(","),
    signIn: Boolean(
      document.querySelector(
        'a[href="/sign-in"], a[href^="/sign-in?"], .layout-auth-controls__signed-out'
      )
    ),
    accessCta: Boolean(document.querySelector(".lineup-access-cta"))
  })`) as Promise<MatchReadyState>;
}

async function disableHttpCache(page: Page): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Network.enable");
    await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  } catch {
    // CDP cache control is missing in some Playwright fallbacks.
  }
}

async function loadMatch(page: Page, url: string): Promise<void> {
  await disableHttpCache(page);
  if (page.url() !== "about:blank") {
    await page
      .goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15_000 })
      .catch(() => {});
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const deadline = Date.now() + 25_000;
  let lastSignature = "";
  let stableAt = 0;
  while (Date.now() < deadline) {
    const ready = await matchReadyState(page);
    if (ready.accessCta) return;
    const signature = `${ready.playerCount}|${ready.percentageSignature}`;
    if (ready.playerCount > 0 && signature === lastSignature) {
      if (stableAt && Date.now() - stableAt >= 1_200) return;
      if (!stableAt) stableAt = Date.now();
    } else {
      lastSignature = signature;
      stableAt = ready.playerCount > 0 ? Date.now() : 0;
    }
    if (!ready.loading && ready.playerCount === 0 && !ready.percentageSignature) {
      return;
    }
    await sleep(400);
  }
}

async function askForManualLogin(_url: string): Promise<void> {
  console.log(`
Opened ${EXPECTED11_SIGN_IN_URL} only. Sign in with email and password
(not Continue with Google). Do not close the browser. Match URLs will open
one at a time after login.`);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  await readline.question("\nPress Enter after you are signed in...");
  readline.close();
}

function failedMatch(url: string, extractedAt: string, error: unknown): Expected11Match {
  return {
    sourceUrl: url,
    extractedAt,
    status: "no-predictions",
    match: {
      id: new URL(url).pathname.match(/^\/match\/(\d+)/)?.[1] ?? null,
      title: "",
      homeTeam: null,
      awayTeam: null,
      formations: [],
    },
    teams: [],
    players: [],
    diagnostics: {
      accessMessage: null,
      signInVisible: false,
      pageLoading: false,
      headings: [],
      visibleLineupCount: 0,
      restrictedPositionCount: 0,
      rawPlayerCandidateCount: 0,
      warnings: [error instanceof Error ? error.message : String(error)],
    },
  };
}

export type Expected11Output = {
  schemaVersion: 2;
  extractedAt: string;
  matches: Expected11Match[];
};

export type Expected11RunProgress = {
  phase: "opening" | "waiting-login" | "match-complete";
  completed: number;
  total: number;
  currentUrl: string;
  message: string;
};

export type Expected11RunOptions = {
  urls: string[];
  diagnostic?: boolean;
  /** Save PNG clips of green lineup pitches per match. */
  screenshot?: boolean;
  /** Selected tour — green screenshots as `{tour}/{club}.png`. */
  tour?: number;
  headless?: boolean;
  promptForLogin?: boolean;
  extractedAt?: string;
  onProgress?: (progress: Expected11RunProgress) => void;
  waitForManualLogin?: (url: string) => Promise<void>;
};

export type Expected11RunResult = {
  outputPath: string;
  output: Expected11Output;
  hasFailures: boolean;
};

export async function runExpected11(
  options: Expected11RunOptions,
): Promise<Expected11RunResult> {
  const urls = options.urls.map(parseExpected11MatchUrl);
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const outputDir = resolve(projectRoot, "data/expected11/output");
  const extractedAt = options.extractedAt ?? new Date().toISOString();
  const outputPath = resolve(
    outputDir,
    `expected11-${extractedAt.replace(/[:.]/g, "-")}.json`,
  );
  const headless = options.headless ?? defaultHeadless();
  const promptForLogin =
    options.promptForLogin ??
    (options.waitForManualLogin != null || Boolean(process.stdin.isTTY));

  await mkdir(outputDir, { recursive: true });
  const context = await launchExpected11Context(projectRoot, headless, promptForLogin);
  const results: Expected11Match[] = [];

  try {
    const page = await keepSinglePage(context);
    if (promptForLogin) {
      await closeExtraPages(context, page);
      await openExpected11SignIn(page);
      await closeExtraPages(context, page);
      if (await pageIsLoggedIn(page)) {
        process.stdout.write(
          "Expected11 session already present; skipping login wait.\n",
        );
      } else {
        await prepareExpected11PasswordLogin(page);
        options.onProgress?.({
          phase: "waiting-login",
          completed: 0,
          total: urls.length,
          currentUrl: EXPECTED11_SIGN_IN_URL,
          message: "Waiting for Expected11 email/password login in Chrome",
        });
        await waitForExpected11Login(
          page,
          context,
          options.waitForManualLogin ?? askForManualLogin,
        );
        process.stdout.write("Login confirmed; opening matches one at a time.\n");
      }
    }

    for (const [index, url] of urls.entries()) {
      try {
        await closeExtraPages(context, page);
        console.log(`Opening ${url}`);
        options.onProgress?.({
          phase: "opening",
          completed: index,
          total: urls.length,
          currentUrl: url,
          message: `Opening match ${index + 1} of ${urls.length}`,
        });
        await loadMatch(page, url);
        if (options.screenshot) {
          const { captureGreenDuringRun } = await import(
            "./captureExpected11Screenshot.js"
          );
          const shots = await captureGreenDuringRun(
            page,
            url,
            extractedAt,
            options.tour,
          );
          if (shots.length) {
            const names = shots.map((s) => s.relativePath).join(", ");
            console.log(
              `Saved ${shots.length} screenshot(s) for ${url}: ${names}`,
            );
          }
        }
        const snapshot = (await page.evaluate(
          "(" +
            collectExpected11Snapshot.toString() +
            ")(document.body, " +
            JSON.stringify({ sourceUrl: url, extractedAt }) +
            ")",
        )) as Expected11Snapshot;

        const match = normalizeExpected11Snapshot(snapshot);
        results.push(match);
        const message =
          `${match.status === "ok" ? "Extracted" : "No predictions found"}: ` +
          `${match.teams.length} teams, ${match.players.length} players`;
        console.log(message);
        options.onProgress?.({
          phase: "match-complete",
          completed: index + 1,
          total: urls.length,
          currentUrl: url,
          message,
        });
        if (options.diagnostic) {
          console.log(
            JSON.stringify(
              {
                url,
                status: match.status,
                diagnostics: match.diagnostics,
              },
              null,
              2,
            ),
          );
        }
      } catch (error) {
        const failed = failedMatch(url, extractedAt, error);
        results.push(failed);
        console.error(`Failed ${url}: ${failed.diagnostics.warnings[0]}`);
        options.onProgress?.({
          phase: "match-complete",
          completed: index + 1,
          total: urls.length,
          currentUrl: url,
          message: `Failed: ${failed.diagnostics.warnings[0]}`,
        });
      }
    }
  } finally {
    await context.close();
  }

  const output: Expected11Output = {
    schemaVersion: 2,
    extractedAt,
    matches: results,
  };
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);

  return {
    outputPath,
    output,
    hasFailures: results.some((match) => match.status !== "ok"),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }

  const diagnostic = args.includes("--diagnostic");
  const screenshot = args.includes("--screenshot");
  const urlArgs = args.filter(
    (arg) => arg !== "--diagnostic" && arg !== "--screenshot",
  );
  if (urlArgs.length === 0) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await runExpected11({ urls: urlArgs, diagnostic, screenshot });
    if (result.hasFailures) {
      console.error(
        "One or more pages had no visible predictions. Re-run with --diagnostic after checking login/access in the opened browser.",
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
