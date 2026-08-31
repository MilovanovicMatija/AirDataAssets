/* ==========================================================================
   AirData 3D scroll section — test rig with tuning controls
   - three scroll poses (Before / During / After), tunable in the GUI
   - propeller spin per pose, counter-rotating pairs
   - light rig tunable in the GUI
   - "Copy values" button exports everything as JSON to the clipboard
   ========================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

// Assets resolve relative to wherever THIS script is hosted (local server,
// or the public CDN repo on jsDelivr) — no hardcoded domain needed.
const ASSET_BASE = new URL('..', import.meta.url).href;

// Draco-compressed GLBs (~0.3-0.4 MB), shipped XOR-scrambled under a neutral
// .bin extension so the asset can't be grabbed from the network tab and opened
// in 3D software (TurboSquid "reasonable steps"). Lighter mesh goes to mobile.
// Matches the Webflow tablet breakpoint — must equal the @media in the embed
const MOBILE_BP = 991;
const IS_MOBILE = window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches;
const MODEL_URL = ASSET_BASE + (IS_MOBILE ? 'assets/model/d3.bin' : 'assets/model/d6.bin');

// --------------------------------------------------------------------------
// Poses: [Before, During, After] — edit live in the GUI, then Copy values
// --------------------------------------------------------------------------
const POSES = [
  { name: 'Before',
    rot: new THREE.Euler(0.13, 0, 0),
    pos: new THREE.Vector3(0, 0.1, 3),
    scale: 1.0,
    propSpin: 0,              // rad/s
  },
  { name: 'During',
    rot: new THREE.Euler(0.5, 0, 0),
    pos: new THREE.Vector3(0, 0.26, 3),
    scale: 1.0,
    propSpin: 30,
  },
  { name: 'After',
    rot: new THREE.Euler(0.3, 0, 0),
    pos: new THREE.Vector3(0, 0.1, 3),
    scale: 1.0,
    propSpin: 0.0,
  },
];

const SETTINGS = {
  preview: 'Scroll',          // Scroll | Before | During | After
  // propellers
  propAxis: 'Z',              // pivots carry a -90° X rotation, local Z = up
  propMultiplier: 1.0,
  propStagger: 0.04,          // per-prop delay so they don't stop in unison
  spinEaseOff: 2.0,           // spin-down inertia damping — lower = coasts longer
  // blur disc
  discStrength: 1.0,          // disc opacity at full speed (0 = off)
  discDrift: 0.04,            // how much of the prop spin the texture keeps (0 = frozen)
  discScale: 0.85,            // disc size relative to the measured blade sweep
  discStart: 11,              // rad/s where blades start fading into the disc
  discFull: 22,               // rad/s where only the disc remains
  discColor: '#ababab',       // tint multiplied into the texture
  // materials / stage
  background: '#101214',
  faceColor: '#000000',
  gridColor: '#ffffff',
  gridOpacity: 0.73,
  gridAmbient: 0.14,          // brightness of lines facing away from the light
  gridContrast: 1.55,         // falloff sharpness of the line shading
  // WebGL can't draw thick lines directly — lines are always 1 device pixel.
  // Lowering the render scale makes that pixel cover more CSS pixels, so
  // the grid reads thicker (at the cost of overall sharpness).
  renderScale: 2,
  // lights
  hemiIntensity: 4,
  hemiSky: '#ffffff',
  hemiGround: '#000000',
  keyIntensity: 6,
  keyX: -0.1, keyY: 3.9, keyZ: 1.4,
  rimIntensity: 6,
  rimX: 4.1, rimY: -2, rimZ: -5.7,
  // camera
  camY: 0.4,
  camZ: 6.6,
};

const DAMPING = 6;
const EPSILON = 0.0005;

// --------------------------------------------------------------------------

const stage  = document.getElementById('ad3d-stage');
const track  = document.getElementById('ad3d');
const sticky = track.querySelector('.ad3d__sticky');
const steps  = Array.from(document.querySelectorAll('.ad3d__step'));
const mqMobile = window.matchMedia(`(max-width: ${MOBILE_BP}px)`);

// HUD overlay --------------------------------------------------------------
const hudRoot = document.getElementById('ad3d-hud');
const hudSec = {
  before: document.getElementById('hud-before'),
  during: document.getElementById('hud-during'),
  after:  document.getElementById('hud-after'),
};
const hudBatt     = document.getElementById('hud-batt');
const hudBattVal  = document.getElementById('hud-batt-val');
const hudBattFill = document.getElementById('hud-batt-fill');
const hudLive     = document.getElementById('hud-live');
const hudComplete = document.getElementById('hud-complete');
const hudRisk     = document.getElementById('hud-risk');
const hudCallouts = {
  prop:  { label: document.getElementById('hud-co-prop'),  path: document.getElementById('hud-line-prop'),  dot: document.getElementById('hud-dot-prop'),  mode: 'right' },
  fc:    { label: document.getElementById('hud-co-fc'),    path: document.getElementById('hud-line-fc'),    dot: document.getElementById('hud-dot-fc'),    mode: 'left'  },
  cam:   { label: document.getElementById('hud-co-cam'),   path: document.getElementById('hud-line-cam'),   dot: document.getElementById('hud-dot-cam'),   mode: 'top'   },
  motor: { label: document.getElementById('hud-co-motor'), path: document.getElementById('hud-line-motor'), dot: document.getElementById('hud-dot-motor'), mode: 'left'  },
};
// 3D points the callout lines terminate at (filled in once the model loads)
const hudAnchors = { top: null, camera: null };
let hudScale = 1;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Renderer -----------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);

// Lights -------------------------------------------------------------------
const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
const key  = new THREE.DirectionalLight(0xffffff, 1);
const rim  = new THREE.DirectionalLight(0xffffff, 1);
scene.add(hemi, key, rim);

// Materials ----------------------------------------------------------------
const faceMaterial = new THREE.MeshStandardMaterial({
  roughness: 0.9,
  metalness: 0.0,
  polygonOffset: true,        // push faces back so grid lines never z-fight
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
});

// Lit wireframe: LineBasicMaterial is flat/unlit, which is why the grid
// looked flat next to the Figma reference. This shader shades each line
// vertex by its surface normal against the key light, so lines facing the
// light glow and the rest falls off dark — the "lit wireframe" look.
const gridUniforms = {
  uColor:    { value: new THREE.Color('#ffffff') },
  uOpacity:  { value: 1 },
  uLightDir: { value: new THREE.Vector3(0, 1, 1) },
  uAmbient:  { value: 0.22 },
  uContrast: { value: 1.6 },
};

const gridMaterial = new THREE.ShaderMaterial({
  uniforms: gridUniforms,
  transparent: true,
  vertexShader: /* glsl */`
    uniform vec3 uLightDir;
    uniform float uAmbient;
    uniform float uContrast;
    varying float vShade;
    void main() {
      vec3 n = normalize(mat3(modelMatrix) * normal);
      float d = max(dot(n, normalize(uLightDir)), 0.0);
      vShade = uAmbient + (1.0 - uAmbient) * pow(d, uContrast);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 uColor;
    uniform float uOpacity;
    varying float vShade;
    void main() {
      gl_FragColor = vec4(uColor * vShade, uOpacity);
    }
  `,
});

