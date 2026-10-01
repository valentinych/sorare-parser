#!/usr/bin/env node
/**
 * Automops Telegram publish + preview (shared by CLI and Expected11 local UI).
 *
 * Env: DRAFTMANTRA_BOT_TOKEN, AUTOMOPS_CHANNEL_ID=@automops
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { config as loadEnv } from "dotenv";
import { sanitizeSorareAnalystNote } from "./sorareInsideNotes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
loadEnv({ path: path.join(ROOT, ".env") });

const SORARE_DIR = path.join(ROOT, "data/sorare/output");
const E11_DIR = path.join(ROOT, "data/expected11/output");
const FOOTMOPS_DIR = path.join(ROOT, "data/footmops");
const DB_PATH = process.env.DB_PATH
  ? path.resolve(ROOT, process.env.DB_PATH)
  : path.join(ROOT, "data/app.db");

export const AUTOMOPS_LEAGUES = {
  39: {
    nameEn: "Premier League",
    logoUrl: "https://media.api-sports.io/football/leagues/39.png",
  },
  40: {
    nameEn: "Championship",
    logoUrl: "https://media.api-sports.io/football/leagues/40.png",
    slug: "championship",
  },
  78: {
    nameEn: "Bundesliga",
    logoUrl: "https://media.api-sports.io/football/leagues/78.png",
    slug: "bundesliga",
  },
  106: {
    nameEn: "Ekstraklasa",
    logoUrl: "https://media.api-sports.io/football/leagues/106.png",
    slug: "ekstraklasa",
  },
  135: {
    nameEn: "Serie A",
    logoUrl: "https://media.api-sports.io/football/leagues/135.png",
  },
  203: {
    nameEn: "Süper Lig",
    logoUrl: "https://media.api-sports.io/football/leagues/203.png",
    slug: "super-lig",
  },
};

/** @deprecated use AUTOMOPS_LEAGUES */
const LEAGUES = AUTOMOPS_LEAGUES;

/** Gazetka / TV kickoffs when AF placeholders are identical (Europe/Warsaw). */
const EKSTRAKLASA_GW9_KICKOFFS = [
  { home: "Widzew", away: "Wieczysta", iso: "2026-09-18T16:00:00+02:00" },
  { home: "Wisla Krakow", away: "Slask", iso: "2026-09-18T20:30:00+02:00" },
  { home: "Korona", away: "Rakow", iso: "2026-09-19T14:45:00+02:00" },
  { home: "GKS Katowice", away: "Cracovia", iso: "2026-09-19T17:30:00+02:00" },
  { home: "Motor", away: "Gornik", iso: "2026-09-19T20:15:00+02:00" },
  { home: "Piast", away: "Pogon", iso: "2026-09-20T12:15:00+02:00" },
  { home: "Zaglebie", away: "Wisla Plock", iso: "2026-09-20T14:45:00+02:00" },
  { home: "Jagiellonia", away: "Legia", iso: "2026-09-20T17:30:00+02:00" },
  { home: "Lech", away: "Radomiak", iso: "2026-09-20T20:15:00+02:00" },
];

const NOTE_LABELS = {
  teamAnalysis: "Team Analysis",
  injuriesAndRecovery: "Injuries & Recovery Status",
  suspensionsAndIneligibilities: "Suspensions & Ineligibilities",
  additionalNotes: "Additional notes",
};

const HOWTO = `
How to add @draftmantra_bot to https://t.me/automops

1) Channel → Manage → Administrators → Add administrator
2) Pick @draftmantra_bot
3) Enable "Post Messages"
4) Comments under the post:
   • Manage → Discussion → create/link a discussion group
   • Add @draftmantra_bot as admin of that group (can post)
5) Optional: /start the bot in DM
6) Run: npm run publish:automops -- --league=135 --tour=4 --upcoming

Env: DRAFTMANTRA_BOT_TOKEN, AUTOMOPS_CHANNEL_ID=@automops
`.trim();

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export function automopsBotTokenConfigured() {
  return Boolean(
    process.env.DRAFTMANTRA_BOT_TOKEN?.trim() ||
      process.env.PANENKA_BOT_TOKEN?.trim() ||
      process.env.TELEGRAM_BOT_TOKEN?.trim(),
  );
}

export function botToken() {
  const token =
    process.env.DRAFTMANTRA_BOT_TOKEN?.trim() ||
    process.env.PANENKA_BOT_TOKEN?.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    "";
  if (!token) throw new Error("Set DRAFTMANTRA_BOT_TOKEN in .env");
  return token;
}

export function channelId() {
  return (
    process.env.AUTOMOPS_CHANNEL_ID?.trim() ||
    process.env.DRAFTMANTRA_CHANNEL_ID?.trim() ||
    "@automops"
  );
}

export function listAutomopsLeagues() {
  return Object.entries(AUTOMOPS_LEAGUES).map(([id, meta]) => ({
    id: Number(id),
    name: meta.nameEn,
    logoUrl: meta.logoUrl,
    slug: meta.slug || null,
  }));
}

export function listAutomopsTours(leagueId, season) {
  const id = Number(leagueId);
  const seasonN = Number(season ?? (process.env.PREDICT_SEASON || 2026));
  if (!AUTOMOPS_LEAGUES[id]) {
    throw new Error(
      `League ${leagueId} is not configured (39=PL, 40=Championship, 78=Bundesliga, 106=Ekstraklasa, 135=Serie A, 203=Süper Lig)`,
    );
  }
  const db = openDb();
  try {
    const rows = db
      .prepare(
        `SELECT round, MIN(date) AS start_at, MAX(date) AS end_at,
                SUM(CASE WHEN status IN ('NS','TBD','1H','HT','2H','ET','P','LIVE') THEN 1 ELSE 0 END) AS upcoming_n
         FROM fixtures
         WHERE league_id = ? AND season = ? AND IFNULL(is_preseason, 0) = 0
           AND round IS NOT NULL AND round != ''
         GROUP BY round
         ORDER BY MIN(date)`,
      )
      .all(id, seasonN);
    const tours = rows
      .map((row) => {
        const tour = parseTour(row.round);
        if (tour == null) return null;
        return {
          tour,
          afRound: row.round,
          startAt: row.start_at || null,
          endAt: row.end_at || null,
          upcoming: Number(row.upcoming_n) > 0,
        };
      })
      .filter(Boolean);
    const current =
      tours.find((t) => t.upcoming)?.tour ?? tours[tours.length - 1]?.tour ?? null;
    return {
      leagueId: id,
      season: seasonN,
      currentTour: current,
      tours: tours.map((t) => ({ ...t, current: t.tour === current })),
    };
  } finally {
    db.close();
  }
}

