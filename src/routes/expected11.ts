import { createReadStream, statSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config, isLiveDraftAdmin } from "../config.js";
import {
  defaultExpected11GazettesDir,
  expected11GazetteFile,
  expected11GazetteFileName,
  expected11GazetteView,
} from "../domain/expected11Gazette.js";
import {
  Expected11IngestError,
  defaultExpected11League,
  getExpected11IngestView,
  getExpected11TourMatchIds,
  importExpected11ForTour,
  listExpected11Tours,
  parseExpected11ImportScope,
  parseExpected11Tour,
  rebuildExpected11Tour,
  resolveExpected11League,
  resolveExpected11Tour,
  saveExpected11TourUrls,
  type Expected11IngestResult,
  type Expected11IngestView,
  type Expected11TourOption,
} from "../domain/expected11Ingest.js";
import {
  expected11TokenMatches,
  Expected11ImportError,
  getExpected11View,
  MAX_EXPECTED11_IMPORT_BYTES,
  normalizeExpected11Import,
  type Expected11ImportPayload,
  type Expected11ImportResult,
  type Expected11ViewOptions,
} from "../domain/expected11Import.js";
import { currentUser, requireSameOrigin, requireUser } from "./account.js";

type Expected11Actor = { email: string };

type Expected11RouteOptions = {
  token?: () => string;
  importPayload?: (
    payload: Expected11ImportPayload,
    scope: { league: string; tour: number },
  ) => Expected11ImportResult;
  view?: (options?: Expected11ViewOptions) => ReturnType<typeof getExpected11View>;
  ingestView?: (
    options?: { includeUrls?: boolean; league?: string | null; tour?: number | null },
  ) => Expected11IngestView;
  saveUrls?: (input: {
    league: unknown;
    tour: unknown;
    urls: unknown;
  }) => Expected11IngestResult;
  rebuildTour?: (input: {
    league: unknown;
    tour: unknown;
    urls?: unknown;
  }) => Promise<Expected11IngestResult>;
  toursForLeague?: (leagueSlug: string) => Expected11TourOption[];
  matchIdsForTour?: (league: string, tour: number) => string[];
  actorEmail?: (request: FastifyRequest) => string | null;
  authorizeAdmin?: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Expected11Actor | null;
  gazetteDir?: string;
};

function bearer(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer ([^\s]+)$/);
  return match?.[1];
}

function defaultActorEmail(request: FastifyRequest): string | null {
  return currentUser(request)?.email ?? null;
}

function defaultAuthorizeAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Expected11Actor | null {
  const user = requireUser(request, reply);
  if (!user) return null;
  if (!isLiveDraftAdmin(user.email)) {
    reply.code(403).send({ error: "expected11_admin_forbidden" });
    return null;
  }
  return { email: user.email };
}

function ingestError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof Expected11IngestError) {
    return reply.code(error.status).send({ error: error.code });
  }
  if (error instanceof Expected11ImportError) {
    return reply.code(error.status).send({ error: error.code });
  }
  request.log.error(error, "Expected11 URL ingest failed");
  return reply.code(500).send({ error: "expected11_ingest_failed" });
}

function queryScope(request: FastifyRequest): {
  leagueParam: string | undefined;
  tourParam: string | undefined;
} {
  const query = request.query as { league?: string; tour?: string; competition?: string };
  return {
    leagueParam: query.league || query.competition,
    tourParam: query.tour,
  };
}