// Per-propeller material clones (so blades can fade into the blur disc)
// and the disc materials themselves — all updated by applySettings too.
const bladeFaceMats = [];
const bladeGridMats = [];
const discMats = [];

// Apply everything tunable in one place ------------------------------------
function applySettings() {
  renderer.setClearColor(new THREE.Color(SETTINGS.background));
  faceMaterial.color.set(SETTINGS.faceColor);
  gridUniforms.uColor.value.set(SETTINGS.gridColor);
  gridUniforms.uOpacity.value = SETTINGS.gridOpacity;
  gridUniforms.uAmbient.value = SETTINGS.gridAmbient;
  gridUniforms.uContrast.value = SETTINGS.gridContrast;
  gridUniforms.uLightDir.value.set(SETTINGS.keyX, SETTINGS.keyY, SETTINGS.keyZ);
  for (const m of bladeFaceMats) { m.color.set(SETTINGS.faceColor); }
  for (const m of bladeGridMats) {
    m.uniforms.uColor.value.set(SETTINGS.gridColor);
    m.uniforms.uAmbient.value = SETTINGS.gridAmbient;
    m.uniforms.uContrast.value = SETTINGS.gridContrast;
    m.uniforms.uLightDir.value.set(SETTINGS.keyX, SETTINGS.keyY, SETTINGS.keyZ);
  }
  for (const m of discMats) { m.color.set(SETTINGS.discColor); }
  for (const p of propellers) {
    if (p.disc) { p.disc.scale.setScalar(SETTINGS.discScale); }
  }

  hemi.intensity = SETTINGS.hemiIntensity;
  hemi.color.set(SETTINGS.hemiSky);
  hemi.groundColor.set(SETTINGS.hemiGround);
  key.intensity = SETTINGS.keyIntensity;
  key.position.set(SETTINGS.keyX, SETTINGS.keyY, SETTINGS.keyZ);
  rim.intensity = SETTINGS.rimIntensity;
  rim.position.set(SETTINGS.rimX, SETTINGS.rimY, SETTINGS.rimZ);

  camera.position.set(0, SETTINGS.camY, SETTINGS.camZ);
  camera.lookAt(0, 0, 0);

  if (renderer.getPixelRatio() !== SETTINGS.renderScale) {
    renderer.setPixelRatio(SETTINGS.renderScale);
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
  }

  PROP_AXIS.set(
    SETTINGS.propAxis === 'X' ? 1 : 0,
    SETTINGS.propAxis === 'Y' ? 1 : 0,
    SETTINGS.propAxis === 'Z' ? 1 : 0
  );

  needsRender = true;
}

// Model --------------------------------------------------------------------
const pivot = new THREE.Group();
scene.add(pivot);

let modelReady = false;

