import { getDb } from "../db/index.js";

export type PositionGroup = "GK" | "DEF" | "MID" | "ATT";

export type TopPlayer = {
  playerId: number;
  name: string;
  teamId: number;
  teamName: string;
  position: string | null;
  appearances: number;
  lineups: number;
  minutes: number;
  goals: number;
  assists: number;
  rating: number | null;
  score: number;
};

function scoreFor(position: PositionGroup, row: {
  minutes: number;
  goals: number;
  assists: number;
  rating: number | null;
  lineups: number;
}): number {
  const rating = row.rating ?? 6.5;
  const minutesFactor = Math.min(row.minutes / 900, 3); // soft cap ~10 full matches
  switch (position) {
    case "GK":
      return rating * 10 + row.lineups * 0.5 + minutesFactor;
    case "DEF":
      return rating * 10 + row.lineups * 0.4 + minutesFactor + row.goals * 0.5;
    case "MID":
      return rating * 8 + (row.goals + row.assists) * 2 + minutesFactor + row.lineups * 0.3;
    case "ATT":
      return (row.goals * 4 + row.assists * 2) + rating * 5 + minutesFactor;
  }
}

export function topByPosition(opts: {
  position: PositionGroup;
  teamId?: number;
  limit?: number;
}): TopPlayer[] {
  const limit = opts.limit ?? 10;
  const db = getDb();

  const rows = opts.teamId
    ? (db
        .prepare(
          `SELECT s.player_id AS playerId, p.name, s.team_id AS teamId, t.name AS teamName,
                  s.position, s.appearances, s.lineups, s.minutes, s.goals, s.assists, s.rating
           FROM player_season_stats s
           JOIN players p ON p.id = s.player_id
           JOIN teams t ON t.id = s.team_id
           WHERE s.team_id = ? AND s.position = ?
           ORDER BY s.minutes DESC`,
        )
        .all(opts.teamId, opts.position) as Array<Omit<TopPlayer, "score">>)
    : (db
        .prepare(
          `SELECT s.player_id AS playerId, p.name, s.team_id AS teamId, t.name AS teamName,
                  s.position, s.appearances, s.lineups, s.minutes, s.goals, s.assists, s.rating
           FROM player_season_stats s
           JOIN players p ON p.id = s.player_id
           JOIN teams t ON t.id = s.team_id
           WHERE s.position = ?
           ORDER BY s.minutes DESC`,
        )
        .all(opts.position) as Array<Omit<TopPlayer, "score">>);

  return rows
    .map((r) => ({
      ...r,
      score: Number(
        scoreFor(opts.position, {
          minutes: r.minutes,
          goals: r.goals,
          assists: r.assists,
          rating: r.rating,
          lineups: r.lineups,
        }).toFixed(2),
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function topBoard(limitPerPos = 5): Record<PositionGroup, TopPlayer[]> {
  return {
    GK: topByPosition({ position: "GK", limit: limitPerPos }),
    DEF: topByPosition({ position: "DEF", limit: limitPerPos }),
    MID: topByPosition({ position: "MID", limit: limitPerPos }),
    ATT: topByPosition({ position: "ATT", limit: limitPerPos }),
  };
}
