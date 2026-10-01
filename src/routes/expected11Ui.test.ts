import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const helperPath = "../../public-tm/expected11-view.js";
const premiumHelperPath = "../../public-tm/premium-sort.js";

test("Expected11 UI keeps aggregate and selected-match scopes distinct", async () => {
  const {
    expected11AggregateText,
    expected11NarrativeBlocks,
    expected11PlayerProfileUrl,
    expected11PositionsText,
    expected11ScopeText,
    expected11VisibleMatches,
  } = await import(helperPath);
  const data = {
    aggregate: {
      matches: 2,
      teams: 4,
      clubs: 4,
      linked: 80,
      unmatched: 20,
      ambiguous: 0,
    },
    matches: [
      {
        id: "1",
        title: "One",
        teams: [{}, {}],
        counts: { linked: 50, unmatched: 4, ambiguous: 0 },
      },
      {
        id: "2",
        title: "Two",
        teams: [{}, {}],
        counts: { linked: 30, unmatched: 16, ambiguous: 0 },
      },
    ],
  };

  assert.equal(expected11VisibleMatches(data, "").length, 2);
  assert.deepEqual(
    expected11VisibleMatches(data, "1").map((match: { id: string }) => match.id),
    ["1"],
  );
  assert.match(expected11AggregateText(data), /2 матчей · 4 клубов · связано 80/);
  assert.match(expected11ScopeText(data, "1"), /Выбранный матч: 2 клуба · связано 50/);
  assert.doesNotMatch(expected11ScopeText(data, "1"), /связано 80/);

  const linked = {
    linkStatus: "linked",
    mantraPlayerId: 4264,
    profilePlayerId: "606718",
    positions: ["LB", "WB"],
  };
  assert.equal(expected11PlayerProfileUrl(linked), "/player.html?id=606718");
  assert.notEqual(
    expected11PlayerProfileUrl(linked),
    `/player.html?id=${linked.mantraPlayerId}`,
  );
  assert.equal(
    expected11PlayerProfileUrl({
      linkStatus: "linked",
      mantraPlayerId: 4264,
      profilePlayerId: null,
    }),
    null,
  );
  assert.equal(
    expected11PlayerProfileUrl({
      linkStatus: "unmatched",
      profilePlayerId: "606718",
    }),
    null,
  );
  assert.equal(expected11PositionsText(linked), "LB / WB");
  assert.equal(expected11PositionsText({ linkStatus: "unmatched", positions: ["ST"] }), "—");

  const team = {
    notes: {
      teamAnalysis: {
        text: "Paragraph one.\n\n<script>alert(1)</script>",
      },
      additionalNotes: { text: "Late update." },
    },
  };
  assert.deepEqual(expected11NarrativeBlocks(team, false), []);
  const narratives = expected11NarrativeBlocks(team, true);
  assert.equal(narratives.length, 4);
  assert.equal(narratives[0].text, "Paragraph one.\n\n<script>alert(1)</script>");
  assert.equal(narratives[1].text, "—");
  assert.equal(narratives[3].text, "Late update.");
});

test("Expected11 renderer escapes narratives and exposes responsive columns", async () => {
  const [app, css, i18n] = await Promise.all([
    readFile(new URL("../../public-tm/pages/expected11.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/i18n.js", import.meta.url), "utf8"),
  ]);

  assert.match(app, /<dd>\$\{esc\(text\)\}<\/dd>/);
  assert.match(app, /expected11PlayerProfileUrl\(player\)/);
  assert.match(app, /expected11PositionsText\(player\)/);
  assert.match(app, /selectedMatchId \? expected11Narratives\(team, match\) : ""/);
  assert.match(app, /renderExpected11Gazette\(data\)/);
  assert.match(app, /iframe class="expected11-gazette"/);
  assert.match(app, /data\?\.gazette\?\.url/);
  assert.match(app, /Expected11, %/);
  assert.match(app, /Позиции Mantra/);
  assert.match(css, /\.expected11-player-header/);
  assert.match(css, /\.expected11-gazette/);
  assert.match(css, /white-space: pre-wrap/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 64px minmax\(72px, auto\)/);
  assert.match(i18n, /"Mantra positions"/);
  assert.match(i18n, /"Injuries & Recovery"/);
  assert.match(i18n, /"Травми та відновлення"/);
  assert.match(i18n, /"Траўмы і аднаўленне"/);
});

