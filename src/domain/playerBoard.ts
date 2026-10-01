import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { leagueById } from "../lib/afLeagues.js";
import { catalogMantraLeagues } from "../lib/mantraLeagueCatalog.js";
import { catalogDivisionsForTournament } from "../lib/liveLeagues.js";
import { namesMatch, normName } from "../lib/names.js";
import { parseDetailRole, roleGroup, type Role } from "../lib/roles.js";
import { loadAfNewTransferMap } from "./newTransfers.js";
import { leaguePlayerRatings } from "./playerRating.js";
import { getComputed } from "../lib/computedCache.js";
import { allSeasonPredictions } from "./predictSeasonXi.js";
import {
  expected11XiPredictionsForAfPlayers,
  type Expected11XiPrediction,
} from "./expected11Xi.js";
import {
  serieALineupForAfPlayers,
  type SerieALineupPrediction,
} from "./serieALineup.js";
import { xiBoardCacheKey, xiCacheVersion } from "./xiCache.js";
import {
  applyLiveDraftTaken,
  loadLiveDraftAwards,
} from "./liveDraftOwnership.js";

export type XiStatus = "starter" | "backup" | "squad";

export type BoardPlayer = {
  playerId: number;
  name: string;
  teamId: number;
  teamName: string;
  role: Role | null;
  roleLabel: string | null;
  /** Extra TM side roles, e.g. "CM, DM". */
  sideRole: string | null;
  group: "GK" | "DEF" | "MID" | "ATT" | null;
  rating: number;
  marketValueEur: number | null;
  minutes: number;
  xiStatus: XiStatus;
  xiSlot: string | null;
  xiTeamId: number | null;
  /** Summer arrival (TM clubAssignments.start + debut filter). */
  isNew: boolean;
  joinedAt: string | null;
  expected11: Expected11XiPrediction | null;
  serieALineup: SerieALineupPrediction | null;
  mantra: {
    id: number;
    positions: string[];
    positionsItal: string[];
    clubName: string | null;
    tmUrl: string | null;
    tmPrice: number | null;
    baseScore: number | null;
    totalScore: number | null;
    appearances: number | null;
    age: number | null;
    height: number | null;
    nationality: string | null;
    /** Fantasy league ids where already owned. */
    takenLeagueIds: number[];
    teamsCount: number;
    /** Live-draft buyer team name when the player was sold in round 1. */
    ownedBy: string | null;
  } | null;
};

export type MantraLeagueOption = {
  id: number;
  name: string;
  division: string;
  label: string;
};

type SquadRow = {
  playerId: number;
  name: string;
  teamId: number;
  teamName: string;
  afPosition: string | null;
  detailRole: string | null;
  detailLabel: string | null;
  sideRole: string | null;
  marketValueEur: number | null;
  minutes: number;
};

type MantraRow = {
  id: number;
  full_name: string;
  name: string;
  first_name: string | null;
  club_name: string | null;
  positions_json: string | null;
  positions_ital_json: string | null;
  tm_url: string | null;
  tm_price: number | null;
  base_score: number | null;
  total_score: number | null;
  appearances: number | null;
  age: number | null;
  height: number | null;
  nationality: string | null;
  leagues_json: string | null;
  teams_count: number | null;
};

function clubsLooselyMatch(afClub: string, mantraClub: string): boolean {
  const a = normName(afClub);
  const b = normName(mantraClub);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const stop = new Set(["krakow", "warszawa", "lodz", "wroclaw", "fc", "ks"]);
  const ta = a.split(" ").filter((t) => t.length > 2 && !stop.has(t));
  const tb = b.split(" ").filter((t) => t.length > 2 && !stop.has(t));
  return ta.some((t) => tb.includes(t));
}

function nameOverlapScore(afName: string, other: string): number {
  const na = normName(afName);
  const nb = normName(other);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (!namesMatch(afName, other)) return 0;
  const ta = na.split(" ").filter((t) => t.length > 1);
  const tb = nb.split(" ").filter((t) => t.length > 1);
  const inter = ta.filter((t) => tb.includes(t));
  // Prefer longer shared surnames / compound names (Thomas-Asante ≫ Thomas).
  const lastA = ta[ta.length - 1] ?? "";
  const lastB = tb[tb.length - 1] ?? "";
  let score = inter.length * 10 + Math.min(na.length, nb.length);
  if (lastA && lastA === lastB) score += 20;
  if (tb.length >= 2 && inter.length >= 2) score += 15;
  return score;
}

