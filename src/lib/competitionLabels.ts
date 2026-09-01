/** Human-readable labels for TM / AF competition codes shown in UI filters. */

const LABELS: Record<string, string> = {
  // Domestic leagues (TM)
  PL1: "Ekstraklasa",
  GB1: "Premier League",
  GB2: "Championship",
  L1: "Bundesliga",
  IT1: "Serie A",
  ES1: "La Liga",
  FR1: "Ligue 1",
  TR1: "Süper Lig",
  NL1: "Eredivisie",
  PO1: "Primeira Liga",
  BE1: "Jupiler Pro League",
  // Domestic cups / supers
  PLSC: "Суперкубок Польши",
  GBCS: "Community Shield",
  FAC: "FA Cup",
  CGB: "Кубок лиги (EFL)",
  POC: "Puchar Polski",
  // Europe
  CL: "Лига чемпионов",
  CLQ: "ЛЧ · квалификация",
  EL: "Лига Европы",
  ELQ: "ЛЕ · квалификация",
  ECL: "Лига конференций",
  ECLQ: "ЛК · квалификация",
  USC: "Суперкубок УЕФА",
  // Friendlies
  FRI: "Товарищеские",
  // AF league ids (when surfaced as codes)
  AF667: "Товарищеские",
  AF2: "Лига чемпионов",
  AF3: "Лига Европы",
  AF848: "Лига конференций",
  AF39: "Premier League",
  AF40: "Championship",
  AF78: "Bundesliga",
  AF135: "Serie A",
  AF140: "La Liga",
  AF61: "Ligue 1",
  AF203: "Süper Lig",
  AF88: "Eredivisie",
  AF94: "Primeira Liga",
  AF144: "Jupiler Pro League",
  AF106: "Ekstraklasa",
  AF528: "Community Shield",
  AF531: "Суперкубок УЕФА",
  AF45: "FA Cup",
  AF48: "Кубок лиги (EFL)",
};

/** Map AF Football league id → short filter code used in matches UI. */
export function afLeagueToCompCode(leagueId: number | null | undefined, name?: string | null): string {
  if (leagueId == null) return "FRI";
  const n = (name || "").toLowerCase();
  if (leagueId === 667 || n.includes("friendly")) return "FRI";
  if (leagueId === 2) return "CLQ";
  if (leagueId === 3) return "ELQ";
  if (leagueId === 848) return "ECLQ";
  if (leagueId === 528) return "GBCS";
  if (leagueId === 531) return "USC";
  if (leagueId === 39) return "GB1";
  if (leagueId === 40) return "GB2";
  if (leagueId === 78) return "L1";
  if (leagueId === 135) return "IT1";
  if (leagueId === 140) return "ES1";
  if (leagueId === 61) return "FR1";
  if (leagueId === 203) return "TR1";
  if (leagueId === 88) return "NL1";
  if (leagueId === 94) return "PO1";
  if (leagueId === 144) return "BE1";
  if (leagueId === 106) return "PL1";
  return `AF${leagueId}`;
}

export function competitionLabel(code: string | null | undefined, fallbackName?: string | null): string {
  if (!code) return fallbackName || "—";
  if (LABELS[code]) return LABELS[code];
  if (fallbackName && fallbackName.trim()) return fallbackName.trim();
  return code;
}

/** Option text for dropdowns: "Товарищеские (FRI)" */
export function competitionOptionLabel(code: string, fallbackName?: string | null): string {
  const label = competitionLabel(code, fallbackName);
  if (label === code) return code;
  return `${label} (${code})`;
}
