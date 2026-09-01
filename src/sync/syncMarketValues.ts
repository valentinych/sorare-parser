import type { TmPlayer } from "../clients/transfermarkt.js";
import * as tm from "../clients/transfermarkt.js";
import { getDb, setMeta } from "../db/index.js";
import { nameMatchScore, namesMatch, normalizePos, normName } from "../lib/names.js";
import { parseDetailRole } from "../lib/roles.js";
import { AF_LEAGUES } from "../lib/afLeagues.js";

const CITY_TOKENS = new Set([
  "krakow",
  "warszawa",
  "lodz",
  "wroclaw",
  "poznan",
  "gdansk",
  "lublin",
  "radom",
  "kielce",
  "szczecin",
  "zabrze",
  "katowice",
  "gliwice",
  "lubin",
  "plock",
  "bialystok",
  "czestochowa",
  "madrid",
  "barcelona",
  "bilbao",
  "sevilla",
  "valencia",
  "london",
]);

/** Shared brand words that alone must not map two different clubs (Real Madrid↔Betis, West Ham↔Brom). */
const GENERIC_CLUB_TOKENS = new Set([
  ...CITY_TOKENS,
  "real",
  "united",
  "city",
  "town",
  "athletic",
  "atletico",
  "sporting",
  "racing",
  "olympique",
  "inter",
  "club",
  "deportivo",
  "albion",
  "hotspur",
  "wanderers",
  "west",
  "east",
  "north",
  "south",
  "borussia",
  "dynamo",
  "dinamo",
  "the",
  "de",
  "cd",
  "ud",
  "rcd",
  "ca",
  "ac",
  "as",
  "sv",
]);

function distinctiveTokens(name: string): string[] {
  return name
    .split(" ")
    .filter(Boolean)
    .filter((t) => t.length > 2 && !GENERIC_CLUB_TOKENS.has(t));
}

/** Prefer distinctive club tokens; ignore shared city / brand words. */
function clubNamesMatch(a: string, b: string): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // strip common suffixes for EN/PL clubs
  const strip = (s: string) =>
    s
      .replace(/\b(fc|cf|afc|sc|united|city|town|hotspur|wanderers|albion)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const sa = strip(na);
  const sb = strip(nb);
  if (sa && sb && sa === sb) return true;
  // substring only when the shorter side still has a distinctive token
  if (sa && sb && (sa.includes(sb) || sb.includes(sa))) {
    const shorter = sa.length <= sb.length ? sa : sb;
    if (distinctiveTokens(shorter).length >= 1) return true;
  }
  const da = distinctiveTokens(na);
  const db = distinctiveTokens(nb);
  const inter = da.filter((t) => db.includes(t));
  return inter.length >= 1;
}

/** Hard overrides AF team_id -> TM club id */
const TM_CLUB_BY_AF: Record<number, string> = {
  17115: "30974", // Wieczysta
  338: "422", // Wisla Krakow
  6962: "88", // Widzew
  // Premier League
  66: "405", // Aston Villa
  51: "1237", // Brighton & Hove Albion
  50: "281", // Manchester City
  33: "985", // Manchester United
  40: "31", // Liverpool
  42: "11", // Arsenal
  49: "631", // Chelsea
  47: "148", // Tottenham
  34: "762", // Newcastle
  // Championship / promoted
  48: "379", // West Ham United
  60: "984", // West Bromwich Albion
  39: "543", // Wolverhampton Wanderers
  72: "1039", // Queens Park Rangers
  // La Liga
  541: "418", // Real Madrid
  530: "13", // Atlético de Madrid
  531: "621", // Athletic Bilbao
  543: "150", // Real Betis Balompié
  542: "1108", // Deportivo Alavés
  544: "897", // Deportivo A Coruña
};

export type TmValueSyncOpts = {
  forceRefresh?: boolean;
  leagueId?: number;
  tmCompetition?: string;
};

