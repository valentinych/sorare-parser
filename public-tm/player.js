import {
  formatUiDateTime,
  initI18n,
  setUiPreferences,
} from "./i18n.js?v=4";

initI18n();

const statusEl = document.getElementById("status");
const pageEl = document.getElementById("player-page");

function formatMoney(value) {
  if (value == null) return "—";
  if (value >= 1_000_000) return `€${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `€${Math.round(value / 1_000)}K`;
  return `€${value}`;
}

function formatHeight(h) {
  if (h == null) return "—";
  return `${Number(h).toFixed(2)} m`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString("ru-RU");
}

function formatDateTime(iso) {
  return formatUiDateTime(iso);
}

function dl(items) {
  return `<dl class="facts">${items
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v ?? "—"}</dd></div>`)
    .join("")}</dl>`;
}

function render(p) {
  document.title = `${p.name} · TM Desk`;
  const club = p.clubs?.[0];
  const extras = (p.positions?.extras || [])
    .map((x) => x.label || x.name)
    .filter(Boolean)
    .join(", ");
  const mainPos = p.positions?.main;
  const natFlag = p.nationality?.flagUrl
    ? `<img class="flag" src="${p.nationality.flagUrl}" alt="" />`
    : "";

  const mv = p.marketValue || {};
  const matches = p.matches || [];
  const events = p.events || [];

  pageEl.innerHTML = `
    <section class="player-hero">
      <img class="portrait" src="${p.portraitUrl || ""}" alt="" />
      <div>
        <p class="eyebrow">${club?.clubName || "—"}${club?.shirtNumber != null ? ` · #${club.shirtNumber}` : ""}${club?.isCaptain ? " · C" : ""}</p>
        <h1>${p.name}</h1>
        <p class="meta">
          ${natFlag}
          ${p.nationality?.name || "—"}
          ${p.nationality?.fifaCode ? `(${p.nationality.fifaCode})` : ""}
          ${p.nationality?.confederation?.name ? ` · ${p.nationality.confederation.name}` : ""}
        </p>
        <div class="club-metrics">
          <span class="chip">${mainPos?.label || "—"} · ${mainPos?.name || mainPos?.group || "позиция"}</span>
          ${extras ? `<span class="chip">ещё: ${extras}</span>` : ""}
          <span class="chip">${formatMoney(mv.current)}</span>
        </div>
      </div>
    </section>

    <section class="player-grid">
      <article class="panel">
        <h2>Профиль</h2>
        ${dl([
          ["Возраст", p.age],
          ["Дата рождения", formatDate(p.dateOfBirth)],
          ["Место рождения", p.placeOfBirth],
          ["Страна рождения", p.birthCountry?.name],
          ["Пол", p.gender],
          ["Рост", formatHeight(p.height)],
          ["Рабочая нога", p.preferredFoot],
          ["Контракт до", p.contractUntil],
          ["Агентство", p.agency?.name],
          ["Экипировка", p.outfitter?.name || (p.outfitter ? p.outfitter.id : "—")],
          ["Второе гражданство", p.nationality?.second?.name],
        ])}
        ${p.formerClubsNote ? `<p class="note"><strong>Бывшие клубы:</strong> ${p.formerClubsNote}</p>` : ""}
      </article>

      <article class="panel">
        <h2>Стоимость</h2>
        ${dl([
          ["Текущая", `${formatMoney(mv.current)}${mv.currentDetermined ? ` · ${formatDate(mv.currentDetermined)}` : ""}`],
          ["Предыдущая", `${formatMoney(mv.previous)}${mv.previousDetermined ? ` · ${formatDate(mv.previousDetermined)}` : ""}`],
          ["Пик", `${formatMoney(mv.highest)}${mv.highestDetermined ? ` · ${formatDate(mv.highestDetermined)}` : ""}`],
          ["Динамика", mv.deltaValue ? `${mv.deltaValue}${mv.deltaType ? ` (${mv.deltaType})` : ""}` : "—"],
        ])}
        <p class="hint">Позиции и страны резолвятся из справочника TM (<code>positions</code>, <code>countries</code>, <code>outfitters</code>, <code>confederations</code>).</p>
      </article>

      <article class="panel">
        <h2>Позиции (справочник)</h2>
        ${dl([
          ["Основная", `${mainPos?.label || "—"} — ${mainPos?.name || "—"}${mainPos?.category ? ` · ${mainPos.category}` : ""}`],
          ["Группа", mainPos?.group || "—"],
          [
            "Доп. 1",
            p.positions?.extras?.[0]
              ? `${p.positions.extras[0].label || "—"} — ${p.positions.extras[0].name || "—"}`
              : "—",
          ],
          [
            "Доп. 2",
            p.positions?.extras?.[1]
              ? `${p.positions.extras[1].label || "—"} — ${p.positions.extras[1].name || "—"}`
              : "—",
          ],
        ])}
      </article>

      <article class="panel">
        <h2>Клуб</h2>
        ${(p.clubs || [])
          .map(
            (c) => `
          <div class="club-row">
            ${c.clubCrest ? `<img src="${c.clubCrest}" alt="" />` : ""}
            <div>
              <strong>${c.clubName || c.clubId}</strong>
              <p class="meta">${c.clubCity || "—"} · #${c.shirtNumber ?? "—"} ${c.isCaptain ? "· капитан" : ""}</p>
            </div>
          </div>`,
          )
          .join("") || "<p class='meta'>—</p>"}
        ${
          (p.assignments || []).length
            ? `<h3>Назначения</h3><ul class="plain">${p.assignments
                .map(
                  (a) =>
                    `<li>${a.type || "—"} · club ${a.clubId} · start ${a.start || "—"} · debut ${a.debut || "—"}</li>`,
                )
                .join("")}</ul>`
            : ""
        }
      </article>
    </section>

    <section class="panel wide">
      <h2>Матчи с участием (${matches.length})</h2>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Турнир</th>
              <th>Матч</th>
              <th>Роль</th>
              <th>#</th>
              <th>Позиция</th>
            </tr>
          </thead>
          <tbody>
            ${
              matches.length
                ? matches
                    .map((m) => {
                      const score =
                        m.homeScore != null && m.awayScore != null
                          ? `${m.homeScore}:${m.awayScore}`
                          : "—";
                      return `<tr class="click-row" data-game="${m.gameId}">
                        <td>${formatDateTime(m.dateUtc)}</td>
                        <td>${m.competitionId || "—"}</td>
                        <td>${m.homeClubName || "—"} ${score} ${m.awayClubName || "—"}</td>
                        <td>${m.isStarter ? "Старт" : "Запас"}</td>
                        <td>${m.shirtNumber ?? "—"}</td>
                        <td>${m.positionLabel || "—"}</td>
                      </tr>`;
                    })
                    .join("")
                : `<tr><td colspan="6">Пока нет сыгранных матчей с составом в базе</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel wide">
      <h2>События (${events.length})</h2>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>Дата</th><th>Матч</th><th>Минута</th><th>Тип</th><th>Действие</th><th>Роль</th></tr>
          </thead>
          <tbody>
            ${
              events.length
                ? events
                    .map(
                      (e) => `<tr>
                        <td>${formatDateTime(e.dateUtc)}</td>
                        <td>${e.homeClubName || "—"} — ${e.awayClubName || "—"}</td>
                        <td>${e.minute ?? "—"}'</td>
                        <td>${e.icon ? `${e.icon} ` : ""}${e.eventLabel || e.eventType}</td>
                        <td>${e.summary || e.action || e.reason || "—"}</td>
                        <td>${e.roleLabel || (e.role === "active" ? "участник" : "связан")}</td>
                      </tr>`,
                    )
                    .join("")
                : `<tr><td colspan="6">Нет событий (голы/карточки/замены) в загруженных матчах</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </section>
  `;

  for (const tr of pageEl.querySelectorAll("[data-game]")) {
    tr.addEventListener("click", () => {
      location.href = `/#matches`;
    });
  }
}

async function boot() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) {
    statusEl.textContent = "Не указан id игрока";
    return;
  }
  try {
    const [res, accountRes] = await Promise.all([
      fetch(`/api/players/${encodeURIComponent(id)}`),
      fetch("/api/me"),
    ]);
    if (accountRes.ok) {
      const account = await accountRes.json();
      if (account.user) {
        setUiPreferences({
          locale: account.user.locale,
          timeZone: account.user.timeZone,
        });
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data);
  } catch (err) {
    statusEl.textContent = `Не удалось загрузить игрока: ${err.message}`;
  }
}

boot();
