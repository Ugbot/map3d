// Feed ingestion systems for the bitECS map3d world. Upserts FeedEntity
// updates into ECS components; expires stale entities. Tiger style: all
// loops bounded, every entry asserts inputs, no allocation in the hot upsert
// path beyond the first time we see a new feed id.

import { addComponents, addEntity, query, removeComponents } from "bitecs";
import {
  FLAG_IS_FEED,
  FLAG_ON_GROUND,
  FLAG_REMOVED,
  KIND_FEED_AIRCRAFT,
  KIND_FEED_VESSEL,
  type Map3dWorld,
} from "../ecs/world";
import { lonLatToMeters } from "../projection/mercator";
import { assert, assertFinite, assertInRange } from "../util/assert";
import type { FeedEntity, FeedKind } from "./types";

export interface FeedIngestOptions {
  sceneOrigin: { x: number; y: number };
  /** Aircraft altitude compression (0..1 mapping factor for scene Y). */
  altitudeScale?: number;
}

const DEFAULT_OPTS: Required<FeedIngestOptions> = {
  sceneOrigin: { x: 0, y: 0 },
  altitudeScale: 1.0,
};

export function feedUpsertSystem(
  world: Map3dWorld,
  e: FeedEntity,
  opts: FeedIngestOptions = DEFAULT_OPTS,
): number {
  assertInRange(e.lat, -90, 90, "feed.lat");
  assertInRange(e.lon, -180, 180, "feed.lon");
  assertFinite(e.headingDeg, "feed.headingDeg");
  assertFinite(e.speedMs, "feed.speedMs");
  assert(typeof e.id === "string" && e.id.length > 0, "feed.id");

  const c = world.components;
  const ctx = world.context;
  const sceneOrigin = opts.sceneOrigin;
  const altScale = opts.altitudeScale ?? 1.0;

  let eid = ctx.feedIdToEid.get(e.id);
  if (eid === undefined) {
    assert(ctx.feedIdToEid.size < ctx.config.entityCap, "feed entity cap");
    eid = addEntity(world);
    addComponents(
      world,
      eid,
      c.Position,
      c.Heading,
      c.Speed,
      c.Kind,
      c.Geo,
      c.Vertical,
      c.ObservedAt,
      c.Flags,
    );
    ctx.feedIdToEid.set(e.id, eid);
  }

  const kindCode = e.kind === "aircraft" ? KIND_FEED_AIRCRAFT : KIND_FEED_VESSEL;
  c.Kind.value[eid] = kindCode;
  c.Geo.lon[eid] = e.lon;
  c.Geo.lat[eid] = e.lat;
  c.Geo.altM[eid] = e.altM ?? 0;
  c.Vertical.mps[eid] = e.verticalMs ?? 0;
  c.ObservedAt.ms[eid] = e.ts;
  c.Heading.angle[eid] = (e.headingDeg * Math.PI) / 180;
  c.Speed.value[eid] = e.speedMs;

  // Project to scene metres so Position is renderer-ready.
  const m = lonLatToMeters(e.lon, e.lat);
  c.Position.x[eid] = m.x - sceneOrigin.x;
  c.Position.z[eid] = -(m.y - sceneOrigin.y);
  c.Position.y[eid] = (e.altM ?? 0) * altScale;

  let flags = FLAG_IS_FEED;
  if (e.onGround) flags |= FLAG_ON_GROUND;
  c.Flags.bits[eid] = flags;
  return eid;
}

export function feedRemoveSystem(world: Map3dWorld, id: string): void {
  const eid = world.context.feedIdToEid.get(id);
  if (eid === undefined) return;
  // Mark for the codec's next encode; commit later.
  const flags = world.components.Flags.bits[eid];
  world.components.Flags.bits[eid] = flags | FLAG_REMOVED;
}

/** Drop entities that haven't been observed within feedStaleMs of nowMs. */
export function feedExpireSystem(world: Map3dWorld, nowMs: number): void {
  assertFinite(nowMs, "nowMs");
  world.context.nowMs = nowMs;
  const cutoff = nowMs - world.context.config.feedStaleMs;
  const c = world.components;
  for (const eid of query(world, [c.ObservedAt, c.Flags])) {
    if ((c.Flags.bits[eid] & FLAG_IS_FEED) === 0) continue;
    if (c.ObservedAt.ms[eid] < cutoff) {
      c.Flags.bits[eid] |= FLAG_REMOVED;
    }
  }
}

export function feedCommitRemovalsSystem(world: Map3dWorld): void {
  const c = world.components;
  const ctx = world.context;
  for (const eid of query(world, [c.Flags])) {
    if ((c.Flags.bits[eid] & FLAG_REMOVED) === 0) continue;
    if ((c.Flags.bits[eid] & FLAG_IS_FEED) === 0) continue;
    // Find and drop the feed-id mapping.
    for (const [id, mapped] of ctx.feedIdToEid) {
      if (mapped === eid) {
        ctx.feedIdToEid.delete(id);
        break;
      }
    }
    removeComponents(
      world,
      eid,
      c.Position,
      c.Heading,
      c.Speed,
      c.Kind,
      c.Geo,
      c.Vertical,
      c.ObservedAt,
      c.Flags,
    );
  }
}

export function feedKindToCode(k: FeedKind): number {
  return k === "aircraft" ? KIND_FEED_AIRCRAFT : KIND_FEED_VESSEL;
}
