import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import { fixtureForMatch, type FixtureRow } from "./expected11Premium.js";
import { withStartingXiFallbackPercentage } from "./expected11.js";

export const EXPECTED11_XI_LEAGUE_ID = 40;
const EXPECTED11_XI_TOURNAMENT_ID = 11;

export type Expected11XiPrediction = {
  mantraPlayerId: number;
  sourceMatchId: string;
  sourceMatchUrl: string;
  sourceMatchTitle: string;
  sourceClub: string;
  opponent: string | null;
  lineupGroup: "starting" | "bench" | "out";
  displayedPercentage: number | null;
  starterProbability: number | null;
  expected11PlayerUrl: string | null;
  extractedAt: string;
  importedAt: string;
  updatedAt: string;
  kickoff: string | null;
  kickoffKnown: boolean;
  freshness: "upcoming" | "unknown" | "stale";
  provenance: "expected11";
  influencedSelection: boolean;
  influenceReason: "starter_probability" | "out_exclusion" | null;
  outFallback: boolean;
};

type PredictionRow = {
  match_id: string;
  team_side: "home" | "away";
  lineup_group: "starting" | "bench" | "out";
  sort_order: number;
  displayed_percentage: number | null;
  player_path: string | null;
  mantra_player_id: number;
  source_url: string;
  title: string;
  home_team: string | null;
  away_team: string | null;
  extracted_at: string;
  imported_at: string;
  source_club_name: string;
  mantra_club_id: number;
};

