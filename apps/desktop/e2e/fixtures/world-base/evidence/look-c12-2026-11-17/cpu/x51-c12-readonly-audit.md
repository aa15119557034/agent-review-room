# C12 CPU / source read-only audit

Head: `e38dd51a294da3a498b9404c0f27b854d16a2fd5`. Command: `node D:/codex/2026-11-16/world-implementation/handoff/x51-c12-city-driver.mjs`; actual exit 0. Raw output and stderr are kept separately; raw SHA/size and source SHA are in the JSON. No fixture edits or GPU.

- Actual city 29,109 triangles (+252 = 5×4×12 borders +12 laundry floor); strict budget room 890 triangles.
- Five foundation bases/footprints remain unchanged. Six connection reports equal C11 exactly; minimum visible-terrain stair clearance 0.0303982m. Existing background remains non-walkable, 0 suppressed physics calls.
- Original cap top remains base+.02m; border top base+.025m. New interior floor top base+.145m, machine bottoms/old structural slab top base+.14m: 5mm embed, no suspended machines. Apartment entry stair top base+.14m remains above rim. Low-house front .04m overlap has old +.02m cap lip, now +.025m rim lip; not new playable stairs.
- Confirmed geometry risk: full concrete cap and pale borders share outer vertical faces over .09m height at all five foundations. Tops are separated 5mm. Actual visible z-fight is NOT established. Laundry world front z778.19, x273.76..288.29, y12.694808..12.784808. Root/runtime should inspect already-authorized21/24 views, not infer failure from CPU.
- Laundry crate and A-frame clear front border interior edge by .36725m and .06128m respectively; existing supportY is unchanged.
- Shop glass uOpacity .08, transparent/DoubleSide/depthWrite=false/depthTest=true, existing mesh36tri/order0; .08 is base alpha, Fresnel still adds up to.35. No new transparent geometry or sorting policy.
- 32 mesh flag groups unchanged; noncast Toon bins856/756/708/565. Walls/back stairs/balconies remain in original casting bins; no global flag override.
- Two disposal calls produced23geometry/20root-material events,0borrowed-texture events; customDepthMaterial not independently counted. No new textures. Mock texture pixels and canvas remain a CPU limitation; these are not visual acceptance results.

## Existing-kit budget (actual CPU emit counts)

- houses/props.js `wateringCan`: 68 tri (LOD 1)
- houses/props.js `bucket`: 60 tri (LOD 1)
- houses/props.js `broom`: 36 tri (LOD 1)
- houses/props.js `dustpan`: 24 tri (LOD 1)
- houses/props.js `umbrellaFolded`: 36 tri (LOD 1)
- houses/props.js `bins-one`: 36 tri (LOD 1)
- houses/props.js `sillPot`: 172 tri (LOD 1)
- houses/props.js `pot-seed-c12`: 126 tri (LOD 1)
- houses/props.js `planter-.7m`: 164 tri (LOD 1)
- houses/props.js `elecMeter`: 36 tri (LOD 1)
- houses/props.js `ventHood`: 24 tri (LOD 1)
- houses/props.js `acUnit`: 36 tri (LOD 1)
- shopsA/common.js `carton`: 12 tri
- shopsA/common.js `crate`: 12 tri
- shopsA/common.js `aFrame`: 136 tri
- shopsA/common.js `umbrellaStand`: 192 tri
- shopsA/common.js `pipe`: 32 tri

Recommend about350–450new town triangles total across the next density pass, not per zone. Example cost only: two cartons24+umbrella rack192+labelled bin36+broom36+dustpan24+watering can68+pipe32=412; town becomes29,521. This does not recommend putting every item together. Seeded foliage costs vary; existing laundry pot is141tri. The 5,840tri official crate cannot be duplicated inside current budget. Blank A-frame136 plus two atlas panels4=140. No new textures needed when borrowing prebuilt station contexts.
