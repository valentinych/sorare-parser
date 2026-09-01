export type Expected11LineupGroup = "starting" | "bench" | "out";

export const STARTING_XI_FALLBACK_PERCENTAGE = 66;

export function withStartingXiFallbackPercentage(
  group: Expected11LineupGroup,
  percentage: number | null | undefined,
): number | null {
  if (group === "starting" && (percentage == null || percentage === 0)) {
    return STARTING_XI_FALLBACK_PERCENTAGE;
  }
  return percentage ?? null;
}

type Expected11RawPlayer = {
  team: string | null;
  name: string | null;
  href: string | null;
  rawText: string;
  ariaLabel: string | null;
  starterText: string | null;
  statusText: string | null;
};

type Expected11RawTeamPlayer = {
  name: string | null;
  href: string | null;
  rawText: string;
  displayedText: string | null;
  displayedAriaLabel: string | null;
};

type Expected11RawNarrative = {
  label: string;
  text: string;
};

type Expected11RawTeam = {
  side: "home" | "away" | null;
  name: string | null;
  logoUrl: string | null;
  lineup: Record<Expected11LineupGroup, Expected11RawTeamPlayer[]>;
  notes: {
    teamAnalysis: Expected11RawNarrative | null;
    injuriesAndRecovery: Expected11RawNarrative | null;
    suspensionsAndIneligibilities: Expected11RawNarrative | null;
    additionalNotes: Expected11RawNarrative | null;
  };
  author: string | null;
};

export type Expected11Snapshot = {
  sourceUrl: string;
  extractedAt: string;
  pageTitle: string;
  homeTeam: string | null;
  awayTeam: string | null;
  formations: string[];
  accessMessage: string | null;
  signInVisible: boolean;
  pageLoading: boolean;
  headings: string[];
  visibleLineupCount: number;
  restrictedPositionCount: number;
  rawTeams: Expected11RawTeam[];
  rawPlayers: Expected11RawPlayer[];
};

export type Expected11LineupPlayer = {
  name: string;
  displayedPercentage: number | null;
  displayedLabel: string | null;
  raw: {
    text: string;
    ariaLabel: string | null;
    playerPath: string | null;
  };
};

export type Expected11Team = {
  side: "home" | "away" | null;
  name: string;
  logoUrl: string | null;
  lineup: Record<Expected11LineupGroup, Expected11LineupPlayer[]>;
  notes: {
    teamAnalysis: Expected11RawNarrative | null;
    injuriesAndRecovery: Expected11RawNarrative | null;
    suspensionsAndIneligibilities: Expected11RawNarrative | null;
    additionalNotes: Expected11RawNarrative | null;
  };
  author: string | null;
};

export type Expected11Match = {
  sourceUrl: string;
  extractedAt: string;
  status: "ok" | "no-predictions" | "login-required";
  match: {
    id: string | null;
    title: string;
    homeTeam: string | null;
    awayTeam: string | null;
    formations: string[];
  };
  teams: Expected11Team[];
  players: Array<{
    team: string | null;
    name: string;
    lineupGroup?: Expected11LineupGroup;
    probabilities: {
      starter: number | null;
      substitute: number | null;
      notPlaying: number | null;
    };
    predictionLabel: string;
    raw: {
      text: string;
      ariaLabel: string | null;
      starterText: string | null;
      statusText: string | null;
      playerPath: string | null;
    };
  }>;
  diagnostics: {
    accessMessage: string | null;
    signInVisible: boolean;
    pageLoading: boolean;
    headings: string[];
    visibleLineupCount: number;
    restrictedPositionCount: number;
    rawPlayerCandidateCount: number;
    warnings: string[];
  };
};

type SnapshotOptions = {
  sourceUrl: string;
  extractedAt: string;
  assumeVisible?: boolean;
};

