#include <city.h>
#include "bridge.h"

#ifdef BEAM_DRIVEN
/* When the bridge is driving the sim from JS, neuter the built-in procedural
 * traffic emitters so we don't double-up cars on the same roads. We do this
 * by clearing CityTraffic on every City entity after scene load — the
 * SetCity hook reads traffic.frequency to decide whether to spawn emitters,
 * so we have to re-trigger it after the mutation. */
static void suppress_procedural_traffic(ecs_world_t *world) {
    ecs_query_t *q = ecs_query(world, {
        .terms = {{ .id = ecs_id(City) }}
    });
    ecs_assert(q != NULL, ECS_INTERNAL_ERROR, NULL);

    ecs_iter_t it = ecs_query_iter(world, q);
    while (ecs_query_next(&it)) {
        City *cities = ecs_field(&it, City, 0);
        for (int i = 0; i < it.count; i ++) {
            cities[i].traffic.frequency = 0.0f;
            cities[i].traffic.chance = 0.0f;
        }
    }
    ecs_query_fini(q);

    /* Delete any emitters/cars already spawned by the SetCity hook (it ran
     * synchronously during ecs_script_run_file above). The CityTrafficEmitter
     * symbol is module-internal, so we rely on the bridge clearing things
     * later — for now, ExpireTraffic will eventually flush leftover cars. */
}
#endif

int main(int argc, char *argv[]) {
    ecs_world_t *world = ecs_init();

    ECS_IMPORT(world, FlecsStats);

    ECS_IMPORT(world, FlecsUnits);
    ECS_IMPORT(world, FlecsScript);
    ECS_IMPORT(world, FlecsComponentsTransform);
    ECS_IMPORT(world, FlecsComponentsGeometry);
    ECS_IMPORT(world, FlecsComponentsGui);
    ECS_IMPORT(world, FlecsComponentsGraphics);

    ECS_IMPORT(world, FlecsGame);
    ECS_IMPORT(world, FlecsCity);

    /* Bridge must import after FlecsCity so the Car prefab lookup succeeds. */
    ECS_IMPORT(world, FlecsCityBridge);

    ecs_time_t t = {0}; ecs_time_measure(&t);
    ecs_script_run_file(world, "etc/assets/scene.flecs");
    printf("scene loaded in %fs\n", ecs_time_measure(&t));

#ifdef BEAM_DRIVEN
    suppress_procedural_traffic(world);
    beam_init();
#else
    /* Prewarm simulation so there's cars everywhere */
    for (int i = 0; i < 5000; i ++) {
        ecs_progress(world, 0.16);
    }
#endif

    ECS_IMPORT(world, FlecsSystemsTransform);
    ECS_IMPORT(world, FlecsSystemsSokol);
    ecs_script_run_file(world, "etc/assets/app.flecs");

    return ecs_app_run(world, &(ecs_app_desc_t){
        .enable_rest = true,
        .enable_stats = true,
        .target_fps = 60
    });
}
