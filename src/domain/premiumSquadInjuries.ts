/**
 * Batched Premium injury overlay: API-Football /injuries (league+season) +
 * FotMob team squad `injured` / expectedReturn. 1h cache, never per-row.
 */
import type Database from "better-sqlite3";
import { injuriesForLeague, type AfInjury } from "../clients/apiFootball.js";
import {
  fetchTeamSquad,
  type FotmobSquadInjury,
} from "../clients/fotmob.js";
import { config, hasApiFootballKey } from "../config.js";
import {
  invalidateComputed,
  peekComputed,
  writeComputed,
} from "../lib/computedCache.js";
import { clubsMatch } from "../lib/mantraFotmobIds.js";
import { namesMatch } from "../lib/names.js";
import { withTimeout } from "../lib/withTimeout.js";
import {
  PREMIUM_SQUAD_REPORT_TTL_MS,
  type PremiumSquadReportView,
  type SquadReportPlayer,
} from "./premiumSquadReport.js";

export const PREMIUM_INJURIES_CACHE_PREFIX = "premium:injuries:";

export type AbsenceKind = "injury" | "suspension" | "doubtful";

export type InjuryHint = {
  kind: AbsenceKind;
  detail: string | null;
  expectedReturn: string | null;
  source: "fotmob" | "api-football";
};

export type InjuryOverlayMeta = {
  apiFootball: "hit" | "empty" | "no_key" | "error" | "skipped";
  apiFootballCount: number;
  fotmob: "hit" | "empty" | "error" | "skipped";
  fotmobTeams: number;
  fotmobHits: number;
};

export type InjuryOverlayDeps = {
  hasAfKey?: () => boolean;
  fetchAfInjuries?: (leagueId: number, season: number) => Promise<AfInjury[]>;
  fetchFotmobTeamInjuries?: (
    teamId: number,
    signal?: AbortSignal,
  ) => Promise<FotmobSquadInjury[]>;
  season?: number;
};

const FM_TEAM_CAP = 8;
const FM_CONCURRENCY = 3;
const FM_FETCH_MS = 4_000;
const AF_FETCH_MS = 6_000;
const AF_CURRENT_DAYS = 21;

export function classifyAbsence(
  reason: string | null | undefined,
  type?: string | null,
): AbsenceKind {
  const t = `${type ?? ""} ${reason ?? ""}`.toLowerCase();
  if (/doubt|question|unfit|fitness|сомнит/.test(t)) return "doubtful";
  if (/suspend|red card|yellow cards?|ineligib|banned|дисквал|\bban\b/.test(t)) {
    return "suspension";
  }
  return "injury";
}

/** Skip AF rows that are not injury / ban / doubtful (e.g. Inactive, rest). */
export function afAbsenceRelevant(
  reason: string | null | undefined,
  type?: string | null,
): boolean {
  const t = `${type ?? ""} ${reason ?? ""}`.toLowerCase();
  if (!t.trim()) return false;
  if (
    /inactive|coach decision|\brest\b|personal reason|international duty|not in squad/.test(
      t,
    ) &&
    !/injur|suspend|card|doubt/.test(t)
  ) {
    return false;
  }
  return /injur|knock|strain|fracture|hamstring|knee|ankle|muscle|achilles|calf|suspend|card|doubt|unavail|illness|virus|covid/.test(
    t,
  );
}

export function absenceBadge(kind: AbsenceKind): string {
  if (kind === "suspension") return "дисквал";
  if (kind === "doubtful") return "сомнителен";
  return "травма";
}

export function normalizeReturn(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^(unknown|n\/?a|indefinite|tbd|none|-)$/i.test(s)) return "неизвестно";
  return s;
}

function hourVersion(now: Date): string {
  return `ttl:${Math.floor(now.getTime() / PREMIUM_SQUAD_REPORT_TTL_MS)}`;
}

async function cachedHour<T>(
  key: string,
  now: Date,
  compute: () => Promise<T>,
  database: Database.Database | undefined,
  fresh?: boolean,
): Promise<T> {
  const version = hourVersion(now);
  if (fresh) invalidateComputed(key, { database, persist: true });
  const hit = peekComputed<T>(key, version);
  if (hit !== undefined) return hit;
  const value = await compute();
  writeComputed(key, version, value, { database });
  return value;
}

