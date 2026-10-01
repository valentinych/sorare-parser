import "dotenv/config";

function emailAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  apiFootballKey: process.env.API_FOOTBALL_KEY ?? "",
  leagueId: Number(process.env.LEAGUE_ID ?? 106),
  /** historical season used for strength (2025 = 2025/26) */
  season: Number(process.env.SEASON ?? 2025),
  /** prediction target season (2026 = 2026/27) */
  predictSeason: Number(process.env.PREDICT_SEASON ?? 2026),
  dbPath: process.env.DB_PATH ?? "data/app.db",
  publicUrl: process.env.PUBLIC_URL ?? "https://mantra.panenka.games",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  sorareApiKey: process.env.SORARE_API_KEY ?? "",
  sorareEmail: process.env.SORARE_EMAIL ?? "",
  sorarePasswordHash: process.env.SORARE_PASSWORD_HASH ?? "",
  sorareJwtAud: process.env.SORARE_JWT_AUD ?? "",
  expected11ImportToken: process.env.EXPECTED11_IMPORT_TOKEN ?? "",
  mantraAuctionImportToken: process.env.MANTRA_AUCTION_IMPORT_TOKEN ?? "",
  expected11PremiumEmails: emailAllowlist(
    process.env.EXPECTED11_PREMIUM_EMAILS,
  ),
  liveDraftEmails: emailAllowlist(process.env.LIVE_DRAFT_EMAILS),
  liveDraftAdminEmail: (
    process.env.LIVE_DRAFT_ADMIN_EMAIL ?? "aharodnik@gmail.com"
  )
    .trim()
    .toLocaleLowerCase(),
  sorarePollIntervalMs: Math.max(
    5 * 60_000,
    Number(process.env.SORARE_POLL_INTERVAL_MS ?? 30 * 60_000),
  ),
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI ??
    `${process.env.PUBLIC_URL ?? "https://mantra.panenka.games"}/auth/google/callback`,
  /** Summer preseason window (inclusive). PL friendlies often run into mid-August. */
  preseasonFrom: process.env.PRESEASON_FROM ?? "2026-06-01",
  preseasonTo: process.env.PRESEASON_TO ?? "2026-08-20",
};

export function hasExpected11PremiumAccess(email: string | null | undefined): boolean {
  if (hasLiveDraftAccess(email)) return true;
  return Boolean(
    email &&
      config.expected11PremiumEmails.has(email.trim().toLocaleLowerCase()),
  );
}

export function hasLiveDraftAccess(email: string | null | undefined): boolean {
  return Boolean(
    email && config.liveDraftEmails.has(email.trim().toLocaleLowerCase()),
  );
}

export function isLiveDraftAdmin(email: string | null | undefined): boolean {
  return Boolean(
    email && email.trim().toLocaleLowerCase() === config.liveDraftAdminEmail,
  );
}

export function hasApiFootballKey(): boolean {
  const key = config.apiFootballKey.trim();
  return Boolean(key) && key !== "your_api_sports_key_here";
}

export function requireApiKey(): string {
  if (!hasApiFootballKey()) {
    throw new Error("Set API_FOOTBALL_KEY in .env (copy from .env.example)");
  }
  return config.apiFootballKey;
}
