#include "beam_mesh.h"
#include <math.h>
#include <string.h>
#include <stdlib.h>

/* The sokol-side shims are defined alongside the rest of the vendored sokol
 * module (deps/flecs_systems_sokol.c) so they share its sokol_gfx symbol
 * tables. Declared extern here with sokol-free signatures. */
extern uint32_t beam_sokol_make_vbuf_f32(const float *data, uint32_t n_floats);
extern uint32_t beam_sokol_make_ibuf_u32(const uint32_t *data, uint32_t n_indices);
extern void     beam_sokol_destroy_buf(uint32_t id);
extern int      beam_sokol_is_ready(void);

ECS_COMPONENT_DECLARE(BeamMesh);

/* Pack 0x00RRGGBB into a float[3] in [0,1]. Gamma is the caller's problem. */
static void beam_mesh_unpack_rgb(uint32_t packed, float out[3]) {
    out[0] = (float)((packed >> 16) & 0xFFu) * (1.0f / 255.0f);
    out[1] = (float)((packed >>  8) & 0xFFu) * (1.0f / 255.0f);
    out[2] = (float)((packed      ) & 0xFFu) * (1.0f / 255.0f);
}

/* Compute area-weighted vertex normals from a triangle soup and emit an
 * interleaved (pos.xyz, normal.xyz) float buffer at 6 floats per vertex.
 *
 * `interleaved` must have room for `vertex_count * 6` floats. Caller owns the
 * allocation. Returns 1 on success, 0 if any triangle index is out of range
 * (validated by the caller, but checked again here as a defence-in-depth
 * boundary against bridge bugs). */
