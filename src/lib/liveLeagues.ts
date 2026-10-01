/**
 * Leagues with Live dashboards (FotMob fixtures + Mantra fantasy tours).
 * AF/TM/Mantra catalog ids live in afLeagues.ts; this adds FotMob + division wiring.
 */
import { AF_LEAGUES, leagueBySlug, type AfLeagueDef } from "./afLeagues.js";
import { BUNDESLIGA_MANTRA_LEAGUES } from "./mantraLeagueCatalog.js";

export type MantraDivisionDef = {
  leagueId: number;
  division: string;
  name: string;
  /** Fallback tour id only — prefer resolveLeagueTourId(leagueId). */
  tourId?: number;
};

export type LiveLeagueDef = AfLeagueDef & {
  fotmobLeagueId: number;
  mantraDivisions: MantraDivisionDef[];
};

/** Season 26-27 Mantra fantasy divisions (tour ids are fallbacks). */
const EKSTRAKLASA_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 583, division: "A1", name: "Warsaw", tourId: 17749 },
  { leagueId: 584, division: "B1", name: "Krakow", tourId: 17783 },
  { leagueId: 585, division: "B2", name: "Lodz", tourId: 17817 },
  { leagueId: 586, division: "C1", name: "Wrocław", tourId: 17851 },
];

const CHAMPIONSHIP_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 651, division: "A1", name: "Cardiff", tourId: 19850 },
  { leagueId: 652, division: "A2", name: "Swansea", tourId: 19896 },
  { leagueId: 653, division: "B1", name: "Newport", tourId: 19942 },
  { leagueId: 654, division: "B2", name: "Wrexham", tourId: 19988 },
  { leagueId: 655, division: "B3", name: "Bangor", tourId: 20034 },
  { leagueId: 656, division: "B4", name: "Belfast", tourId: 20080 },
  { leagueId: 657, division: "C1", name: "Derry", tourId: 20126 },
];

/** Season 26-27 England 3 Div (tournament 26). A1/B1 not published yet. */
const LEAGUE_ONE_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 795, division: "C1", name: "Winchester" },
  { leagueId: 796, division: "C2", name: "Salisbury" },
  { leagueId: 797, division: "C3", name: "Carlisle" },
  { leagueId: 798, division: "C4", name: "Hereford" },
  { leagueId: 799, division: "C5", name: "Chichester" },
];

/** Season 26-27 Serie A fantasy divisions (tournament_id = 1). */
const SERIE_A_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 742, division: "A1", name: "Rome" },
  { leagueId: 743, division: "A2", name: "Milan" },
  { leagueId: 744, division: "B1", name: "Naples" },
  { leagueId: 745, division: "B2", name: "Turin" },
  { leagueId: 746, division: "B3", name: "Palermo" },
  { leagueId: 747, division: "B4", name: "Genoa" },
  { leagueId: 748, division: "C1", name: "Bologna" },
  { leagueId: 749, division: "C2", name: "Florence" },
  { leagueId: 750, division: "C3", name: "Bari" },
  { leagueId: 751, division: "C4", name: "Catania" },
  { leagueId: 752, division: "C5", name: "Verona" },
  { leagueId: 753, division: "C6", name: "Messina" },
  { leagueId: 754, division: "D1", name: "Modena" },
  { leagueId: 755, division: "D2", name: "Padua" },
  { leagueId: 756, division: "D3", name: "Brescia" },
  { leagueId: 757, division: "D4", name: "Parma" },
  { leagueId: 758, division: "D5", name: "Trieste" },
  { leagueId: 759, division: "D6", name: "Prato" },
  { leagueId: 760, division: "D7", name: "Taranto" },
  { leagueId: 761, division: "D8", name: "Reggio Emilia" },
  { leagueId: 762, division: "D9", name: "Reggio Calabria" },
  { leagueId: 763, division: "E1", name: "Ravenna" },
  { leagueId: 764, division: "E2", name: "Rimini" },
  { leagueId: 765, division: "", name: "Venice" },
];

