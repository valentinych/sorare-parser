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

## SorareInside — скачивание скриншотов

Та же локальная страница `http://127.0.0.1:3002`, вкладка **SorareInside**.
Открывает headed Chrome, грузит lineups на [sorareinside.com](https://sorareinside.com),
и по клику **Home** / **Away** сохраняет скриншот модалки состава + sidecar JSON.

### Запуск

```bash
npm install
npx playwright install chromium
npm run expected11:web
```

`expected11:web` = `tsx src/expected11-server.ts`. Сервер слушает только
`127.0.0.1:3002`. В терминале будет
`Expected11 local UI → http://127.0.0.1:3002`. Открой этот URL, сверху
переключись с **Expected11** на **SorareInside**.

Профиль Chrome для этой вкладки отдельный:
`data/sorare/chrome-profile` (не тот, что у Expected11).

### Что нужно заранее

- Установленный **Google Chrome** (локальный запуск идёт через CDP, без
  `--enable-automation`). Если Chrome нет (Docker / headless Linux) —
  Playwright Chromium.
- Аккаунт SorareInside. Без логина lineups не догружаются, и скриншоты
  не снимаются.
- Один захват за раз: пока идёт **Load leagues** или скриншот, остальные
  операции вернут *A SorareInside operation is already running.* Отдельного
  rate-limit нет — просто не кликай следующую сторону, пока статус не
  станет `ready`.

### Папка скриншотов

Поле **Screenshot folder** + кнопка **Choose folder**.

- По умолчанию: `data/sorare/output`.
- Путь помнится в `data/sorare/output-dir.json` и в `localStorage`
  браузера, переживает перезапуск UI.
- **Choose folder** открывает нативный диалог macOS
  («Save Sorare screenshots to:»). На Linux/Windows диалога нет —
  вставь абсолютный или относительный путь в поле и кликни вне него.
  Если нажать **Choose folder** не на macOS, сервер ответит:
  *Native folder picker works on macOS. Paste a folder path instead.*

Файлы кладутся как `{папка}/{round}/{club}.png` (и рядом `-green.png` +
`.json`). Номер **round/tour** задаётся у каждой лиги в списке **Leagues**
(число 1–99), не в поле папки.

### Пошагово

1. Вставь URL тура в **SorareInside lineups URL**, например
   `https://sorareinside.com/lineups?gwSlug=football-28-aug-1-sep-2026`
   (можно только slug: `football-28-aug-1-sep-2026`).
2. Нажми **Load leagues**. Откроется Chrome. Если сессии нет (первый раз
   или Chrome сбросили) — залогинься в открытом окне SorareInside, затем
   в UI нажми **Login complete — continue**.
3. Дождись статуса `ready` и блока **Leagues**
   (`N tournament/league types. Check leagues and set round/tour for screenshot folders.`).
   Отметь нужные лиги галочкой, в числовом поле справа поставь тур
   (например `3`).
4. Нажми **Expand selected**. Появится блок **Matches**:
   `Home vs Away` + две кнопки **Home** и **Away**.
5. Chrome **сам прокручивает страницу lineups до низа**, пока не
   подгрузятся все ленивые матчи. Это делается при **Load leagues** и
   ещё раз перед первым скриншотом, если страница не была доскроллена.
   Кликать матчи можно после этого, не нужно крутить Chrome руками.
6. Нажми **Home** или **Away** у нужного матча. UI пишет
   `Capturing {club} → {folder}/{round}/…`. Chrome открывает попап
   состава, доскролливает модалку (чтобы появились % / Bench / DNP) и
   сохраняет файлы. Кнопка без lineup неактивна (`No lineup`).

Повтори шаг 6 для каждой стороны. Отдельной кнопки «скачать все» нет:
это ручной клик по сторонам, по одной. Повторный клик по уже зелёной
кнопке переснимает файлы.

### Что сохраняется и как называются файлы

Для `Millwall FC`, round `3`, папка по умолчанию:

```text
data/sorare/output/3/millwall.png         # вся модалка (pitch + bench + DNP)
data/sorare/output/3/millwall-green.png   # только зелёное поле
data/sorare/output/3/millwall.json        # вероятности игроков (локально)
```

Имя файла — slug клуба: lowercase, без суффикса FC/AFC/CF/SC,
пробелы → `-`. После сохранения статус внизу:
`Saved {folder}/{round}/{club}.png + {club}-green.png · N player probabilities in sidecar JSON`.

JSON на прод сам не уходит. Кнопка **Залить JSON на прод** (ниже списка
матчей) — отдельный шаг, если нужен Premium «футмопс»; для скачивания
скриншотов она не обязательна.

### Список матчей после скриншота

Список **не пересобирается** после каждого сохранения. Меняется только
кнопка стороны: становится зелёной с галочкой, например `Home ✓ (18)`
(число — сколько игроков в JSON). Счётчик в подписи Matches
(`captured X/Y sides on disk`) тоже обновляется. Сами строки матчей
остаются на месте.

### Если что-то сломалось

| Симптом | Что сделать |
|--------|-------------|
| Chrome открылся на логине / paywall | Войди в SorareInside в этом окне, нажми **Login complete — continue**. |
| Сессия пропала после рестарта Chrome | Снова **Load leagues**. Профиль `data/sorare/chrome-profile` мог сброситься — логин заново. |
| *Not signed in. Run Load leagues first…* | Скриншот без живой сессии не идёт. Сначала **Load leagues** + логин, потом **Home**/**Away**. |
| *Getting latest saved lineups…* больше 120 с | Проверь логин и `gwSlug`. Без доступа /games пустой. |
| **Choose folder** не работает | Только macOS. На других ОС вставь путь в **Screenshot folder**. |
| Кнопка серая, клик ничего не даёт | Нет lineup у этой стороны, или уже идёт другой захват — смотри **SorareInside status**. |
| Не все матчи в Chrome | Дождись окончания автоскролла (`Scrolling lineups to the bottom to load all matches…`), потом кликай. |

Полный цикл всегда такой: **залогиниться → Load leagues (скролл) → Expand selected → Home/Away (скролл модалки → скриншот)**. Если выпал из сессии на любом шаге — вернись к **Load leagues**.

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