function tmPlayerId(url: string | null): string | null {
  return url?.match(/\/spieler\/(\d+)(?:[/?#]|$)/i)?.[1] ?? null;
}

function utcTimestamp(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
}

function relevantFixtures(database: Database.Database): FixtureRow[] {
  return database
    .prepare(
      `SELECT f.id, COALESCE(o.kickoff, f.date) AS kickoff,
              f.league_id, f.season, f.status,
              (SELECT st.name FROM season_teams st
               WHERE st.team_id = f.home_team_id AND st.season = f.season
                 AND (st.league_id = f.league_id OR st.league_id IS NULL)
               LIMIT 1) AS home_name,
              (SELECT st.name FROM season_teams st
               WHERE st.team_id = f.away_team_id AND st.season = f.season
                 AND (st.league_id = f.league_id OR st.league_id IS NULL)
               LIMIT 1) AS away_name,
              o.home_odd, o.draw_odd, o.away_odd, o.bookmaker
       FROM fixtures f
       LEFT JOIN fixture_odds o ON o.fixture_id = f.id
       WHERE f.league_id = ? AND f.date IS NOT NULL`,
    )
    .all(EXPECTED11_XI_LEAGUE_ID) as FixtureRow[];
}

function stablePlayerLinks(
  database: Database.Database,
  afPlayerIds: number[],
): Map<number, number> {
  if (afPlayerIds.length === 0) return new Map();
  const placeholders = afPlayerIds.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT pv.af_player_id AS afPlayerId, pv.tm_player_id AS tmPlayerId,
              mp.id AS mantraPlayerId, mp.tm_url AS mantraTmUrl
       FROM player_values pv
       JOIN mantra_players mp
         ON mp.tournament_id = ?
        AND mp.tm_url LIKE '%/spieler/' || pv.tm_player_id || '%'
       WHERE pv.af_player_id IN (${placeholders})
         AND pv.af_player_id IS NOT NULL AND mp.tm_url IS NOT NULL`,
    )
    .all(EXPECTED11_XI_TOURNAMENT_ID, ...afPlayerIds) as Array<{
    afPlayerId: number;
    tmPlayerId: string;
    mantraPlayerId: number;
    mantraTmUrl: string;
  }>;

  const candidates = new Map<number, Set<number>>();
  const afIdsByMantra = new Map<number, Set<number>>();
  for (const row of rows) {
    if (tmPlayerId(row.mantraTmUrl) !== String(row.tmPlayerId)) continue;
    const mantraIds = candidates.get(row.afPlayerId) ?? new Set<number>();
    mantraIds.add(row.mantraPlayerId);
    candidates.set(row.afPlayerId, mantraIds);
    const afIds = afIdsByMantra.get(row.mantraPlayerId) ?? new Set<number>();
    afIds.add(row.afPlayerId);
    afIdsByMantra.set(row.mantraPlayerId, afIds);
  }

  const links = new Map<number, number>();
  for (const [afPlayerId, mantraIds] of candidates) {
    if (mantraIds.size !== 1) continue;
    const mantraPlayerId = [...mantraIds][0]!;
    if (afIdsByMantra.get(mantraPlayerId)?.size !== 1) continue;
    links.set(afPlayerId, mantraPlayerId);
  }
  return links;
}

function compareNewest(a: PredictionRow[], b: PredictionRow[]): number {
  const ar = a[0]!;
  const br = b[0]!;
  return (
    Date.parse(br.extracted_at) - Date.parse(ar.extracted_at) ||
    Date.parse(br.imported_at) - Date.parse(ar.imported_at) ||
    br.match_id.localeCompare(ar.match_id, "en", { numeric: true })
  );
}

export function expected11SnapshotVersion(
  database: Database.Database = getDb(),
): string | null {
  const row = database
    .prepare(
      `SELECT
         (SELECT MAX(imported_at) FROM expected11_matches) AS importedAt,
         (SELECT MAX(extracted_at) FROM expected11_matches) AS extractedAt,
         (SELECT MAX(updated_at) FROM expected11_manual_mappings) AS mappingAt`,
    )
    .get() as {
    importedAt: string | null;
    extractedAt: string | null;
    mappingAt: string | null;
  };
  return [row.importedAt, row.extractedAt, row.mappingAt].filter(Boolean).join("|") || null;
}

export function expected11XiPredictionsForAfPlayers(
  leagueId: number,
  afPlayerIds: number[],
  options: {
    now?: Date;
    database?: Database.Database;
  } = {},
): Map<number, Expected11XiPrediction> {
  if (leagueId !== EXPECTED11_XI_LEAGUE_ID) return new Map();
  const database = options.database ?? getDb();
  const uniqueAfIds = [...new Set(afPlayerIds.filter(Number.isSafeInteger))];
  const links = stablePlayerLinks(database, uniqueAfIds);
  if (links.size === 0) return new Map();

  const mantraIds = [...new Set(links.values())];
  const placeholders = mantraIds.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT p.match_id, p.team_side, p.lineup_group, p.sort_order,
              p.displayed_percentage, p.player_path, p.mantra_player_id,
              m.source_url, m.title, m.home_team, m.away_team,
              m.extracted_at, m.imported_at,
              t.source_name AS source_club_name, t.mantra_club_id
       FROM expected11_predictions p
       JOIN expected11_matches m ON m.id = p.match_id
       JOIN expected11_teams t
         ON t.match_id = p.match_id AND t.side = p.team_side
       JOIN mantra_players mp ON mp.id = p.mantra_player_id
       WHERE p.link_status = 'linked'
         AND t.link_status = 'linked'
         AND p.mantra_player_id IN (${placeholders})
         AND mp.tournament_id = ?
         AND mp.club_id = t.mantra_club_id
       ORDER BY datetime(m.extracted_at) DESC, datetime(m.imported_at) DESC,
                CAST(m.id AS INTEGER) DESC, p.sort_order`,
    )
    .all(...mantraIds, EXPECTED11_XI_TOURNAMENT_ID) as PredictionRow[];
  if (rows.length === 0) return new Map();

  const nowMs = (options.now ?? new Date()).getTime();
  const fixtures = relevantFixtures(database);
  const contexts = new Map<
    string,
    ReturnType<typeof fixtureForMatch>
  >();
  for (const row of rows) {
    if (!contexts.has(row.match_id)) {
      contexts.set(
        row.match_id,
        fixtureForMatch(
          { homeTeam: row.home_team, awayTeam: row.away_team },
          fixtures,
          nowMs,
        ),
      );
    }
  }

  const clubMatches = new Map<number, Map<string, PredictionRow[]>>();
  for (const row of rows) {
    const matches = clubMatches.get(row.mantra_club_id) ?? new Map<string, PredictionRow[]>();
    const matchRows = matches.get(row.match_id) ?? [];
    matchRows.push(row);
    matches.set(row.match_id, matchRows);
    clubMatches.set(row.mantra_club_id, matches);
  }

  const selectedRows: PredictionRow[] = [];
  for (const matches of clubMatches.values()) {
    const values = [...matches.values()];
    const future = values
      .filter((matchRows) => contexts.get(matchRows[0]!.match_id)?.fixture)
      .sort((a, b) => {
        const aKickoff =
          Date.parse(contexts.get(a[0]!.match_id)?.fixture?.kickoff ?? "") ||
          Number.MAX_SAFE_INTEGER;
        const bKickoff =
          Date.parse(contexts.get(b[0]!.match_id)?.fixture?.kickoff ?? "") ||
          Number.MAX_SAFE_INTEGER;
        return aKickoff - bKickoff || compareNewest(a, b);
      });
    const unknown = values
      .filter((matchRows) => !contexts.get(matchRows[0]!.match_id)?.knownPast)
      .sort(compareNewest);
    const stale = values
      .filter((matchRows) => contexts.get(matchRows[0]!.match_id)?.knownPast)
      .sort(compareNewest);
    selectedRows.push(...(future[0] ?? unknown[0] ?? stale[0] ?? []));
  }

  const afByMantra = new Map<number, number>();
  for (const [afId, mantraId] of links) afByMantra.set(mantraId, afId);
  const groupRank = { starting: 0, bench: 1, out: 2 };
  const selectedByAf = new Map<number, PredictionRow>();
  for (const row of selectedRows) {
    const afId = afByMantra.get(row.mantra_player_id);
    if (afId == null) continue;
    const current = selectedByAf.get(afId);
    if (
      !current ||
      groupRank[row.lineup_group] < groupRank[current.lineup_group] ||
      (row.lineup_group === current.lineup_group && row.sort_order < current.sort_order)
    ) {
      selectedByAf.set(afId, row);
    }
  }

  const result = new Map<number, Expected11XiPrediction>();
  for (const [afPlayerId, row] of selectedByAf) {
    const context = contexts.get(row.match_id)!;
    const freshness = context.fixture
      ? "upcoming"
      : context.knownPast
        ? "stale"
        : "unknown";
    const current = freshness !== "stale";
    const displayedPercentage = withStartingXiFallbackPercentage(
      row.lineup_group,
      row.displayed_percentage,
    );
    const hasStarterPercentage =
      current &&
      (row.lineup_group === "starting" || row.lineup_group === "bench") &&
      displayedPercentage != null;
    const isOut = current && row.lineup_group === "out";
    result.set(afPlayerId, {
      mantraPlayerId: row.mantra_player_id,
      sourceMatchId: row.match_id,
      sourceMatchUrl: row.source_url,
      sourceMatchTitle: row.title,
      sourceClub: row.source_club_name,
      opponent: row.team_side === "home" ? row.away_team : row.home_team,
      lineupGroup: row.lineup_group,
      displayedPercentage,
      starterProbability: hasStarterPercentage
        ? displayedPercentage! / 100
        : null,
      expected11PlayerUrl: row.player_path
        ? new URL(row.player_path, "https://expected11.com").toString()
        : null,
      extractedAt: row.extracted_at,
      importedAt: row.imported_at,
      updatedAt: utcTimestamp(row.imported_at || row.extracted_at),
      kickoff: context.fixture?.kickoff ?? null,
      kickoffKnown: Boolean(context.fixture?.kickoff),
      freshness,
      provenance: "expected11",
      influencedSelection: hasStarterPercentage || isOut,
      influenceReason: hasStarterPercentage
        ? "starter_probability"
        : isOut
          ? "out_exclusion"
          : null,
      outFallback: false,
    });
  }
  return result;
}
