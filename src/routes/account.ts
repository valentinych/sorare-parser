import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  config,
  hasExpected11PremiumAccess,
  hasLiveDraftAccess,
  isLiveDraftAdmin,
} from "../config.js";
import { getDb } from "../db/index.js";
import {
  getSquadBuilderTeamView,
  listFantasyTeams,
} from "../domain/managerTeam.js";
import {
  createSorareImportCode,
  disconnectSorareInside,
  sorareInsideConnectionStatus,
} from "../domain/sorareInside.js";
import { sorareAuthenticationStatus } from "../clients/sorare.js";

const SESSION_COOKIE = "mantra_session";
const OAUTH_STATE_COOKIE = "mantra_oauth_state";
const OAUTH_VERIFIER_COOKIE = "mantra_oauth_verifier";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const importCodeAttempts = new Map<number, number[]>();

type AppUser = {
  id: number;
  email: string;
  name: string | null;
  picture_url: string | null;
  mantra_manager_id: number | null;
  pin_my_leagues: number;
  locale: string;
  time_zone: string | null;
};

type GoogleUser = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

type SavedSquadRow = {
  id: number;
  fantasy_team_id: number;
  name: string;
  formation: string;
  assignments_json: string;
  alternatives_json: string;
  created_at: string;
  updated_at: string;
};

export function isGoogleConfigured(): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret);
}

function importCodeRateLimited(userId: number, now = Date.now()): boolean {
  const recent = (importCodeAttempts.get(userId) ?? []).filter(
    (time) => now - time < 60_000,
  );
  recent.push(now);
  importCodeAttempts.set(userId, recent);
  return recent.length > 5;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function cookieMap(req: FastifyRequest): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) result.set(name, decodeURIComponent(value));
  }
  return result;
}

function cookie(
  name: string,
  value: string,
  options: { maxAge?: number; httpOnly?: boolean } = {},
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
  ];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name: string): string {
  return cookie(name, "", { maxAge: 0 });
}

function publicUser(user: AppUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    pictureUrl: user.picture_url,
    mantraManagerId: user.mantra_manager_id,
    pinMyLeagues: Boolean(user.pin_my_leagues),
    locale: user.locale,
    timeZone: user.time_zone,
  };
}

