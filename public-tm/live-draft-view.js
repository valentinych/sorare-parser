export function namedTeamsFromRoom(room) {
  const listed = Array.isArray(room?.namedTeams)
    ? room.namedTeams
    : (room?.managers || []).map((manager) => ({
        email: manager.email,
        teamName: manager.teamName,
      }));
  return listed
    .map((item) => ({
      email: String(item?.email || ""),
      teamName: String(item?.teamName || "").trim(),
    }))
    .filter((item) => item.teamName);
}

export function managerPresence(manager = {}) {
  if (manager.online) {
    const ping = Number(manager.pingMs);
    return {
      online: true,
      pingMs: Number.isFinite(ping) ? Math.round(ping) : null,
    };
  }
  return { online: false, pingMs: null };
}

export function managerHeading(manager = {}) {
  const teamName = String(manager.teamName || "").trim();
  if (teamName) return { label: teamName, named: true };
  const fallback =
    String(manager.name || "").trim() ||
    String(manager.email || "").split("@")[0] ||
    "";
  return { label: fallback, named: false };
}

export function managerMantraId(manager = {}) {
  const id = Number(manager.mantraManagerId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function managerSquadId(manager = {}) {
  const id = Number(manager.squadId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function squadPlayerLine(player = {}) {
  const parts = [
    String(player.name || (player.id != null ? `#${player.id}` : "")).trim(),
    (Array.isArray(player.positions) ? player.positions : []).filter(Boolean).join("/"),
    String(player.clubName || "").trim(),
    player.amount == null || player.amount === "" ? "" : String(player.amount),
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Classic Mantra positions used by the PL live-draft roster (`player.positions`). */
export const LIVE_DRAFT_MANTRA_POSITIONS = [
  "GK",
  "CB",
  "RB",
  "LB",
  "WB",
  "DM",
  "CM",
  "AM",
  "W",
  "FW",
  "ST",
];

export function squadPositionCounts(squad = []) {
  const counts = Object.fromEntries(LIVE_DRAFT_MANTRA_POSITIONS.map((pos) => [pos, 0]));
  for (const player of Array.isArray(squad) ? squad : []) {
    const seen = new Set();
    for (const raw of Array.isArray(player?.positions) ? player.positions : []) {
      const pos = String(raw || "").trim().toUpperCase();
      if (!pos || seen.has(pos) || !(pos in counts)) continue;
      seen.add(pos);
      counts[pos] += 1;
    }
  }
  return counts;
}

export function renderSquadPositionTally(squad = []) {
  const counts = squadPositionCounts(squad);
  const parts = LIVE_DRAFT_MANTRA_POSITIONS.map((pos) => {
    const n = counts[pos];
    const zero = n === 0 ? " is-zero" : "";
    return `<span class="live-draft-pos-count${zero}">${escHtml(pos)} ${n}</span>`;
  });
  return `<p class="meta live-draft-squad-tally">${parts.join(" · ")}</p>`;
}

export function renderAllManagerSquads(
  managers = [],
  {
    emptyLabel = "Пока пусто",
    admin = false,
    saveLabel = "OK",
    amountLabel = "Ставка",
    ownerLabel = "За менеджера",
    releaseLabel = "Удалить в аукцион",
  } = {},
) {
  const list = Array.isArray(managers) ? managers : [];
  return list
    .map((manager) => {
      const heading = managerHeading(manager);
      const squad = Array.isArray(manager?.squad) ? manager.squad : [];
      const squadId = managerSquadId(manager);
      const idSuffix = squadId != null ? ` · ID ${squadId}` : "";
      const body = squad.length
        ? squad
            .map((player) => {
              const controls =
                admin && player?.id != null
                  ? `<form class="live-draft-correct" data-correct-player="${escHtml(player.id)}">
                      <input type="number" min="1" max="260" step="1" name="amount" value="${escHtml(player.amount ?? "")}" aria-label="${escHtml(amountLabel)}" data-correct-amount />
                      <select name="email" data-correct-owner aria-label="${escHtml(ownerLabel)}">
                        ${list
                          .filter((item) => item?.email)
                          .map((item) => {
                            const selected =
                              String(item.email).toLocaleLowerCase() ===
                              String(manager.email || "").toLocaleLowerCase()
                                ? " selected"
                                : "";
                            return `<option value="${escHtml(item.email)}"${selected}>${escHtml(managerHeading(item).label)}</option>`;
                          })
                          .join("")}
                      </select>
                      <button type="submit" class="col-picker-btn">${escHtml(saveLabel)}</button>
                    </form>
                    <form class="live-draft-release" data-release-player="${escHtml(player.id)}" data-release-email="${escHtml(manager.email || "")}">
                      <button type="submit" class="col-picker-btn danger">${escHtml(releaseLabel)}</button>
                    </form>`
                  : "";
              return `<article class="live-draft-squad-row">${escHtml(squadPlayerLine(player))}${controls}</article>`;
            })
            .join("")
        : `<p class="meta">${escHtml(emptyLabel)}</p>`;
      return `<section class="live-draft-manager-squad"><h4>${escHtml(heading.label)}${escHtml(idSuffix)}</h4>${body}</section>`;
    })
    .join("");
}

export const LIVE_DRAFT_SQUAD_SIZE = 26;

export const LIVE_DRAFT_ERROR_KEYS = {
  auction_paused: "Аукцион на паузе",
  auction_not_running: "Аукцион не запущен",
  auction_complete: "Аукцион завершён",
  folded: "Ты уже пас",
  bid_too_low: "Ставка слишком низкая",
  bid_over_max: "Ставка выше максимума — нужен резерв на свободные слоты",
  not_your_turn: "Сейчас не твой ход",
  no_open_lot: "Лота нет",
  already_high_bid: "Ты уже лидер лота",
  leader_cannot_fold: "Лидер не может пасовать",
  is_high_bid: "Лидер не может пасовать",
  budget_exceeded: "Не хватает бюджета",
  squad_full: "Состав уже полный",
  need_goalkeepers: "Нужны вратари",
  invalid_amount: "Некорректная ставка",
  invalid_player: "Некорректный игрок",
  player_not_found: "Игрок не найден",
  player_sold: "Игрок уже куплен",
  lot_already_open: "Лот уже открыт",
  unknown_manager: "Неизвестный менеджер",
  not_admin: "Нужны права админа",
  need_participants: "Недостаточно участников",
  reset_required: "Сначала сбрось аукцион",
  not_owner: "Нельзя менять чужое имя",
  invalid_team_name: "Некорректное название команды",
  player_not_sold: "Игрок ещё не продан",
  player_not_on_roster: "Игрок не в этом составе",
  cannot_autopick: "Автопик недоступен — кто-то ещё может перебить",
};

export function liveDraftErrorText(error, translate = (value) => value) {
  const code = error?.code || error?.message;
  const key = LIVE_DRAFT_ERROR_KEYS[code];
  if (key) return translate(key);
  const message = error?.message || String(code || "error");
  return `${translate("Ошибка")}: ${message}`;
}

export function liveDraftBidStep(current) {
  const amount = Number(current);
  if (!Number.isFinite(amount) || amount < 1) return 1;
  return amount < 20 ? 1 : Math.floor(amount / 10);
}

export function liveDraftMaxBid(budgetLeft, squadSize) {
  const reserved = Math.max(0, LIVE_DRAFT_SQUAD_SIZE - Number(squadSize || 0) - 1);
  return Number(budgetLeft || 0) - reserved;
}
