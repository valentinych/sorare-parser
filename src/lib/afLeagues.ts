/** API Football leagues used by this project. */
export type AfLeagueDef = {
  id: number;
  slug: string;
  name: string;
  /** Transfermarkt competition code (e.g. GB1, L1). */
  tmCompetition: string;
  /** MantraFootball tournament id (country / division catalog). */
  mantraTournamentId: number | null;
  /** Official Sorare GraphQL competition slug, when covered. */
  sorareCompetitionSlug?: string;
};

/**
 * Domestic top leagues (+ Championship) wired into TM Desk / predicted XI.
 * AF season = starting year (2025 = 2025/26, 2026 = 2026/27).
 */
export const AF_LEAGUES: Record<number, AfLeagueDef> = {
  106: {
    id: 106,
    slug: "ekstraklasa",
    name: "Ekstraklasa",
    tmCompetition: "PL1",
    mantraTournamentId: 18,
  },
  39: {
    id: 39,
    slug: "premier-league",
    name: "Premier League",
    tmCompetition: "GB1",
    mantraTournamentId: 2,
    sorareCompetitionSlug: "premier-league-gb-eng",
  },
  40: {
    id: 40,
    slug: "championship",
    name: "Championship",
    tmCompetition: "GB2",
    mantraTournamentId: 11,
    sorareCompetitionSlug: "football-league-championship",
  },
  41: {
    id: 41,
    slug: "league-one",
    name: "League One",
    tmCompetition: "GB3",
    mantraTournamentId: 26,
  },
  78: {
    id: 78,
    slug: "bundesliga",
    name: "Bundesliga",
    tmCompetition: "L1",
    mantraTournamentId: 3,
  },
  135: {
    id: 135,
    slug: "serie-a",
    name: "Serie A",
    tmCompetition: "IT1",
    mantraTournamentId: 1,
  },
  140: {
    id: 140,
    slug: "la-liga",
    name: "La Liga",
    tmCompetition: "ES1",
    mantraTournamentId: 5,
  },
  61: {
    id: 61,
    slug: "ligue-1",
    name: "Ligue 1",
    tmCompetition: "FR1",
    mantraTournamentId: 4,
  },
  203: {
    id: 203,
    slug: "super-lig",
    name: "Süper Lig",
    tmCompetition: "TR1",
    mantraTournamentId: 21,
    sorareCompetitionSlug: "spor-toto-super-lig",
  },
  88: {
    id: 88,
    slug: "eredivisie",
    name: "Eredivisie",
    tmCompetition: "NL1",
    mantraTournamentId: 12,
  },
  94: {
    id: 94,
    slug: "primeira-liga",
    name: "Primeira Liga",
    tmCompetition: "PO1",
    mantraTournamentId: 14,
  },
  144: {
    id: 144,
    slug: "jupiler-pro-league",
    name: "Jupiler Pro League",
    tmCompetition: "BE1",
    mantraTournamentId: 13,
  },
  333: {
    id: 333,
    slug: "upl",
    name: "UPL",
    tmCompetition: "UKR1",
    mantraTournamentId: 15,
  },
  253: {
    id: 253,
    slug: "mls",
    name: "MLS",
    tmCompetition: "MLS1",
    mantraTournamentId: 16,
  },
  71: {
    id: 71,
    slug: "brasileirao",
    name: "Brasileirão",
    tmCompetition: "BRA1",
    mantraTournamentId: 19,
  },
};

/** Leagues added in the multi-league expansion (exclude original PL1/GB1 if needed). */
export const NEW_LEAGUE_IDS = [40, 78, 135, 140, 61, 203, 88, 94, 144] as const;

/**
 * Championships shown in header / league dropdowns.
 * Hidden AF_LEAGUES stay synced and keep working via ?league= / direct routes.
 */
export const UI_LEAGUE_SLUGS = [
  "ekstraklasa",
  "serie-a",
  "bundesliga",
  "premier-league",
  "championship",
  "super-lig",
] as const;

export type UiLeagueSlug = (typeof UI_LEAGUE_SLUGS)[number];

/** Extra championships on Premium only (not header UI, not Live poller). */
export const PREMIUM_EXTRA_SLUGS = ["league-one"] as const;

export type PremiumLeagueSlug = UiLeagueSlug | (typeof PREMIUM_EXTRA_SLUGS)[number];

export function allLeagueIds(): number[] {
  return Object.keys(AF_LEAGUES).map(Number);
}

export function leagueBySlug(slug: string): AfLeagueDef | null {
  const hit = Object.values(AF_LEAGUES).find((l) => l.slug === slug);
  return hit ?? null;
}

export function isUiLeagueSlug(slug: string): boolean {
  return (UI_LEAGUE_SLUGS as readonly string[]).includes(slug);
}

export function isPremiumLeagueSlug(slug: string): boolean {
  return (
    isUiLeagueSlug(slug) || (PREMIUM_EXTRA_SLUGS as readonly string[]).includes(slug)
  );
}

export function uiLeagues(): AfLeagueDef[] {
  return UI_LEAGUE_SLUGS.map((slug) => leagueBySlug(slug)).filter(
    (league): league is AfLeagueDef => league != null,
  );
}

export function premiumLeagues(): AfLeagueDef[] {
  return [
    ...uiLeagues(),
    ...PREMIUM_EXTRA_SLUGS.map((slug) => leagueBySlug(slug)).filter(
      (league): league is AfLeagueDef => league != null,
    ),
  ];
}

export function premiumMantraTournaments(): number[] {
  return uniqueMantraTournaments(premiumLeagues().map((league) => league.id));
}

export function isUiTmCompetition(code: string): boolean {
  const league = leagueByTmCompetition(code);
  return league != null && isUiLeagueSlug(league.slug);
}

export function leagueById(id: number): AfLeagueDef | null {
  return AF_LEAGUES[id] ?? null;
}

export function leagueByTmCompetition(code: string): AfLeagueDef | null {
  const key = code.trim();
  if (!key) return null;
  return (
    Object.values(AF_LEAGUES).find(
      (league) => league.tmCompetition.toLowerCase() === key.toLowerCase(),
    ) ?? null
  );
}

export function uniqueTmCompetitions(ids?: number[]): string[] {
  const list = ids?.length ? ids.map((id) => AF_LEAGUES[id]).filter(Boolean) : Object.values(AF_LEAGUES);
  return [...new Set(list.map((l) => l!.tmCompetition))];
}

export function uniqueMantraTournaments(ids?: number[]): number[] {
  const list = ids?.length ? ids.map((id) => AF_LEAGUES[id]).filter(Boolean) : Object.values(AF_LEAGUES);
  return [
    ...new Set(
      list.map((l) => l!.mantraTournamentId).filter((x): x is number => x != null && Number.isFinite(x)),
    ),
  ];
}

/** Full AF catalog for URL resolution of hidden championships. */
export function leagueResolveCatalog(): Array<{ id: string; slug: string; name: string }> {
  return Object.values(AF_LEAGUES).map((league) => ({
    id: league.tmCompetition,
    slug: league.slug,
    name: league.name,
  }));
}
