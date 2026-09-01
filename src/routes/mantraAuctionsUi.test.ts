import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public Auctions tab renders progress, stages, bids, and canonical profiles", async () => {
  const [html, view] = await Promise.all([
    readFile(new URL("../../public-tm/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/auctions-view.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /data-view="auctions"/);
  assert.doesNotMatch(html, /data-view="auctions"[^>]*hidden/);
  assert.match(html, /id="view-auctions"/);
  assert.match(view, /scope\.percent/);
  assert.match(view, /scope\.completed/);
  assert.match(view, /scope\.total/);
  assert.match(view, /player\.profileUrl/);
  assert.match(view, /stageHistoryMarkup/);
  assert.match(view, /title="\$\{esc\(String\(bid\.price/);
  assert.match(view, /player\.bidRecordCount/);
  assert.match(view, /player\.stageCount/);
  assert.match(view, /player\.bidAmountSum/);
  assert.match(view, /data\.preliminary/);
  assert.match(view, /Предварительно · синхронизация не завершена/);
  assert.match(view, /scope\.status === "partial"/);
  assert.match(view, /Частично готово/);
  assert.match(view, /scope\.missingAuctionCount/);
  assert.match(view, /scope\.missingDetailCount/);
  assert.match(view, /scope\.lastRetryAt/);
  assert.match(view, /scope\.availableLeagues/);
  assert.match(view, /scope\.leaguesWithAuctions/);
  assert.match(view, /scope\.collectedAuctions/);
  assert.match(view, /scope\.availableAuctions/);
  assert.match(view, /scope\.detailsProcessed/);
  assert.match(view, /scope\.detailsTotal/);
  assert.match(view, /renderCoverage\(\)/);
  assert.match(view, /auction\.collectionStatus/);
  assert.match(html, /id="auction-coverage-list"/);
  assert.match(view, /включая выигрышную запись без повторного добавления/);
  assert.match(html, /id="auction-bids-min"/);
  assert.match(html, /id="auction-stages-min"/);
  assert.match(html, /id="auction-amount-min"/);
  assert.match(html, /id="auction-sort"/);
  assert.match(html, /id="auction-reset-filters"/);
  assert.match(view, /params\.set\(key, value\)/);
  assert.match(view, /allAuctionsSelected\(\) \? "maxBid:desc" : "finalPrice:desc"/);
  assert.match(view, /auctionSelection\(data\.auctions, previous\)/);
  assert.match(view, /Promise\.all\(\[refreshProgress\(\), loadAuctions\(\)\]\)/);
  assert.match(view, /data-auction-avatar/);
  assert.match(view, /decoding="async"/);
  assert.match(view, /handleAuctionAvatarEvent/);
  assert.match(view, /\/api\/auctions\/all\/players\?scope=/);
  assert.match(view, /value="all"/);
  assert.match(view, /Все аукционы/);
  assert.match(view, /player\.maxBidAmount/);
  assert.match(view, /Менеджер \/ fantasy-команда/);
  assert.match(view, /Fantasy-лига/);
  assert.match(view, /data-auction-mode/);
  assert.match(view, /data-auction-history-player/);
  assert.match(view, /loadAuctionPlayerHistory/);
  assert.match(view, /auctionHistoryMarkup/);
  assert.match(view, /data-auction-history-retry/);
  assert.match(view, /data-auction-history-more/);
  assert.match(view, /clearAuctionHistoryCache/);
  assert.match(html, /value="maxBid:desc"/);
  assert.match(html, /value="maxBid:asc"/);
  assert.match(html, /id="auction-team-report-title"/);
  assert.match(html, /id="auction-report-league"/);
  assert.match(html, /id="auction-report-auction"/);
  assert.match(html, /id="auction-report-team-search"/);
  assert.match(html, /id="auction-report-team"/);
  assert.match(view, /auctionTeamReportSelection/);
  assert.match(view, /\/teams\?scope=/);
  assert.match(view, /\/report\?scope=/);
  assert.match(html, /id="auction-team-spending"/);
  assert.match(view, /auctionTeamSpendingMarkup/);
  assert.match(view, /nextAuctionTeamSummarySort/);
  assert.match(view, /reportSortKey = "actual"/);
  assert.match(view, /reportSortOrder = "desc"/);
  assert.match(
    view,
    /selectedScope = next;[\s\S]*reportGeneration \+= 1;[\s\S]*reportAuctionKey = "";/,
  );
  assert.match(view, /tr\[data-team-summary-team\]/);
  assert.match(view, /auctionTeamReportSummaryMarkup/);
  assert.match(view, /auctionTeamReportPickMarkup/);
  assert.match(view, /loadReportTeams\(sameAuction \? previousTeam : "", sameAuction\)/);
  assert.match(html, /id="auction-ideal-pick"/);
  assert.match(html, /id="auction-ideal-pick-summary"/);
  assert.match(html, /id="auction-ideal-pick-outbid"/);
  assert.match(html, /id="auction-ideal-pick-picks"/);
  assert.match(view, /\/ideal-picks\?scope=/);
  assert.match(view, /\/ideal-picks\/\$\{encodeURIComponent/);
  assert.match(view, /idealPickSummaryMarkup/);
  assert.match(view, /idealWhoOutbidMarkup/);
  assert.match(view, /idealPickDetailMarkup/);
  assert.match(view, /data-ideal-team/);
  assert.match(view, /data-actual-relationship/);
  assert.match(view, /Перебил на этапе/);
  assert.match(view, /Забрал позже/);
  assert.match(
    view,
    /const generation = \+\+auctionsGeneration;[\s\S]*scope !== selectedScope\) return;/,
  );
});

test("auctions header dropdown follows ?league= like other Mantra pages", async () => {
  const view = await readFile(
    new URL("../../public-tm/auctions-view.js", import.meta.url),
    "utf8",
  );
  assert.match(view, /const AUCTION_LEAGUE_SLUGS = \[/);
  assert.match(view, /"bundesliga"/);
  assert.match(view, /"championship"/);
  assert.match(view, /"ekstraklasa"/);
  assert.match(view, /"super-lig"/);
  assert.match(view, /"serie-a"/);
  assert.match(view, /"premier-league"/);
  assert.match(view, /URLSearchParams\(search\)\.get\("league"\)/);
  assert.match(view, /qs\.set\("league", selectedScope\)/);
  assert.match(view, /history\.replaceState\(null, "", next\)/);
  assert.match(view, /getElementById\("competition-select"\)/);
  assert.match(view, /selectAuctionScope\(next\)/);
  assert.match(view, /const fromUrl = auctionLeagueFromSearch\(\)/);
  assert.match(view, /if \(fromUrl\) selectedScope = fromUrl/);
  assert.match(view, /if \(fillingCompetitionSelect\) return/);
  assert.match(view, /if \(!next \|\| next === selectedScope\) return/);
  assert.match(view, /hideLegacyPageStatus\(\)/);
  assert.doesNotMatch(
    view,
    /export async function startAuctionsView\(\)[\s\S]*syncAuctionLeagueUrl\(\)/,
  );
});

test("auction polling is single, conservative, and lifecycle-aware", async () => {
  const view = await readFile(
    new URL("../../public-tm/auctions-view.js", import.meta.url),
    "utf8",
  );
  assert.match(view, /const POLL_MS = 8_000/);
  assert.match(view, /if \(!active \|\| document\.hidden \|\| allComplete\(\)\) return/);
  assert.match(view, /item\.scopeKey === selectedScope/);
  assert.doesNotMatch(view, /scopes\.every\(/);
  assert.doesNotMatch(view, /scopes\.length === 3 &&/);
  assert.match(view, /if \(timer\) clearTimeout\(timer\)/);
  assert.match(view, /document\.addEventListener\("visibilitychange"/);
  assert.match(view, /export function stopAuctionsView\(\)/);
});

test("auction layout remains bounded on mobile and includes all locales", async () => {
  const [css, i18n] = await Promise.all([
    readFile(new URL("../../public-tm/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../public-tm/i18n.js", import.meta.url), "utf8"),
  ]);
  assert.match(css, /\.auction-scope-grid/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /data-status="partial"/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.auction-scope-grid/);
  assert.match(css, /grid-template-columns: 1fr/);
  assert.match(css, /\.auction-coverage-row/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.auction-coverage-row/);
  assert.match(css, /\.auction-player-avatar-image\.is-loaded/);
  assert.match(css, /\.auction-player-avatar[\s\S]*width: 56px/);
  assert.match(css, /\.auction-max-provenance/);
  assert.match(css, /\.auction-max-team/);
  assert.match(css, /\.auction-history-league/);
  assert.match(css, /\.auction-history-auction/);
  assert.match(css, /\.auction-bid \{[\s\S]*display: inline-flex/);
  assert.doesNotMatch(css, /\.auction-bid \{[\s\S]{0,300}justify-content:\s*space-between/);
  assert.match(css, /\.auction-team-report-cards/);
  assert.match(css, /\.auction-team-summary-table/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.auction-team-summary-table td::before/);
  assert.match(css, /\.auction-team-report-pick/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.auction-team-report-pick/);
  assert.match(css, /\.auction-ideal-picks/);
  assert.match(css, /\.auction-ideal-outbid-groups/);
  assert.match(
    css,
    /@media \(max-width: 720px\)[\s\S]*\.auction-ideal-picks \.auction-team-report-pick/,
  );
  assert.match(css, /content: attr\(data-label\)/);
  assert.match(i18n, /"Auctions"/);
  assert.match(i18n, /"Аукціони"/);
  assert.match(i18n, /"Аўкцыёны"/);
  assert.match(i18n, /"Reset filters"/);
  assert.match(i18n, /"Скинути фільтри"/);
  assert.match(i18n, /"Скінуць фільтры"/);
  assert.match(i18n, /Sync is paused; available data is preserved/);
  assert.match(i18n, /Partially ready/);
  assert.match(i18n, /records are temporarily unavailable in the Mantra API/);
  assert.match(i18n, /Accessible fantasy leagues/);
  assert.match(i18n, /League and auction coverage/);
  assert.match(i18n, /"Player photo", "Фото гравця", "Фота гульца"/);
  assert.match(i18n, /"All auctions", "Усі аукціони", "Усе аўкцыёны"/);
  assert.match(i18n, /"Manager \/ fantasy team"/);
  assert.match(i18n, /"Maximum API bid"/);
  assert.match(i18n, /"History by fantasy league"/);
  assert.match(i18n, /"Loading bid history…"/);
  assert.match(i18n, /"Could not load bid history"/);
  assert.match(i18n, /"Load more"/);
  assert.match(i18n, /"Fantasy-team report"/);
  assert.match(i18n, /"Fantasy-team spending", "Витрати fantasy-команд", "Выдаткі fantasy-каманд"/);
  assert.match(i18n, /Partial data: ≥ is the known lower bound/);
  assert.match(i18n, /"Guaranteed outright-beat minimum \+1M"/);
  assert.match(i18n, /"Bid breakdown by acquired player"/);
  assert.match(i18n, /"Ideal Pick", "Ідеальний пік", "Ідэальны пік"/);
  assert.match(i18n, /"Who outbid", "Хто перебив", "Хто перабіў"/);
  assert.match(i18n, /"Outbid at stage"/);
  assert.match(i18n, /"Acquired later"/);
});