function matchMantra(afName: string, afClub: string, mantra: MantraRow[]): MantraRow | null {
  const afTokens = normName(afName).split(" ").filter(Boolean);
  const afLast = afTokens[afTokens.length - 1] ?? "";

  const scored: Array<{ m: MantraRow; score: number }> = [];
  for (const m of mantra) {
    const full = m.full_name || [m.first_name, m.name].filter(Boolean).join(" ");
    const reversed = [m.name, m.first_name].filter(Boolean).join(" ");
    let score = Math.max(nameOverlapScore(afName, full), nameOverlapScore(afName, reversed));

    // Surname-only: require AF *last* token === Mantra surname (never substring "thomas" in Thomas-Asante).
    const manSurname = normName(m.name || "")
      .split(" ")
      .filter(Boolean)
      .pop();
    if (manSurname && afLast && manSurname === afLast && manSurname.length >= 4) {
      score = Math.max(score, 8);
    }

    if (score > 0) scored.push({ m, score });
  }
  if (!scored.length) return null;

  scored.sort((a, b) => {
    const ca = a.m.club_name && clubsLooselyMatch(afClub, a.m.club_name) ? 1 : 0;
    const cb = b.m.club_name && clubsLooselyMatch(afClub, b.m.club_name) ? 1 : 0;
    if (cb !== ca) return cb - ca;
    return b.score - a.score;
  });
  return scored[0]!.m;
}

export function buildPlayerBoard(
  season = config.predictSeason,
  leagueId = 106,
  options?: { serveStale?: boolean },
): BoardPlayer[] {
  return getComputed(
    xiBoardCacheKey(season, leagueId),
    xiCacheVersion(season, leagueId),
    () => computePlayerBoard(season, leagueId),
    { serveStale: options?.serveStale },
  ).value;
}