export function collectExpected11Snapshot(
  root: ParentNode,
  options: SnapshotOptions,
): Expected11Snapshot {
  const helpers = {
    clean(value: string | null | undefined) {
      return value?.replace(/\s+/g, " ").trim() ?? "";
    },
    text(element: Element | null) {
      return helpers.clean(element?.textContent);
    },
    multilineText(element: Element | null) {
      if (!element) return "";
      const innerText = (element as HTMLElement).innerText;
      const value =
        typeof innerText === "string" && innerText.trim()
          ? innerText
          : element.textContent;
      return (value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/[^\S\n]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    },
    isVisible(element: Element) {
      if (
        element.getAttribute("aria-hidden") === "true" ||
        element.hasAttribute("hidden")
      ) {
        return false;
      }
      if (options.assumeVisible) return true;
      const view = element.ownerDocument.defaultView;
      const style = view?.getComputedStyle?.(element);
      if (style?.display === "none" || style?.visibility === "hidden") return false;
      const getClientRects = (element as Element & {
        getClientRects?: () => { length: number };
      }).getClientRects;
      return (
        typeof getClientRects !== "function" ||
        getClientRects.call(element).length > 0
      );
    },
    visible(selector: string) {
      return Array.from(root.querySelectorAll(selector)).filter((element) =>
        helpers.isVisible(element),
      );
    },
    firstVisibleText(selector: string) {
      return helpers.text(helpers.visible(selector)[0] ?? null) || null;
    },
    playerNameFromRaw(value: string) {
      const lines = value
        .split("\n")
        .map((line) => helpers.clean(line))
        .filter(Boolean);
      if (lines.length > 1 && /^[A-Z]{2}$/.test(lines[0]!)) lines.shift();
      if (/^\d+(?:\.\d+)?\s*%$/.test(lines.at(-1) ?? "")) lines.pop();
      return helpers
        .clean(lines.join(" "))
        .replace(/\s+\d+(?:\.\d+)?\s*%$/, "")
        .replace(/\s+\?$/, "")
        .replace(/^[A-Z]{2}\s+(?=\p{Lu})/u, "");
    },
  };
  const {
    clean,
    text,
    multilineText,
    isVisible,
    visible,
    firstVisibleText,
    playerNameFromRaw,
  } = helpers;
  const homeTeam = firstVisibleText(".match-view__team-label--home");
  const awayTeam = firstVisibleText(".match-view__team-label--away");

  const semantics = {
    normalizedHeading(value: string) {
      return clean(value)
        .toLocaleLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    },
    lineupGroup(value: string): Expected11LineupGroup | null {
      const heading = semantics.normalizedHeading(value);
      if (heading === "starting") return "starting";
      if (heading === "bench") return "bench";
      if (heading === "out") return "out";
      return null;
    },
    noteKey(
      value: string,
    ):
      | "teamAnalysis"
      | "injuriesAndRecovery"
      | "suspensionsAndIneligibilities"
      | "additionalNotes"
      | null {
      const heading = semantics.normalizedHeading(value);
      if (heading === "team analysis") return "teamAnalysis";
      if (heading === "injuries and recovery") return "injuriesAndRecovery";
      if (heading === "suspensions and ineligibilities") {
        return "suspensionsAndIneligibilities";
      }
      if (heading === "additional notes") return "additionalNotes";
      return null;
    },
    sideFor(
      name: string | null,
      element: Element,
    ): "home" | "away" | null {
      if (
        name &&
        homeTeam &&
        semantics.normalizedHeading(name) === semantics.normalizedHeading(homeTeam)
      ) {
        return "home";
      }
      if (
        name &&
        awayTeam &&
        semantics.normalizedHeading(name) === semantics.normalizedHeading(awayTeam)
      ) {
        return "away";
      }
      if (element.classList.contains("match-view__squad-team--home")) return "home";
      if (element.classList.contains("match-view__squad-team--away")) return "away";
      if (element.classList.contains("match-view__expert-notes-card--home")) {
        return "home";
      }
      if (element.classList.contains("match-view__expert-notes-card--away")) {
        return "away";
      }
      return null;
    },
    safeImageUrl(element: Element | null) {
      const src = element?.getAttribute("src");
      if (!src) return null;
      try {
        const url = new URL(src, options.sourceUrl);
        return url.protocol === "https:" || url.protocol === "http:"
          ? url.toString()
          : null;
      } catch {
        return null;
      }
    },
    emptyRawTeam(
      name: string | null,
      side: "home" | "away" | null,
      logoUrl: string | null,
    ): Expected11RawTeam {
      return {
        side,
        name,
        logoUrl,
        lineup: { starting: [], bench: [], out: [] },
        notes: {
          teamAnalysis: null,
          injuriesAndRecovery: null,
          suspensionsAndIneligibilities: null,
          additionalNotes: null,
        },
        author: null,
      };
    },
  };

  const allHeadings = visible("h1, h2, h3, h4, h5, h6");
  const squadContainers = new Map<Element, Expected11RawTeam>();
  for (const heading of allHeadings) {
    const group = semantics.lineupGroup(text(heading));
    if (!group) continue;
    const section = heading.closest("section") ?? heading.parentElement;
    if (!section) continue;
    const rows = Array.from(section.querySelectorAll("li")).filter(isVisible);
    const container = heading.closest("article") ?? section.parentElement;
    if (!container) continue;

    let team = squadContainers.get(container);
    if (!team) {
      const teamHeading =
        Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6"))
          .filter(isVisible)
          .find(
            (candidate) =>
              !semantics.lineupGroup(text(candidate)) &&
              !semantics.noteKey(text(candidate)),
          ) ??
        null;
      const name = text(teamHeading) || null;
      team = semantics.emptyRawTeam(
        name,
        semantics.sideFor(name, container),
        semantics.safeImageUrl(teamHeading?.querySelector("img[src]") ?? null),
      );
      squadContainers.set(container, team);
    }

    for (const row of rows) {
      const playerLink = Array.from(row.querySelectorAll('a[href*="/player/"]')).find(
        isVisible,
      ) as HTMLAnchorElement | undefined;
      const nameElement =
        playerLink ??
        (Array.from(row.querySelectorAll("[data-player-name]")).find(isVisible) as
          | Element
          | undefined);
      const rawText = multilineText(row).slice(0, 500);
      const name =
        clean(
          row.getAttribute("data-player-name") ??
            nameElement?.getAttribute("data-player-name"),
        ) ||
        text(nameElement ?? null) ||
        playerNameFromRaw(rawText) ||
        null;
      const percentageElements = Array.from(row.querySelectorAll("*")).filter(
        (element) =>
          isVisible(element) &&
          /\d+(?:\.\d+)?\s*%/.test(
            `${element.getAttribute("aria-label") ?? ""} ${text(element)}`,
          ),
      );
      const percentageElement =
        percentageElements.find((element) =>
          /^\d+(?:\.\d+)?\s*%$/.test(text(element)),
        ) ??
        percentageElements.find((element) =>
          /\d+(?:\.\d+)?\s*%/.test(element.getAttribute("aria-label") ?? ""),
        ) ??
        null;
      const displayedMatch = text(percentageElement).match(/\d+(?:\.\d+)?\s*%/);

      team.lineup[group].push({
        name,
        href: playerLink?.getAttribute("href") ?? null,
        rawText,
        displayedText: displayedMatch?.[0].replace(/\s+/g, "") ?? null,
        displayedAriaLabel:
          clean(percentageElement?.getAttribute("aria-label")) || null,
      });
    }
  }

  const rawTeams = Array.from(squadContainers.values());
  for (const heading of allHeadings) {
    const key = semantics.noteKey(text(heading));
    if (!key) continue;
    const section = heading.closest("section") ?? heading.parentElement;
    if (!section) continue;
    const card = heading.closest("article") ?? section.parentElement;
    if (!card) continue;
    const teamHeading =
      Array.from(card.querySelectorAll("h1, h2, h3, h4, h5, h6"))
        .filter(isVisible)
        .find(
          (candidate) =>
            !semantics.lineupGroup(text(candidate)) &&
            !semantics.noteKey(text(candidate)),
        ) ??
      null;
    const name = text(teamHeading) || null;
    const side = semantics.sideFor(name, card);
    let team =
      rawTeams.find(
        (candidate) =>
          name &&
          candidate.name &&
          semantics.normalizedHeading(candidate.name) ===
            semantics.normalizedHeading(name),
      ) ??
      rawTeams.find((candidate) => side && candidate.side === side);
    if (!team) {
      team = semantics.emptyRawTeam(
        name,
        side,
        semantics.safeImageUrl(teamHeading?.querySelector("img[src]") ?? null),
      );
      rawTeams.push(team);
    } else if (!team.logoUrl) {
      team.logoUrl = semantics.safeImageUrl(
        teamHeading?.querySelector("img[src]") ?? null,
      );
    }

    const copy = Array.from(section.children)
      .filter((element) => element !== heading && isVisible(element))
      .map((element) => multilineText(element))
      .filter(Boolean)
      .join("\n\n");
    team.notes[key] = {
      label: multilineText(heading),
      text: copy,
    };
    const footer = Array.from(card.querySelectorAll("footer")).find(isVisible) ?? null;
    team.author = text(footer) || team.author;
  }

  const lineupElements = visible(
    '.lineup[aria-label*="starting lineup"], .lineup--home, .lineup--away',
  ).filter((element, index, all) => all.indexOf(element) === index);

  // Keep the DOM walk self-contained so Playwright can serialize this function.
  const playerRows: Expected11Snapshot["rawPlayers"] = [];
  for (const lineup of lineupElements) {
    const lineupLabel = clean(lineup.getAttribute("aria-label"));
    const team =
      lineupLabel.replace(/\s+starting lineup$/i, "").trim() ||
      (lineup.classList.contains("lineup--home")
        ? firstVisibleText(".match-view__team-label--home")
        : firstVisibleText(".match-view__team-label--away"));
    const articles = Array.from(
      lineup.querySelectorAll("article.lineup-position, [data-player-name]"),
    ).filter(isVisible);

    for (const article of articles) {
      const playerLink = Array.from(
        article.querySelectorAll('a[href*="/player/"]'),
      ).find(isVisible) as HTMLAnchorElement | undefined;
      const nameElement = [
        playerLink,
        article.querySelector("[data-player-name]"),
        article.querySelector(".lineup-position__name"),
        article.querySelector(".lineup-position__starter"),
        article.querySelector(".lineup-position__identity"),
      ].find((element) => element && isVisible(element));
      const candidateName =
        clean(article.getAttribute("data-player-name")) ||
        clean(nameElement?.getAttribute("data-player-name")) ||
        text(nameElement ?? null);
      const name =
        candidateName && !/^\d+(?:\.\d+)?%$/.test(candidateName)
          ? candidateName
          : null;
      const starterElement = Array.from(
        article.querySelectorAll(
          ".starting-odds-badge, [data-start-probability], [aria-label*=\"starting\"]",
        ),
      ).find(isVisible);
      const statusElement = Array.from(
        article.querySelectorAll(
          ".lineup-position__status, [data-prediction-status], [data-status]",
        ),
      ).find(isVisible);

      playerRows.push({
        team: team || null,
        name,
        href: playerLink?.getAttribute("href") ?? null,
        rawText: clean(article.textContent).slice(0, 500),
        ariaLabel: clean(article.getAttribute("aria-label")) || null,
        starterText:
          clean(starterElement?.getAttribute("aria-label")) ||
          text(starterElement ?? null) ||
          null,
        statusText:
          clean(
            statusElement?.getAttribute("data-prediction-status") ??
              statusElement?.getAttribute("data-status"),
          ) ||
          text(statusElement ?? null) ||
          null,
      });
    }
  }

  return {
    sourceUrl: options.sourceUrl,
    extractedAt: options.extractedAt,
    pageTitle: clean(root.ownerDocument?.title),
    homeTeam,
    awayTeam,
    formations: visible(".match-view__formations")
      .flatMap((element) => multilineText(element).match(/\d+(?:-\d+){2,}/g) ?? [])
      .slice(0, 2),
    accessMessage: firstVisibleText(".lineup-access-cta"),
    signInVisible:
      visible(
        'a[href="/sign-in"], a[href^="/sign-in?"], .layout-auth-controls__signed-out',
      ).length > 0,
    pageLoading:
      visible(
        ".match-view--loading, [aria-label='Loading home team squad'], [aria-label='Loading away team squad']",
      ).length > 0,
    headings: allHeadings
      .map((element) => text(element))
      .filter(Boolean)
      .slice(0, 30),
    visibleLineupCount: squadContainers.size || lineupElements.length,
    restrictedPositionCount: visible(".lineup-position--restricted").length,
    rawTeams,
    rawPlayers: playerRows,
  };
}

function probabilityNearLabel(raw: string, labels: string[]): number | null {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = raw.match(
      new RegExp(`(\\d+(?:\\.\\d+)?)\\s*%[^.]{0,40}${escaped}`, "i"),
    );
    const after = raw.match(
      new RegExp(`${escaped}[^\\d.]{0,40}(\\d+(?:\\.\\d+)?)\\s*%`, "i"),
    );
    const value = Number(after?.[1] ?? before?.[1]);
    if (Number.isFinite(value) && value >= 0 && value <= 100) return value / 100;
  }
  return null;
}

