/**
 * SorareInside "analyst notes" often capture pitch chrome instead of prose
 * (Score/AA/DA/APP tables, Starting % Key legend, reliability footer).
 * Drop those so Automops / JSON sidecars only keep real narrative text.
 */

/** True when text is SI UI chrome / pitch dump, not analyst prose. */
export function isSorareInsideChromeNoise(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/^(none|\.|—|-)$/i.test(t)) return true;

  const chromeHits = [
    /Starting\s*%\s*Key/i.test(t),
    /SorareInside\.com/i.test(t),
    /\b(?:HIGH|MEDIUM|LOW)\s+RELIABILITY\b/i.test(t),
    /First published:/i.test(t),
    /Potential Factors to not start/i.test(t),
    /Highly likely to start the match/i.test(t),
    /^Score\s*$/im.test(t) && /\bAA\b/.test(t) && /\bAPP\b/.test(t),
  ].filter(Boolean).length;

  const pctLines = (t.match(/^\d{1,3}%\s*$/gm) || []).length;
  const shortLines = t.split(/\n/).filter((l) => l.trim().length > 0).length;

  // Explicit chrome blocks.
  if (chromeHits >= 2) return true;
  if (chromeHits >= 1 && pctLines >= 4) return true;

  // Pitch probability dump: many bare "80%" lines + short name rows, little prose.
  if (pctLines >= 6 && shortLines >= 20) {
    const proseLines = t
      .split(/\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length >= 40 &&
          !/^\d{1,3}%/.test(l) &&
          !/^(score|aa|da|app|ps|pspe)$/i.test(l) &&
          !/sorareinside|reliability|starting\s*%\s*key|first published|updated\s+\d/i.test(
            l,
          ),
      );
    if (proseLines.length === 0) return true;
  }

  return false;
}

/** Return trimmed note text, or "" when only SI chrome remains. */
export function sanitizeSorareAnalystNote(text: string): string {
  const t = String(text || "").trim();
  if (!t || /^(none|\.|—|-)$/i.test(t)) return "";
  if (isSorareInsideChromeNoise(t)) return "";
  return t;
}

export type SorareAnalystNotesBag = {
  teamAnalysis?: string;
  injuriesAndRecovery?: string;
  suspensionsAndIneligibilities?: string;
  additionalNotes?: string;
};

/** Sanitize each note field; omit empty/chrome keys. */
export function sanitizeSorareAnalystNotesMap(
  notes: SorareAnalystNotesBag | null | undefined,
): SorareAnalystNotesBag {
  if (!notes || typeof notes !== "object") return {};
  const out: SorareAnalystNotesBag = {};
  for (const key of [
    "teamAnalysis",
    "injuriesAndRecovery",
    "suspensionsAndIneligibilities",
    "additionalNotes",
  ] as const) {
    const raw = notes[key];
    const cleaned = sanitizeSorareAnalystNote(typeof raw === "string" ? raw : "");
    if (cleaned) out[key] = cleaned;
  }
  return out;
}
