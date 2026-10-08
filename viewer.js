// MeasureIt shared-run viewer.
//
// Reads scene.json (the run's description) and data.bin.gz (every array,
// packed by share.py) and redraws the app's presentation views with three.js:
//   Fluid      — faint vessel wireframe + velocity arrows coloured by |u|
//   Solid      — wall wireframe warped by its displacement, coloured by |d|
//   Windkessel — overlay: outlet caps lit, circuits facing the camera, π(t)
//   Boundary conditions — tagged regions, hover (or the legend) to read them
// Space plays, ←/→ step, 1–4 switch views, R resets the camera.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const BC_ALPHA = 0.9, BC_HOVER = 0.72, BC_DIM = 0.08;
const BC_LINE_W = 5, SCHEM_W = 2;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── data ─────────────────────────────────────────────────────────────────────

async function fetchBytes(url, expected, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, expected);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function gunzip(bytes) {
  // a server may already have decoded a Content-Encoding: gzip response
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes.buffer;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

function arrays(buffer, index) {
  const ctor = { f32: Float32Array, u32: Uint32Array, i32: Int32Array, i16: Int16Array };
  const get = (key) => {
    const m = index[key];
    if (!m) return null;
    const n = m.shape.reduce((a, b) => a * b, 1);
    return { data: new ctor[m.dtype](buffer, m.offset, n), shape: m.shape, scale: m.scale ?? 1 };
  };
  return { get, has: (k) => k in index };
}

// per-frame slice of a (T, N, 3) quantised array, dequantised into `out`
function frameInto(arr, k, out, factor = 1) {
  if (!arr) return null;
  const n = arr.shape[1] * arr.shape[2];
  const s = arr.scale * factor;
  const src = arr.data;
  const o = k * n;
  for (let j = 0; j < n; j++) out[j] = src[o + j] * s;
  return out;
}

// ── colour ───────────────────────────────────────────────────────────────────

function lutColor(lut, x, out) {
  const t = Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
  const i = Math.round(t * 255) * 3;
  out[0] = lut[i] / 255; out[1] = lut[i + 1] / 255; out[2] = lut[i + 2] / 255;
  return out;
}

function fmt(v) {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
  return Number(v.toPrecision(3)).toString();
}

// ── the arrow glyph (pv.Arrow: tip 0.32, tip r 0.11, shaft r 0.035) ──────────

function arrowGeometry() {
  const tipLen = 0.32, tipR = 0.11, shaftR = 0.035;
  const shaft = new THREE.CylinderGeometry(shaftR, shaftR, 1 - tipLen, 8, 1, false);
  shaft.translate(0, (1 - tipLen) / 2, 0);
  const tip = new THREE.ConeGeometry(tipR, tipLen, 8, 1, false);
  tip.translate(0, 1 - tipLen / 2, 0);
  const g = mergeGeoms([shaft, tip]);
  return g;
}

function mergeGeoms(list) {
  const pos = [], nrm = [], idx = [];
  let base = 0;
  for (const g of list) {
    const gi = g.index ? g.index.array : null;
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i++) { pos.push(p[i]); nrm.push(n[i]); }
    if (gi) for (let i = 0; i < gi.length; i++) idx.push(gi[i] + base);
    base += p.length / 3;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

function fatSegments(segs, color, width, res) {
  // segs: Float32Array of (n, 2, 3)
  const g = new LineSegmentsGeometry();
  g.setPositions(segs);
  const m = new LineMaterial({ color, linewidth: width, transparent: true,
                               depthWrite: false, worldUnits: false });
  m.resolution.copy(res);
  const l = new LineSegments2(g, m);
  l.computeLineDistances();
  return l;
}

// ── viewer ───────────────────────────────────────────────────────────────────

export async function start(stamp) {
  const loading = $("loading");
  const fill = loading.querySelector(".fill");
  const sub = loading.querySelector(".sub");
  const S = await (await fetch(`scene.json?v=${stamp}`)).json();
  document.title = `${S.name} · MeasureIt`;
  const bytes = await fetchBytes(`${S.data.file}?v=${stamp}`, S.data.bytes, (got, tot) => {
    fill.style.width = `${Math.min(100, (100 * got) / (tot || got))}%`;
    sub.textContent = `${(got / 1e6).toFixed(1)} / ${(tot / 1e6).toFixed(1)} MB`;
  });
  sub.textContent = "unpacking…";
  const A = arrays(await gunzip(bytes), S.arrays);

  // ── renderer / camera ──────────────────────────────────────────────────────
  const stage = $("stage");
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0d0d0d, 1);
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 1e-3, 1e4);
  scene.add(camera);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(0.3, 0.6, 1);
  camera.add(key);
  const res = new THREE.Vector2(1, 1);

  const B = S.bounds;
  const center = new THREE.Vector3((B[0] + B[1]) / 2, (B[2] + B[3]) / 2, (B[4] + B[5]) / 2);
  const radius = 0.5 * Math.hypot(B[1] - B[0], B[3] - B[2], B[5] - B[4]) || 1;
  camera.near = radius / 500;
  camera.far = radius * 200;

  // The vessel's own frame (share.axial_frame): z' = long axis, from the
  // inflow toward the outlets; x' = second axis; y' = z' × x'.  The default
  // view stands z' upright with x' across the screen, looking along y'.
  const F = S.frame || null;
  const ax = F ? { x: new THREE.Vector3(...F.x), y: new THREE.Vector3(...F.y),
                   z: new THREE.Vector3(...F.z) } : null;
  if (F) center.fromArray(F.center);
  // OrbitControls reads camera.up ONCE, when it is constructed — the up axis
  // has to be set before, or every drag pivots about the wrong axis
  camera.up.copy(ax ? ax.z : new THREE.Vector3(0, 0, 1));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.rotateSpeed = 0.45;
  controls.zoomSpeed = 0.7;
  controls.panSpeed = 0.7;
  controls.screenSpacePanning = true;

  function resetCamera() {
    camera.fov = 30;
    const tgt = center.clone();
    let toViewer, half_w, half_h;
    if (ax) {
      toViewer = ax.y.clone().negate();          // right = x', up = z'
      // fit the model's own extent along x' and z', not its bounding sphere
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      const P = fPts0, v = new THREE.Vector3();
      for (let i = 0; i < P.length; i += 3) {
        v.set(P[i] - tgt.x, P[i + 1] - tgt.y, P[i + 2] - tgt.z);
        const px = v.dot(ax.x), pz = v.dot(ax.z);
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
      }
      tgt.addScaledVector(ax.x, (x0 + x1) / 2).addScaledVector(ax.z, (z0 + z1) / 2);
      half_w = (x1 - x0) / 2; half_h = (z1 - z0) / 2;
    } else {
      toViewer = new THREE.Vector3(1, 1, 1).normalize();
      half_w = half_h = radius;
    }
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tanH = tanV * Math.max(camera.aspect, 1e-3);
    // leave room for the HUD / legend / controls around the model
    const dist = 1.18 * Math.max(half_h / tanV, half_w / tanH) + radius * 0.25;
    camera.position.copy(tgt).addScaledVector(toViewer, dist);
    camera.up.copy(ax ? ax.z : new THREE.Vector3(0, 0, 1));
    controls.target.copy(tgt);
    camera.updateProjectionMatrix();
    controls.update();
    dirty = true;
  }

  // ── orientation gizmo: the vessel frame x' y' z' plus the world axes ───────
  const gizmo = new THREE.Scene();
  const gcam = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  const GIZ = 120;                                   // px
  function label(text, color, scale = 0.42) {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 64;
    const g = c.getContext("2d");
    g.font = "600 34px JetBrains Mono, Menlo, monospace";
    g.fillStyle = color; g.textBaseline = "middle";
    g.fillText(text, 4, 32);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
    sp.scale.set(scale * 4, scale, 1);
    sp.center.set(0, 0.5);
    return sp;
  }
  function gizArrow(dir, color, len, text, r = 0.035) {
    const g = new THREE.Group();
    const m = new THREE.MeshBasicMaterial({ color });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len * 0.78, 10), m);
    shaft.position.y = len * 0.39;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(r * 2.8, len * 0.22, 14), m);
    tip.position.y = len * 0.89;
    g.add(shaft, tip);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    gizmo.add(g);
    const lb = label(text, color);
    lb.position.copy(dir.clone().normalize().multiplyScalar(len * 1.08));
    gizmo.add(lb);
  }
  // the lab axes, plus the vessel's axial direction (share.axial_frame)
  for (const [d, c, t] of [[[1, 0, 0], "#e07a6a", "x"], [[0, 1, 0], "#7fc97f", "y"], [[0, 0, 1], "#6f9fd6", "z"]]) {
    gizArrow(new THREE.Vector3(...d), c, 0.8, t, 0.026);
  }
  if (ax) gizArrow(ax.z, "#e8e8e8", 1.15, "axial", 0.04);
  function renderGizmo() {
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    gcam.position.copy(dir.multiplyScalar(5.4));
    gcam.up.copy(camera.up);
    gcam.lookAt(0, 0, 0);
    const size = w <= 720 ? 86 : GIZ;
    const y0 = w <= 720 ? 112 : 92;                  // above the playback bar
    renderer.setScissorTest(true);
    renderer.setScissor(12, y0, size, size);
    renderer.setViewport(12, y0, size, size);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(gizmo, gcam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.autoClear = true;
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.getDrawingBufferSize(res);
    for (const m of fatMaterials) m.resolution.copy(res);
    dirty = true;
  }
  const fatMaterials = [];
  const track = (obj) => { if (obj.material instanceof LineMaterial) fatMaterials.push(obj.material); return obj; };

  // ── state ──────────────────────────────────────────────────────────────────
  const T = S.n_frames;
  let frame = 0, playing = false, fps = 12, lastTick = 0, dirty = true;
  let warp = S.warp ?? 1;
  let glyphScale = S.glyph_scale;
  let view = "fluid", lastField = "fluid";
  let hover = null;
  const domainVis = { fluid: true, solid: true };
  const tmp3 = [0, 0, 0];

  // ── fluid ──────────────────────────────────────────────────────────────────
  const fPts0 = A.get("fluid/points").data;
  const fAle = A.get("fluid/ale");
  const fAleBuf = fAle ? new Float32Array(fPts0.length) : null;
  const fGeom = new THREE.BufferGeometry();
  const fPos = new Float32Array(fPts0);
  fGeom.setAttribute("position", new THREE.BufferAttribute(fPos, 3));
  fGeom.setIndex(new THREE.BufferAttribute(A.get("fluid/edges").data, 1));
  const fluidWire = new THREE.LineSegments(fGeom, new THREE.LineBasicMaterial({
    color: S.wire.color, transparent: true, opacity: S.wire.alpha, depthWrite: false }));
  scene.add(fluidWire);

  const gPts0 = A.get("glyph/points").data;
  const G = gPts0.length / 3;
  const gU = A.get("glyph/u");
  const gAle = A.get("glyph/ale");
  const gUBuf = new Float32Array(G * 3);
  const gAleBuf = gAle ? new Float32Array(G * 3) : null;
  const arrows = new THREE.InstancedMesh(arrowGeometry(),
    new THREE.MeshLambertMaterial({ color: 0xffffff }), G);
  arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  arrows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(G * 3), 3);
  arrows.frustumCulled = false;
  scene.add(arrows);
  const flowLut = S.cmaps.flow.lut;

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(),
        _s = new THREE.Vector3(), _d = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0);
  const col = [0, 0, 0];

  function updateFluid() {
    if (fAle) {
      frameInto(fAle, frame, fAleBuf);
      for (let j = 0; j < fPos.length; j++) fPos[j] = fPts0[j] + warp * fAleBuf[j];
    } else fPos.set(fPts0);
    fGeom.attributes.position.needsUpdate = true;
    fGeom.computeBoundingSphere();

    frameInto(gU, frame, gUBuf);
    if (gAle) frameInto(gAle, frame, gAleBuf);
    const umax = S.umax || 1;
    for (let i = 0; i < G; i++) {
      const ux = gUBuf[3 * i], uy = gUBuf[3 * i + 1], uz = gUBuf[3 * i + 2];
      const sp = Math.hypot(ux, uy, uz);
      _p.set(gPts0[3 * i], gPts0[3 * i + 1], gPts0[3 * i + 2]);
      if (gAleBuf) _p.set(_p.x + warp * gAleBuf[3 * i], _p.y + warp * gAleBuf[3 * i + 1],
                          _p.z + warp * gAleBuf[3 * i + 2]);
      if (sp > 0) {
        _d.set(ux / sp, uy / sp, uz / sp);
        _q.setFromUnitVectors(_y, _d);
      } else _q.identity();
      const L = sp * glyphScale;
      _s.set(L, L, L);
      _m.compose(_p, _q, _s);
      arrows.setMatrixAt(i, _m);
      lutColor(flowLut, sp / umax, col);
      arrows.instanceColor.setXYZ(i, col[0], col[1], col[2]);
    }
    arrows.instanceMatrix.needsUpdate = true;
    arrows.instanceColor.needsUpdate = true;
  }

  // ── solid ──────────────────────────────────────────────────────────────────
  let solidWire = null, sPts0 = null, sPos = null, sCol = null, sDisp = null, sBuf = null;
  if (A.has("solid/points")) {
    sPts0 = A.get("solid/points").data;
    sDisp = A.get("solid/disp");
    sBuf = new Float32Array(sPts0.length);
    sPos = new Float32Array(sPts0);
    sCol = new Float32Array(sPts0.length);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(sCol, 3));
    g.setIndex(new THREE.BufferAttribute(A.get("solid/edges").data, 1));
    solidWire = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
    scene.add(solidWire);
  }
  const solidLut = S.cmaps.solid.lut;
  // |d| in display units: the stored displacement is native, dmax already
  // carries the length factor (1 for CGS, 100 for SI → cm)
  const lenF = S.length_factor ?? 1;

  function updateSolid() {
    if (!solidWire) return;
    frameInto(sDisp, frame, sBuf);
    const dmax = S.dmax || 1;
    for (let j = 0; j < sPts0.length; j += 3) {
      const dx = sBuf[j], dy = sBuf[j + 1], dz = sBuf[j + 2];
      sPos[j] = sPts0[j] + warp * dx;
      sPos[j + 1] = sPts0[j + 1] + warp * dy;
      sPos[j + 2] = sPts0[j + 2] + warp * dz;
      lutColor(solidLut, (Math.hypot(dx, dy, dz) * lenF) / dmax, col);
      sCol[j] = col[0]; sCol[j + 1] = col[1]; sCol[j + 2] = col[2];
    }
    solidWire.geometry.attributes.position.needsUpdate = true;
    solidWire.geometry.attributes.color.needsUpdate = true;
    solidWire.geometry.computeBoundingSphere();
  }

  // ── boundary regions ───────────────────────────────────────────────────────
  const regions = S.regions.map((r) => ({ ...r }));
  const pickables = [];
  for (const r of regions) {
    if (!r.has_patch) continue;
    const k = `bc/${r.domain}/${r.tag}`;
    r.pts0 = A.get(`${k}/points`).data;
    r.surf = A.get(`${k}/surf`).data;
    r.pos = new Float32Array(r.pts0);
    const color = new THREE.Color(r.color);
    if (r.is_line) {
      const L = A.get(`${k}/lines`).data;
      r.lineIdx = L;
      const segs = new Float32Array(L.length * 3);
      fillSegs(r, segs);
      r.obj = track(fatSegments(segs, color, BC_LINE_W, res));
      r.segs = segs;
    } else {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(r.pos, 3));
      g.setIndex(new THREE.BufferAttribute(A.get(`${k}/tris`).data, 1));
      g.computeVertexNormals();
      r.obj = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
        color, transparent: true, opacity: BC_ALPHA, side: THREE.DoubleSide, depthWrite: false }));
    }
    r.obj.userData.region = r;
    r.obj.visible = false;
    scene.add(r.obj);
    pickables.push(r.obj);
    if (A.has(`${k}/schem`)) {
      r.schem = track(fatSegments(A.get(`${k}/schem`).data,
        new THREE.Color(r.schem_color || r.color), SCHEM_W, res));
      r.schem.visible = false;
      r.schem.renderOrder = 5;
      scene.add(r.schem);
    }
    if (A.has(`${k}/circuit`) && r.circuit_anchor) {
      const grp = new THREE.Group();
      grp.position.fromArray(r.circuit_anchor);
      grp.add(track(fatSegments(A.get(`${k}/circuit`).data, new THREE.Color(r.color), SCHEM_W, res)));
      grp.visible = false;
      grp.renderOrder = 6;
      scene.add(grp);
      r.circuit = grp;
    }
  }
  function fillSegs(r, segs) {
    const L = r.lineIdx, P = r.pos;
    for (let i = 0; i < L.length; i++) {
      const v = L[i];
      segs[3 * i] = P[3 * v]; segs[3 * i + 1] = P[3 * v + 1]; segs[3 * i + 2] = P[3 * v + 2];
    }
  }
  function warpRegion(r, on) {
    // a cap rides with the vessel: fluid patches follow d_ale through the
    // fluid surface's own nodes
    if (on && fAle && r.domain === "fluid") {
      for (let i = 0; i < r.surf.length; i++) {
        const s = r.surf[i];
        for (let c = 0; c < 3; c++)
          r.pos[3 * i + c] = r.pts0[3 * i + c] + (s >= 0 ? warp * fAleBuf[3 * s + c] : 0);
      }
    } else r.pos.set(r.pts0);
    if (r.is_line) {
      fillSegs(r, r.segs);
      r.obj.geometry.setPositions(r.segs);
    } else {
      r.obj.geometry.attributes.position.needsUpdate = true;
      r.obj.geometry.computeBoundingSphere();
    }
  }

  // ── colour bar ─────────────────────────────────────────────────────────────
  const cbar = $("cbar");
  function setColorBar(title, lut, vmax) {
    if (!title) { cbar.style.display = "none"; return; }
    cbar.style.display = "block";
    cbar.querySelector(".title").textContent = title;
    const cv = cbar.querySelector("canvas");
    const ctx = cv.getContext("2d");
    for (let y = 0; y < 256; y++) {
      lutColor(lut, 1 - y / 255, col);
      ctx.fillStyle = `rgb(${col[0] * 255},${col[1] * 255},${col[2] * 255})`;
      ctx.fillRect(0, y, 14, 1);
    }
    cbar.querySelector(".ticks").innerHTML =
      [1, 0.75, 0.5, 0.25, 0].map((t) => `<div>${fmt(t * vmax)}</div>`).join("");
  }

  // ── view switching ─────────────────────────────────────────────────────────
  const viewsEl = $("views");
  const viewDefs = [
    ["fluid", "Fluid", true],
    ["solid", "Solid", !!solidWire && !S.rigid],
    ["wk", "Windkessel", S.has_windkessel && (S.windkessel.length > 0 || regions.some((r) => r.circuit))],
    ["bc", "Boundary conditions", regions.length > 0],
  ];
  const viewBtns = {};
  viewDefs.forEach(([k, label, ok], n) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.disabled = !ok;
    if (!ok) b.title = k === "solid" ? "No wall motion in this run (rigid-wall CFD)."
      : k === "wk" ? "This run declares no Windkessel outlets."
      : "No boundary regions in this run.";
    b.onclick = () => setView(k);
    viewsEl.appendChild(b);
    viewBtns[k] = b;
  });
  let paramBtn = null;
  if (S.parameters && S.parameters.length) {
    paramBtn = document.createElement("button");
    paramBtn.textContent = "Parameters θ(t)";
    paramBtn.onclick = () => { paramBtn.classList.toggle("on"); renderPlots(); };
    viewsEl.appendChild(paramBtn);
  }

  function setView(k) {
    if (viewBtns[k]?.disabled) return;
    view = k;
    if (k === "fluid" || k === "solid") lastField = k;
    for (const [kk, b] of Object.entries(viewBtns)) b.classList.toggle("on", kk === k);
    hover = null;
    applyView();
    renderPlots();
    updateControlsVisibility();
    dirty = true;
  }

  function applyView() {
    const field = view === "bc" ? null : view === "wk" ? lastField : view;
    // no region geometry in this share (the mesh file was not found when it
    // was made): keep the vessel outline on screen and say why it is empty
    const noGeom = view === "bc" && !regions.some((r) => r.obj);
    fluidWire.visible = field === "fluid" || noGeom;
    fluidWire.material.opacity = noGeom ? Math.max(0.35, S.wire.alpha) : S.wire.alpha;
    arrows.visible = field === "fluid";
    if (solidWire) solidWire.visible = field === "solid";
    if (field === "fluid") setColorBar(S.titles.u, flowLut, S.umax);
    else if (field === "solid") setColorBar(S.titles.d, solidLut, S.dmax);
    else setColorBar(null);

    for (const r of regions) {
      if (!r.obj) continue;
      const wkCap = view === "wk" && r.type === "windkessel";
      r.obj.visible = (view === "bc" && domainVis[r.domain]) || wkCap;
      if (r.circuit) r.circuit.visible = wkCap;
      if (r.schem) r.schem.visible = false;
    }
    $("legend").style.display = view === "bc" || view === "wk" ? "block" : "none";
    $("legend").classList.toggle("wk", view === "wk");
    buildLegend();
    applyHighlight();
    updateFrame();
  }

  function applyHighlight() {
    for (const r of regions) {
      if (!r.obj) continue;
      if (view === "bc") {
        const op = hover == null ? BC_ALPHA : hover === r.key ? BC_HOVER : BC_DIM;
        r.obj.material.opacity = op;
        // a near-opaque region writes depth (clean, no see-through shading
        // mess); a dimmed one must not, or it hides the hovered region
        // buried behind it
        if (!r.is_line) {
          r.obj.material.depthWrite = op >= BC_HOVER - 1e-6 && hover == null;
          r.obj.renderOrder = hover === r.key ? 2 : 1;
        }
        r.obj.visible = domainVis[r.domain];
        if (r.schem) r.schem.visible = hover === r.key && domainVis[r.domain];
      } else if (view === "wk" && r.type === "windkessel") {
        r.obj.material.opacity = 0.95;
      }
    }
    const card = $("card");
    const r = regions.find((x) => x.key === hover);
    document.body.classList.toggle("carding", !!r && view === "bc");
    if (!r && view === "bc" && !regions.some((x) => x.obj)) {
      card.style.display = "block";
      card.innerHTML = `<div class="t">Region geometry not included</div><div class="b">The tagged mesh
        file was not found on the machine that shared this run, so the regions cannot be drawn.
        Every condition is still listed — hover a row in the legend to read it.</div>`;
    } else if (!r || view !== "bc") { card.style.display = "none"; }
    else {
      card.style.display = "block";
      card.innerHTML = `<div class="t" style="color:${r.color}">${esc(r.title)}</div>` +
        (r.blurb ? `<div class="b">${esc(r.blurb)}</div>` : "") +
        `<div class="i">${esc(r.info)}</div>` +
        (r.rows.length ? `<table>${r.rows.map(([n, v, a]) =>
          `<tr><td class="n">${esc(n)}</td><td>${esc(v)}</td><td class="a">${esc(a)}</td></tr>`).join("")}</table>` : "");
    }
    for (const el of document.querySelectorAll("#legend .row"))
      el.classList.toggle("hot", el.dataset.key === hover);
    placeCard();
    dirty = true;
  }

  // Put the BC card where it covers the least of the model: project a sample
  // of the surface nodes to the screen and count how many fall under each
  // candidate position (left column, bottom-left, bottom-centre).
  const cardSample = (() => {
    const n = fPts0.length / 3, step = Math.max(1, Math.floor(n / 600)), out = [];
    for (let i = 0; i < n; i += step) out.push(new THREE.Vector3(fPts0[3 * i], fPts0[3 * i + 1], fPts0[3 * i + 2]));
    return out;
  })();
  function placeCard() {
    const card = $("card");
    if (card.style.display === "none" || window.innerWidth <= 720) return;
    const W = window.innerWidth, H = window.innerHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const hudB = $("hud").getBoundingClientRect().bottom + 12;
    const ctlT = $("controls").getBoundingClientRect().top - 12;
    const cands = [
      { name: "left", x: 16, y: hudB },
      { name: "bottom-left", x: 16, y: ctlT - ch },
      { name: "bottom", x: (W - cw) / 2, y: ctlT - ch },
    ].filter((c) => c.y >= hudB - 1 && c.y + ch <= ctlT + 1 || c.name === "bottom");
    const scr = cardSample.map((p) => {
      const v = p.clone().project(camera);
      return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H, v.z < 1];
    });
    let best = null, bestN = Infinity;
    for (const c of cands) {
      let n = 0;
      for (const [x, y, ok] of scr) if (ok && x >= c.x && x <= c.x + cw && y >= c.y && y <= c.y + ch) n++;
      if (n < bestN) { bestN = n; best = c; }
    }
    card.style.left = `${best.x}px`;
    card.style.top = `${best.y}px`;
    card.style.bottom = "auto";
    card.style.transform = "none";
  }

  // ── legend ─────────────────────────────────────────────────────────────────
  function buildLegend() {
    const el = $("legend");
    const list = view === "wk" ? regions.filter((r) => r.type === "windkessel") : regions;
    let html = "";
    for (const dom of ["fluid", "solid"]) {
      const rs = list.filter((r) => r.domain === dom);
      if (!rs.length) continue;
      html += `<div class="hdr ${domainVis[dom] ? "" : "off"}" data-dom="${dom}"
        title="${view === "bc" ? "Click to hide / show every " + dom + " region" : ""}">${dom.toUpperCase()}</div>`;
      for (const r of rs)
        html += `<div class="row" data-key="${r.key}">
          <div class="sw ${r.has_patch ? "" : "hollow"}" style="background:${r.color};border-color:${r.color}"></div>
          <div class="lab">${esc(r.label)} <span class="sub">· tag ${r.tag}</span><div class="sub">${esc(r.info)}</div></div></div>`;
    }
    el.innerHTML = html;
    el.querySelectorAll(".hdr").forEach((h) => h.onclick = () => {
      if (view !== "bc") return;
      domainVis[h.dataset.dom] = !domainVis[h.dataset.dom];
      buildLegend(); applyHighlight();
    });
    el.querySelectorAll(".row").forEach((row) => {
      row.onmouseenter = () => { if (view === "bc") { hover = row.dataset.key; applyHighlight(); } };
      row.onmouseleave = () => { if (view === "bc") { hover = null; applyHighlight(); } };
      row.onclick = () => { if (view === "bc") { hover = hover === row.dataset.key ? null : row.dataset.key; applyHighlight(); } };
    });
  }

  // ── hover picking (BC view) ────────────────────────────────────────────────
  const ray = new THREE.Raycaster();
  ray.params.Line2 = { threshold: 4 };
  const mouse = new THREE.Vector2();
  let pickPending = false, pointerOver = false;
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (view !== "bc" || e.buttons) return;
    pointerOver = true;
    mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    if (!pickPending) { pickPending = true; requestAnimationFrame(doPick); }
  });
  renderer.domElement.addEventListener("pointerleave", () => {
    pointerOver = false;
    if (view === "bc" && hover) { hover = null; applyHighlight(); }
  });
  // touch has no hover: a tap (press + release without dragging) picks
  let down = null;
  renderer.domElement.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (view !== "bc" || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
    mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects(pickables.filter((o) => o.visible), false)[0];
    const k = hit ? hit.object.userData.region.key : null;
    if (e.pointerType !== "mouse" || k !== hover) { hover = k === hover && e.pointerType !== "mouse" ? null : k; applyHighlight(); }
  });
  function doPick() {
    pickPending = false;
    if (view !== "bc" || !pointerOver) return;
    ray.setFromCamera(mouse, camera);
    const vis = pickables.filter((o) => o.visible);
    const hit = ray.intersectObjects(vis, false)[0];
    const k = hit ? hit.object.userData.region.key : null;
    if (k !== hover) { hover = k; applyHighlight(); }
  }

  // ── plots (Windkessel, parameters) ─────────────────────────────────────────
  const plotsEl = $("plots");
  function linePath(xs, ys, sx, sy) {
    let d = "";
    for (let i = 0; i < xs.length; i++) {
      if (ys[i] == null || xs[i] == null) continue;
      d += `${d ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(ys[i]).toFixed(1)}`;
    }
    return d;
  }
  function extent(arrs) {
    let lo = Infinity, hi = -Infinity;
    for (const a of arrs) if (a) for (const v of a) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(hi > lo)) { hi = lo + 1; lo = lo - 1; }
    const pad = 0.06 * (hi - lo);
    return [lo - pad, hi + pad];
  }
  function svgPlot({ series, yLabel, y2 = null }) {
    const W = 500, H = 150, l = 52, r = y2 ? 52 : 12, t = 8, b = 22;
    const xs = series.flatMap((s) => s.x).concat(y2 ? y2.x : []).filter((v) => v != null);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const [y0, y1] = extent(series.flatMap((s) => [s.y, s.lo, s.hi]));
    const sx = (v) => l + ((v - x0) / (x1 - x0 || 1)) * (W - l - r);
    const sy = (v) => t + (1 - (v - y0) / (y1 - y0)) * (H - t - b);
    let g = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
    g += `<rect x="${l}" y="${t}" width="${W - l - r}" height="${H - t - b}" fill="none" stroke="#2c2c2c"/>`;
    for (let k = 0; k <= 3; k++) {
      const v = y0 + (k / 3) * (y1 - y0);
      g += `<text x="${l - 4}" y="${sy(v) + 3}" text-anchor="end">${fmt(v)}</text>`;
    }
    for (let k = 0; k <= 4; k++) {
      const v = x0 + (k / 4) * (x1 - x0);
      g += `<text x="${sx(v)}" y="${H - 6}" text-anchor="middle">${fmt(v)}</text>`;
    }
    g += `<text x="10" y="${(H - b) / 2}" transform="rotate(-90 10 ${(H - b) / 2})" text-anchor="middle">${esc(yLabel)}</text>`;
    for (const s of series) {
      if (s.lo && s.hi) {
        const up = linePath(s.x, s.hi, sx, sy);
        const dn = [];
        for (let i = s.x.length - 1; i >= 0; i--) if (s.lo[i] != null) dn.push(`L${sx(s.x[i]).toFixed(1)},${sy(s.lo[i]).toFixed(1)}`);
        g += `<path d="${up}${dn.join("")}Z" fill="${s.color}" opacity="0.18" stroke="none"/>`;
      }
      g += `<path d="${linePath(s.x, s.y, sx, sy)}" fill="none" stroke="${s.color}" stroke-width="${s.w || 1.6}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""}/>`;
    }
    if (y2) {
      const [q0, q1] = extent([y2.y]);
      const sq = (v) => t + (1 - (v - q0) / (q1 - q0)) * (H - t - b);
      g += `<path d="${linePath(y2.x, y2.y, sx, sq)}" fill="none" stroke="#9a9a9a" stroke-width="1" opacity="0.8"/>`;
      for (let k = 0; k <= 3; k++) {
        const v = q0 + (k / 3) * (q1 - q0);
        g += `<text x="${W - r + 4}" y="${sq(v) + 3}">${fmt(v)}</text>`;
      }
      g += `<text x="${W - 6}" y="${(H - b) / 2}" transform="rotate(90 ${W - 6} ${(H - b) / 2})" text-anchor="middle">${esc(y2.label)}</text>`;
    }
    // the frame cursor: drawn once, moved by moveCursor() during playback
    g += `<line class="cur" data-x0="${x0}" data-x1="${x1}" data-l="${l}" data-w="${W - l - r}"
      x1="0" x2="0" y1="${t}" y2="${H - b}" stroke="#d0d0d0" stroke-dasharray="4 3" stroke-width="1"/>`;
    return g + "</svg>";
  }

  function renderPlots() {
    const showWk = view === "wk" && S.windkessel.length;
    const showPar = paramBtn && paramBtn.classList.contains("on");
    if (!showWk && !showPar) { plotsEl.style.display = "none"; return; }
    plotsEl.style.display = "block";
    let html = "";
    if (showWk) {
      // one caption for all outlets: every plot shows the same three curves
      const srcs = [...new Set(S.windkessel.map((tr) => tr.pi_source))];
      const anyQ = S.windkessel.some((tr) => tr.Q);
      html += `<div class="ph"><span class="t">Windkessel outlets</span><button class="fold">${plotsEl.classList.contains("folded") ? "show" : "hide"}</button></div>
        <div class="note">solid: reservoir pressure π` +
        (anyQ ? ` · dashed: load pressure P_l = π + R_p·Q · grey: outlet flow Q (right axis, mL/s)` : ``) +
        `. Pressures in mmHg. The dashed vertical line is the frame on screen.` +
        (srcs.length === 1 ? `<br>π from ${esc(srcs[0])}.` : ``) + `</div>`;
      for (const tr of S.windkessel) {
        const series = [{ x: tr.pi_times, y: tr.pi, color: tr.color }];
        if (tr.pl) series.push({ x: tr.q_times, y: tr.pl, color: tr.color, dash: "5 3", w: 1.2 });
        html += `<div class="plot"><div class="pt"><span style="color:${tr.color}">outlet ${tr.tag}</span>
          <span class="s">${esc(tr.summary)}</span></div>` +
          svgPlot({ series, yLabel: "p [mmHg]",
                    y2: tr.Q ? { x: tr.q_times, y: tr.Q, label: "Q [mL/s]" } : null }) +
          (srcs.length > 1 ? `<div class="note">π from ${esc(tr.pi_source)}</div>` : ``) + `</div>`;
      }
    }
    if (showPar) {
      html += `<div class="ph"><span class="t">Estimated parameters</span>${showWk ? "" : `<button class="fold">${plotsEl.classList.contains("folded") ? "show" : "hide"}</button>`}</div>`;
      for (const p of S.parameters) {
        html += `<div class="plot"><div class="pt"><span>${esc(p.label)}</span>
          <span class="s">${fmt(p.value[p.value.length - 1])} ${esc(p.unit)}</span></div>` +
          svgPlot({ series: [{ x: p.times, y: p.value, lo: p.lo, hi: p.hi, color: "#6fb1d6" }],
                    yLabel: p.unit || "value" }) + `</div>`;
      }
      html += `<div class="note">Band: ±1σ of the filter covariance, mapped through the parameter transform (asymmetric).</div>`;
    }
    plotsEl.innerHTML = html;
    plotsEl.querySelectorAll(".fold").forEach((b) => b.onclick = () => {
      plotsEl.classList.toggle("folded");
      b.textContent = plotsEl.classList.contains("folded") ? "show" : "hide";
    });
    moveCursor();
  }
  // Per frame only the cursor lines move.  Rebuilding the plots on every
  // frame replaced the Hide button under the pointer during playback, so a
  // click never landed on it.
  function moveCursor() {
    if (plotsEl.style.display === "none") return;
    const t = S.times[frame];
    for (const ln of plotsEl.querySelectorAll("line.cur")) {
      const x0 = +ln.dataset.x0, x1 = +ln.dataset.x1;
      const on = t != null && t >= x0 && t <= x1;
      const x = +ln.dataset.l + ((t - x0) / (x1 - x0 || 1)) * +ln.dataset.w;
      ln.setAttribute("x1", on ? x : -10);
      ln.setAttribute("x2", on ? x : -10);
      ln.style.display = on ? "" : "none";
    }
  }

  // ── HUD + panels ───────────────────────────────────────────────────────────
  const hud = $("hud");
  // compact by default: name + clock; the toggle reveals the run facts and
  // the constitutive parameters
  hud.innerHTML = `<div class="top"><span class="name">${esc(S.name)}</span>
      <button class="tog" title="Show / hide the run details">details</button></div>
    <div class="more"><div class="facts">${esc(S.hud.facts)}</div>` +
    (S.hud.material?.length ? `<div class="mat">${S.hud.material.map(esc).join("\n")}</div>` : "") +
    `</div><div class="clock"></div>`;
  hud.querySelector(".tog").onclick = () => {
    hud.classList.toggle("open");
    if (typeof placeCard === "function") placeCard();
  };
  const clock = hud.querySelector(".clock");

  function panel(title, rows, open = false) {
    if (!rows || !rows.length) return;
    const p = document.createElement("div");
    p.className = "panel cpanel" + (open ? " open" : "");
    let body = "", grp = null;
    for (const r of rows) {
      if (r.group !== grp) { grp = r.group; body += `<div class="grp">${esc(grp)}</div>`; }
      body += `<details class="${r.active === false ? "inactive" : ""}"><summary><span>${esc(r.name)}</span>
        <span class="v">${esc(r.value)}</span></summary><p>${r.detail || ""}</p></details>`;
    }
    p.innerHTML = `<div class="head"><span>${esc(title)}</span><span>${rows.length} ▾</span></div><div class="bodyp">${body}</div>`;
    p.querySelector(".head").onclick = () => p.classList.toggle("open");
    $("side").appendChild(p);
  }
  panel("Assimilation", S.assimilation);
  panel("Stabilization & numerics", S.stabilization);
  if (S.notes?.length)
    panel("Notes", S.notes.map((n) => ({ group: "", name: "", value: "", detail: esc(n) }))
      .map((r, i) => ({ ...r, name: `note ${i + 1}`, value: S.notes[i].slice(0, 40) + (S.notes[i].length > 40 ? "…" : "") })));
  {
    const p = document.createElement("div");
    p.className = "panel cpanel";
    p.innerHTML = `<div class="head"><span>Shared ${esc(S.shared)} · MeasureIt</span><span>?</span></div>
      <div class="bodyp"><p style="color:var(--muted);line-height:1.5;margin:6px 0">Drag to orbit, right-drag or two
      fingers to pan, scroll to zoom.<br>Space play/pause · ←/→ step · 1–4 views · R reset view.
      <br>Fields are quantised to 16 bits for the web; the colour ranges are global over the run.</p></div>`;
    p.querySelector(".head").onclick = () => p.classList.toggle("open");
    $("side").appendChild(p);
  }

  // ── playback controls ──────────────────────────────────────────────────────
  const ctl = $("controls");
  ctl.innerHTML = `<button id="play">▶ Play</button>
    <input id="slider" type="range" min="0" max="${T - 1}" value="0" step="1">
    <span class="grp"><span class="lbl">fps</span><select id="fps">${[5, 12, 24, 40].map((v) =>
      `<option ${v === fps ? "selected" : ""}>${v}</option>`).join("")}</select></span>
    <span class="grp" id="warpg"><span class="lbl">Warp ×</span><input id="warp" type="number" min="0" step="10" value="${warp}"></span>
    <span class="grp" id="scaleg"><span class="lbl">Arrow scale</span><input id="gscale" type="number" min="0" step="any" value="${glyphScale}"></span>
    <button id="reset" title="Reset the camera (R)">Reset view</button>`;
  const playBtn = $("play"), slider = $("slider");
  playBtn.onclick = () => setPlaying(!playing);
  slider.oninput = () => { setFrame(+slider.value); };
  $("fps").onchange = (e) => { fps = +e.target.value; };
  $("warp").onchange = (e) => { const v = parseFloat(e.target.value); if (v >= 0) { warp = v; updateFrame(); } };
  $("gscale").onchange = (e) => { const v = parseFloat(e.target.value); if (v >= 0) { glyphScale = v; updateFrame(); } };
  $("reset").onclick = resetCamera;
  function updateControlsVisibility() {
    const field = view === "bc" ? null : view === "wk" ? lastField : view;
    $("warpg").style.display = (S.has_ale || !S.rigid) && view !== "bc" ? "" : "none";
    $("scaleg").style.display = field === "fluid" ? "" : "none";
    const stat = view === "bc";
    playBtn.disabled = stat || T < 2;
    slider.disabled = stat || T < 2;
    if (stat) setPlaying(false);
  }
  function setPlaying(on) {
    playing = on && T > 1 && view !== "bc";
    playBtn.textContent = playing ? "❚❚ Pause" : "▶ Play";
  }
  function setFrame(k) {
    frame = ((k % T) + T) % T;
    slider.value = frame;
    updateFrame();
  }
  function updateFrame() {
    const field = view === "bc" ? null : view === "wk" ? lastField : view;
    if (field === "fluid") updateFluid();
    else if (field === "solid") updateSolid();
    else if (fAle) frameInto(fAle, frame, fAleBuf);
    for (const r of regions) {
      if (!r.obj || !r.obj.visible) continue;
      warpRegion(r, view === "wk");
    }
    const t = S.times[frame];
    clock.textContent = view === "bc" ? "boundary conditions — static"
      : `t = ${t != null ? t.toFixed(4) : "?"} s   ·   frame ${frame + 1} / ${T}`;
    moveCursor();
    dirty = true;
  }

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.code === "Space") { e.preventDefault(); setPlaying(!playing); }
    else if (e.key === "ArrowRight") setFrame(frame + 1);
    else if (e.key === "ArrowLeft") setFrame(frame - 1);
    else if (e.key === "r" || e.key === "R") resetCamera();
    else if ("1234".includes(e.key)) setView(viewDefs[+e.key - 1][0]);
  });

  // ── go ─────────────────────────────────────────────────────────────────────
  window.addEventListener("resize", resize);
  let placeT = 0;
  controls.addEventListener("change", () => {
    dirty = true;
    clearTimeout(placeT);
    placeT = setTimeout(placeCard, 120);
  });
  resize();
  resetCamera();
  // #view=solid&frame=40&warp=200&hover=fluid:3&params&play — a link can open
  // the page on a particular view and instant
  const H = new URLSearchParams(location.hash.slice(1));
  if (H.has("warp")) { warp = parseFloat(H.get("warp")) || warp; $("warp").value = warp; }
  if (H.has("frame")) frame = Math.max(0, Math.min(T - 1, (parseInt(H.get("frame"), 10) || 1) - 1));
  slider.value = frame;
  const v0 = H.get("view");
  setView(viewBtns[v0] && !viewBtns[v0].disabled ? v0 : "fluid");
  if (H.has("params") && paramBtn) { paramBtn.classList.add("on"); renderPlots(); }
  if (H.has("hover") && view === "bc") { hover = H.get("hover"); applyHighlight(); }
  if (H.has("play")) setPlaying(true);
  updateControlsVisibility();
  loading.style.display = "none";
  // a handle for the console (and for automated checks of a bundle)
  window.measureit = {
    scene: S, setView, setFrame, setPlaying,
    get frame() { return frame; }, get view() { return view; },
    hover: (k) => { hover = k; applyHighlight(); },
  };

  function loop(now) {
    requestAnimationFrame(loop);
    if (playing && now - lastTick >= 1000 / fps) {
      lastTick = now;
      setFrame(frame + 1);
    }
    if (controls.update()) dirty = true;
    if (!dirty) return;
    for (const r of regions) if (r.circuit && r.circuit.visible) r.circuit.quaternion.copy(camera.quaternion);
    renderer.render(scene, camera);
    renderGizmo();
    dirty = false;
  }
  requestAnimationFrame(loop);
}