export function currentUser(req: FastifyRequest): AppUser | null {
  const token = cookieMap(req).get(SESSION_COOKIE);
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();
  db.prepare(`DELETE FROM user_sessions WHERE expires_at <= ?`).run(now);
  return (
    (db
      .prepare(
        `SELECT u.id, u.email, u.name, u.picture_url, u.mantra_manager_id,
                u.pin_my_leagues, u.locale, u.time_zone
         FROM user_sessions s
         JOIN app_users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(hash(token), now) as AppUser | undefined) ?? null
  );
}

export function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
): AppUser | null {
  const user = currentUser(req);
  if (!user) {
    reply.code(401).send({ error: "authentication_required" });
    return null;
  }
  return user;
}

function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const forwardedHost = req.headers["x-forwarded-host"];
    const host =
      (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ??
      req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function requireSameOrigin(
  req: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (sameOrigin(req)) return true;
  reply.code(403).send({ error: "invalid_origin" });
  return false;
}

function redirectHome(reply: FastifyReply, status: string) {
  return reply.redirect(`${config.publicUrl}/#builder?auth=${status}`);
}

function savedSquadJson(row: SavedSquadRow) {
  return {
    id: row.id,
    fantasyTeamId: row.fantasy_team_id,
    name: row.name,
    formation: row.formation,
    assignments: JSON.parse(row.assignments_json) as Record<string, number>,
    alternatives: JSON.parse(row.alternatives_json) as Record<string, number>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function accountRoutes(app: FastifyInstance) {
  app.get("/api/me", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const user = currentUser(req);
    return {
      authenticated: Boolean(user),
      googleConfigured: isGoogleConfigured(),
      user: user ? publicUser(user) : null,
      entitlements: {
        expected11Premium: hasExpected11PremiumAccess(user?.email),
        expected11Admin: isLiveDraftAdmin(user?.email),
        liveDraft: hasLiveDraftAccess(user?.email),
      },
      sorare: sorareAuthenticationStatus(),
      sorareInside: sorareInsideConnectionStatus(user?.id ?? null),
    };
  });

  app.get("/auth/google", async (_req, reply) => {
    if (!isGoogleConfigured()) return redirectHome(reply, "unconfigured");

    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = hash(verifier);
    reply.header("Set-Cookie", [
      cookie(OAUTH_STATE_COOKIE, state, { maxAge: 600 }),
      cookie(OAUTH_VERIFIER_COOKIE, verifier, { maxAge: 600 }),
    ]);

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", config.googleClientId);
    url.searchParams.set("redirect_uri", config.googleRedirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "select_account");
    return reply.redirect(url.toString());
  });

  app.get("/auth/google/callback", async (req, reply) => {
    const query = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };
    const cookies = cookieMap(req);
    const state = cookies.get(OAUTH_STATE_COOKIE);
    const verifier = cookies.get(OAUTH_VERIFIER_COOKIE);
    reply.header("Set-Cookie", [
      clearCookie(OAUTH_STATE_COOKIE),
      clearCookie(OAUTH_VERIFIER_COOKIE),
    ]);

    if (
      query.error ||
      !query.code ||
      !query.state ||
      !state ||
      !verifier ||
      query.state !== state ||
      !isGoogleConfigured()
    ) {
      return redirectHome(reply, "failed");
    }

    try {
      const tokenResponse = await fetch(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code: query.code,
            client_id: config.googleClientId,
            client_secret: config.googleClientSecret,
            redirect_uri: config.googleRedirectUri,
            grant_type: "authorization_code",
            code_verifier: verifier,
          }),
        },
      );
      if (!tokenResponse.ok) throw new Error(`Google token: ${tokenResponse.status}`);
      const tokens = (await tokenResponse.json()) as { access_token?: string };
      if (!tokens.access_token) throw new Error("Google token missing");

      const profileResponse = await fetch(
        "https://openidconnect.googleapis.com/v1/userinfo",
        { headers: { authorization: `Bearer ${tokens.access_token}` } },
      );
      if (!profileResponse.ok) throw new Error(`Google profile: ${profileResponse.status}`);
      const profile = (await profileResponse.json()) as GoogleUser;
      if (!profile.sub || !profile.email || profile.email_verified !== true) {
        throw new Error("Google email is not verified");
      }

      const db = getDb();
      db.prepare(
        `INSERT INTO app_users (google_sub, email, name, picture_url)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(google_sub) DO UPDATE SET
           email = excluded.email,
           name = excluded.name,
           picture_url = excluded.picture_url,
           updated_at = datetime('now')`,
      ).run(
        profile.sub,
        profile.email,
        profile.name ?? null,
        profile.picture ?? null,
      );
      const user = db
        .prepare(`SELECT id FROM app_users WHERE google_sub = ?`)
        .get(profile.sub) as { id: number };

      const sessionToken = randomBytes(32).toString("base64url");
      const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      db.prepare(
        `INSERT INTO user_sessions (token_hash, user_id, expires_at)
         VALUES (?, ?, ?)`,
      ).run(hash(sessionToken), user.id, expiresAt);
      reply.header("Set-Cookie", [
        clearCookie(OAUTH_STATE_COOKIE),
        clearCookie(OAUTH_VERIFIER_COOKIE),
        cookie(SESSION_COOKIE, sessionToken, {
          maxAge: SESSION_TTL_SECONDS,
        }),
      ]);
      return redirectHome(reply, "ok");
    } catch (error) {
      req.log.error(error, "Google OAuth callback failed");
      return redirectHome(reply, "failed");
    }
  });

  app.post("/api/logout", async (req, reply) => {
    if (!requireSameOrigin(req, reply)) return;
    const token = cookieMap(req).get(SESSION_COOKIE);
    if (token) {
      getDb()
        .prepare(`DELETE FROM user_sessions WHERE token_hash = ?`)
        .run(hash(token));
    }
    reply.header("Set-Cookie", clearCookie(SESSION_COOKIE));
    return { ok: true };
  });

  app.patch("/api/me", async (req, reply) => {
    if (!requireSameOrigin(req, reply)) return;
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      mantraManagerId?: number | string | null;
      pinMyLeagues?: boolean | number | string | null;
      locale?: string;
      timeZone?: string | null;
    };
    const raw = body.mantraManagerId;
    const managerId =
      raw === undefined
        ? user.mantra_manager_id
        : raw === null || raw === ""
          ? null
          : Number(raw);
    if (
      managerId != null &&
      (!Number.isSafeInteger(managerId) || managerId <= 0)
    ) {
      return reply.code(400).send({ error: "invalid_mantra_manager_id" });
    }
    const pinMyLeagues =
      body.pinMyLeagues === undefined
        ? Boolean(user.pin_my_leagues)
        : body.pinMyLeagues === true ||
          body.pinMyLeagues === 1 ||
          body.pinMyLeagues === "1" ||
          body.pinMyLeagues === "true";
    const locale = String(body.locale ?? user.locale);
    if (!["ru", "en", "uk", "be"].includes(locale)) {
      return reply.code(400).send({ error: "invalid_locale" });
    }
    const timeZone = body.timeZone == null ? user.time_zone : String(body.timeZone);
    if (timeZone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone }).format();
      } catch {
        return reply.code(400).send({ error: "invalid_time_zone" });
      }
    }
    getDb()
      .prepare(
        `UPDATE app_users
         SET mantra_manager_id = ?, pin_my_leagues = ?, locale = ?, time_zone = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(managerId, pinMyLeagues ? 1 : 0, locale, timeZone, user.id);
    return {
      user: {
        ...publicUser(user),
        mantraManagerId: managerId,
        pinMyLeagues,
        locale,
        timeZone,
      },
    };
  });

  app.get("/api/me/sorareinside", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const user = requireUser(req, reply);
    if (!user) return;
    return { connection: sorareInsideConnectionStatus(user.id) };
  });

  app.post("/api/me/sorareinside/import-code", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(req, reply)) return;
    const user = requireUser(req, reply);
    if (!user) return;
    if (importCodeRateLimited(user.id)) {
      reply.header("Retry-After", "60");
      return reply.code(429).send({ error: "rate_limit_exceeded" });
    }
    return createSorareImportCode(user.id);
  });

  app.delete("/api/me/sorareinside", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(req, reply)) return;
    const user = requireUser(req, reply);
    if (!user) return;
    disconnectSorareInside(user.id);
    return {
      ok: true,
      connection: sorareInsideConnectionStatus(user.id),
    };
  });

  app.get("/api/me/mantra-teams", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!user.mantra_manager_id) {
      return reply.code(409).send({ error: "mantra_manager_id_required" });
    }
    const query = req.query as {
      tournamentId?: string;
      leagueId?: string;
    };
    const tournamentId =
      query.tournamentId != null ? Number(query.tournamentId) : undefined;
    const leagueId =
      query.leagueId != null ? Number(query.leagueId) : undefined;
    return {
      teams: listFantasyTeams({
        tournamentId:
          tournamentId != null && Number.isFinite(tournamentId)
            ? tournamentId
            : undefined,
        leagueId:
          leagueId != null && Number.isFinite(leagueId) ? leagueId : undefined,
        managerId: user.mantra_manager_id,
      }),
    };
  });

  app.get("/api/squad-builder/saves", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const query = req.query as { teamId?: string };
    const teamId = query.teamId != null ? Number(query.teamId) : null;
    if (
      teamId != null &&
      (!Number.isSafeInteger(teamId) || teamId <= 0)
    ) {
      return reply.code(400).send({ error: "invalid_team_id" });
    }
    const rows = getDb()
      .prepare(
        `SELECT id, fantasy_team_id, name, formation, assignments_json, alternatives_json,
                created_at, updated_at
         FROM saved_squads
         WHERE user_id = ? AND (? IS NULL OR fantasy_team_id = ?)
         ORDER BY updated_at DESC, id DESC`,
      )
      .all(user.id, teamId, teamId) as SavedSquadRow[];
    return { squads: rows.map(savedSquadJson) };
  });

  app.post("/api/squad-builder/saves", async (req, reply) => {
    if (!requireSameOrigin(req, reply)) return;
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      fantasyTeamId?: number;
      name?: string;
      formation?: string;
      assignments?: Record<string, number>;
      alternatives?: Record<string, number>;
    };
    const teamId = Number(body.fantasyTeamId);
    const name = String(body.name ?? "").trim();
    const formation = String(body.formation ?? "");
    if (!Number.isSafeInteger(teamId) || teamId <= 0) {
      return reply.code(400).send({ error: "invalid_team_id" });
    }
    if (!name || name.length > 80) {
      return reply.code(400).send({ error: "invalid_name" });
    }

    const view = getSquadBuilderTeamView(teamId);
    if (!view) return reply.code(404).send({ error: "team_not_found" });
    const formationDef = view.squadFormations.find(
      (item) => item.formation === formation,
    );
    if (!formationDef) {
      return reply.code(400).send({ error: "invalid_formation" });
    }

    const roster = new Map(
      view.roster.map((player) => [player.mantraId, player]),
    );
    const normalized: Record<string, number> = {};
    const normalizedAlternatives: Record<string, number> = {};
    const usedPlayers = new Set<number>();
    for (const [rawSlot, rawPlayerId] of Object.entries(
      body.assignments ?? {},
    )) {
      const slotIndex = Number(rawSlot);
      const playerId = Number(rawPlayerId);
      const slot = formationDef.slots.find((item) => item.index === slotIndex);
      const player = roster.get(playerId);
      if (
        !Number.isSafeInteger(slotIndex) ||
        !Number.isSafeInteger(playerId) ||
        !slot ||
        !player ||
        usedPlayers.has(playerId) ||
        !player.positions.some((position) => slot.accepted.includes(position))
      ) {
        return reply.code(400).send({ error: "invalid_assignments" });
      }
      normalized[String(slotIndex)] = playerId;
      usedPlayers.add(playerId);
    }
    for (const [rawSlot, rawPlayerId] of Object.entries(
      body.alternatives ?? {},
    )) {
      const slotIndex = Number(rawSlot);
      const playerId = Number(rawPlayerId);
      const slot = formationDef.slots.find((item) => item.index === slotIndex);
      const player = roster.get(playerId);
      if (
        !Number.isSafeInteger(slotIndex) ||
        !Number.isSafeInteger(playerId) ||
        !slot ||
        !player ||
        usedPlayers.has(playerId) ||
        !player.positions.some((position) => slot.accepted.includes(position))
      ) {
        return reply.code(400).send({ error: "invalid_alternatives" });
      }
      normalizedAlternatives[String(slotIndex)] = playerId;
      usedPlayers.add(playerId);
    }

    const db = getDb();
    db.prepare(
      `INSERT INTO saved_squads
         (user_id, fantasy_team_id, name, formation, assignments_json, alternatives_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, fantasy_team_id, name) DO UPDATE SET
         formation = excluded.formation,
         assignments_json = excluded.assignments_json,
         alternatives_json = excluded.alternatives_json,
         updated_at = datetime('now')`,
    ).run(
      user.id,
      teamId,
      name,
      formation,
      JSON.stringify(normalized),
      JSON.stringify(normalizedAlternatives),
    );
    const row = db
      .prepare(
        `SELECT id, fantasy_team_id, name, formation, assignments_json, alternatives_json,
                created_at, updated_at
         FROM saved_squads
         WHERE user_id = ? AND fantasy_team_id = ? AND name = ?`,
      )
      .get(user.id, teamId, name) as SavedSquadRow;
    return reply.code(201).send({ squad: savedSquadJson(row) });
  });

  app.delete("/api/squad-builder/saves/:id", async (req, reply) => {
    if (!requireSameOrigin(req, reply)) return;
    const user = requireUser(req, reply);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return reply.code(400).send({ error: "invalid_save_id" });
    }
    const result = getDb()
      .prepare(`DELETE FROM saved_squads WHERE id = ? AND user_id = ?`)
      .run(id, user.id);
    if (result.changes === 0) {
      return reply.code(404).send({ error: "save_not_found" });
    }
    return { ok: true };
  });
}
