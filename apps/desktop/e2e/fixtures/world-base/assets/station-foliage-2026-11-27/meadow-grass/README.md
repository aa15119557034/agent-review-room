# Meadow grass

`meadow-grass.blend` contains the editable fan, sweep, and two short-grass models. Every blade is a separate closed component. The fans give the grass taller edges. The short models distribute 27 and 30 bent blades across each patch, with teal roots, sage leaves, and pale yellow-green tips in the vertex colors. All four models ship without textures.

Blender 5.2.2 builds all four GLBs and their editable source. Run these commands from this directory.

```text
blender --background --factory-startup --python build-meadow-grass.py
blender --background --factory-startup meadow-grass.blend --python build-meadow-grass.py -- --export-only
```

The GLBs use metre units and a ground-level origin. The fan and sweep have 572 and 528 triangles. The low and bowed grass models reach 0.20 and 0.24 m before planting scale and have 756 and 840 triangles. `island-ground.json` records the F hillside and H tower-road planting areas.
