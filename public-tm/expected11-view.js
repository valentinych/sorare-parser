export function expected11VisibleMatches(data, matchId) {
  const matches = Array.isArray(data?.matches) ? data.matches : [];
  return matchId ? matches.filter((match) => match.id === matchId) : matches;
}

export function expected11PlayerProfileUrl(player) {
  if (player?.linkStatus !== "linked") return null;
  const id = Number(player?.profilePlayerId);
  return Number.isSafeInteger(id) && id > 0 ? `/player.html?id=${id}` : null;
}

export function expected11PositionsText(player) {
  if (player?.linkStatus !== "linked" || !Array.isArray(player?.positions)) {
    return "—";
  }
  const positions = player.positions.filter(
    (position) => typeof position === "string" && position.trim(),
  );
  return positions.length ? positions.join(" / ") : "—";
}

export function expected11NarrativeBlocks(team, selectedMatch) {
  if (!selectedMatch) return [];
  const notes = team?.notes || {};
  return [
    ["Анализ команды", notes.teamAnalysis],
    ["Травмы и восстановление", notes.injuriesAndRecovery],
    ["Дисквалификации и недоступные", notes.suspensionsAndIneligibilities],
    ["Дополнительные заметки", notes.additionalNotes],
  ].map(([label, note]) => ({
    label,
    text: typeof note?.text === "string" && note.text.trim() ? note.text : "—",
  }));
}

export function expected11AggregateText(data) {
  const counts = data?.aggregate ?? {};
  return (
    `Всего: ${counts.matches ?? 0} матчей · ${counts.clubs ?? 0} клубов · ` +
    `связано ${counts.linked ?? 0} · не найдено ${counts.unmatched ?? 0} · ` +
    `неоднозначно ${counts.ambiguous ?? 0}`
  );
}

export function expected11ScopeText(data, matchId) {
  if (!matchId) {
    return `Все матчи / все клубы · показано ${data?.aggregate?.teams ?? 0} клубов`;
  }
  const match = expected11VisibleMatches(data, matchId)[0];
  if (!match) return "Выбранный матч не найден";
  return (
    `Выбранный матч: ${match.teams.length} клуба · связано ${match.counts.linked} · ` +
    `не найдено ${match.counts.unmatched} · неоднозначно ${match.counts.ambiguous}`
  );
}
