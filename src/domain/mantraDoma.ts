/**
 * «Mantra Дома» — League One players with curated Mantra positions,
 * photos (TM portrait or FotMob CDN), and club crests.
 */
import { getDb } from "../db/index.js";
import {
  loadLeagueOneMantraPositions,
  readLeagueOneSnapshot,
  type LeagueOnePlayerRow,
} from "./leagueOne.js";

const FOTMOB_PLAYER_IMAGE =
  "https://images.fotmob.com/image_resources/playerimages";
const FOTMOB_TEAM_LOGO =
  "https://images.fotmob.com/image_resources/logo/teamlogo";
const TM_CREST = "https://img.a.transfermarkt.technology/wappen/big";

export type MantraDomaPlayer = {
  tmPlayerId: string;
  name: string;
  clubId: string;
  clubName: string;
  mantraPositions: string[];
  /** Prefer Transfermarkt portrait; else FotMob headshot. */
  photoUrl: string | null;
  photoSource: "transfermarkt" | "fotmob" | null;
  clubLogoUrl: string | null;
  fotmobPlayerId: number | null;
};

export type MantraDomaView = {
  ok: boolean;
  empty: boolean;
  count: number;
  syncedAt: string | null;
  players: MantraDomaPlayer[];
  clubs: Array<{ id: string; name: string }>;
};

function fotmobPlayerPhoto(fotmobPlayerId: number | null | undefined): string | null {
  if (fotmobPlayerId == null || !Number.isFinite(fotmobPlayerId) || fotmobPlayerId <= 0) {
    return null;
  }
  return `${FOTMOB_PLAYER_IMAGE}/${fotmobPlayerId}.png`;
}

function tmCrestUrl(clubId: string | null | undefined): string | null {
  const id = String(clubId || "").trim();
  if (!id) return null;
  return `${TM_CREST}/${id}.png`;
}

function fotmobTeamLogo(teamId: number | null | undefined): string | null {
  if (teamId == null || !Number.isFinite(teamId) || teamId <= 0) return null;
  return `${FOTMOB_TEAM_LOGO}/${teamId}.png`;
}

function loadTmMedia(playerIds: string[]): Map<
  string,
  { name: string; portraitUrl: string | null; clubId: string; clubName: string; crestUrl: string | null }
> {
  const ids = [...new Set(playerIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const map = new Map<
    string,
    { name: string; portraitUrl: string | null; clubId: string; clubName: string; crestUrl: string | null }
  >();
  if (!ids.length) return map;

  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT sp.player_id AS playerId, sp.name, sp.portrait_url AS portraitUrl,
              sp.club_id AS clubId, c.name AS clubName, c.crest_url AS crestUrl
       FROM tm_squad_players sp
       LEFT JOIN tm_clubs c ON c.id = sp.club_id
       WHERE sp.player_id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
    playerId: string;
    name: string;
    portraitUrl: string | null;
    clubId: string;
    clubName: string | null;
    crestUrl: string | null;
  }>;

  for (const row of rows) {
    if (map.has(row.playerId)) continue;
    map.set(row.playerId, {
      name: row.name,
      portraitUrl: row.portraitUrl || null,
      clubId: row.clubId,
      clubName: row.clubName || "",
      crestUrl: row.crestUrl || null,
    });
  }
  return map;
}

/** clubName (TM or FotMob) → FotMob team id, from snapshot orphans. */
function buildFotmobTeamMap(
  orphans: Array<{ teamId: number; teamName: string }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const orphan of orphans) {
    const key = String(orphan.teamName || "")
      .trim()
      .toLowerCase();
    if (!key || !orphan.teamId) continue;
    if (!map.has(key)) map.set(key, orphan.teamId);
  }
  return map;
}

