# Ekstraklasa XI (pet)

Типичные XI (2025/26) и **предикт стартовых составов 2026/27** с бэкапами.

## Источники

| Сигнал | Откуда |
|--------|--------|
| Сила игрока | API-Football stats сезона **2025** (минуты, rating, голы/ассисты) |
| Стоимость | Transfermarkt market value (private API) |
| Предсезон | Friendlies Clubs июнь–июль 2026 → form_score команды |
| Состав | `/players/squads` на сезон 2026 |

Предсезонные **lineups в AF пустые**, поэтому XI считается по составу + силе + цене + форме команды.

## Setup

```bash
cp .env.example .env   # API_FOOTBALL_KEY
npm install
```

## Expected11 browser parser

Local parser launches **installed Google Chrome** (the real
`/Applications/Google Chrome.app` binary over CDP, without
`--enable-automation`). Docker rebuilds still
need the project-managed Chromium:

```bash
npx playwright install chromium
```

For the local web interface, run:

```bash
npm run expected11:web
```

Open `http://127.0.0.1:3002`, paste one or more Expected11 match URLs (one per
line), and click **Start parser**. Optional **Screenshot green pitch areas**
saves PNG clips of the green lineup regions under
`data/expected11/output/screenshots-<timestamp>/`. The page also has a
**Screenshot tool**: mode `green` (auto pitch boxes) or `coords` (viewport
`x,y,width,height` clip) via `POST /api/screenshot`. The server listens only on
`127.0.0.1`. If
the headed browser asks for login or CAPTCHA, complete it manually, keep the
browser open, then click **Login complete — continue** in the local interface.
Only one run can use the isolated profile at a time. The finished parser JSON
can be viewed and downloaded from the page. After a successful run,
**Publish to production** sends only that sanitized JSON to the fixed
`https://mantra.panenka.games/api/expected11/import` endpoint. Set the same
random `EXPECTED11_IMPORT_TOKEN` on the local runner and production server;
the token stays server-side and is never returned to the browser. The publish
transport omits diagnostic and compatibility duplicates while retaining match
provenance, teams, lineup groups, percentages, notes, authors, and player paths
used for linking. Production accepts at most 512 KiB per import.

The CLI remains available:

```bash
npm run expected11 -- --diagnostic \
  https://expected11.com/match/19729166/wolverhampton-wanderers-vs-blackburn-rovers
```

The headed browser uses the isolated, persistent profile
`data/expected11/chrome-profile/` (not Chrome for Testing). Sign in with
Expected11 **email and password** (not Google/Gmail) once in that window — the
old `data/expected11/profile/` session is not reused.
On the first restricted page, complete any CAPTCHA manually, then press Enter
in the terminal (or **Login complete** in the web UI). The parser does not
automate Google login or use your everyday Chrome profile. Type email/password
in the headed window; optional `EXPECTED11_EMAIL` / `EXPECTED11_PASSWORD` only
prefill the form and are never logged. `/sorare`
**Пересобрать** reuses this same Playwright path (not an anonymous HTTP fetch).
Docker/headless falls back to bundled Chromium at `data/expected11/profile/`
if Google Chrome is not installed in the container; if the session expired, the
skip code is `expected11_login_required`.

Each run writes `data/expected11/output/expected11-<timestamp>.json`. Schema
version 2 adds a clear `teams` array while retaining the flat `players` array
for compatibility:

```text
matches[].teams[] = {
  side, name, logoUrl,
  lineup: { starting: Player[], bench: Player[], out: Player[] },
  notes: {
    teamAnalysis,
    injuriesAndRecovery,
    suspensionsAndIneligibilities
  },
  author
}

Player = {
  name,
  displayedPercentage, // 0..100, null when no badge is shown
  displayedLabel,      // raw visible badge such as "60%"
  raw
}
```

Narrative blocks contain their visible `label` and multiline `text`. Team logo
URLs are recorded only when the rendered page exposes an HTTP(S) URL; images
are not downloaded by the parser. The compatibility `players[].probabilities`
values remain normalized from 0 to 1 and are populated only when the visible
label states the probability meaning. A lineup section alone does not invent
substitute or not-playing probability values.

A run exits non-zero when a supplied page yields no visible player names; use
`--diagnostic` for selector counts and access warnings. Only visible rendered
DOM is inspected, and full HTML is never saved.

The public `#sorare` bookmark remains compatible and displays the latest
Expected 11 import grouped by club and `STARTING` / `BENCH` / `OUT`. Player
links are created only by normalized exact full-name matching inside one
uniquely matched Mantra club. Unmatched and ambiguous names remain unlinked.

## Sync

```bash
# история 2025/26 (stats) + предикт-пайплайн 2026/27
npm run sync -- --skip-lineups

# только 2026/27 (squads, preseason, TM values)
npm run sync:2026
```

## API

```bash
npm run dev
```

| Endpoint | Описание |
|----------|----------|
| `GET /ekstraklasa/2026/teams` | клубы 2026/27 |
| `GET /ekstraklasa/2026/predicted-xi` | предикт всех команд (starter + backup) |
| `GET /ekstraklasa/2026/teams/:id/predicted-xi` | предикт одной команды |
| `GET /ekstraklasa/2025/predicted-xi` | типичная XI по lineup-ам 2025/26 |
| `GET /ekstraklasa/2026/meta` | счётчики sync |

## MantraFootball (Poland)

```bash
npm run sync:mantra
```

Тянет всех игроков турнира Poland (id=18), ≤4 req/s, профили кэшируются в `mantra_players` (повторный sync не дергает уже сохранённые профили).

Таблица на UI: `/` → секция «Все игроки» (фильтры клуб/позиция/состав, сортировка по рейтингу, Mantra positions, XI/Backup).
API: `GET /ekstraklasa/2026/board`