const BUNDESLIGA_DIVISIONS: MantraDivisionDef[] = BUNDESLIGA_MANTRA_LEAGUES.map((l) => ({
  leagueId: l.id,
  division: l.division,
  name: l.name,
}));

const SUPER_LIG_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 658, division: "A1", name: "Istanbul", tourId: 20172 },
  { leagueId: 659, division: "B1", name: "Ankara", tourId: 20206 },
  { leagueId: 660, division: "B2", name: "Izmir", tourId: 20240 },
  { leagueId: 661, division: "C1", name: "Bursa", tourId: 20274 },
  { leagueId: 662, division: "C2", name: "Antalya", tourId: 20308 },
  { leagueId: 663, division: "C3", name: "Adana", tourId: 20342 },
];

/** Season 26-27 Premier League fantasy divisions. tourId filled when known; Round nav is source of truth. */
const PREMIER_LEAGUE_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 684, division: "A1", name: "London", tourId: 21123 },
  { leagueId: 685, division: "A2", name: "Birmingham" },
  { leagueId: 686, division: "A3", name: "Manchester" },
  { leagueId: 687, division: "B1", name: "Liverpool", tourId: 21237 },
  { leagueId: 688, division: "B2", name: "Sheffield" },
  { leagueId: 689, division: "B3", name: "Bristol" },
  { leagueId: 690, division: "B4", name: "Leicester" },
  { leagueId: 691, division: "B5", name: "Leeds" },
  { leagueId: 692, division: "B6", name: "Stoke" },
  { leagueId: 693, division: "C1", name: "Coventry" },
  { leagueId: 694, division: "C2", name: "Sunderland" },
  { leagueId: 695, division: "C3", name: "Nottingham" },
  { leagueId: 696, division: "C4", name: "Hull" },
  { leagueId: 697, division: "C5", name: "Preston" },
  { leagueId: 698, division: "C6", name: "Bradford" },
  { leagueId: 699, division: "C7", name: "Southend" },
  { leagueId: 700, division: "C8", name: "Derby" },
  { leagueId: 701, division: "C9", name: "Plymouth" },
  { leagueId: 703, division: "D1", name: "Wolverhampton" },
  { leagueId: 704, division: "D2", name: "Southampton" },
  { leagueId: 705, division: "D3", name: "Milton Keynes" },
  { leagueId: 706, division: "D4", name: "Norwich" },
  { leagueId: 707, division: "D5", name: "Portsmouth" },
  { leagueId: 708, division: "D6", name: "Newcastle" },
  { leagueId: 709, division: "D7", name: "Oxford" },
  { leagueId: 710, division: "D8", name: "Peterborough" },
  { leagueId: 711, division: "D9", name: "Cambridge" },
  { leagueId: 712, division: "E1", name: "Doncaster" },
  { leagueId: 713, division: "E2", name: "York" },
  { leagueId: 714, division: "E3", name: "Gloucester" },
  { leagueId: 715, division: "E4", name: "Colchester" },
  { leagueId: 716, division: "E5", name: "Exeter" },
  { leagueId: 717, division: "E6", name: "Lincoln" },
  { leagueId: 718, division: "E7", name: "Chelmsford" },
  { leagueId: 719, division: "E8", name: "Worcester" },
  { leagueId: 720, division: "E9", name: "Blackpool" },
  { leagueId: 721, division: "F1", name: "Rochdale" },
  { leagueId: 722, division: "F2", name: "Middlesbrough" },
  { leagueId: 723, division: "F3", name: "Salford" },
  { leagueId: 724, division: "", name: "Brighton" },
  { leagueId: 725, division: "", name: "Telford" },
  { leagueId: 726, division: "", name: "Crawley" },
  { leagueId: 727, division: "", name: "Barnsley" },
  { leagueId: 728, division: "", name: "Wigan" },
  { leagueId: 729, division: "", name: "Luton" },
  { leagueId: 730, division: "", name: "Bath" },
  { leagueId: 731, division: "F4", name: "Stockport" },
  { leagueId: 741, division: "F5", name: "Swindon", tourId: 23253 },
  { leagueId: 786, division: "", name: "Bournemouth", tourId: 24903 },
];

