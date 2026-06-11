/*
 * ANOMALY DETECTOR — audio-reactive 3D visualizer
 * Reconstruction of Filip Zrnzevic's CodePen "yyyRgry" (Audio Visualizer with
 * THREE.js — GSAP Challenge #2: Draggable & Inertia), extended with a
 * MORPHOLOGY system so the anomaly can take different shapes.
 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  window.__VIZ = { ready: false, playing: false, beats: 0, shape: 'ICOSAHEDRON', bands: { bass: 0, mid: 0, treble: 0, level: 0 }, errors: [] };
  window.addEventListener('error', function (e) { window.__VIZ.errors.push(String(e.message)); });

  function fatal(msg) {
    $('#fatalMsg').textContent = msg;
    $('#fatal').classList.add('show');
  }

  if (!window.THREE || !window.gsap || !window.Draggable || !window.InertiaPlugin) {
    fatal('VENDOR LIBRARIES MISSING — SEE vendor/');
    return;
  }
  gsap.registerPlugin(Draggable, InertiaPlugin);

  /* ------------------------------------------------------------------ *
   *  RENDERER / SCENE
   * ------------------------------------------------------------------ */
  var canvas = $('#scene');
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    fatal('WEBGL REQUIRED — ' + err.message);
    return;
  }
  renderer.setClearColor(0x000000, 0);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
  camera.position.set(0, 0, 6.4);

  /* ------------------------------------------------------------------ *
   *  SHADERS
   * ------------------------------------------------------------------ */
  // Ashima/McEwan 3D simplex noise (public domain)
  var SNOISE = [
    'vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}',
    'vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}',
    'float snoise(vec3 v){',
    '  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);',
    '  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);',
    '  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);',
    '  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;',
    '  i=mod289(i);',
    '  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));',
    '  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;',
    '  vec4 j=p-49.0*floor(p*ns.z*ns.z);',
    '  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);',
    '  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);',
    '  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);',
    '  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));',
    '  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;',
    '  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);',
    '  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));',
    '  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;',
    '  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;',
    '  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));',
    '}'
  ].join('\n');

  var uniforms = {
    uTime:       { value: 0 },
    uDistort:    { value: 1.0 },
    uReact:      { value: 1.0 },
    uBass:       { value: 0 },
    uMid:        { value: 0 },
    uTreble:     { value: 0 },
    uLevel:      { value: 0 },
    uPulse:      { value: 0 },
    uNoiseScale: { value: 2.2 },
    uFlow:       { value: 0.7 },
    uFracture:   { value: 0.45 },
    uColorA:     { value: new THREE.Color('#ff6a14') },
    uColorB:     { value: new THREE.Color('#ffe7cf') },
    uPx:         { value: 1 }
  };

  var DISPLACE_VERT = [
    'attribute vec3 aCent;',     // face centroid (same for the 3 verts of a tri)
    'attribute float aSeed1;',   // per-face random seed
    'uniform float uTime,uDistort,uReact,uBass,uMid,uTreble,uPulse,uNoiseScale,uFlow,uFracture;',
    'varying float vDisp; varying vec3 vN; varying vec3 vView;',
    SNOISE,
    'void main(){',
    '  vec3 nrm=normalize(normal);',
    '  vec3 sp=normalize(position);',
    '  float t=uTime*uFlow;',
    '  float n =snoise(sp*uNoiseScale + vec3(0.0,t*0.7,t*0.35));',
    '  float n2=snoise(sp*(uNoiseScale*2.35) - vec3(t*0.9,0.0,t*0.5));',
    '  float audio=(uBass*0.55+uMid*0.30+uTreble*0.15)*uReact;',
    // smooth organic swell
    '  float smoothD=(0.18*n+0.09*n2)*(0.38+audio*1.45);',
    // rigid per-face shard field, quantized so neighbouring faces tear apart
    '  vec3 cd=normalize(aCent+vec3(1e-4));',
    '  float fn=snoise(cd*(uNoiseScale*0.9)+vec3(t*0.55,-t*0.4,t*0.3));',
    '  float fq=floor(fn*4.0+0.5)*0.25;',
    '  float shard=(0.6*fq+0.4*fn)*(0.45+audio*1.7)+uPulse*(0.32*aSeed1+0.08);',
    '  float disp=uDistort*(smoothD*(1.0-0.55*uFracture)+0.40*shard*uFracture)',
    '            +uPulse*0.17*n',
    '            +uTreble*uReact*0.05*n2;',
    // shards burst outward from the centre, smooth swell follows the normal
    '  vec3 dir=normalize(mix(nrm,cd,uFracture*0.75));',
    '  vec3 p=position+dir*disp;',
    '  p*=1.0+uBass*uReact*0.07+uPulse*0.05;',
    '  vDisp=disp;',
    '  vN=normalMatrix*nrm;',
    '  vec4 mv=modelViewMatrix*vec4(p,1.0);',
    '  vView=-mv.xyz;',
    '  gl_Position=projectionMatrix*mv;',
    '}'
  ].join('\n');

  var WIRE_FRAG = [
    'uniform vec3 uColorA,uColorB; uniform float uTreble,uLevel,uPulse;',
    'varying float vDisp; varying vec3 vN; varying vec3 vView;',
    'void main(){',
    '  float d=abs(dot(normalize(vN),normalize(vView)));',
    '  float fres=pow(1.0-d,1.5);',
    '  float heat=clamp(abs(vDisp)*2.6+uTreble*0.4+uPulse*0.5,0.0,1.0);',
    '  vec3 col=mix(uColorA,uColorB,heat);',
    '  col+=fres*uColorA*0.55;',
    '  gl_FragColor=vec4(col*(0.85+uLevel*0.7),0.5+0.5*heat);',
    '}'
  ].join('\n');

  var CORE_FRAG = [
    'uniform vec3 uColorA,uColorB; uniform float uBass,uPulse;',
    'varying float vDisp; varying vec3 vN; varying vec3 vView;',
    'void main(){',
    '  float d=abs(dot(normalize(vN),normalize(vView)));',
    '  float fres=pow(1.0-d,2.1);',
    '  vec3 col=uColorA*0.05',
    '          +uColorA*fres*(0.75+uBass*1.7+uPulse*0.9)',
    '          +uColorB*pow(fres,3.0)*(0.35+uPulse*0.8);',
    '  gl_FragColor=vec4(col,0.94);',
    '}'
  ].join('\n');

  var HALO_VERT = [
    'uniform float uBass,uPulse;',
    'varying vec3 vN; varying vec3 vView;',
    'void main(){',
    '  vec3 p=position*(1.0+uBass*0.10+uPulse*0.06);',
    '  vN=normalMatrix*normalize(normal);',
    '  vec4 mv=modelViewMatrix*vec4(p,1.0);',
    '  vView=-mv.xyz;',
    '  gl_Position=projectionMatrix*mv;',
    '}'
  ].join('\n');

  var HALO_FRAG = [
    'uniform vec3 uColorA,uColorB; uniform float uBass,uPulse,uLevel;',
    'varying vec3 vN; varying vec3 vView;',
    'void main(){',
    '  float d=abs(dot(normalize(vN),normalize(vView)));',
    '  float glow=pow(1.0-d,2.6);',
    '  vec3 col=mix(uColorA,uColorB,glow*0.55);',
    '  float a=glow*(0.26+uBass*0.62+uPulse*0.6+uLevel*0.2);',
    '  gl_FragColor=vec4(col,a);',
    '}'
  ].join('\n');

  var PARTICLE_VERT = [
    'attribute vec4 aSeed;',
    'uniform float uTime,uLevel,uPulse,uPx;',
    'varying float vA;',
    'void main(){',
    '  float tw=0.5+0.5*sin(uTime*aSeed.y*2.0+aSeed.x*6.2831);',
    '  vA=(0.15+0.85*tw)*(0.30+uLevel*0.85+uPulse*0.5);',
    '  vec4 mv=modelViewMatrix*vec4(position,1.0);',
    '  gl_PointSize=(0.9+aSeed.z*2.0)*(1.0+uPulse*0.35)*uPx*(26.0/-mv.z);',
    '  gl_Position=projectionMatrix*mv;',
    '}'
  ].join('\n');

  var PARTICLE_FRAG = [
    'uniform vec3 uColorA,uColorB;',
    'varying float vA;',
    'void main(){',
    '  float r=length(gl_PointCoord-0.5);',
    '  if(r>0.5) discard;',
    '  float soft=smoothstep(0.5,0.05,r);',
    '  gl_FragColor=vec4(mix(uColorA,uColorB,soft*0.6),vA*soft);',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------------ *
   *  ANOMALY MESHES
   * ------------------------------------------------------------------ */
  var spinGroup = new THREE.Group();   // user/inertia + auto rotation
  scene.add(spinGroup);

  // the core shares every uniform except uFracture (kept low) so the glowing
  // body stays mostly whole while the wireframe shell tears open around it
  var coreUniforms = {};
  (function () {
    for (var k in uniforms) coreUniforms[k] = uniforms[k];
    coreUniforms.uFracture = { value: uniforms.uFracture.value * 0.3 };
  })();

  var wireMat = new THREE.ShaderMaterial({
    uniforms: uniforms, vertexShader: DISPLACE_VERT, fragmentShader: WIRE_FRAG,
    wireframe: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
  });
  var coreMat = new THREE.ShaderMaterial({
    uniforms: coreUniforms, vertexShader: DISPLACE_VERT, fragmentShader: CORE_FRAG,
    transparent: true
  });
  var haloMat = new THREE.ShaderMaterial({
    uniforms: uniforms, vertexShader: HALO_VERT, fragmentShader: HALO_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide
  });

  var coreMesh = new THREE.Mesh(new THREE.BufferGeometry(), coreMat);
  coreMesh.scale.setScalar(0.965);
  var wireMesh = new THREE.Mesh(new THREE.BufferGeometry(), wireMat);
  wireMesh.renderOrder = 1;
  spinGroup.add(coreMesh, wireMesh);

  var haloMesh = new THREE.Mesh(new THREE.SphereGeometry(1.58, 48, 48), haloMat);
  haloMesh.renderOrder = 2;
  scene.add(haloMesh);

  // background dust
  var particles;
  var P_COUNT = 850;
  (function () {
    var pos = new Float32Array(P_COUNT * 3);
    var seed = new Float32Array(P_COUNT * 4);
    for (var i = 0; i < P_COUNT; i++) {
      var r = 3.2 + Math.pow(Math.random(), 0.7) * 7.5;
      var th = Math.random() * Math.PI * 2;
      var ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3]     = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.72;
      pos[i * 3 + 2] = r * Math.cos(ph);
      seed[i * 4] = Math.random(); seed[i * 4 + 1] = 0.4 + Math.random() * 1.4;
      seed[i * 4 + 2] = Math.random(); seed[i * 4 + 3] = Math.random();
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    var m = new THREE.ShaderMaterial({
      uniforms: uniforms, vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
    });
    particles = new THREE.Points(g, m);
    scene.add(particles);
  })();

  /* ------------------------------------------------------------------ *
   *  MORPHOLOGY — the different shapes (extension over the original)
   * ------------------------------------------------------------------ */
  function di(d, a, b) { return Math.round(lerp(a, b, d)); } // detail interpolation

  // every geometry becomes non-indexed with per-face centroid + seed
  // attributes so the fracture shader can move whole triangles rigidly
  function prepGeometry(g) {
    if (g.index) g = g.toNonIndexed();
    var pos = g.attributes.position, n = pos.count;
    var cent = new Float32Array(n * 3), seed = new Float32Array(n);
    for (var f = 0; f < n; f += 3) {
      var cx = (pos.getX(f) + pos.getX(f + 1) + pos.getX(f + 2)) / 3;
      var cy = (pos.getY(f) + pos.getY(f + 1) + pos.getY(f + 2)) / 3;
      var cz = (pos.getZ(f) + pos.getZ(f + 1) + pos.getZ(f + 2)) / 3;
      var s = Math.random();
      for (var k = 0; k < 3; k++) {
        var j = f + k;
        cent[j * 3] = cx; cent[j * 3 + 1] = cy; cent[j * 3 + 2] = cz;
        seed[j] = s;
      }
    }
    g.setAttribute('aCent', new THREE.BufferAttribute(cent, 3));
    g.setAttribute('aSeed1', new THREE.BufferAttribute(seed, 1));
    return g;
  }

  var helixCurve = new THREE.Curve();
  helixCurve.getPoint = function (t, target) {
    var v = target || new THREE.Vector3();
    var a = t * Math.PI * 4.4;
    return v.set(Math.cos(a) * 0.82, (t - 0.5) * 2.1, Math.sin(a) * 0.82);
  };

  function starGeometry(d) {
    var shp = new THREE.Shape();
    for (var i = 0; i < 10; i++) {
      var r = (i % 2) ? 0.52 : 1.22;
      var a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      i === 0 ? shp.moveTo(Math.cos(a) * r, Math.sin(a) * r) : shp.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    shp.closePath();
    var g = new THREE.ExtrudeGeometry(shp, {
      depth: 0.5, steps: di(d, 1, 3),
      bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: di(d, 1, 4)
    });
    g.center();
    return g;
  }

  var SHAPES = [
    { id: 'ICO', name: 'ICOSAHEDRON',  glyph: 'M8 1 L15 6 L12 15 L4 15 L1 6 Z M8 1 L8 15',           make: function (d) { return new THREE.IcosahedronGeometry(1.18, di(d, 1, 5)); } },
    { id: 'SPH', name: 'SPHERE',       glyph: 'M8 1 A7 7 0 1 0 8 15 A7 7 0 1 0 8 1 M1.5 8 H14.5',     make: function (d) { return new THREE.SphereGeometry(1.18, di(d, 10, 46), di(d, 8, 32)); } },
    { id: 'TOR', name: 'TORUS',        glyph: 'M8 3 A6 5 0 1 0 8 13 A6 5 0 1 0 8 3 M8 6.5 A2 1.6 0 1 0 8 9.5 A2 1.6 0 1 0 8 6.5', make: function (d) { return new THREE.TorusGeometry(0.92, 0.40, di(d, 8, 28), di(d, 14, 72)); } },
    { id: 'KNT', name: 'TORUS KNOT',   glyph: 'M3 11 C1 6 6 1 9 4 C12 7 4 9 7 12 C10 15 15 10 13 5',  make: function (d) { return new THREE.TorusKnotGeometry(0.78, 0.30, di(d, 48, 220), di(d, 6, 22)); } },
    { id: 'OCT', name: 'OCTAHEDRON',   glyph: 'M8 1 L15 8 L8 15 L1 8 Z M1 8 H15 M8 1 V15',            make: function (d) { return new THREE.OctahedronGeometry(1.30, di(d, 0, 3)); } },
    { id: 'DOD', name: 'DODECAHEDRON', glyph: 'M8 1 L14 5 L12 12 L4 12 L2 5 Z M8 1 L8 5 M2 5 L5 8 M14 5 L11 8 M4 12 L5 8 L8 5 L11 8 L12 12', make: function (d) { return new THREE.DodecahedronGeometry(1.26, di(d, 0, 3)); } },
    { id: 'BOX', name: 'PRISM CUBE',   glyph: 'M3 5 L8 2 L13 5 L13 11 L8 14 L3 11 Z M3 5 L8 8 L13 5 M8 8 V14', make: function (d) { return new THREE.BoxGeometry(1.58, 1.58, 1.58, di(d, 1, 10), di(d, 1, 10), di(d, 1, 10)); } },
    { id: 'CAP', name: 'CAPSULE',      glyph: 'M5 4 A3 3 0 0 1 11 4 V12 A3 3 0 0 1 5 12 Z',           make: function (d) { return new THREE.CapsuleGeometry(0.62, 1.05, di(d, 2, 14), di(d, 8, 32)); } },
    { id: 'TET', name: 'TETRAHEDRON',  glyph: 'M8 2 L14 13 L2 13 Z M8 2 L8 13',                       make: function (d) { return new THREE.TetrahedronGeometry(1.45, di(d, 0, 3)); } },
    { id: 'PYR', name: 'PYRAMID',      glyph: 'M8 2 L14 12 L2 12 Z M2 12 L8 9.5 L14 12 M8 2 L8 9.5',  make: function (d) { return new THREE.ConeGeometry(1.18, 1.7, 4, di(d, 1, 12)); } },
    { id: 'CON', name: 'CONE',         glyph: 'M8 2 L12.5 11.5 A4.5 1.6 0 1 1 3.5 11.5 Z',            make: function (d) { return new THREE.ConeGeometry(1.0, 1.85, di(d, 8, 42), di(d, 1, 12)); } },
    { id: 'CYL', name: 'CYLINDER',     glyph: 'M3.5 4.5 A4.5 1.7 0 1 0 12.5 4.5 A4.5 1.7 0 1 0 3.5 4.5 M3.5 4.5 V11.5 A4.5 1.7 0 0 0 12.5 11.5 V4.5', make: function (d) { return new THREE.CylinderGeometry(0.85, 0.85, 1.7, di(d, 8, 42), di(d, 1, 12)); } },
    { id: 'GEM', name: 'GEMSTONE',     glyph: 'M8 1 L13 6 L8 15 L3 6 Z M3 6 H13 M8 1 L8 15',          make: function (d) { var g = new THREE.OctahedronGeometry(1.06, di(d, 0, 3)); g.scale(0.92, 1.5, 0.92); return g; } },
    { id: 'RNG', name: 'HALO RING',    glyph: 'M8 2.5 A5.5 5.5 0 1 0 8 13.5 A5.5 5.5 0 1 0 8 2.5 M8 5.5 A2.5 2.5 0 1 0 8 10.5 A2.5 2.5 0 1 0 8 5.5', make: function (d) { return new THREE.TorusGeometry(1.18, 0.22, di(d, 6, 20), di(d, 18, 90)); } },
    { id: 'HLX', name: 'HELIX COIL',   glyph: 'M2 4.5 Q5 1.5 8 4.5 T14 4.5 M2 8 Q5 5 8 8 T14 8 M2 11.5 Q5 8.5 8 11.5 T14 11.5', make: function (d) { return new THREE.TubeGeometry(helixCurve, di(d, 36, 170), 0.26, di(d, 5, 14), false); } },
    { id: 'STR', name: 'STELLATED',    glyph: 'M8 1 L9.8 5.8 L15 6 L11 9.4 L12.4 14.6 L8 11.6 L3.6 14.6 L5 9.4 L1 6 L6.2 5.8 Z', make: starGeometry }
  ];

  var state = {
    shape: 0,
    detail: 0.55,
    rotation: 0.45,
    pal: 0,
    chromaAuto: false,
    focus: false,
    fps: 60,
    morphing: false,
    morphScale: { v: 1 },
    popScale: { v: 1 },
    rot: { rx: 0.18, ry: -0.42 },
    dragging: false,
    inertiaTween: null
  };

  function rebuildGeometry() {
    var def = SHAPES[state.shape];
    var g = prepGeometry(def.make(state.detail));
    var old = wireMesh.geometry;
    wireMesh.geometry = g;
    coreMesh.geometry = g;
    if (old && old.dispose) old.dispose();
    $('#resolutionVal').textContent = g.attributes.position.count + ' V';
  }

  function setShape(idx, opts) {
    idx = (idx + SHAPES.length) % SHAPES.length;
    if (state.morphing || (idx === state.shape && !(opts && opts.force))) return;
    state.morphing = true;
    var def = SHAPES[idx];

    var btns = document.querySelectorAll('#shapeGrid .btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', i === idx);

    gsap.timeline({ onComplete: function () { state.morphing = false; } })
      .to(state.morphScale, { v: 0.04, duration: 0.26, ease: 'back.in(2.2)' })
      .add(function () {
        state.shape = idx;
        rebuildGeometry();
        $('#shapeName').textContent = def.name;
        window.__VIZ.shape = def.name;
        setStatus('MORPHOLOGY RECONFIGURED', def.name + ' LATTICE ONLINE');
        gsap.fromTo(uniforms.uPulse, { value: 1 }, { value: 0, duration: 0.7, ease: 'expo.out', overwrite: 'auto' });
        flashReticle();
      })
      .to(state.morphScale, { v: 1, duration: 0.9, ease: 'elastic.out(1, 0.42)' });
  }

  /* ------------------------------------------------------------------ *
   *  CHROMATICS — ten colour schemes, selectable or auto-cycling
   * ------------------------------------------------------------------ */
  var PALETTES = [
    { name: 'EMBER',       a: '#ff6a14', b: '#ffe7cf', css: '#ff7a18' },
    { name: 'CRYO',        a: '#2ba8ff', b: '#e6fbff', css: '#3db5ff' },
    { name: 'VIRIDIAN',    a: '#19ff8c', b: '#eafff3', css: '#2dff9b' },
    { name: 'ULTRAVIOLET', a: '#9a5cff', b: '#f1e8ff', css: '#a875ff' },
    { name: 'CRIMSON',     a: '#ff2e44', b: '#ffe0dc', css: '#ff4757' },
    { name: 'SOLAR',       a: '#ffb300', b: '#fff6d8', css: '#ffc233' },
    { name: 'NEON ROSE',   a: '#ff2ea0', b: '#ffe3f4', css: '#ff4db3' },
    { name: 'ABYSS AQUA',  a: '#00e0cf', b: '#e0fffb', css: '#19f0de' },
    { name: 'GHOST',       a: '#c9d4e8', b: '#ffffff', css: '#dfe7f5' },
    { name: 'ACID',        a: '#b4ff2b', b: '#f6ffdf', css: '#c3ff4d' }
  ];

  function setPalette(idx, animate) {
    idx = (idx + PALETTES.length) % PALETTES.length;
    state.pal = idx;
    var p = PALETTES[idx];
    var ca = new THREE.Color(p.a), cb = new THREE.Color(p.b);
    var dur = animate ? 1.1 : 0;
    gsap.to(uniforms.uColorA.value, { r: ca.r, g: ca.g, b: ca.b, duration: dur, overwrite: 'auto' });
    gsap.to(uniforms.uColorB.value, { r: cb.r, g: cb.g, b: cb.b, duration: dur, overwrite: 'auto' });
    var acc = new THREE.Color(p.css);
    var root = document.documentElement.style;
    root.setProperty('--accent', p.css);
    root.setProperty('--accent-rgb', ((acc.r * 255) | 0) + ', ' + ((acc.g * 255) | 0) + ', ' + ((acc.b * 255) | 0));
    root.setProperty('--accent-hot', p.b);
    $('#chromaName').textContent = p.name;
    var sws = document.querySelectorAll('#swatchGrid button');
    for (var i = 0; i < sws.length; i++) sws[i].classList.toggle('on', i === idx);
    if (animate) setStatus('CHROMATICS SHIFTED', p.name + ' SPECTRUM ENGAGED');
  }

  /* ------------------------------------------------------------------ *
   *  AUDIO ENGINE — demo synth / file / mic  →  analyser bands
   * ------------------------------------------------------------------ */
  var AC = window.AudioContext || window.webkitAudioContext;
  var audio = {
    ctx: null, analyser: null, master: null, bus: null, comp: null,
    freq: null, wave: null,
    mode: 'demo', playing: false,
    fileEl: null, fileNode: null, fileName: null,
    micStream: null, micNode: null,
    demo: { timer: null, step: 0, nextT: 0, noise: null, pad: [], delay: null, startAt: 0, elapsed: 0 },
    bands: { bass: 0, mid: 0, treble: 0, level: 0, rawBass: 0 },
    sensitivity: 1.2
  };

  function ensureCtx() {
    if (audio.ctx) return;
    audio.ctx = new AC();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = parseFloat($('#volume').value);
    audio.comp = audio.ctx.createDynamicsCompressor();
    audio.bus = audio.ctx.createGain();
    audio.analyser = audio.ctx.createAnalyser();
    audio.analyser.fftSize = 2048;
    audio.analyser.smoothingTimeConstant = 0.62;
    // audible chain: bus -> comp -> master -> out
    // analysis taps PRE-compressor so transients keep their dynamics
    audio.bus.connect(audio.comp);
    audio.comp.connect(audio.master);
    audio.master.connect(audio.ctx.destination);
    audio.bus.connect(audio.analyser);
    audio.freq = new Uint8Array(audio.analyser.frequencyBinCount);
    audio.wave = new Uint8Array(audio.analyser.fftSize);

    // dedicated kick detector: bandpass around the kick fundamental -> RMS
    audio.kickFilter = audio.ctx.createBiquadFilter();
    audio.kickFilter.type = 'bandpass';
    audio.kickFilter.frequency.value = 58;
    audio.kickFilter.Q.value = 1.1;
    audio.beatAnalyser = audio.ctx.createAnalyser();
    audio.beatAnalyser.fftSize = 512;
    audio.beatAnalyser.smoothingTimeConstant = 0;
    audio.bus.connect(audio.kickFilter);
    audio.kickFilter.connect(audio.beatAnalyser);
    audio.beatWave = new Uint8Array(audio.beatAnalyser.fftSize);

    // global echo send (ECHO slider): bus -> send -> delay loop -> output
    audio.echoSend = audio.ctx.createGain();
    audio.echoSend.gain.value = parseFloat($('#echo').value);
    var ed = audio.ctx.createDelay(1); ed.delayTime.value = 0.31;
    var efb = audio.ctx.createGain(); efb.gain.value = 0.42;
    var elp = audio.ctx.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 2600;
    audio.bus.connect(audio.echoSend);
    audio.echoSend.connect(ed);
    ed.connect(efb); efb.connect(elp); elp.connect(ed);
    ed.connect(audio.comp);

    // shared echo for the demo synth
    var dl = audio.ctx.createDelay(1); dl.delayTime.value = 0.29;
    var fb = audio.ctx.createGain(); fb.gain.value = 0.38;
    var lp = audio.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    dl.connect(fb); fb.connect(lp); lp.connect(dl);
    dl.connect(audio.bus);
    audio.demo.delay = dl;

    var len = audio.ctx.sampleRate;
    var buf = audio.ctx.createBuffer(1, len, audio.ctx.sampleRate);
    var dat = buf.getChannelData(0);
    for (var i = 0; i < len; i++) dat[i] = Math.random() * 2 - 1;
    audio.demo.noise = buf;
  }

  /* ----- procedural demo track (A-minor, 116 BPM) — keeps the page
     fully self-contained/offline; original pen streamed an mp3 ----- */
  var BPM = 116, SPB = 60 / BPM, STEP = SPB / 4;

  function dKick(t) {
    var c = audio.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(155, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.16);
    g.gain.setValueAtTime(0.78, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    o.connect(g); g.connect(audio.bus);
    o.start(t); o.stop(t + 0.3);
  }
  function dNoise(t, dur, type, freq, gain) {
    var c = audio.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = audio.demo.noise; s.loop = true;
    f.type = type; f.frequency.value = freq; f.Q.value = 0.9;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(audio.bus);
    s.start(t); s.stop(t + dur + 0.02);
  }
  function dBass(t, f0, dur) {
    var c = audio.ctx, o = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain();
    o.type = 'sawtooth'; o.frequency.value = f0;
    f.type = 'lowpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(420, t);
    f.frequency.exponentialRampToValueAtTime(120, t + dur);
    g.gain.setValueAtTime(0.34, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f); f.connect(g); g.connect(audio.bus);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function dStab(t, notes) {
    var c = audio.ctx;
    for (var i = 0; i < notes.length; i++) {
      var o = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter();
      o.type = 'sawtooth'; o.frequency.value = notes[i] * (i % 2 ? 1.003 : 0.997);
      f.type = 'lowpass'; f.frequency.setValueAtTime(2600, t); f.frequency.exponentialRampToValueAtTime(420, t + 0.30);
      g.gain.setValueAtTime(0.055, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
      o.connect(f); f.connect(g); g.connect(audio.bus); g.connect(audio.demo.delay);
      o.start(t); o.stop(t + 0.4);
    }
  }
  function dPadStart() {
    var c = audio.ctx, lp = c.createBiquadFilter(), g = c.createGain();
    lp.type = 'lowpass'; lp.frequency.value = 460;
    g.gain.value = 0.045;
    var lfo = c.createOscillator(), lg = c.createGain();
    lfo.frequency.value = 0.07; lg.gain.value = 240;
    lfo.connect(lg); lg.connect(lp.frequency); lfo.start();
    [110, 110.6, 164.81].forEach(function (fr) {
      var o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = fr;
      o.connect(lp); o.start();
      audio.demo.pad.push(o);
    });
    lp.connect(g); g.connect(audio.bus);
    audio.demo.pad.push(lfo);
  }
  function dPadStop() {
    audio.demo.pad.forEach(function (o) { try { o.stop(); } catch (e) { /* already stopped */ } });
    audio.demo.pad = [];
  }

  var BASS_PAT = { 0: [55, 2], 3: [55, 1], 6: [65.41, 2], 8: [55, 2], 11: [49, 2], 14: [82.41, 1] };

  function scheduleStep(step, t) {
    var s = step % 16, bar = (step >> 4) % 4;
    if (s === 0 || s === 4 || s === 8 || s === 12) dKick(t);
    if (bar === 3 && s === 14) dKick(t);
    if (s === 4 || s === 12) dNoise(t, 0.16, 'bandpass', 1900, 0.5);
    if (s % 2 === 0 && s !== 10) dNoise(t, 0.045, 'highpass', 7200, 0.22);
    if (s === 10) dNoise(t, 0.22, 'highpass', 6200, 0.27);
    var b = BASS_PAT[s];
    if (b) dBass(t, b[0] * (bar === 2 ? 1.5 : 1), b[1] * STEP * 0.92);
    if (s === 0) dStab(t, bar % 2 ? [174.61, 220, 261.63, 329.63] : [220, 261.63, 329.63, 392]);
  }
  function demoTick() {
    if (!audio.ctx || audio.ctx.state !== 'running') return;
    while (audio.demo.nextT < audio.ctx.currentTime + 0.14) {
      scheduleStep(audio.demo.step, audio.demo.nextT);
      audio.demo.step++;
      audio.demo.nextT += STEP;
    }
  }
  function demoStart() {
    audio.demo.step = 0;
    audio.demo.nextT = audio.ctx.currentTime + 0.06;
    audio.demo.startAt = audio.ctx.currentTime - audio.demo.elapsed;
    dPadStart();
    audio.demo.timer = setInterval(demoTick, 25);
  }
  function demoStop() {
    clearInterval(audio.demo.timer); audio.demo.timer = null;
    dPadStop();
  }

  /* ----- transport / sources ----- */
  function setStatus(main, sub) {
    if (main) $('#statusText').textContent = main;
    if (sub != null) $('#statusSub').textContent = sub;
  }
  function setDots(on) {
    document.querySelectorAll('.dot').forEach(function (d) { d.classList.toggle('idle', !on); });
  }

  function play() {
    ensureCtx();
    audio.ctx.resume();
    if (audio.mode === 'demo') {
      if (!audio.demo.timer) demoStart();
    } else if (audio.mode === 'file' && audio.fileEl) {
      audio.fileEl.play();
    } else if (audio.mode === 'mic') {
      startMic(); return; // async — completes in callback
    }
    audio.playing = true;
    afterTransport();
  }
  function pause() {
    if (audio.mode === 'demo') {
      if (audio.ctx) audio.demo.elapsed = audio.ctx.currentTime - audio.demo.startAt;
      demoStop();
      if (audio.ctx) audio.ctx.suspend();
    } else if (audio.mode === 'file' && audio.fileEl) {
      audio.fileEl.pause();
    } else if (audio.mode === 'mic') {
      stopMic();
    }
    audio.playing = false;
    afterTransport();
  }
  function afterTransport() {
    $('#play').classList.toggle('playing', audio.playing);
    setDots(audio.playing);
    window.__VIZ.playing = audio.playing;
    if (audio.playing) {
      setStatus('SIGNAL LOCKED — ANALYZING', sourceLabel());
      $('#timeState').textContent = 'RUNNING';
    } else {
      setStatus('SIGNAL HOLD', 'TRANSPORT PAUSED');
      $('#timeState').textContent = 'STANDBY';
    }
  }
  function sourceLabel() {
    return audio.mode === 'demo' ? 'INTERNAL SYNTH 116 BPM'
         : audio.mode === 'file' ? (audio.fileName || 'LOCAL FILE')
         : 'LIVE MICROPHONE FEED';
  }

  function switchSource(mode) {
    if (audio.playing) pause();
    if (audio.ctx && audio.ctx.state === 'suspended' && mode !== 'demo') audio.ctx.resume();
    audio.mode = mode;
    ['srcDemo', 'srcFile', 'srcMic'].forEach(function (id) {
      $('#' + id).classList.toggle('on', id.toLowerCase() === 'src' + mode);
    });
    $('#trackName').textContent =
      mode === 'demo' ? 'DEMO SIGNAL 116' :
      mode === 'file' ? (audio.fileName || 'NO FILE — CLICK FILE / DROP') :
      'MICROPHONE';
    setStatus('SOURCE: ' + mode.toUpperCase(), 'PRESS PLAY TO ENGAGE');
  }

  function loadFile(file) {
    if (!file || (file.type && file.type.indexOf('audio') !== 0 && !/\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(file.name))) {
      setStatus('REJECTED — NOT AN AUDIO FILE', file ? file.name.toUpperCase() : '');
      return;
    }
    ensureCtx();
    if (audio.playing) pause();
    if (!audio.fileEl) {
      audio.fileEl = new Audio();
      audio.fileEl.loop = true;
      audio.fileEl.crossOrigin = 'anonymous';
      audio.fileNode = audio.ctx.createMediaElementSource(audio.fileEl);
      audio.fileNode.connect(audio.bus);
    }
    audio.fileEl.src = URL.createObjectURL(file);
    audio.fileName = file.name.toUpperCase();
    switchSource('file');
    audio.ctx.resume();
    play();
  }

  function startMic() {
    ensureCtx();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('MIC UNAVAILABLE', 'SECURE CONTEXT REQUIRED'); return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      audio.micStream = stream;
      audio.micNode = audio.ctx.createMediaStreamSource(stream);
      // analysis only — never routed to the speakers (no feedback loop)
      audio.micNode.connect(audio.analyser);
      audio.micNode.connect(audio.kickFilter);
      audio.playing = true;
      afterTransport();
    }).catch(function () {
      setStatus('MIC ACCESS DENIED', 'FALLING BACK TO DEMO SIGNAL');
      switchSource('demo');
    });
  }
  function stopMic() {
    if (audio.micStream) audio.micStream.getTracks().forEach(function (t) { t.stop(); });
    if (audio.micNode) { try { audio.micNode.disconnect(); } catch (e) { /* noop */ } }
    audio.micStream = audio.micNode = null;
  }

  /* ----- per-frame analysis ----- */
  function bandAvg(a, from, to) {
    var s = 0;
    for (var i = from; i < to; i++) s += a[i];
    return s / ((to - from) * 255);
  }
  var beat = { hist: [], last: 0, intervals: [], bpm: 0, kick: 0, mean: 0 };
  window.__VIZ.beat = beat;

  function updateAudio(now) {
    var b = audio.bands;
    if (audio.analyser && audio.playing && audio.ctx.state === 'running') {
      audio.analyser.getByteFrequencyData(audio.freq);
      audio.analyser.getByteTimeDomainData(audio.wave);
      var sens = audio.sensitivity;
      var rb = clamp(bandAvg(audio.freq, 1, 8)   * 0.85 * sens, 0, 1);
      var rm = clamp(bandAvg(audio.freq, 8, 80)  * 1.05 * sens, 0, 1);
      var rt = clamp(bandAvg(audio.freq, 80, 400) * 1.5 * sens, 0, 1);
      b.bass   = lerp(b.bass,   rb, rb > b.bass   ? 0.55 : 0.085);
      b.mid    = lerp(b.mid,    rm, rm > b.mid    ? 0.55 : 0.085);
      b.treble = lerp(b.treble, rt, rt > b.treble ? 0.55 : 0.085);
      b.level  = clamp(b.bass * 0.5 + b.mid * 0.35 + b.treble * 0.15, 0, 1);
      b.rawBass = rb;

      // beat: RMS spike of the kick-bandpassed signal vs rolling mean
      audio.beatAnalyser.getByteTimeDomainData(audio.beatWave);
      var sum = 0;
      for (var i = 0; i < audio.beatWave.length; i++) {
        var dv = (audio.beatWave[i] - 128) / 128;
        sum += dv * dv;
      }
      var kick = Math.sqrt(sum / audio.beatWave.length) * 2.2 * sens;
      beat.hist.push(kick); if (beat.hist.length > 55) beat.hist.shift();
      var mean = 0;
      for (var j = 0; j < beat.hist.length; j++) mean += beat.hist[j];
      mean /= beat.hist.length || 1;
      beat.kick = kick; beat.mean = mean;
      if (kick > 0.12 && kick > mean * 1.45 && now - beat.last > 0.22) {
        if (beat.last) {
          var iv = now - beat.last;
          if (iv > 0.25 && iv < 2.0) {
            beat.intervals.push(iv); if (beat.intervals.length > 9) beat.intervals.shift();
            var sorted = beat.intervals.slice().sort(function (a, b) { return a - b; });
            beat.bpm = 60 / sorted[(sorted.length / 2) | 0];
          }
        }
        beat.last = now;
        onBeat();
      }
    } else {
      // idle breathing so the orb never looks dead
      b.bass   = lerp(b.bass,   0.09 + 0.07 * Math.sin(now * 1.1), 0.04);
      b.mid    = lerp(b.mid,    0.07 + 0.05 * Math.sin(now * 0.7 + 2), 0.04);
      b.treble = lerp(b.treble, 0.04, 0.05);
      b.level  = lerp(b.level,  0.1, 0.05);
    }
    window.__VIZ.bands = { bass: b.bass, mid: b.mid, treble: b.treble, level: b.level };
  }

  function onBeat() {
    window.__VIZ.beats++;
    gsap.fromTo(uniforms.uPulse, { value: 1 }, { value: 0, duration: 0.55, ease: 'expo.out', overwrite: 'auto' });
    gsap.fromTo(state.popScale, { v: 1.075 }, { v: 1, duration: 0.45, ease: 'power2.out', overwrite: 'auto' });
    flashReticle();
    var p = $('#p-tele');
    p.classList.add('beat');
    setTimeout(function () { p.classList.remove('beat'); }, 130);
  }
  function flashReticle() {
    var r = $('#reticle');
    r.classList.add('flash');
    setTimeout(function () { r.classList.remove('flash'); }, 150);
  }

  /* ------------------------------------------------------------------ *
   *  HUD — spectrum bars, oscilloscope, meters, status rotation
   * ------------------------------------------------------------------ */
  function fitCanvas(c) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var r = c.getBoundingClientRect();
    c.width = Math.max(2, Math.round(r.width * dpr));
    c.height = Math.max(2, Math.round(r.height * dpr));
    return c.getContext('2d');
  }
  var specCtx, scopeCtx, specPeaks = [];

  // canvases pick their colours from the live shader uniforms, so they
  // follow chroma transitions for free
  function rgba(c, a) {
    return 'rgba(' + ((c.r * 255) | 0) + ',' + ((c.g * 255) | 0) + ',' + ((c.b * 255) | 0) + ',' + a + ')';
  }

  function drawSpectrum() {
    var c = $('#spectrum'), ctx = specCtx, W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (!audio.freq) return;
    var N = 36, gap = Math.max(1, W * 0.008), bw = (W - gap * (N - 1)) / N;
    for (var i = 0; i < N; i++) {
      var f0 = Math.floor(2 * Math.pow(240, i / N));
      var f1 = Math.max(f0 + 1, Math.floor(2 * Math.pow(240, (i + 1) / N)));
      var v = audio.playing ? Math.pow(bandAvg(audio.freq, f0, Math.min(f1, 500)), 0.8) : 0.02;
      var h = Math.max(1, v * (H - 6));
      specPeaks[i] = Math.max(h, (specPeaks[i] || 0) - H * 0.012);
      var x = i * (bw + gap);
      ctx.fillStyle = rgba(uniforms.uColorA.value, 0.35 + v * 0.65);
      ctx.fillRect(x, H - h, bw, h);
      ctx.fillStyle = rgba(uniforms.uColorB.value, 0.9);
      ctx.fillRect(x, H - specPeaks[i] - 2, bw, 1.5);
    }
  }
  function drawScope() {
    var c = $('#scope'), ctx = scopeCtx, W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    if (!audio.wave) return;
    ctx.strokeStyle = rgba(uniforms.uColorA.value, 0.95);
    ctx.lineWidth = Math.max(1, H * 0.022);
    ctx.shadowColor = rgba(uniforms.uColorA.value, 0.8); ctx.shadowBlur = 7;
    ctx.beginPath();
    var n = audio.wave.length;
    for (var i = 0; i < n; i += 8) {
      var x = (i / n) * W;
      var y = H / 2 + ((audio.wave[i] - 128) / 128) * (H * 0.46);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s));
    return ('0' + Math.floor(s / 60)).slice(-2) + ':' + ('0' + (s % 60)).slice(-2);
  }
  // VU LED strip + band meters (updated every frame — cheap DOM writes)
  var vuSegs = [];
  (function () {
    var vu = $('#vu');
    for (var i = 0; i < 16; i++) { var s = document.createElement('i'); vu.appendChild(s); vuSegs.push(s); }
  })();
  var barBass = $('#barBass'), barMid = $('#barMid'), barTreble = $('#barTreble');

  var meterTick = 0;
  function drawHud(now) {
    drawSpectrum();
    drawScope();

    var lit = Math.round(audio.bands.level * 16);
    for (var s = 0; s < 16; s++) {
      vuSegs[s].classList.toggle('lit', s < lit && s < 13);
      vuSegs[s].classList.toggle('hot', s < lit && s >= 13);
    }
    barBass.style.width = (audio.bands.bass * 100) + '%';
    barMid.style.width = (audio.bands.mid * 100) + '%';
    barTreble.style.width = (audio.bands.treble * 100) + '%';

    if (now - meterTick < 0.12) return;
    meterTick = now;
    $('#mLevel').textContent = Math.round(audio.bands.level * 100) + '%';
    var pk = 0;
    if (audio.freq && audio.playing) for (var i = 0; i < 500; i++) pk = Math.max(pk, audio.freq[i]);
    $('#mPeak').textContent = pk > 1 ? (20 * Math.log10(pk / 255)).toFixed(1) + ' dB' : '-∞ dB';
    $('#mBpm').textContent = (beat.bpm > 50 && beat.bpm < 200 && audio.playing) ? Math.round(beat.bpm) + ' BPM' : '--- BPM';
    $('#mBeats').textContent = window.__VIZ.beats;
    $('#mFps').textContent = Math.round(state.fps);
    $('#mForm').textContent = SHAPES[state.shape].id;
    var t = 0;
    if (audio.mode === 'demo' && audio.ctx) t = audio.playing ? audio.ctx.currentTime - audio.demo.startAt : audio.demo.elapsed;
    else if (audio.mode === 'file' && audio.fileEl) t = audio.fileEl.currentTime;
    $('#timeCur').textContent = audio.mode === 'mic' ? 'LIVE' : fmtTime(t);
  }

  var STATUS_POOL = [
    ['SIGNAL LOCKED — ANALYZING', null],
    ['HARMONIC TRACE ACTIVE', null],
    ['ANOMALY RESPONSE NOMINAL', null],
    ['FIELD INTEGRITY STABLE', null]
  ];
  setInterval(function () {
    if (!audio.playing) return;
    var pick = STATUS_POOL[(Math.random() * STATUS_POOL.length) | 0];
    setStatus(pick[0], 'RESPONSE ' + Math.round(40 + audio.bands.level * 60) + '% — ' + sourceLabel());
  }, 5200);

  /* ------------------------------------------------------------------ *
   *  INTERACTION — draggable panels (inertia) + grab/fling the orb
   * ------------------------------------------------------------------ */
  Draggable.create('.panel', {
    type: 'x,y',
    bounds: '#app',
    inertia: true,
    edgeResistance: 0.66,
    dragClickables: false,
    cursor: 'grab',
    activeCursor: 'grabbing'
  });

  // orb: raycast grab → rotate → fling with InertiaPlugin
  var ray = new THREE.Raycaster();
  var ndc = new THREE.Vector2();
  var grabSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1.75);
  var drag = { on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0 };

  function pointerNdc(e) {
    ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }
  function overOrb(e) {
    pointerNdc(e);
    ray.setFromCamera(ndc, camera);
    return ray.ray.intersectsSphere(grabSphere);
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (!overOrb(e)) return;
    drag.on = true;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.vx = drag.vy = 0; drag.t = performance.now();
    state.dragging = true;
    if (state.inertiaTween) state.inertiaTween.kill();
    canvas.classList.add('grabbing');
    canvas.setPointerCapture(e.pointerId);
    setStatus('MANUAL OVERRIDE — DIRECT CONTACT', 'RELEASE TO FLING');
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!drag.on) {
      canvas.classList.toggle('grab', overOrb(e));
      return;
    }
    var now = performance.now();
    var dt = Math.max(8, now - drag.t) / 1000;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    state.rot.ry += dx * 0.0062;
    state.rot.rx = clamp(state.rot.rx + dy * 0.0062, -1.45, 1.45);
    // EMA-smoothed angular velocity (rad/s) feeds the inertia throw
    drag.vx = lerp(drag.vx, (dx * 0.0062) / dt, 0.45);
    drag.vy = lerp(drag.vy, (dy * 0.0062) / dt, 0.45);
    drag.x = e.clientX; drag.y = e.clientY; drag.t = now;
  });
  function endDrag(e) {
    if (!drag.on) return;
    drag.on = false;
    canvas.classList.remove('grabbing');
    if (canvas.hasPointerCapture && e.pointerId != null && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    state.inertiaTween = gsap.to(state.rot, {
      inertia: {
        ry: { velocity: drag.vx },
        rx: { velocity: drag.vy, max: 1.45, min: -1.45 },
        resistance: 90
      },
      onComplete: function () { state.dragging = false; state.inertiaTween = null; }
    });
    setStatus('INERTIAL DRIFT', 'GSAP INERTIAPLUGIN DECAY');
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* ------------------------------------------------------------------ *
   *  CONTROLS
   * ------------------------------------------------------------------ */
  function bindSlider(id, fn, fmt) {
    var el = $('#' + id), val = $('#' + id + 'Val');
    var apply = function () {
      var v = parseFloat(el.value);
      var pct = ((v - parseFloat(el.min)) / (parseFloat(el.max) - parseFloat(el.min))) * 100;
      el.style.setProperty('--fill', pct + '%');
      if (fmt && val) val.textContent = fmt(v);
      fn(v);
    };
    el.addEventListener('input', apply);
    apply();
  }
  var f2 = function (v) { return v.toFixed(2); };

  bindSlider('rotation',   function (v) { state.rotation = v; }, f2);
  bindSlider('distortion', function (v) { gsap.to(uniforms.uDistort, { value: v, duration: 0.3, overwrite: 'auto' }); }, f2);
  bindSlider('fracture',   function (v) {
    uniforms.uFracture.value = v;
    coreUniforms.uFracture.value = v * 0.3;
  }, f2);
  bindSlider('reactivity', function (v) { uniforms.uReact.value = v; }, f2);
  bindSlider('sensitivity', function (v) { audio.sensitivity = v; }, f2);
  bindSlider('volume', function (v) {
    if (audio.master) audio.master.gain.value = v;
    $('#volumeVal').textContent = Math.round(v * 100) + '%';
  }, null);
  bindSlider('echo', function (v) {
    if (audio.echoSend) audio.echoSend.gain.value = v;
    $('#echoVal').textContent = Math.round((v / 0.9) * 100) + '%';
  }, null);

  var resTimer = null;
  var booted = false;
  bindSlider('resolution', function (v) {
    state.detail = v;
    if (!booted) return;
    clearTimeout(resTimer);
    resTimer = setTimeout(function () {
      rebuildGeometry();
      setStatus('LATTICE RETESSELLATED', $('#resolutionVal').textContent.replace(' V', ' VERTICES'));
    }, 60);
  }, null);

  $('#play').addEventListener('click', function () { audio.playing ? pause() : play(); });
  $('#play').addEventListener('keydown', function (e) { if (e.key === 'Enter') { audio.playing ? pause() : play(); } });
  $('#srcDemo').addEventListener('click', function () { switchSource('demo'); });
  $('#srcMic').addEventListener('click', function () { switchSource('mic'); play(); });
  $('#srcFile').addEventListener('click', function () {
    if (audio.fileName) switchSource('file'); else $('#fileInput').click();
  });
  $('#srcFile').addEventListener('dblclick', function () { $('#fileInput').click(); });
  $('#fileInput').addEventListener('change', function (e) { loadFile(e.target.files[0]); });

  // drag & drop audio
  var dropDepth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); dropDepth++; $('#drop').classList.add('show'); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function () { if (--dropDepth <= 0) { dropDepth = 0; $('#drop').classList.remove('show'); } });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); dropDepth = 0;
    $('#drop').classList.remove('show');
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  });

  // morphology grid
  (function () {
    var grid = $('#shapeGrid');
    SHAPES.forEach(function (s, i) {
      var b = document.createElement('button');
      b.className = 'btn' + (i === 0 ? ' on' : '');
      b.innerHTML = '<svg viewBox="0 0 16 16"><path d="' + s.glyph + '"/></svg><small>' + s.id + '</small>';
      b.title = s.name;
      b.addEventListener('click', function () { setShape(i); });
      grid.appendChild(b);
    });
  })();

  // chroma swatches + cycle
  (function () {
    var grid = $('#swatchGrid');
    PALETTES.forEach(function (p, i) {
      var b = document.createElement('button');
      b.style.background = 'linear-gradient(135deg, ' + p.a + ', ' + p.b + ')';
      b.title = p.name;
      b.addEventListener('click', function () {
        state.chromaAuto = false;
        $('#chromaCycle').classList.remove('on');
        setPalette(i, true);
      });
      grid.appendChild(b);
    });
  })();
  $('#chromaCycle').addEventListener('click', function () {
    state.chromaAuto = !state.chromaAuto;
    this.classList.toggle('on', state.chromaAuto);
    setStatus(state.chromaAuto ? 'CHROMA CYCLE ENGAGED' : 'CHROMA CYCLE HELD',
      state.chromaAuto ? 'SPECTRUM ROTATION EVERY 8S' : PALETTES[state.pal].name + ' LOCKED');
    if (state.chromaAuto) setPalette(state.pal + 1, true);
  });
  setInterval(function () { if (state.chromaAuto) setPalette(state.pal + 1, true); }, 8000);

  // panel collapse + focus mode
  function setCollapsed(panel, yes) {
    if (panel.__closed === yes) return;
    panel.__closed = yes;
    var body = panel.querySelector('.body');
    panel.querySelector('.fold').textContent = yes ? '+' : '—';
    if (yes) {
      gsap.to(body, { height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0, duration: 0.32, ease: 'power2.inOut' });
    } else {
      gsap.set(body, { clearProps: 'height,opacity,paddingTop,paddingBottom' });
      var h = body.offsetHeight;
      gsap.fromTo(body, { height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0 },
        { height: h, opacity: 1, paddingTop: 12, paddingBottom: 12, duration: 0.32, ease: 'power2.inOut',
          onComplete: function () { gsap.set(body, { clearProps: 'height,opacity,paddingTop,paddingBottom' }); } });
    }
  }
  document.querySelectorAll('.panel').forEach(function (panel) {
    panel.querySelector('.fold').addEventListener('click', function () { setCollapsed(panel, !panel.__closed); });
  });

  function setFocus(on) {
    state.focus = on;
    document.body.classList.toggle('focus', on);
    $('#focusBtn').classList.toggle('on', on);
    ['#p-audio', '#p-params', '#p-tele'].forEach(function (sel) { setCollapsed($(sel), on); });
    gsap.to(camera.position, { z: on ? 5.3 : 6.4, duration: 1.1, ease: 'power2.inOut', overwrite: 'auto' });
    setStatus(on ? 'FOCUS MODE — FULL FIELD' : 'CONSOLE RESTORED',
      on ? 'ANOMALY + MORPHOLOGY ONLY' : 'ALL PANELS ACTIVE');
  }
  $('#focusBtn').addEventListener('click', function () { setFocus(!state.focus); });

  window.addEventListener('keydown', function (e) {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); audio.playing ? pause() : play(); }
    else if (e.key >= '1' && e.key <= '9') setShape(parseInt(e.key, 10) - 1);
    else if (e.key === '0') setShape(9);
    else if (e.key === 'ArrowRight') setShape(state.shape + 1);
    else if (e.key === 'ArrowLeft') setShape(state.shape - 1);
    else if (e.key === 'c' || e.key === 'C') {
      state.chromaAuto = false;
      $('#chromaCycle').classList.remove('on');
      setPalette(state.pal + 1, true);
    }
    else if (e.key === 'f' || e.key === 'F') setFocus(!state.focus);
    else if (e.key === 'r' || e.key === 'R') {
      var next = (state.shape + 1 + ((Math.random() * (SHAPES.length - 1)) | 0)) % SHAPES.length;
      setShape(next);
    }
  });

  /* ------------------------------------------------------------------ *
   *  RESIZE + MAIN LOOP
   * ------------------------------------------------------------------ */
  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    uniforms.uPx.value = dpr;
    specCtx = fitCanvas($('#spectrum'));
    scopeCtx = fitCanvas($('#scope'));
  }
  window.addEventListener('resize', resize);

  var clock = new THREE.Clock();

  function loop() {
    requestAnimationFrame(loop);
    var dt = Math.min(clock.getDelta(), 0.05);
    var now = clock.elapsedTime;
    state.fps = lerp(state.fps, 1 / Math.max(dt, 0.001), 0.06);

    updateAudio(now);
    var b = audio.bands;

    uniforms.uTime.value = now;
    uniforms.uBass.value = b.bass;
    uniforms.uMid.value = b.mid;
    uniforms.uTreble.value = b.treble;
    uniforms.uLevel.value = b.level;

    if (!state.dragging) state.rot.ry += dt * state.rotation * (0.5 + b.level * 0.9);
    spinGroup.rotation.set(state.rot.rx, state.rot.ry, 0);
    var sc = state.morphScale.v * state.popScale.v;
    spinGroup.scale.setScalar(sc);
    haloMesh.scale.setScalar(Math.max(sc, 0.35));

    particles.rotation.y += dt * (0.018 + b.level * 0.05);
    particles.rotation.x = Math.sin(now * 0.05) * 0.06;

    camera.position.x = Math.sin(now * 0.16) * 0.12 + b.bass * 0.075 * Math.sin(now * 9) + uniforms.uPulse.value * 0.03 * Math.sin(now * 31);
    camera.position.y = Math.cos(now * 0.13) * 0.1 + uniforms.uPulse.value * 0.025 * Math.cos(now * 27);
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
    drawHud(now);
  }

  setPalette(0, false);
  rebuildGeometry();
  resize();
  loop();
  booted = true;
  window.__VIZ.ready = true;
  setStatus('BOOT SEQUENCE COMPLETE', 'AWAITING SIGNAL — PRESS PLAY OR [SPACE]');
})();