export async function getMantraDomaView(): Promise<MantraDomaView> {
  const assigned = loadLeagueOneMantraPositions();
  const snapshot = await readLeagueOneSnapshot();
  const snapPlayers: LeagueOnePlayerRow[] = snapshot?.players ?? [];
  const byTm = new Map(snapPlayers.map((p) => [p.tmPlayerId, p]));
  const media = loadTmMedia([...assigned.keys()]);
  const teamByName = buildFotmobTeamMap(snapshot?.fotmobOrphans ?? []);

  const players: MantraDomaPlayer[] = [];
  for (const [tmPlayerId, mantraPositions] of assigned) {
    if (!mantraPositions.length) continue;
    const snap = byTm.get(tmPlayerId);
    const tm = media.get(tmPlayerId);
    // Skip stale assignments with no League One snapshot / TM squad row.
    if (!snap && !tm) continue;

    const name = snap?.tmName || tm?.name || tmPlayerId;
    const clubId = snap?.tmClubId || tm?.clubId || "";
    const clubName = snap?.tmClubName || tm?.clubName || "—";
    const fotmobPlayerId = snap?.fotmobPlayerId ?? null;

    const tmPortrait = tm?.portraitUrl || null;
    const fotmobPhoto = fotmobPlayerPhoto(fotmobPlayerId);
    const photoUrl = tmPortrait || fotmobPhoto;
    const photoSource: MantraDomaPlayer["photoSource"] = tmPortrait
      ? "transfermarkt"
      : fotmobPhoto
        ? "fotmob"
        : null;

    const fotmobClubKey = String(snap?.fotmobClubName || clubName)
      .trim()
      .toLowerCase();
    const fotmobTeamId = teamByName.get(fotmobClubKey) ?? null;
    const clubLogoUrl =
      tm?.crestUrl || tmCrestUrl(clubId) || fotmobTeamLogo(fotmobTeamId);

    players.push({
      tmPlayerId,
      name,
      clubId,
      clubName,
      mantraPositions: [...mantraPositions],
      photoUrl,
      photoSource,
      clubLogoUrl,
      fotmobPlayerId,
    });
  }

  players.sort((a, b) => {
    const aClub = a.clubName === "—" ? 1 : 0;
    const bClub = b.clubName === "—" ? 1 : 0;
    return (
      aClub - bClub ||
      a.clubName.localeCompare(b.clubName, "ru") ||
      a.name.localeCompare(b.name, "ru") ||
      a.tmPlayerId.localeCompare(b.tmPlayerId)
    );
  });

  const clubMap = new Map<string, string>();
  for (const p of players) {
    if (p.clubId && !clubMap.has(p.clubId)) clubMap.set(p.clubId, p.clubName);
  }
  const clubs = [...clubMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  return {
    ok: true,
    empty: players.length === 0,
    count: players.length,
    syncedAt: snapshot?.syncedAt ?? null,
    players,
    clubs,
  };
}

export type MantraDomaApplication = {
  userId: number;
  teamName: string;
  wantRegularAuction: boolean;
  wantLiveAuction: boolean;
  userName: string | null;
  userPictureUrl: string | null;
  createdAt: string;
  updatedAt: string;
  isMine: boolean;
};

export class MantraDomaApplicationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "MantraDomaApplicationError";
  }
}

function ensureApplicationsTable(database = getDb()): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mantra_doma_applications (
      user_id INTEGER PRIMARY KEY,
      team_name TEXT NOT NULL,
      want_regular_auction INTEGER NOT NULL DEFAULT 0,
      want_live_auction INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
  `);
}

function mapApplicationRow(
  row: {
    userId: number;
    teamName: string;
    wantRegularAuction: number;
    wantLiveAuction: number;
    userName: string | null;
    userPictureUrl: string | null;
    createdAt: string;
    updatedAt: string;
  },
  viewerUserId: number | null,
): MantraDomaApplication {
  return {
    userId: row.userId,
    teamName: row.teamName,
    wantRegularAuction: Boolean(row.wantRegularAuction),
    wantLiveAuction: Boolean(row.wantLiveAuction),
    userName: row.userName,
    userPictureUrl: row.userPictureUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isMine: viewerUserId != null && row.userId === viewerUserId,
  };
}

export function listMantraDomaApplications(
  viewerUserId: number | null = null,
): { ok: true; applications: MantraDomaApplication[]; mine: MantraDomaApplication | null } {
  ensureApplicationsTable();
  const rows = getDb()
    .prepare(
      `SELECT a.user_id AS userId, a.team_name AS teamName,
              a.want_regular_auction AS wantRegularAuction,
              a.want_live_auction AS wantLiveAuction,
              u.name AS userName, u.picture_url AS userPictureUrl,
              a.created_at AS createdAt, a.updated_at AS updatedAt
       FROM mantra_doma_applications a
       JOIN app_users u ON u.id = a.user_id
       ORDER BY a.updated_at DESC, a.user_id ASC`,
    )
    .all() as Array<{
    userId: number;
    teamName: string;
    wantRegularAuction: number;
    wantLiveAuction: number;
    userName: string | null;
    userPictureUrl: string | null;
    createdAt: string;
    updatedAt: string;
  }>;

  const applications = rows.map((row) => mapApplicationRow(row, viewerUserId));
  return {
    ok: true,
    applications,
    mine: applications.find((row) => row.isMine) ?? null,
  };
}

export function upsertMantraDomaApplication(
  userId: number,
  input: {
    teamName?: unknown;
    wantRegularAuction?: unknown;
    wantLiveAuction?: unknown;
  },
): { ok: true; application: MantraDomaApplication } {
  const teamName = String(input.teamName ?? "").trim();
  if (!teamName || teamName.length > 80) {
    throw new MantraDomaApplicationError("team_name_required", 400);
  }
  const wantRegularAuction = Boolean(input.wantRegularAuction);
  const wantLiveAuction = Boolean(input.wantLiveAuction);
  if (!wantRegularAuction && !wantLiveAuction) {
    throw new MantraDomaApplicationError("auction_preference_required", 400);
  }

  ensureApplicationsTable();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO mantra_doma_applications
         (user_id, team_name, want_regular_auction, want_live_auction, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         team_name = excluded.team_name,
         want_regular_auction = excluded.want_regular_auction,
         want_live_auction = excluded.want_live_auction,
         updated_at = excluded.updated_at`,
    )
    .run(
      userId,
      teamName,
      wantRegularAuction ? 1 : 0,
      wantLiveAuction ? 1 : 0,
      now,
      now,
    );

  const listed = listMantraDomaApplications(userId);
  if (!listed.mine) throw new MantraDomaApplicationError("application_missing", 500);
  return { ok: true, application: listed.mine };
}
