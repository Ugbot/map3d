// Numeric class enums per layer. Workers tag each feature with a small int
// instead of a string, so the renderer can branch/pick colour with O(1) lookups.

import { assert, assertFinite, assertInRange } from "@map3d/data-core";

// Public classifier contract: input is the raw tag string from the source
// vector tile (potentially undefined). We assert the type invariant — bad
// types here mean a parser bug, not user data.
function assertTagInput(s: string | undefined, where: string): void {
  assert(s === undefined || typeof s === "string", `${where}: tag not string|undefined`);
}

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

// Widths optimised for visual clarity at altitude, not OSM realism. This is
// a simulation display — the network needs to read at a glance.
export const RoadWidthM: Record<number, number> = {
  [RoadClass.motorway]: 48,
  [RoadClass.trunk]: 40,
  [RoadClass.primary]: 32,
  [RoadClass.secondary]: 24,
  [RoadClass.tertiary]: 18,
  [RoadClass.residential]: 14,
  [RoadClass.service]: 10,
  [RoadClass.unclassified]: 12,
  [RoadClass.living_street]: 10,
  [RoadClass.unknown]: 12,
};

// Per-class colour for road ribbons. Saturated so the hierarchy reads at
// altitude even on a bright ground — this is a simulation display, not a
// realistic asphalt tint.
export const RoadColor: Record<number, number> = {
  [RoadClass.motorway]: 0xff8a3c,
  [RoadClass.trunk]: 0xff7a30,
  [RoadClass.primary]: 0xffc24a,
  [RoadClass.secondary]: 0xf2d077,
  [RoadClass.tertiary]: 0xe0c498,
  [RoadClass.residential]: 0xb8a890,
  [RoadClass.service]: 0x8a7e6c,
  [RoadClass.unclassified]: 0xb8a890,
  [RoadClass.living_street]: 0xb8a890,
  [RoadClass.unknown]: 0xa09080,
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
  [RailClass.rail]: 16,
  [RailClass.subway]: 14,
  [RailClass.light_rail]: 14,
  [RailClass.tram]: 10,
  [RailClass.monorail]: 10,
  [RailClass.unknown]: 12,
};

// Rail colour palette — bright magenta/violet so it stays distinct from
// roads at any zoom and reads through the night ramp.
export const RailColor: Record<number, number> = {
  [RailClass.rail]: 0xd6a8ff,
  [RailClass.subway]: 0xc18bff,
  [RailClass.light_rail]: 0xcfa3ff,
  [RailClass.tram]: 0xb898ff,
  [RailClass.monorail]: 0xb898ff,
  [RailClass.unknown]: 0xc18bff,
};

export const PathClass = {
  unknown: 0,
  footway: 1,
  path: 2,
  cycleway: 3,
  pedestrian: 4,
  steps: 5,
} as const;

// Path colour palette — subtle tan, not competing with roads.
export const PathColor: Record<number, number> = {
  [PathClass.footway]: 0xb5a890,
  [PathClass.path]: 0xa89880,
  [PathClass.cycleway]: 0xa8b888,
  [PathClass.pedestrian]: 0xc2b298,
  [PathClass.steps]: 0xa89070,
  [PathClass.unknown]: 0xa89880,
};

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
  transit: 1,
  food: 2,
  shop: 3,
  leisure: 4,
  health: 5,
  education: 6,
  civic: 7,
  accommodation: 8,
  attraction: 9,
  worship: 10,
  emergency: 11,
} as const;
export type PoiClassValue = (typeof PoiClass)[keyof typeof PoiClass];

export const PoiColor: Record<number, number> = {
  [PoiClass.unknown]: 0x9aa3ad,
  [PoiClass.transit]: 0xffd166, // gold
  [PoiClass.food]: 0xff7a59, // coral
  [PoiClass.shop]: 0x6bd1c9, // teal
  [PoiClass.leisure]: 0x9bd96b, // lime
  [PoiClass.health]: 0xff5a7e, // pink-red (medical)
  [PoiClass.education]: 0x8aa6ff, // periwinkle
  [PoiClass.civic]: 0xd1b48a, // sand
  [PoiClass.accommodation]: 0xc18bff, // lilac
  [PoiClass.attraction]: 0xffb347, // amber
  [PoiClass.worship]: 0xe6c97a, // muted gold
  [PoiClass.emergency]: 0xff3030, // alarm red
};

// OpenMapTiles `poi.class` is a coarse string. Map to our bucket enum.
export function classifyPoiOMT(cls: string | undefined): number {
  assertTagInput(cls, "classifyPoiOMT");
  if (!cls) return PoiClass.unknown;
  const k = cls.toLowerCase();
  if (k === "bus" || k === "railway" || k === "aerialway" || k === "ferry_terminal" || k === "airport" || k === "harbor" || k === "park_ride") return PoiClass.transit;
  if (k === "restaurant" || k === "fast_food" || k === "cafe" || k === "bar" || k === "pub" || k === "food_court" || k === "ice_cream") return PoiClass.food;
  if (k === "shop" || k === "convenience" || k === "supermarket" || k === "department_store" || k === "mall" || k === "marketplace" || k === "kiosk") return PoiClass.shop;
  if (k === "park" || k === "garden" || k === "playground" || k === "pitch" || k === "stadium" || k === "swimming_pool" || k === "sports_centre" || k === "beach") return PoiClass.leisure;
  if (k === "hospital" || k === "clinic" || k === "doctors" || k === "dentist" || k === "pharmacy") return PoiClass.health;
  if (k === "school" || k === "college" || k === "university" || k === "kindergarten" || k === "library") return PoiClass.education;
  if (k === "town_hall" || k === "courthouse" || k === "embassy" || k === "post_office" || k === "police" || k === "fire_station") return k === "police" || k === "fire_station" ? PoiClass.emergency : PoiClass.civic;
  if (k === "hotel" || k === "motel" || k === "hostel" || k === "guest_house" || k === "campsite" || k === "caravan_site") return PoiClass.accommodation;
  if (k === "tourism" || k === "museum" || k === "monument" || k === "memorial" || k === "viewpoint" || k === "attraction" || k === "art_gallery" || k === "theatre" || k === "cinema" || k === "zoo") return PoiClass.attraction;
  if (k === "place_of_worship" || k === "religion") return PoiClass.worship;
  return PoiClass.unknown;
}