// glTF can't store C4D's viewport wireframe, so we rebuild the quad grid:
// the exporter splits each quad into two triangles, and on a near-uniform
// grid the quad diagonal is the triangle's longest edge. Keep the two
// shorter edges of every triangle, dedupe, and we get the quads back.
function buildQuadWireframe(geometry) {
  const index = geometry.index;
  const posAttr = geometry.attributes.position;
  const triCount = (index ? index.count : posAttr.count) / 3;
  const getIndex = (i) => (index ? index.getX(i) : i);

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const seen = new Set();
  const lineIndices = [];

  for (let t = 0; t < triCount; t++) {
    const ia = getIndex(t * 3), ib = getIndex(t * 3 + 1), ic = getIndex(t * 3 + 2);
    a.fromBufferAttribute(posAttr, ia);
    b.fromBufferAttribute(posAttr, ib);
    c.fromBufferAttribute(posAttr, ic);

    const edges = [
      [ia, ib, a.distanceToSquared(b)],
      [ib, ic, b.distanceToSquared(c)],
      [ic, ia, c.distanceToSquared(a)],
    ].sort((e1, e2) => e1[2] - e2[2]);

    for (let k = 0; k < 2; k++) {
      const [i1, i2] = edges[k];
      const kkey = i1 < i2 ? i1 * 1e7 + i2 : i2 * 1e7 + i1;
      if (!seen.has(kkey)) {
        seen.add(kkey);
        lineIndices.push(i1, i2);
      }
    }
  }

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', posAttr);
  lineGeo.setAttribute('normal', geometry.attributes.normal); // for lit shading
  lineGeo.setIndex(lineIndices);
  return lineGeo;
}

// Propeller pivots found in the file ("01 drone propeller" etc.). Diagonal
// pairs spin in opposite directions, like on a real quad.
const propellers = [];

// The blur disc texture: hand-made radial smear on black. Drawn with
// additive blending, so black contributes nothing — no alpha needed.
const discTexture = new THREE.TextureLoader().load(`${ASSET_BASE}assets/spin.jpg`, () => {
  needsRender = true;
});
discTexture.colorSpace = THREE.SRGBColorSpace;

// Measure the blade in pivot-local space: its sweep radius (disc size)
// and the plane it spins in (disc placement).
function measureBlade(blade) {
  const probe = new THREE.Mesh(blade.geometry);
  probe.position.copy(blade.position);
  probe.quaternion.copy(blade.quaternion);
  probe.scale.copy(blade.scale);
  probe.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(probe);
  const R = Math.sqrt(
    Math.max(box.min.x ** 2, box.max.x ** 2) +
    Math.max(box.min.y ** 2, box.max.y ** 2)
  ) * 1.03;
  const zMid = (box.min.z + box.max.z) / 2;
  return { R, zMid };
}

// Draco decoding runs in a web worker, off the main thread
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

function onModelLoaded(gltf) {
  const model = gltf.scene;

  let flip = 1;
  model.traverse((child) => {
    if (child.isMesh) {
      child.material = faceMaterial;
      const grid = new THREE.LineSegments(buildQuadWireframe(child.geometry), gridMaterial);
      child.add(grid);
    }
    // GLTFLoader replaces whitespace in node names with underscores
    // ("01 drone propeller" arrives as "01_drone_propeller"), so normalize
    // both away. The pivots are plain nodes; meshes are excluded so the
    // "..._Drone_PROPELLER_A_01_remesh" mesh names don't match.
    const norm = child.name.toLowerCase().replace(/[\s_]+/g, '');
    if (child.isMesh && norm.includes('droncamera')) {
      // HUD anchor at the camera module's center, parented to the mesh
      child.geometry.computeBoundingBox();
      const anchor = new THREE.Object3D();
      child.geometry.boundingBox.getCenter(anchor.position);
      child.add(anchor);
      hudAnchors.camera = anchor;
    }
    if (!child.isMesh && norm.includes('dronepropeller')) {
      const p = child.position;
      const dir = Math.abs(p.x * p.z) > 1e-4 ? Math.sign(p.x * p.z) : (flip *= -1);
      propellers.push({
        node: child,
        dir,
        baseQuat: child.quaternion.clone(),
        speed: 0,        // actual speed, follows targetSpeed with inertia
        targetSpeed: 0,  // what the scroll position asks for
        angle: propellers.length * 1.7,  // desynced blade orientations
      });
    }
  });

  // Normalize: center the model and scale its largest side to ~2 units
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = 2 / Math.max(size.x, size.y, size.z);
  model.position.sub(center).multiplyScalar(s);
  model.scale.setScalar(s);

  // Blur discs: bake once from the first blade (all four are identical),
  // then give every propeller its own disc and fadeable blade materials.
  const firstBlade = (() => {
    let m = null;
    if (propellers[0]) { propellers[0].node.traverse((c) => { if (!m && c.isMesh) { m = c; } }); }
    return m;
  })();

  if (firstBlade) {
    const bake = measureBlade(firstBlade);
    const discGeo = new THREE.CircleGeometry(bake.R, 48);

    for (const p of propellers) {
      // own materials so this prop's blades can fade out independently
      p.bladeFace = faceMaterial.clone();
      p.bladeFace.transparent = true;
      p.bladeGrid = gridMaterial.clone();
      bladeFaceMats.push(p.bladeFace);
      bladeGridMats.push(p.bladeGrid);
      p.node.traverse((c) => {
        if (c.isMesh) {
          c.material = p.bladeFace;
          const lines = c.children.find((ch) => ch.isLineSegments);
          if (lines) { lines.material = p.bladeGrid; }
        }
      });

      const discMat = new THREE.MeshBasicMaterial({
        map: discTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0,
      });
      discMats.push(discMat);
      const disc = new THREE.Mesh(discGeo, discMat);
      disc.position.z = bake.zMid;
      disc.visible = false;
      p.node.add(disc);
      p.disc = disc;
      p.discMat = discMat;
    }
    applySettings();
  }

  pivot.add(model);

  // HUD anchor at the top of the body dome (pivot space, model is centered)
  const nbox = new THREE.Box3().setFromObject(model);
  const topAnchor = new THREE.Object3D();
  topAnchor.position.set(0, nbox.max.y * 0.55, 0);
  pivot.add(topAnchor);
  hudAnchors.top = topAnchor;

  modelReady = true;
  needsRender = true;

  console.log(`[ad3d] propellers found: ${propellers.length}`,
    propellers.map((p) => `${p.node.name} (dir ${p.dir})`));
  if (propellers.length === 0) {
    console.warn('[ad3d] no propeller pivots matched — node names in file:',
      (() => { const names = []; model.traverse((c) => names.push(c.name)); return names; })());
  }
}

