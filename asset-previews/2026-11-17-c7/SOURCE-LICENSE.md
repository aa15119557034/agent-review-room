# Textured props — source, license and byte preservation

Audit date: 2026-11-17. These files were obtained directly from Poly Haven asset URLs returned by its official API, using the unique User-Agent `agent-review-room-X51-asset-audit`.

| Asset | Author in official API | Official source |
|---|---|---|
| Plastic Crate 02 | Fabi_G | https://polyhaven.com/a/plastic_crate_02 |
| Painted Wooden Bench | Kirill Sannikov | https://polyhaven.com/a/painted_wooden_bench |
| Worn Shutter | Dimitrios Savva | https://polyhaven.com/a/worn_shutter |

The asset license is **CC0 1.0 Universal**, as stated by [Poly Haven's official asset license](https://polyhaven.com/license). The canonical dedication is at https://creativecommons.org/publicdomain/zero/1.0/ . This file records provenance; it is not a claim that a separate LICENSE file was included in the individually downloaded files.

Only the original two 1K glTF files, their BIN/image dependencies, and the three Worn Shutter material JPGs were downloaded. No preview renders, screenshots, webpage copies, package archives or converted assets are included. No original downloaded byte was modified, recompressed or converted.

Authoritative local records:

- `meta/*.info.json`, `meta/*.files.json`: original six API responses.
- `meta/metadata-sha256.json`: actual SHA256 of those six responses.
- `meta/download-plan.json`: official URLs, expected byte lengths and MD5, including two unselected shutter geometry files for audit only.
- `download-receipt.json`: the 13 downloaded original files, exact URLs, actual byte lengths, MD5 and SHA256; paths relative to `downloads/`.
- `asset-inspection.json`: CPU inspection of real glTF/BIN and JPEG headers.

The official preview renders and webpage text are not assumed to share the asset CC0 license. None was copied into this directory or the fixture.