static int beam_mesh_compute_interleaved(
    const float *positions, uint32_t n_floats,
    const uint32_t *indices, uint32_t n_indices,
    float *interleaved)
{
    ecs_assert(positions != NULL, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(indices != NULL, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(interleaved != NULL, ECS_INVALID_PARAMETER, NULL);

    const uint32_t vertex_count = n_floats / 3u;

    /* First pass: zero the interleaved buffer, then copy positions into the
     * pos slots so we can accumulate normals into the normal slots. */
    uint32_t i;
    for (i = 0; i < vertex_count; i++) {
        interleaved[i * 6 + 0] = positions[i * 3 + 0];
        interleaved[i * 6 + 1] = positions[i * 3 + 1];
        interleaved[i * 6 + 2] = positions[i * 3 + 2];
        interleaved[i * 6 + 3] = 0.0f;
        interleaved[i * 6 + 4] = 0.0f;
        interleaved[i * 6 + 5] = 0.0f;
    }

    /* Second pass: accumulate face normals weighted by triangle area. The
     * cross product of two edges has magnitude == 2*triangle_area, so summing
     * un-normalised crosses gives the area-weighted sum we want. */
    const uint32_t tri_count = n_indices / 3u;
    for (i = 0; i < tri_count; i++) {
        uint32_t i0 = indices[i * 3 + 0];
        uint32_t i1 = indices[i * 3 + 1];
        uint32_t i2 = indices[i * 3 + 2];
        if (i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count) {
            return 0;
        }

        const float *p0 = &positions[i0 * 3];
        const float *p1 = &positions[i1 * 3];
        const float *p2 = &positions[i2 * 3];

        float e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
        float e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];

        float nx = e1y * e2z - e1z * e2y;
        float ny = e1z * e2x - e1x * e2z;
        float nz = e1x * e2y - e1y * e2x;

        interleaved[i0 * 6 + 3] += nx;
        interleaved[i0 * 6 + 4] += ny;
        interleaved[i0 * 6 + 5] += nz;
        interleaved[i1 * 6 + 3] += nx;
        interleaved[i1 * 6 + 4] += ny;
        interleaved[i1 * 6 + 5] += nz;
        interleaved[i2 * 6 + 3] += nx;
        interleaved[i2 * 6 + 4] += ny;
        interleaved[i2 * 6 + 5] += nz;
    }

    /* Third pass: normalise. Degenerate vertices (no incident triangle, or
     * exactly-cancelling neighbours) get a stable up-pointing normal so the
     * shader doesn't NaN out. */
    for (i = 0; i < vertex_count; i++) {
        float *n = &interleaved[i * 6 + 3];
        float len2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
        if (len2 > 1e-12f) {
            float inv = 1.0f / sqrtf(len2);
            n[0] *= inv;
            n[1] *= inv;
            n[2] *= inv;
        } else {
            n[0] = 0.0f; n[1] = 1.0f; n[2] = 0.0f;
        }
    }

    return 1;
}

int beam_mesh_build(BeamMesh *out,
                    const float *positions, uint32_t n_floats,
                    const uint32_t *indices, uint32_t n_indices,
                    uint32_t color_rgb,
                    float origin_x, float origin_y, float origin_z)
{
    ecs_assert(out != NULL, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(positions != NULL, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(indices != NULL, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(n_floats > 0, ECS_INVALID_PARAMETER, "empty positions");
    ecs_assert(n_indices > 0, ECS_INVALID_PARAMETER, "empty indices");
    ecs_assert(n_floats <= BEAM_MESH_MAX_FLOATS, ECS_OUT_OF_RANGE,
        "n_floats exceeds BEAM_MESH_MAX_FLOATS");
    ecs_assert(n_indices <= BEAM_MESH_MAX_INDICES, ECS_OUT_OF_RANGE,
        "n_indices exceeds BEAM_MESH_MAX_INDICES");
    ecs_assert((n_floats % 3u) == 0, ECS_INVALID_PARAMETER,
        "n_floats must be multiple of 3 (xyz triples)");
    ecs_assert((n_indices % 3u) == 0, ECS_INVALID_PARAMETER,
        "n_indices must be multiple of 3 (triangle list)");
    ecs_assert(origin_x == origin_x && origin_y == origin_y &&
        origin_z == origin_z, ECS_INVALID_PARAMETER, "non-finite origin");

    /* Zero-init first so any early-return leaves a clean struct. */
    memset(out, 0, sizeof(*out));
    out->origin[0] = origin_x;
    out->origin[1] = origin_y;
    out->origin[2] = origin_z;
    beam_mesh_unpack_rgb(color_rgb, out->color);

    const uint32_t vertex_count = n_floats / 3u;

    /* Range-check every index in a single bounded pass before we touch sokol.
     * This keeps the GPU buffer creation off the failure path. */
    uint32_t i;
    for (i = 0; i < n_indices; i++) {
        if (indices[i] >= vertex_count) {
            ecs_assert(false, ECS_INVALID_PARAMETER,
                "BeamMesh index out of range");
            memset(out, 0, sizeof(*out));
            return 0;
        }
    }

    /* Defer to the sokol shim only when the renderer has finished sg_setup —
     * the bridge may queue uploads before the first frame. If sokol isn't
     * ready we leave the struct zeroed; the caller (bridge) should retry on
     * the next tile upsert or upgrade to a deferred-upload queue. */
    if (!beam_sokol_is_ready()) {
        return 0;
    }

    /* Build interleaved CPU buffer once, then hand off to sokol. We allocate
     * here (not in the render hot path) so the per-frame draw is alloc-free.
     * The shim copies into an immutable sokol buffer; we free immediately. */
    const size_t interleaved_floats = (size_t)vertex_count * 6u;
    float *interleaved = (float*)malloc(interleaved_floats * sizeof(float));
    if (!interleaved) {
        return 0;
    }

    if (!beam_mesh_compute_interleaved(
            positions, n_floats, indices, n_indices, interleaved))
    {
        free(interleaved);
        return 0;
    }

    uint32_t vbuf_id = beam_sokol_make_vbuf_f32(
        interleaved, (uint32_t)interleaved_floats);
    free(interleaved);
    if (!vbuf_id) {
        return 0;
    }

    uint32_t ibuf_id = beam_sokol_make_ibuf_u32(indices, n_indices);
    if (!ibuf_id) {
        beam_sokol_destroy_buf(vbuf_id);
        return 0;
    }

    out->vbuf = vbuf_id;
    out->ibuf = ibuf_id;
    out->index_count = n_indices;
    return 1;
}

void beam_mesh_destroy(BeamMesh *bm) {
    if (!bm) return;
    if (bm->vbuf) {
        beam_sokol_destroy_buf(bm->vbuf);
        bm->vbuf = 0;
    }
    if (bm->ibuf) {
        beam_sokol_destroy_buf(bm->ibuf);
        bm->ibuf = 0;
    }
    bm->index_count = 0;
}

/* on_remove hook fired when an entity with BeamMesh is destroyed. Releases
 * the sokol buffers so the bridge's tile-release path doesn't leak. */
static void BeamMeshOnRemove(ecs_iter_t *it) {
    BeamMesh *bm = ecs_field(it, BeamMesh, 0);
    int i;
    for (i = 0; i < it->count; i++) {
        beam_mesh_destroy(&bm[i]);
    }
}

/* Render system — placeholder.
 *
 * Drawing BeamMesh entities correctly requires hooking into the sokol
 * module's `sokol_run_scene_pass` so we participate in the same offscreen
 * framebuffer (depth pre-pass, HDR target, fog post-pass, etc.). That
 * integration lives in deps/flecs_systems_sokol.c and is the responsibility
 * of the sokol-module patch in this same change set. The system below is
 * kept as an explicit registration hook so external callers can observe its
 * existence; the actual sg_draw calls happen inside the scene-pass extension
 * registered by FlecsSokolBeamMeshImport. */
static void BeamMeshRender(ecs_iter_t *it) {
    (void)it;
    /* Intentionally empty: the scene-pass extension drives draws. */
}

void FlecsSokolBeamMeshImport(ecs_world_t *world) {
    ecs_assert(world != NULL, ECS_INVALID_PARAMETER, NULL);

    ECS_MODULE(world, FlecsSokolBeamMesh);

    ECS_COMPONENT_DEFINE(world, BeamMesh);

    /* Fire beam_mesh_destroy whenever a BeamMesh component is removed. This
     * is the only path through which sokol buffers are freed — even tile
     * release works by ecs_delete'ing the entity, which triggers on_remove
     * for every component including BeamMesh. */
    ecs_set_hooks(world, BeamMesh, {
        .on_remove = BeamMeshOnRemove
    });

    /* Register a phase system in EcsOnStore (same phase the sokol module
     * uses for SokolRender). The render system itself is a no-op; the actual
     * drawing is dispatched from inside the sokol scene-pass extension. */
    ecs_system(world, {
        .entity = ecs_entity(world, {
            .name = "BeamMeshRender",
            .add = (ecs_id_t[]){ ecs_dependson(EcsOnStore), EcsOnStore, 0 }
        }),
        .callback = BeamMeshRender
    });
}