// Fetch the scrambled model, XOR-decode it in memory, then parse the GLB.
const XOR_KEY = new TextEncoder().encode('AD-KATAN-25');
fetch(MODEL_URL)
  .then((r) => r.arrayBuffer())
  .then((buf) => {
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) { bytes[i] ^= XOR_KEY[i % XOR_KEY.length]; }
    gltfLoader.parse(buf, '', onModelLoaded,
      (err) => console.error('[ad3d] model parse failed', err));
  });

// Scroll progress ----------------------------------------------------------
let targetProgress = 0;
let currentProgress = 0;
let needsRender = true;
let inView = true;

function readScroll() {
  const rect = track.getBoundingClientRect();
  const scrollable = rect.height - window.innerHeight;
  targetProgress = THREE.MathUtils.clamp(-rect.top / scrollable, 0, 1);

  // Section-1 HUD entrance: play when the section pins into view, and undo
  // it (with the same transitions) when the user scrolls back up above it.
  const vh = window.innerHeight;
  if (rect.top <= vh * 0.2 && rect.bottom > vh) {
    hudRoot.classList.add('is-in');
  } else if (rect.top > vh * 0.35) {
    hudRoot.classList.remove('is-in');
  }

}
window.addEventListener('scroll', readScroll, { passive: true });
readScroll();

// Scroll snap ---------------------------------------------------------------
// If the user stops scrolling mid-transition (e.g. at 80% between two poses),
// glide the page to the nearest hold: Before (0), During (0.5) or After (1).
const SNAP_POINTS = [0, 0.5, 1];
const SNAP_RADIUS = 0.09;   // only pull when this close to a hold (in progress units)
let snapTimer = 0;

function trySnap() {
  if (SETTINGS.preview !== 'Scroll') { return; }
  const rect = track.getBoundingClientRect();
  const scrollable = rect.height - window.innerHeight;
  // only while the section is pinned
  if (rect.top > 0 || rect.bottom < window.innerHeight) { return; }
  const p = THREE.MathUtils.clamp(-rect.top / scrollable, 0, 1);

  let nearest = SNAP_POINTS[0];
  for (const s of SNAP_POINTS) {
    if (Math.abs(s - p) < Math.abs(nearest - p)) { nearest = s; }
  }
  const dist = Math.abs(nearest - p);
  if (dist < 0.004) { return; }        // already on a hold
  if (dist > SNAP_RADIUS) { return; }  // too far — don't yank, leave it be

  const top = window.scrollY + rect.top + nearest * scrollable;
  // The host site may run Lenis smooth scroll — native smooth scrollTo would
  // fight its animation loop, so go through Lenis when it's exposed.
  if (window.lenis && typeof window.lenis.scrollTo === 'function') {
    window.lenis.scrollTo(top);
  } else {
    window.scrollTo({ top, behavior: 'smooth' });
  }
}

window.addEventListener('scroll', () => {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(trySnap, 180);
}, { passive: true });

const io = new IntersectionObserver(([entry]) => {
  inView = entry.isIntersecting;
  if (inView) { needsRender = true; }
});
io.observe(track);

// Resize -------------------------------------------------------------------
function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h, false);
  for (const svg of stage.querySelectorAll('.ad3d__lines')) {
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
  // proportional HUD: everything inside is sized in em off this base
  hudScale = THREE.MathUtils.clamp(w / 1100, 0.55, 1.2);
  hudRoot.style.fontSize = `${15.6 * hudScale}px`;
  // center the natural-height sticky block within the viewport while pinned;
  // on mobile the sticky block is full-viewport, so it pins flush to the top
  // on mobile the host page owns `top` (e.g. to clear a fixed nav)
  sticky.style.top = mqMobile.matches
    ? ''
    : `${Math.max(16, (window.innerHeight - sticky.offsetHeight) / 2)}px`;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  needsRender = true;
}
new ResizeObserver(resize).observe(stage);
resize();

// On mobile the heading + intro paragraph scroll away normally — only the
// steps and the 3D panel stay pinned. The intro node is moved out of the
// sticky block into the track (and back when the viewport grows).
const introEl = document.querySelector('.ad3d__intro');
const copyEl  = document.querySelector('.ad3d__copy');

// Variant-A mobile layout: reserve the height of the TALLEST expanded step so
// switching steps never shifts anything, then hand the drone panel whatever
// vertical space remains (its width follows from the 780/640 aspect ratio).
// The element the steps are stacked inside (ad3d__copy locally, or a
// dedicated ad3d__steps wrapper in the Webflow build)
const stepsWrap = steps.length ? steps[0].parentElement : null;
const stepBodies = steps.map((s) => s.querySelector('.ad3d__step-body'));

