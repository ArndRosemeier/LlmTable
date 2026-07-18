/** Serializable adventure seed shared by client collection + server sessions. */

export interface AdventureSeedLocation {
  name: string;
  blurb: string;
}

export interface AdventureSeedNpc {
  name: string;
  motive: string;
}

export interface AdventureSeedClock {
  name: string;
  max: number;
  start?: number;
}

export interface AdventureSeed {
  id: string;
  title: string;
  tone: string;
  premise: string;
  locations: AdventureSeedLocation[];
  npcs: AdventureSeedNpc[];
  /** GM-only; never show to PCs. */
  secret: string;
  clock?: AdventureSeedClock;
  setPieces?: string[];
}
