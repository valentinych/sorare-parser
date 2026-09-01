import assert from "node:assert/strict";
import test from "node:test";
import {
  config,
  hasExpected11PremiumAccess,
  hasLiveDraftAccess,
} from "./config.js";

test("Expected11 entitlement compares normalized allowlisted emails", () => {
  const originalPremium = new Set(config.expected11PremiumEmails);
  const originalDraft = new Set(config.liveDraftEmails);
  config.expected11PremiumEmails.clear();
  config.liveDraftEmails.clear();
  config.expected11PremiumEmails.add("owner@example.com");
  try {
    assert.equal(hasExpected11PremiumAccess(" Owner@Example.COM "), true);
    assert.equal(hasExpected11PremiumAccess("other@example.com"), false);
    assert.equal(hasExpected11PremiumAccess(null), false);
  } finally {
    config.expected11PremiumEmails.clear();
    config.liveDraftEmails.clear();
    for (const email of originalPremium) config.expected11PremiumEmails.add(email);
    for (const email of originalDraft) config.liveDraftEmails.add(email);
  }
});

test("Expected11 premium includes LIVE_DRAFT_EMAILS without expanding live-draft", () => {
  const originalPremium = new Set(config.expected11PremiumEmails);
  const originalDraft = new Set(config.liveDraftEmails);
  config.expected11PremiumEmails.clear();
  config.liveDraftEmails.clear();
  config.expected11PremiumEmails.add("owner@example.com");
  config.liveDraftEmails.add("draft@example.com");
  try {
    assert.equal(hasExpected11PremiumAccess("draft@example.com"), true);
    assert.equal(hasExpected11PremiumAccess("owner@example.com"), true);
    assert.equal(hasExpected11PremiumAccess("other@example.com"), false);
    assert.equal(hasLiveDraftAccess("owner@example.com"), false);
    assert.equal(hasLiveDraftAccess("draft@example.com"), true);
  } finally {
    config.expected11PremiumEmails.clear();
    config.liveDraftEmails.clear();
    for (const email of originalPremium) config.expected11PremiumEmails.add(email);
    for (const email of originalDraft) config.liveDraftEmails.add(email);
  }
});

test("live draft entitlement denies everyone when the allowlist is empty", () => {
  const original = new Set(config.liveDraftEmails);
  config.liveDraftEmails.clear();
  try {
    assert.equal(hasLiveDraftAccess("owner@example.com"), false);
    assert.equal(hasLiveDraftAccess(" Owner@Example.COM "), false);
    assert.equal(hasLiveDraftAccess(null), false);
  } finally {
    for (const email of original) config.liveDraftEmails.add(email);
  }
});

test("live draft entitlement compares normalized allowlisted emails", () => {
  const original = new Set(config.liveDraftEmails);
  config.liveDraftEmails.clear();
  config.liveDraftEmails.add("owner@example.com");
  try {
    assert.equal(hasLiveDraftAccess(" Owner@Example.COM "), true);
    assert.equal(hasLiveDraftAccess("other@example.com"), false);
    assert.equal(hasLiveDraftAccess(null), false);
  } finally {
    config.liveDraftEmails.clear();
    for (const email of original) config.liveDraftEmails.add(email);
  }
});
