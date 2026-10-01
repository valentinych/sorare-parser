import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { MANTRA_AUCTION_SCHEMA } from "../domain/mantraAuctions.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  logo TEXT
);

CREATE TABLE IF NOT EXISTS season_teams (
  season INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  logo TEXT,
  league_id INTEGER,
  PRIMARY KEY (season, team_id)
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  age INTEGER,
  nationality TEXT,
  photo TEXT,
  position TEXT,
  team_id INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS fixtures (
  id INTEGER PRIMARY KEY,
  date TEXT,
  round TEXT,
  home_team_id INTEGER NOT NULL,
  away_team_id INTEGER NOT NULL,
  status TEXT,
  league_id INTEGER,
  season INTEGER,
  is_preseason INTEGER DEFAULT 0,
  home_goals INTEGER,
  away_goals INTEGER
);

CREATE TABLE IF NOT EXISTS lineup_appearances (
  fixture_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  position TEXT,
  grid TEXT,
  formation TEXT,
  is_starter INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (fixture_id, team_id, player_id)
);

CREATE TABLE IF NOT EXISTS player_season_stats (
  player_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  position TEXT,
  appearances INTEGER DEFAULT 0,
  lineups INTEGER DEFAULT 0,
  minutes INTEGER DEFAULT 0,
  goals INTEGER DEFAULT 0,
  assists INTEGER DEFAULT 0,
  rating REAL,
  PRIMARY KEY (player_id, team_id)
);

CREATE TABLE IF NOT EXISTS player_stats (
  season INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  position TEXT,
  appearances INTEGER DEFAULT 0,
  lineups INTEGER DEFAULT 0,
  minutes INTEGER DEFAULT 0,
  goals INTEGER DEFAULT 0,
  assists INTEGER DEFAULT 0,
  rating REAL,
  yellow_cards INTEGER DEFAULT 0,
  red_cards INTEGER DEFAULT 0,
  goals_conceded INTEGER DEFAULT 0,
  clean_sheets INTEGER DEFAULT 0,
  PRIMARY KEY (season, player_id, team_id)
);

CREATE TABLE IF NOT EXISTS squad_players (
  season INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  age INTEGER,
  number INTEGER,
  position TEXT,
  photo TEXT,
  PRIMARY KEY (season, team_id, player_id)
);

CREATE TABLE IF NOT EXISTS tm_club_map (
  af_team_id INTEGER PRIMARY KEY,
  tm_club_id TEXT NOT NULL,
  tm_name TEXT
);

CREATE TABLE IF NOT EXISTS player_values (
  af_player_id INTEGER,
  tm_player_id TEXT NOT NULL,
  team_id INTEGER,
  name TEXT NOT NULL,
  position TEXT,
  detail_role TEXT,
  detail_label TEXT,
  side_role TEXT,
  market_value_eur INTEGER,
  PRIMARY KEY (tm_player_id)
);

CREATE TABLE IF NOT EXISTS preseason_team_form (
  season INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  played INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  draws INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  gf INTEGER DEFAULT 0,
  ga INTEGER DEFAULT 0,
  form_score REAL DEFAULT 0,
  PRIMARY KEY (season, team_id)
);

CREATE TABLE IF NOT EXISTS mantra_players (
  id INTEGER PRIMARY KEY,
  fotmob_player_id INTEGER,
  name TEXT NOT NULL,
  first_name TEXT,
  full_name TEXT,
  positions_json TEXT,
  positions_ital_json TEXT,
  club_id INTEGER,
  club_name TEXT,
  club_code TEXT,
  club_logo TEXT,
  club_tm_url TEXT,
  avatar_path TEXT,
  base_score REAL,
  total_score REAL,
  appearances INTEGER,
  average_price REAL,
  teams_count INTEGER DEFAULT 0,
  leagues_json TEXT,
  tm_url TEXT,
  tm_price REAL,
  birth_date TEXT,
  age INTEGER,
  height INTEGER,
  nationality TEXT,
  shirt_number INTEGER,
  list_synced_at TEXT,
  profile_synced_at TEXT,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS mantra_leagues (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  division TEXT,
  division_id INTEGER,
  season_id INTEGER,
  status TEXT,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS mantra_fantasy_teams (
  id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL,
  tournament_id INTEGER,
  name TEXT NOT NULL,
  code TEXT,
  logo_path TEXT,
  user_id INTEGER,
  budget REAL,
  players_json TEXT NOT NULL DEFAULT '[]',
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS mantra_managers (
  id INTEGER PRIMARY KEY,
  nickname TEXT NOT NULL,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS mantra_table_rows (
  league_slug TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  manager_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  team_logo TEXT,
  league_name TEXT NOT NULL,
  flag TEXT,
  division TEXT NOT NULL,
  division_rank INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  wins REAL NOT NULL DEFAULT 0,
  draws REAL NOT NULL DEFAULT 0,
  loses REAL NOT NULL DEFAULT 0,
  gf REAL NOT NULL DEFAULT 0,
  ga REAL NOT NULL DEFAULT 0,
  gd REAL NOT NULL DEFAULT 0,
  points REAL NOT NULL DEFAULT 0,
  ts REAL NOT NULL DEFAULT 0,
  ideal_ts REAL,
  ideal_pct REAL,
  i_gf REAL,
  i_ga REAL,
  i_gd REAL,
  i_pts REAL,
  form_json TEXT,
  ideal_rank INTEGER,
  ideal_games INTEGER,
  ideal_wins INTEGER,
  ideal_draws INTEGER,
  ideal_loses INTEGER,
  ideal_avg_ts REAL,
  ideal_form_json TEXT,
  fetched_at TEXT,
  PRIMARY KEY (league_slug, team_id)
);
CREATE INDEX IF NOT EXISTS idx_mantra_table_rows_manager
  ON mantra_table_rows(manager_id);

CREATE TABLE IF NOT EXISTS mantra_gw_player_scores (
  slug TEXT NOT NULL,
  round TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  total REAL NOT NULL,
  base REAL,
  PRIMARY KEY (slug, round, player_id)
);

CREATE TABLE IF NOT EXISTS app_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  picture_url TEXT,
  mantra_manager_id INTEGER,
  pin_my_leagues INTEGER NOT NULL DEFAULT 0,
  locale TEXT NOT NULL DEFAULT 'ru',
  time_zone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at
  ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS saved_squads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  fantasy_team_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  formation TEXT NOT NULL,
  assignments_json TEXT NOT NULL,
  alternatives_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
  UNIQUE (user_id, fantasy_team_id, name)
);

CREATE INDEX IF NOT EXISTS idx_saved_squads_user_team
  ON saved_squads(user_id, fantasy_team_id);

CREATE TABLE IF NOT EXISTS api_cache (
  key TEXT PRIMARY KEY,
  body_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS computed_cache (
  key TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  body_json TEXT NOT NULL,
  built_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sorare_cache (
  key TEXT PRIMARY KEY,
  body_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sorare_team_links (
  league_id INTEGER NOT NULL,
  sorare_slug TEXT NOT NULL,
  sorare_name TEXT NOT NULL,
  af_team_id INTEGER,
  af_team_name TEXT,
  mapped_at TEXT,
  PRIMARY KEY (league_id, sorare_slug),
  UNIQUE (league_id, af_team_id)
);

CREATE TABLE IF NOT EXISTS sorare_player_links (
  league_id INTEGER NOT NULL,
  sorare_slug TEXT NOT NULL,
  sorare_name TEXT NOT NULL,
  sorare_team_slug TEXT NOT NULL,
  af_player_id INTEGER,
  af_team_id INTEGER,
  mapped_at TEXT,
  PRIMARY KEY (league_id, sorare_slug),
  UNIQUE (league_id, af_player_id)
);

CREATE TABLE IF NOT EXISTS sorare_player_predictions (
  sorare_game_id TEXT NOT NULL,
  league_id INTEGER NOT NULL,
  kickoff TEXT NOT NULL,
  sorare_player_slug TEXT NOT NULL,
  af_player_id INTEGER,
  af_team_id INTEGER,
  starter_prob REAL NOT NULL,
  substitute_prob REAL NOT NULL,
  non_playing_prob REAL NOT NULL,
  reliability TEXT,
  provider_url TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (sorare_game_id, sorare_player_slug)
);

CREATE INDEX IF NOT EXISTS idx_sorare_predictions_af_player
  ON sorare_player_predictions(league_id, af_player_id, kickoff);

CREATE TABLE IF NOT EXISTS sorare_import_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sorare_import_codes_expiry
  ON sorare_import_codes(expires_at);

CREATE TABLE IF NOT EXISTS user_sorare_projections (
  user_id INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  player_key TEXT NOT NULL,
  client_card_id TEXT,
  player_id TEXT,
  player_slug TEXT,
  team_slug TEXT,
  projected_score REAL,
  starting_percentage REAL,
  reliability TEXT,
  team_win_odds REAL,
  player_expected_goals REAL,
  team_clean_sheet_odds REAL,
  card_position TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, game_id, player_key),
  FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sorare_projections_game
  ON user_sorare_projections(user_id, game_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_user_sorare_projections_expiry
  ON user_sorare_projections(expires_at);

CREATE TABLE IF NOT EXISTS expected11_matches (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  home_team TEXT,
  away_team TEXT,
  formations_json TEXT NOT NULL DEFAULT '[]',
  extracted_at TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expected11_teams (
  match_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('home', 'away')),
  source_name TEXT NOT NULL,
  logo_url TEXT,
  notes_json TEXT NOT NULL DEFAULT '{}',
  author TEXT,
  mantra_club_id INTEGER,
  mantra_club_name TEXT,
  link_status TEXT NOT NULL CHECK (link_status IN ('linked', 'unmatched', 'ambiguous')),
  PRIMARY KEY (match_id, side),
  FOREIGN KEY (match_id) REFERENCES expected11_matches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS expected11_predictions (
  match_id TEXT NOT NULL,
  team_side TEXT NOT NULL CHECK (team_side IN ('home', 'away')),
  lineup_group TEXT NOT NULL CHECK (lineup_group IN ('starting', 'bench', 'out')),
  sort_order INTEGER NOT NULL,
  source_name TEXT NOT NULL,
  displayed_percentage REAL,
  player_path TEXT,
  mantra_player_id INTEGER,
  link_status TEXT NOT NULL CHECK (link_status IN ('linked', 'unmatched', 'ambiguous')),
  PRIMARY KEY (match_id, team_side, lineup_group, sort_order),
  FOREIGN KEY (match_id, team_side) REFERENCES expected11_teams(match_id, side) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_expected11_predictions_mantra_player
  ON expected11_predictions(mantra_player_id);

CREATE TABLE IF NOT EXISTS expected11_manual_mappings (
  source_name_normalized TEXT NOT NULL,
  mantra_club_id INTEGER NOT NULL,
  mantra_player_id INTEGER NOT NULL,
  mapped_by_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_name_normalized, mantra_club_id),
  FOREIGN KEY (mapped_by_user_id) REFERENCES app_users(id)
);

CREATE INDEX IF NOT EXISTS idx_expected11_manual_mappings_player
  ON expected11_manual_mappings(mantra_player_id);

CREATE TABLE IF NOT EXISTS expected11_ingest_sources (
  scope TEXT PRIMARY KEY CHECK (scope IN ('tour', 'championship')),
  source_url TEXT NOT NULL,
  extracted_at TEXT,
  imported_at TEXT,
  match_ids_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS expected11_ingest_tours (
  league TEXT NOT NULL,
  tour INTEGER NOT NULL,
  urls_json TEXT NOT NULL DEFAULT '[]',
  extracted_at TEXT,
  imported_at TEXT,
  match_ids_json TEXT NOT NULL DEFAULT '[]',
  skipped_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  PRIMARY KEY (league, tour)
);

CREATE TABLE IF NOT EXISTS serie_a_lineup_snapshots (
  source TEXT PRIMARY KEY CHECK (source IN ('fantacalcio', 'sorareinside')),
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS serie_a_lineup_predictions (
  source TEXT NOT NULL CHECK (source IN ('fantacalcio', 'sorareinside')),
  club_key TEXT NOT NULL,
  source_club TEXT NOT NULL,
  source_player TEXT NOT NULL,
  lineup_group TEXT NOT NULL CHECK (lineup_group IN ('starting', 'bench', 'unknown')),
  sort_order INTEGER NOT NULL,
  displayed_percentage REAL,
  raw_label TEXT,
  slot TEXT,
  af_player_id INTEGER,
  af_team_id INTEGER,
  mantra_player_id INTEGER,
  link_status TEXT NOT NULL CHECK (link_status IN ('linked', 'unmatched', 'ambiguous')),
  PRIMARY KEY (source, club_key, source_player),
  FOREIGN KEY (source) REFERENCES serie_a_lineup_snapshots(source) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_serie_a_lineup_af_player
  ON serie_a_lineup_predictions(af_player_id);

CREATE TABLE IF NOT EXISTS footmops_snapshots (
  league TEXT NOT NULL,
  tour INTEGER NOT NULL,
  source TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league, tour)
);

CREATE TABLE IF NOT EXISTS footmops_predictions (
  league TEXT NOT NULL,
  tour INTEGER NOT NULL,
  club_key TEXT NOT NULL,
  source_club TEXT NOT NULL,
  source_player TEXT NOT NULL,
  lineup_group TEXT NOT NULL CHECK (lineup_group IN ('starting', 'bench', 'out')),
  displayed_percentage REAL,
  mantra_player_id INTEGER,
  link_status TEXT NOT NULL CHECK (link_status IN ('linked', 'unmatched', 'ambiguous')),
  PRIMARY KEY (league, tour, club_key, source_player)
);

CREATE INDEX IF NOT EXISTS idx_footmops_predictions_player
  ON footmops_predictions(mantra_player_id);

CREATE TABLE IF NOT EXISTS tm_competitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  season_id INTEGER,
  country_id INTEGER,
  total_market_value REAL,
  game_day_count INTEGER,
  closest_game_day INTEGER,
  is_ongoing INTEGER,
  logo_url TEXT,
  relative_url TEXT,
  raw_json TEXT,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS tm_clubs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  abbreviation TEXT,
  country_id INTEGER,
  primary_competition_id TEXT,
  city TEXT,
  crest_url TEXT,
  relative_url TEXT,
  squad_size INTEGER,
  average_age REAL,
  market_value REAL,
  average_market_value REAL,
  acquisition_value REAL,
  top18_market_value REAL,
  raw_json TEXT,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS tm_competition_clubs (
  competition_id TEXT NOT NULL,
  club_id TEXT NOT NULL,
  ranking INTEGER,
  points INTEGER,
  played INTEGER,
  wins INTEGER,
  draws INTEGER,
  losses INTEGER,
  goals_for INTEGER,
  goals_against INTEGER,
  goal_diff INTEGER,
  PRIMARY KEY (competition_id, club_id)
);

CREATE TABLE IF NOT EXISTS tm_squad_players (
  club_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  shirt_number INTEGER,
  is_captain INTEGER DEFAULT 0,
  assignment_type TEXT,
  name TEXT,
  age INTEGER,
  date_of_birth TEXT,
  height REAL,
  preferred_foot TEXT,
  position TEXT,
  detail_role TEXT,
  detail_label TEXT,
  side_role TEXT,
  market_value_eur INTEGER,
  market_value_previous INTEGER,
  market_value_highest INTEGER,
  contract_until TEXT,
  place_of_birth TEXT,
  country_of_birth_id INTEGER,
  nationality_id INTEGER,
  second_nationality_id INTEGER,
  nationality TEXT,
  gender TEXT,
  agency_name TEXT,
  portrait_url TEXT,
  relative_url TEXT,
  raw_json TEXT,
  synced_at TEXT,
  PRIMARY KEY (club_id, player_id)
);

CREATE TABLE IF NOT EXISTS tm_ref (
  category TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT,
  raw_json TEXT,
  PRIMARY KEY (category, id)
);

CREATE TABLE IF NOT EXISTS tm_games (
  id TEXT PRIMARY KEY,
  competition_id TEXT,
  season_id INTEGER,
  game_day INTEGER,
  date_utc TEXT,
  home_club_id TEXT,
  away_club_id TEXT,
  home_score INTEGER,
  away_score INTEGER,
  is_finished INTEGER,
  is_live INTEGER,
  home_tactic TEXT,
  away_tactic TEXT,
  relative_url TEXT,
  raw_json TEXT,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS tm_game_lineup (
  game_id TEXT NOT NULL,
  club_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  is_starter INTEGER DEFAULT 1,
  shirt_number INTEGER,
  is_captain INTEGER DEFAULT 0,
  position_label TEXT,
  age_at_game REAL,
  market_value_eur INTEGER,
  PRIMARY KEY (game_id, club_id, player_id, is_starter)
);

CREATE TABLE IF NOT EXISTS tm_game_events (
  game_id TEXT NOT NULL,
  club_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  minute INTEGER,
  added_time INTEGER,
  action TEXT,
  reason TEXT,
  active_player_id TEXT,
  passive_player_id TEXT,
  seq INTEGER NOT NULL,
  PRIMARY KEY (game_id, club_id, event_type, seq)
);

CREATE TABLE IF NOT EXISTS manager_formation_summary (
  team_id INTEGER PRIMARY KEY,
  coach_id INTEGER NOT NULL,
  coach_name TEXT,
  preferred_formation TEXT NOT NULL,
  preferred_count INTEGER NOT NULL,
  sample_size INTEGER NOT NULL,
  breakdown_json TEXT,
  source TEXT NOT NULL DEFAULT 'api-football',
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS manager_formation_samples (
  team_id INTEGER NOT NULL,
  coach_id INTEGER NOT NULL,
  fixture_id INTEGER NOT NULL,
  sample_team_id INTEGER NOT NULL,
  formation TEXT NOT NULL,
  date_utc TEXT,
  PRIMARY KEY (team_id, fixture_id)
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS live_draft (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  configured INTEGER NOT NULL DEFAULT 0,
  league TEXT NOT NULL DEFAULT 'premier-league',
  status TEXT NOT NULL DEFAULT 'unconfigured',
  participants_json TEXT NOT NULL DEFAULT '[]',
  rules_json TEXT,
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO live_draft (id) VALUES (1);
`;

let db: Database.Database | null = null;

export function migrateFootmopsPredictions(database: Database.Database): void {
  const table = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'footmops_predictions'`,
    )
    .get() as { sql: string } | undefined;
  if (!table) return;
  const allowsOut = table.sql.includes("'out'");
  const pctNotNull = /displayed_percentage REAL NOT NULL/i.test(table.sql);
  if (allowsOut && !pctNotNull) return;

  database.pragma("foreign_keys = OFF");
  try {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE footmops_predictions_next (
        league TEXT NOT NULL,
        tour INTEGER NOT NULL,
        club_key TEXT NOT NULL,
        source_club TEXT NOT NULL,
        source_player TEXT NOT NULL,
        lineup_group TEXT NOT NULL CHECK (lineup_group IN ('starting', 'bench', 'out')),
        displayed_percentage REAL,
        mantra_player_id INTEGER,
        link_status TEXT NOT NULL CHECK (link_status IN ('linked', 'unmatched', 'ambiguous')),
        PRIMARY KEY (league, tour, club_key, source_player)
      );
      INSERT INTO footmops_predictions_next
        SELECT league, tour, club_key, source_club, source_player, lineup_group,
               displayed_percentage, mantra_player_id, link_status
        FROM footmops_predictions;
      DROP TABLE footmops_predictions;
      ALTER TABLE footmops_predictions_next RENAME TO footmops_predictions;
      CREATE INDEX IF NOT EXISTS idx_footmops_predictions_player
        ON footmops_predictions(mantra_player_id);
      COMMIT;
    `);
  } catch (error) {
    database.exec(`ROLLBACK`);
    throw error;
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

export function migrateMantraAuctionJobs(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(mantra_auction_jobs)`)
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("failed_count")) {
    database.exec(
      `ALTER TABLE mantra_auction_jobs ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!names.has("last_retry_at")) {
    database.exec(`ALTER TABLE mantra_auction_jobs ADD COLUMN last_retry_at TEXT`);
  }

  const table = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mantra_auction_jobs'`,
    )
    .get() as { sql: string } | undefined;
  if (table?.sql.includes("'partial'")) return;

  database.pragma("foreign_keys = OFF");
  try {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE mantra_auction_jobs_next (
        scope_key TEXT PRIMARY KEY,
        scope_name TEXT NOT NULL,
        mantra_league_ids_json TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending','discovering','running','partial','complete','error')
        ),
        phase TEXT NOT NULL,
        completed_units INTEGER NOT NULL DEFAULT 0,
        total_units INTEGER,
        percent REAL,
        last_error TEXT,
        request_starts INTEGER NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        responses_429 INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        last_retry_at TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO mantra_auction_jobs_next
        SELECT scope_key, scope_name, mantra_league_ids_json, run_id, status, phase,
               completed_units, total_units, percent, last_error, request_starts,
               retries, responses_429, failed_count, last_retry_at, started_at,
               updated_at, completed_at
        FROM mantra_auction_jobs;
      DROP TABLE mantra_auction_jobs;
      ALTER TABLE mantra_auction_jobs_next RENAME TO mantra_auction_jobs;
      COMMIT;
    `);
  } catch (error) {
    database.exec(`ROLLBACK`);
    throw error;
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

function migrate(database: Database.Database): void {
  migrateMantraAuctionJobs(database);
  migrateFootmopsPredictions(database);

  // Remove the retired server-side Companion token flow and any stored secrets.
  database.exec(`
    DROP TABLE IF EXISTS user_sorare_inside_cache;
    DROP TABLE IF EXISTS user_sorare_inside;
  `);

  const appUserCols = database.prepare(`PRAGMA table_info(app_users)`).all() as Array<{ name: string }>;
  const appUserNames = new Set(appUserCols.map((column) => column.name));
  if (!appUserNames.has("locale")) {
    database.exec(`ALTER TABLE app_users ADD COLUMN locale TEXT NOT NULL DEFAULT 'ru'`);
  }
  if (!appUserNames.has("time_zone")) {
    database.exec(`ALTER TABLE app_users ADD COLUMN time_zone TEXT`);
  }
  if (!appUserNames.has("pin_my_leagues")) {
    database.exec(
      `ALTER TABLE app_users ADD COLUMN pin_my_leagues INTEGER NOT NULL DEFAULT 0`,
    );
  }

  const savedSquadCols = database.prepare(`PRAGMA table_info(saved_squads)`).all() as Array<{ name: string }>;
  if (
    savedSquadCols.length > 0 &&
    !savedSquadCols.some((column) => column.name === "alternatives_json")
  ) {
    database.exec(
      `ALTER TABLE saved_squads ADD COLUMN alternatives_json TEXT NOT NULL DEFAULT '{}'`,
    );
  }

  const seasonTeamCols = database.prepare(`PRAGMA table_info(season_teams)`).all() as Array<{ name: string }>;
  const seasonTeamNames = new Set(seasonTeamCols.map((c) => c.name));
  if (!seasonTeamNames.has("league_id")) {
    database.exec(`ALTER TABLE season_teams ADD COLUMN league_id INTEGER`);
    // Existing rows were synced for Ekstraklasa (106)
    database.exec(`UPDATE season_teams SET league_id = 106 WHERE league_id IS NULL`);
  }

  const fixtureCols = database.prepare(`PRAGMA table_info(fixtures)`).all() as Array<{ name: string }>;
  const fixtureNames = new Set(fixtureCols.map((c) => c.name));
  const fixtureAlters: string[] = [];
  if (!fixtureNames.has("league_id")) fixtureAlters.push(`ALTER TABLE fixtures ADD COLUMN league_id INTEGER`);
  if (!fixtureNames.has("season")) fixtureAlters.push(`ALTER TABLE fixtures ADD COLUMN season INTEGER`);
  if (!fixtureNames.has("is_preseason")) fixtureAlters.push(`ALTER TABLE fixtures ADD COLUMN is_preseason INTEGER DEFAULT 0`);
  if (!fixtureNames.has("home_goals")) fixtureAlters.push(`ALTER TABLE fixtures ADD COLUMN home_goals INTEGER`);
  if (!fixtureNames.has("away_goals")) fixtureAlters.push(`ALTER TABLE fixtures ADD COLUMN away_goals INTEGER`);
  for (const sql of fixtureAlters) database.exec(sql);

  const valueCols = database.prepare(`PRAGMA table_info(player_values)`).all() as Array<{ name: string }>;
  const valueNames = new Set(valueCols.map((c) => c.name));
  if (!valueNames.has("detail_role")) database.exec(`ALTER TABLE player_values ADD COLUMN detail_role TEXT`);
  if (!valueNames.has("detail_label")) database.exec(`ALTER TABLE player_values ADD COLUMN detail_label TEXT`);
  if (!valueNames.has("side_role")) database.exec(`ALTER TABLE player_values ADD COLUMN side_role TEXT`);

  const mantraCols = database.prepare(`PRAGMA table_info(mantra_players)`).all() as Array<{ name: string }>;
  const mantraNames = new Set(mantraCols.map((c) => c.name));
  if (!mantraNames.has("teams_count")) database.exec(`ALTER TABLE mantra_players ADD COLUMN teams_count INTEGER DEFAULT 0`);
  if (!mantraNames.has("leagues_json")) database.exec(`ALTER TABLE mantra_players ADD COLUMN leagues_json TEXT`);
  if (!mantraNames.has("tournament_id")) {
    database.exec(`ALTER TABLE mantra_players ADD COLUMN tournament_id INTEGER`);
    database.exec(`UPDATE mantra_players SET tournament_id = 18 WHERE tournament_id IS NULL`);
  }
  if (!mantraNames.has("fotmob_player_id")) {
    database.exec(`ALTER TABLE mantra_players ADD COLUMN fotmob_player_id INTEGER`);
  }
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_mantra_players_fotmob_player_id
     ON mantra_players(fotmob_player_id)
     WHERE fotmob_player_id IS NOT NULL`,
  );

  const mantraLeagueCols = database.prepare(`PRAGMA table_info(mantra_leagues)`).all() as Array<{ name: string }>;
  const mantraLeagueNames = new Set(mantraLeagueCols.map((c) => c.name));
  if (!mantraLeagueNames.has("tournament_id")) {
    database.exec(`ALTER TABLE mantra_leagues ADD COLUMN tournament_id INTEGER`);
    database.exec(`UPDATE mantra_leagues SET tournament_id = 18 WHERE tournament_id IS NULL`);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS mantra_fantasy_teams (
      id INTEGER PRIMARY KEY,
      league_id INTEGER NOT NULL,
      tournament_id INTEGER,
      name TEXT NOT NULL,
      code TEXT,
      logo_path TEXT,
      user_id INTEGER,
      budget REAL,
      players_json TEXT NOT NULL DEFAULT '[]',
      synced_at TEXT
    )
  `);

  const statsCols = database.prepare(`PRAGMA table_info(player_stats)`).all() as Array<{ name: string }>;
  const statsNames = new Set(statsCols.map((c) => c.name));
  if (!statsNames.has("yellow_cards")) database.exec(`ALTER TABLE player_stats ADD COLUMN yellow_cards INTEGER DEFAULT 0`);
  if (!statsNames.has("red_cards")) database.exec(`ALTER TABLE player_stats ADD COLUMN red_cards INTEGER DEFAULT 0`);
  if (!statsNames.has("goals_conceded")) database.exec(`ALTER TABLE player_stats ADD COLUMN goals_conceded INTEGER DEFAULT 0`);
  if (!statsNames.has("clean_sheets")) database.exec(`ALTER TABLE player_stats ADD COLUMN clean_sheets INTEGER DEFAULT 0`);

  database.exec(`
    CREATE TABLE IF NOT EXISTS player_comp_stats (
      season INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      league_id INTEGER NOT NULL,
      league_name TEXT,
      team_name TEXT,
      position TEXT,
      appearances INTEGER DEFAULT 0,
      lineups INTEGER DEFAULT 0,
      minutes INTEGER DEFAULT 0,
      goals INTEGER DEFAULT 0,
      assists INTEGER DEFAULT 0,
      rating REAL,
      yellow_cards INTEGER DEFAULT 0,
      red_cards INTEGER DEFAULT 0,
      goals_conceded INTEGER DEFAULT 0,
      clean_sheets INTEGER DEFAULT 0,
      shots_total INTEGER,
      shots_on INTEGER,
      passes_total INTEGER,
      key_passes INTEGER,
      pass_accuracy INTEGER,
      tackles_total INTEGER,
      blocks INTEGER,
      interceptions INTEGER,
      dribbles_attempts INTEGER,
      dribbles_success INTEGER,
      fouls_drawn INTEGER,
      fouls_committed INTEGER,
      pen_scored INTEGER,
      pen_missed INTEGER,
      saves INTEGER,
      PRIMARY KEY (season, player_id, team_id, league_id)
    )
  `);

  // One-time backfill: domestic rows already in player_stats (league via season_teams).
  const compCount = (
    database.prepare(`SELECT COUNT(*) AS n FROM player_comp_stats`).get() as { n: number }
  ).n;
  if (compCount === 0) {
    database.exec(`
      INSERT OR IGNORE INTO player_comp_stats
        (season, player_id, team_id, league_id, league_name, team_name, position,
         appearances, lineups, minutes, goals, assists, rating,
         yellow_cards, red_cards, goals_conceded, clean_sheets)
      SELECT
        ps.season, ps.player_id, ps.team_id,
        COALESCE(st.league_id, 0),
        NULL,
        t.name,
        ps.position,
        ps.appearances, ps.lineups, ps.minutes, ps.goals, ps.assists, ps.rating,
        COALESCE(ps.yellow_cards, 0), COALESCE(ps.red_cards, 0),
        COALESCE(ps.goals_conceded, 0), COALESCE(ps.clean_sheets, 0)
      FROM player_stats ps
      LEFT JOIN season_teams st ON st.team_id = ps.team_id AND st.season = ps.season
      LEFT JOIN teams t ON t.id = ps.team_id
      WHERE COALESCE(st.league_id, 0) != 0
    `);
  }

  // Fill gaps when season_teams for stats season is incomplete (e.g. EK only in predictSeason).
  const gapKey = "player_comp_stats_gapfill_v1";
  const gapDone = database.prepare(`SELECT value FROM sync_meta WHERE key = ?`).get(gapKey) as
    | { value: string }
    | undefined;
  if (!gapDone) {
    const rows = database
      .prepare(
        `SELECT ps.season, ps.player_id, ps.team_id, ps.position,
                ps.appearances, ps.lineups, ps.minutes, ps.goals, ps.assists, ps.rating,
                COALESCE(ps.yellow_cards, 0) AS yellow_cards,
                COALESCE(ps.red_cards, 0) AS red_cards,
                COALESCE(ps.goals_conceded, 0) AS goals_conceded,
                COALESCE(ps.clean_sheets, 0) AS clean_sheets,
                t.name AS team_name
         FROM player_stats ps
         LEFT JOIN teams t ON t.id = ps.team_id`,
      )
      .all() as Array<{
      season: number;
      player_id: number;
      team_id: number;
      position: string | null;
      appearances: number | null;
      lineups: number | null;
      minutes: number | null;
      goals: number | null;
      assists: number | null;
      rating: number | null;
      yellow_cards: number;
      red_cards: number;
      goals_conceded: number;
      clean_sheets: number;
      team_name: string | null;
    }>;
    const leagueFor = database.prepare(
      `SELECT league_id FROM season_teams
       WHERE team_id = ?
       ORDER BY ABS(season - ?) ASC
       LIMIT 1`,
    );
    const upsert = database.prepare(
      `INSERT OR IGNORE INTO player_comp_stats
         (season, player_id, team_id, league_id, league_name, team_name, position,
          appearances, lineups, minutes, goals, assists, rating,
          yellow_cards, red_cards, goals_conceded, clean_sheets)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = database.transaction(() => {
      for (const r of rows) {
        const hit = leagueFor.get(r.team_id, r.season) as { league_id: number } | undefined;
        if (!hit?.league_id) continue;
        upsert.run(
          r.season,
          r.player_id,
          r.team_id,
          hit.league_id,
          r.team_name,
          r.position,
          r.appearances,
          r.lineups,
          r.minutes,
          r.goals,
          r.assists,
          r.rating,
          r.yellow_cards,
          r.red_cards,
          r.goals_conceded,
          r.clean_sheets,
        );
      }
    });
    tx();
    database
      .prepare(
        `INSERT INTO sync_meta (key, value, updated_at) VALUES (?, '1', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
      )
      .run(gapKey);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS player_tm_perf (
      season INTEGER NOT NULL,
      tm_player_id TEXT NOT NULL,
      af_player_id INTEGER,
      appearances INTEGER DEFAULT 0,
      lineups INTEGER DEFAULT 0,
      goals INTEGER DEFAULT 0,
      assists INTEGER DEFAULT 0,
      yellow_cards INTEGER DEFAULT 0,
      red_cards INTEGER DEFAULT 0,
      clean_sheets INTEGER DEFAULT 0,
      source TEXT DEFAULT 'tm_games',
      synced_at TEXT,
      PRIMARY KEY (season, tm_player_id)
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS fixture_odds (
      fixture_id INTEGER PRIMARY KEY,
      league_id INTEGER,
      season INTEGER,
      kickoff TEXT,
      home_odd REAL,
      draw_odd REAL,
      away_odd REAL,
      bookmaker TEXT,
      home_win_prob REAL,
      draw_prob REAL,
      away_win_prob REAL,
      home_cs_odd REAL,
      away_cs_odd REAL,
      home_cs_prob REAL,
      away_cs_prob REAL,
      home_score_odd REAL,
      away_score_odd REAL,
      home_score_prob REAL,
      away_score_prob REAL,
      popular_score TEXT,
      top_scores TEXT,
      anytime_scorers TEXT,
      synced_at TEXT
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS fotmob_matches (
      id INTEGER PRIMARY KEY,
      league_id INTEGER,
      round TEXT,
      round_name TEXT,
      kickoff TEXT,
      home_id INTEGER,
      home_name TEXT,
      away_id INTEGER,
      away_name TEXT,
      score_home INTEGER,
      score_away INTEGER,
      status_short TEXT,
      phase TEXT,
      page_url TEXT,
      potm_player_id INTEGER,
      potm_name TEXT,
      potm_rating REAL,
      details_synced_at TEXT,
      list_synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS fotmob_match_players (
      match_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      name TEXT,
      team_id INTEGER,
      team_name TEXT,
      is_home INTEGER,
      shirt_number TEXT,
      position_id INTEGER,
      rating REAL,
      starter INTEGER,
      minutes INTEGER,
      goals INTEGER,
      assists INTEGER,
      yellow_cards INTEGER,
      red_cards INTEGER,
      own_goals INTEGER,
      saves INTEGER,
      goals_conceded INTEGER,
      penalties_won INTEGER,
      penalties_conceded INTEGER,
      penalties_scored INTEGER,
      penalties_missed INTEGER,
      penalties_saved INTEGER,
      PRIMARY KEY (match_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS fotmob_match_events (
      match_id INTEGER NOT NULL,
      event_idx INTEGER NOT NULL,
      time INTEGER,
      overload_time INTEGER,
      type TEXT,
      is_home INTEGER,
      player_id INTEGER,
      player_name TEXT,
      card TEXT,
      home_score INTEGER,
      away_score INTEGER,
      raw_json TEXT,
      PRIMARY KEY (match_id, event_idx)
    );
  `);

  const squadCols = database.prepare(`PRAGMA table_info(tm_squad_players)`).all() as Array<{ name: string }>;
  if (squadCols.length > 0) {
    const names = new Set(squadCols.map((c) => c.name));
    const alters: Array<[string, string]> = [
      ["market_value_previous", "INTEGER"],
      ["market_value_highest", "INTEGER"],
      ["place_of_birth", "TEXT"],
      ["country_of_birth_id", "INTEGER"],
      ["nationality_id", "INTEGER"],
      ["second_nationality_id", "INTEGER"],
      ["nationality", "TEXT"],
      ["gender", "TEXT"],
      ["agency_name", "TEXT"],
    ];
    for (const [col, typ] of alters) {
      if (!names.has(col)) database.exec(`ALTER TABLE tm_squad_players ADD COLUMN ${col} ${typ}`);
    }
  }

  const fmPlayerCols = database
    .prepare(`PRAGMA table_info(fotmob_match_players)`)
    .all() as Array<{ name: string }>;
  if (fmPlayerCols.length > 0) {
    const names = new Set(fmPlayerCols.map((c) => c.name));
    for (const [col, typ] of [
      ["minutes", "INTEGER"],
      ["goals", "INTEGER"],
      ["assists", "INTEGER"],
      ["yellow_cards", "INTEGER"],
      ["red_cards", "INTEGER"],
      ["own_goals", "INTEGER"],
      ["saves", "INTEGER"],
      ["goals_conceded", "INTEGER"],
      ["penalties_won", "INTEGER"],
      ["penalties_conceded", "INTEGER"],
      ["penalties_scored", "INTEGER"],
      ["penalties_missed", "INTEGER"],
      ["penalties_saved", "INTEGER"],
    ] as Array<[string, string]>) {
      if (!names.has(col)) database.exec(`ALTER TABLE fotmob_match_players ADD COLUMN ${col} ${typ}`);
    }
  }

  const oddsCols = database
    .prepare(`PRAGMA table_info(fixture_odds)`)
    .all() as Array<{ name: string }>;
  if (oddsCols.length > 0) {
    const names = new Set(oddsCols.map((c) => c.name));
    for (const [col, typ] of [
      ["home_cs_odd", "REAL"],
      ["away_cs_odd", "REAL"],
      ["home_cs_prob", "REAL"],
      ["away_cs_prob", "REAL"],
      ["home_score_odd", "REAL"],
      ["away_score_odd", "REAL"],
      ["home_score_prob", "REAL"],
      ["away_score_prob", "REAL"],
      ["popular_score", "TEXT"],
      ["top_scores", "TEXT"],
      ["anytime_scorers", "TEXT"],
    ] as Array<[string, string]>) {
      if (!names.has(col)) database.exec(`ALTER TABLE fixture_odds ADD COLUMN ${col} ${typ}`);
    }
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS live_auction_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL,
      nominator_email TEXT NOT NULL,
      high_bid INTEGER NOT NULL,
      high_bidder_email TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','sold')),
      last_bid_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_auction_bids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_live_auction_bids_lot ON live_auction_bids(lot_id);
    CREATE TABLE IF NOT EXISTS live_auction_awards (
      player_id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      lot_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_auction_folds (
      lot_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (lot_id, email)
    );
    CREATE TABLE IF NOT EXISTS league_one_mantra_positions (
      tm_player_id TEXT NOT NULL,
      position TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tm_player_id, position)
    );
    CREATE TABLE IF NOT EXISTS league_one_player_mappings (
      tm_player_id TEXT PRIMARY KEY,
      fotmob_player_id INTEGER NOT NULL UNIQUE,
      mapped_by_user_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mantra_doma_applications (
      user_id INTEGER PRIMARY KEY,
      team_name TEXT NOT NULL,
      want_regular_auction INTEGER NOT NULL DEFAULT 0,
      want_live_auction INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS mantra_managers (
      id INTEGER PRIMARY KEY,
      nickname TEXT NOT NULL,
      synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS mantra_table_rows (
      league_slug TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      manager_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      team_logo TEXT,
      league_name TEXT NOT NULL,
      flag TEXT,
      division TEXT NOT NULL,
      division_rank INTEGER NOT NULL DEFAULT 0,
      games INTEGER NOT NULL DEFAULT 0,
      wins REAL NOT NULL DEFAULT 0,
      draws REAL NOT NULL DEFAULT 0,
      loses REAL NOT NULL DEFAULT 0,
      gf REAL NOT NULL DEFAULT 0,
      ga REAL NOT NULL DEFAULT 0,
      gd REAL NOT NULL DEFAULT 0,
      points REAL NOT NULL DEFAULT 0,
      ts REAL NOT NULL DEFAULT 0,
      ideal_ts REAL,
      ideal_pct REAL,
      i_gf REAL,
      i_ga REAL,
      i_gd REAL,
      i_pts REAL,
      form_json TEXT,
      ideal_rank INTEGER,
      ideal_games INTEGER,
      ideal_wins INTEGER,
      ideal_draws INTEGER,
      ideal_loses INTEGER,
      ideal_avg_ts REAL,
      ideal_form_json TEXT,
      fetched_at TEXT,
      PRIMARY KEY (league_slug, team_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mantra_table_rows_manager
      ON mantra_table_rows(manager_id);
    CREATE TABLE IF NOT EXISTS mantra_gw_player_scores (
      slug TEXT NOT NULL,
      round TEXT NOT NULL,
      player_id INTEGER NOT NULL,
      total REAL NOT NULL,
      base REAL,
      PRIMARY KEY (slug, round, player_id)
    );
  `);
}

export function getDb(): Database.Database {
  if (db) return db;
  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  db.exec(MANTRA_AUCTION_SCHEMA);
  migrate(db);
  return db;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO sync_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value);
}