function resolveTmCompetition(opts: TmValueSyncOpts): string {
  if (opts.tmCompetition) return opts.tmCompetition;
  if (opts.leagueId && AF_LEAGUES[opts.leagueId]) return AF_LEAGUES[opts.leagueId]!.tmCompetition;
  return "PL1";
}

async function loadTmClubs(
  tmCompetition: string,
  opts: { forceRefresh?: boolean },
): Promise<Array<{ id: string; name: string }>> {
  const db = getDb();
  const local = db
    .prepare(
      `SELECT cl.id, cl.name
       FROM tm_competition_clubs cc
       JOIN tm_clubs cl ON cl.id = cc.club_id
       WHERE cc.competition_id = ?`,
    )
    .all(tmCompetition) as Array<{ id: string; name: string }>;
  if (local.length > 0 && !opts.forceRefresh) {
    console.log(`  TM clubs from DB ${tmCompetition}: ${local.length}`);
    return local;
  }

  const table = await tm.competitionTable(tmCompetition, opts);
  const clubIds = table?.data?.tables?.[0]?.clubs.map((c) => c.clubId) ?? [];
  const tmClubs: Array<{ id: string; name: string }> = [];
  for (const id of clubIds) {
    const info = await tm.clubInfo(id, opts);
    if (info?.data?.name) tmClubs.push({ id: String(info.data.id ?? id), name: info.data.name });
  }
  return tmClubs;
}

/** Count AF↔TM roster name overlaps (greedy 1:1). Used when club names are weird. */
function rosterOverlapScore(
  afNames: string[],
  tmNames: string[],
): number {
  const used = new Set<number>();
  let n = 0;
  for (const a of afNames) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < tmNames.length; i++) {
      if (used.has(i)) continue;
      const s = nameMatchScore(a, tmNames[i]!);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    if (best >= 0 && bestScore > 0) {
      used.add(best);
      n++;
    }
  }
  return n;
}

function loadAfSquadNames(season: number, afTeamId: number): string[] {
  return (
    getDb()
      .prepare(`SELECT name FROM squad_players WHERE season = ? AND team_id = ?`)
      .all(season, afTeamId) as Array<{ name: string }>
  ).map((r) => r.name);
}

function loadTmSquadNames(tmClubId: string): string[] {
  return (
    getDb()
      .prepare(`SELECT name FROM tm_squad_players WHERE club_id = ?`)
      .all(tmClubId) as Array<{ name: string }>
  ).map((r) => r.name);
}

/** Best TM club by shared player identities; null if overlap too weak. */
function bestClubByRosterOverlap(
  afNames: string[],
  tmClubs: Array<{ id: string; name: string }>,
  opts?: { excludeIds?: Set<string>; minOverlap?: number },
): { club: { id: string; name: string }; overlap: number } | null {
  if (afNames.length === 0) return null;
  const minOverlap = opts?.minOverlap ?? Math.min(3, Math.max(2, Math.ceil(afNames.length * 0.12)));
  let best: { club: { id: string; name: string }; overlap: number } | null = null;
  for (const club of tmClubs) {
    if (opts?.excludeIds?.has(club.id)) continue;
    const overlap = rosterOverlapScore(afNames, loadTmSquadNames(club.id));
    if (!best || overlap > best.overlap) best = { club, overlap };
  }
  if (!best || best.overlap < minOverlap) return null;
  return best;
}