export async function expected11Routes(
  app: FastifyInstance,
  options: Expected11RouteOptions = {},
) {
  const token = options.token ?? (() => config.expected11ImportToken);
  const importPayload =
    options.importPayload ??
    ((payload, scope) =>
      importExpected11ForTour(payload, scope.league, scope.tour));
  const view: NonNullable<Expected11RouteOptions["view"]> =
    options.view ??
    ((viewOptions) => getExpected11View(undefined, viewOptions));
  const ingestView =
    options.ingestView ?? ((viewOptions) => getExpected11IngestView(viewOptions));
  const saveUrls = options.saveUrls ?? saveExpected11TourUrls;
  const rebuildTour = options.rebuildTour ?? rebuildExpected11Tour;
  const toursForLeague =
    options.toursForLeague ??
    ((leagueSlug: string) => listExpected11Tours(resolveExpected11League(leagueSlug)));
  const matchIdsForTour =
    options.matchIdsForTour ??
    ((league: string, tour: number) => getExpected11TourMatchIds(league, tour));
  const actorEmail = options.actorEmail ?? defaultActorEmail;
  const authorizeAdmin = options.authorizeAdmin ?? defaultAuthorizeAdmin;
  const gazetteDir = options.gazetteDir ?? defaultExpected11GazettesDir();

  function scopedPayload(
    request: FastifyRequest,
    extra: Record<string, unknown> = {},
  ) {
    const email = actorEmail(request);
    const canEditUrls = isLiveDraftAdmin(email);
    const { leagueParam, tourParam } = queryScope(request);
    const league = leagueParam
      ? resolveExpected11League(leagueParam)
      : defaultExpected11League();
    const tours = toursForLeague(league.slug);
    const tour = resolveExpected11Tour(tourParam, tours);
    const ingest = ingestView({
      includeUrls: canEditUrls,
      league: league.slug,
      tour,
    });
    const matchIds =
      tour != null ? matchIdsForTour(league.slug, tour) : [];
    return {
      canEditUrls,
      league: {
        slug: league.slug,
        name: league.name,
        tmCompetition: league.tmCompetition,
      },
      tour,
      tours,
      ingest,
      ...view({
        narrativeMatchId:
          typeof (request.query as { matchId?: string }).matchId === "string" &&
          /^\d+$/.test((request.query as { matchId?: string }).matchId!)
            ? (request.query as { matchId?: string }).matchId
            : undefined,
        matchIds,
      }),
      gazette: expected11GazetteView(league.slug, tour, gazetteDir),
      ...extra,
    };
  }

  app.get("/api/expected11/gazette/:league/:tour", async (request, reply) => {
    const params = request.params as { league?: string; tour?: string };
    try {
      const league = resolveExpected11League(params.league);
      const tour = parseExpected11Tour(params.tour);
      const file = expected11GazetteFile(league.slug, tour, gazetteDir);
      if (!file) {
        return reply.code(404).send({ error: "gazette_not_found" });
      }
      const st = statSync(file);
      reply
        .type("application/pdf")
        .header("Content-Length", String(st.size))
        .header(
          "Content-Disposition",
          `inline; filename="${expected11GazetteFileName(league.slug, tour)}"`,
        )
        .header("Cache-Control", "public, max-age=86400, immutable");
      return reply.send(createReadStream(file));
    } catch (error) {
      return ingestError(error, request, reply);
    }
  });

  app.get("/api/expected11", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const { leagueParam } = queryScope(request);
    if (leagueParam) {
      try {
        resolveExpected11League(leagueParam);
      } catch (error) {
        return ingestError(error, request, reply);
      }
    }
    return scopedPayload(request);
  });

  function adminBodyScope(request: FastifyRequest) {
    const body = (request.body ?? {}) as {
      league?: unknown;
      tour?: unknown;
      urls?: unknown;
    };
    return body;
  }

  app.post("/api/expected11/urls", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    if (!authorizeAdmin(request, reply)) return;
    const body = adminBodyScope(request);
    try {
      const result = saveUrls({
        league: body.league,
        tour: body.tour,
        urls: body.urls,
      });
      const league = resolveExpected11League(body.league);
      const tour = Number(body.tour);
      return {
        canEditUrls: true,
        ingest: result.ingest,
        import: result.import,
        ...view({
          matchIds: matchIdsForTour(league.slug, tour),
        }),
      };
    } catch (error) {
      return ingestError(error, request, reply);
    }
  });

  app.post("/api/expected11/rebuild", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireSameOrigin(request, reply)) return;
    if (!authorizeAdmin(request, reply)) return;
    const body = adminBodyScope(request);
    try {
      const result = await rebuildTour({
        league: body.league,
        tour: body.tour,
        urls: body.urls,
      });
      const league = resolveExpected11League(body.league);
      const tour = Number(body.tour);
      return {
        canEditUrls: true,
        ingest: result.ingest,
        import: result.import,
        ...view({
          matchIds: matchIdsForTour(league.slug, tour),
        }),
      };
    } catch (error) {
      return ingestError(error, request, reply);
    }
  });

  app.post(
    "/api/expected11/import",
    { bodyLimit: MAX_EXPECTED11_IMPORT_BYTES },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const expectedToken = token();
      if (!expectedToken) {
        return reply.code(503).send({ error: "expected11_import_not_configured" });
      }
      if (!expected11TokenMatches(bearer(request.headers.authorization), expectedToken)) {
        return reply.code(401).send({ error: "invalid_expected11_import_token" });
      }
      try {
        const payload = normalizeExpected11Import(request.body);
        const scope = parseExpected11ImportScope(request.body);
        return importPayload(payload, scope);
      } catch (error) {
        return ingestError(error, request, reply);
      }
    },
  );
}
