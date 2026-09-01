/**
 * Manager formation preference.
 *
 * Identity: Transfermarkt staff page (AF /coachs is often months behind summer windows).
 * Formations: last N finished matches from the matched AF coach career (default 100),
 * backfilled from the current club when career is thin / empty (common for new appointments).
 * Preferred = recency-weighted mode (half-life ~180d), not raw count — recent stints dominate.
 */
import * as af from "../clients/apiFootball.js";
import { getDb, setMeta } from "../db/index.js";
import { FORMATIONS, inferFormation, parseDetailRole, type Role } from "../lib/roles.js";
import { tmEnqueue } from "../lib/tmQueue.js";

const DEFAULT_SAMPLE = 100;
/** Recency half-life for formation weights (days). */
const FORMATION_HALFLIFE_DAYS = 180;

function seasonsTouching(start: string | null, end: string | null): number[] {
  const from = start ? Number(start.slice(0, 4)) : new Date().getUTCFullYear() - 4;
  const toYear = end ? Number(end.slice(0, 4)) : new Date().getUTCFullYear();
  const seasons: number[] = [];
  for (let y = from - 1; y <= toYear; y++) {
    if (y >= 2015) seasons.push(y);
  }
  return [...new Set(seasons)].sort((a, b) => b - a);
}

function inRange(dateIso: string, start: string | null, end: string | null): boolean {
  const d = dateIso.slice(0, 10);
  if (start && d < start.slice(0, 10)) return false;
  if (end && d > end.slice(0, 10)) return false;
  return true;
}

function normalizeFormation(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const f = raw.trim().replace(/\s+/g, "");
  if (FORMATIONS[f]) return f;
  const aliases: Record<string, string> = {
    "4-3-2-1": "4-3-3",
    "4-5-1": "4-1-4-1",
    "3-4-2-1": "3-4-3",
    "3-4-1-2": "3-5-2",
  };
  if (aliases[f] && FORMATIONS[aliases[f]]) return aliases[f];
  return null;
}

/** Tokenize coach name; keep single-letter initials (AF often stores "O. Buruk"). */
export function coachTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length >= 1);
}

/** Compact key for display / stale checks (last two significant tokens). */
export function normCoachName(name: string | null | undefined): string | null {
  const tokens = coachTokens(name).filter((t) => t.length > 1);
  if (!tokens.length) return null;
  return tokens.slice(-2).join(" ");
}

function firstNamesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1 && b.startsWith(a)) return true;
  if (b.length === 1 && a.startsWith(b)) return true;
  return false;
}

/**
 * Match TM full names to AF abbreviated forms ("Okan Buruk" ↔ "O. Buruk")
 * and multi-token AF names ("Vítor Matos" ↔ "Vitor Emanuel Soares Matos").
 */
export function coachNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = coachTokens(a);
  const tb = coachTokens(b);
  if (!ta.length || !tb.length) return false;

  const lastA = ta[ta.length - 1]!;
  const lastB = tb[tb.length - 1]!;
  if (lastA.length < 3 || lastA !== lastB) return false;

  const firstsA = ta.slice(0, -1);
  const firstsB = tb.slice(0, -1);
  if (!firstsA.length || !firstsB.length) return false;

  // Any given-name token pair matches (full or initial).
  for (const fa of firstsA) {
    for (const fb of firstsB) {
      if (firstNamesMatch(fa, fb)) return true;
    }
  }
  return false;
}