function computePlayerBoard(season: number, leagueId: number): BoardPlayer[] {
  const historySeason = config.season;
  const db = getDb();
  const mantraTournamentId = leagueById(leagueId)?.mantraTournamentId ?? null;
  const useMantra = mantraTournamentId != null;

  const rows = db
    .prepare(
      `SELECT
         sp.player_id AS playerId,
         sp.name,
         sp.team_id AS teamId,
         st.name AS teamName,
         sp.position AS afPosition,
         pv.detail_role AS detailRole,
         pv.detail_label AS detailLabel,
         pv.side_role AS sideRole,
         pv.market_value_eur AS marketValueEur,
         COALESCE(ps.minutes, 0) AS minutes
       FROM squad_players sp
       JOIN season_teams st ON st.season = sp.season AND st.team_id = sp.team_id
       LEFT JOIN player_stats ps
         ON ps.player_id = sp.player_id AND ps.season = ? AND ps.team_id = sp.team_id
       LEFT JOIN player_values pv ON pv.af_player_id = sp.player_id AND pv.team_id = sp.team_id
       WHERE sp.season = ?
         AND (st.league_id = ? OR (st.league_id IS NULL AND ? = 106))`,
    )
    .all(historySeason, season, leagueId, leagueId) as SquadRow[];

  const mantra = useMantra
    ? (db
        .prepare(
          `SELECT id, full_name, name, first_name, club_name, positions_json, positions_ital_json,
                  tm_url, tm_price, base_score, total_score, appearances, age, height, nationality,
                  leagues_json, teams_count
           FROM mantra_players
           WHERE tournament_id = ? OR (tournament_id IS NULL AND ? = 18)`,
        )
        .all(mantraTournamentId, mantraTournamentId) as MantraRow[])
    : [];

  const predictions = allSeasonPredictions(season, leagueId);
  const expected11Predictions = expected11XiPredictionsForAfPlayers(
    leagueId,
    rows.map((row) => row.playerId),
  );
  const serieALineupPredictions = serieALineupForAfPlayers(
    leagueId,
    rows.map((row) => row.playerId),
  );
  const xiMap = new Map<number, { status: XiStatus; slot: string; teamId: number }>();
  for (const pred of predictions) {
    for (const slot of pred.xi) {
      const starterId = slot.starter.playerId;
      if (!xiMap.has(starterId) || xiMap.get(starterId)!.status !== "starter") {
        xiMap.set(starterId, { status: "starter", slot: slot.label, teamId: pred.teamId });
      }
      if (slot.backup) {
        const bid = slot.backup.playerId;
        if (!xiMap.has(bid)) {
          xiMap.set(bid, { status: "backup", slot: slot.label, teamId: pred.teamId });
        }
      }
    }
  }

  const ratingById = leaguePlayerRatings(season, leagueId);
  const newTransfers = loadAfNewTransferMap();
  const liveDraftAwards = loadLiveDraftAwards(db);

  const board: BoardPlayer[] = rows.map((r) => {
    const role =
      parseDetailRole(r.detailRole, r.detailLabel, null) ??
      parseDetailRole(r.afPosition, r.afPosition, r.afPosition);
    const rating = ratingById.get(r.playerId) ?? 0;
    const xi = xiMap.get(r.playerId);
    const transfer = newTransfers.get(r.playerId);
    const m = useMantra ? matchMantra(r.name, r.teamName, mantra) : null;
    let mantraPayload: BoardPlayer["mantra"] = null;
    if (m) {
      let positions: string[] = [];
      let positionsItal: string[] = [];
      let takenLeagueIds: number[] = [];
      try {
        positions = JSON.parse(m.positions_json || "[]");
        positionsItal = JSON.parse(m.positions_ital_json || "[]");
      } catch {
        /* ignore */
      }
      try {
        takenLeagueIds = (JSON.parse(m.leagues_json || "[]") as unknown[])
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n));
      } catch {
        /* ignore */
      }
      const liveAward = liveDraftAwards.get(m.id);
      takenLeagueIds = applyLiveDraftTaken(takenLeagueIds, liveAward);
      mantraPayload = {
        id: m.id,
        positions,
        positionsItal,
        clubName: m.club_name,
        tmUrl: m.tm_url,
        tmPrice: m.tm_price,
        baseScore: m.base_score,
        totalScore: m.total_score,
        appearances: m.appearances,
        age: m.age,
        height: m.height,
        nationality: m.nationality,
        takenLeagueIds,
        teamsCount: m.teams_count ?? 0,
        ownedBy: liveAward?.teamName ?? null,
      };
    }

    return {
      playerId: r.playerId,
      name: r.name,
      teamId: r.teamId,
      teamName: r.teamName,
      role: role,
      roleLabel: r.detailLabel ?? r.detailRole ?? role,
      sideRole: r.sideRole || null,
      group: role ? roleGroup(role) : null,
      rating,
      marketValueEur: r.marketValueEur,
      minutes: r.minutes,
      xiStatus: xi?.status ?? "squad",
      xiSlot: xi?.slot ?? null,
      xiTeamId: xi?.teamId ?? null,
      isNew: transfer?.isNew ?? false,
      joinedAt: transfer?.joinedAt ?? null,
      expected11: expected11Predictions.get(r.playerId) ?? null,
      serieALineup: serieALineupPredictions.get(r.playerId) ?? null,
      mantra: mantraPayload,
    };
  });

  board.sort((a, b) => b.rating - a.rating);
  return board;
}

export function listMantraLeagues(tournamentId?: number | null): MantraLeagueOption[] {
  let rows =
    tournamentId != null
      ? (getDb()
          .prepare(
            `SELECT id, name, division FROM mantra_leagues
             WHERE (status = 'active' OR status IS NULL)
               AND (tournament_id = ? OR (tournament_id IS NULL AND ? = 18))
             ORDER BY division, name`,
          )
          .all(tournamentId, tournamentId) as Array<{
          id: number;
          name: string;
          division: string | null;
        }>)
      : (getDb()
          .prepare(
            `SELECT id, name, division FROM mantra_leagues
             WHERE status = 'active' OR status IS NULL
             ORDER BY division, name`,
          )
          .all() as Array<{ id: number; name: string; division: string | null }>);
  if (!rows.length && tournamentId != null) {
    const catalog = catalogDivisionsForTournament(tournamentId);
    const fallback = catalog.length ? catalog : catalogMantraLeagues(tournamentId);
    rows = fallback.map((r) => ({
      id: r.id,
      name: r.name,
      division: r.division,
    }));
  }
  return rows.map((r) => {
    const division = r.division ?? "";
    const label = [r.name, division].filter(Boolean).join(" ");
    return { id: r.id, name: r.name, division, label };
  });
}
