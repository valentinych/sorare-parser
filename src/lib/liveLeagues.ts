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

export const DEFAULT_LIVE_SLUG = "ekstraklasa";

export function allLiveLeagues(): LiveLeagueDef[] {
  return Object.values(LIVE_LEAGUES);
}

export function liveLeagueBySlug(slug: string | null | undefined): LiveLeagueDef | null {
  if (!slug) return null;
  const key = String(slug).trim().toLowerCase();
  if (LIVE_LEAGUES[key]) return LIVE_LEAGUES[key]!;
  // Accept TM codes / display-name slugs via AF registry.
  const af = leagueBySlug(key);
  if (af && LIVE_LEAGUES[af.slug]) return LIVE_LEAGUES[af.slug]!;
  const byTm = Object.values(LIVE_LEAGUES).find(
    (l) => l.tmCompetition.toLowerCase() === key || l.tmCompetition === slug,
  );
  return byTm ?? null;
}

export function resolveLiveLeague(param?: string | null): LiveLeagueDef {
  return liveLeagueBySlug(param) ?? LIVE_LEAGUES[DEFAULT_LIVE_SLUG]!;
}

export function liveLeagueByFotmobId(fotmobId: number): LiveLeagueDef | null {
  return Object.values(LIVE_LEAGUES).find((l) => l.fotmobLeagueId === fotmobId) ?? null;
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