/** Head coach from TM staff HTML (first "Manager" row). */
export async function fetchTmManagerName(tmClubId: string): Promise<string | null> {
  const html = await tmEnqueue(async () => {
    const res = await fetch(`https://www.transfermarkt.com/x/mitarbeiter/verein/${tmClubId}`, {
      headers: {
        Accept: "text/html",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-GB,en;q=0.9",
        Referer: "https://www.transfermarkt.com/",
      },
    });
    if (!res.ok) return null;
    return res.text();
  });
  if (!html) return null;

  // Name link, then a following cell with role Manager / Head coach (not Assistant Manager).
  const re =
    /title="([^"]+)"[^>]*>[^<]*<\/a>[\s\S]{0,400}?<td>\s*((?:Manager|Head coach|Head Coach|Cheftrainer))\s*<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const role = m[2]!.toLowerCase();
    if (role.includes("assistant")) continue;
    const name = decodeHtmlEntities(m[1]!).trim();
    if (name.length >= 3) return name;
  }
  return null;
}

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/** AF /coachs search only accepts alphanumeric + spaces. */
function afSearchQuery(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/['’]/g, " ")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tmClubIdForAfTeam(afTeamId: number): string | null {
  const row = getDb()
    .prepare(`SELECT tm_club_id AS id FROM tm_club_map WHERE af_team_id = ?`)
    .get(afTeamId) as { id: string } | undefined;
  return row?.id ?? null;
}

function pickAfCoachByName(
  coaches: af.AfCoach[],
  wantName: string,
  preferTeamId?: number,
): af.AfCoach | null {
  const hits = coaches.filter((c) => coachNamesMatch(c.name, wantName));
  if (!hits.length) return null;
  // Prefer: stint at target club → richer career → more recent start.
  // Avoid empty-career duplicates (e.g. "Ismail Kartal" n=0 vs "İ. Kartal" n=17).
  hits.sort((a, b) => {
    const aAt = preferTeamId
      ? (a.career ?? []).some((s) => s.team?.id === preferTeamId)
      : false;
    const bAt = preferTeamId
      ? (b.career ?? []).some((s) => s.team?.id === preferTeamId)
      : false;
    if (aAt !== bAt) return aAt ? -1 : 1;
    const aN = (a.career ?? []).length;
    const bN = (b.career ?? []).length;
    if (bN !== aN) return bN - aN;
    const aStart = [...(a.career ?? [])].sort((x, y) => String(y.start).localeCompare(String(x.start)))[0]
      ?.start;
    const bStart = [...(b.career ?? [])].sort((x, y) => String(y.start).localeCompare(String(x.start)))[0]
      ?.start;
    return String(bStart ?? "").localeCompare(String(aStart ?? ""));
  });
  return hits[0] ?? null;
}

function pickCurrentCoachFallback(coaches: af.AfCoach[], teamId: number): af.AfCoach | null {
  const ranked = coaches
    .map((c) => {
      const stints = (c.career ?? []).filter((x) => x.team?.id === teamId);
      const active = stints.find((s) => !s.end);
      const latest = [...stints].sort((a, b) => String(b.start).localeCompare(String(a.start)))[0];
      return { c, active, latest };
    })
    .filter((x) => x.active || x.latest);
  ranked.sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    return String(b.active?.start ?? b.latest?.start ?? "").localeCompare(
      String(a.active?.start ?? a.latest?.start ?? ""),
    );
  });
  const withActive = ranked.filter((x) => x.active);
  if (withActive.length >= 1) {
    withActive.sort((a, b) =>
      String(b.active?.start ?? "").localeCompare(String(a.active?.start ?? "")),
    );
    return withActive[0]!.c;
  }
  return ranked[0]?.c ?? null;
}

async function resolveAfCoach(
  teamId: number,
  tmName: string | null,
): Promise<{ coach: af.AfCoach | null; displayName: string | null }> {
  const teamRes = await af.coaches({ team: teamId });
  await af.sleep(250);
  const teamCoaches = teamRes.response ?? [];

  if (tmName) {
    const pool: af.AfCoach[] = [...teamCoaches];
    const seen = new Set(pool.map((c) => c.id));

    const parts = afSearchQuery(tmName).split(" ").filter(Boolean);
    const last = parts[parts.length - 1];
    const first = parts[0];
    const queries = [
      parts.length >= 2 ? `${first} ${last}` : null,
      last && last.length >= 3 ? last : null,
      parts.length >= 2 ? `${first} ${parts[1]}` : null,
      parts.join(" "),
    ].filter((q, i, arr): q is string => !!q && q.length >= 4 && arr.indexOf(q) === i);

    // Always gather surname (+ variants) so empty-career AF duplicates lose to rich ones
    // (e.g. "Ismail Kartal" n=0 vs "İ. Kartal" n=17).
    for (const q of queries) {
      const searchRes = await af.coaches({ search: q });
      await af.sleep(250);
      for (const c of searchRes.response ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        pool.push(c);
      }
    }

    const hit = pickAfCoachByName(pool, tmName, teamId);
    if (hit) return { coach: hit, displayName: tmName };
    return { coach: null, displayName: tmName };
  }

  const fallback = pickCurrentCoachFallback(teamCoaches, teamId);
  return { coach: fallback, displayName: fallback?.name ?? null };
}