const LIGUE_1_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 732, division: "A1", name: "Paris" },
  { leagueId: 733, division: "A2", name: "Marseille" },
  { leagueId: 734, division: "B1", name: "Lyon" },
  { leagueId: 735, division: "B2", name: "Toulouse" },
  { leagueId: 736, division: "B3", name: "Nice" },
  { leagueId: 737, division: "B4", name: "Nantes" },
  { leagueId: 738, division: "C1", name: "Strasbourg" },
  { leagueId: 739, division: "C2", name: "Montpellier" },
  { leagueId: 740, division: "C3", name: "Bordeaux" },
];

const LA_LIGA_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 664, division: "A1", name: "Madrid" },
  { leagueId: 665, division: "A2", name: "Barcelona" },
  { leagueId: 666, division: "B1", name: "Valencia" },
  { leagueId: 667, division: "B2", name: "Sevilla" },
  { leagueId: 668, division: "B3", name: "Zaragoza" },
  { leagueId: 669, division: "B4", name: "Málaga" },
  { leagueId: 670, division: "C1", name: "Murcia" },
  { leagueId: 671, division: "C2", name: "Mallorca" },
  { leagueId: 672, division: "C3", name: "Las Palmas" },
  { leagueId: 673, division: "C4", name: "Bilbao" },
  { leagueId: 674, division: "C5", name: "Alicante" },
  { leagueId: 675, division: "C6", name: "Cordoba" },
  { leagueId: 678, division: "D1", name: "Valladolid" },
  { leagueId: 679, division: "D2", name: "Vigo" },
  { leagueId: 680, division: "D3", name: "Gijon" },
  { leagueId: 681, division: "D4", name: "Hospitalet" },
  { leagueId: 682, division: "D5", name: "Granada" },
  { leagueId: 683, division: "D6", name: "Elche" },
  { leagueId: 791, division: "D7", name: "San Sebastián" },
  { leagueId: 702, division: "", name: "La Coruña" },
];

const EREDIVISIE_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 634, division: "A1", name: "Amsterdam" },
  { leagueId: 635, division: "B1", name: "Rotterdam" },
  { leagueId: 636, division: "B2", name: "Den Haag" },
  { leagueId: 637, division: "C1", name: "Eindhoven" },
  { leagueId: 638, division: "C2", name: "Utrecht" },
];

const JUPILER_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 641, division: "A1", name: "Brussels" },
  { leagueId: 642, division: "B1", name: "Antwerp" },
  { leagueId: 643, division: "B2", name: "Ghent" },
  { leagueId: 650, division: "C1", name: "Charleroi" },
];

const PRIMEIRA_LIGA_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 645, division: "A1", name: "Lisbon" },
  { leagueId: 647, division: "B1", name: "Porto" },
  { leagueId: 648, division: "B2", name: "Braga" },
  { leagueId: 649, division: "C1", name: "Amadora" },
];

