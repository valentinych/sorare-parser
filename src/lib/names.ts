/** Normalize names for AF ↔ TM / Mantra fuzzy matching. */
export function normName(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    // Latin letters that are not decomposable to ASCII via NFD
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/œ/gi, "oe")
    .replace(/ł/gi, "l")
    .replace(/đ/gi, "d")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .toLowerCase()
    // HTML entities from AF (O&apos;Hare) + Irish O'Brien / curly ’ → oleary
    .replace(/&apos;/g, "")
    .replace(/&#0*39;/g, "")
    .replace(/&quot;/g, "")
    .replace(/(\w)['\u2019\u2018](\w)/g, "$1$2")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(fc|cf|sc|ks|rks|mks|gks|lks)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function initialMatchesToken(initial: string, token: string): boolean {
  return initial.length === 1 && token.length >= 2 && token.startsWith(initial);
}

/**
 * Common football given-name variants. Only used when surnames already agree —
 * never alone (Tom Smith ≉ Thomas Jones).
 */
const DIMINUTIVE_GROUPS: string[][] = [
  ["tom", "thomas", "tommy"],
  ["will", "william", "bill", "billy", "liam"],
  ["alex", "alexander", "alexandre", "alejandro"],
  ["seb", "sebastian", "sebastien"],
  ["ollie", "oliver"],
  ["nick", "nicholas", "nicolas", "nico"],
  ["mike", "michael", "mick", "mickey"],
  ["chris", "christopher"],
  ["dan", "daniel", "danny"],
  ["dave", "david", "dai"],
  ["jim", "james", "jamie", "jimmy"],
  ["joe", "joseph", "joey"],
  ["john", "johnny", "jon"],
  ["jack", "jackie"],
  ["rob", "robert", "bob", "bobby", "robbie"],
  ["rich", "richard", "rick", "ricky"],
  ["steve", "stephen", "steven"],
  ["matt", "matthew", "matty"],
  ["ben", "benjamin", "benny"],
  ["sam", "samuel", "sammy"],
  ["tony", "anthony"],
  ["harry", "harold"],
  ["fred", "frederick", "freddie", "freddy"],
  ["andy", "andrew"],
  ["josh", "joshua"],
  ["max", "maxim", "maximilian"],
];

const DIMINUTIVE_OF = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of DIMINUTIVE_GROUPS) {
    const set = new Set(group);
    for (const name of group) map.set(name, set);
  }
  return map;
})();

function diminutivesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const group = DIMINUTIVE_OF.get(a);
  return !!group && group.has(b);
}

/** Surname particles that should not block initial+surname matches ("F. de Jong"). */
const NAME_PARTICLES = new Set([
  "de",
  "da",
  "do",
  "dos",
  "das",
  "van",
  "von",
  "der",
  "den",
  "la",
  "le",
  "el",
  "di",
  "del",
  "della",
  "af",
  "av",
]);

function significantTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !NAME_PARTICLES.has(t));
}

/** Given-name tokens compatible (exact, initial, or diminutive). */
function givenTokenCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  if (initialMatchesToken(a, b) || initialMatchesToken(b, a)) return true;
  if (diminutivesMatch(a, b)) return true;
  return false;
}

/**
 * Compare given-name token lists when surnames already match.
 * Supports "A. O. Kalin" ↔ "Ali Osman Kalın" and "Tom" ↔ "Thomas".
 */
function givenNamesCompatible(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;

  // Zip from the left for equal length, or when shorter is all initials /
  // prefix of longer given names ("a t" ↔ "ahmet taha", "tom" ↔ "thomas edward").
  if (shorter.length === longer.length) {
    return shorter.every((t, i) => givenTokenCompatible(t, longer[i]!));
  }

  // All-initial shorter side: each initial must match the corresponding longer token.
  if (shorter.every((t) => t.length === 1) && shorter.length <= longer.length) {
    return shorter.every((t, i) => initialMatchesToken(t, longer[i]!));
  }

  // Single given vs multi: compare first tokens only ("ahmet" ↔ "ahmet taha").
  if (shorter.length === 1) {
    return givenTokenCompatible(shorter[0]!, longer[0]!);
  }

  // Equal-prefix compare when lengths differ but first N tokens align
  // ("seb naylor" already equal-len; "william james" ↔ "will" → shorter len 1).
  if (shorter.every((t, i) => givenTokenCompatible(t, longer[i]!))) return true;

  return false;
}

/** True when every token of `short` appears in order inside `long` (middle names OK). */
function tokensAreSubsequence(short: string[], long: string[]): boolean {
  if (!short.length) return true;
  let i = 0;
  for (const t of long) {
    if (t === short[i]) {
      i++;
      if (i === short.length) return true;
    }
  }
  return false;
}

export function namesMatch(a: string, b: string): boolean {
  return nameMatchScore(a, b) > 0;
}

/**
 * Higher is better. Used to disambiguate collisions like AF "B. Yılmaz"
 * matching both "Barış Alper Yılmaz" and "Berat Yılmaz".
 */
