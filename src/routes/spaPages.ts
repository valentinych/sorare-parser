import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const SPA_PAGES = [
  "clubs",
  "players",
  "matches",
  "live",
  "auctions",
  "tables",
  "xi",
  "sorare",
  "mapping",
  "premium",
  "league-one",
  "mantra-doma",
  "builder",
  "ref",
] as const;

export type SpaPage = (typeof SPA_PAGES)[number];

const PAGE_PATHS: Record<SpaPage, string> = {
  clubs: "/clubs",
  players: "/players",
  matches: "/matches",
  live: "/live",
  auctions: "/auctions",
  tables: "/tables",
  xi: "/xi",
  sorare: "/sorare",
  mapping: "/mapping",
  premium: "/premium",
  "league-one": "/league-one",
  "mantra-doma": "/mantra-doma",
  builder: "/builder",
  ref: "/ref",
};

const LEAGUE_PAGES = new Set<SpaPage>([
  "clubs",
  "players",
  "matches",
  "live",
  "xi",
  "builder",
]);

const STATUS_PAGES = new Set<SpaPage>(["clubs", "players", "matches", "xi", "builder", "ref"]);

const PAGE_TITLES: Record<SpaPage, string> = {
  clubs: "Клубы",
  players: "Игроки",
  matches: "Матчи",
  live: "Live",
  auctions: "Аукционы",
  tables: "Таблицы",
  xi: "Предикты XI",
  sorare: "Фейк Мопс",
  mapping: "Mapping",
  premium: "Premium",
  "league-one": "League One",
  "mantra-doma": "Mantra Дома",
  builder: "Squad Builder",
  ref: "Справочник",
};

const DIALOGS_BY_PAGE: Record<SpaPage, string[]> = {
  clubs: ["account", "club", "game"],
  players: ["account", "club", "game"],
  matches: ["account", "club", "game"],
  live: ["account", "live", "ideal-vs-real"],
  auctions: ["account"],
  tables: ["account", "ideal-vs-real"],
  xi: ["account"],
  sorare: ["account"],
  mapping: ["account"],
  premium: ["account"],
  "league-one": ["account"],
  "mantra-doma": ["account"],
  builder: ["account"],
  ref: ["account"],
};

let template = "";

export async function loadSpaTemplate(publicDir: string): Promise<string> {
  template = await readFile(path.join(publicDir, "index.html"), "utf8");
  return template;
}

function stripMarked(html: string, kind: string, id: string): string {
  const re = new RegExp(`<!--spa-${kind}:${id}-->[\\s\\S]*?<!--/spa-${kind}:${id}-->\\n?`, "g");
  return html.replace(re, "");
}

function keepMarked(html: string, kind: string, keep: Set<string>): string {
  return html.replace(
    new RegExp(`<!--spa-${kind}:([a-z0-9-]+)-->[\\s\\S]*?<!--/spa-${kind}:\\1-->\\n?`, "g"),
    (block, id) => (keep.has(id) ? block : ""),
  );
}

export function composeSpaPage(html: string, page: SpaPage): string {
  let out = keepMarked(html, "view", new Set([page]));
  out = keepMarked(out, "dialog", new Set(DIALOGS_BY_PAGE[page]));
  if (!LEAGUE_PAGES.has(page)) {
    out = stripMarked(out, "block", "league");
  }
  if (!STATUS_PAGES.has(page)) {
    out = out.replace(
      /<p class="status" id="status">Загрузка…<\/p>/,
      '<p class="status" id="status" hidden></p>',
    );
  }
  out = out.replace(/<body\b[^>]*>/, `<body data-page="${page}">`);
  out = out.replace(
    /<nav class="tabs" role="tablist">[\s\S]*?<\/nav>/,
    (nav) =>
      nav.replace(/<a class="tab"[^>]*data-view="([^"]+)"[^>]*>/g, (tag, view) => {
        const selected = view === page || (page === "clubs" && view === "clubs");
        return tag
          .replace(/aria-selected="(true|false)"/, `aria-selected="${selected ? "true" : "false"}"`)
          .replace(/aria-selected="true"/, selected ? `aria-selected="true"` : `aria-selected="false"`);
      }),
  );
  out = out.replace(
    /<script src="\/app\.js\?v=\d+" type="module"><\/script>/,
    '<script src="/boot.js?v=77" type="module"></script>',
  );
  out = out.replace(
    /<script src="\/boot\.js\?v=\d+" type="module"><\/script>/,
    '<script src="/boot.js?v=77" type="module"></script>',
  );
  const title = PAGE_TITLES[page];
  out = out.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${title} · Mantra Helper · Panenka</title>`,
  );
  if (page !== "clubs") {
    out = out.replace(/id="view-clubs"[^>]*data-active="true"/, 'id="view-clubs" class="view"');
  }
  const viewOpen = new RegExp(`(<section id="view-${page}" class="view")([^>]*)>`, "g");
  out = out.replace(viewOpen, (_, start, attrs) => {
    const cleaned = String(attrs)
      .replace(/\s+hidden/g, "")
      .replace(/\s+data-active="true"/g, "");
    return `${start}${cleaned} data-active="true">`;
  });
  return out;
}

export function isSpaReady(): boolean {
  return Boolean(template);
}

export async function sendSpaPage(reply: FastifyReply, page: SpaPage) {
  if (!template) {
    throw new Error("SPA template not loaded");
  }
  const html = composeSpaPage(template, page);
  reply.header("Cache-Control", "no-store");
  return reply.type("text/html; charset=utf-8").send(html);
}

export async function spaPageRoutes(
  app: FastifyInstance,
  options: { publicDir: string },
) {
  await loadSpaTemplate(options.publicDir);

  async function send(page: SpaPage) {
    return async (_request: FastifyRequest, reply: FastifyReply) => sendSpaPage(reply, page);
  }

  app.get("/", await send("clubs"));
  for (const page of SPA_PAGES) {
    if (page === "live") continue;
    app.get(PAGE_PATHS[page], await send(page));
  }
}
