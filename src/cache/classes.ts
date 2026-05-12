// Numeric class enums per layer. Workers tag each feature with a small int
// instead of a string, so the renderer can branch/pick colour with O(1) lookups.

export const RoadClass = {
  unknown: 0,
  motorway: 1,
  trunk: 2,
  primary: 3,
  secondary: 4,
  tertiary: 5,
  residential: 6,
  service: 7,
  unclassified: 8,
  living_street: 9,
} as const;
export type RoadClassValue = (typeof RoadClass)[keyof typeof RoadClass];

export const RoadWidthM: Record<number, number> = {
  [RoadClass.motorway]: 12,
  [RoadClass.trunk]: 10,
  [RoadClass.primary]: 8,
  [RoadClass.secondary]: 7,
  [RoadClass.tertiary]: 6,
  [RoadClass.residential]: 5,
  [RoadClass.service]: 3.5,
  [RoadClass.unclassified]: 5,
  [RoadClass.living_street]: 4,
  [RoadClass.unknown]: 4,
};

export const RailClass = {
  unknown: 0,
  rail: 1,
  subway: 2,
  light_rail: 3,
  tram: 4,
  monorail: 5,
} as const;

export const RailWidthM: Record<number, number> = {
  [RailClass.rail]: 2.5,
  [RailClass.subway]: 2.5,
  [RailClass.light_rail]: 2.5,
  [RailClass.tram]: 2,
  [RailClass.monorail]: 1.5,
  [RailClass.unknown]: 2,
};

export const PathClass = {
  unknown: 0,
  footway: 1,
  path: 2,
  cycleway: 3,
  pedestrian: 4,
  steps: 5,
} as const;

export const PathWidthM: Record<number, number> = {
  [PathClass.footway]: 1.5,
  [PathClass.path]: 1.2,
  [PathClass.cycleway]: 2,
  [PathClass.pedestrian]: 3,
  [PathClass.steps]: 1.5,
  [PathClass.unknown]: 1.2,
};

export const BuildingClass = {
  unknown: 0,
  residential: 1,
  commercial: 2,
  industrial: 3,
  civic: 4,
  religious: 5,
  transit: 6,
} as const;

export const LanduseClass = {
  unknown: 0,
  park: 1,
  forest: 2,
  grass: 3,
  cemetery: 4,
  residential: 5,
  industrial: 6,
  commercial: 7,
  retail: 8,
  school: 9,
  hospital: 10,
  pitch: 11,
} as const;

export const PoiClass = {
  unknown: 0,
  bus_stop: 1,
  station: 2,
  subway_entrance: 3,
  tram_stop: 4,
} as const;

export function classifyRoad(kind: string | undefined): number {
  if (!kind) return RoadClass.unknown;
  // Protomaps `roads` layer uses `kind` like "highway" + `kind_detail` for the OSM tag.
  // We accept either.
  const k = kind.toLowerCase();
  if (k === "motorway") return RoadClass.motorway;
  if (k === "trunk") return RoadClass.trunk;
  if (k === "primary") return RoadClass.primary;
  if (k === "secondary") return RoadClass.secondary;
  if (k === "tertiary") return RoadClass.tertiary;
  if (k === "residential") return RoadClass.residential;
  if (k === "service") return RoadClass.service;
  if (k === "living_street") return RoadClass.living_street;
  if (k === "unclassified") return RoadClass.unclassified;
  return RoadClass.unknown;
}

export function classifyRail(kind: string | undefined): number {
  if (!kind) return RailClass.unknown;
  const k = kind.toLowerCase();
  if (k === "rail") return RailClass.rail;
  if (k === "subway") return RailClass.subway;
  if (k === "light_rail") return RailClass.light_rail;
  if (k === "tram") return RailClass.tram;
  if (k === "monorail") return RailClass.monorail;
  return RailClass.unknown;
}

export function classifyPath(kind: string | undefined): number {
  if (!kind) return PathClass.unknown;
  const k = kind.toLowerCase();
  if (k === "footway") return PathClass.footway;
  if (k === "path") return PathClass.path;
  if (k === "cycleway") return PathClass.cycleway;
  if (k === "pedestrian") return PathClass.pedestrian;
  if (k === "steps") return PathClass.steps;
  return PathClass.unknown;
}

export function classifyLanduse(kind: string | undefined): number {
  if (!kind) return LanduseClass.unknown;
  const k = kind.toLowerCase();
  if (k === "park" || k === "national_park" || k === "nature_reserve") return LanduseClass.park;
  if (k === "forest" || k === "wood") return LanduseClass.forest;
  if (k === "grass" || k === "meadow" || k === "village_green") return LanduseClass.grass;
  if (k === "cemetery") return LanduseClass.cemetery;
  if (k === "residential") return LanduseClass.residential;
  if (k === "industrial") return LanduseClass.industrial;
  if (k === "commercial") return LanduseClass.commercial;
  if (k === "retail") return LanduseClass.retail;
  if (k === "school" || k === "college" || k === "university") return LanduseClass.school;
  if (k === "hospital") return LanduseClass.hospital;
  if (k === "pitch" || k === "stadium" || k === "playground") return LanduseClass.pitch;
  return LanduseClass.unknown;
}
