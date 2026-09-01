import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";
import {
  expected11LaunchOptions,
  isExpected11GoogleAuthControl,
  isExpected11LoggedIn,
  isExpected11PasswordAuthControl,
  isExpected11SessionCookieName,
} from "./runExpected11.js";

test("fallback launch options hide Playwright automation flags", () => {
  const headed = expected11LaunchOptions(false, true);
  assert.equal(headed.channel, "chrome");
  assert.deepEqual(headed.ignoreDefaultArgs, ["--enable-automation"]);
  assert.ok(headed.args.includes("--disable-blink-features=AutomationControlled"));
  assert.ok(!headed.args.includes("--enable-automation"));

  const docker = expected11LaunchOptions(true, false);
  assert.equal(docker.channel, undefined);
  assert.ok(docker.args.includes("--headless=new"));
  assert.deepEqual(docker.ignoreDefaultArgs, ["--enable-automation"]);
});

test("password login prefers email form over Google SSO", () => {
  assert.equal(isExpected11GoogleAuthControl("Continue with Google"), true);
  assert.equal(isExpected11GoogleAuthControl("Sign in with Gmail"), true);
  assert.equal(isExpected11GoogleAuthControl("https://accounts.google.com"), true);
  assert.equal(isExpected11PasswordAuthControl("Continue with Google"), false);
  assert.equal(isExpected11PasswordAuthControl("Sign in with email"), true);
  assert.equal(isExpected11PasswordAuthControl("Use password"), true);
  assert.equal(isExpected11PasswordAuthControl("Continue"), false);
});

test("match load bypasses HTTP cache and waits for percentages to settle", () => {
  const source = readFileSync(new URL("./runExpected11.ts", import.meta.url), "utf8");
  assert.match(source, /Network\.setCacheDisabled/);
  assert.match(source, /percentageSignature/);
  assert.match(source, /goto\("about:blank"/);
});

test("tsx keepNames does not inject __name into Playwright evaluate payloads", () => {
  const source = readFileSync(new URL("./runExpected11.ts", import.meta.url), "utf8");
  const { code } = transformSync(source, {
    loader: "ts",
    format: "esm",
    minifyWhitespace: true,
    keepNames: true,
  });
  const payloads = [
    ...code.matchAll(/\.evaluate\((`[\s\S]*?`)/g),
    ...code.matchAll(/\.evaluate\(("\("\+)/g),
  ];
  assert.ok(payloads.length >= 3, "expected string Playwright evaluate payloads");
  for (const match of payloads) {
    assert.equal(
      match[1]?.includes("__name(") ?? false,
      false,
      `Playwright evaluate payload contains tsx __name helper: ${match[1]?.slice(0, 240)}`,
    );
  }
});

test("login wait treats sign-in page as logged out until session leaves it", () => {
  assert.equal(isExpected11SessionCookieName("__session"), true);
  assert.equal(isExpected11SessionCookieName("next-auth.session-token"), true);
  assert.equal(isExpected11SessionCookieName("csrf-token"), false);

  assert.equal(
    isExpected11LoggedIn({
      url: "https://expected11.com/sign-in",
      cookieNames: [],
      signedOutVisible: false,
      signedInVisible: false,
      passwordFieldVisible: true,
    }),
    false,
  );
  assert.equal(
    isExpected11LoggedIn({
      url: "https://expected11.com/sign-in",
      cookieNames: ["__session"],
      signedOutVisible: true,
      signedInVisible: false,
      passwordFieldVisible: false,
    }),
    false,
  );
  assert.equal(
    isExpected11LoggedIn({
      url: "https://expected11.com/sign-in",
      cookieNames: [],
      signedOutVisible: false,
      signedInVisible: true,
      passwordFieldVisible: false,
    }),
    true,
  );
  assert.equal(
    isExpected11LoggedIn({
      url: "https://expected11.com/",
      cookieNames: ["__session"],
      signedOutVisible: false,
      signedInVisible: false,
      passwordFieldVisible: false,
    }),
    true,
  );
  assert.equal(
    isExpected11LoggedIn({
      url: "about:blank",
      cookieNames: ["__session"],
      signedOutVisible: false,
      signedInVisible: false,
      passwordFieldVisible: false,
    }),
    false,
  );
});