const UPL_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 587, division: "A1", name: "Kyiv" },
  { leagueId: 588, division: "A2", name: "Kharkiv" },
  { leagueId: 589, division: "B1", name: "Odesa" },
  { leagueId: 590, division: "B2", name: "Dnipro" },
  { leagueId: 591, division: "B3", name: "Donetsk" },
  { leagueId: 592, division: "B4", name: "Lviv" },
  { leagueId: 593, division: "C1", name: "Zaporizhzhia" },
  { leagueId: 594, division: "C2", name: "Kryvyi Rih" },
  { leagueId: 595, division: "C3", name: "Sevastopol" },
  { leagueId: 596, division: "C4", name: "Mykolaiv" },
  { leagueId: 597, division: "C5", name: "Mariupol" },
  { leagueId: 598, division: "C6", name: "Luhansk" },
  { leagueId: 599, division: "D1", name: "Vinnytsia" },
  { leagueId: 600, division: "D2", name: "Simferopol" },
  { leagueId: 601, division: "D3", name: "Chernihiv" },
  { leagueId: 602, division: "D4", name: "Poltava" },
  { leagueId: 603, division: "D5", name: "Kherson" },
  { leagueId: 604, division: "D6", name: "Khmelnytskyi" },
  { leagueId: 605, division: "D7", name: "Cherkasy" },
  { leagueId: 606, division: "D8", name: "Zhytomyr" },
  { leagueId: 630, division: "D9", name: "Sumy" },
  { leagueId: 640, division: "E1", name: "Kropyvnytskyi" },
  { leagueId: 607, division: "", name: "Mala Tokmachka" },
  { leagueId: 608, division: "", name: "TTT A1" },
  { leagueId: 609, division: "", name: "TTT A2" },
  { leagueId: 610, division: "", name: "TTT B1" },
  { leagueId: 611, division: "", name: "TTT B2" },
  { leagueId: 612, division: "", name: "TTT B3" },
  { leagueId: 613, division: "", name: "TTT B4" },
  { leagueId: 614, division: "", name: "TTT C1" },
  { leagueId: 615, division: "", name: "TTT C2" },
  { leagueId: 616, division: "", name: "TTT C3" },
  { leagueId: 617, division: "", name: "TTT C4" },
  { leagueId: 618, division: "", name: "TTT C5" },
  { leagueId: 619, division: "", name: "TTT C6" },
  { leagueId: 620, division: "", name: "TTT D1" },
  { leagueId: 621, division: "", name: "TTT D2" },
  { leagueId: 622, division: "", name: "Zolochiv" },
  { leagueId: 623, division: "", name: "Rivne" },
  { leagueId: 624, division: "", name: "Chernivtsi" },
  { leagueId: 625, division: "", name: "Ivano-Frankivsk" },
  { leagueId: 626, division: "", name: "Lutsk" },
  { leagueId: 627, division: "", name: "Ternopil" },
  { leagueId: 628, division: "", name: "Trostyanets" },
  { leagueId: 629, division: "", name: "Sobolivka" },
  { leagueId: 631, division: "", name: "Kamyanske" },
  { leagueId: 632, division: "", name: "TTT D3" },
  { leagueId: 633, division: "", name: "Zalishchyky" },
  { leagueId: 639, division: "", name: "Reni" },
  { leagueId: 644, division: "", name: "Melitopol" },
  { leagueId: 646, division: "", name: "TTT D4" },
  { leagueId: 676, division: "", name: "Kerch" },
];

const MLS_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 551, division: "A1", name: "New York" },
  { leagueId: 552, division: "A2", name: "Los Angeles" },
  { leagueId: 553, division: "B1", name: "Chicago" },
  { leagueId: 554, division: "B2", name: "Houston" },
  { leagueId: 555, division: "B3", name: "Phoenix" },
  { leagueId: 556, division: "B4", name: "Philadelphia" },
  { leagueId: 557, division: "C1", name: "San Antonio" },
  { leagueId: 558, division: "C2", name: "San Diego" },
  { leagueId: 559, division: "", name: "Jacksonville" },
];

const BRASILEIRAO_DIVISIONS: MantraDivisionDef[] = [
  { leagueId: 545, division: "A1", name: "São Paulo" },
  { leagueId: 546, division: "B1", name: "Rio de Janeiro" },
  { leagueId: 547, division: "B2", name: "Brasília" },
  { leagueId: 548, division: "C1", name: "Fortaleza" },
  { leagueId: 549, division: "C2", name: "Salvador" },
];

