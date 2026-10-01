/** FotMob public data API (www.fotmob.com/api/data/…). ≤40 req/s, own limiter. */
import { rateLimitFotmob } from "../lib/rateLimit.js";
import { withTimeout } from "../lib/withTimeout.js";

const BASE = "https://www.fotmob.com/api/data";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Ekstraklasa on FotMob. Prefer LIVE_LEAGUES[*].fotmobLeagueId for multi-league. */
export const FOTMOB_EK_LEAGUE_ID = 196;
/** Championship (England D2) on FotMob. */
export const FOTMOB_CHAMPIONSHIP_LEAGUE_ID = 48;
/** Süper Lig (Turkey D1) on FotMob. */
export const FOTMOB_SUPER_LIG_LEAGUE_ID = 71;
/** Premier League (England D1) on FotMob. */
export const FOTMOB_PREMIER_LEAGUE_ID = 47;
/** League One (England D3) on FotMob. */
export const FOTMOB_LEAGUE_ONE_ID = 108;

export type FotmobLeagueTeam = {
  id: number;
  name: string;
  shortName: string | null;
};

export type FotmobSquadPlayer = {
  id: number;
  name: string;
  teamId: number;
  teamName: string;
  shirtNumber: number | null;
  positionIdsDesc: string | null;
  roleKey: string | null;
  injured?: boolean;
  injuryName?: string | null;
  expectedReturn?: string | null;
};

export type FotmobSquadInjury = {
  playerId: number;
  name: string;
  injured: boolean;
  injuryName: string | null;
  expectedReturn: string | null;
};

/** Squad-page injury blob: `{ injured: true, injury: { id, expectedReturn } }`. */
export function parseFotmobSquadInjury(raw: unknown): FotmobSquadInjury | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Json;
  const playerId = Number(rec.id);
  if (!Number.isFinite(playerId) || playerId <= 0) return null;
  const injuryRaw = rec.injury;
  const injuryObj =
    injuryRaw && typeof injuryRaw === "object" ? (injuryRaw as Json) : null;
  const expectedReturn =
    injuryObj?.expectedReturn != null && String(injuryObj.expectedReturn).trim()
      ? String(injuryObj.expectedReturn).trim()
      : null;
  const nameRaw =
    injuryObj?.name ?? injuryObj?.reason ?? injuryObj?.label ?? injuryObj?.type;
  const injuryName =
    nameRaw != null && String(nameRaw).trim() ? String(nameRaw).trim() : null;
  const injuredFlag = rec.injured === true || rec.injured === 1;
  if (!injuredFlag && !expectedReturn && !injuryName) return null;
  return {
    playerId,
    name: String(rec.name ?? ""),
    injured: true,
    injuryName,
    expectedReturn,
  };
}

export type FotmobMatchStatus = {
  utcTime?: string;
  started?: boolean;
  finished?: boolean;
  cancelled?: boolean;
  scoreStr?: string;
  reason?: { short?: string; long?: string };
  liveTime?: { short?: string; long?: string; maxMinute?: number };
};

export type FotmobFixtureMatch = {
  id: number;
  round: string | number | null;
  roundName: string | null;
  pageUrl: string | null;
  home: { id: number; name: string; score: number | null };
  away: { id: number; name: string; score: number | null };
  status: FotmobMatchStatus;
};

export type FotmobMatchEvent = {
  time: number | null;
  overloadTime: number | null;
  type: string;
  isHome: boolean | null;
  playerName: string | null;
  playerId: number | null;
  card: string | null;
  homeScore: number | null;
  awayScore: number | null;
  assistName: string | null;
  playerOut: string | null;
  playerIn: string | null;
  playerOutId: number | null;
  playerInId: number | null;
  ownGoal: boolean;
  raw: unknown;
};

export type FotmobPlayerRating = {
  playerId: number;
  name: string;
  teamId: number;
  teamName: string;
  isHome: boolean;
  shirtNumber: string | null;
  positionId: number | null;
  rating: number | null;
  starter: boolean;
  minutes: number | null;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  ownGoals: number;
  saves: number;
  goalsConceded: number;
  penaltiesWon: number;
  penaltiesConceded: number;
  penaltiesScored: number;
  penaltiesMissed: number;
  penaltiesSaved: number;
};