export const WaterwayClass = {
  unknown: 0,
  river: 1,
  stream: 2,
  canal: 3,
  drain: 4,
  ditch: 5,
} as const;
export const WaterwayWidthM: Record<number, number> = {
  [WaterwayClass.river]: 18,
  [WaterwayClass.stream]: 4,
  [WaterwayClass.canal]: 14,
  [WaterwayClass.drain]: 2.5,
  [WaterwayClass.ditch]: 1.5,
  [WaterwayClass.unknown]: 4,
};
export function classifyWaterway(s: string | undefined): number {
  assertTagInput(s, "classifyWaterway");
  if (!s) return WaterwayClass.unknown;
  const k = s.toLowerCase();
  if (k === "river") return WaterwayClass.river;
  if (k === "stream") return WaterwayClass.stream;
  if (k === "canal") return WaterwayClass.canal;
  if (k === "drain") return WaterwayClass.drain;
  if (k === "ditch") return WaterwayClass.ditch;
  return WaterwayClass.unknown;
}

// OMT landcover.class enum + colour palette. Subclass refines it if needed.
export const LandcoverClass = {
  unknown: 0,
  grass: 1,
  wood: 2,
  sand: 3,
  rock: 4,
  ice: 5,
  wetland: 6,
  farmland: 7,
  urban: 8,
} as const;
export const LandcoverColor: Record<number, number> = {
  [LandcoverClass.unknown]: 0x5a5a5a,
  [LandcoverClass.grass]: 0x5c8a5a,
  [LandcoverClass.wood]: 0x3e6b3a,
  [LandcoverClass.sand]: 0xc2a878,
  [LandcoverClass.rock]: 0x7a7268,
  [LandcoverClass.ice]: 0xdde6ea,
  [LandcoverClass.wetland]: 0x5c7a72,
  [LandcoverClass.farmland]: 0x8b9d5a,
  [LandcoverClass.urban]: 0x5a5a5a,
};
export function classifyLandcover(cls: string | undefined): number {
  assertTagInput(cls, "classifyLandcover");
  if (!cls) return LandcoverClass.unknown;
  const k = cls.toLowerCase();
  if (k === "grass") return LandcoverClass.grass;
  if (k === "wood") return LandcoverClass.wood;
  if (k === "sand") return LandcoverClass.sand;
  if (k === "rock") return LandcoverClass.rock;
  if (k === "ice" || k === "snow") return LandcoverClass.ice;
  if (k === "wetland") return LandcoverClass.wetland;
  if (k === "farmland") return LandcoverClass.farmland;
  if (k === "urban" || k === "residential") return LandcoverClass.urban;
  return LandcoverClass.unknown;
}

// ITU-R M.1371 AIS ship-type code → display colour.
// Codes are loose buckets: 20s sailing/wing/HSC, 30s fishing, 40s HSC, 50s
// special (tug/pilot/SAR), 60s passenger, 70s cargo, 80s tanker, 90s other.
export function vesselTypeColor(type: number | undefined): number {
  assert(type === undefined || Number.isFinite(type), "vesselTypeColor: type not finite");
  if (type === undefined) return 0xb8c4d4;
  if (type >= 30 && type <= 39) return 0x6bd16b; // fishing — green
  if (type >= 60 && type <= 69) return 0xffffff; // passenger — white
  if (type >= 70 && type <= 79) return 0x88a8d0; // cargo — blue-grey
  if (type >= 80 && type <= 89) return 0xe07550; // tanker — red-orange
  if (type >= 50 && type <= 59) return 0xffd166; // tug/pilot — yellow
  if (type >= 36 && type <= 37) return 0xa066ff; // pleasure — violet
  return 0xb8c4d4;
}

// Pick a base earth-plate colour by latitude band so empty tiles never show
// the void. Crude climate buckets — refine later if we add a real biome model.
export function earthBaseColorForLat(latDeg: number): number {
  assertFinite(latDeg, "earthBaseColorForLat: latDeg");
  assertInRange(latDeg, -90, 90, "earthBaseColorForLat: latDeg range");
  const abs = Math.abs(latDeg);
  if (abs < 12) return 0x4a6b3a; // tropical green
  if (abs < 24) return 0xa78a5e; // sand
  if (abs < 35) return 0x9c8a64; // dry / steppe
  if (abs < 50) return 0x57624c; // temperate
  if (abs < 65) return 0x445040; // boreal
  return 0xb8c4cc; // polar
}

export function classifyRoad(kind: string | undefined): number {
  assertTagInput(kind, "classifyRoad");
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
  assertTagInput(kind, "classifyRail");
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
  assertTagInput(kind, "classifyPath");
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
  assertTagInput(kind, "classifyLanduse");
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