export async function syncTmClubMap(season: number, opts: TmValueSyncOpts = {}): Promise<number> {
  const tmCompetition = resolveTmCompetition(opts);
  const tmClubs = await loadTmClubs(tmCompetition, opts);
  const db = getDb();
  const afTeams = opts.leagueId
    ? (db
        .prepare(
          `SELECT team_id AS id, name FROM season_teams
           WHERE season = ? AND (league_id = ? OR league_id IS NULL)`,
        )
        .all(season, opts.leagueId) as Array<{ id: number; name: string }>)
    : (db
        .prepare(`SELECT team_id AS id, name FROM season_teams WHERE season = ?`)
        .all(season) as Array<{ id: number; name: string }>);

  const upsert = db.prepare(
    `INSERT INTO tm_club_map (af_team_id, tm_club_id, tm_name)
     VALUES (@af_team_id, @tm_club_id, @tm_name)
     ON CONFLICT(af_team_id) DO UPDATE SET tm_club_id = excluded.tm_club_id, tm_name = excluded.tm_name`,
  );

  // First pass: forced + name match (may leave misses / weak links).
  type Tentative = {
    af: { id: number; name: string };
    hit: { id: string; name: string } | null;
    via: "forced" | "name" | "roster" | null;
  };
  const tentative: Tentative[] = [];
  const claimed = new Set<string>();

  for (const af of afTeams) {
    let hit: { id: string; name: string } | undefined;
    let via: Tentative["via"] = null;
    const forced = TM_CLUB_BY_AF[af.id];
    if (forced) {
      hit = tmClubs.find((c) => c.id === forced) ?? { id: forced, name: af.name };
      via = "forced";
    }
    if (!hit) {
      hit =
        tmClubs.find((c) => normName(c.name) === normName(af.name)) ??
        tmClubs.find((c) => clubNamesMatch(af.name, c.name));
      if (hit) via = "name";
    }
    if (hit) claimed.add(hit.id);
    tentative.push({ af, hit: hit ?? null, via });
  }

  // Second pass: roster-overlap rematch for misses and weak name links
  // (Turkish transliteration / official vs common names).
  for (const row of tentative) {
    const afNames = loadAfSquadNames(season, row.af.id);
    if (afNames.length === 0) continue;

    const currentOverlap = row.hit
      ? rosterOverlapScore(afNames, loadTmSquadNames(row.hit.id))
      : 0;
    const exclude = new Set(claimed);
    if (row.hit) exclude.delete(row.hit.id);

    const byRoster = bestClubByRosterOverlap(afNames, tmClubs, {
      excludeIds: exclude,
      minOverlap: Math.min(3, Math.max(2, Math.ceil(afNames.length * 0.12))),
    });
    if (!byRoster) continue;

    const nameWeak =
      !row.hit ||
      (row.via === "name" &&
        currentOverlap < Math.min(4, Math.ceil(afNames.length * 0.15)));
    const rosterMuchBetter =
      byRoster.overlap >= currentOverlap + 3 && byRoster.overlap >= 4;

    if (!row.hit || (nameWeak && byRoster.club.id !== row.hit.id) || rosterMuchBetter) {
      if (row.hit && row.hit.id !== byRoster.club.id) claimed.delete(row.hit.id);
      // Avoid stealing a strong existing claim
      const stealee = tentative.find(
        (t) => t !== row && t.hit?.id === byRoster.club.id,
      );
      if (stealee) {
        const stealeeAf = loadAfSquadNames(season, stealee.af.id);
        const stealeeOverlap = stealeeAf.length
          ? rosterOverlapScore(stealeeAf, loadTmSquadNames(byRoster.club.id))
          : 0;
        if (stealeeOverlap >= byRoster.overlap) continue;
        stealee.hit = null;
        stealee.via = null;
      }
      row.hit = byRoster.club;
      row.via = "roster";
      claimed.add(byRoster.club.id);
      console.log(
        `  roster-remap ${row.af.name} -> ${byRoster.club.name} (${byRoster.club.id}) overlap=${byRoster.overlap}/${afNames.length}`,
      );
    }
  }

  let mapped = 0;
  for (const row of tentative) {
    if (!row.hit) {
      console.warn(`  TM map miss: ${row.af.name}`);
      continue;
    }
    upsert.run({
      af_team_id: row.af.id,
      tm_club_id: row.hit.id,
      tm_name: row.hit.name,
    });
    mapped++;
    const tag = row.via === "roster" ? " [roster]" : row.via === "forced" ? " [forced]" : "";
    console.log(`  map ${row.af.name} -> ${row.hit.name} (${row.hit.id})${tag}`);
  }
  setMeta(`tm_map_${opts.leagueId ?? "all"}_${season}`, String(mapped));
  return mapped;
}