export type FotmobMatchDetails = {
  matchId: number;
  leagueId: number | null;
  leagueName: string | null;
  round: string | null;
  kickoff: string | null;
  started: boolean;
  finished: boolean;
  scoreHome: number | null;
  scoreAway: number | null;
  statusShort: string | null;
  home: { id: number; name: string };
  away: { id: number; name: string };
  events: FotmobMatchEvent[];
  players: FotmobPlayerRating[];
  potm: { playerId: number; name: string; rating: number | null } | null;
};

type Json = Record<string, unknown>;

/** Test probe: GET /live must leave this at 0. */
export let fotmobHttpCalls = 0;

export function resetFotmobHttpCallsForTests(): void {
  fotmobHttpCalls = 0;
}

async function fotmobGet(
  path: string,
  params?: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<Json> {
  fotmobHttpCalls += 1;
  const url = new URL(BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }
  await rateLimitFotmob();
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const work = (async () => {
    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": UA,
        Referer: "https://www.fotmob.com/",
        Origin: "https://www.fotmob.com",
      },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`FotMob ${path} → ${res.status}`);
    return (await res.json()) as Json;
  })();
  try {
    return await withTimeout(work, 20_000, `FotMob ${path} timed out`);
  } finally {
    ac.abort();
    signal?.removeEventListener("abort", onAbort);
  }
}

/** FotMob list rows often leave home/away.score null and put the score in status.scoreStr. */
export function scoresFromFotmobStatus(
  status: FotmobMatchStatus | undefined,
  homeScore: number | null,
  awayScore: number | null,
): { home: number | null; away: number | null } {
  if (homeScore != null && awayScore != null) return { home: homeScore, away: awayScore };
  const raw = status?.scoreStr;
  if (!raw) return { home: homeScore, away: awayScore };
  const m = String(raw).match(/(\d+)\s*[-–—:]\s*(\d+)/);
  if (!m) return { home: homeScore, away: awayScore };
  return {
    home: homeScore ?? Number(m[1]),
    away: awayScore ?? Number(m[2]),
  };
}

function asTeam(raw: unknown): { id: number; name: string; score: number | null } {
  const t = (raw ?? {}) as Json;
  return {
    id: Number(t.id) || 0,
    name: String(t.name ?? ""),
    score: t.score != null && Number.isFinite(Number(t.score)) ? Number(t.score) : null,
  };
}

export function parseFotmobFixture(raw: Json): FotmobFixtureMatch | null {
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;
  const status = (raw.status ?? {}) as FotmobMatchStatus;
  const home = asTeam(raw.home);
  const away = asTeam(raw.away);
  const scores = scoresFromFotmobStatus(status, home.score, away.score);
  home.score = scores.home;
  away.score = scores.away;
  return {
    id,
    round: (raw.round as string | number | null) ?? null,
    roundName: raw.roundName != null ? String(raw.roundName) : null,
    pageUrl: raw.pageUrl != null ? String(raw.pageUrl) : null,
    home,
    away,
    status,
  };
}

export async function fetchLeagueFixtures(
  leagueId = FOTMOB_EK_LEAGUE_ID,
  signal?: AbortSignal,
): Promise<{
  hasOngoingMatch: boolean;
  matches: FotmobFixtureMatch[];
}> {
  const data = await fotmobGet("/leagues", { id: leagueId }, signal);
  const fixtures = (data.fixtures ?? {}) as Json;
  const list = Array.isArray(fixtures.allMatches) ? (fixtures.allMatches as Json[]) : [];
  return {
    hasOngoingMatch: Boolean(fixtures.hasOngoingMatch),
    matches: list.map(parseFotmobFixture).filter((m): m is FotmobFixtureMatch => m != null),
  };
}

/** League table clubs (overall standings). */
export async function fetchLeagueTableTeams(
  leagueId: number,
  signal?: AbortSignal,
): Promise<FotmobLeagueTeam[]> {
  const data = await fotmobGet("/leagues", { id: leagueId }, signal);
  const tableRoot = (data.table ?? {}) as Json;
  const first = (Object.values(tableRoot)[0] ?? null) as Json | null;
  const all = (((first?.data as Json | undefined)?.table as Json | undefined)?.all ??
    null) as unknown;
  if (!Array.isArray(all)) return [];
  const out: FotmobLeagueTeam[] = [];
  for (const row of all as Json[]) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    out.push({
      id,
      name: String(row.name ?? ""),
      shortName: row.shortName != null ? String(row.shortName) : null,
    });
  }
  return out;
}

