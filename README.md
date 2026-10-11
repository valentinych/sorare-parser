# Mantra Helper

Fantasy companion for [MantraFootball](https://mantrafootball.org): live scores, Mantra tours, a pitch XI builder, tables, auctions, and lineup intel.

**Site:** [https://mantra.panenka.games/](https://mantra.panenka.games/)

This GitHub repo is named `sorare-parser` for historical reasons. The public product is **Mantra Helper**.

Interface languages: русский, English, українська, беларуская. Sign in with Google to save squads, pin your teams, and use Premium.

---

## Screenshots

**Live** — Mantra division pairings plus FotMob match cards (goals, cards, ratings).

![Live: Mantra tours](docs/screenshots/live.png)

![Live: FotMob matches](docs/screenshots/live-matches.png)

**Squad Builder** — pick a Mantra league and team, drop players onto a formation, export PNG.

![Squad Builder](docs/screenshots/builder.png)

![Squad Builder pitch 3-5-2](docs/screenshots/builder-pitch.jpg)

**Tables** — combined standings with TS, Ideal TS, and % of ideal.

![Tables](docs/screenshots/tables.png)

**Mantra Home** — player tiles for the home competition.

![Mantra Home](docs/screenshots/mantra-doma.jpg)

**Auctions** — historical bids, stages, and winning prices.

![Auctions](docs/screenshots/auctions.png)

---

## English

### Who it’s for

MantraFootball managers who want one place for **today’s matches**, **this tour’s XI**, **season tables**, and **auction history** — across the same 15 leagues the builder uses.

### Features

#### Live

FotMob scores next to Mantra tour pairings. Points follow Mantra rules (rating + bonuses) once a club is playing or finished; FotMob refreshes about every 5 minutes. XI squads sync once per round.

- Round tabs, live / soon / FT cards, events, and player ratings
- Mantra division boards with pair scores, `n/11` XI, and role chips
- Dream Team of the round and Ideal vs Real
- **My teams** (`Мои команды`) — your Mantra squads across leagues (Google sign-in + Mantra manager ID)
- “Show my leagues first” when you are logged in

Covered competitions (same set as Squad Builder):

Ekstraklasa · Serie A · Bundesliga · Premier League · Championship · Süper Lig · Ligue 1 · La Liga · Eredivisie · Pro League · Primeira Liga · UPL · MLS · Brasileirão · League One

#### Squad Builder

Build a starting XI on a green pitch using MantraFootball player photos.

- Formations (3-5-2, 4-3-3, 4-2-3-1, and the rest of the Mantra set)
- Second option on a slot (alternative)
- Download PNG
- Save / load named squads after Google sign-in
- “My teams only” filter
- Admin: refresh squads after calculated auction rounds (30-minute cooldown per league)

#### Tables

- Combined standings across divisions: W/D/L, GF/GA, TS, **Ideal TS**, % of ideal, form
- **Managers** view — aggregated manager stats (plus extra leagues in the competition list)
- Ideal tables (everyone posted Ideal XI) vs real tables; click a row to compare XIs

#### Premium

Expected XI / squad report / unpicked tops / form. Google sign-in; entitlement-gated.

- Squad report: minutes, FotMob, TS, form 0–10, auction price, injury / ban / OUT badges
- Top-5 unpicked players by position in that league
- Generate a suggested XI from Expected 11 + footmops probabilities, win/CS odds
- Same post-auction refresh as Builder (admin, 30-minute cooldown)

#### Auctions

Historical Mantra auctions: max API bid, stages, bid-record sums, winning manager. Filters, fantasy-team report, and Ideal Pick (what the other teams’ max + 1M would have bought).

#### Mantra Home (`Mantra Дома`)

Home-competition player grid (tiles or list), apply for a regular and/or live auction in your league (Google sign-in).

#### League One & Expected 11

- Public **League One** tab: FotMob ↔ Transfermarkt pairing and Mantra positions
- **Expected 11** (Фейк Мопс): imported STARTING / BENCH / OUT lineups by club

---

## Русский

### Для кого

Менеджеры MantraFootball: **лайв матчей**, **туры и XI**, **таблицы сезона** и **история аукционов** — в тех же 15 лигах, что и Squad Builder.

### Возможности

#### Live

Счёта FotMob рядом с парами туров Mantra. Очки считаются по правилам Mantra (рейтинг + бонусы), когда клуб уже играет или сыграл; FotMob обновляется примерно раз в 5 минут. Составы XI синкаются раз за тур.

- Вкладки туров, карточки live / soon / FT, события и оценки
- Доски дивизионов: счёт пары, `n/11` XI, чипы ролей
- Dream Team тура и Ideal vs Real
- **Мои команды** — ваши составы Mantra по всем лигам (вход Google + Mantra Manager ID)
- «Показывай мои лиги вверху» после входа

Лиги (тот же набор, что в Builder):

Ekstraklasa · Serie A · Bundesliga · Premier League · Championship · Süper Lig · Ligue 1 · La Liga · Eredivisie · Pro League · Primeira Liga · UPL · MLS · Brasileirão · League One

#### Squad Builder

Стартовый XI на зелёном поле с фото игроков MantraFootball.

- Схемы (3-5-2, 4-3-3, 4-2-3-1 и остальные схемы Mantra)
- Вторая опция на слот
- Скачать PNG
- Сохранение составов после входа через Google
- Фильтр «Только мои команды»
- Админ: обновление составов после рассчитанных раундов аукциона (кулдаун 30 минут на лигу)

#### Таблицы

- Сводная таблица по дивизионам: W/D/L, GF/GA, TS, **Ideal TS**, % к идеалу, форма
- Вид **Managers** — статистика менеджеров (в списке чемпионатов есть дополнительные лиги)
- Идеальные таблицы (все выставили Ideal XI) и реальные; клик по строке — сравнение XI

#### Premium

Expected XI, отчёт по составу, топ свободных, форма. Нужен Google-вход; доступ по entitlement.

- Отчёт: минуты, FotMob, TS, форма 0–10, цена с аукциона, бейджи травма / дисквал / OUT
- Топ-5 невзятых игроков по позициям в лиге
- Генерация XI из Expected 11 + футмопс, вероятности победы и сухих
- То же обновление после аукциона, что в Builder (админ, кулдаун 30 минут)

#### Аукционы

История аукционов Mantra: максимальная ставка API, этапы, сумма записей, победитель. Фильтры, отчёт по фэнтези-команде и Ideal Pick (максимум остальных + 1M).

#### Mantra Дома

Сетка игроков домашней лиги (плитки или список), заявка на обычный и/или живой аукцион (вход Google).

#### League One и Expected 11

- Публичная вкладка **League One**: связка FotMob ↔ Transfermarkt и позиции Mantra
- **Expected 11** (Фейк Мопс): импортированные составы STARTING / BENCH / OUT по клубам

---

## Local development

Node.js, npm. Copy `.env.example` → `.env` and fill only what you need (API keys stay local; do not commit `.env`).

```bash
npm install
npm test
npm run dev:tm
```

`dev:tm` serves the Mantra Helper UI (the same app as production). Default port is `3000`.

Optional local tools still in this repo:

- `npm run expected11:web` — headed Expected11 / SorareInside parser UI on `http://127.0.0.1:3002` (not the public site)
- `npm run sync:mantra`, `npm run sync:live`, and other `sync:*` scripts — data ingest for leagues the site already shows