function channelMessageUrl(chat, messageId) {
  const id = String(chat || "").trim();
  if (!messageId) return null;
  if (id.startsWith("@")) {
    return `https://t.me/${id.slice(1)}/${messageId}`;
  }
  // Private / numeric channel ids: t.me/c/<id without -100>/<msg>
  const digits = id.replace(/^-100/, "").replace(/^-/, "");
  if (/^\d+$/.test(digits)) {
    return `https://t.me/c/${digits}/${messageId}`;
  }
  return null;
}

function imageBasenames(match) {
  return [...(match.home?.images || []), ...(match.away?.images || [])]
    .filter((f) => existsSync(f))
    .map((f) => path.basename(f));
}

/**
 * Dry-run preview for the UI — never posts to Telegram.
 */
export async function buildAutomopsPreview({
  leagueId,
  season,
  tour,
  upcomingOnly = false,
} = {}) {
  const bundle = await buildBundle({
    leagueId: Number(leagueId),
    season: Number(season ?? (process.env.PREDICT_SEASON || 2026)),
    tour: tour != null && tour !== "" ? Number(tour) : undefined,
    upcomingOnly: Boolean(upcomingOnly),
  });
  return {
    leagueId: bundle.leagueId,
    season: bundle.season,
    tour: bundle.tour,
    afRound: bundle.afRound,
    leagueName: bundle.meta.nameEn,
    logoUrl: bundle.meta.logoUrl,
    channelId: channelId(),
    botConfigured: automopsBotTokenConfigured(),
    upcomingOnly: Boolean(upcomingOnly),
    mainCaption: mainCaption(bundle),
    matches: bundle.matches.map((m) => ({
      home: m.home.name,
      away: m.away.name,
      kickoff: m.kickoff,
      kickoffLabel: formatKickoff(m.kickoff),
      caption: matchCaption(m),
      images: imageBasenames(m),
      hasOdds: Boolean(m.odds),
      sorareCounts: {
        home: m.home.sorareProbs.length,
        away: m.away.sorareProbs.length,
      },
      e11Counts: {
        home: m.home.e11Probs.length,
        away: m.away.e11Probs.length,
      },
    })),
  };
}

let publishInFlight = false;

/**
 * Publish the same content as `npm run publish:automops` to Telegram.
 */
export async function publishAutomops({
  leagueId,
  season,
  tour,
  upcomingOnly = false,
  channelOnly = false,
  commentsOnly = false,
  replyTo,
  discussionRoot,
  skipMatches = 0,
  only,
} = {}) {
  if (publishInFlight) {
    const err = new Error("An Automops publish is already running.");
    err.code = "automops_busy";
    throw err;
  }
  publishInFlight = true;
  try {
    const bundle = await buildBundle({
      leagueId: Number(leagueId),
      season: Number(season ?? (process.env.PREDICT_SEASON || 2026)),
      tour: tour != null && tour !== "" ? Number(tour) : undefined,
      upcomingOnly: Boolean(upcomingOnly),
    });
    const caption = mainCaption(bundle);
    const token = botToken();
    const chat = channelId();

    const chatInfoEarly = await tg(token, "getChat", { chat_id: chat });
    const discussionIdEarly = chatInfoEarly.linked_chat_id;
    const discussionRootArg =
      discussionRoot != null && discussionRoot !== ""
        ? Number(discussionRoot)
        : undefined;

    let updatesOffset;
    if (!discussionRootArg) {
      try {
        updatesOffset = await getUpdatesOffset(token);
      } catch (e) {
        console.warn("getUpdates offset probe failed:", e?.message || e);
      }
    }

    let channelMessageId;
    if (commentsOnly) {
      channelMessageId = Number(replyTo);
      if (!channelMessageId) {
        throw new Error("commentsOnly requires replyTo=<channel_message_id>");
      }
    } else {
      const msg = await tg(token, "sendPhoto", {
        chat_id: chat,
        photo: bundle.meta.logoUrl,
        caption: caption.slice(0, 1024),
        parse_mode: "HTML",
      });
      channelMessageId = msg.message_id;
    }

    const channelUrl = channelMessageUrl(chat, channelMessageId);
    if (channelOnly) {
      return {
        ok: true,
        leagueId: bundle.leagueId,
        season: bundle.season,
        tour: bundle.tour,
        channelMessageId,
        channelUrl,
        comments: 0,
        commentsExpected: 0,
        discussionSkipped: true,
      };
    }

    const discussionId = discussionIdEarly;
    if (!discussionId) {
      return {
        ok: true,
        leagueId: bundle.leagueId,
        season: bundle.season,
        tour: bundle.tour,
        channelMessageId,
        channelUrl,
        comments: 0,
        commentsExpected: bundle.matches.length,
        discussionSkipped: true,
        warning:
          "Post sent, but discussion is not enabled — match comments skipped.",
      };
    }

    let discussionRootId = discussionRootArg;
    if (!discussionRootId) {
      discussionRootId = await waitForDiscussionRoot(
        token,
        discussionId,
        channelMessageId,
        { offset: updatesOffset },
      );
    }
    if (!discussionRootId) {
      const err = new Error(
        "Could not find the discussion-group auto-forward of the channel post.",
      );
      err.code = "automops_discussion_root";
      err.channelMessageId = channelMessageId;
      err.channelUrl = channelUrl;
      throw err;
    }

    const onlyNeedles = only
      ? String(only)
          .split(",")
          .map((s) => norm(s))
          .filter(Boolean)
      : [];
    let toPost = bundle.matches.slice(Number(skipMatches) || 0);
    if (onlyNeedles.length) {
      toPost = toPost.filter((m) => {
        const label = norm(`${m.home.name} ${m.away.name}`);
        return onlyNeedles.some((n) => label.includes(n));
      });
    }

    let comments = 0;
    const failures = [];
    for (const m of toPost) {
      try {
        await sendMatchComment(token, discussionId, discussionRootId, m);
        comments += 1;
        await new Promise((r) => setTimeout(r, 1500));
      } catch (e) {
        const msg = e?.message || String(e);
        console.warn(`comment failed: ${m.home.name} vs ${m.away.name}:`, msg);
        const retryAfter = Number(
          String(msg).match(/retry after (\d+)/i)?.[1] || 0,
        );
        if (retryAfter > 0) {
          await new Promise((r) => setTimeout(r, (retryAfter + 2) * 1000));
          try {
            await sendMatchComment(token, discussionId, discussionRootId, m);
            comments += 1;
            continue;
          } catch (e2) {
            failures.push({
              match: `${m.home.name} vs ${m.away.name}`,
              error: e2?.message || String(e2),
            });
            continue;
          }
        }
        failures.push({
          match: `${m.home.name} vs ${m.away.name}`,
          error: msg,
        });
      }
    }

    return {
      ok: true,
      leagueId: bundle.leagueId,
      season: bundle.season,
      tour: bundle.tour,
      channelMessageId,
      channelUrl,
      discussionRootId,
      comments,
      commentsExpected: toPost.length,
      failures,
    };
  } finally {
    publishInFlight = false;
  }
}