function parseSquadMember(
  raw: Json,
  teamId: number,
  teamName: string,
): FotmobSquadPlayer | null {
  const id = Number(raw.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const role = (raw.role ?? {}) as Json;
  const roleKey = role.key != null ? String(role.key) : null;
  if (roleKey === "coach") return null;
  const shirt =
    raw.shirtNumber != null && Number.isFinite(Number(raw.shirtNumber))
      ? Number(raw.shirtNumber)
      : null;
  const injury = parseFotmobSquadInjury(raw);
  return {
    id,
    name: String(raw.name ?? ""),
    teamId,
    teamName,
    shirtNumber: shirt,
    positionIdsDesc: raw.positionIdsDesc != null ? String(raw.positionIdsDesc) : null,
    roleKey,
    injured: injury?.injured ?? false,
    injuryName: injury?.injuryName ?? null,
    expectedReturn: injury?.expectedReturn ?? null,
  };
}

/** Full club squad from FotMob team page (excludes coaches). */
export async function fetchTeamSquad(
  teamId: number,
  signal?: AbortSignal,
): Promise<{ teamId: number; teamName: string; players: FotmobSquadPlayer[] }> {
  const data = await fotmobGet("/teams", { id: teamId }, signal);
  const details = (data.details ?? {}) as Json;
  const teamName = String(details.name ?? "");
  const squadWrap = (data.squad ?? {}) as Json;
  const groups = Array.isArray(squadWrap.squad) ? (squadWrap.squad as Json[]) : [];
  const players: FotmobSquadPlayer[] = [];
  const seen = new Set<number>();
  for (const group of groups) {
    const members = Array.isArray(group.members) ? (group.members as Json[]) : [];
    for (const member of members) {
      const parsed = parseSquadMember(member, teamId, teamName);
      if (!parsed || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      players.push(parsed);
    }
  }
  return { teamId, teamName, players };
}

export async function fetchMatchesByDate(dateYmd: string): Promise<FotmobFixtureMatch[]> {
  const data = await fotmobGet("/matches", { date: dateYmd });
  const leagues = Array.isArray(data.leagues) ? (data.leagues as Json[]) : [];
  const out: FotmobFixtureMatch[] = [];
  for (const lg of leagues) {
    const matches = Array.isArray(lg.matches) ? (lg.matches as Json[]) : [];
    for (const m of matches) {
      const parsed = parseFotmobFixture(m);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

function parseEvent(raw: Json): FotmobMatchEvent {
  const player = (raw.player ?? {}) as Json;
  const swap = Array.isArray(raw.swap) ? (raw.swap as Json[]) : [];
  // FotMob: swap[0] = player coming on, swap[1] = player going off
  const playerIn = swap[0] ?? null;
  const playerOut = swap[1] ?? null;
  let assistName: string | null = null;
  if (typeof raw.assistInput === "string" && raw.assistInput.trim()) {
    assistName = raw.assistInput.trim();
  } else if (typeof raw.assistStr === "string") {
    const m = String(raw.assistStr).match(/assist by\s+(.+)/i);
    if (m) assistName = m[1].trim();
  }
  return {
    time: raw.time != null ? Number(raw.time) : null,
    overloadTime: raw.overloadTime != null ? Number(raw.overloadTime) : null,
    type: String(raw.type ?? raw.card ?? "Unknown"),
    isHome: raw.isHome != null ? Boolean(raw.isHome) : null,
    playerName:
      (raw.nameStr as string) ||
      (raw.fullName as string) ||
      (player.name as string) ||
      null,
    playerId:
      raw.playerId != null
        ? Number(raw.playerId)
        : player.id != null
          ? Number(player.id)
          : null,
    card: raw.card != null ? String(raw.card) : null,
    homeScore: raw.homeScore != null ? Number(raw.homeScore) : null,
    awayScore: raw.awayScore != null ? Number(raw.awayScore) : null,
    assistName,
    playerOut: playerOut?.name != null ? String(playerOut.name) : null,
    playerIn: playerIn?.name != null ? String(playerIn.name) : null,
    playerOutId: playerOut?.id != null ? Number(playerOut.id) : null,
    playerInId: playerIn?.id != null ? Number(playerIn.id) : null,
    ownGoal: Boolean(raw.ownGoal),
    raw,
  };
}

function parseLineupPlayers(
  team: Json,
  isHome: boolean,
): FotmobPlayerRating[] {
  const teamId = Number(team.id) || 0;
  const teamName = String(team.name ?? "");
  const out: FotmobPlayerRating[] = [];
  const pushList = (list: unknown, starter: boolean) => {
    if (!Array.isArray(list)) return;
    for (const p of list as Json[]) {
      const perf = (p.performance ?? {}) as Json;
      const ratingRaw = perf.rating ?? p.rating;
      const rating =
        ratingRaw != null && Number.isFinite(Number(ratingRaw)) ? Number(ratingRaw) : null;
      const id = Number(p.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      out.push({
        playerId: id,
        name: String(p.name ?? ""),
        teamId,
        teamName,
        isHome,
        shirtNumber: p.shirtNumber != null ? String(p.shirtNumber) : null,
        positionId: p.positionId != null ? Number(p.positionId) : null,
        rating,
        starter,
        minutes: null,
        goals: 0,
        assists: 0,
        yellowCards: 0,
        redCards: 0,
        ownGoals: 0,
        saves: 0,
        goalsConceded: 0,
        penaltiesWon: 0,
        penaltiesConceded: 0,
        penaltiesScored: 0,
        penaltiesMissed: 0,
        penaltiesSaved: 0,
      });
    }
  };
  pushList(team.starters, true);
  pushList(team.subs, false);
  return out;
}

function statValue(statsBlock: Json | undefined, label: string): number | null {
  if (!statsBlock) return null;
  const entry = statsBlock[label] as Json | undefined;
  if (!entry) return null;
  const stat = (entry.stat ?? entry) as Json;
  if (stat.value == null) return null;
  const n = Number(stat.value);
  return Number.isFinite(n) ? n : null;
}

/** FotMob labels move; `key` (e.g. missed_penalty) is the stable field. */
function statValueByKey(statsBlock: Json | undefined, key: string): number | null {
  if (!statsBlock) return null;
  for (const entry of Object.values(statsBlock)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Json;
    if (String(e.key ?? "") !== key) continue;
    const stat = (e.stat ?? e) as Json;
    if (stat.value == null) return null;
    const n = Number(stat.value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Read FotMob "Missed penalty" (key missed_penalty). Never treat a miss as a goal. */
export function penaltyMissedFromStatsBlock(statsBlock: Json | undefined): number {
  return (
    statValue(statsBlock, "Penalties missed") ??
    statValue(statsBlock, "Penalty missed") ??
    statValue(statsBlock, "Missed penalty") ??
    statValueByKey(statsBlock, "missed_penalty") ??
    0
  );
}

/** FotMob GK save: label "Saved penalties" / key saved_penalties (not "Saves from penalty"). */
export function penaltySavedFromStatsBlock(statsBlock: Json | undefined): number {
  return (
    statValue(statsBlock, "Saved penalties") ??
    statValue(statsBlock, "Penalties saved") ??
    statValue(statsBlock, "Penalty saved") ??
    statValue(statsBlock, "Saves from penalty") ??
    statValueByKey(statsBlock, "saved_penalties") ??
    0
  );
}

export type PenaltyEventInput = {
  type: string;
  playerId: number | null;
  ownGoal?: boolean;
  raw?: unknown;
};

/** true = score went up, false = unchanged, null = cannot tell. */
function penaltyScoreIncreased(raw: Json): boolean | null {
  const ns = raw.newScore;
  if (!Array.isArray(ns) || ns.length < 2) return null;
  const afterH = Number(ns[0]);
  const afterA = Number(ns[1]);
  if (!Number.isFinite(afterH) || !Number.isFinite(afterA)) return null;
  const beforeH = raw.homeScore != null ? Number(raw.homeScore) : NaN;
  const beforeA = raw.awayScore != null ? Number(raw.awayScore) : NaN;
  if (!Number.isFinite(beforeH) || !Number.isFinite(beforeA)) return true;
  return afterH > beforeH || afterA > beforeA;
}

function isPenaltyGoalDescription(raw: Json): boolean {
  const key = String(raw.goalDescriptionKey ?? "").toLowerCase();
  const desc = String(raw.goalDescription ?? "").toLowerCase();
  return key === "penalty" || desc === "penalty";
}

/**
 * Classify a FotMob match event for Mantra pens.
 * `MissedPenalty` is only a miss — never a goal / scored-penalty, even if raw
 * has a "penalty" description. Scored pens are `type: Goal` + penalty key +
 * the score actually increasing. Bare `Penalty` with no outcome is ignored.
 * Shootout events are ignored.
 */
export function classifyPenaltyEvent(e: PenaltyEventInput): "scored" | "missed" | null {
  const raw = e.raw && typeof e.raw === "object" ? (e.raw as Json) : {};
  if (raw.isPenaltyShootoutEvent) return null;
  if (e.type === "MissedPenalty") return "missed";
  if (e.type === "Penalty" || e.type === "penalty") return null;
  if (e.type === "Goal" && !e.ownGoal && isPenaltyGoalDescription(raw)) {
    const up = penaltyScoreIncreased(raw);
    if (up === true) return "scored";
    if (up === false) return "missed";
    return null;
  }
  return null;
}

export function applyPenaltiesFromEvents(
  players: FotmobPlayerRating[],
  events: PenaltyEventInput[],
): void {
  const scored = new Map<number, number>();
  const missed = new Map<number, number>();
  for (const e of events) {
    if (e.playerId == null) continue;
    const kind = classifyPenaltyEvent(e);
    if (kind === "missed") missed.set(e.playerId, (missed.get(e.playerId) ?? 0) + 1);
    else if (kind === "scored") scored.set(e.playerId, (scored.get(e.playerId) ?? 0) + 1);
  }
  if (!scored.size && !missed.size) return;
  for (const p of players) {
    const m = missed.get(p.playerId);
    const s = scored.get(p.playerId);
    if (m != null) p.penaltiesMissed = Math.max(p.penaltiesMissed, m);
    if (s != null) p.penaltiesScored = Math.max(p.penaltiesScored, s);
    // A miss is never a goal — do not increment goals here (goals come from stats).
  }
}

function mergePlayerStats(players: FotmobPlayerRating[], playerStats: Json): void {
  const byId = new Map(players.map((p) => [p.playerId, p]));
  for (const [idStr, raw] of Object.entries(playerStats)) {
    const id = Number(idStr);
    const p = byId.get(id);
    if (!p || !raw || typeof raw !== "object") continue;
    const blocks = Array.isArray((raw as Json).stats) ? ((raw as Json).stats as Json[]) : [];
    const top = blocks.find((b) => b.key === "top_stats") ?? blocks[0];
    const stats = (top?.stats ?? {}) as Json;
    const rating = statValue(stats, "FotMob rating");
    if (rating != null) p.rating = rating;
    p.minutes = statValue(stats, "Minutes played");
    p.goals = statValue(stats, "Goals") ?? 0;
    p.assists = statValue(stats, "Assists") ?? 0;
    p.yellowCards = statValue(stats, "Yellow cards") ?? statValue(stats, "Yellow card") ?? 0;
    p.redCards = statValue(stats, "Red cards") ?? statValue(stats, "Red card") ?? 0;
    p.ownGoals = statValue(stats, "Own goals") ?? statValue(stats, "Own goal") ?? 0;
    p.saves = statValue(stats, "Saves") ?? 0;
    p.goalsConceded = statValue(stats, "Goals conceded") ?? 0;
    // Scan all blocks — pen perks live in top_stats (or attack/gk).
    let penWon = 0;
    let penConc = 0;
    let penScored = 0;
    let penMissed = 0;
    let penSaved = 0;
    for (const block of blocks) {
      const s = (block?.stats ?? {}) as Json;
      penWon +=
        statValue(s, "Penalties won") ??
        statValue(s, "Penalty won") ??
        0;
      penConc +=
        statValue(s, "Conceded penalty") ??
        statValue(s, "Penalties conceded") ??
        statValue(s, "Penalty conceded") ??
        0;
      penScored +=
        statValue(s, "Penalties scored") ??
        statValue(s, "Penalty scored") ??
        statValue(s, "Penalty goals") ??
        0;
      penMissed += penaltyMissedFromStatsBlock(s);
      penSaved += penaltySavedFromStatsBlock(s);
    }
    p.penaltiesWon = penWon;
    p.penaltiesConceded = penConc;
    p.penaltiesScored = penScored;
    p.penaltiesMissed = penMissed;
    p.penaltiesSaved = penSaved;
  }
}

/** FotMob playerStats often omit cards; match events are authoritative. */
function applyCardsFromEvents(
  players: FotmobPlayerRating[],
  events: FotmobMatchEvent[],
): void {
  const yellow = new Map<number, number>();
  const red = new Map<number, number>();
  let any = false;
  for (const e of events) {
    if (e.playerId == null) continue;
    const card = String(e.card ?? "").toLowerCase();
    if (card === "yellow") {
      yellow.set(e.playerId, (yellow.get(e.playerId) ?? 0) + 1);
      any = true;
    } else if (card === "red") {
      red.set(e.playerId, (red.get(e.playerId) ?? 0) + 1);
      any = true;
    }
  }
  if (!any) return;
  for (const p of players) {
    if (yellow.has(p.playerId) || red.has(p.playerId)) {
      p.yellowCards = yellow.get(p.playerId) ?? 0;
      p.redCards = red.get(p.playerId) ?? 0;
    }
  }
}

export async function fetchMatchDetails(
  matchId: number,
  signal?: AbortSignal,
): Promise<FotmobMatchDetails> {
  const data = await fotmobGet("/matchDetails", { matchId }, signal);
  const general = (data.general ?? {}) as Json;
  const header = (data.header ?? {}) as Json;
  const content = (data.content ?? {}) as Json;
  const status = (header.status ?? {}) as FotmobMatchStatus;
  const teams = Array.isArray(header.teams) ? (header.teams as Json[]) : [];
  const homeT = teams[0] ?? {};
  const awayT = teams[1] ?? {};

  const matchFacts = (content.matchFacts ?? {}) as Json;
  const eventsWrap = (matchFacts.events ?? {}) as Json;
  const eventsRaw = Array.isArray(eventsWrap.events) ? (eventsWrap.events as Json[]) : [];
  const events = eventsRaw.map(parseEvent);

  const lineup = (content.lineup ?? {}) as Json;
  const players = [
    ...parseLineupPlayers((lineup.homeTeam ?? {}) as Json, true),
    ...parseLineupPlayers((lineup.awayTeam ?? {}) as Json, false),
  ];
  const playerStats = (content.playerStats ?? {}) as Json;
  if (playerStats && typeof playerStats === "object") mergePlayerStats(players, playerStats);
  applyCardsFromEvents(players, events);
  applyPenaltiesFromEvents(players, events);

  const potmRaw = (matchFacts.playerOfTheMatch ?? null) as Json | null;
  let potm: FotmobMatchDetails["potm"] = null;
  if (potmRaw && potmRaw.id != null) {
    const r = potmRaw.rating ?? (potmRaw.performance as Json | undefined)?.rating;
    potm = {
      playerId: Number(potmRaw.id),
      name: String(potmRaw.name ?? ""),
      rating: r != null && Number.isFinite(Number(r)) ? Number(r) : null,
    };
  }

  return {
    matchId: Number(general.matchId ?? matchId),
    leagueId: general.leagueId != null ? Number(general.leagueId) : null,
    leagueName: general.leagueName != null ? String(general.leagueName) : null,
    round: general.round != null ? String(general.round) : null,
    kickoff: status.utcTime ?? null,
    started: Boolean(status.started ?? general.started),
    finished: Boolean(status.finished ?? general.finished),
    scoreHome: homeT.score != null ? Number(homeT.score) : null,
    scoreAway: awayT.score != null ? Number(awayT.score) : null,
    statusShort: status.reason?.short ?? status.liveTime?.short ?? null,
    home: { id: Number(homeT.id) || 0, name: String(homeT.name ?? "") },
    away: { id: Number(awayT.id) || 0, name: String(awayT.name ?? "") },
    events,
    players,
    potm,
  };
}

/** Overdue NS is only "live" during a match window — not every past unplayed fixture. */
export const OVERDUE_NS_LIVE_MS = 4 * 3600_000;

export function matchPhase(m: {
  status?: FotmobMatchStatus;
  started?: boolean;
  finished?: boolean;
  kickoff?: string | null;
}): "live" | "finished" | "upcoming" | "cancelled" {
  const st = m.status;
  if (st?.cancelled) return "cancelled";
  const started = st?.started ?? m.started ?? false;
  const finished = st?.finished ?? m.finished ?? false;
  if (finished) return "finished";
  if (started) return "live";
  // FotMob sometimes leaves started=false after kickoff; treat recent overdue NS as in-play.
  const kickRaw = st?.utcTime ?? m.kickoff;
  const kick = kickRaw ? Date.parse(String(kickRaw)) : NaN;
  const now = Date.now();
  if (Number.isFinite(kick) && now >= kick && now - kick <= OVERDUE_NS_LIVE_MS) return "live";
  return "upcoming";
}