function withLive(
  afId: number,
  fotmobLeagueId: number,
  mantraDivisions: MantraDivisionDef[],
): LiveLeagueDef {
  const af = AF_LEAGUES[afId];
  if (!af) throw new Error(`AF league ${afId} missing from AF_LEAGUES`);
  if (af.mantraTournamentId == null) {
    throw new Error(`AF league ${afId} has no Mantra tournament`);
  }
  return { ...af, fotmobLeagueId, mantraDivisions };
}

/** Live-enabled leagues keyed by AF slug. */
export const LIVE_LEAGUES: Record<string, LiveLeagueDef> = {
  ekstraklasa: withLive(106, 196, EKSTRAKLASA_DIVISIONS),
  "serie-a": withLive(135, 55, SERIE_A_DIVISIONS),
  bundesliga: withLive(78, 54, BUNDESLIGA_DIVISIONS),
  "premier-league": withLive(39, 47, PREMIER_LEAGUE_DIVISIONS),
  championship: withLive(40, 48, CHAMPIONSHIP_DIVISIONS),
  "super-lig": withLive(203, 71, SUPER_LIG_DIVISIONS),
};

/**
 * Extra Mantra championships on /tables only.
 * Keep them off Live poller / tours --all so existing 6 leagues stay untouched.
 */
export const TABLES_EXTRA_LEAGUES: Record<string, LiveLeagueDef> = {
  "ligue-1": withLive(61, 53, LIGUE_1_DIVISIONS),
  "la-liga": withLive(140, 87, LA_LIGA_DIVISIONS),
  eredivisie: withLive(88, 57, EREDIVISIE_DIVISIONS),
  "jupiler-pro-league": withLive(144, 40, JUPILER_DIVISIONS),
  "primeira-liga": withLive(94, 61, PRIMEIRA_LIGA_DIVISIONS),
  upl: withLive(333, 441, UPL_DIVISIONS),
  mls: withLive(253, 130, MLS_DIVISIONS),
  brasileirao: withLive(71, 268, BRASILEIRAO_DIVISIONS),
};

export const TABLES_EXTRA_SLUGS = [
  "ligue-1",
  "la-liga",
  "eredivisie",
  "jupiler-pro-league",
  "primeira-liga",
  "upl",
  "mls",
  "brasileirao",
] as const;

/**
 * Extra championships on Premium (unpicked tops / squad tools).
 * Keep them off Live poller and /tables so existing dashboards stay untouched.
 */
export const PREMIUM_EXTRA_LEAGUES: Record<string, LiveLeagueDef> = {
  "league-one": withLive(41, 108, LEAGUE_ONE_DIVISIONS),
};

/** Country flag emoji for /tables manager league column (🇫🇷 C1). */
const LEAGUE_FLAG_EMOJI: Record<string, string> = {
  ekstraklasa: "🇵🇱",
  "serie-a": "🇮🇹",
  bundesliga: "🇩🇪",
  "premier-league": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  championship: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "league-one": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "super-lig": "🇹🇷",
  "ligue-1": "🇫🇷",
  "la-liga": "🇪🇸",
  eredivisie: "🇳🇱",
  "jupiler-pro-league": "🇧🇪",
  "primeira-liga": "🇵🇹",
  upl: "🇺🇦",
  mls: "🇺🇸",
  brasileirao: "🇧🇷",
};

export function leagueFlagEmoji(slug: string | null | undefined): string {
  const key = String(slug || "")
    .trim()
    .toLowerCase();
  return LEAGUE_FLAG_EMOJI[key] ?? "";
}

export const DEFAULT_LIVE_SLUG = "ekstraklasa";

export function allLiveLeagues(): LiveLeagueDef[] {
  return Object.values(LIVE_LEAGUES);
}

export function allTablesLeagues(): LiveLeagueDef[] {
  return [
    ...allLiveLeagues(),
    ...TABLES_EXTRA_SLUGS.map((slug) => TABLES_EXTRA_LEAGUES[slug]!),
  ];
}