async function tg(token, method, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const init =
    payload instanceof FormData
      ? { method: "POST", body: payload }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload ?? {}),
        };
  const res = await fetch(url, init);
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  }
  return data.result;
}

function foldTr(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    // Turkish ı/İ are not NFD-decomposable to ASCII.
    .replace(/ı/g, "i")
    .replace(/İ/g, "i");
}

function clubSlug(name) {
  return foldTr(name)
    .toLowerCase()
    .replace(/\s+(fc|afc|cf|sc|fk|sk)\.?$/i, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function norm(s) {
  return foldTr(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function namesOk(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

function isChromePlayerName(name) {
  const t = String(name || "").trim();
  if (!t) return true;
  if (/^[%+\d\s.]+$/.test(t)) return true;
  if (/^%\s*\+?\s*ps$/i.test(t)) return true;
  if (/^[A-Z]{1,4}$/.test(t)) return true;
  if (/^(score|aa|da|app|ps|pspe|all)$/i.test(t)) return true;
  if (/sorareinside\.com/i.test(t)) return true;
  if (/^(first published|updated|copy lineup url)\b/i.test(t)) return true;
  if (/^(ago|hours?|days?|minutes?)\b/i.test(t)) return true;
  return false;
}

function slugAliases(teamName) {
  const base = clubSlug(teamName);
  const extras = {
    bournemouth: ["afc-bournemouth"],
    tottenham: ["tottenham-hotspur"],
    brighton: ["brighton-and-hove-albion"],
    hull: ["hull-city"],
    ipswich: ["ipswich-town"],
    leeds: ["leeds-united"],
    newcastle: ["newcastle-united"],
    coventry: ["coventry-city"],
    wolves: ["wolverhampton-wanderers"],
    inter: ["fc-internazionale-milano", "internazionale-milano"],
    milan: ["ac-milan"],
    "ac-milan": ["ac-milan"],
    roma: ["as-roma"],
    "as-roma": ["as-roma"],
    lazio: ["ss-lazio"],
    napoli: ["ssc-napoli"],
    juventus: ["juventus"],
    atalanta: ["atalanta-bergamasca-calcio"],
    bologna: ["bologna-fc-1909"],
    fiorentina: ["acf-fiorentina"],
    torino: ["torino"],
    genoa: ["genoa-cfc"],
    udinese: ["udinese-calcio", "udinese-udine"],
    cagliari: ["cagliari-calcio"],
    como: ["calcio-como"],
    parma: ["parma-calcio-1913"],
    lecce: ["us-lecce"],
    monza: ["ac-monza"],
    sassuolo: ["us-sassuolo-calcio"],
    venezia: ["venezia"],
    frosinone: ["frosinone-calcio"],
    // Süper Lig AF short names → SorareInside capture slugs
    kasimpasa: ["kasimpasa-spor-kulubu"],
    konyaspor: ["tumosan-konyaspor-kulubu"],
    corum: ["yeni-corumspor-spor-kulubu"],
    "corum-fk": ["yeni-corumspor-spor-kulubu"],
    alanyaspor: ["alanyaspor-kulubu"],
    kocaelispor: ["kocaelispor-kulubu"],
    gaziantep: ["gazisehir-gaziantep-futbol-kulubu"],
    "gaziantep-fk": ["gazisehir-gaziantep-futbol-kulubu"],
    basaksehir: ["istanbul-basaksehir-futbol-kulubu"],
    genclerbirligi: ["genclerbirligi-spor-kulubu"],
    trabzonspor: ["trabzonspor-kulubu"],
    galatasaray: ["galatasaray-spor-kulubu"],
    erzurumspor: ["buyuksehir-belediye-erzurum-spor-kulubu"],
    "erzurumspor-fk": ["buyuksehir-belediye-erzurum-spor-kulubu"],
    samsunspor: ["samsunspor-kulubu"],
    fenerbahce: ["fenerbahce-spor-kulubu"],
    eyupspor: ["eyup-spor-kulubu"],
    amed: ["amed-sportif-faaliyetler-kulubu"],
    besiktas: ["besiktas-jimnastik-kulubu"],
    goztepe: ["goztepe-spor-kulubu"],
    rizespor: ["caykur-rize-spor-kulubu"],
    // Bundesliga AF names → SorareInside capture slugs
    bayern: ["fc-bayern-munchen"],
    "bayern-munchen": ["fc-bayern-munchen"],
    leverkusen: ["bayer-04-leverkusen"],
    "bayer-leverkusen": ["bayer-04-leverkusen"],
    freiburg: ["sport-club-freiburg"],
    "sc-freiburg": ["sport-club-freiburg"],
    werder: ["sv-werder-bremen"],
    "werder-bremen": ["sv-werder-bremen"],
    "union-berlin": ["1-fc-union-berlin"],
    "fc-union-berlin": ["1-fc-union-berlin"],
    mainz: ["1-fsv-mainz-05"],
    "mainz-05": ["1-fsv-mainz-05"],
    "fsv-mainz-05": ["1-fsv-mainz-05"],
    hoffenheim: ["tsg-hoffenheim"],
    "1899-hoffenheim": ["tsg-hoffenheim"],
    heidenheim: ["1-fc-heidenheim-1846"],
    "fc-heidenheim": ["1-fc-heidenheim-1846"],
    "1-fc-heidenheim": ["1-fc-heidenheim-1846"],
    koln: ["1-fc-koln"],
    "fc-koln": ["1-fc-koln"],
    // Championship AF short names → SorareInside capture slugs
    birmingham: ["birmingham-city"],
    blackburn: ["blackburn-rovers"],
    cardiff: ["cardiff-city"],
    charlton: ["charlton-athletic"],
    derby: ["derby-county"],
    norwich: ["norwich-city"],
    preston: ["preston-north-end"],
    qpr: ["queens-park-rangers"],
    "sheffield-utd": ["sheffield-united"],
    sheffield: ["sheffield-united"],
    swansea: ["swansea-city"],
    "west-brom": ["west-bromwich-albion"],
    "west-ham": ["west-ham-united"],
    bolton: ["bolton-wanderers"],
    lincoln: ["lincoln-city"],
  };
  const out = new Set([base]);
  for (const [k, vs] of Object.entries(extras)) {
    if (base === k || base.startsWith(k)) vs.forEach((v) => out.add(v));
  }
  if (base.includes("brighton")) out.add("brighton-and-hove-albion");
  if (base.includes("tottenham")) out.add("tottenham-hotspur");
  if (base.includes("internazionale") || base === "inter") {
    out.add("fc-internazionale-milano");
  }
  return [...out];
}

function parseTour(round) {
  const m = String(round).match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

function roundLabel(tour) {
  return `Regular Season - ${tour}`;
}

function openDb() {
  if (!existsSync(DB_PATH)) throw new Error(`DB not found: ${DB_PATH}`);
  return new Database(DB_PATH, { readonly: true });
}

function resolveTour(db, leagueId, season, tour) {
  if (tour != null) return { tour, afRound: roundLabel(tour) };
  const upcoming = db
    .prepare(
      `SELECT round, MIN(date) AS mind
       FROM fixtures
       WHERE league_id = ? AND season = ? AND IFNULL(is_preseason, 0) = 0
         AND status IN ('NS','TBD','1H','HT','2H','ET','P','LIVE')
       GROUP BY round ORDER BY mind LIMIT 1`,
    )
    .get(leagueId, season);
  const row =
    upcoming ||
    db
      .prepare(
        `SELECT round FROM fixtures
         WHERE league_id = ? AND season = ? AND IFNULL(is_preseason, 0) = 0
         ORDER BY ABS(julianday(date) - julianday('now')) LIMIT 1`,
      )
      .get(leagueId, season);
  if (!row) throw new Error(`No fixtures for league=${leagueId} season=${season}`);
  const n = parseTour(row.round);
  if (n == null) throw new Error(`Cannot parse tour from: ${row.round}`);
  return { tour: n, afRound: row.round };
}

function loadFixtures(db, leagueId, season, afRound) {
  const oddsCols = new Set(
    db.prepare(`PRAGMA table_info(fixture_odds)`).all().map((c) => c.name),
  );
  const topScoresExpr = oddsCols.has("top_scores")
    ? "o.top_scores AS topScoresJson"
    : "NULL AS topScoresJson";
  const anytimeExpr = oddsCols.has("anytime_scorers")
    ? "o.anytime_scorers AS anytimeScorersJson"
    : "NULL AS anytimeScorersJson";
  return db
    .prepare(
      `SELECT f.id, f.date, f.status, th.name AS home, ta.name AS away,
              o.bookmaker,
              o.home_win_prob AS homeWinProb,
              o.draw_prob AS drawProb,
              o.away_win_prob AS awayWinProb,
              o.home_cs_prob AS homeCsProb,
              o.away_cs_prob AS awayCsProb,
              o.home_score_prob AS homeScoreProb,
              o.away_score_prob AS awayScoreProb,
              o.popular_score AS popularScore,
              ${topScoresExpr},
              ${anytimeExpr}
       FROM fixtures f
       JOIN teams th ON th.id = f.home_team_id
       JOIN teams ta ON ta.id = f.away_team_id
       LEFT JOIN fixture_odds o ON o.fixture_id = f.id
       WHERE f.league_id = ? AND f.season = ? AND f.round = ?
         AND IFNULL(f.is_preseason, 0) = 0
       ORDER BY f.date, f.id`,
    )
    .all(leagueId, season, afRound);
}

function parseJsonArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseTopScores(raw) {
  return parseJsonArray(raw);
}

function formatPct(p) {
  if (p == null || !Number.isFinite(Number(p))) return null;
  return `${Math.round(Number(p) * 100)}%`;
}

function fixtureOdds(f) {
  const topScores = parseTopScores(f.topScoresJson)
    .map((row) => {
      const score = String(row?.score || "").trim();
      const prob = Number(row?.prob);
      if (!score) return null;
      return {
        score,
        pct: Number.isFinite(prob) ? formatPct(prob) : null,
      };
    })
    .filter(Boolean);
  if (!topScores.length && f.popularScore) {
    topScores.push({ score: String(f.popularScore), pct: null });
  }
  const anytimeScorers = parseJsonArray(f.anytimeScorersJson)
    .map((row) => {
      const name = String(row?.name || "").trim();
      const prob = Number(row?.prob);
      const side = row?.side === "home" || row?.side === "away" ? row.side : null;
      if (!name || !Number.isFinite(prob)) return null;
      return { name, pct: formatPct(prob), side };
    })
    .filter(Boolean)
    .slice(0, 8);
  const hasAny =
    f.homeWinProb != null ||
    f.homeCsProb != null ||
    f.awayCsProb != null ||
    f.homeScoreProb != null ||
    f.awayScoreProb != null ||
    topScores.length > 0 ||
    anytimeScorers.length > 0;
  if (!hasAny) return null;
  return {
    bookmaker: f.bookmaker || null,
    homeWin: formatPct(f.homeWinProb),
    draw: formatPct(f.drawProb),
    awayWin: formatPct(f.awayWinProb),
    homeCs: formatPct(f.homeCsProb),
    awayCs: formatPct(f.awayCsProb),
    homeScore: formatPct(f.homeScoreProb),
    awayScore: formatPct(f.awayScoreProb),
    topScores,
    anytimeScorers,
  };
}

async function fetchSorareKickoffs(leagueId) {
  if (leagueId !== 135) return new Map();
  try {
    const res = await fetch("http://127.0.0.1:3002/api/sorare/matches");
    if (!res.ok) return new Map();
    const raw = await res.text();
    const data = JSON.parse(raw.replace(/[\u0000-\u001f]/g, " "));
    const map = new Map();
    for (const m of data.matches || []) {
      if (m.leagueLabel !== "Italy - Serie A") continue;
      const home = m.home?.teamName || "";
      const away = m.away?.teamName || "";
      if (!home || !away || !m.date) continue;
      map.set(`${norm(home)}|${norm(away)}`, m.date);
    }
    return map;
  } catch {
    return new Map();
  }
}

function applySorareKickoff(fixture, sorareDates) {
  if (!sorareDates?.size) return fixture.date;
  const direct = sorareDates.get(`${norm(fixture.home)}|${norm(fixture.away)}`);
  if (direct) return direct;
  for (const [key, date] of sorareDates) {
    const [h, a] = key.split("|");
    if (namesOk(fixture.home, h) && namesOk(fixture.away, a)) return date;
  }
  return fixture.date;
}

function normalizeNotes(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const key of Object.keys(NOTE_LABELS)) {
    const v = raw[key];
    let text = "";
    let label = NOTE_LABELS[key];
    if (typeof v === "string") {
      text = sanitizeSorareAnalystNote(v);
    } else if (v && typeof v === "object") {
      text = sanitizeSorareAnalystNote(String(v.text || ""));
      label = String(v.label || NOTE_LABELS[key]);
    }
    if (!text) continue;
    out[key] = { label, text };
  }
  return out;
}

function loadSorare(tour, teamName) {
  const dir = path.join(SORARE_DIR, String(tour));
  if (!existsSync(dir)) return { probs: [], images: [], notes: {} };
  for (const slug of slugAliases(teamName)) {
    const jsonPath = path.join(dir, `${slug}.json`);
    if (!existsSync(jsonPath)) continue;
    const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
    const probs = (raw.probabilities || [])
      .filter((p) => p?.name && !isChromePlayerName(p.name))
      .map((p) => {
        const group = String(p.group || "starting").toLowerCase();
        const isOut = group === "out" || p.percentage == null;
        return {
          name: p.name,
          pct: isOut || p.percentage == null ? null : Number(p.percentage),
          source: "sorare",
          group: isOut ? "out" : group === "bench" ? "bench" : "starting",
        };
      })
      .filter((p) => p.group === "out" || Number.isFinite(p.pct));
    const images = [];
    for (const rel of [raw.screenshot, raw.greenScreenshot]) {
      if (!rel) continue;
      const abs = path.isAbsolute(rel) ? rel : path.join(SORARE_DIR, rel);
      if (existsSync(abs)) images.push(abs);
    }
    for (const name of [`${slug}.png`, `${slug}-green.png`]) {
      const abs = path.join(dir, name);
      if (existsSync(abs) && !images.includes(abs)) images.push(abs);
    }
    return { probs, images, notes: normalizeNotes(raw.notes) };
  }
  return { probs: [], images: [], notes: {} };
}

function e11Pct(p) {
  if (p.probabilities?.starter != null && Number.isFinite(p.probabilities.starter)) {
    return Math.round(Number(p.probabilities.starter) * 100);
  }
  for (const s of [p.predictionLabel, p.raw?.starterText, p.raw?.text]) {
    const m = String(s || "").match(/(\d+)\s*%/);
    if (m) return Number(m[1]);
  }
  return null;
}

function titleHasTeams(title, home, away) {
  const t = norm(title);
  const h = norm(home);
  const a = norm(away);
  if (t.includes(h) && t.includes(a)) return true;
  // Prefer distinctive tokens (skip "as"/"fc"/…); "AS Roma" → "roma".
  const SKIP = new Set(["as", "fc", "ac", "us", "ss", "ssc", "afc", "calcio", "club"]);
  const token = (name) => {
    const parts = norm(name).split(" ").filter(Boolean);
    return parts.find((p) => p.length >= 3 && !SKIP.has(p)) || parts.find((p) => p.length >= 3) || "";
  };
  const h0 = token(home);
  const a0 = token(away);
  return Boolean(h0 && a0 && t.includes(h0) && t.includes(a0));
}

function findE11(home, away) {
  if (!existsSync(E11_DIR)) return null;
  const files = readdirSync(E11_DIR)
    .filter((f) => f.startsWith("expected11-") && f.endsWith(".json"))
    .map((f) => path.join(E11_DIR, f))
    .sort()
    .reverse();

  for (const file of files) {
    let snap;
    try {
      snap = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const m of snap.matches || []) {
      const mh = m.match?.homeTeam || "";
      const ma = m.match?.awayTeam || "";
      const title = m.match?.title || "";
      const ok =
        (namesOk(home, mh) && namesOk(away, ma)) ||
        titleHasTeams(title, home, away);
      if (!ok) continue;

      const sideOf = (teamName, side) => {
        const team = (m.teams || []).find(
          (t) => t.side === side || namesOk(t.name || "", teamName),
        );
        const probs = (m.players || [])
          .filter(
            (p) =>
              namesOk(p.team || "", teamName) ||
              (team?.name && namesOk(p.team || "", team.name)),
          )
          .map((p) => {
            const pct = e11Pct(p);
            if (pct == null || !p.name) return null;
            const group = String(p.lineupGroup || "starting").toLowerCase();
            return {
              name: p.name,
              pct,
              source: "expected11",
              group:
                group === "out" || group === "dnp"
                  ? "out"
                  : group === "bench"
                    ? "bench"
                    : "starting",
            };
          })
          .filter(Boolean);
        return {
          probs,
          notes: normalizeNotes(team?.notes || {}),
          author: team?.author || null,
        };
      };

      return { home: sideOf(home, "home"), away: sideOf(away, "away") };
    }
  }
  return null;
}

function e11Shot(tour, teamName) {
  const dir = path.join(E11_DIR, String(tour));
  if (!existsSync(dir)) return null;
  for (const slug of slugAliases(teamName)) {
    const p = path.join(dir, `${slug}.png`);
    if (existsSync(p)) return p;
  }
  return null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatKickoff(iso, timeZone = "Europe/Warsaw") {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function bucketOf(group) {
  const g = String(group || "starting").toLowerCase();
  if (g === "out" || g === "dnp") return "out";
  if (g === "bench") return "bench";
  return "starting";
}

function mergeProbBuckets(a, b) {
  const rows = [];
  const find = (name) => rows.find((r) => namesOk(r.name, name));
  const add = (p) => {
    const hit = find(p.name);
    const bucket = bucketOf(p.group);
    const asSorare =
      p.source === "sorare" || p.source === "gazetka" || p.source === "footmops";
    if (!hit) {
      rows.push({
        name: p.name,
        sorare: asSorare ? p.pct : undefined,
        e11: p.source === "expected11" ? p.pct : undefined,
        bucket,
      });
      return;
    }
    if (asSorare) hit.sorare = p.pct;
    else hit.e11 = p.pct;
    // Keep the best status (starting > bench > out), never demote a starter.
    const rank = { starting: 0, bench: 1, out: 2 };
    if (rank[bucket] < rank[hit.bucket]) hit.bucket = bucket;
  };
  a.forEach(add);
  b.forEach(add);

  const mergedPct = (r) => {
    if (r.sorare != null && r.e11 != null) return Math.round((r.sorare + r.e11) / 2);
    return r.sorare ?? r.e11 ?? -1;
  };

  const formatRow = (r) => {
    if (r.bucket === "out") return `· ❌ ${escapeHtml(r.name)}`;
    const parts = [];
    if (r.sorare != null) parts.push(`Sorare ${r.sorare}%`);
    if (r.e11 != null) parts.push(`E11 ${r.e11}%`);
    const merged = r.sorare != null && r.e11 != null
      ? Math.round((r.sorare + r.e11) / 2)
      : (r.sorare ?? r.e11 ?? null);
    if (merged == null) return null;
    const detail =
      parts.length > 1
        ? ` → <b>${merged}%</b> (${parts.join(" · ")})`
        : ` <b>${merged}%</b>`;
    return `· ${escapeHtml(r.name)}${detail}`;
  };

  const pick = (bucket, limit) =>
    rows
      .filter((r) => r.bucket === bucket)
      .sort((a, b) =>
        bucket === "out"
          ? 0
          : mergedPct(b) - mergedPct(a) || String(a.name).localeCompare(String(b.name)),
      )
      .map(formatRow)
      .filter(Boolean)
      .slice(0, limit);

  return {
    starting: pick("starting", 11),
    bench: pick("bench", 20),
    out: pick("out", 20),
  };
}

function notesHtml(title, notes, author) {
  const order = [
    "teamAnalysis",
    "injuriesAndRecovery",
    "suspensionsAndIneligibilities",
    "additionalNotes",
  ];
  const chunks = [];
  for (const key of order) {
    const n = notes?.[key];
    const text = (n?.text || "").trim();
    if (!text || text === "." || /^none$/i.test(text)) continue;
    chunks.push(
      `<b>${escapeHtml(n?.label || NOTE_LABELS[key] || key)}</b>\n${escapeHtml(text)}`,
    );
  }
  if (!chunks.length) return "";
  const head = author
    ? `<b>${escapeHtml(title)}</b> <i>(${escapeHtml(author)})</i>`
    : `<b>${escapeHtml(title)}</b>`;
  return `${head}\n${chunks.join("\n\n")}`;
}

function mergeNoteMaps(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (!out[k]) {
      out[k] = v;
      continue;
    }
    if (v?.text && out[k]?.text && out[k].text !== v.text) {
      out[k] = {
        label: out[k].label || v.label,
        text: `${out[k].text}\n\n${v.text}`,
      };
    }
  }
  return out;
}

function loadFootmopsSnap(leagueSlug, tour) {
  if (!leagueSlug || tour == null) return null;
  const file = path.join(FOOTMOPS_DIR, `${leagueSlug}-tour-${tour}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function clubTokens(name) {
  const SKIP = new Set([
    "as",
    "fc",
    "ac",
    "us",
    "ss",
    "ssc",
    "afc",
    "cf",
    "sc",
    "kghm",
    "pko",
    "bp",
    "krakow",
    "kraków",
    "lodz",
    "łódź",
    "wroclaw",
    "wrocław",
    "warszawa",
    "poznan",
    "poznań",
    "bialystok",
    "białystok",
    "szczecin",
    "gliwice",
    "lublin",
    "zabrze",
    "lubin",
    "kielce",
    "plock",
    "płock",
    "radom",
    "katowice",
    "czestochowa",
    "częstochowa",
  ]);
  return norm(name)
    .split(" ")
    .filter((t) => t.length >= 3 && !SKIP.has(t));
}

function clubsOk(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = clubTokens(a);
  const tb = clubTokens(b);
  if (!ta.length || !tb.length) return false;
  // Distinctive token overlap (avoid "cracovia" ⊆ "rakow" false positives).
  if (ta.some((t) => tb.includes(t))) return true;
  const a0 = ta[0];
  const b0 = tb[0];
  return a0.startsWith(b0) || b0.startsWith(a0);
}

function footmopsProbsForTeam(snap, teamName) {
  if (!snap?.matches?.length) return [];
  for (const m of snap.matches) {
    for (const team of m.teams || []) {
      if (!clubsOk(team.name || "", teamName)) continue;
      return (team.players || [])
        .map((p) => {
          const group = String(p.group || "starting").toLowerCase();
          const isOut = group === "out";
          const pct = isOut ? null : Number(p.percentage);
          if (!p?.name) return null;
          if (!isOut && !Number.isFinite(pct)) return null;
          return {
            name: p.name,
            pct: isOut ? null : pct,
            source: "gazetka",
            group: isOut ? "out" : group === "bench" ? "bench" : "starting",
          };
        })
        .filter(Boolean);
    }
  }
  return [];
}

function applyGazetkaKickoffs(leagueId, tour, fixtures) {
  if (leagueId !== 106 || tour !== 9) return fixtures;
  return fixtures.map((f) => {
    const hit = EKSTRAKLASA_GW9_KICKOFFS.find(
      (k) => clubsOk(f.home, k.home) && clubsOk(f.away, k.away),
    );
    return hit ? { ...f, date: hit.iso } : f;
  });
}

function buildSide(tour, teamName, e11Side, footmopsSnap) {
  const sorare = loadSorare(tour, teamName);
  const footmops = footmopsProbsForTeam(footmopsSnap, teamName);
  const shot = e11Shot(tour, teamName);
  const images = [...sorare.images];
  if (shot) images.push(shot);
  // Prefer live Sorare probs; fall back to gazetka/footmops lineups.
  const sorareProbs = sorare.probs.length ? sorare.probs : footmops;
  return {
    name: teamName,
    sorareProbs,
    e11Probs: e11Side?.probs || [],
    notes: mergeNoteMaps(sorare.notes, e11Side?.notes || {}),
    author: e11Side?.author || null,
    images: [...new Set(images)],
  };
}

export async function buildBundle({ leagueId, season, tour, upcomingOnly }) {
  const meta = LEAGUES[leagueId];
  if (!meta) {
    throw new Error(
      `League ${leagueId} is not configured (39=PL, 40=Championship, 78=Bundesliga, 106=Ekstraklasa, 135=Serie A, 203=Süper Lig)`,
    );
  }
  const sorareDates = await fetchSorareKickoffs(leagueId);
  const db = openDb();
  try {
    const resolved = resolveTour(db, leagueId, season, tour);
    const footmopsSnap = loadFootmopsSnap(meta.slug, resolved.tour);
    let fixtures = loadFixtures(db, leagueId, season, resolved.afRound).map((f) => ({
      ...f,
      date: applySorareKickoff(f, sorareDates),
    }));
    fixtures = applyGazetkaKickoffs(leagueId, resolved.tour, fixtures);
    if (upcomingOnly) {
      const now = Date.now();
      fixtures = fixtures.filter((f) => new Date(f.date).getTime() >= now - 30 * 60_000);
    }
    fixtures.sort(
      (a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id,
    );
    if (!fixtures.length) {
      throw new Error(
        `Empty tour ${resolved.afRound} league=${leagueId} season=${season}` +
          (upcomingOnly ? " (upcoming only)" : ""),
      );
    }
    const matches = fixtures.map((f) => {
      const e11 = findE11(f.home, f.away);
      return {
        kickoff: f.date,
        odds: fixtureOdds(f),
        home: buildSide(resolved.tour, f.home, e11?.home, footmopsSnap),
        away: buildSide(resolved.tour, f.away, e11?.away, footmopsSnap),
      };
    });
    return {
      leagueId,
      season,
      tour: resolved.tour,
      afRound: resolved.afRound,
      meta,
      matches,
    };
  } finally {
    db.close();
  }
}

export function mainCaption(bundle) {
  const lines = [
    `<b>${bundle.meta.nameEn}</b>`,
    `Gameweek <b>${bundle.tour}</b>`,
    `<i>${escapeHtml(bundle.afRound)} · season ${bundle.season}</i>`,
    "",
    "<b>Fixtures</b>",
  ];
  for (const m of bundle.matches) {
    lines.push(
      `• ${escapeHtml(formatKickoff(m.kickoff))} — <b>${escapeHtml(m.home.name)}</b> vs <b>${escapeHtml(m.away.name)}</b>`,
    );
  }
  lines.push("", "Match details in the comments 👇");
  return lines.join("\n");
}

function sideProbBlock(side) {
  const lines = [];
  const buckets = mergeProbBuckets(side.sorareProbs, side.e11Probs);
  if (buckets.starting.length) {
    lines.push("<b>Starting XI (merged)</b>");
    lines.push(...buckets.starting);
  }
  if (buckets.bench.length) {
    lines.push("<b>Bench</b>");
    lines.push(...buckets.bench);
  }
  if (buckets.out.length) {
    lines.push("<b>OUT</b>");
    lines.push(...buckets.out);
  }
  if (!buckets.starting.length && !buckets.bench.length && !buckets.out.length) {
    lines.push("<i>No Sorare / Expected11 probabilities</i>");
  }
  return lines;
}

function oddsBlock(m) {
  const o = m.odds;
  if (!o) return ["<i>No bookmaker odds for this match</i>", ""];
  const lines = [
    o.bookmaker
      ? `<b>Bookmaker</b> · ${escapeHtml(o.bookmaker)}`
      : "<b>Bookmaker</b>",
  ];
  if (o.homeWin || o.draw || o.awayWin) {
    lines.push(
      `P(win): <b>${escapeHtml(m.home.name)} ${o.homeWin || "—"}</b>` +
        ` · Draw ${o.draw || "—"}` +
        ` · <b>${escapeHtml(m.away.name)} ${o.awayWin || "—"}</b>`,
    );
  }
  if (o.homeCs || o.awayCs) {
    lines.push(
      `CS: ${escapeHtml(m.home.name)} ${o.homeCs || "—"}` +
        ` · ${escapeHtml(m.away.name)} ${o.awayCs || "—"}`,
    );
  }
  if (o.homeScore || o.awayScore) {
    lines.push(
      `P(score ≥1): ${escapeHtml(m.home.name)} ${o.homeScore || "—"}` +
        ` · ${escapeHtml(m.away.name)} ${o.awayScore || "—"}`,
    );
  }
  if (o.topScores?.length) {
    const label = o.topScores.length > 1 ? "Top scores" : "Most likely";
    const parts = o.topScores.map((s) =>
      s.pct ? `${escapeHtml(s.score)} (${s.pct})` : escapeHtml(s.score),
    );
    lines.push(`${label}: ${parts.join(" · ")}`);
  }
  if (o.anytimeScorers?.length) {
    const tagged = o.anytimeScorers.filter((p) => p.side);
    if (tagged.length >= Math.min(4, o.anytimeScorers.length)) {
      const home = o.anytimeScorers.filter((p) => p.side === "home").slice(0, 4);
      const away = o.anytimeScorers.filter((p) => p.side === "away").slice(0, 4);
      lines.push("<b>Anytime scorer</b>");
      if (home.length) {
        lines.push(
          `${escapeHtml(m.home.name)}: ` +
            home.map((p) => `${escapeHtml(p.name)} ${p.pct}`).join(" · "),
        );
      }
      if (away.length) {
        lines.push(
          `${escapeHtml(m.away.name)}: ` +
            away.map((p) => `${escapeHtml(p.name)} ${p.pct}`).join(" · "),
        );
      }
    } else {
      lines.push(
        `<b>Anytime scorer</b>: ` +
          o.anytimeScorers
            .map((p) => `${escapeHtml(p.name)} ${p.pct}`)
            .join(" · "),
      );
    }
  }
  lines.push("");
  return lines;
}

export function matchCaption(m) {
  const lines = [
    `<b>${escapeHtml(m.home.name)} — ${escapeHtml(m.away.name)}</b>`,
    `🕒 ${escapeHtml(formatKickoff(m.kickoff))}`,
    "",
    ...oddsBlock(m),
  ];
  for (const side of [m.home, m.away]) {
    const icon = side === m.home ? "🏠" : "✈️";
    lines.push(`${icon} <b>${escapeHtml(side.name)}</b>`);
    lines.push(...sideProbBlock(side));
    lines.push("");
  }
  const hn = notesHtml(`Analyst notes · ${m.home.name}`, m.home.notes, m.home.author);
  const an = notesHtml(`Analyst notes · ${m.away.name}`, m.away.notes, m.away.author);
  if (hn) lines.push(hn, "");
  if (an) lines.push(an, "");
  if (!hn && !an) {
    lines.push("<i>No analyst text (screenshots + probabilities only).</i>");
  }
  let text = lines.join("\n").trim();
  if (text.length > 3900) {
    let cut = text.slice(0, 3890);
    cut = cut.replace(/<[^>]*$/, "");
    const openB =
      (cut.match(/<b>/g) || []).length - (cut.match(/<\/b>/g) || []).length;
    const openI =
      (cut.match(/<i>/g) || []).length - (cut.match(/<\/i>/g) || []).length;
    text =
      cut +
      "</b>".repeat(Math.max(0, openB)) +
      "</i>".repeat(Math.max(0, openI)) +
      "…";
  }
  return text;
}

async function getUpdatesOffset(token) {
  const updates = await tg(token, "getUpdates", { timeout: 0, limit: 100 });
  if (!updates?.length) return undefined;
  return updates[updates.length - 1].update_id + 1;
}

async function waitForDiscussionRoot(
  token,
  discussionId,
  channelMsgId,
  { timeoutMs = 25_000, offset } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let nextOffset = offset;
  let conflictStreak = 0;

  while (Date.now() < deadline) {
    let updates;
    try {
      updates = await tg(token, "getUpdates", {
        timeout: 3,
        allowed_updates: ["message"],
        ...(nextOffset != null ? { offset: nextOffset } : {}),
      });
      conflictStreak = 0;
    } catch (e) {
      const msg = String(e?.message || e);
      if (/Conflict: terminated by other getUpdates/i.test(msg)) {
        conflictStreak += 1;
        console.warn("getUpdates conflict — retrying in 2s…");
        await new Promise((r) => setTimeout(r, 2000));
        // Another long-poll owns this token — fall back to probe.
        if (conflictStreak >= 3) {
          console.warn(
            "getUpdates still conflicted — probing discussion group for auto-forward…",
          );
          return findDiscussionRootByProbe(token, discussionId, channelMsgId);
        }
        continue;
      }
      throw e;
    }
    for (const u of updates || []) {
      if (u.update_id != null) nextOffset = u.update_id + 1;
      const m = u.message;
      if (!m) continue;
      if (String(m.chat?.id) !== String(discussionId)) continue;
      const fwd =
        m.forward_from_message_id ?? m.forward_origin?.message_id ?? null;
      if (m.is_automatic_forward && fwd === channelMsgId) {
        return m.message_id;
      }
      if (fwd === channelMsgId) return m.message_id;
    }
  }
  // Auto-forward may already have been delivered (and consumed) before we
  // started polling — walk recent discussion ids.
  return findDiscussionRootByProbe(token, discussionId, channelMsgId);
}

/** Probe recent discussion messages by reply_to until auto-forward of channelMsgId. */
async function findDiscussionRootByProbe(token, discussionId, channelMsgId) {
  // Seed from a throwaway message so we know the current high-water mark.
  let seed;
  try {
    seed = await tg(token, "sendMessage", {
      chat_id: discussionId,
      text: ".",
      disable_notification: true,
    });
  } catch (e) {
    console.warn("discussion probe seed failed:", e?.message || e);
    return null;
  }
  const high = Number(seed.message_id);
  try {
    await tg(token, "deleteMessage", {
      chat_id: discussionId,
      message_id: high,
    });
  } catch {
    /* ignore */
  }
  for (let id = high - 1; id >= Math.max(1, high - 80); id--) {
    let res;
    try {
      res = await tg(token, "sendMessage", {
        chat_id: discussionId,
        text: ".",
        reply_to_message_id: id,
        disable_notification: true,
      });
    } catch {
      continue;
    }
    const mid = res.message_id;
    const r = res.reply_to_message || {};
    const fwd =
      r.forward_from_message_id ?? r.forward_origin?.message_id ?? null;
    try {
      await tg(token, "deleteMessage", {
        chat_id: discussionId,
        message_id: mid,
      });
    } catch {
      /* ignore */
    }
    if (fwd === channelMsgId || (r.is_automatic_forward && fwd === channelMsgId)) {
      return id;
    }
  }
  return null;
}

async function sendMatchComment(token, discussionId, discussionRootId, m) {
  const caption = matchCaption(m);
  // Reply to the auto-forwarded channel post INSIDE the discussion group.
  // Cross-chat reply_parameters to the channel only creates an external quote —
  // it does NOT show up as a channel comment count.
  await tg(token, "sendMessage", {
    chat_id: discussionId,
    text: caption.slice(0, 4096),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_to_message_id: discussionRootId,
  });

  const images = [...m.home.images, ...m.away.images].filter((f) => existsSync(f));
  if (!images.length) return;

  const chunk = images.slice(0, 10);
  const form = new FormData();
  form.append("chat_id", String(discussionId));
  form.append("reply_to_message_id", String(discussionRootId));
  form.append(
    "media",
    JSON.stringify(
      chunk.map((_f, i) => ({
        type: "photo",
        media: `attach://file${i}`,
        ...(i === 0
          ? { caption: `${m.home.name} vs ${m.away.name}`.slice(0, 200) }
          : {}),
      })),
    ),
  );
  for (let i = 0; i < chunk.length; i++) {
    form.append(
      `file${i}`,
      new Blob([readFileSync(chunk[i])], { type: "image/png" }),
      path.basename(chunk[i]),
    );
  }
  await tg(token, "sendMediaGroup", form);
}

export async function runAutomopsCli(argv = process.argv) {
  const argOf = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const flag = (name) => argv.includes(`--${name}`);

  if (flag("howto")) {
    console.log(HOWTO);
    return;
  }

  const leagueId = Number(argOf("league", "135"));
  const season = Number(argOf("season", process.env.PREDICT_SEASON || "2026"));
  const tourRaw = argOf("tour");
  const tour = tourRaw ? Number(tourRaw) : undefined;
  const dryRun = flag("dry-run");
  const channelOnly = flag("channel-only");
  const commentsOnly = flag("comments-only");
  const upcomingOnly = flag("upcoming");
  const replyToRaw = argOf("reply-to") || argOf("message-id");
  const replyTo = replyToRaw ? Number(replyToRaw) : undefined;

  if (commentsOnly && !replyTo) {
    throw new Error("For --comments-only pass --reply-to=<channel_message_id>");
  }
  if (channelOnly && commentsOnly) {
    throw new Error("Cannot combine --channel-only and --comments-only");
  }

  if (dryRun) {
    const preview = await buildAutomopsPreview({
      leagueId,
      season,
      tour,
      upcomingOnly,
    });
    console.log(HOWTO);
    console.log("\n--- MAIN ---\n");
    console.log(preview.mainCaption);
    for (const m of preview.matches) {
      console.log("\n--- MATCH ---\n");
      console.log(m.caption);
      console.log(
        `\n# imgs=${m.images.length}` +
          ` sorare=${m.sorareCounts.home}/${m.sorareCounts.away}` +
          ` e11=${m.e11Counts.home}/${m.e11Counts.away}` +
          ` odds=${m.hasOdds ? "yes" : "no"}`,
      );
    }
    console.log(
      `\nOK dry-run tour=${preview.tour} matches=${preview.matches.length} upcoming=${upcomingOnly}`,
    );
    return preview;
  }

  try {
    const result = await publishAutomops({
      leagueId,
      season,
      tour,
      upcomingOnly,
      channelOnly,
      commentsOnly,
      replyTo,
      discussionRoot: argOf("discussion-root", "") || undefined,
      skipMatches: Number(argOf("skip-matches", "0")) || 0,
      only: argOf("only", "") || undefined,
    });
    if (commentsOnly) {
      console.log(
        `Comments-only: attached to channel message_id=${result.channelMessageId} tour=${result.tour}`,
      );
    } else {
      console.log(
        `Posted channel message_id=${result.channelMessageId} tour=${result.tour}` +
          (result.channelUrl ? ` ${result.channelUrl}` : ""),
      );
    }
    if (result.discussionSkipped) {
      console.warn(result.warning || "Discussion skipped.");
      console.warn(HOWTO);
      process.exitCode = 3;
      return result;
    }
    if (!channelOnly) {
      console.log(
        `Done. comments=${result.comments}/${result.commentsExpected}` +
          (result.failures?.length ? ` failures=${result.failures.length}` : ""),
      );
    }
    return result;
  } catch (e) {
    if (e?.code === "automops_discussion_root") {
      console.error(
        "Could not find the discussion-group auto-forward of the channel post.\n" +
          "Re-run publish (fresh channel post), or pass --discussion-root=<group_message_id>.",
      );
      if (e.channelUrl) console.error(e.channelUrl);
      process.exitCode = 4;
      return;
    }
    console.error(String(e?.message || e));
    console.error("\n" + HOWTO);
    process.exitCode = 2;
    throw e;
  }
}
