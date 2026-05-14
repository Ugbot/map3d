# City Bridge (JS / WASM ABI)

The bridge lets an external TypeScript host drive Flecs City's agents/feeds
in place of the procedural traffic system. All exports are plain C with
`EMSCRIPTEN_KEEPALIVE`; native builds compile too (the keepalive expands
to nothing).

## ABI

| Function | Purpose |
|---|---|
| `beam_init()` | Verify bridge is live. Call once after the WASM boots. |
| `beam_begin_frame(tick_seq)` / `beam_end_frame()` | Wrap a batch of upserts. Defers ECS ops for the duration. |
| `beam_agent_upsert(id, kind, x, y, z, heading)` | kind: 0=vehicle, 1=train, 2=pedestrian. Creates or updates. |
| `beam_agent_remove(id)` | Delete an agent; probes all kinds. Prefer the kind-aware variant. |
| `beam_agent_remove_kind(id, kind)` | Delete an agent with a known kind. O(1) map remove. |
| `beam_feed_upsert(id, kind, x, y, z, heading)` | kind: 0=aircraft, 1=vessel. |
| `beam_feed_remove(id)` | Delete a feed; probes all kinds. Prefer the kind-aware variant. |
| `beam_feed_remove_kind(id, kind)` | Delete a feed with a known kind. O(1) map remove. |
| `beam_set_env(...)` | Push sun/ambient hints into the `BeamEnv` singleton. |
| `beam_clear_all()` | Delete every bridge-owned entity. Use on reconnect. |
| `beam_live_count()` | Total resident bridge entities. |

Coordinate convention: scene-local metres, `xz` ground plane, `y` up;
`heading = atan2(dx, dz)` (0 = +z, clockwise) matching the three.js side.
`remote_id` is a non-zero `u32`; ids are unique across kinds within a family.

`BRIDGE_MAX_ENTITIES = 32768` is asserted on every upsert.

## Build

The `em` target in `project.json` adds `-DBEAM_DRIVEN=1` and the
`-sEXPORTED_FUNCTIONS` / `-sEXPORTED_RUNTIME_METHODS` link flags the JS
host needs. Build with:

```
bake --target em
```

Output lands in `etc/` as `.js` + `.wasm` next to the embedded assets.

Native build (`bake`) still works; `BEAM_DRIVEN` stays off so the
procedural prewarm runs and procedural traffic spawns as before.

## Integration

`main.c`:

1. imports `FlecsCity`, then `FlecsCityBridgeImport(world)`,
2. runs `etc/assets/scene.flecs`,
3. under `BEAM_DRIVEN`, zeroes `City.traffic.frequency` / `.chance` on
   every City entity and skips the 5000-frame prewarm,
4. calls `beam_init()` so subsequent JS calls succeed.

The bridge uses two `ecs_map_t` (agents, feeds) keyed by
`(kind << 32) | remote_id`, mapping to `ecs_entity_t`. Frame batches run
inside `ecs_defer_begin/end`. No allocation happens in the per-call hot
path beyond what the maps amortise.

## Prefabs

The bridge declares kind-specific prefabs that all `IsA Car`, overriding
the body `Box` and `Rgb` so the visual differences read at city scale:

| Kind | Prefab | Size (W×H×D) | Colour |
|---|---|---|---|
| agent 0 | `Car` (inherited) | as defined in `city.flecs` | blue-grey |
| agent 1 | `BeamTrain` | 4 × 3.5 × 30 | grey |
| agent 2 | `BeamPedestrian` | 0.6 × 1.8 × 0.6 | cyan |
| feed 0 | `BeamAircraft` | 30 × 3 × 4 | white |
| feed 1 | `BeamVessel` | 14 × 6 × 60 | dark blue |

## Sun sync

`FlecsCityBridgeImport` registers a single `EcsOnUpdate` system,
`BridgeSunSync`, that on each tick reads the `BeamEnv` singleton and
writes the named scene light entity (`light`, tagged `EcsSun` in
`etc/assets/app.flecs`). Altitude/azimuth become an `EcsPosition3` unit
direction; the packed `sun_color_rgb` becomes the light's `EcsRgb`. If
the `light` entity isn't present (e.g. headless test) the system logs
once via `ecs_dbg` and no-ops.

## Known limitations

- `suppress_procedural_traffic` zeroes future spawns but leaves any
  emitters that already spawned during the synchronous `SetCity` hook;
  those cars drive off-map within seconds via `ExpireTraffic`.