export function allPremiumExtraLeagues(): LiveLeagueDef[] {
  return Object.values(PREMIUM_EXTRA_LEAGUES);
}

/** Live 6 + /tables extras + Premium-only England 3. Squad Builder catalog. */
export function allBuilderLeagues(): LiveLeagueDef[] {
  return [...allTablesLeagues(), ...allPremiumExtraLeagues()];
}

/** Live 6 + Premium-only extras (not /tables extras). */
export function allPremiumLeagues(): LiveLeagueDef[] {
  return [...allLiveLeagues(), ...allPremiumExtraLeagues()];
}

/** Division rows when `mantra_leagues` is empty — ids from LIVE/TABLES/PREMIUM catalogs only. */
export function catalogDivisionsForTournament(
  tournamentId: number | null | undefined,
): Array<{ id: number; name: string; division: string }> {
  if (tournamentId == null || !Number.isFinite(tournamentId)) return [];
  const league = allBuilderLeagues().find((item) => item.mantraTournamentId === tournamentId);
  return (league?.mantraDivisions ?? []).map((d) => ({
    id: d.leagueId,
    name: d.name,
    division: d.division,
  }));
}

export function isTablesExtraSlug(slug: string | null | undefined): boolean {
  const key = String(slug || "")
    .trim()
    .toLowerCase();
  return Boolean(key && TABLES_EXTRA_LEAGUES[key]);
}

export function liveLeagueBySlug(slug: string | null | undefined): LiveLeagueDef | null {
  if (!slug) return null;
  const key = String(slug).trim().toLowerCase();
  if (LIVE_LEAGUES[key]) return LIVE_LEAGUES[key]!;
  if (TABLES_EXTRA_LEAGUES[key]) return TABLES_EXTRA_LEAGUES[key]!;
  if (PREMIUM_EXTRA_LEAGUES[key]) return PREMIUM_EXTRA_LEAGUES[key]!;
  // Accept TM codes / display-name slugs via AF registry.
  const af = leagueBySlug(key);
  if (af && LIVE_LEAGUES[af.slug]) return LIVE_LEAGUES[af.slug]!;
  if (af && TABLES_EXTRA_LEAGUES[af.slug]) return TABLES_EXTRA_LEAGUES[af.slug]!;
  if (af && PREMIUM_EXTRA_LEAGUES[af.slug]) return PREMIUM_EXTRA_LEAGUES[af.slug]!;
  const byTm = allBuilderLeagues().find(
    (l) => l.tmCompetition.toLowerCase() === key || l.tmCompetition === slug,
  );
  return byTm ?? null;
}

export function resolveLiveLeague(param?: string | null): LiveLeagueDef {
  return liveLeagueBySlug(param) ?? LIVE_LEAGUES[DEFAULT_LIVE_SLUG]!;
}

export function liveLeagueByFotmobId(fotmobId: number): LiveLeagueDef | null {
  return (
    allBuilderLeagues().find((l) => l.fotmobLeagueId === fotmobId) ?? null
  );
}

/** Legacy Ekstraklasa meta keys stay unscoped so existing DB/files keep working. */
export function isDefaultLiveSlug(slug: string): boolean {
  return slug === DEFAULT_LIVE_SLUG;
}

export function liveRoundMetaKey(slug: string): string {
  return isDefaultLiveSlug(slug) ? "live_round" : `live_round:${slug}`;
}

export function liveSyncedMetaKey(slug: string): string {
  return isDefaultLiveSlug(slug) ? "live_synced_at" : `live_synced_at:${slug}`;
}

export function liveOngoingMetaKey(slug: string): string {
  return isDefaultLiveSlug(slug) ? "live_has_ongoing" : `live_has_ongoing:${slug}`;
}

export function mantraToursMetaKey(slug: string): string {
  return isDefaultLiveSlug(slug) ? "mantra_tours_json" : `mantra_tours_json:${slug}`;
}

