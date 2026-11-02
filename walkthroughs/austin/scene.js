// 3D daylight scene of the Circuit of the Americas on real terrain.
// World units are metres. Local frame from build-data: x = east, y = north, z = up (above datum).
// three.js frame: X = east, Y = up, Z = -north.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Sky } from 'three/addons/objects/Sky.js';

export const SECTOR_GLOW = ['#ff4d6d', '#3ec5ff', '#ffd23f'];
const TRACK_W = 14;
const RACE_DAY = { y: 2026, m: 10, d: 25, utcOffset: -5 }; // Sunday 25 Oct 2026, CDT
const LAT = 30.1346, LON = -97.6359;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Solar elevation/azimuth (radians; azimuth clockwise from north). Low-precision almanac, good to ~0.1°. */
export function sunPosition(date, lat = LAT, lon = LON) {
  const rad = Math.PI / 180;
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const ha = (gmst * 15 + lon) * rad - ra;
  const la = lat * rad;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { el, az: (az + 2 * Math.PI) % (2 * Math.PI) };
}
export const raceDayDate = (hours) => new Date(Date.UTC(RACE_DAY.y, RACE_DAY.m - 1, RACE_DAY.d, 0, 0) + (hours - RACE_DAY.utcOffset) * 3600e3);

// ---------------------------------------------------------------- low-poly F1 car (forward = +Z, 1:1 scale)
function makeCar(colour, { ghost = false } = {}) {
  const g = new THREE.Group();
  const opts = ghost ? { transparent: true, opacity: 0.38, depthWrite: false } : {};
  const paint = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.35, metalness: 0.45, ...opts });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.55, metalness: 0.3, ...opts });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.9, ...opts });
  const rim = new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.4, metalness: 0.8, ...opts });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = !ghost; g.add(m); return m; };
  // taper a box along z: front face scaled to (fx, fy)
  const taper = (w, h, l, fx, fy, back = 1) => {
    const geo = new THREE.BoxGeometry(w, h, l);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const front = p.getZ(i) > 0;
      const s = front ? fx : back;
      p.setX(i, p.getX(i) * s);
      if (front) p.setY(i, (p.getY(i) + h / 2) * fy - h / 2);
    }
    geo.computeVertexNormals();
    return geo;
  };
  add(new THREE.BoxGeometry(1.5, 0.05, 4.4), carbon, 0, 0.07, -0.1); // floor
  add(taper(0.78, 0.55, 2.0, 0.75, 0.85), paint, 0, 0.4, 0.55); // tub
  add(taper(0.55, 0.32, 1.25, 0.32, 0.55), paint, 0, 0.32, 2.1); // nose
  add(taper(0.8, 0.72, 2.2, 0.95, 1, 0.4), paint, 0, 0.47, -1.05); // engine cover
  for (const s of [-1, 1]) add(taper(0.5, 0.42, 1.7, 1, 1, 0.55), paint, s * 0.62, 0.32, -0.35); // sidepods
  add(new THREE.BoxGeometry(1.9, 0.04, 0.42), carbon, 0, 0.14, 2.62); // front wing
  add(new THREE.BoxGeometry(1.7, 0.03, 0.22), paint, 0, 0.22, 2.55, -0.25);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.03, 0.26, 0.5), carbon, s * 0.95, 0.2, 2.6);
  add(new THREE.BoxGeometry(1.0, 0.04, 0.38), carbon, 0, 0.95, -2.3); // rear wing
  add(new THREE.BoxGeometry(1.0, 0.03, 0.22), paint, 0, 1.05, -2.36, 0.3);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.03, 0.55, 0.5), paint, s * 0.5, 0.82, -2.3);
  add(new THREE.BoxGeometry(0.06, 0.5, 0.18), carbon, 0, 0.62, -2.2);
  add(new THREE.SphereGeometry(0.15, 14, 10), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.3, ...opts }), 0, 0.76, 0.12); // helmet
  const halo = add(new THREE.TorusGeometry(0.32, 0.035, 6, 20, Math.PI), carbon, 0, 0.8, 0.25, -Math.PI / 2 + 0.15, 0, 0);
  halo.rotation.order = 'YXZ';
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.42, 6), carbon, 0, 0.82, 0.62, Math.PI / 2 - 0.5);
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.37, 22).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.38, 14).rotateZ(Math.PI / 2);
  for (const [z, w] of [[1.62, 0.33], [-1.55, 0.4]])
    for (const s of [-1, 1]) {
      add(wheelGeo, tyre, s * 0.8, 0.36, z).scale.set(w / 0.37, 1, 1);
      add(rimGeo, rim, s * 0.8, 0.36, z).scale.set(w / 0.37 + 0.02, 1, 1);
    }
  return g;
}