// Desktop accordion with measured heights. The CSS max-height trick animates
// to a fixed cap (420px) while the real content is ~150px, so the visible
// part only moves in the last third of the animation and it feels abrupt.
// Here each body animates to its exact scrollHeight with a soft ease, the
// closing one collapses first and the opening one follows a beat later.
const STEP_EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';

function applyStepHeights() {
  if (mqMobile.matches) { return; }
  steps.forEach((s, i) => {
    const b = stepBodies[i];
    if (!b) { return; }
    b.style.maxHeight = 'none';
    b.style.overflow = 'hidden';
    if (s.classList.contains('is-active')) {
      b.style.transition = `height 0.8s ${STEP_EASE} 0.2s, opacity 0.5s ease 0.4s, margin-top 0.8s ${STEP_EASE} 0.2s`;
      b.style.height = `${b.scrollHeight}px`;
      b.style.opacity = '1';
      b.style.marginTop = '12px';
    } else {
      b.style.transition = `height 0.6s ${STEP_EASE}, opacity 0.25s ease, margin-top 0.6s ${STEP_EASE}`;
      b.style.height = '0px';
      b.style.opacity = '0';
      b.style.marginTop = '0px';
    }
  });
}

function clearStepHeights() {
  for (const b of stepBodies) {
    if (!b) { continue; }
    for (const prop of ['maxHeight', 'overflow', 'transition', 'height', 'opacity', 'marginTop']) {
      b.style[prop] = '';
    }
  }
}

function layoutMobile() {
  if (!mqMobile.matches || !stepsWrap) {
    if (stepsWrap) {
      for (const prop of ['height', 'position', 'width', 'alignSelf']) { stepsWrap.style[prop] = ''; }
    }
    for (const s of steps) { s.style.opacity = ''; s.style.transform = ''; s.style.transition = ''; }
    stage.style.width = '';
    applyStepHeights();   // desktop accordion (re-measures on resize)
    return;
  }
  clearStepHeights();     // mobile crossfade owns the bodies

  // Steps are absolutely stacked on mobile (crossfade), so their wrapper
  // gets the explicit height of the tallest step — switching never shifts
  // anything below.
  // absolutely positioned steps give their wrapper no size of its own, so
  // force it to full width (a flex parent with align-items: start would
  // otherwise shrink it to zero and the text wraps word by word)
  stepsWrap.style.width = '100%';
  stepsWrap.style.alignSelf = 'stretch';
  stepsWrap.style.position = 'relative';
  let maxH = 0;
  for (const s of steps) { maxH = Math.max(maxH, s.offsetHeight); }
  stepsWrap.style.height = `${maxH}px`;
  // panel width/height on mobile is left to CSS (host page controls it)
  stage.style.width = '';
}

// Mobile crossfade driven by scroll position instead of a timed CSS
// transition: each step is fully visible around its hold (0 / 0.5 / 1),
// fades out on the way to the midpoint, and the next one fades in after a
// small dead zone, drifting in the scroll direction. Scrubs with the finger.
function updateStepsMobile(p) {
  const segs = POSES.length - 1;
  for (let i = 0; i < steps.length; i++) {
    const c = i / segs;                             // this step's hold
    const d = Math.abs(p - c) * segs;               // 0 at hold, 1 at midpoint
    const op = 1 - THREE.MathUtils.smoothstep(d, 0.55, 0.9);
    const dir = Math.sign(p - c) || 0;
    const s = steps[i];
    s.style.transition = 'none';
    s.style.opacity = op.toFixed(3);
    s.style.transform = `translateY(${(-dir * (1 - op) * 14).toFixed(1)}px)`;
  }
}

function placeIntro() {
  // intro/copy may be absent while the host page is still being built —
  // never let a missing text element take the whole module down
  if (introEl && copyEl) {
    try {
      if (mqMobile.matches) {
        // right before the sticky block, whatever wrappers the host page
        // has put around it (Webflow nests it in container divs)
        if (introEl.nextElementSibling !== sticky) {
          sticky.parentElement.insertBefore(introEl, sticky);
        }
        introEl.classList.add('ad3d__intro--out');
      } else if (introEl.parentElement !== copyEl) {
        copyEl.insertBefore(introEl, copyEl.firstChild);
        introEl.classList.remove('ad3d__intro--out');
      }
    } catch (err) {
      console.warn('[ad3d] could not relocate intro:', err);
    }
  }
  layoutMobile();
  resize(); // sticky height changed — recenter/repin it
}
mqMobile.addEventListener('change', placeIntro);
window.addEventListener('resize', layoutMobile);
document.fonts?.ready.then(layoutMobile);   // re-measure once webfonts land
placeIntro();

// Pose interpolation -------------------------------------------------------
const smoothstep = (t) => t * t * (3 - 2 * t);
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
// Remap segment progress into the [start, end] window, clamped to 0/1
// outside it — this is what creates the staggered timing.
const linWindow = (t, start, end) =>
  THREE.MathUtils.clamp((t - start) / (end - start), 0, 1);
const subRange = (t, start, end) => smoothstep(linWindow(t, start, end));