export function nameMatchScore(a: string, b: string): number {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;

  const ta = na.split(" ").filter(Boolean);
  const tb = nb.split(" ").filter(Boolean);
  const lastA = ta[ta.length - 1];
  const lastB = tb[tb.length - 1];

  // Token containment, not raw substring: "Alisson" ↔ "Alisson Becker",
  // but "Beck" must not match "Alisson Becker" via "beck" ⊂ "becker".
  if (ta.length && tb.length) {
    const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    if (tokensAreSubsequence(shorter, longer)) {
      return 80 + Math.min(na.length, nb.length);
    }
  }

  // Compare on significant tokens so "F. de Jong" ↔ "Frenkie de Jong" works
  // (particle "de" would otherwise make both sides length-3 and skip this branch).
  const sigA = significantTokens(ta);
  const sigB = significantTokens(tb);
  const lastSigA = sigA[sigA.length - 1] ?? lastA;
  const lastSigB = sigB[sigB.length - 1] ?? lastB;

  if (lastSigA && lastSigB && lastSigA === lastSigB && lastSigA.length >= 4) {
    const givenA = sigA.slice(0, -1);
    const givenB = sigB.slice(0, -1);

    // Surname-only on one side ("wszolek" ↔ "pawel wszolek")
    if (givenA.length === 0 || givenB.length === 0) return 40;

    if (givenNamesCompatible(givenA, givenB)) {
      const exact =
        givenA.length === givenB.length && givenA.every((t, i) => t === givenB[i]);
      if (exact) return 90;
      // Diminutive / initial — weaker when fuller name has middle tokens
      // ("b yilmaz" ↔ "baris alper yilmaz" vs "berat yilmaz").
      const fuller = sigA.length >= sigB.length ? sigA : sigB;
      const middleBonus = Math.max(0, fuller.length - 2) * 2;
      const dim =
        givenA.some((t, i) => givenB[i] && diminutivesMatch(t, givenB[i]!)) ||
        (givenA.length === 1 && givenB.length >= 1 && diminutivesMatch(givenA[0]!, givenB[0]!)) ||
        (givenB.length === 1 && givenA.length >= 1 && diminutivesMatch(givenB[0]!, givenA[0]!));
      return (dim ? 75 : 50) + middleBonus;
    }
    return 0;
  }

  // "Fahri Kerem Ay" ↔ "Fahri Ay": shorter tokens are an ordered subsequence.
  if (sigA.length >= 2 && sigB.length >= 2) {
    const [shorter, longer] =
      sigA.length <= sigB.length ? [sigA, sigB] : [sigB, sigA];
    if (
      shorter.length >= 2 &&
      longer.length > shorter.length &&
      tokensAreSubsequence(shorter, longer) &&
      shorter[shorter.length - 1] === longer[longer.length - 1] &&
      (shorter[shorter.length - 1]?.length ?? 0) >= 2
    ) {
      return 70 + shorter.length * 2;
    }
  }

  const inter = ta.filter((t) => tb.includes(t) && t.length > 2);
  // "Jean Carlos" ↔ "Jean Carlos Silva" / given-name shirt names
  if (inter.length >= 2 || (inter.length === 1 && (ta.length === 1 || tb.length === 1))) {
    return 60 + inter.length * 5;
  }

  // AF "O. Abraham" vs Mantra "Abraham Ojo": shared "abraham" + initial O↔Ojo
  if (inter.length >= 1) {
    const shared = new Set(inter);
    const onlyA = ta.filter((t) => !shared.has(t));
    const onlyB = tb.filter((t) => !shared.has(t));
    if (onlyA.length === 1 && onlyB.length === 1) {
      if (initialMatchesToken(onlyA[0]!, onlyB[0]!) || initialMatchesToken(onlyB[0]!, onlyA[0]!)) {
        return 55;
      }
      if (diminutivesMatch(onlyA[0]!, onlyB[0]!)) return 55;
    }
  }

  return 0;
}

/** Candidate strings for linking Mantra shirt name ↔ FotMob (uses first/full name). */
export function nameMatchVariants(opts: {
  shirtName: string;
  firstName?: string | null;
  surname?: string | null;
  fullName?: string | null;
}): string[] {
  const out: string[] = [];
  const add = (v: string | null | undefined) => {
    const s = v?.trim();
    if (s && !out.includes(s)) out.push(s);
  };
  add(opts.shirtName);
  add(opts.fullName);
  add(opts.firstName);
  if (opts.firstName && opts.surname) {
    add(`${opts.firstName} ${opts.surname}`);
    add(`${opts.surname} ${opts.firstName}`);
  }
  add(opts.surname);
  return out;
}

export function namesMatchAny(candidates: string[], other: string): boolean {
  return candidates.some((c) => namesMatch(c, other));
}

export function normalizePos(pos: string | null | undefined): "GK" | "DEF" | "MID" | "ATT" | null {
  if (!pos) return null;
  const p = pos.toLowerCase();
  if (p.includes("goal") || p === "g" || p === "gk") return "GK";
  if (p.includes("defend") || p === "d" || p.includes("back") || p.includes("wing-back")) return "DEF";
  if (p.includes("mid") || p === "m") return "MID";
  if (p.includes("attack") || p.includes("forward") || p.includes("striker") || p === "f" || p === "a") return "ATT";
  if (p.includes("keeper")) return "GK";
  return null;
}
