import assert from "node:assert/strict";
import test from "node:test";
import {
  clubFileSlug,
  filterGreenHits,
  parseScreenshotClip,
  parseScreenshotRequest,
  parseScreenshotTour,
  tourClubScreenshotPath,
} from "./expected11Screenshot.js";

test("parseScreenshotClip validates viewport clip", () => {
  assert.deepEqual(parseScreenshotClip({ x: 10.2, y: 20.8, width: 100, height: 50 }), {
    x: 10,
    y: 21,
    width: 100,
    height: 50,
  });
  assert.throws(() => parseScreenshotClip({ x: -1, y: 0, width: 10, height: 10 }));
  assert.throws(() => parseScreenshotClip({ x: 0, y: 0, width: 0, height: 10 }));
});

test("parseScreenshotRequest green vs coords", () => {
  assert.deepEqual(
    parseScreenshotRequest({
      mode: "green",
      url: "https://expected11.com/match/1/a-vs-b",
      sides: ["home"],
      tour: 3,
    }),
    {
      mode: "green",
      url: "https://expected11.com/match/1/a-vs-b",
      sides: ["home"],
      tour: 3,
    },
  );
  assert.deepEqual(
    parseScreenshotRequest({
      mode: "coords",
      clip: { x: 0, y: 0, width: 640, height: 480 },
    }),
    {
      mode: "coords",
      url: undefined,
      tour: undefined,
      clip: { x: 0, y: 0, width: 640, height: 480 },
    },
  );
  assert.throws(() => parseScreenshotRequest({ mode: "coords" }));
});

test("clubFileSlug builds tour/club path segments", () => {
  assert.equal(clubFileSlug("Millwall"), "millwall");
  assert.equal(clubFileSlug("Millwall FC"), "millwall");
  assert.equal(clubFileSlug("Norwich City"), "norwich-city");
  assert.equal(clubFileSlug("West Bromwich Albion"), "west-bromwich-albion");
  assert.equal(tourClubScreenshotPath(3, "Millwall"), "3/millwall.png");
  assert.equal(parseScreenshotTour(3), 3);
  assert.equal(parseScreenshotTour("12"), 12);
  assert.throws(() => parseScreenshotTour(0));
});

test("filterGreenHits respects side filter", () => {
  const hits = [
    {
      side: "home" as const,
      teamName: "Millwall",
      selector: ".lineup--home",
      box: { x: 0, y: 0, width: 10, height: 10 },
    },
    {
      side: "away" as const,
      teamName: "Norwich City",
      selector: ".lineup--away",
      box: { x: 0, y: 0, width: 10, height: 10 },
    },
  ];
  assert.equal(filterGreenHits(hits, ["home"]).length, 1);
  assert.equal(filterGreenHits(hits, ["all"]).length, 2);
  assert.equal(filterGreenHits(hits).length, 2);
});