function formationFromSquad(teamId: number, season: number): string {
  const rows = getDb()
    .prepare(
      `SELECT pv.detail_role AS detailRole, pv.detail_label AS detailLabel, sp.position AS afPosition
       FROM squad_players sp
       LEFT JOIN player_values pv
         ON pv.af_player_id = sp.player_id AND pv.team_id = sp.team_id
       WHERE sp.season = ? AND sp.team_id = ?`,
    )
    .all(season, teamId) as Array<{
    detailRole: string | null;
    detailLabel: string | null;
    afPosition: string | null;
  }>;
  const roles: Role[] = rows.map((r) => {
    const fromDetail = parseDetailRole(r.detailRole, r.detailLabel, null);
    const fromAf = parseDetailRole(r.afPosition, r.afPosition, r.afPosition);
    return fromDetail ?? fromAf ?? "CM";
  });
  return inferFormation(roles).code;
}

/** Recency-weighted preferred formation (half-life FORMATION_HALFLIFE_DAYS). */
function pickPreferredFormation(
  samples: Array<{ formation: string; date: string }>,
): { preferred: string; preferredCount: number; breakdown: Record<string, number> } | null {
  if (!samples.length) return null;
  const now = Date.now();
  const weights: Record<string, number> = {};
  const breakdown: Record<string, number> = {};
  for (const s of samples) {
    const t = Date.parse(s.date);
    const days = Number.isFinite(t) ? Math.max(0, (now - t) / 86_400_000) : 365;
    const w = Math.pow(0.5, days / FORMATION_HALFLIFE_DAYS);
    weights[s.formation] = (weights[s.formation] ?? 0) + w;
    breakdown[s.formation] = (breakdown[s.formation] ?? 0) + 1;
  }
  const ranked = Object.entries(weights).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return (breakdown[b[0]] ?? 0) - (breakdown[a[0]] ?? 0);
  });
  const preferred = ranked[0]![0];
  return { preferred, preferredCount: breakdown[preferred] ?? 0, breakdown };
}

async function collectFixturesForStint(
  sampleTeamId: number,
  start: string | null,
  end: string | null,
  seenFx: Set<number>,
  candidates: Array<{ fixtureId: number; sampleTeamId: number; date: string }>,
  hardCap: number,
): Promise<void> {
  for (const season of seasonsTouching(start, end)) {
    if (candidates.length >= hardCap) return;
    const { response } = await af.teamFixtures({ team: sampleTeamId, season });
    await af.sleep(250);
    for (const row of response) {
      if (row.fixture.status.short !== "FT") continue;
      if (!inRange(row.fixture.date, start, end)) continue;
      if (seenFx.has(row.fixture.id)) continue;
      seenFx.add(row.fixture.id);
      candidates.push({
        fixtureId: row.fixture.id,
        sampleTeamId,
        date: row.fixture.date,
      });
    }
  }
}

export type ManagerFormationSummary = {
  teamId: number;
  coachId: number;
  coachName: string;
  preferredFormation: string;
  preferredCount: number;
  sampleSize: number;
  breakdown: Record<string, number>;
  source: string;
  syncedAt: string;
};

