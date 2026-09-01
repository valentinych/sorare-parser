/** Fallback Mantra fantasy-league names when `mantra_leagues` has no rows. */

export type CatalogMantraLeague = {
  id: number;
  name: string;
  division: string;
};

/**
 * Season 26-27 active Bundesliga Mantra leagues (tournament_id = 3).
 * Players were synced; league rows were never inserted.
 */
export const BUNDESLIGA_MANTRA_LEAGUES: CatalogMantraLeague[] = [
  { id: 770, name: "Berlin", division: "A1" },
  { id: 771, name: "Hamburg", division: "A2" },
  { id: 772, name: "Munich", division: "B1" },
  { id: 773, name: "Cologne", division: "B2" },
  { id: 774, name: "Frankfurt", division: "B3" },
  { id: 775, name: "Stuttgart", division: "B4" },
  { id: 776, name: "Düsseldorf", division: "C1" },
  { id: 777, name: "Dortmund", division: "C2" },
  { id: 778, name: "Essen", division: "C3" },
  { id: 779, name: "Bremen", division: "C4" },
  { id: 780, name: "Dresden", division: "C5" },
  { id: 781, name: "Leipzig", division: "C6" },
  { id: 782, name: "Hanover", division: "D1" },
  { id: 783, name: "Nuremberg", division: "D2" },
  { id: 784, name: "Duisburg", division: "D3" },
];

const BY_TOURNAMENT: Record<number, CatalogMantraLeague[]> = {
  3: BUNDESLIGA_MANTRA_LEAGUES,
};

export function catalogMantraLeagues(
  tournamentId: number | null | undefined,
): CatalogMantraLeague[] {
  if (tournamentId == null || !Number.isFinite(tournamentId)) return [];
  return BY_TOURNAMENT[tournamentId] ?? [];
}
