import type { AdventureSeed } from "@llm-table/shared";

export type {
  AdventureSeed,
  AdventureSeedLocation,
  AdventureSeedNpc,
  AdventureSeedClock,
} from "@llm-table/shared";

export const ADVENTURE_SEEDS: AdventureSeed[] = [
  {
    id: "blank",
    title: "Blank slate (improv)",
    tone: "Whatever the table invents — wonder, danger, or comedy.",
    premise:
      "There is no prepared plot. Open with a vivid situation that fits the PCs, then discover the story together. Establish stakes early.",
    locations: [],
    npcs: [],
    secret: "There is no fixed secret. Invent one early and keep it consistent.",
    setPieces: ["A sudden complication that reframes the opening scene"],
  },
  {
    id: "haunted-mill",
    title: "The Mill on Blackwater",
    tone: "Folk horror, damp wood, whispered debts.",
    premise:
      "Villagers hire the party to clear the old mill before the spring flood. People who go in after dusk come back wrong — or not at all.",
    locations: [
      {
        name: "Blackwater village green",
        blurb: "Muddy square, nervous elders, a boarded well.",
      },
      {
        name: "The mill exterior",
        blurb: "Wheel jammed with weeds; windows like blind eyes.",
      },
      {
        name: "Grindstone floor",
        blurb: "Dust, chalk circles, and a rhythm that isn't the river.",
      },
      {
        name: "The undercroft",
        blurb: "Flooded cellar; something nested in the silt.",
      },
    ],
    npcs: [
      {
        name: "Marla Reed",
        motive: "Wants the mill usable again; hides that her brother vanished inside.",
      },
      {
        name: "Old Kem",
        motive: "Warns them off; secretly feeds the thing to keep the village 'safe'.",
      },
    ],
    secret:
      "Kem bound a river-hunger spirit to the millstone years ago. It is starving because the wheel stopped — and Marla's brother is still alive, half-claimed, in the undercroft.",
    clock: { name: "The hunger's patience", max: 6, start: 1 },
    setPieces: [
      "A villager begs them not to smash the stone — 'it keeps worse things out'",
      "The millstone turns once with no water",
    ],
  },
  {
    id: "night-heist",
    title: "Lanterns Over Glass",
    tone: "Stylish heist, witty tension, rooftop neon-fantasy.",
    premise:
      "A patron offers a fortune to steal the Mirror of False Dawns from the Skyvault Gallery during the Founders' Gala — without killing anyone.",
    locations: [
      {
        name: "Gala floor",
        blurb: "Masks, champagne, hired eyes in every mirror.",
      },
      {
        name: "Service corridors",
        blurb: "Steam, laundry carts, a schedule board that lies.",
      },
      {
        name: "Skyvault chamber",
        blurb: "The mirror under a lattice of light-wards.",
      },
      {
        name: "Rooftop escape route",
        blurb: "Glass ridges and a waiting skiff that may not wait.",
      },
    ],
    npcs: [
      {
        name: "Patron Vesper",
        motive: "Wants the mirror; will burn the crew if exposed.",
      },
      {
        name: "Curator Ilen",
        motive: "Proud of the wards; secretly already sold a copy once.",
      },
      {
        name: "Captain Rook",
        motive: "Gallery security chief who loves a fair chase.",
      },
    ],
    secret:
      "The Mirror on display is a decoy. The real one is worn as a mask by Curator Ilen during the gala. Vesper knows and is testing whether the party notices.",
    clock: { name: "Gala countdown", max: 8, start: 0 },
    setPieces: [
      "A toast forces everyone onto the floor — cameras sweep",
      "Rook offers a five-minute head start if they confess the patron",
    ],
  },
  {
    id: "lost-caravan",
    title: "Ashroad Missing",
    tone: "Desert mystery, heat shimmer, quiet dread.",
    premise:
      "A merchant guild pays the party to find a caravan that vanished on the Ashroad. Tracks lead toward a canyon the maps call empty.",
    locations: [
      {
        name: "Ashroad waystation",
        blurb: "Cracked cistern, one nervous clerk, wind full of grit.",
      },
      {
        name: "The false canyon",
        blurb: "Shadows that don't match the sun; camp remnants.",
      },
      {
        name: "Salt mirror flats",
        blurb: "Glare so bright it erases footprints.",
      },
    ],
    npcs: [
      {
        name: "Guild factor Sarn",
        motive: "Wants cargo recovered; cares less about the missing people.",
      },
      {
        name: "Guide Tolla",
        motive: "Knows a side path; owes a debt to whoever took the caravan.",
      },
    ],
    secret:
      "The caravan walked into a mirage-fold controlled by a salt-wight that feeds on names. Survivors forget who they were unless someone speaks their true name.",
    clock: { name: "Name-erosion", max: 5, start: 0 },
    setPieces: [
      "A survivor greets them warmly — and cannot say their own name",
      "Maps redraw themselves overnight",
    ],
  },
];

export function isBuiltinAdventureSeedId(id: string): boolean {
  return ADVENTURE_SEEDS.some((s) => s.id === id);
}

export function getAdventureSeed(id: string): AdventureSeed {
  const seed = ADVENTURE_SEEDS.find((s) => s.id === id);
  if (!seed) {
    throw new Error(`Unknown adventure seed: ${id}`);
  }
  return seed;
}