export function getManagerFormation(teamId: number): ManagerFormationSummary | null {
  const row = getDb()
    .prepare(
      `SELECT team_id, coach_id, coach_name, preferred_formation, preferred_count,
              sample_size, breakdown_json, source, synced_at
       FROM manager_formation_summary WHERE team_id = ?`,
    )
    .get(teamId) as
    | {
        team_id: number;
        coach_id: number;
        coach_name: string | null;
        preferred_formation: string;
        preferred_count: number;
        sample_size: number;
        breakdown_json: string | null;
        source: string;
        synced_at: string;
      }
    | undefined;
  if (!row) return null;
  let breakdown: Record<string, number> = {};
  try {
    breakdown = row.breakdown_json ? (JSON.parse(row.breakdown_json) as Record<string, number>) : {};
  } catch {
    /* ignore */
  }
  return {
    teamId: row.team_id,
    coachId: row.coach_id,
    coachName: row.coach_name ?? "",
    preferredFormation: row.preferred_formation,
    preferredCount: row.preferred_count,
    sampleSize: row.sample_size,
    breakdown,
    source: row.source,
    syncedAt: row.synced_at,
  };
}

/** True when stored coach name no longer matches Transfermarkt head coach. */
export async function managerIdentityStale(teamId: number): Promise<boolean> {
  const existing = getManagerFormation(teamId);
  const tmId = tmClubIdForAfTeam(teamId);
  if (!tmId) return !existing;
  const tmName = await fetchTmManagerName(tmId);
  if (!tmName) return !existing;
  if (!existing) return true;
  return !coachNamesMatch(existing.coachName, tmName);
}