function applyPose(p) {
  const segs = POSES.length - 1;
  const scaled = p * segs;
  const i = Math.min(Math.floor(scaled), segs - 1);
  const raw = scaled - i;
  const a = POSES[i];
  const b = POSES[i + 1];

  // Takeoff (segment 0): props spin up to full speed first, then the drone
  // rises along Y, and only once airborne it tilts into the flight attitude.
  // Landing (segment 1): everything settles down together, props stop last.
  let tPos, tRot;
  if (i === 0) {
    // rise starts first; once it's ~60% up, the tilt joins in and they finish together
    tPos = subRange(raw, 0.4, 0.85);
    tRot = subRange(raw, 0.62, 1.0);
  } else {
    tPos = subRange(raw, 0.0, 0.6);
    tRot = tPos;
  }

  pivot.rotation.set(
    THREE.MathUtils.lerp(a.rot.x, b.rot.x, tRot),
    THREE.MathUtils.lerp(a.rot.y, b.rot.y, tRot),
    THREE.MathUtils.lerp(a.rot.z, b.rot.z, tRot)
  );
  pivot.position.lerpVectors(a.pos, b.pos, tPos);
  pivot.scale.setScalar(THREE.MathUtils.lerp(a.scale, b.scale, tPos));

  // Spin-up is shared: all four motors start together with an eased ramp.
  // Only the wind-down is per-propeller: a small stagger plus easeOutQuad,
  // so each one loses speed fast, then trails off and they stop one by one.
  const stag = SETTINGS.propStagger;
  for (let k = 0; k < propellers.length; k++) {
    let tp;
    if (i === 0) {
      tp = subRange(raw, 0, 0.45);
    } else {
      const s = 0.5 + k * stag;
      tp = easeOutQuad(linWindow(raw, s, Math.min(1, s + 0.3)));
    }
    propellers[k].targetSpeed = THREE.MathUtils.lerp(a.propSpin, b.propSpin, tp);
  }
}

// HUD update ---------------------------------------------------------------
const hudWorld = new THREE.Vector3();

function projectToStage(obj) {
  obj.getWorldPosition(hudWorld).project(camera);
  return {
    x: (hudWorld.x * 0.5 + 0.5) * stage.clientWidth,
    y: (-hudWorld.y * 0.5 + 0.5) * stage.clientHeight,
  };
}

// Leader line: label edge -> short elbow -> 3D target point
function drawCallout(co, target) {
  const stageRect = stage.getBoundingClientRect();
  const rect = co.label.getBoundingClientRect();
  const pad = 8 * hudScale, run = 20 * hudScale, mid = 7 * hudScale;
  let sx, sy, ex, ey;
  if (co.mode === 'right') {
    sx = rect.right - stageRect.left + pad;
    sy = rect.top - stageRect.top + mid;
    ex = sx + run; ey = sy;
  } else if (co.mode === 'left') {
    sx = rect.left - stageRect.left - pad;
    sy = rect.top - stageRect.top + mid;
    ex = sx - run; ey = sy;
  } else { // top
    sx = rect.left - stageRect.left + (rect.width / 2);
    sy = rect.top - stageRect.top - pad * 0.75;
    ex = sx; ey = sy - run * 0.8;
  }
  co.path.setAttribute('d', `M ${sx} ${sy} L ${ex} ${ey} L ${target.x} ${target.y}`);
  co.dot.setAttribute('cx', target.x);
  co.dot.setAttribute('cy', target.y);
}

function setSec(el, op) {
  el.style.opacity = op;
  el.style.visibility = op > 0.01 ? 'visible' : 'hidden';
  return op > 0.01;
}

// Extreme-projected propeller (side: 1 = rightmost on screen, -1 = leftmost)
function extremeProp(side) {
  let best = null;
  for (const p of propellers) {
    const pt = projectToStage(p.node);
    if (!best || (pt.x - best.x) * side > 0) { best = pt; }
  }
  return best;
}

// Rear propeller: the two pivots farthest from the camera are the rear pair;
// side picks which of them (1 = right on screen).
const hudDist = new THREE.Vector3();
function rearProp(side) {
  const pts = [];
  for (const p of propellers) {
    p.node.getWorldPosition(hudDist);
    const dist = hudDist.distanceTo(camera.position);
    const pt = projectToStage(p.node);
    pt.dist = dist;
    pts.push(pt);
  }
  if (!pts.length) { return null; }
  pts.sort((a, b) => b.dist - a.dist);
  const rear = pts.slice(0, 2);
  rear.sort((a, b) => (b.x - a.x) * side);
  return rear[0];
}

function updateHUD() {
  const p = currentProgress;

  // Section layers: Before at the top, During around the middle hold,
  // After at the bottom — each fades over a short progress window.
  const opBefore = THREE.MathUtils.clamp(1 - p * 8, 0, 1);
  const opDuring = THREE.MathUtils.clamp((p - 0.34) / 0.08, 0, 1)
                 * THREE.MathUtils.clamp((0.66 - p) / 0.08, 0, 1);
  const opAfter  = THREE.MathUtils.clamp((p - 0.86) / 0.08, 0, 1);

  // Persistent top-right: battery drains and goes red during takeoff,
  // LIVE shows with the During overlay, Flight complete with After.
  const drain = THREE.MathUtils.clamp((p - 0.12) / 0.22, 0, 1);
  const battVal = Math.round(THREE.MathUtils.lerp(100, 15, drain));
  hudBattVal.textContent = `${battVal}%`;
  hudBattFill.setAttribute('width', Math.max(1.2, 14 * battVal / 100));
  hudBatt.classList.toggle('is-low', battVal <= 30);
  setSec(hudBatt, THREE.MathUtils.clamp((0.82 - p) / 0.08, 0, 1));
  setSec(hudLive, opDuring);
  setSec(hudComplete, opAfter);

  if (setSec(hudSec.before, opBefore)) {
    const propTarget = extremeProp(-1);
    if (propTarget) { drawCallout(hudCallouts.prop, propTarget); }
    if (hudAnchors.top) { drawCallout(hudCallouts.fc, projectToStage(hudAnchors.top)); }
    if (hudAnchors.camera) { drawCallout(hudCallouts.cam, projectToStage(hudAnchors.camera)); }
  }

  if (setSec(hudSec.during, opDuring)) {
    const t = rearProp(1);
    if (t) {
      hudRisk.style.left = `${t.x}px`;
      hudRisk.style.top = `${t.y}px`;
    }
  }

  if (setSec(hudSec.after, opAfter)) {
    const t = rearProp(1);
    if (t) { drawCallout(hudCallouts.motor, t); }
  }
}

