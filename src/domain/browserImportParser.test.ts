import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";

type Parser = {
  parseVisibleProjections(
    root: Document,
    options: { isVisible(element: Element): boolean },
  ): Array<Record<string, unknown>>;
};

test("parses only visible sanitized Companion v0.3.0 ribbon attributes", () => {
  const parserSource = readFileSync(
    new URL("../../browser-import-helper/parser.js", import.meta.url),
    "utf8",
  );
  const fixture = readFileSync(
    new URL(
      "../../browser-import-helper/test/fixtures/companion-v0.3.0.html",
      import.meta.url,
    ),
    "utf8",
  );
  const context: Record<string, unknown> = {};
  vm.runInNewContext(parserSource, context);
  const parser = context.MantraSorareImportParser as Parser;
  const { document } = parseHTML(fixture);
  const projections = parser.parseVisibleProjections(document, {
    isVisible: (element) => element.getAttribute("data-test-hidden") !== "true",
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(projections)),
    [
      {
        clientCardId: "card-slug|Game:123||FW",
        playerId: "Player:123",
        playerSlug: "fixture-forward",
        gameId: "Game:123",
        teamSlug: null,
        projectedScore: 64,
        startingPercentage: 87.5,
        reliability: "high",
        teamWinOdds: 58,
        playerExpectedGoals: 0.42,
        teamCleanSheetOdds: null,
        cardPosition: "FWD",
      },
    ],
  );
  assert.equal(JSON.stringify(projections).includes("token"), false);
});