export async function syncManagerFormationsForTeam(
  teamId: number,
  opts: { sampleSize?: number; predictSeason?: number } = {},
): Promise<ManagerFormationSummary | null> {
  const limit = opts.sampleSize ?? DEFAULT_SAMPLE;
  const predictSeason = opts.predictSeason ?? new Date().getUTCFullYear();
  const db = getDb();

  const tmId = tmClubIdForAfTeam(teamId);
  const tmName = tmId ? await fetchTmManagerName(tmId) : null;
  if (tmName) console.log(`  TM manager: ${tmName} (club ${tmId})`);
  else console.warn(`  TM manager miss for AF team ${teamId} (tm=${tmId ?? "—"})`);

  const { coach, displayName } = await resolveAfCoach(teamId, tmName);
  const coachName = displayName ?? coach?.name;
  if (!coachName) {
    console.warn(`  no manager resolved for team ${teamId}`);
    return null;
  }
  console.log(
    `  coach ${coachName}${coach ? ` (AF ${coach.id})` : " (TM only, no AF career match)"} for team ${teamId}`,
  );

  type Cand = { fixtureId: number; sampleTeamId: number; date: string };
  const candidates: Cand[] = [];
  const seenFx = new Set<number>();
  const keptSamples: Array<{ formation: string; date: string }> = [];
  let kept = 0;

  if (coach) {
    const stints = (coach.career ?? []).filter((s) => s.team?.id != null);
    // Prefer current club stints, then newest others — avoids stale "active" AF stints
    // at a previous club flooding the recent window (e.g. Wilder still listed at Watford).
    stints.sort((a, b) => {
      const aHere = Number(a.team?.id) === teamId ? 1 : 0;
      const bHere = Number(b.team?.id) === teamId ? 1 : 0;
      if (aHere !== bHere) return bHere - aHere;
      return String(b.start ?? "").localeCompare(String(a.start ?? ""));
    });

    const hardCap = Math.max(limit * 3, 250);
    for (const stint of stints) {
      if (candidates.length >= hardCap) break;
      await collectFixturesForStint(
        Number(stint.team.id),
        stint.start,
        stint.end,
        seenFx,
        candidates,
        hardCap,
      );
    }

    // Backfill from current club when career is empty/thin or AF hasn't listed this stint
    // (common: new appointment, youth-only career, duplicate empty coach records).
    const hasCurrentStint = stints.some((s) => Number(s.team?.id) === teamId);
    if (!hasCurrentStint || candidates.length < limit) {
      const backfillStart =
        stints.find((s) => Number(s.team?.id) === teamId)?.start ??
        `${predictSeason - 2}-07-01`;
      console.log(
        `  backfill current club ${teamId} from ${backfillStart} (career candidates=${candidates.length})`,
      );
      await collectFixturesForStint(teamId, backfillStart, null, seenFx, candidates, hardCap);
    }

    candidates.sort((a, b) => b.date.localeCompare(a.date));
    // Oversample candidates: many recent fixtures may belong to other coaches when AF
    // career end dates are stale. Keep fetching lineups until we have `limit` kept.
    const takeCap = Math.min(candidates.length, Math.max(limit * 2, 150));
    console.log(`  candidate fixtures: ${candidates.length}, scanning up to ${takeCap}`);

    const insertSample = db.prepare(
      `INSERT INTO manager_formation_samples
         (team_id, coach_id, fixture_id, sample_team_id, formation, date_utc)
       VALUES (@team_id, @coach_id, @fixture_id, @sample_team_id, @formation, @date_utc)
       ON CONFLICT(team_id, fixture_id) DO UPDATE SET
         formation = excluded.formation,
         coach_id = excluded.coach_id,
         sample_team_id = excluded.sample_team_id,
         date_utc = excluded.date_utc`,
    );

    db.prepare(`DELETE FROM manager_formation_samples WHERE team_id = ?`).run(teamId);

    let scanned = 0;
    for (const cand of candidates.slice(0, takeCap)) {
      if (kept >= limit) break;
      scanned++;
      const { response } = await af.lineups(cand.fixtureId, cand.sampleTeamId);
      await af.sleep(250);
      const row = response.find((r) => r.team?.id === cand.sampleTeamId) ?? response[0];
      if (!row) continue;
      const lineupCoachId = row.coach?.id;
      const lineupCoachName = row.coach?.name;
      const coachOk =
        lineupCoachId == null ||
        lineupCoachId === coach.id ||
        coachNamesMatch(lineupCoachName, coach.name) ||
        coachNamesMatch(lineupCoachName, coachName);
      if (!coachOk) continue;
      const formation = normalizeFormation(row.formation);
      if (!formation) continue;
      insertSample.run({
        team_id: teamId,
        coach_id: coach.id,
        fixture_id: cand.fixtureId,
        sample_team_id: cand.sampleTeamId,
        formation,
        date_utc: cand.date,
      });
      keptSamples.push({ formation, date: cand.date });
      kept++;
      if (kept % 20 === 0) console.log(`  formations ${kept}/${limit} (scanned ${scanned})`);
    }
  } else {
    db.prepare(`DELETE FROM manager_formation_samples WHERE team_id = ?`).run(teamId);
  }

  const picked = pickPreferredFormation(keptSamples);
  let preferred: [string, number];
  let counts: Record<string, number>;
  let source = coach ? "tm+api-football" : "tm";
  if (picked) {
    preferred = [picked.preferred, picked.preferredCount];
    counts = picked.breakdown;
  } else {
    const inferred = formationFromSquad(teamId, predictSeason);
    preferred = [inferred, 0];
    counts = {};
    source = `${source}+squad-infer`;
    console.warn(`  no AF formations for ${coachName}; inferred ${inferred} from squad`);
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO manager_formation_summary
       (team_id, coach_id, coach_name, preferred_formation, preferred_count, sample_size, breakdown_json, source, synced_at)
     VALUES (@team_id, @coach_id, @coach_name, @preferred_formation, @preferred_count, @sample_size, @breakdown_json, @source, @synced_at)
     ON CONFLICT(team_id) DO UPDATE SET
       coach_id = excluded.coach_id,
       coach_name = excluded.coach_name,
       preferred_formation = excluded.preferred_formation,
       preferred_count = excluded.preferred_count,
       sample_size = excluded.sample_size,
       breakdown_json = excluded.breakdown_json,
       source = excluded.source,
       synced_at = excluded.synced_at`,
  ).run({
    team_id: teamId,
    coach_id: coach?.id ?? 0,
    coach_name: coachName,
    preferred_formation: preferred[0],
    preferred_count: preferred[1],
    sample_size: kept,
    breakdown_json: JSON.stringify(counts),
    source,
    synced_at: now,
  });

  setMeta(`manager_formation_${teamId}`, `${preferred[0]}:${preferred[1]}/${kept}`);
  console.log(
    `  preferred ${preferred[0]} (${preferred[1]}/${kept}, recency-weighted) · ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ") || "inferred"}`,
  );

  return getManagerFormation(teamId);
}
