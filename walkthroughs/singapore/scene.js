// 3D night-scene of the Marina Bay Street Circuit.
// World units are metres. Local frame from build-data: x = east, y = north.
// three.js frame: X = east, Y = up, Z = -north.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export const SECTOR_GLOW = ['#ff4d6d', '#3ec5ff', '#ffd23f'];
const TRACK_W = 13;
const ELEV_SCALE = 0.6;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function createScene(container, { track, city, zones = [] }) {
  // ------------------------------------------------------------ renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'labels-layer';
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0d1c, 0.00028);

  const camera = new THREE.PerspectiveCamera(42, 1, 1, 30000);
  camera.position.set(-900, 1500, 1700);

  const controls = new OrbitControls(camera, labelRenderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 4;
  controls.maxDistance = 6000;
  controls.screenSpacePanning = false;

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.62);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ------------------------------------------------------------ track helpers
  const N = track.line.length;
  const step = track.step_m;
  const L = track.length_m;
  const P = track.line.map(([x, y, z]) => new THREE.Vector3(x, 0.45 + z * ELEV_SCALE, -y));
  // smoothed tangents & left normals
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

  // speed lookup (2026 pole lap) by distance, for heat colouring
  const lapRows = track.laps.q2026.rows;
  function speedAtD(d) {
    let lo = 0, hi = lapRows.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (lapRows[m][1] < d) lo = m; else hi = m; }
    const a = lapRows[lo], b = lapRows[hi];
    const f = b[1] === a[1] ? 0 : Math.min(1, Math.max(0, (d - a[1]) / (b[1] - a[1])));
    return a[2] + (b[2] - a[2]) * f;
  }

  // Ribbon builder: offsets are lateral distances from centreline (left = +)
  function ribbon(i0, i1, offA, offB, yA, yB, colorFn, closed = false) {
    const pos = [], col = [], idx = [];
    const count = closed ? N + 1 : i1 - i0 + 1;
    const c = new THREE.Color();
    for (let k = 0; k < count; k++) {
      const i = ((closed ? k : i0 + k) % N + N) % N;
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

  // ------------------------------------------------------------ sky
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(14000, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {},
      vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `varying vec3 vP;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
        void main(){
          float y = clamp(vP.y, -0.1, 1.0);
          vec3 top = vec3(0.012,0.016,0.045);
          vec3 mid = vec3(0.05,0.045,0.13);
          vec3 hor = vec3(0.30,0.13,0.20);
          vec3 c = mix(hor, mid, smoothstep(0.0, 0.10, y));
          c = mix(c, top, smoothstep(0.10, 0.6, y));
          vec2 uv = vec2(atan(vP.z, vP.x)*220., vP.y*260.);
          float s = step(0.9965, h(floor(uv))) * smoothstep(0.12, 0.5, y);
          c += s * 0.55;
          gl_FragColor = vec4(c,1.);
        }`,
    })
  );
  sky.renderOrder = -100;
  scene.add(sky);

  scene.add(new THREE.HemisphereLight(0x6f7cff, 0x0b0b12, 0.55));
  const moon = new THREE.DirectionalLight(0xb9c6ff, 0.5);
  moon.position.set(-1, 2, 1);
  scene.add(moon);

  // ------------------------------------------------------------ ground layers (no depth write, ordered)
  const flat = (color, order, extra = {}) =>
    new THREE.MeshBasicMaterial({ color, depthWrite: false, ...extra });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(9000, 64).rotateX(-Math.PI / 2), flat(0x080a12));
  ground.renderOrder = -10;
  scene.add(ground);

  const unpack = (arr, from = 0) => { const v = []; for (let i = from; i < arr.length; i += 2) v.push(new THREE.Vector2(arr[i], arr[i + 1])); return v; };
  function polysToGeometry(polys, y) {
    const shapes = polys.map((p) => {
      const s = new THREE.Shape(unpack(p.outer));
      s.holes = p.holes.map((h) => new THREE.Path(unpack(h)));
      return s;
    });
    const g = new THREE.ShapeGeometry(shapes);
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    return g;
  }
  const green = new THREE.Mesh(polysToGeometry(city.green, 0.02), flat(0x0c1f19));
  green.renderOrder = -9;
  scene.add(green);

  const waterMat = new THREE.ShaderMaterial({
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: `#include <fog_pars_vertex>
      varying vec3 vW;
      void main(){ vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; vec4 mvPosition = viewMatrix*w; gl_Position = projectionMatrix*mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `#include <fog_pars_fragment>
      uniform float uTime; varying vec3 vW;
      float h(vec2 p){ return fract(sin(dot(p, vec2(41.3,289.1)))*43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      void main(){
        vec2 p = vW.xz*0.035;
        float w = n(p + vec2(uTime*0.05, uTime*0.03)) * 0.6 + n(p*2.7 - vec2(uTime*0.04, 0.)) * 0.4;
        vec3 deep = vec3(0.004,0.010,0.028);
        vec3 c = deep + vec3(0.010,0.020,0.045)*w;
        float glint = pow(n(vW.xz*0.22 + vec2(uTime*0.3, -uTime*0.2)), 22.) * 2.0;
        c += glint * vec3(1.0,0.72,0.45) * 0.55;
        gl_FragColor = vec4(c,1.);
        #include <fog_fragment>
      }`,
  });
  const water = new THREE.Mesh(polysToGeometry(city.water, 0.05), waterMat);
  water.renderOrder = -8;
  scene.add(water);

  // roads
  {
    const pos = [], idx = [];
    for (const r of city.roads) {
      const w = r[0] / 2;
      const pts = unpack(r, 1);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * w, ny = (dx / len) * w;
        const base = pos.length / 3;
        pos.push(a.x + nx, 0.1, -(a.y + ny), a.x - nx, 0.1, -(a.y - ny), b.x + nx, 0.1, -(b.y + ny), b.x - nx, 0.1, -(b.y - ny));
        idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const roads = new THREE.Mesh(g, flat(0x141927, -7, { side: THREE.DoubleSide }));
    roads.renderOrder = -7;
    scene.add(roads);
  }

  // ------------------------------------------------------------ buildings
  // OSM models the Singapore Flyer as stacked slabs; drop them (we draw a proper wheel) but keep their alignment.
  const flyerRef = city.landmarks.find((l) => l.label === 'Singapore Flyer');
  let flyerAxis = null;
  {
    const centroidOf = (b) => { let x = 0, y = 0; const n = (b.length - 2) / 2; for (let i = 2; i < b.length; i += 2) (x += b[i]), (y += b[i + 1]); return [x / n, y / n]; };
    const slices = [];
    city.buildings = city.buildings.filter((b) => {
      if (!flyerRef || b[0] < 100 || b[1] < 10) return true;
      const [x, y] = centroidOf(b);
      if (Math.hypot(x - flyerRef.x, y - flyerRef.y) > 90) return true;
      slices.push([x, y]);
      return false;
    });
    if (slices.length > 4) {
      const a = slices[0], z = slices.at(-1);
      flyerAxis = new THREE.Vector2(z[0] - a[0], z[1] - a[1]).normalize();
    }
  }
  const buildingMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uDim: { value: 1 } }]),
    vertexShader: `#include <fog_pars_vertex>
      attribute vec3 aInfo; // u along wall (or -1 for roof), building seed, building height
      varying vec3 vInfo; varying float vY; varying vec3 vN; varying float vDist;
      void main(){ vInfo = aInfo; vY = position.y; vN = normal;
        vec4 mvPosition = modelViewMatrix*vec4(position,1.); vDist = -mvPosition.z; gl_Position = projectionMatrix*mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `#include <fog_pars_fragment>
      uniform float uDim; varying vec3 vInfo; varying float vY; varying vec3 vN; varying float vDist;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
      void main(){
        float seed = vInfo.y; float H = vInfo.z;
        vec3 base = mix(vec3(0.010,0.012,0.022), vec3(0.020,0.022,0.036), h(vec2(seed,1.7)));
        float shade = 0.65 + 0.35*abs(vN.x);
        vec3 c = base*shade;
        if (vInfo.x < 0.0) {
          c = base*0.8 + vec3(0.004,0.005,0.009);
        } else {
          vec2 cell = vec2(floor(vInfo.x/3.4), floor(vY/3.7));
          vec2 f = vec2(fract(vInfo.x/3.4), fract(vY/3.7));
          float frame = step(0.18,f.x)*step(f.x,0.82)*step(0.25,f.y)*step(f.y,0.8);
          float r = h(cell + seed*13.1);
          float lit = step(0.55, r) * frame;
          vec3 warm = vec3(1.0,0.74,0.42), cool = vec3(0.55,0.75,1.0);
          vec3 win = mix(warm, cool, step(0.82, h(cell.yx + seed)));
          vec3 detail = lit * win * (0.35 + 0.65*h(cell*1.3+seed)) * 0.9;
          vec3 avg = mix(vec3(1.0,0.74,0.42), vec3(0.55,0.75,1.0), 0.2) * 0.045 * (0.5 + 1.0*h(vec2(seed, 3.1)));
          float near = smoothstep(1400.0, 350.0, vDist);
          c += mix(avg, detail, near) * uDim;
          // top-edge accent light on towers
          c += smoothstep(H-2.0, H, vY) * step(80., H) * vec3(0.35,0.5,0.9) * 0.6;
        }
        gl_FragColor = vec4(c,1.);
        #include <fog_fragment>
      }`,
  });
  {
    const pos = [], nor = [], info = [];
    let seed = 0;
    for (const b of city.buildings) {
      const H = b[0], H0 = b[1];
      let ring = unpack(b, 2);
      if (THREE.ShapeUtils.isClockWise(ring)) ring = ring.reverse();
      seed = (seed + 0.618) % 1;
      const sd = seed * 97.0;
      let u = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const len = Math.hypot(c.x - a.x, c.y - a.y);
        const nx = (c.y - a.y) / (len || 1), nz = (c.x - a.x) / (len || 1);
        const quad = [[a, H0, u], [c, H0, u + len], [c, H, u + len], [a, H0, u], [c, H, u + len], [a, H, u]];
        for (const [p, y, uu] of quad) { pos.push(p.x, y, -p.y); nor.push(nx, 0, nz); info.push(uu, sd, H); }
        u += len;
      }
      const tris = THREE.ShapeUtils.triangulateShape(ring, []);
      for (const t of tris) for (const k of t) { pos.push(ring[k].x, H, -ring[k].y); nor.push(0, 1, 0); info.push(-1, sd, H); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 3));
    var buildings = new THREE.Mesh(g, buildingMat);
    scene.add(buildings);
  }

  // aviation lights on tall towers
  {
    const pts = [];
    for (const b of city.buildings) if (b[0] > 120) { let x = 0, y = 0; const n = (b.length - 2) / 2; for (let i = 2; i < b.length; i += 2) (x += b[i]), (y += b[i + 1]); pts.push(x / n, b[0] + 2, -y / n); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    var aviation = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xff2a2a, size: 7, sizeAttenuation: true, transparent: true, toneMapped: false, depthWrite: false }));
    scene.add(aviation);
  }

  // ------------------------------------------------------------ landmarks: Singapore Flyer
  const landmarkByLabel = Object.fromEntries(city.landmarks.map((l) => [l.label, l]));
  const flyerLm = landmarkByLabel['Singapore Flyer'];
  if (flyerLm) {
    const g = new THREE.Group();
    const R = 75, hub = 90;
    const glow = new THREE.MeshBasicMaterial({ color: 0xbfe6ff, toneMapped: false });
    const steel = new THREE.MeshBasicMaterial({ color: 0x5b6b8a });
    g.add(new THREE.Mesh(new THREE.TorusGeometry(R, 1.1, 8, 160), glow));
    g.add(new THREE.Mesh(new THREE.TorusGeometry(R - 4, 0.5, 6, 160), steel));
    const spokes = [];
    for (let i = 0; i < 56; i++) { const a = (i / 56) * Math.PI * 2; spokes.push(0, 0, 0, Math.cos(a) * R, Math.sin(a) * R, 0); }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(spokes, 3));
    g.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0x7fa9ff, transparent: true, opacity: 0.35 })));
    const capGeo = new THREE.CapsuleGeometry(2.2, 4, 4, 8).rotateZ(Math.PI / 2);
    const capMat = new THREE.MeshBasicMaterial({ color: 0xff7ad9, toneMapped: false });
    const caps = new THREE.InstancedMesh(capGeo, capMat, 28);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2; m.makeTranslation(Math.cos(a) * (R + 3), Math.sin(a) * (R + 3), 0); caps.setMatrixAt(i, m); }
    g.add(caps);
    g.position.set(0, hub, 0);
    const holder = new THREE.Group();
    holder.add(g);
    const legMat = new THREE.MeshBasicMaterial({ color: 0x3a4660 });
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 2.2, hub + 4, 8), legMat);
      leg.position.set(s * 22, (hub + 4) / 2 - 2, 0);
      leg.rotation.z = s * 0.24;
      holder.add(leg);
    }
    holder.position.set(flyerLm.x, 0, -flyerLm.y);
    // wheel plane contains flyerAxis; its normal is perpendicular in the ground plane
    const ax = flyerAxis || new THREE.Vector2(0.79, 0.62);
    holder.lookAt(flyerLm.x - ax.y * 100, 0, -(flyerLm.y + ax.x * 100));
    scene.add(holder);
    var flyerWheel = g;
  }

  // ------------------------------------------------------------ track meshes
  const trackGroup = new THREE.Group();
  scene.add(trackGroup);
  const asphalt = new THREE.Mesh(
    ribbon(0, 0, TRACK_W / 2, -TRACK_W / 2, 0, 0, (i, k, c) => c.set(0x1a1d26), true),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1, emissive: 0x0d0f16 })
  );
  trackGroup.add(asphalt);
  // skirts down to the ground so an elevated ribbon reads as solid
  for (const s of [1, -1]) {
    const g = ribbon(0, 0, (s * TRACK_W) / 2, (s * TRACK_W) / 2, 0, 0, (i, k, c) => c.set(0x10131c), true);
    const p = g.attributes.position;
    for (let v = 1; v < p.count; v += 2) p.setY(v, 0);
    trackGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }
  // floodlit barrier glow (edge lines) and light curtains
  const edgeMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide });
  for (const s of [1, -1]) {
    trackGroup.add(new THREE.Mesh(ribbon(0, 0, s * (TRACK_W / 2 + 0.2), s * (TRACK_W / 2 + 0.9), 0.06, 0.06, (i, k, c) => c.setRGB(0.5, 0.45, 0.38), true), edgeMat));
    const curtain = ribbon(0, 0, s * (TRACK_W / 2 + 1), s * (TRACK_W / 2 + 1), 0, 2.2, (i, k, c) => c.set(0xffd9a8), true);
    trackGroup.add(new THREE.Mesh(curtain, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec3 color; varying float vH; varying vec3 vC; void main(){ vH = position.y; vC = color; vec4 b = modelMatrix*vec4(position,1.); gl_Position = projectionMatrix*viewMatrix*b; }`,
      fragmentShader: `varying float vH; varying vec3 vC; void main(){ gl_FragColor = vec4(vC * 0.05, 1.); }`,
    })));
  }
  // racing-line glow, coloured by mode
  const lineGeo = ribbon(0, 0, 1.8, -1.8, 0.12, 0.12, (i, k, c) => c.set(SECTOR_GLOW[sectorOfD(i * step)]).multiplyScalar(1.7), true);
  const glowLine = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  trackGroup.add(glowLine);

  function recolor(mode) {
    const col = lineGeo.attributes.color;
    const c = new THREE.Color();
    const slow = new THREE.Color('#6a1f8f'), fast = new THREE.Color('#7ef3ff');
    for (let k = 0; k <= N; k++) {
      const i = k % N, d = i * step;
      if (mode === 'speed') {
        const t = Math.min(1, Math.max(0, (speedAtD(d) - 60) / (310 - 60)));
        c.copy(slow).lerp(fast, Math.pow(t, 0.9)).multiplyScalar(0.9 + 0.8 * t);
      } else c.set(SECTOR_GLOW[sectorOfD(d)]).multiplyScalar(1.7);
      col.setXYZ(k * 2, c.r, c.g, c.b);
      col.setXYZ(k * 2 + 1, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  // kerbs on the inside of each corner
  for (const cn of track.corners) {
    const side = cn.dir === 'left' ? 1 : -1;
    const ci = Math.round(cn.d / step);
    const span = Math.min(12, Math.max(6, Math.abs(cn.headingChange) / 8));
    const i0 = ci - Math.round(span), i1 = ci + Math.round(span);
    for (const sgn of [side, -side * 0.0001]) {
      if (sgn !== side) continue;
      const g = ribbon(i0, i1, sgn * (TRACK_W / 2 - 1.6), sgn * (TRACK_W / 2), 0.08, 0.08, (i, k, c) => c.set(k % 2 ? 0xf2f2f2 : 0xe10600));
      trackGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, color: 0x9a9a9a })));
    }
  }

  // start/finish chequer
  {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 8;
    const x = cv.getContext('2d');
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { x.fillStyle = (i + j) % 2 ? '#fff' : '#111'; x.fillRect(i * 4, j * 4, 4, 4); }
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W, 1.6), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    m.rotation.x = -Math.PI / 2;
    const p0 = P[0];
    m.position.copy(p0).setY(p0.y + 0.15);
    m.rotation.z = Math.atan2(Lf[0].x, Lf[0].z) + Math.PI / 2;
    trackGroup.add(m);
  }

  // sector gates
  const gateMarkers = [];
  [0, ...track.sectors].forEach((d, s) => {
    const p = pointAt(d), t = tangentAt(d);
    const l = new THREE.Vector3(t.z, 0, -t.x);
    const col = new THREE.Color(SECTOR_GLOW[s]);
    const mat = new THREE.MeshBasicMaterial({ color: col, toneMapped: false });
    const g = new THREE.Group();
    for (const sg of [1, -1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.8, 11, 0.8), mat);
      post.position.copy(p).addScaledVector(l, sg * (TRACK_W / 2 + 1.5)).setY(p.y + 5.5);
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W + 3.8, 0.8, 0.8), mat);
    beam.position.copy(p).setY(p.y + 11);
    beam.lookAt(beam.position.clone().add(t));
    g.add(beam);
    trackGroup.add(g);
    const el = document.createElement('div');
    el.className = 'gate-label';
    el.textContent = s === 0 ? 'START / FINISH · S1' : `S${s + 1}`;
    el.style.setProperty('--c', SECTOR_GLOW[s]);
    const o = new CSS2DObject(el);
    o.position.copy(p).setY(p.y + 30);
    scene.add(o);
    gateMarkers.push(o);
  });

  // 2026 Straight Mode zones: dashed cyan strips along the left edge
  const zoneGroup = new THREE.Group();
  zoneGroup.visible = false;
  trackGroup.add(zoneGroup);
  for (const z of zones) {
    let d0 = z.from, d1 = z.to;
    if (d1 < d0) d1 += L;
    const i0 = Math.round(d0 / step), i1 = Math.round(d1 / step);
    for (let i = i0; i < i1; i += 6) {
      const g = ribbon(i, Math.min(i + 3, i1), TRACK_W / 2 + 2.2, TRACK_W / 2 + 4.2, 0.1, 0.1, (ii, k, c) => c.set('#7ef3ff'));
      zoneGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide })));
    }
  }

  // pit lane
  if (track.pit?.length > 1) {
    const pts = track.pit.map(([x, y]) => new THREE.Vector3(x, 0.4, -y));
    const curve = new THREE.CatmullRomCurve3(pts);
    trackGroup.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 200, 0.35, 4), new THREE.MeshBasicMaterial({ color: 0x8a6cff, toneMapped: false })));
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
    const side = cn.dir === 'left' ? -1 : 1; // pin on the outside
    const ci = Math.round(cn.d / step) % N;
    o.position.copy(P[ci]).addScaledVector(Lf[ci], side * 22).setY(P[ci].y + 12);
    scene.add(o);
    cornerLabels.set(cn.number, o);
  }
  const landmarkLabels = [];
  for (const lm of city.landmarks) {
    const el = document.createElement('div');
    el.className = 'landmark-label';
    el.textContent = lm.label;
    const o = new CSS2DObject(el);
    o.position.set(lm.x, lm.label === 'Singapore Flyer' ? 175 : lm.label === 'Marina Bay Sands' ? 215 : 40, -lm.y);
    scene.add(o);
    landmarkLabels.push(o);
  }

  // ------------------------------------------------------------ car / cursor
  const car = new THREE.Group();
  const carCore = new THREE.Mesh(new THREE.SphereGeometry(1.3, 20, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const carHalo = new THREE.Mesh(new THREE.SphereGeometry(3, 20, 12), new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.35, toneMapped: false, depthWrite: false }));
  car.add(carCore, carHalo);
  car.visible = false;
  scene.add(car);
  // comet trail
  const TRAIL = 70;
  const trailPos = new Float32Array(TRAIL * 3);
  const trailCol = new Float32Array(TRAIL * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
  const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true }));
  trail.frustumCulled = false;
  trail.visible = false;
  scene.add(trail);

  function placeCar(d, trailFrom = d - 120) {
    const p = pointAt(d);
    car.position.copy(p).setY(p.y + 1.6);
    const tmp = new THREE.Vector3();
    for (let k = 0; k < TRAIL; k++) {
      const dd = d - ((d - trailFrom) * k) / (TRAIL - 1);
      pointAt(dd, tmp);
      trailPos.set([tmp.x, tmp.y + 1.6, tmp.z], k * 3);
      const f = 1 - k / TRAIL;
      trailCol.set([1.0 * f, 0.25 * f, 0.4 * f], k * 3);
    }
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.attributes.color.needsUpdate = true;
  }

  // ------------------------------------------------------------ camera animation
  let tween = null;
  function flyTo(pos, target, dur = 1600) {
    tween = { from: camera.position.clone(), fromT: controls.target.clone(), to: pos.clone(), toT: target.clone(), t0: performance.now(), dur };
  }
  function overview(dur) {
    const target = new THREE.Vector3(-560, 0, -120);
    const k = camera.aspect < 1.2 ? Math.min(2.2, 1.2 / camera.aspect) : 1;
    const eye = new THREE.Vector3(-700, 1450, 1500).sub(target).multiplyScalar(k).add(target);
    flyTo(eye, target, dur);
  }
  function focusCorner(n, view = 'orbit') {
    const cn = track.corners.find((c) => c.number === n);
    if (!cn) return;
    const apex = pointAt(cn.d);
    if (view === 'driver') {
      const eye = pointAt(cn.d - 75).setY(apex.y + 1.1);
      const look = pointAt(cn.d + 8).setY(apex.y + 1.0);
      flyTo(eye, look, 1900);
    } else {
      const back = pointAt(cn.d - 160);
      const t = tangentAt(cn.d - 40);
      const side = new THREE.Vector3(t.z, 0, -t.x).multiplyScalar(cn.dir === 'left' ? -1 : 1);
      const eye = back.clone().addScaledVector(side, 70).setY(apex.y + 95);
      flyTo(eye, apex.clone().setY(apex.y + 2), 1600);
    }
    cornerLabels.forEach((o, k) => o.element.classList.toggle('active', k === n));
  }

  // ------------------------------------------------------------ lap playback
  let play = null; // { rows, t0, speed, cam }
  function rowAt(rows, t) {
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m][0] < t) lo = m; else hi = m; }
    const a = rows[lo], b = rows[hi];
    const f = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
    return { t, d: a[1] + (b[1] - a[1]) * f, speed: a[2] + (b[2] - a[2]) * f, gear: f < 0.5 ? a[3] : b[3], throttle: a[4] + (b[4] - a[4]) * f, brake: f < 0.5 ? a[5] : b[5] };
  }
  const tickHandlers = [];
  function playLap(key, { cam = 'chase', rate = 1 } = {}) {
    const lap = track.laps[key];
    play = { lap, rows: lap.rows, t: 0, last: performance.now(), rate, cam };
    tween = null;
    car.visible = trail.visible = true;
    controls.enabled = cam === 'free';
  }
  function stopLap() {
    play = null;
    controls.enabled = true;
    car.visible = trail.visible = false;
  }
  const chaseEye = new THREE.Vector3(), chaseLook = new THREE.Vector3();

  // ------------------------------------------------------------ resize & loop
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.setSize(w, h);
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
    const dt = clock.getDelta();
    const time = clock.elapsedTime;
    waterMat.uniforms.uTime.value = time;
    if (flyerWheel) flyerWheel.rotation.z += dt * 0.02;
    aviation.material.opacity = 0.35 + 0.65 * (Math.sin(time * 3) > 0.6 ? 1 : 0.15);
    carHalo.scale.setScalar(1 + 0.15 * Math.sin(time * 9));

    if (tween) {
      const k = Math.min(1, (performance.now() - tween.t0) / tween.dur);
      const e = ease(k);
      camera.position.lerpVectors(tween.from, tween.to, e);
      // arc upward mid-flight for long moves
      const lift = Math.sin(Math.PI * e) * Math.min(400, tween.from.distanceTo(tween.to) * 0.25);
      camera.position.y += lift;
      controls.target.lerpVectors(tween.fromT, tween.toT, e);
      if (k >= 1) tween = null;
    }

    glowLine.visible = !(play && play.cam === 'onboard');
    if (play) {
      play.t += dt * play.rate;
      if (play.t > play.lap.lapTime) play.t = 0;
      const s = rowAt(play.rows, play.t);
      placeCar(s.d, s.d - Math.max(40, s.speed * 0.5));
      if (play.cam !== 'free') {
        const t = tangentAt(s.d);
        if (play.cam === 'onboard') {
          pointAt(s.d + 1, chaseEye).y += 1.0;
          pointAt(s.d + 40, chaseLook).y += 0.6;
          car.visible = false;
          glowLine.visible = false;
        } else if (play.cam === 'heli') {
          pointAt(s.d - 60, chaseEye).y += 140;
          chaseEye.addScaledVector(new THREE.Vector3(t.z, 0, -t.x), 80);
          pointAt(s.d + 20, chaseLook);
          car.visible = true;
        } else {
          pointAt(s.d - 30, chaseEye).y += 8;
          pointAt(s.d + 45, chaseLook).y += 1;
          car.visible = true;
        }
        const k = 1 - Math.exp(-dt * (play.cam === 'onboard' ? 14 : 5));
        camera.position.lerp(chaseEye, k);
        controls.target.lerp(chaseLook, k);
      }
      tickHandlers.forEach((f) => f({ ...s, sector: sectorOfD(s.d) + 1, lapTime: play.lap.lapTime }));
    }

    controls.update();
    const camDist = camera.position.distanceTo(controls.target);
    bloom.strength = THREE.MathUtils.clamp(camDist / 1600, 0.3, 0.85);
    glowLine.material.color.setScalar(THREE.MathUtils.clamp(camDist / 700, 0.28, 1));
    composer.render();
    labelRenderer.render(scene, camera);
  }
  overview(10);
  frame();

  return {
    focusCorner,
    overview: () => { stopLap(); overview(1800); cornerLabels.forEach((o) => o.element.classList.remove('active')); },
    playLap,
    stopLap,
    setCam: (cam) => { if (play) { play.cam = cam; controls.enabled = cam === 'free'; car.visible = cam !== 'onboard'; } },
    setRate: (r) => { if (play) play.rate = r; },
    isPlaying: () => !!play,
    seek: (t) => { if (play) play.t = t; },
    onTick: (f) => tickHandlers.push(f),
    onCornerClick: (f) => cornerClickHandlers.push(f),
    setMode: recolor,
    setCursor(d) {
      if (d == null) { if (!play) car.visible = trail.visible = false; return; }
      if (play) return;
      car.visible = trail.visible = true;
      placeCar(d, d - 60);
    },
    setLayer(name, on) {
      if (name === 'buildings') buildings.visible = on;
      if (name === 'labels') landmarkLabels.forEach((o) => (o.visible = on));
      if (name === 'bloom') bloom.enabled = on;
      if (name === 'zones') zoneGroup.visible = on;
    },
    pause: () => { running = false; },
    resume: () => { if (!running) { running = true; clock.getDelta(); frame(); } },
  };
}