// Text step switching ------------------------------------------------------
let activeStep = 0;

function updateSteps(p) {
  if (!steps.length) { return; }
  const next = Math.min(POSES.length - 1, Math.round(p * (POSES.length - 1)));
  if (next !== activeStep) {
    steps[activeStep].classList.remove('is-active');
    steps[next].classList.add('is-active');
    activeStep = next;
    applyStepHeights();
  }
}

// Main loop ----------------------------------------------------------------
const PROP_AXIS = new THREE.Vector3(0, 1, 0);
const propDelta = new THREE.Quaternion();
let lastTime = performance.now();

function tick(now) {
  requestAnimationFrame(tick);

  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (!inView || !modelReady) { return; }

  // GUI preview override: lock the section to one pose while tuning
  if (SETTINGS.preview !== 'Scroll') {
    const idx = POSES.findIndex((p) => p.name === SETTINGS.preview);
    targetProgress = idx / (POSES.length - 1);
  } else {
    readScroll();
  }

  updateSteps(targetProgress);

  if (reducedMotion) {
    currentProgress = targetProgress;
  } else {
    currentProgress += (targetProgress - currentProgress) * (1 - Math.exp(-DAMPING * dt));
  }

  const settled = Math.abs(targetProgress - currentProgress) < EPSILON;
  if (settled) { currentProgress = targetProgress; }

  let spinning = false;
  if (!reducedMotion) {
    for (const p of propellers) {
      // Inertia: catch up fast when accelerating, but when the target drops
      // the actual speed decays on an exponential tail, so at the very end
      // the props coast and ease off instead of stopping with the scroll.
      const target = p.targetSpeed * SETTINGS.propMultiplier;
      const damp = target > p.speed ? 10 : SETTINGS.spinEaseOff;
      p.speed += (target - p.speed) * (1 - Math.exp(-damp * dt));
      if (target < 0.001 && p.speed < 0.05) { p.speed = 0; }

      const v = p.speed;
      if (v > 0.001) {
        spinning = true;
        p.angle += p.dir * v * dt;
        propDelta.setFromAxisAngle(PROP_AXIS, p.angle);
        p.node.quaternion.copy(p.baseQuat).multiply(propDelta);

        // Crossfade blades <-> baked blur disc based on this prop's speed
        if (p.discMat) {
          const span = Math.max(0.1, SETTINGS.discFull - SETTINGS.discStart);
          const fade = THREE.MathUtils.clamp((v - SETTINGS.discStart) / span, 0, 1);
          p.disc.visible = fade > 0.01 && SETTINGS.discStrength > 0.01;
          p.discMat.opacity = fade * SETTINGS.discStrength;
          p.bladeFace.opacity = 1 - fade;
          p.bladeGrid.uniforms.uOpacity.value = SETTINGS.gridOpacity * (1 - fade);
          // The disc sits inside the spinning pivot — cancel out most of the
          // spin so the streaks in the texture drift slowly instead of strobing
          p.disc.rotation.z = -p.angle * (1 - SETTINGS.discDrift);
        }
      }
    }
  }

  // Renders while scrolling or spinning; goes fully idle once the drone
  // has landed (props stopped) and the scroll position has settled.
  if (needsRender || !settled || spinning) {
    applyPose(currentProgress);
    renderer.render(scene, camera);
    updateHUD();
    if (mqMobile.matches) { updateStepsMobile(currentProgress); }
    needsRender = !settled;
  }
}
requestAnimationFrame(tick);

// ==========================================================================
// Tuning GUI
// ==========================================================================
const gui = new GUI({ title: 'Tuning' });
// controls are hidden unless the page is opened with ?showMaster
if (!new URLSearchParams(window.location.search).has('showOptions')) {
  gui.hide();
}

// Pose controls hidden — poses are final. Re-enable by flipping this flag.
const SHOW_POSE_CONTROLS = false;
if (SHOW_POSE_CONTROLS) {
  gui.add(SETTINGS, 'preview', ['Scroll', 'Before', 'During', 'After'])
     .name('Preview pose');
}
if (SHOW_POSE_CONTROLS) {
  for (const pose of POSES) {
    const f = gui.addFolder(`Pose: ${pose.name}`);
    f.add(pose.rot, 'x', -Math.PI, Math.PI, 0.01).name('rot X (tilt)').onChange(applySettings);
    f.add(pose.rot, 'y', -Math.PI * 2, Math.PI * 2, 0.01).name('rot Y (yaw)').onChange(applySettings);
    f.add(pose.rot, 'z', -Math.PI, Math.PI, 0.01).name('rot Z (roll)').onChange(applySettings);
    f.add(pose.pos, 'x', -3, 3, 0.01).name('pos X').onChange(applySettings);
    f.add(pose.pos, 'y', -3, 3, 0.01).name('pos Y').onChange(applySettings);
    f.add(pose.pos, 'z', -3, 3, 0.01).name('pos Z').onChange(applySettings);
    f.add(pose, 'scale', 0.2, 2, 0.01).onChange(applySettings);
    f.add(pose, 'propSpin', 0, 60, 0.5).name('prop speed').onChange(applySettings);
    f.close();
  }
}

