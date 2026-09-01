import assert from "node:assert/strict";
import test from "node:test";
import {
  googleSignInEnabled,
  liveDraftAccess,
  liveDraftCopy,
} from "../../public-tm/live-draft-access.js";

test("session present is logged in even when googleConfigured is false", () => {
  assert.equal(
    liveDraftAccess({
      authenticated: true,
      googleConfigured: false,
      liveDraft: true,
    }),
    "ready",
  );
  assert.equal(
    googleSignInEnabled({ authenticated: true, googleConfigured: false }),
    true,
  );
  assert.doesNotMatch(
    liveDraftCopy("ready").copy,
    /Google-вход не настроен/,
  );
  assert.doesNotMatch(liveDraftCopy("ready").meta, /вход не настроен/i);
  assert.match(liveDraftCopy("ready").hint, /15 секунд/);
});

test("401 vs 403 copy and unconfigured only without a session", () => {
  assert.equal(
    liveDraftAccess({
      authenticated: true,
      googleConfigured: true,
      liveDraft: false,
    }),
    "forbidden",
  );
  assert.match(liveDraftCopy("forbidden").meta, /Нет доступа/);
  assert.match(liveDraftCopy("forbidden").copy, /Нет доступа/);
  assert.doesNotMatch(liveDraftCopy("forbidden").copy, /вход не настроен/i);

  assert.equal(
    liveDraftAccess({
      authenticated: false,
      googleConfigured: true,
      liveDraft: false,
    }),
    "login",
  );
  assert.equal(liveDraftCopy("login").showLogin, true);

  assert.equal(
    liveDraftAccess({
      authenticated: false,
      googleConfigured: false,
      liveDraft: false,
    }),
    "unconfigured",
  );
  assert.match(liveDraftCopy("unconfigured").copy, /Google-вход не настроен/);
});