function isCurrentAbsence(item: AfInjury, now: Date): boolean {
  const ts =
    item.fixture.timestamp != null
      ? item.fixture.timestamp * 1000
      : item.fixture.date
        ? Date.parse(item.fixture.date)
        : NaN;
  if (!Number.isFinite(ts)) return true;
  return (ts - now.getTime()) / 86_400_000 >= -AF_CURRENT_DAYS;
}

function latestAfByPlayer(rows: AfInjury[], now: Date): AfInjury[] {
  const best = new Map<string, AfInjury>();
  for (const row of rows) {
    if (!row.player.name || !isCurrentAbsence(row, now)) continue;
    if (!afAbsenceRelevant(row.player.reason, row.player.type)) continue;
    const key = `${row.team.name}|${row.player.name}`.toLowerCase();
    const prev = best.get(key);
    const ts = row.fixture.timestamp ?? 0;
    const prevTs = prev?.fixture.timestamp ?? 0;
    if (!prev || ts >= prevTs) best.set(key, row);
  }
  return [...best.values()];
}

function playerNeedsFotmob(player: SquadReportPlayer): boolean {
  if (player.status === "OUT" || player.status === "дискв.") return true;
  const known = player.minutesByTour.filter((cell) => cell.minutes != null);
  if (!known.length) return true;
  if (known.every((cell) => (cell.minutes ?? 0) === 0)) return true;
  let streak = 0;
  for (let i = player.minutesByTour.length - 1; i >= 0; i--) {
    const minutes = player.minutesByTour[i]?.minutes;
    if (minutes == null) continue;
    if (minutes === 0) streak += 1;
    else break;
  }
  return streak >= 2;
}

function fotmobTeamIds(
  view: PremiumSquadReportView,
  fetchAllClubs: boolean,
): number[] {
  const ids = new Set<number>();
  for (const player of view.players) {
    if (player.fotmobTeamId == null) continue;
    if (fetchAllClubs || playerNeedsFotmob(player)) ids.add(player.fotmobTeamId);
  }
  return [...ids].slice(0, FM_TEAM_CAP);
}

function matchAf(player: SquadReportPlayer, row: AfInjury): boolean {
  const nameHit =
    namesMatch(player.displayName, row.player.name) ||
    namesMatch(player.surname, row.player.name);
  if (!nameHit) return false;
  if (!player.clubName) return true;
  return clubsMatch(player.clubName, row.team.name);
}