// ---------------------------------------------------------------- COTA Observation Tower
function makeTower(h) {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fc4d8, roughness: 0.1, metalness: 0.6 });
  const red = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.45, metalness: 0.35 });
  const deckY = h - 9;
  const core = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.4, deckY, 18), white);
  core.position.y = deckY / 2;
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 7.5, 3, 28), glass);
  deck.position.y = deckY + 1.5;
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(6, 9, 1.2, 28), white);
  roof.position.y = deckY + 3.6;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, h - deckY - 4, 8), white);
  mast.position.y = deckY + 4 + (h - deckY - 4) / 2;
  g.add(core, deck, roof, mast);
  // the red steel "veil": straight tubes between two rotated rings form a hyperboloid
  const N = 30, base = 17, top = 7.5, twist = Math.PI * 0.62;
  const tube = new THREE.CylinderGeometry(0.22, 0.32, 1, 6);
  const veil = new THREE.InstancedMesh(tube, red, N);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const p0 = new THREE.Vector3(Math.cos(a) * base, 0, Math.sin(a) * base);
    const p1 = new THREE.Vector3(Math.cos(a + twist) * top, deckY + 0.5, Math.sin(a + twist) * top);
    const dir = p1.clone().sub(p0);
    q.setFromUnitVectors(up, dir.clone().normalize());
    m.compose(p0.clone().add(p1).multiplyScalar(0.5), q, new THREE.Vector3(1, dir.length(), 1));
    veil.setMatrixAt(i, m);
  }
  g.add(veil);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export async function createScene(container, { track, city, terrainBuf, zones = [] }) {
  // ------------------------------------------------------------ renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'labels-layer';
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xb9c6d6, 2600, 12000);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 40000);
  camera.position.set(0, 1500, 1800);
  const BASE_FOV = 40;

  const controls = new OrbitControls(camera, labelRenderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.485;
  controls.minDistance = 4;
  controls.maxDistance = 7000;
  controls.screenSpacePanning = false;

  // ------------------------------------------------------------ terrain sampling
  const ter = track.terrain;
  const TN = ter.n, TS = ter.step;
  const heights = new Float32Array(TN * TN);
  {
    const u16 = new Uint16Array(terrainBuf);
    for (let k = 0; k < heights.length; k++) heights[k] = u16[k] * ter.scale;
  }
  // fade the outer ring to a constant height so the terrain meets the far plain without a seam
  let edgeMean = 0, edgeN = 0;
  for (let k = 0; k < TN; k++) { edgeMean += heights[k] + heights[(TN - 1) * TN + k] + heights[k * TN] + heights[k * TN + TN - 1]; edgeN += 4; }
  edgeMean /= edgeN;
  const FADE = 34; // grid cells (~270 m)
  for (let j = 0; j < TN; j++)
    for (let i = 0; i < TN; i++) {
      const e = Math.min(i, j, TN - 1 - i, TN - 1 - j);
      if (e < FADE + 10) { const f = smooth(10, FADE + 10, e); heights[j * TN + i] = edgeMean + (heights[j * TN + i] - edgeMean) * f; }
    }
  function heightAt(x, y) {
    const fx = (x - ter.x0) / TS, fy = (y - ter.y0) / TS;
    const i = Math.max(0, Math.min(TN - 2, Math.floor(fx))), j = Math.max(0, Math.min(TN - 2, Math.floor(fy)));
    const ax = Math.min(1, Math.max(0, fx - i)), ay = Math.min(1, Math.max(0, fy - j));
    const a = heights[j * TN + i], b = heights[j * TN + i + 1], c = heights[(j + 1) * TN + i], d = heights[(j + 1) * TN + i + 1];
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
  }

  // ------------------------------------------------------------ track helpers
  const N = track.line.length;
  const step = track.step_m;
  const L = track.length_m;
  const P = track.line.map(([x, y, z]) => new THREE.Vector3(x, z + 0.04, -y));
  const Tn = P.map((_, i) => P[(i + 2) % N].clone().sub(P[(i - 2 + N) % N]).setY(0).normalize());
  const Lf = Tn.map((t) => new THREE.Vector3(t.z, 0, -t.x));
  const wrapD = (d) => ((d % L) + L) % L;
  function pointAt(d, out = new THREE.Vector3()) {
    const f = wrapD(d) / step;
    const i = Math.floor(f) % N;
    return out.copy(P[i]).lerp(P[(i + 1) % N], f - Math.floor(f));
  }
  function tangentAt(d, out = new THREE.Vector3()) {
    const f = wrapD(d) / step;
    const i = Math.floor(f) % N;
    return out.copy(Tn[i]).lerp(Tn[(i + 1) % N], f - Math.floor(f)).normalize();
  }
  const sectorOfD = (d) => (d < track.sectors[0] ? 0 : d < track.sectors[1] ? 1 : 2);
  const gradeAt = (i) => (P[(i + 5) % N].y - P[(i - 5 + N) % N].y) / (10 * step);

  const lapRows = track.laps.q2026.rows;
  function speedAtD(d) {
    let lo = 0, hi = lapRows.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (lapRows[m][1] < d) lo = m; else hi = m; }
    const a = lapRows[lo], b = lapRows[hi];
    const f = b[1] === a[1] ? 0 : Math.min(1, Math.max(0, (d - a[1]) / (b[1] - a[1])));
    return a[2] + (b[2] - a[2]) * f;
  }

  function ribbon(i0, i1, offA, offB, yA, yB, colorFn, closed = false) {
    const pos = [], col = [], idx = [];
    const count = closed ? N + 1 : i1 - i0 + 1;
    const c = new THREE.Color();
    for (let k = 0; k < count; k++) {
      const i = (((closed ? k : i0 + k) % N) + N) % N;
      const p = P[i], l = Lf[i];
      pos.push(p.x + l.x * offA, p.y + yA, p.z + l.z * offA, p.x + l.x * offB, p.y + yB, p.z + l.z * offB);
      colorFn(i, k, c);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (k < count - 1) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  // Ribbon whose width grows with camera distance, so lines stay legible from the overview.
  function screenRibbon(i0, i1, off, half, colorFn, { closed = false, maxScale = 9, lift = 0.1 } = {}) {
    const pos = [], col = [], side = [], left = [], idx = [];
    const count = closed ? N + 1 : i1 - i0 + 1;
    const c = new THREE.Color();
    for (let k = 0; k < count; k++) {
      const i = (((closed ? k : i0 + k) % N) + N) % N;
      const p = P[i], l = Lf[i];
      colorFn(i, k, c);
      for (const s of [1, -1]) { pos.push(p.x, p.y + lift, p.z); left.push(l.x, 0, l.z); side.push(s); col.push(c.r, c.g, c.b); }
      if (k < count - 1) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    g.setAttribute('aLeft', new THREE.Float32BufferAttribute(left, 3));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: { uHalf: { value: half }, uOff: { value: off }, uMax: { value: maxScale }, uRef: { value: 180 }, uBright: { value: 1 }, uOpacity: { value: 1 } },
      vertexShader: `attribute float aSide; attribute vec3 aLeft; attribute vec3 color; varying vec3 vC;
        uniform float uHalf, uOff, uMax, uRef;
        void main(){ vC = color; vec4 w = modelMatrix*vec4(position,1.);
          float dist = distance(w.xyz, cameraPosition);
          float k = clamp(dist/uRef, 1., uMax);
          w.xyz += aLeft*(uOff*k + aSide*uHalf*k);
          w.y += dist*0.0012;
          gl_Position = projectionMatrix*viewMatrix*w; }`,
      fragmentShader: `varying vec3 vC; uniform float uBright, uOpacity; void main(){ gl_FragColor = vec4(vC*uBright, uOpacity); }`,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return mesh;
  }

  // ------------------------------------------------------------ sky, sun, environment
  const sky = new Sky();
  sky.scale.setScalar(30000);
  const su = sky.material.uniforms;
  su.turbidity.value = 4.5;
  su.rayleigh.value = 1.2;
  su.mieCoefficient.value = 0.004;
  su.mieDirectionalG.value = 0.82;
  scene.add(sky);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(1000);
  envSky.material.uniforms = su;
  envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null;

  const hemi = new THREE.HemisphereLight(0xbcd3ff, 0x6b5a3a, 0.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  const circuitCentre = (() => {
    const b = new THREE.Box3().setFromPoints(P);
    return b.getCenter(new THREE.Vector3());
  })();
  const sunDir = new THREE.Vector3();
  let shadowFocus = null; // null = whole circuit
  function placeShadowCamera() {
    const sc = sun.shadow.camera;
    const focus = shadowFocus || circuitCentre;
    const R = shadowFocus ? 160 : 1500;
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(sunDir, 2600);
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R;
    sc.near = 100; sc.far = 5200;
    sc.updateProjectionMatrix();
  }
  let sunHours = 15;
  function setTimeOfDay(hours) {
    sunHours = hours;
    const { el, az } = sunPosition(raceDayDate(hours));
    sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    su.sunPosition.value.copy(sunDir);
    const day = smooth(-0.06, 0.2, el);
    const warm = 1 - smooth(0.03, 0.45, el);
    sun.intensity = 3.0 * smooth(-0.03, 0.12, el);
    sun.color.setHSL(0.09 - 0.03 * warm, 0.35 + 0.55 * warm, 0.62 + 0.3 * (1 - warm));
    hemi.intensity = 0.15 + 0.55 * day;
    hemi.color.setHSL(0.6, 0.5, 0.55 + 0.2 * day);
    renderer.toneMappingExposure = 0.36 + 0.24 * day;
    scene.fog.color.setHSL(0.58 - 0.5 * warm * 0.18, 0.25 + 0.2 * warm, 0.12 + 0.6 * day * (1 - 0.25 * warm));
    placeShadowCamera();
    clearTimeout(setTimeOfDay.t);
    setTimeOfDay.t = setTimeout(() => {
      envRT?.dispose();
      envRT = pmrem.fromScene(envScene, 0, 1, 2000);
      scene.environment = envRT.texture;
      scene.environmentIntensity = 0.55;
    }, 60);
    return { elevationDeg: (el * 180) / Math.PI, azimuthDeg: (az * 180) / Math.PI };
  }

  // ------------------------------------------------------------ painted ground texture (OpenStreetMap features)
  const maxTex = renderer.capabilities.maxTextureSize;
  const TEX = Math.min(maxTex >= 8192 && window.devicePixelRatio > 1 && innerWidth > 900 ? 8192 : 4096, maxTex);
  const B = city.bounds;
  const cv = document.createElement('canvas');
  cv.width = cv.height = TEX;
  const cx2 = cv.getContext('2d');
  const sx = (x) => ((x - B.x0) / B.size) * TEX;
  const sy = (y) => (1 - (y - B.y0) / B.size) * TEX;
  const pxPerM = TEX / B.size;
  {
    // base: late-October central Texas pasture, mottled
    cx2.fillStyle = '#8c8d55';
    cx2.fillRect(0, 0, TEX, TEX);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const tones = ['#7d824a', '#99935a', '#868a4e', '#a09a63', '#74794a', '#8f8a52'];
    for (let k = 0; k < 9000; k++) {
      cx2.fillStyle = tones[k % tones.length];
      cx2.globalAlpha = 0.18 + rnd() * 0.25;
      const r = (8 + rnd() * 60) * pxPerM;
      cx2.beginPath();
      cx2.ellipse(rnd() * TEX, rnd() * TEX, r, r * (0.5 + rnd() * 0.5), rnd() * Math.PI, 0, Math.PI * 2);
      cx2.fill();
    }
    // tree clumps along creeks and field edges are typical here; sprinkle dark dots, sparser near the circuit
    for (let k = 0; k < 14000; k++) {
      const x = rnd() * TEX, y = rnd() * TEX;
      const wx = B.x0 + (x / TEX) * B.size, wy = B.y0 + (1 - y / TEX) * B.size;
      if (Math.hypot(wx - circuitCentre.x, wy + circuitCentre.z) < 900 && rnd() < 0.85) continue;
      cx2.globalAlpha = 0.5 + rnd() * 0.3;
      cx2.fillStyle = rnd() < 0.5 ? '#4a5530' : '#5a6236';
      cx2.beginPath();
      cx2.arc(x, y, (2 + rnd() * 4) * pxPerM, 0, Math.PI * 2);
      cx2.fill();
    }
    cx2.globalAlpha = 1;
    const unpackPath = (arr, from = 0) => {
      cx2.moveTo(sx(arr[from]), sy(arr[from + 1]));
      for (let i = from + 2; i < arr.length; i += 2) cx2.lineTo(sx(arr[i]), sy(arr[i + 1]));
      cx2.closePath();
    };
    const fillPolys = (polys, color, { stroke = null, lw = 0 } = {}) => {
      cx2.fillStyle = color;
      for (const p of polys) {
        cx2.beginPath();
        unpackPath(p.outer);
        for (const h of p.holes) unpackPath(h);
        cx2.fill('evenodd');
        if (stroke) { cx2.strokeStyle = stroke; cx2.lineWidth = lw; cx2.stroke(); }
      }
    };
    const strokeLines = (arr, color, wFn, { from = 1, cap = 'round', dash = null } = {}) => {
      cx2.strokeStyle = color;
      cx2.lineCap = cap;
      cx2.lineJoin = 'round';
      cx2.setLineDash(dash || []);
      for (const r of arr) {
        cx2.lineWidth = Math.max(0.8, wFn(r) * pxPerM);
        cx2.beginPath();
        cx2.moveTo(sx(r[from]), sy(r[from + 1]));
        for (let i = from + 2; i < r.length; i += 2) cx2.lineTo(sx(r[i]), sy(r[i + 1]));
        cx2.stroke();
      }
      cx2.setLineDash([]);
    };
    const G = city.ground;
    fillPolys(G.scrub, '#5b6638');
    fillPolys(G.grass, '#6f8a3e');
    strokeLines(city.lines.roads, '#4d4c4a', (r) => r[0] + 1.2);
    strokeLines(city.lines.roads, '#6a6965', (r) => r[0]);
    cx2.globalAlpha = 0.55;
    fillPolys(G.parking, '#9b9884');
    cx2.globalAlpha = 1;
    strokeLines(city.lines.paths, '#c9bea6', (r) => r[0]);
    fillPolys(G.plaza, '#d6d0c2');
    fillPolys(G.water, '#3e6f86', { stroke: '#7f8e6a', lw: 2 });
    fillPolys(G.gravel, '#c8b38a');
    fillPolys(G.runoffGravel, '#cdb88f');
    fillPolys(G.runoff, '#55565a');
    fillPolys(G.raceway, '#3f4044');
    fillPolys(G.runoffWhite, '#e6e5e0');
    fillPolys(G.runoffRed, '#c41e2e');
    fillPolys(G.runoffBlue, '#1e4aa3');
    fillPolys(G.kerb, '#d6d6d6');
    fillPolys(G.bleachers, '#a3a7ad');
    strokeLines(city.lines.markings.map((m) => [0, ...m]), 'rgba(255,255,255,0.85)', () => 0.35);
    strokeLines(city.lines.barriers, '#b9bcc2', (r) => (r[0] ? 0.8 : 0.4));
  }
  const groundTex = new THREE.CanvasTexture(cv);
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  groundTex.generateMipmaps = true;
  groundTex.minFilter = THREE.LinearMipmapLinearFilter;

  // ------------------------------------------------------------ terrain mesh
  const terrain = (() => {
    const pos = new Float32Array(TN * TN * 3), uv = new Float32Array(TN * TN * 2);
    for (let j = 0; j < TN; j++)
      for (let i = 0; i < TN; i++) {
        const k = j * TN + i;
        const x = ter.x0 + i * TS, y = ter.y0 + j * TS;
        pos[k * 3] = x; pos[k * 3 + 1] = heights[k]; pos[k * 3 + 2] = -y;
        uv[k * 2] = (x - B.x0) / B.size; uv[k * 2 + 1] = (y - B.y0) / B.size;
      }
    const idx = new Uint32Array((TN - 1) * (TN - 1) * 6);
    let p = 0;
    for (let j = 0; j < TN - 1; j++)
      for (let i = 0; i < TN - 1; i++) {
        const a = j * TN + i, b = a + 1, c = a + TN, d = c + 1;
        idx[p++] = a; idx[p++] = b; idx[p++] = c; idx[p++] = b; idx[p++] = d; idx[p++] = c; // counter-clockwise seen from above
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.96, metalness: 0 });
    // tiling detail noise so the ground keeps some texture up close, where the painted map is soft
    const dc = document.createElement('canvas');
    dc.width = dc.height = 256;
    const dx = dc.getContext('2d');
    const img = dx.createImageData(256, 256);
    let sd = 11;
    const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    const base = new Float32Array(32 * 32).map(() => rnd());
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        const gx = (x / 256) * 32, gy = (y / 256) * 32, i0 = Math.floor(gx), j0 = Math.floor(gy), fx = gx - i0, fy = gy - j0;
        const at = (i, j) => base[((j + 32) % 32) * 32 + ((i + 32) % 32)];
        const v = (at(i0, j0) * (1 - fx) + at(i0 + 1, j0) * fx) * (1 - fy) + (at(i0, j0 + 1) * (1 - fx) + at(i0 + 1, j0 + 1) * fx) * fy;
        const n = Math.round(255 * (0.55 * v + 0.45 * rnd()));
        const k = (y * 256 + x) * 4;
        img.data[k] = img.data[k + 1] = img.data[k + 2] = n;
        img.data[k + 3] = 255;
      }
    dx.putImageData(img, 0, 0);
    const detail = new THREE.CanvasTexture(dc);
    detail.wrapS = detail.wrapT = THREE.RepeatWrapping;
    detail.anisotropy = 4;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uDetail = { value: detail };
      sh.uniforms.uDetailScale = { value: B.size / 9 };
      sh.fragmentShader = 'uniform sampler2D uDetail; uniform float uDetailScale;\n' + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        float dn = texture2D(uDetail, vMapUv * uDetailScale).r;
        float dn2 = texture2D(uDetail, vMapUv * uDetailScale * 0.113).r;
        diffuseColor.rgb *= 0.8 + 0.4 * (dn * 0.55 + dn2 * 0.45);`);
    };
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    return m;
  })();
  scene.add(terrain);
  // far plain: a ring that starts inside the terrain's flat outer band, so the two never overlap where the terrain dips
  const tcx = ter.x0 + ((TN - 1) * TS) / 2, tcy = ter.y0 + ((TN - 1) * TS) / 2;
  const plain = new THREE.Mesh(new THREE.RingGeometry(((TN - 1) * TS) / 2 - 60, 36000, 96, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x858654, roughness: 1 }));
  plain.position.set(tcx, edgeMean - 0.15, -tcy);
  plain.receiveShadow = true;
  scene.add(plain);

  // ------------------------------------------------------------ buildings & grandstands
  const buildings = (() => {
    const pos = [], nor = [], col = [];
    const c = new THREE.Color();
    for (const b of city.buildings) {
      const kind = b[0], H = b[1], base = b[2];
      let ring = [];
      for (let i = 3; i < b.length; i += 2) ring.push(new THREE.Vector2(b[i], b[i + 1]));
      if (ring.length < 3) continue;
      if (THREE.ShapeUtils.isClockWise(ring)) ring = ring.reverse();
      const y0 = base - 3, y1 = base + H;
      const wall = kind === 'g' ? new THREE.Color(0x5d6676) : new THREE.Color(0xd8d2c4);
      const roofC = kind === 'g' ? new THREE.Color(0xf1f1ef) : new THREE.Color(0xb9b6ae);
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], d = ring[(i + 1) % ring.length];
        const len = Math.hypot(d.x - a.x, d.y - a.y) || 1;
        const nx = (d.y - a.y) / len, nz = (d.x - a.x) / len;
        for (const [p, y] of [[a, y0], [d, y0], [d, y1], [a, y0], [d, y1], [a, y1]]) {
          pos.push(p.x, y, -p.y); nor.push(nx, 0, nz);
          c.copy(wall).multiplyScalar(y === y1 ? 1 : 0.8); col.push(c.r, c.g, c.b);
        }
      }
      for (const t of THREE.ShapeUtils.triangulateShape(ring, [])) for (const k of [t[0], t[2], t[1]]) { pos.push(ring[k].x, y1, -ring[k].y); nor.push(0, 1, 0); col.push(roofC.r, roofC.g, roofC.b); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
    m.castShadow = m.receiveShadow = true;
    return m;
  })();
  scene.add(buildings);

  let tower = null;
  if (city.tower) {
    tower = makeTower(city.tower.h);
    tower.position.set(city.tower.x, city.tower.z, -city.tower.y);
    scene.add(tower);
  }

  // ------------------------------------------------------------ track meshes
  const trackGroup = new THREE.Group();
  scene.add(trackGroup);
  const asphaltMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const asphalt = new THREE.Mesh(ribbon(0, 0, TRACK_W / 2, -TRACK_W / 2, 0, 0, (i, k, c) => c.setRGB(0.2, 0.205, 0.215).multiplyScalar(0.95 + 0.1 * Math.sin(i * 1.7)), true), asphaltMat);
  asphalt.receiveShadow = true;
  trackGroup.add(asphalt);
  const paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const s of [1, -1]) {
    const e = new THREE.Mesh(ribbon(0, 0, s * (TRACK_W / 2 - 0.35), s * (TRACK_W / 2 - 0.1), 0.01, 0.01, (i, k, c) => c.setRGB(0.92, 0.92, 0.9), true), paintMat);
    e.receiveShadow = true;
    trackGroup.add(e);
  }
  // kerbs: inside of each corner and the outside on exit
  for (const cn of track.corners) {
    const side = cn.dir === 'left' ? 1 : -1;
    const ci = Math.round(cn.d / step);
    const span = Math.round(Math.min(14, Math.max(6, Math.abs(cn.headingChange) / 7)));
    const mk = (i0, i1, s) => {
      const g = ribbon(i0, i1, s * (TRACK_W / 2 - 1.1), s * (TRACK_W / 2 + 0.6), 0.03, 0.08, (i, k, c) => c.set(Math.floor(k / 1) % 2 ? 0xf4f4f4 : 0xd2141e));
      const m = new THREE.Mesh(g, paintMat);
      m.receiveShadow = true;
      trackGroup.add(m);
    };
    mk(ci - span, ci + span, side);
    mk(ci + span, ci + span * 2 + 4, -side);
  }
  // start/finish chequer & grid slots
  {
    const c2 = document.createElement('canvas');
    c2.width = 64; c2.height = 8;
    const x = c2.getContext('2d');
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { x.fillStyle = (i + j) % 2 ? '#fff' : '#111'; x.fillRect(i * 4, j * 4, 4, 4); }
    const tex = new THREE.CanvasTexture(c2);
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W, 1.6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(P[0]).setY(P[0].y + 0.02);
    m.rotation.z = Math.atan2(Lf[0].x, Lf[0].z) + Math.PI / 2;
    trackGroup.add(m);
    const slotMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    for (let k = 0; k < 22; k++) {
      const d = -10 - k * 8;
      const p = pointAt(d), t = tangentAt(d);
      const lat = (k % 2 ? -1 : 1) * 2.6;
      const slot = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.25).rotateX(-Math.PI / 2), slotMat);
      slot.position.copy(p).addScaledVector(new THREE.Vector3(t.z, 0, -t.x), lat).setY(p.y + 0.02);
      slot.rotation.y = Math.atan2(t.x, t.z);
      trackGroup.add(slot);
    }
  }
  // racing line, coloured by mode
  const lineMesh = screenRibbon(0, 0, 0, 0.8, (i, k, c) => c.set(SECTOR_GLOW[sectorOfD(i * step)]), { closed: true, maxScale: 4.5 });
  trackGroup.add(lineMesh);
  let lineMode = 'sector';
  function recolor(mode) {
    lineMode = mode;
    const col = lineMesh.geometry.attributes.color;
    const c = new THREE.Color();
    const slow = new THREE.Color('#5b2a86'), mid = new THREE.Color('#f04e98'), fast = new THREE.Color('#ffe066');
    const down = new THREE.Color('#2f8fff'), flat = new THREE.Color('#f2f2f2'), up = new THREE.Color('#ff4b2b');
    for (let k = 0; k <= N; k++) {
      const i = k % N, d = i * step;
      if (mode === 'speed') {
        const t = Math.min(1, Math.max(0, (speedAtD(d) - 70) / (340 - 70)));
        if (t < 0.5) c.copy(slow).lerp(mid, t * 2); else c.copy(mid).lerp(fast, (t - 0.5) * 2);
      } else if (mode === 'grade') {
        const g = Math.max(-1, Math.min(1, gradeAt(i) / 0.08));
        if (g < 0) c.copy(flat).lerp(down, -g); else c.copy(flat).lerp(up, g);
      } else c.set(SECTOR_GLOW[sectorOfD(d)]);
      for (const o of [0, 1]) col.setXYZ(k * 2 + o, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  // sector gates
  [0, ...track.sectors].forEach((d, s) => {
    const p = pointAt(d), t = tangentAt(d);
    const l = new THREE.Vector3(t.z, 0, -t.x);
    const mat = new THREE.MeshStandardMaterial({ color: SECTOR_GLOW[s], emissive: SECTOR_GLOW[s], emissiveIntensity: 0.6, roughness: 0.4 });
    for (const sg of [1, -1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 9, 0.7), mat);
      post.position.copy(p).addScaledVector(l, sg * (TRACK_W / 2 + 1.6)).setY(p.y + 4.5);
      post.castShadow = true;
      trackGroup.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W + 3.9, 0.7, 0.7), mat);
    beam.position.copy(p).setY(p.y + 9);
    beam.lookAt(beam.position.clone().add(t));
    beam.castShadow = true;
    trackGroup.add(beam);
    const el = document.createElement('div');
    el.className = 'gate-label';
    el.textContent = s === 0 ? 'START / FINISH · S1' : `S${s + 1}`;
    el.style.setProperty('--c', SECTOR_GLOW[s]);
    const o = new CSS2DObject(el);
    o.position.copy(p).setY(p.y + 22);
    scene.add(o);
  });

  // 2026 Straight Mode zones: cyan dashes along the left edge
  const zoneGroup = new THREE.Group();
  zoneGroup.visible = false;
  trackGroup.add(zoneGroup);
  for (const z of zones) {
    let d0 = z.from, d1 = z.to;
    if (d1 < d0) d1 += L;
    const i0 = Math.round(d0 / step), i1 = Math.round(d1 / step);
    for (let i = i0; i < i1; i += 6) zoneGroup.add(screenRibbon(i, Math.min(i + 3, i1), TRACK_W / 2 + 2.6, 1.0, (ii, k, c) => c.set('#38e1ff'), { maxScale: 6 }));
  }


  // ------------------------------------------------------------ labels
  const cornerLabels = new Map();
  const cornerClickHandlers = [];
  for (const cn of track.corners) {
    const el = document.createElement('button');
    el.className = 'corner-pin';
    el.dataset.sector = cn.sector;
    el.innerHTML = `<span>${cn.number}</span>`;
    el.title = `Turn ${cn.number}`;
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => { e.stopPropagation(); cornerClickHandlers.forEach((f) => f(cn.number)); });
    const o = new CSS2DObject(el);
    const side = cn.dir === 'left' ? -1 : 1;
    const ci = Math.round(cn.d / step) % N;
    o.position.copy(P[ci]).addScaledVector(Lf[ci], side * 15).setY(P[ci].y + 10);
    scene.add(o);
    cornerLabels.set(cn.number, o);
  }
  const landmarkLabels = [];
  for (const lm of city.landmarks) {
    const el = document.createElement('div');
    el.className = `landmark-label ${lm.kind || ''}`;
    el.textContent = lm.label;
    const o = new CSS2DObject(el);
    o.position.set(lm.x, lm.z, -lm.y);
    scene.add(o);
    landmarkLabels.push(o);
  }

  // ------------------------------------------------------------ cars
  function carRig(colour, code, ghost) {
    const body = makeCar(colour, { ghost });
    const rig = new THREE.Group();
    rig.add(body);
    const el = document.createElement('div');
    el.className = `car-tag${ghost ? ' ghost' : ''}`;
    el.style.setProperty('--c', colour);
    el.textContent = code;
    const tag = new CSS2DObject(el);
    tag.position.set(0, ghost ? 2.6 : 3.4, 0);
    rig.add(tag);
    rig.visible = false;
    scene.add(rig);
    return { rig, body, tag, el };
  }
  let carA = null, carB = null;
  function ensureCars(lapA, lapB) {
    for (const c of [carA, carB]) if (c) { scene.remove(c.rig); c.el.remove(); }
    carA = carRig(lapA.driver.colour, lapA.driver.code, false);
    carB = lapB ? carRig(lapB.driver.colour, `${lapB.driver.code} '${lapB.driver.session.slice(2, 4)}`, true) : null;
  }
  // cursor (hover on the chart)
  const cursor = new THREE.Mesh(new THREE.SphereGeometry(4, 20, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }));
  cursor.renderOrder = 5;
  cursor.visible = false;
  scene.add(cursor);
  const look = new THREE.Vector3();
  function placeRig(rig, d, lateral = 0) {
    const p = pointAt(d);
    const t = tangentAt(d);
    p.addScaledVector(new THREE.Vector3(t.z, 0, -t.x), lateral);
    rig.position.copy(p).setY(p.y + 0.02);
    pointAt(d + 4, look).addScaledVector(new THREE.Vector3(t.z, 0, -t.x), lateral);
    look.y += 0.02;
    rig.lookAt(look);
  }

  // ------------------------------------------------------------ camera animation
  let tween = null;
  function flyTo(pos, target, dur = 1600) {
    tween = { from: camera.position.clone(), fromT: controls.target.clone(), to: pos.clone(), toT: target.clone(), t0: performance.now(), dur };
  }
  function overview(dur) {
    const wide = camera.aspect >= 1.2;
    const target = circuitCentre.clone().add(wide ? new THREE.Vector3(-120, 0, 60) : new THREE.Vector3(-60, 0, 60));
    const k = wide ? 1.42 : Math.min(2.6, 1.6 / camera.aspect);
    const eye = new THREE.Vector3(-1150, 900, 820).multiplyScalar(k).add(target);
    flyTo(eye, target, dur);
  }
  function focusCorner(n, view = 'orbit') {
    const cn = track.corners.find((c) => c.number === n);
    if (!cn) return;
    const apex = pointAt(cn.d);
    if (view === 'driver') {
      const eye = pointAt(cn.d - 85);
      eye.y += 1.2;
      const lk = pointAt(cn.d + 6);
      lk.y += 1.0;
      flyTo(eye, lk, 1900);
    } else {
      const back = pointAt(cn.d - 170);
      const t = tangentAt(cn.d - 40);
      const side = new THREE.Vector3(t.z, 0, -t.x).multiplyScalar(cn.dir === 'left' ? -1 : 1);
      const eye = back.clone().addScaledVector(side, 80);
      eye.y = Math.max(eye.y, apex.y) + 85;
      flyTo(eye, apex.clone().setY(apex.y + 2), 1600);
    }
    cornerLabels.forEach((o, k) => o.element.classList.toggle('active', k === n));
  }

  // ------------------------------------------------------------ lap playback
  function rowAt(rows, t) {
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m][0] < t) lo = m; else hi = m; }
    const a = rows[lo], b = rows[hi];
    const f = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
    return { t, d: a[1] + (b[1] - a[1]) * f, speed: a[2] + (b[2] - a[2]) * f, gear: f < 0.5 ? a[3] : b[3], throttle: a[4] + (b[4] - a[4]) * f, brake: f < 0.5 ? a[5] : b[5] };
  }
  function timeAtD(rows, d) {
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m][1] < d) lo = m; else hi = m; }
    const a = rows[lo], b = rows[hi];
    const f = b[1] === a[1] ? 0 : Math.min(1, Math.max(0, (d - a[1]) / (b[1] - a[1])));
    return a[0] + (b[0] - a[0]) * f;
  }
  // TV cameras: one trackside position per corner, outside the turn, a little above the barrier
  const tvCams = track.corners.map((cn) => {
    const i = Math.round(cn.d / step) % N;
    const side = cn.dir === 'left' ? -1 : 1;
    const p = P[i].clone().addScaledVector(Lf[i], side * 48);
    p.y = Math.max(heightAt(p.x, -p.z), P[i].y) + 9;
    return { p, d: cn.d };
  });
  let tvIdx = -1;
  const tickHandlers = [];
  let play = null;
  function playLap(key, { cam = 'chase', rate = 1, ghost = null } = {}) {
    const lap = track.laps[key];
    const glap = ghost && ghost !== key ? track.laps[ghost] : null;
    ensureCars(lap, glap);
    play = { lap, glap, rows: lap.rows, t: -0.6, rate, cam, last: performance.now() };
    tween = null;
    carA.rig.visible = true;
    if (carB) carB.rig.visible = true;
    controls.enabled = cam === 'free';
    tvIdx = -1;
  }
  function stopLap() {
    play = null;
    container.classList.remove('immersive');
    controls.enabled = true;
    shadowFocus = null;
    placeShadowCamera();
    camera.fov = BASE_FOV;
    camera.updateProjectionMatrix();
    for (const c of [carA, carB]) if (c) c.rig.visible = false;
  }
  const chaseEye = new THREE.Vector3(), chaseLook = new THREE.Vector3(), tmp = new THREE.Vector3();
  let snapNext = false;

  // ------------------------------------------------------------ resize & loop
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const clock = new THREE.Clock();
  let running = true;
  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, clock.getDelta());

    if (tween) {
      const k = Math.min(1, (performance.now() - tween.t0) / tween.dur);
      const e = ease(k);
      camera.position.lerpVectors(tween.from, tween.to, e);
      camera.position.y += Math.sin(Math.PI * e) * Math.min(380, tween.from.distanceTo(tween.to) * 0.22);
      controls.target.lerpVectors(tween.fromT, tween.toT, e);
      if (k >= 1) tween = null;
    }

    if (play) {
      play.t += dt * play.rate;
      const end = Math.max(play.lap.lapTime, play.glap?.lapTime || 0) + 1.2;
      if (play.t > end) play.t = -0.6;
      const tc = Math.max(0, Math.min(play.lap.lapTime, play.t));
      const s = rowAt(play.rows, tc);
      placeRig(carA.rig, s.d, 0);
      let gap = null;
      if (play.glap) {
        const g = rowAt(play.glap.rows, Math.max(0, Math.min(play.glap.lapTime, play.t)));
        placeRig(carB.rig, g.d, -1.9);
        gap = tc - timeAtD(play.glap.rows, s.d); // + means the main car is slower than the ghost here
        if (play.t >= play.lap.lapTime) gap = play.lap.lapTime - play.glap.lapTime;
      }
      const immersive = play.cam === 'chase' || play.cam === 'onboard';
      container.classList.toggle('immersive', immersive);
      carA.tag.visible = !immersive;
      if (play.cam !== 'free') {
        const t = tangentAt(s.d);
        let k = 1 - Math.exp(-dt * 5);
        camera.fov = BASE_FOV;
        if (play.cam === 'onboard') {
          pointAt(s.d - 0.1, chaseEye).y += 1.42;
          pointAt(s.d + 45, chaseLook).y += 0.4;
          k = 1 - Math.exp(-dt * 16);
        } else if (play.cam === 'heli') {
          pointAt(s.d - 70, chaseEye).y += 150;
          chaseEye.addScaledVector(tmp.set(t.z, 0, -t.x), 90);
          pointAt(s.d + 25, chaseLook);
        } else if (play.cam === 'tv') {
          // pick the closest trackside camera, with hysteresis
          let best = tvIdx, bd = tvIdx >= 0 ? tvCams[tvIdx].p.distanceTo(carA.rig.position) * 0.7 : Infinity;
          tvCams.forEach((c, i) => { const dd = c.p.distanceTo(carA.rig.position); if (dd < bd) (bd = dd), (best = i); });
          const cut = best !== tvIdx;
          tvIdx = best;
          chaseEye.copy(tvCams[tvIdx].p);
          chaseLook.copy(carA.rig.position).y += 1;
          const dist = chaseEye.distanceTo(chaseLook);
          camera.fov = THREE.MathUtils.clamp((2 * Math.atan(16 / dist) * 180) / Math.PI, 3.5, 45);
          k = cut ? 1 : 1 - Math.exp(-dt * 12);
        } else {
          pointAt(s.d - 9.5, chaseEye).y += 2.9;
          pointAt(s.d + 10, chaseLook).y += 0.6;
        }
        if (snapNext) { k = 1; snapNext = false; }
        camera.updateProjectionMatrix();
        camera.position.lerp(chaseEye, k);
        controls.target.lerp(chaseLook, k);
        shadowFocus = carA.rig.position;
        placeShadowCamera();
      }
      const i = Math.round(wrapD(s.d) / step) % N;
      tickHandlers.forEach((f) => f({ ...s, sector: sectorOfD(wrapD(s.d)) + 1, lapTime: play.lap.lapTime, gap, alt: P[i].y + track.datum_m, grade: gradeAt(i) }));
    }

    controls.update();
    const camDist = camera.position.distanceTo(controls.target);
    lineMesh.material.uniforms.uOpacity.value = 0.95 * smooth(70, 320, camDist);
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  setTimeOfDay(15);
  overview(10);
  frame();

  return {
    focusCorner,
    overview: () => { stopLap(); overview(1800); cornerLabels.forEach((o) => o.element.classList.remove('active')); },
    playLap,
    stopLap,
    setCam: (cam) => { if (play) { play.cam = cam; controls.enabled = cam === 'free'; tvIdx = -1; if (cam === 'free') { camera.fov = BASE_FOV; camera.updateProjectionMatrix(); shadowFocus = null; placeShadowCamera(); } } },
    setRate: (r) => { if (play) play.rate = r; },
    seek: (t) => { if (play) play.t = t; },
    // debugging aid: snap the follow camera instead of easing (used by automated screenshots)
    snap: () => { snapNext = true; },
    isPlaying: () => !!play,
    onTick: (f) => tickHandlers.push(f),
    onCornerClick: (f) => cornerClickHandlers.push(f),
    setMode: recolor,
    setTimeOfDay,
    getTimeOfDay: () => sunHours,
    setCursor(d) {
      if (d == null) { cursor.visible = false; return; }
      if (play) return;
      cursor.visible = true;
      pointAt(d, cursor.position).y += 3;
    },
    setLayer(name, on) {
      if (name === 'buildings') { buildings.visible = on; if (tower) tower.visible = on; }
      if (name === 'labels') landmarkLabels.forEach((o) => (o.visible = on));
      if (name === 'line') lineMesh.visible = on;
      if (name === 'zones') zoneGroup.visible = on;
    },
    pause: () => { running = false; },
    resume: () => { if (!running) { running = true; clock.getDelta(); frame(); } },
  };
}
