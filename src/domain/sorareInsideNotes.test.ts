import assert from "node:assert/strict";
import test from "node:test";
import {
  isSorareInsideChromeNoise,
  sanitizeSorareAnalystNote,
  sanitizeSorareAnalystNotesMap,
} from "./sorareInsideNotes.js";

/** Fixture resembling Automops Analyst notes · Kasımpaşa junk paste. */
const KASIMPASA_CHROME = `Score
AA
DA
APP
80%

Andreas Gianniotis

A. Yanar

20%

80%

Ayberk Karapo

J. Jessen

20%

80%

Kevin Mouanga

A. Dağbaşı

20%

SorareInside.com

MEDIUM RELIABILITY

First published: 2 days ago

·

Updated 2 days ago

·

47

Starting % Key

90%

Highly likely to start the match. Only, 'unforeseen circumstances' would prevent it.

80%

Likely to start the match under 'normal circumstances', however could not be described as 'nailed on'.

70%

Fairly good chance that the player will start the match, but still some risk due to potential factors.

60%

A reasonable risk that the player will not start, but slightly more likely than not.

50%

We don't know with any certainty whether the player will start. The chances to start/not start cannot be split.

40%

Reasonable chance to start, but factors lean against starting.

30%

Has some chances to start, but still quite unlikely.

20%

Unlikely to start, but has a small chance.

10%

Very unlikely to start.

0%

Will not start (injury, suspension, not in squad, did not travel etc.).

Potential Factors to not start may include, (but are not exclusive to):

• Tactical decision by the Coach/Manager

• Squad Rotation

• Player has recently returned to training`;

test("detects Kasımpaşa-style SI pitch chrome as noise", () => {
  assert.equal(isSorareInsideChromeNoise(KASIMPASA_CHROME), true);
  assert.equal(sanitizeSorareAnalystNote(KASIMPASA_CHROME), "");
});

test("keeps real analyst prose", () => {
  const prose =
    "Gianniotis is the preferred starter. Yanar only covers if rotated after midweek.";
  assert.equal(isSorareInsideChromeNoise(prose), false);
  assert.equal(sanitizeSorareAnalystNote(prose), prose);
});

test("drops empty / none placeholders", () => {
  assert.equal(sanitizeSorareAnalystNote("none"), "");
  assert.equal(sanitizeSorareAnalystNote("."), "");
  assert.equal(sanitizeSorareAnalystNote("  "), "");
});

test("sanitizeSorareAnalystNotesMap omits chrome fields", () => {
  const cleaned = sanitizeSorareAnalystNotesMap({
    teamAnalysis: KASIMPASA_CHROME,
    injuriesAndRecovery: "Hamstring: Winck doubtful, late fitness test.",
    suspensionsAndIneligibilities: KASIMPASA_CHROME,
  });
  assert.equal(cleaned.teamAnalysis, undefined);
  assert.equal(cleaned.suspensionsAndIneligibilities, undefined);
  assert.match(cleaned.injuriesAndRecovery || "", /Hamstring/);
});