type LocalTmPlayer = {
  id: string;
  name: string;
  position: string | null;
  detail_role: string | null;
  detail_label: string | null;
  side_role: string | null;
  market_value_eur: number | null;
};

function loadLocalTmSquad(tmClubId: string): LocalTmPlayer[] {
  return getDb()
    .prepare(
      `SELECT player_id AS id, name, position, detail_role, detail_label, side_role, market_value_eur
       FROM tm_squad_players WHERE club_id = ?`,
    )
    .all(tmClubId) as LocalTmPlayer[];
}

export async function syncMarketValues(season: number, opts: TmValueSyncOpts = {}): Promise<number> {
  const db = getDb();
  const leagueFilter = opts.leagueId
    ? (db
        .prepare(`SELECT team_id AS id FROM season_teams WHERE season = ? AND league_id = ?`)
        .all(season, opts.leagueId) as Array<{ id: number }>)
    : null;
  const leagueTeamIds = leagueFilter ? new Set(leagueFilter.map((t) => t.id)) : null;

  const maps = (
    db.prepare(`SELECT af_team_id, tm_club_id, tm_name FROM tm_club_map`).all() as Array<{
      af_team_id: number;
      tm_club_id: string;
      tm_name: string;
    }>
  ).filter((m) => !leagueTeamIds || leagueTeamIds.has(m.af_team_id));

  // Prefer a real AF link over a later null write (same TM id can appear on two
  // club squads after transfers / dual listings — e.g. Güven Yalçın).
  const upsertValue = db.prepare(
    `INSERT INTO player_values
       (af_player_id, tm_player_id, team_id, name, position, detail_role, detail_label, side_role, market_value_eur)
     VALUES
       (@af_player_id, @tm_player_id, @team_id, @name, @position, @detail_role, @detail_label, @side_role, @market_value_eur)
     ON CONFLICT(tm_player_id) DO UPDATE SET
       af_player_id = COALESCE(excluded.af_player_id, player_values.af_player_id),
       team_id = CASE
         WHEN excluded.af_player_id IS NOT NULL THEN excluded.team_id
         WHEN player_values.af_player_id IS NOT NULL THEN player_values.team_id
         ELSE excluded.team_id
       END,
       name = excluded.name,
       position = excluded.position,
       detail_role = excluded.detail_role,
       detail_label = excluded.detail_label,
       side_role = excluded.side_role,
       market_value_eur = excluded.market_value_eur`,
  );

  let total = 0;
  let matched = 0;

  for (const map of maps) {
    const localSquad = loadLocalTmSquad(map.tm_club_id);
    let players: Array<{
      id: string;
      name: string;
      position: string | null;
      detail_role: string | null;
      detail_label: string | null;
      side_role: string | null;
      market_value_eur: number | null;
    }> = localSquad;

    if (players.length === 0 || opts.forceRefresh) {
      const squad = await tm.clubSquad(map.tm_club_id, opts);
      const ids = squad?.data?.playerIds ?? [];
      const remote = await tm.playersByIds(ids, opts);
      players = remote.map((p) => {
        const detail = detailFromTm(p);
        return {
          id: String(p.id),
          name: p.name,
          position:
            normalizePos(p.attributes?.position?.category) ??
            normalizePos(p.attributes?.positionGroupName) ??
            normalizePos(p.attributes?.position?.name),
          detail_role: detail.role,
          detail_label: detail.label,
          side_role: detail.side,
          market_value_eur: p.marketValueDetails?.current?.value ?? null,
        };
      });
    }

    // Prefer squad shirt name, but also try players.name + lineup aliases.
    // AF squads sometimes use the second Spanish surname ("Álvaro Fernández") while
    // TM / lineups use the first ("Álvaro Carreras" / "A. Carreras").
    const afSquad = db
      .prepare(
        `SELECT sp.player_id AS id, sp.name, sp.position, p.name AS player_name
         FROM squad_players sp
         LEFT JOIN players p ON p.id = sp.player_id
         WHERE sp.season = ? AND sp.team_id = ?`,
      )
      .all(season, map.af_team_id) as Array<{
      id: number;
      name: string;
      position: string | null;
      player_name: string | null;
    }>;

    const lineupAliases = new Map<number, string[]>();
    const aliasRows = db
      .prepare(
        `SELECT player_id AS id, player_name AS name
         FROM lineup_appearances
         WHERE team_id = ?
         GROUP BY player_id, player_name`,
      )
      .all(map.af_team_id) as Array<{ id: number; name: string }>;
    for (const row of aliasRows) {
      const list = lineupAliases.get(row.id) ?? [];
      if (row.name && !list.includes(row.name)) list.push(row.name);
      lineupAliases.set(row.id, list);
    }

    const afAliases = (a: (typeof afSquad)[number]): string[] => {
      const out: string[] = [];
      const add = (v: string | null | undefined) => {
        const s = v?.trim();
        if (s && !out.includes(s)) out.push(s);
      };
      add(a.name);
      add(a.player_name);
      for (const alias of lineupAliases.get(a.id) ?? []) add(alias);
      return out;
    };

    const usedAf = new Set<number>();
    const keepTmIds = new Set<string>();
    // High MV first so "Barış Alper Yılmaz" claims AF "B. Yılmaz" before youth "Berat Yılmaz".
    const ordered = [...players].sort(
      (a, b) => (b.market_value_eur ?? 0) - (a.market_value_eur ?? 0),
    );

    for (const p of ordered) {
      const position = normalizePos(p.position) ?? p.position;
      let afId: number | null = null;
      const candidates = afSquad
        .filter((a) => {
          if (usedAf.has(a.id)) return false;
          return afAliases(a).some((alias) => namesMatch(alias, p.name));
        })
        .map((a) => {
          const nameScore = Math.max(0, ...afAliases(a).map((alias) => nameMatchScore(alias, p.name)));
          return {
            a,
            score: nameScore + (a.position && position && a.position === position ? 20 : 0),
          };
        })
        .sort((x, y) => y.score - x.score || x.a.name.length - y.a.name.length);
      if (candidates[0]) afId = candidates[0].a.id;

      if (afId) {
        usedAf.add(afId);
        matched++;
      }

      keepTmIds.add(String(p.id));
      upsertValue.run({
        af_player_id: afId,
        tm_player_id: p.id,
        team_id: map.af_team_id,
        name: p.name,
        position,
        detail_role: p.detail_role,
        detail_label: p.detail_label,
        side_role: p.side_role,
        market_value_eur: p.market_value_eur,
      });
      total++;
    }

    // Clear values still pinned to this AF club after the player left.
    let cleared = 0;
    if (keepTmIds.size > 0) {
      const staleValues = db
        .prepare(`SELECT tm_player_id AS id FROM player_values WHERE team_id = ?`)
        .all(map.af_team_id) as Array<{ id: string }>;
      const delValue = db.prepare(`DELETE FROM player_values WHERE tm_player_id = ? AND team_id = ?`);
      for (const row of staleValues) {
        if (keepTmIds.has(String(row.id))) continue;
        delValue.run(row.id, map.af_team_id);
        cleared++;
      }
    }

    console.log(
      `  values ${map.tm_name}: ${players.length} players, matched ${usedAf.size}` +
        (cleared ? `, cleared ${cleared}` : ""),
    );
  }

  setMeta(`tm_values_${opts.leagueId ?? "all"}_${season}`, `${total}/matched_${matched}`);
  return total;
}

function detailFromTm(p: TmPlayer): { role: string | null; label: string | null; side: string | null } {
  const pos = p.attributes?.position;
  const side = p.attributes?.firstSidePosition;
  const role = parseDetailRole(pos?.shortName, pos?.name, p.attributes?.positionGroupName ?? pos?.category);
  const sideRole = parseDetailRole(side?.shortName, side?.name, side?.category);
  return {
    role,
    label: pos?.shortName ?? pos?.name ?? null,
    side: sideRole,
  };
}