export function normalizeExpected11Snapshot(
  snapshot: Expected11Snapshot,
): Expected11Match {
  function displayedPercentage(value: string | null): number | null {
    const parsed = Number(value?.match(/(\d+(?:\.\d+)?)\s*%/)?.[1]);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
  }

  function normalizeTeamPlayer(
    player: Expected11RawTeamPlayer,
    group: Expected11LineupGroup,
  ): Expected11LineupPlayer | null {
    if (!player.name) return null;
    const parsed = displayedPercentage(player.displayedText);
    const percentage = withStartingXiFallbackPercentage(group, parsed);
    return {
      name: player.name,
      displayedPercentage: percentage,
      displayedLabel:
        percentage != null && (parsed == null || parsed === 0)
          ? `${percentage}%`
          : player.displayedText,
      raw: {
        text: player.rawText,
        ariaLabel: player.displayedAriaLabel,
        playerPath: player.href,
      },
    };
  }

  const teams: Expected11Team[] = snapshot.rawTeams
    .filter((team): team is Expected11RawTeam & { name: string } => Boolean(team.name))
    .map((team) => ({
      side: team.side,
      name: team.name,
      logoUrl: team.logoUrl,
      lineup: {
        starting: team.lineup.starting
          .map((player) => normalizeTeamPlayer(player, "starting"))
          .filter((player): player is Expected11LineupPlayer => Boolean(player)),
        bench: team.lineup.bench
          .map((player) => normalizeTeamPlayer(player, "bench"))
          .filter((player): player is Expected11LineupPlayer => Boolean(player)),
        out: team.lineup.out
          .map((player) => normalizeTeamPlayer(player, "out"))
          .filter((player): player is Expected11LineupPlayer => Boolean(player)),
      },
      notes: team.notes,
      author: team.author,
    }));

  const players =
    teams.length > 0
      ? teams.flatMap((team) =>
          (["starting", "bench", "out"] as const).flatMap((group) =>
            team.lineup[group].map((player) => {
              const probabilityText = [
                player.raw.ariaLabel,
                player.displayedLabel,
                player.raw.text,
              ]
                .filter(Boolean)
                .join(". ");
              return {
                team: team.name,
                name: player.name,
                lineupGroup: group,
                probabilities: {
                  starter:
                    probabilityNearLabel(probabilityText, [
                      "chance of starting",
                      "starting",
                      "starter",
                    ]) ??
                    (player.displayedPercentage != null
                      ? player.displayedPercentage / 100
                      : null),
                  substitute: probabilityNearLabel(probabilityText, [
                    "substitute",
                    "substitution",
                  ]),
                  notPlaying: probabilityNearLabel(probabilityText, [
                    "not playing",
                    "non-playing",
                    "not in squad",
                  ]),
                },
                predictionLabel: player.displayedLabel ?? player.raw.text,
                raw: {
                  text: player.raw.text,
                  ariaLabel: player.raw.ariaLabel,
                  starterText: player.raw.ariaLabel ?? player.displayedLabel,
                  statusText: null,
                  playerPath: player.raw.playerPath,
                },
              };
            }),
          ),
        )
      : snapshot.rawPlayers
          .filter(
            (player): player is typeof player & { name: string } =>
              Boolean(player.name),
          )
          .map((player) => {
            const predictionLabel =
              player.statusText ||
              player.starterText ||
              player.ariaLabel ||
              player.rawText;
            const probabilityText = [
              player.starterText,
              player.statusText,
              player.ariaLabel,
              player.rawText,
            ]
              .filter(Boolean)
              .join(". ");
            return {
              team: player.team,
              name: player.name,
              probabilities: {
                starter:
                  probabilityNearLabel(probabilityText, [
                    "chance of starting",
                    "starting",
                    "starter",
                    "confidence",
                  ]) ?? STARTING_XI_FALLBACK_PERCENTAGE / 100,
                substitute: probabilityNearLabel(probabilityText, [
                  "substitute",
                  "substitution",
                ]),
                notPlaying: probabilityNearLabel(probabilityText, [
                  "not playing",
                  "non-playing",
                  "not in squad",
                ]),
              },
              predictionLabel,
              raw: {
                text: player.rawText,
                ariaLabel: player.ariaLabel,
                starterText: player.starterText,
                statusText: player.statusText,
                playerPath: player.href,
              },
            };
          });

  const warnings: string[] = [];
  if (snapshot.visibleLineupCount === 0) {
    warnings.push("No visible starting-lineup containers matched the expected page semantics.");
  }
  if (players.length === 0) {
    warnings.push("No visible player names were found.");
  }
  if (snapshot.restrictedPositionCount > 0) {
    warnings.push(
      `${snapshot.restrictedPositionCount} visible lineup positions are access-restricted.`,
    );
  }
  const placeholderPlayerCount = snapshot.rawTeams.reduce(
    (count, team) =>
      count +
      (["starting", "bench", "out"] as const).reduce(
        (teamCount, group) =>
          teamCount +
          team.lineup[group].filter(
            (player) =>
              !player.href &&
              /\?\s*(?:\d+(?:\.\d+)?\s*%)?\s*$/.test(player.rawText),
          ).length,
        0,
      ),
    0,
  );
  if (placeholderPlayerCount > 0) {
    warnings.push(
      `${placeholderPlayerCount} visible player rows use placeholder markup without a player profile.`,
    );
  }
  for (const [side, expectedName] of [
    ["home", snapshot.homeTeam],
    ["away", snapshot.awayTeam],
  ] as const) {
    if (!expectedName) continue;
    const team = teams.find((candidate) => candidate.side === side);
    if (!team) {
      warnings.push(`Expected ${side} team "${expectedName}" was not parsed.`);
      continue;
    }
    const playerCount =
      team.lineup.starting.length + team.lineup.bench.length + team.lineup.out.length;
    if (playerCount === 0) {
      warnings.push(`No visible player names were found for ${expectedName}.`);
    }
  }

  const matchId =
    new URL(snapshot.sourceUrl).pathname.match(/^\/match\/(\d+)(?:\/|$)/)?.[1] ?? null;

  const loginRequired =
    players.length === 0 &&
    teams.length === 0 &&
    (snapshot.signInVisible ||
      Boolean(snapshot.accessMessage) ||
      snapshot.restrictedPositionCount > 0 ||
      snapshot.pageLoading);
  const status: Expected11Match["status"] = loginRequired
    ? "login-required"
    : players.length > 0 || teams.length > 0
      ? "ok"
      : "no-predictions";

  return {
    sourceUrl: snapshot.sourceUrl,
    extractedAt: snapshot.extractedAt,
    status,
    match: {
      id: matchId,
      title:
        snapshot.pageTitle.replace(/\s*\|\s*Expected 11\s*$/i, "").trim() ||
        [snapshot.homeTeam, snapshot.awayTeam].filter(Boolean).join(" vs "),
      homeTeam: snapshot.homeTeam,
      awayTeam: snapshot.awayTeam,
      formations: snapshot.formations,
    },
    teams,
    players,
    diagnostics: {
      accessMessage: snapshot.accessMessage,
      signInVisible: snapshot.signInVisible,
      pageLoading: snapshot.pageLoading,
      headings: snapshot.headings,
      visibleLineupCount: snapshot.visibleLineupCount,
      restrictedPositionCount: snapshot.restrictedPositionCount,
      rawPlayerCandidateCount:
        snapshot.rawTeams.reduce(
          (count, team) =>
            count +
            team.lineup.starting.length +
            team.lineup.bench.length +
            team.lineup.out.length,
          0,
        ) || snapshot.rawPlayers.length,
      warnings,
    },
  };
}