const fProps = gui.addFolder('Propellers');
fProps.add(SETTINGS, 'propAxis', ['X', 'Y', 'Z']).name('spin axis').onChange(applySettings);
fProps.add(SETTINGS, 'propMultiplier', 0, 3, 0.05).name('speed multiplier').onChange(applySettings);
fProps.add(SETTINGS, 'propStagger', 0, 0.12, 0.005).name('stop stagger').onChange(applySettings);
fProps.add(SETTINGS, 'spinEaseOff', 0.5, 6, 0.1).name('stop ease (lower = longer)').onChange(applySettings);
fProps.add(SETTINGS, 'discStrength', 0, 2, 0.05).name('disc opacity').onChange(applySettings);
fProps.add(SETTINGS, 'discDrift', 0, 0.3, 0.005).name('disc spin').onChange(applySettings);
fProps.add(SETTINGS, 'discScale', 0.5, 1.5, 0.01).name('disc scale').onChange(applySettings);
fProps.add(SETTINGS, 'discStart', 0, 30, 0.5).name('fade start (rad/s)').onChange(applySettings);
fProps.add(SETTINGS, 'discFull', 0, 30, 0.5).name('fade full (rad/s)').onChange(applySettings);
fProps.addColor(SETTINGS, 'discColor').name('disc tint').onChange(applySettings);
fProps.close();

const fLight = gui.addFolder('Lights');
fLight.add(SETTINGS, 'hemiIntensity', 0, 4, 0.05).name('hemi intensity').onChange(applySettings);
fLight.addColor(SETTINGS, 'hemiSky').name('hemi sky').onChange(applySettings);
fLight.addColor(SETTINGS, 'hemiGround').name('hemi ground').onChange(applySettings);
fLight.add(SETTINGS, 'keyIntensity', 0, 6, 0.05).name('key intensity').onChange(applySettings);
fLight.add(SETTINGS, 'keyX', -10, 10, 0.1).onChange(applySettings);
fLight.add(SETTINGS, 'keyY', -10, 10, 0.1).onChange(applySettings);
fLight.add(SETTINGS, 'keyZ', -10, 10, 0.1).onChange(applySettings);
fLight.add(SETTINGS, 'rimIntensity', 0, 6, 0.05).name('rim intensity').onChange(applySettings);
fLight.add(SETTINGS, 'rimX', -10, 10, 0.1).onChange(applySettings);
fLight.add(SETTINGS, 'rimY', -10, 10, 0.1).onChange(applySettings);
fLight.add(SETTINGS, 'rimZ', -10, 10, 0.1).onChange(applySettings);
fLight.close();

const fLook = gui.addFolder('Materials & stage');
fLook.addColor(SETTINGS, 'background').onChange(applySettings);
fLook.addColor(SETTINGS, 'faceColor').name('face color').onChange(applySettings);
fLook.addColor(SETTINGS, 'gridColor').name('grid color').onChange(applySettings);
fLook.add(SETTINGS, 'gridOpacity', 0, 1, 0.01).name('grid opacity').onChange(applySettings);
fLook.add(SETTINGS, 'gridAmbient', 0, 1, 0.01).name('grid ambient').onChange(applySettings);
fLook.add(SETTINGS, 'gridContrast', 0.3, 4, 0.05).name('grid contrast').onChange(applySettings);
fLook.add(SETTINGS, 'renderScale', 0.5, 2, 0.05).name('sharpness (lower = thicker grid)').onChange(applySettings);
fLook.close();

const fCam = gui.addFolder('Camera');
fCam.add(SETTINGS, 'camY', -3, 3, 0.05).name('camera Y').onChange(applySettings);
fCam.add(SETTINGS, 'camZ', 2, 12, 0.05).name('camera distance').onChange(applySettings);
fCam.close();

// Copy all current values as JSON ------------------------------------------
function snapshot() {
  const out = { settings: { ...SETTINGS } };
  if (SHOW_POSE_CONTROLS) {
    out.poses = POSES.map((p) => ({
      name: p.name,
      rot: [+p.rot.x.toFixed(3), +p.rot.y.toFixed(3), +p.rot.z.toFixed(3)],
      pos: [+p.pos.x.toFixed(3), +p.pos.y.toFixed(3), +p.pos.z.toFixed(3)],
      scale: +p.scale.toFixed(3),
      propSpin: p.propSpin,
    }));
  }
  return out;
}

gui.add({
  copy: async () => {
    const json = JSON.stringify(snapshot(), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      gui.title('Copied! ✔');
    } catch {
      console.log(json);
      gui.title('Clipboard blocked — see console');
    }
    setTimeout(() => gui.title('Tuning'), 1500);
  },
}, 'copy').name('Copy values');

applySettings();