export function listAdventureSeeds(): Array<{
  id: string;
  title: string;
  tone: string;
  premise: string;
}> {
  return ADVENTURE_SEEDS.map((s) => ({
    id: s.id,
    title: s.title,
    tone: s.tone,
    premise: s.premise,
  }));
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

/** Validate and normalize a seed payload (built-in or custom). Fails loud on bad data. */
export function validateAdventureSeed(raw: unknown): AdventureSeed {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Adventure seed must be an object");
  }
  const s = raw as Record<string, unknown>;
  const id = requireNonEmptyString(s.id, "Seed id");
  const title = requireNonEmptyString(s.title, "Seed title");
  const tone = requireNonEmptyString(s.tone, "Seed tone");
  const premise = requireNonEmptyString(s.premise, "Seed premise");
  const secret = requireNonEmptyString(s.secret, "Seed secret");

  if (!Array.isArray(s.locations)) {
    throw new Error("Seed locations must be an array");
  }
  const locations = s.locations.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`locations[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    return {
      name: requireNonEmptyString(row.name, `locations[${index}].name`),
      blurb: requireNonEmptyString(row.blurb, `locations[${index}].blurb`),
    };
  });

  if (!Array.isArray(s.npcs)) {
    throw new Error("Seed npcs must be an array");
  }
  const npcs = s.npcs.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`npcs[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    return {
      name: requireNonEmptyString(row.name, `npcs[${index}].name`),
      motive: requireNonEmptyString(row.motive, `npcs[${index}].motive`),
    };
  });

  let clock: AdventureSeed["clock"];
  if (s.clock !== undefined && s.clock !== null) {
    if (typeof s.clock !== "object") {
      throw new Error("Seed clock must be an object");
    }
    const c = s.clock as Record<string, unknown>;
    const max = Number(c.max);
    if (!Number.isFinite(max) || max < 1) {
      throw new Error("Seed clock.max must be a positive number");
    }
    const startRaw = c.start;
    const start =
      startRaw === undefined || startRaw === null ? 0 : Math.trunc(Number(startRaw));
    if (!Number.isFinite(start) || start < 0) {
      throw new Error("Seed clock.start must be a non-negative number");
    }
    clock = {
      name: requireNonEmptyString(c.name, "clock.name"),
      max: Math.trunc(max),
      start,
    };
  }

  let setPieces: string[] | undefined;
  if (s.setPieces !== undefined && s.setPieces !== null) {
    if (!Array.isArray(s.setPieces)) {
      throw new Error("Seed setPieces must be an array");
    }
    setPieces = s.setPieces.map((item, index) => {
      if (typeof item !== "string" || !item.trim()) {
        throw new Error(`setPieces[${index}] must be a non-empty string`);
      }
      return item.trim();
    });
  }

  return {
    id,
    title,
    tone,
    premise,
    locations,
    npcs,
    secret,
    ...(clock ? { clock } : {}),
    ...(setPieces && setPieces.length > 0 ? { setPieces } : {}),
  };
}

/** Resolve built-in by id, or validate an explicit custom/built-in payload. */
export function resolveAdventureSeed(params: {
  adventureSeedId?: string;
  adventureSeed?: unknown;
}): AdventureSeed {
  if (params.adventureSeed !== undefined && params.adventureSeed !== null) {
    return validateAdventureSeed(params.adventureSeed);
  }
  const id = (params.adventureSeedId ?? "haunted-mill").trim();
  return getAdventureSeed(id);
}

export function formatSeedForGm(seed: AdventureSeed): string {
  const locations =
    seed.locations.length === 0
      ? "(none prepared — invent as needed)"
      : seed.locations.map((l) => `- ${l.name}: ${l.blurb}`).join("\n");
  const npcs =
    seed.npcs.length === 0
      ? "(none prepared — invent as needed)"
      : seed.npcs.map((n) => `- ${n.name}: ${n.motive}`).join("\n");
  const setPieces =
    seed.setPieces && seed.setPieces.length > 0
      ? seed.setPieces.map((s) => `- ${s}`).join("\n")
      : "(none)";

  return [
    `Seed: ${seed.title} (${seed.id})`,
    `Tone: ${seed.tone}`,
    `Premise: ${seed.premise}`,
    "",
    "Locations:",
    locations,
    "",
    "NPCs:",
    npcs,
    "",
    `Secret (GM only — do not reveal outright): ${seed.secret}`,
    seed.clock
      ? `Clock: ${seed.clock.name} (0-${seed.clock.max}, starts at ${seed.clock.start ?? 0})`
      : "Clock: none",
    "",
    "Optional set-pieces:",
    setPieces,
  ].join("\n");
}

export function publicSeedSummary(seed: AdventureSeed): {
  id: string;
  title: string;
  tone: string;
  premise: string;
} {
  return {
    id: seed.id,
    title: seed.title,
    tone: seed.tone,
    premise: seed.premise,
  };
}

export function blankCustomSeed(): AdventureSeed {
  return {
    id: crypto.randomUUID(),
    title: "New adventure",
    tone: "Tone goes here",
    premise: "What the party knows going in.",
    locations: [{ name: "Opening place", blurb: "What they see." }],
    npcs: [{ name: "Key NPC", motive: "What they want." }],
    secret: "GM-only truth. Keep it consistent.",
    clock: { name: "Pressure", max: 6, start: 0 },
    setPieces: ["A memorable complication"],
  };
}