export function mantraToursSyncedMetaKey(slug: string): string {
  return isDefaultLiveSlug(slug) ? "mantra_tours_synced_at" : `mantra_tours_synced_at:${slug}`;
}

/** File basename piece: "" for ekstraklasa, "-championship" otherwise. */
export function mantraFileSuffix(slug: string): string {
  return isDefaultLiveSlug(slug) ? "" : `-${slug}`;
}

/** True when at least one Mantra match on the tour has locked lineups. */
export function mantraToursAreLocked(
  tours: Array<{ matches: Array<{ locked?: boolean }> }>,
): boolean {
  return tours.some((t) => t.matches.some((m) => m.locked));
}

/** True when a tour has a future lineup deadline (unlocked set-lineup window). */
export function tourHasActiveDeadline(
  tour: {
    deadline?: string | null;
    deadlineLabel?: string | null;
    matches?: Array<{ locked?: boolean }>;
  },
  nowMs = Date.now(),
): boolean {
  if (tour.deadline) {
    const t = Date.parse(tour.deadline);
    if (Number.isFinite(t)) return t > nowMs;
  }
  return Boolean(tour.deadlineLabel?.trim()) && (tour.matches ?? []).some((m) => !m.locked);
}

export function mantraToursHaveActiveDeadline(
  tours: Array<{
    deadline?: string | null;
    deadlineLabel?: string | null;
    matches?: Array<{ locked?: boolean }>;
  }>,
  nowMs = Date.now(),
): boolean {
  return tours.some((t) => tourHasActiveDeadline(t, nowMs));
}

/**
 * Follow a locked Mantra match tour, or an unlocked tour with a lineup deadline,
 * when it is ahead of FotMob's hold-the-finished-round picker.
 * Do not use this for unlocked/auction pages with no deadline.
 */
export function preferMantraMatchRound(
  fotmobRound: string | null | undefined,
  mantraRound: number | null | undefined,
  mantraLocked: boolean,
  mantraHasDeadline = false,
): string | null {
  const fotmob = fotmobRound != null && String(fotmobRound).trim() !== "" ? String(fotmobRound) : null;
  if (
    (!mantraLocked && !mantraHasDeadline) ||
    mantraRound == null ||
    !Number.isFinite(mantraRound)
  ) {
    return fotmob;
  }
  if (!fotmob) return String(mantraRound);
  if (Number(mantraRound) > Number(fotmob)) return String(mantraRound);
  return fotmob;
}

/**
 * First FotMob match of the tour has started: live, finished, or kickoff already passed.
 * That — not a global Mantra "open tour" flag — is the signal to collect Real XI.
 */
export function tourHasFirstKickoff(
  matches: Array<{
    phase?: string | null;
    kickoff?: string | null;
    status_short?: string | null;
  }>,
  nowMs = Date.now(),
): boolean {
  return matches.some((m) => {
    const phase = String(m.phase ?? "");
    if (phase === "live" || phase === "finished") return true;
    if (phase === "cancelled") return false;
    const short = String(m.status_short ?? "").toUpperCase();
    if (short === "PP" || short === "CANC" || short === "PST") return false;
    const kick = m.kickoff ? Date.parse(m.kickoff) : NaN;
    return Number.isFinite(kick) && nowMs >= kick;
  });
}

/** Probe of tourId+1 is the next round for that division (ids increment by 1). */
export function shouldAutoOpenNextTour(
  currentRound: number | null | undefined,
  next: {
    round: number | null | undefined;
    locked: boolean;
    kickedOff?: boolean;
    hasDeadline?: boolean;
  } | null,
): boolean {
  if (!next || next.round == null || !Number.isFinite(next.round)) return false;
  if (!next.locked && !next.kickedOff && !next.hasDeadline) return false;
  if (currentRound == null) return true;
  return Number(next.round) > Number(currentRound);
}
