# AirData 3D — CDN assets

Public repo that only serves the runtime files for the AirData 3D scroll
section via jsDelivr. Source of truth (markup, raw models, dev setup) lives
in the private AirData repo — edit there, then copy the built files here.

## Contents

- `js/ad3d.js` — the whole 3D section logic (ES module)
- `assets/model/d3.bin`, `d6.bin` — drone models (Draco GLB, scrambled; not
  openable in 3D software, per the TurboSquid license terms)
- `assets/spin.jpg` — propeller blur texture

Do NOT add raw `.gltf` / `.glb` files to this repo — it is public.

## Usage (Webflow)

Page Settings -> Custom Code -> Before `</body>`:

```html
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/" } }
</script>
<script type="module"
  src="https://cdn.jsdelivr.net/gh/MilovanovicMatija/AirDataAssets@main/js/ad3d.js"></script>
```

The script resolves the model and texture relative to its own URL, so nothing
else needs configuring.

## Updating

jsDelivr caches `@main` for up to 12 hours. After pushing an update, force a
refresh with:

```
https://purge.jsdelivr.net/gh/MilovanovicMatija/AirDataAssets@main/js/ad3d.js
```

(one purge URL per changed file), or pin a commit hash in the embed instead
of `@main` for instant, immutable deploys.
