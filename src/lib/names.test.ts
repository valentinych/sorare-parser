import assert from "node:assert/strict";
import test from "node:test";
import { nameMatchScore, normName } from "./names.js";

test("normName maps Turkish ı/İ/ş/ğ/ü/ö/ç to ASCII", () => {
  assert.equal(normName("Kasımpaşa"), "kasimpasa");
  assert.equal(normName("İstanbul Başakşehir"), "istanbul basaksehir");
  assert.equal(normName("Çaykur Rizespor"), "caykur rizespor");
  assert.equal(normName("Göztepe"), "goztepe");
  assert.equal(normName("Gençlerbirliği"), "genclerbirligi");
  assert.equal(normName("Beşiktaş"), "besiktas");
  assert.equal(normName("Fenerbahçe"), "fenerbahce");
  assert.equal(normName("Eyüpspor"), "eyupspor");
  assert.equal(normName("Müldür"), "muldur");
  assert.equal(normName("Icardi"), normName("İcardi"));
});

test("Turkish shirt names match FotMob full names at score ≥ 80", () => {
  assert.ok(nameMatchScore("Müldür", "Mert Müldür") >= 80);
  assert.ok(nameMatchScore("Nubel", "Alexander Nübel") >= 80);
  assert.ok(nameMatchScore("İcardi", "Mauro Icardi") >= 80);
  assert.ok(nameMatchScore("Yılmaz", "Barış Alper Yılmaz") >= 80);
});

test("Alisson matches Alisson Becker; Beck does not steal that id", () => {
  assert.ok(nameMatchScore("Alisson", "Alisson Becker") >= 80);
  assert.ok(nameMatchScore("Alisson Becker", "Alisson") >= 80);
  assert.ok(nameMatchScore("Beck", "Alisson Becker") < 80);
  assert.ok(nameMatchScore("Owen Beck", "Alisson Becker") < 80);
});

test("normName maps ß to ss so Krauß links Krauss", () => {
  assert.equal(normName("Tom Krauß"), "tom krauss");
  assert.equal(normName("Tom Krauss"), "tom krauss");
  assert.ok(nameMatchScore("Tom Krauss", "Tom Krauß") >= 80);
});