test("Championship XI exposes Expected11 status, provenance, sorting, and mobile markup", async () => {
  const [app, css, i18n] = await Promise.all([
    readFile(new URL("../../public-tm/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/i18n.js", import.meta.url), "utf8"),
  ]);
  assert.match(app, /championshipExpected11Enabled\(\)/);
  assert.match(app, /expected11StatusText\(prediction\)/);
  assert.match(app, /expected11-source-link/);
  assert.match(app, /expected11-desc/);
  assert.match(app, /aValue == null && bValue != null/);
  assert.match(app, /starterProbabilitySource === "official_sorare"/);
  assert.match(app, /OUT исключён из выбора/);
  assert.match(css, /\.expected11-xi-cell/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.expected11-source-detail/);
  assert.match(i18n, /missing data is neutral/);
  assert.match(i18n, /"OUT використано лише/);
  assert.match(i18n, /"OUT выключаны/);
});

test("Serie A XI exposes two source probability columns without fabricating 0%", async () => {
  const [app, css, i18n] = await Promise.all([
    readFile(new URL("../../public-tm/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/i18n.js", import.meta.url), "utf8"),
  ]);
  assert.match(app, /serieALineupEnabled\(\)/);
  assert.match(app, /formatSerieASourcePct/);
  assert.match(app, /Fantacalcio %/);
  assert.match(app, /SorareInside %/);
  assert.match(app, /displayedPercentage != null/);
  assert.doesNotMatch(app, /formatSerieASourcePct[\s\S]{0,200}return ["']0%/);
  assert.match(css, /\.lineup-pct/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*td\.lineup-pct/);
  assert.match(i18n, /"Fantacalcio %"/);
  assert.match(i18n, /"SorareInside %"/);
  assert.match(i18n, /missing data is neutral/);
});

test("private Expected11 tabs start hidden and depend on account entitlement", async () => {
  const [html, app, core] = await Promise.all([
    readFile(new URL("../../public-tm/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/core.js", import.meta.url), "utf8"),
  ]);
  assert.match(
    html,
    /data-view="mapping"[^>]*hidden/,
  );
  assert.match(
    html,
    /data-view="premium"[^>]*hidden/,
  );
  assert.match(app, /accountState\.entitlements\?\.expected11Premium/);
  assert.match(app, /accountState\.entitlements\?\.expected11Admin/);
  assert.match(core, /tab\[data-view="premium"\]/);
  assert.match(core, /tab\[data-view="mapping"\]/);
  assert.match(core, /expected11Admin/);
  assert.doesNotMatch(app, /name === "mapping" \|\| name === "premium"/);
  assert.match(app, /name === "premium" && !accountState\.entitlements\?\.expected11Premium/);
  assert.match(app, /name === "mapping" && !accountState\.entitlements\?\.expected11Admin/);
});

test("League One and Mantra Doma are public tabs with anonymous GETs", async () => {
  const [html, app, core, boot, leagueOnePage, mantraDomaPage, leagueOneRoutes, mantraDomaRoutes] =
    await Promise.all([
      readFile(new URL("../../public-tm/index.html", import.meta.url), "utf8"),
      readFile(new URL("../../public-tm/app.js", import.meta.url), "utf8"),
      readFile(new URL("../../public-tm/core.js", import.meta.url), "utf8"),
      readFile(new URL("../../public-tm/boot.js", import.meta.url), "utf8"),
      readFile(new URL("../../public-tm/pages/league-one.js", import.meta.url), "utf8"),
      readFile(new URL("../../public-tm/pages/mantra-doma.js", import.meta.url), "utf8"),
      readFile(new URL("./leagueOne.ts", import.meta.url), "utf8"),
      readFile(new URL("./mantraDoma.ts", import.meta.url), "utf8"),
    ]);
  assert.match(html, /data-view="league-one" href="\/league-one"/);
  assert.match(html, /data-view="mantra-doma" href="\/mantra-doma"/);
  assert.doesNotMatch(html, /data-view="league-one"[^>]*hidden/);
  assert.doesNotMatch(html, /data-view="mantra-doma"[^>]*hidden/);
  assert.doesNotMatch(core, /tab\[data-view="league-one"\]/);
  assert.doesNotMatch(core, /tab\[data-view="mantra-doma"\]/);
  assert.doesNotMatch(app, /tab\[data-view="league-one"\]/);
  assert.doesNotMatch(app, /tab\[data-view="mantra-doma"\]/);
  assert.doesNotMatch(app, /name === "league-one"/);
  assert.doesNotMatch(app, /name === "mantra-doma"/);
  assert.doesNotMatch(leagueOnePage, /location\.replace\("\/clubs"\)/);
  assert.doesNotMatch(mantraDomaPage, /renderLoginGate/);
  assert.doesNotMatch(mantraDomaPage, /mantra-doma-login-gate/);
  assert.doesNotMatch(mantraDomaPage, /playerCell/);
  assert.match(mantraDomaPage, /\/api\/mantra-doma\/stats/);
  assert.match(html, /id="mantra-doma-photo-dialog"/);
  assert.match(boot, /"league-one": "\.\/pages\/league-one\.js\?v=14"/);
  assert.match(boot, /"mantra-doma": "\.\/pages\/mantra-doma\.js\?v=9"/);
  assert.match(mantraDomaPage, /mantra-doma-table/);
  assert.match(mantraDomaPage, /nextToggleSort/);
  assert.match(mantraDomaPage, /data-doma-sort/);
  assert.match(mantraDomaPage, /title="\$\{esc\(title\)\}"/);
  assert.match(leagueOneRoutes, /app\.get\("\/api\/league-one", async \(\) => \{/);
  assert.match(leagueOneRoutes, /app\.get\("\/api\/league-one\/reports", async \(\) => \{/);
  assert.doesNotMatch(
    leagueOneRoutes,
    /app\.get\("\/api\/league-one",[\s\S]{0,180}authorizeAdmin/,
  );
  assert.match(leagueOneRoutes, /app\.post\("\/api\/league-one\/sync"[\s\S]*authorizeAdmin/);
  assert.match(mantraDomaRoutes, /app\.get\("\/api\/mantra-doma", async \(\) => \{/);
  assert.match(mantraDomaRoutes, /app\.get\("\/api\/mantra-doma\/stats", async \(\) => \{/);
  assert.doesNotMatch(
    mantraDomaRoutes,
    /app\.get\("\/api\/mantra-doma\/stats"[\s\S]{0,180}requireUser/,
  );
  assert.match(mantraDomaRoutes, /currentUser\(request\)/);
  assert.match(mantraDomaRoutes, /app\.post\("\/api\/mantra-doma\/applications"[\s\S]*requireUser/);
});

test("mapping page filters loaded rows by championship without refetching", async () => {
  const [html, page, boot] = await Promise.all([
    readFile(new URL("../../public-tm/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/pages/expected11.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/boot.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="mapping-league"/);
  assert.match(html, /<option value="">Все лиги<\/option>/);
  assert.match(page, /function mappingLeagueMatches/);
  assert.match(page, /fillMappingLeagueSelect\(data\)/);
  assert.match(page, /getElementById\("mapping-league"\)\?\.addEventListener\("change"/);
  assert.match(page, /renderMapping\(mappingData\)/);
  assert.doesNotMatch(
    page,
    /getElementById\("mapping-league"\)\?\.addEventListener\("change"[\s\S]{0,180}loadMapping/,
  );
  assert.match(page, /applyLinkedMapping\(result/);
  assert.doesNotMatch(
    page,
    /applyLinkedMapping[\s\S]{0,400}loadMapping\(\)/,
  );
  assert.match(boot, /expected11\.js\?v=14/);
});

test("Sorare championship dropdown reads and writes ?league= slugs", async () => {
  const [page, boot] = await Promise.all([
    readFile(new URL("../../public-tm/pages/expected11.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/boot.js", import.meta.url), "utf8"),
  ]);
  assert.match(page, /function syncExpected11Hash/);
  assert.match(page, /replacePathQuery\(PAGE_PATHS\.sorare/);
  assert.match(page, /EXPECTED11_SLUG_TO_TM/);
  assert.match(page, /"premier-league"/);
  assert.match(page, /"championship"/);
  assert.match(page, /"ekstraklasa"/);
  assert.match(page, /"serie-a"/);
  assert.match(page, /"bundesliga"/);
  assert.match(page, /"super-lig"/);
  assert.match(page, /qs\.get\("league"\)/);
  assert.match(page, /qs\.get\("tour"\) \|\| qs\.get\("round"\)/);
  assert.match(page, /renderExpected11Gazette\(data\)/);
  assert.match(boot, /sorare: "\.\/pages\/expected11\.js\?v=14"/);
});

test("Expected11 URL ingest form is admin-only and not in anonymous HTML", async () => {
  const [html, page, core, account] = await Promise.all([
    readFile(new URL("../../public-tm/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/pages/expected11.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/core.js", import.meta.url), "utf8"),
    readFile(new URL("./account.ts", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="expected11-ingest"[^>]*hidden/);
  assert.match(html, /id="mapping-ingest"[^>]*hidden/);
  assert.match(html, /id="expected11-tour"/);
  assert.doesNotMatch(html, /id="expected11-tour-url"/);
  assert.doesNotMatch(html, /id="expected11-championship-url"/);
  assert.doesNotMatch(html, /id="expected11-urls"/);
  assert.doesNotMatch(page, /aharodnik@gmail\.com/);
  assert.doesNotMatch(page, /expected11-tour-url/);
  assert.doesNotMatch(page, /expected11-championship-url/);
  assert.match(page, /entitlements\?\.expected11Admin/);
  assert.match(page, /page === "mapping" && !accountState\.entitlements\?\.expected11Admin/);
  assert.match(page, /id="expected11-urls"/);
  assert.match(page, /\/api\/expected11\/urls/);
  assert.match(page, /\/api\/expected11\/rebuild/);
  assert.match(core, /expected11Admin: false/);
  assert.match(account, /expected11Admin: isLiveDraftAdmin/);
});

test("Premium metric sorting is numeric, null-last, stable, and filter-compatible", async () => {
  const { nextPremiumSort, nextToggleSort, sortNumericRows, sortPremiumRows } =
    await import(premiumHelperPath);
  const rows = [
    {
      mantraPlayerId: 1,
      clubId: 20,
      clubName: "Beta",
      position: "ST",
      surname: "Zulu",
      displayName: "Alex Zulu",
      displayedPercentage: 90,
      winProbability: 0.5,
    },
    {
      mantraPlayerId: 2,
      clubId: 10,
      clubName: "Alpha",
      position: "GK",
      surname: "Able",
      displayName: "Ben Able",
      displayedPercentage: 90,
      winProbability: null,
    },
    {
      mantraPlayerId: 3,
      clubId: 10,
      clubName: "Alpha",
      position: "ST",
      surname: "Baker",
      displayName: "Chris Baker",
      displayedPercentage: 70,
      winProbability: 0.4,
    },
    {
      mantraPlayerId: 4,
      clubId: 10,
      clubName: "Alpha",
      position: "ST",
      surname: "Alpha",
      displayName: "Dan Alpha",
      displayedPercentage: null,
      winProbability: 0.4,
    },
    {
      mantraPlayerId: 5,
      clubId: 30,
      clubName: "Gamma",
      position: "CB",
      surname: "Missing",
      displayName: "Eve Missing",
      displayedPercentage: null,
      winProbability: null,
    },
    {
      mantraPlayerId: 6,
      clubId: 40,
      clubName: "Delta",
      position: "AM",
      surname: "Hundred",
      displayName: "Finn Hundred",
      displayedPercentage: "100",
      winProbability: 0.3,
    },
  ];

  assert.deepEqual(
    sortPremiumRows(rows, { key: "displayedPercentage", dir: "desc" }).map(
      (row: { mantraPlayerId: number }) => row.mantraPlayerId,
    ),
    [6, 2, 1, 3, 4, 5],
  );
  assert.deepEqual(
    sortPremiumRows(rows, { key: "displayedPercentage", dir: "asc" }).map(
      (row: { mantraPlayerId: number }) => row.mantraPlayerId,
    ),
    [3, 2, 1, 6, 4, 5],
  );
  assert.deepEqual(
    sortPremiumRows(rows, { key: "winProbability", dir: "desc" }).map(
      (row: { mantraPlayerId: number }) => row.mantraPlayerId,
    ),
    [1, 4, 3, 6, 2, 5],
  );
  assert.deepEqual(
    sortPremiumRows(rows, { key: "winProbability", dir: "asc" }).map(
      (row: { mantraPlayerId: number }) => row.mantraPlayerId,
    ),
    [6, 4, 3, 1, 2, 5],
  );

  const alphaRows = rows.filter((row) => row.clubId === 10);
  assert.deepEqual(
    sortPremiumRows(alphaRows, {
      key: "displayedPercentage",
      dir: "desc",
    }).map((row: { mantraPlayerId: number }) => row.mantraPlayerId),
    [2, 3, 4],
  );
  assert.deepEqual(nextPremiumSort(null, "winProbability"), {
    key: "winProbability",
    dir: "desc",
  });
  assert.deepEqual(
    nextPremiumSort(
      { key: "winProbability", dir: "desc" },
      "winProbability",
    ),
    { key: "winProbability", dir: "asc" },
  );
  assert.deepEqual(
    nextPremiumSort(
      { key: "winProbability", dir: "asc" },
      "displayedPercentage",
    ),
    { key: "displayedPercentage", dir: "desc" },
  );

  const squadRows = [
    {
      mantraPlayerId: 1,
      clubName: "Alpha",
      position: "ST",
      surname: "High",
      displayName: "High",
      ratingAvg: 8.1,
      mantraTsAvg: 6.2,
      formScore: 9.1,
      auctionPrice: 12,
    },
    {
      mantraPlayerId: 2,
      clubName: "Alpha",
      position: "GK",
      surname: "Gap",
      displayName: "Gap",
      ratingAvg: null,
      mantraTsAvg: null,
      formScore: 0,
      auctionPrice: null,
    },
    {
      mantraPlayerId: 3,
      clubName: "Beta",
      position: "CM",
      surname: "Mid",
      displayName: "Mid",
      ratingAvg: 6.4,
      mantraTsAvg: 7.5,
      formScore: 5,
      auctionPrice: 3,
    },
  ];
  assert.deepEqual(
    sortNumericRows(squadRows, { key: "formScore", dir: "desc" }).map(
      (row: { mantraPlayerId: number }) => row.mantraPlayerId,
    ),
    [1, 3, 2],
  );
  assert.deepEqual(
    sortNumericRows(squadRows, { key: "auctionPrice", dir: "desc" }).map(
      (row: { mantraPlayerId: number }) => row.mantraPlayerId,
    ),
    [1, 3, 2],
  );
  assert.deepEqual(
    sortNumericRows(squadRows, { key: "ratingAvg", dir: "asc" }).map(
      (row: { mantraPlayerId: number }) => row.mantraPlayerId,
    ),
    [3, 1, 2],
  );
  assert.deepEqual(nextToggleSort(null, "formScore"), { key: "formScore", dir: "desc" });
  assert.deepEqual(
    nextToggleSort({ key: "formScore", dir: "desc" }, "formScore"),
    { key: "formScore", dir: "asc" },
  );
});

test("Premium sort controls expose direction and load cache-busted assets", async () => {
  const [html, premium, expected11] = await Promise.all([
    readFile(new URL("../../public-tm/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/pages/premium.js", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/pages/expected11.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /data-premium-sort="xiScore"/);
  assert.match(html, /data-sort-label="Оценка"/);
  assert.match(html, /data-premium-sort="displayedPercentage"/);
  assert.match(html, /data-premium-sort="footmopsPercentage"/);
  assert.match(html, /data-sort-label="футмопс"/);
  assert.match(html, /data-premium-sort="winProbability"/);
  assert.match(html, /data-premium-sort="cleanSheetProbability"/);
  assert.match(html, /data-premium-sort="opponentCleanSheetProbability"/);
  assert.match(html, /aria-sort="none"/);
  assert.match(html, /boot\.js\?v=77/);
  assert.match(html, /Обновить состав моей команды/);
  assert.match(html, /id="premium-refresh-auctions"/);
  assert.match(html, /Обновить после раундов аукциона/);
  assert.match(html, /id="premium-refresh-auctions"[\s\S]*?\bhidden\b/);
  assert.match(html, /styles\.css\?v=163/);
  assert.match(html, /id="premium-generate"/);
  assert.match(html, /Сгенерировать состав/);
  assert.match(html, /id="premium-squad-report"/);
  assert.match(html, /Отчёт по составу/);
  assert.match(html, />Цена</);
  assert.match(html, />Форма</);
  assert.match(html, /data-squad-sort="auctionPrice"/);
  assert.match(html, /data-squad-sort="ratingAvg"/);
  assert.match(html, /data-squad-sort="mantraTsAvg"/);
  assert.match(html, /data-squad-sort="formScore"/);
  assert.match(html, /id="premium-unpicked-tops"/);
  assert.match(html, /Топ-5 свободных/);
  assert.match(html, /premium-squad-pos/);
  assert.match(html, />Поз</);
  assert.match(premium, /function squadPlayerCell/);
  assert.match(premium, /function mantraPosPill/);
  assert.match(premium, /MANTRA_POS_COLOR/);
  assert.match(premium, /mantra-pos-pill/);
  assert.match(premium, /premium-squad-pos/);
  assert.doesNotMatch(premium, /function playerCell[\s\S]*function playerCell/);
  assert.match(html, /premium-select-col/);
  assert.match(html, /id="premium-team"/);
  assert.doesNotMatch(html, /id="premium-league"/);
  assert.doesNotMatch(html, /id="premium-club"/);
  assert.match(premium, /function formatXiPct/);
  assert.match(premium, /formatXiPct\(row\.displayedPercentage\)/);
  assert.match(premium, /core\.js\?v=11/);
  assert.match(premium, /premium-sort\.js\?v=5/);
  assert.match(premium, /footmopsPercentage/);
  assert.match(premium, /footmopsGroup === "out"/);
  assert.match(premium, /return "OUT"/);
  assert.match(premium, /premium-formations\.js\?v=4/);
  assert.match(premium, /Скамейка/);
  assert.match(premium, /Вне заявки/);
  assert.match(premium, /premium-row-bench/);
  assert.match(premium, /mantraPositionsText\(row\)/);
  assert.match(premium, /premium-player-select/);
  assert.match(premium, /pickBestPremiumXi/);
  assert.match(premium, /applyBestXi/);
  assert.match(premium, /\/api\/expected11\/premium\/refresh/);
  assert.match(premium, /\/api\/expected11\/premium\/refresh-auctions/);
  assert.match(premium, /\/api\/expected11\/premium\/squad-report/);
  assert.match(premium, /\/api\/expected11\/premium\/unpicked-tops/);
  assert.match(premium, /showSquadReport/);
  assert.match(premium, /loadUnpickedTops/);
  assert.match(premium, /function squadPlayerCell/);
  assert.match(premium, /reportLoadError/);
  assert.match(premium, /minutesGrid/);
  assert.match(premium, /statusBadge/);
  assert.match(premium, /premium-squad-grid/);
  assert.match(premium, /function formScoreHeat/);
  assert.match(premium, /function formScoreCell/);
  assert.match(premium, /premium-form-heat/);
  assert.match(premium, /formScoreHeat\(row\.formScore\)/);
  assert.doesNotMatch(premium, /formScoreHeat\(row\.ratingAvg\)/);
  assert.match(premium, /data-unpicked-sort/);
  assert.match(premium, /data-squad-sort/);
  assert.match(premium, /sortNumericRows/);
  assert.match(premium, /nextToggleSort/);
  assert.match(premium, /fetchJson/);
  assert.match(premium, /loadSquadReport\(refresh\)\.catch/);
  assert.doesNotMatch(premium, /await loadSquadReport/);
  assert.doesNotMatch(premium, /await loadUnpickedTops/);
  assert.match(premium, /loadUnpickedTops\(refresh\)\.catch/);
  assert.match(premium, /method: "POST"/);
  assert.match(premium, /function isPremiumAdmin/);
  assert.match(premium, /expected11Admin/);
  assert.match(premium, /syncAuctionRefreshButton/);
  assert.match(premium, /aria-busy/);
  assert.match(premium, /function squadPlayerCell/);
  assert.match(premium, /"aria-sort"/);
  assert.match(premium, /nextPremiumSort\(premiumSort/);
  assert.match(premium, /teamOptionLabel\(team\)/);
  assert.match(premium, /mantraLeagueName/);
  assert.doesNotMatch(premium, /fillClubFilter/);
  assert.doesNotMatch(premium, /premium-league/);
  assert.doesNotMatch(premium, /premium-club/);
  assert.doesNotMatch(expected11, /premium-sort/);
  assert.doesNotMatch(expected11, /loadPremium/);
});