function applyHint(player: SquadReportPlayer, hint: InjuryHint): SquadReportPlayer {
  const badge = absenceBadge(hint.kind);
  const parts = [
    hint.detail,
    hint.expectedReturn ? `возврат ${hint.expectedReturn}` : null,
    hint.source === "fotmob" ? "FotMob" : "API-Football",
    player.status === "OUT" ? player.reason : null,
  ].filter((part): part is string => Boolean(part && part !== "—"));
  return {
    ...player,
    status: badge,
    reason: hint.detail || player.reason,
    injury: {
      label: badge,
      expectedReturn: hint.expectedReturn,
      source: hint.source,
      detail: parts.join(" · ") || badge,
    },
  };
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next;
      next += 1;
      out[idx] = await fn(items[idx]!);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

async function defaultFotmobInjuries(
  teamId: number,
  signal?: AbortSignal,
): Promise<FotmobSquadInjury[]> {
  const squad = await fetchTeamSquad(teamId, signal);
  return squad.players
    .filter((row) => row.injured || row.expectedReturn || row.injuryName)
    .map((row) => ({
      playerId: row.id,
      name: row.name,
      injured: Boolean(row.injured),
      injuryName: row.injuryName ?? null,
      expectedReturn: row.expectedReturn ?? null,
    }));
}

export async function overlaySquadInjuries(
  view: PremiumSquadReportView,
  options: {
    now?: Date;
    fresh?: boolean;
    afLeagueId: number | null;
    database?: Database.Database;
    deps?: InjuryOverlayDeps;
    budgetMs?: number;
  },
): Promise<PremiumSquadReportView> {
  if (!view.ok || !view.players.length) {
    return {
      ...view,
      injuryMeta: {
        apiFootball: "skipped",
        apiFootballCount: 0,
        fotmob: "skipped",
        fotmobTeams: 0,
        fotmobHits: 0,
      },
    };
  }

  const now = options.now ?? new Date();
  const deps = options.deps ?? {};
  const deadline = Date.now() + Math.max(1, options.budgetMs ?? 8_000);
  const remaining = () => Math.max(0, deadline - Date.now());
  const hasKey = (deps.hasAfKey ?? hasApiFootballKey)();
  const season = deps.season ?? config.predictSeason;
  const fetchAf = deps.fetchAfInjuries ?? injuriesForLeague;
  const fetchFm = deps.fetchFotmobTeamInjuries ?? defaultFotmobInjuries;
  const meta: InjuryOverlayMeta = {
    apiFootball: hasKey ? "empty" : "no_key",
    apiFootballCount: 0,
    fotmob: "skipped",
    fotmobTeams: 0,
    fotmobHits: 0,
  };

  const byPlayer = new Map<number, InjuryHint>();

  if (hasKey && options.afLeagueId != null && remaining() > 50) {
    try {
      const rows = await withTimeout(
        cachedHour(
          `${PREMIUM_INJURIES_CACHE_PREFIX}af:${options.afLeagueId}:${season}`,
          now,
          () => fetchAf(options.afLeagueId!, season),
          options.database,
          options.fresh,
        ),
        Math.min(AF_FETCH_MS, remaining()),
        "af injuries timeout",
      );
      const current = latestAfByPlayer(rows, now);
      meta.apiFootballCount = current.length;
      meta.apiFootball = current.length ? "hit" : "empty";
      for (const player of view.players) {
        const hit = current.find((row) => matchAf(player, row));
        if (!hit) continue;
        byPlayer.set(player.mantraPlayerId, {
          kind: classifyAbsence(hit.player.reason, hit.player.type),
          detail: hit.player.reason || hit.player.type,
          expectedReturn: null,
          source: "api-football",
        });
      }
    } catch {
      meta.apiFootball = "error";
    }
  }

  const teamIds = fotmobTeamIds(view, !hasKey);
  meta.fotmobTeams = teamIds.length;
  if (teamIds.length && remaining() > 50) {
    let error = false;
    const fmById = new Map<number, FotmobSquadInjury>();
    await mapPool(teamIds, FM_CONCURRENCY, async (teamId) => {
      if (remaining() < 50) return;
      const ac = new AbortController();
      const ms = Math.min(FM_FETCH_MS, remaining());
      const timer = setTimeout(() => ac.abort(), ms);
      try {
        const rows = await cachedHour(
          `${PREMIUM_INJURIES_CACHE_PREFIX}fm:${teamId}`,
          now,
          () => fetchFm(teamId, ac.signal),
          options.database,
          options.fresh,
        );
        for (const row of rows) {
          if (!row.injured && !row.expectedReturn && !row.injuryName) continue;
          fmById.set(row.playerId, row);
        }
      } catch {
        error = true;
      } finally {
        clearTimeout(timer);
      }
    });
    meta.fotmobHits = fmById.size;
    meta.fotmob = error && !fmById.size ? "error" : fmById.size ? "hit" : "empty";
    for (const player of view.players) {
      if (player.fotmobPlayerId == null) continue;
      const row = fmById.get(player.fotmobPlayerId);
      if (!row) continue;
      const prev = byPlayer.get(player.mantraPlayerId);
      byPlayer.set(player.mantraPlayerId, {
        kind: prev?.kind === "suspension" ? "suspension" : "injury",
        detail: row.injuryName || prev?.detail || "травма",
        expectedReturn: normalizeReturn(row.expectedReturn) ?? prev?.expectedReturn ?? null,
        source: "fotmob",
      });
    }
  }

  const players = view.players.map((player) => {
    const hint = byPlayer.get(player.mantraPlayerId);
    return hint ? applyHint(player, hint) : player;
  });
  const anyReturn = players.some((player) => player.injury?.expectedReturn);

  return {
    ...view,
    players,
    gaps: {
      sofaScore: true,
      fotmobInjuryReturn: !anyReturn,
      apiFootballKey: !hasKey,
    },
    injuryMeta: meta,
  };
}
