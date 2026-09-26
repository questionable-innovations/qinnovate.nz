// Kessler: low Earth orbit after the cascade.
// Tens of thousands of debris points propagated on the GPU from orbital
// elements (mean motion ∝ a^-1.5), a planet that is only negative space
// (an occluding sphere, a hairline limb, and the hole its shadow cuts in
// the swarm), a few dim orbit rules, and one sodium-coloured tracked object.

import { m4, rng, vao, type M4, type Setup } from '$lib/stage';

export const GROUND = '#0e1117';

const C_GROUND = [14 / 255, 17 / 255, 23 / 255];
const C_LIGHT = [0.914, 0.918, 0.945];
const C_RULE = [0.412, 0.431, 0.51];
const C_SODIUM = [0.851, 0.647, 0.357];
const C_RED = [0.92, 0.22, 0.2];

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
/** mean motion at a = 1 Earth radius, rad/s (period ~90 s at the surface) */
const K = TAU / 90;
/** background objects were "born" long ago: no flash, no expansion */
const OLD = -1000;
/** floats per particle: a e inc raan | argp M0 bright birth | da dinc draan dM | dN */
const STRIDE = 13;
const EVENT_SLOTS = 6;
const EVENT_N = 1400;
const PICKABLE = 3000;

// camera
const YAW0 = 0.55;
const PITCH0 = -0.26;
const DIST = 4.6;
const DRIFT = 0.011; // rad/s idle camera drift

// ---------------------------------------------------------------- shaders

const ORBIT = /* glsl */ `
vec3 orbitE(float a, float e, float inc, float raan, float argp, float E) {
	float x = a * (cos(E) - e);
	float y = a * sqrt(1.0 - e * e) * sin(E);
	float ca = cos(argp), sa = sin(argp);
	vec2 q = vec2(ca * x - sa * y, sa * x + ca * y);
	float ci = cos(inc), si = sin(inc), cO = cos(raan), sO = sin(raan);
	vec3 p = vec3(q.x, q.y * ci, q.y * si);
	return vec3(cO * p.x - sO * p.y, p.z, sO * p.x + cO * p.y);
}
float kepler(float M, float e) {
	float E = M + e * sin(M);
	E = M + e * sin(E);
	E = E - (E - e * sin(E) - M) / (1.0 - e * cos(E));
	return E;
}
vec3 orbitM(float a, float e, float inc, float raan, float argp, float M) {
	return orbitE(a, e, inc, raan, argp, kepler(mod(M, 6.2831853), e));
}
`;

const DEBRIS_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aEl;   // a e inc raan
layout(location = 1) in vec4 aEl2;  // argp M0 bright birth
layout(location = 2) in vec4 aDel;  // da dinc draan dM  (fragment dispersion)
layout(location = 3) in float aDN;  // extra mean motion (shear)
uniform mat4 uVP;
uniform vec3 uEye;
uniform vec3 uSun;
uniform float uT;
uniform float uK;
uniform float uPx;
uniform float uDist;
uniform float uGain;
uniform float uIntro; // seconds since load; large once settled
uniform float uPickMin; // pick pass: minimum point size so small dots are easy to hit
uniform vec4 uInf;      // xyz: where the infection started, w: how far it has reached (0 = none)
out float vA;
out float vSod;
out float vRed;
flat out float vId;
${ORBIT}
float hash1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
	float age = uT - aEl2.w;
	vId = float(gl_VertexID);
	vSod = 0.0;
	vRed = 0.0;
	if (age < 0.0) {
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
		gl_PointSize = 0.0;
		vA = 0.0;
		return;
	}
	float ex = 1.0 - exp(-age * 1.3);
	float a0 = aEl.x + aDel.x;
	float n = uK * pow(a0, -1.5) + aDN;
	// intro: inner shells first, each object sweeping forward into its slot
	float delay = 0.25 + 1.5 * clamp((aEl.x - 1.0) / 1.7, 0.0, 1.0) + 0.9 * hash1(float(gl_VertexID));
	float appear = smoothstep(delay, delay + 1.1, uIntro);
	float M = aEl2.y + aDel.w * ex + n * age - (1.0 - appear) * (1.0 - appear) * 1.1;
	vec3 p = orbitM(aEl.x + aDel.x * ex, aEl.y, aEl.z + aDel.y * ex, aEl.w + aDel.z * ex, aEl2.x, M);
	gl_Position = uVP * vec4(p, 1.0);

	// Earth's shadow: a cylinder behind the planet, away from the sun
	float sl = dot(p, uSun);
	float rp = length(p - sl * uSun);
	float lit = max(step(0.0, sl), smoothstep(0.985, 1.05, rp));

	float d = length(uEye - p);
	float near = clamp(uDist / d, 0.55, 1.8);
	float side = dot(p, normalize(uEye)); // > 0: on the camera's side of the planet
	// brightness above 9 flags amber shards (what is left of the tracked object)
	float b = aEl2.z;
	vSod = step(9.0, b);
	b -= vSod * 10.0;
	float flash = exp(-age * 2.2);

	// the infection: each dot turns once the wave reaches it, a little early or late so it spreads
	// like a contagion rather than a sphere, flaring as it goes and glowing a touch after
	if (uInf.w > 0.0) {
		float lag = uInf.w - length(p - uInf.xyz) - 0.45 * hash1(float(gl_VertexID) * 1.7 + 3.1);
		vRed = step(0.0, lag);
		b = mix(b, max(b, 0.5), vRed) * (1.0 + 2.5 * vRed * exp(-lag * 7.0));
		lit = mix(lit, max(lit, 0.5), vRed);
	}

	float alpha = b * mix(0.07, 1.0, lit) * mix(0.45, 1.0, smoothstep(-1.1, 0.9, side)) * near;
	// a new cloud fades in as it opens up, so the burst never reads as a blob
	alpha *= mix(0.03, 1.0, clamp(age / 14.0, 0.0, 1.0)) * (1.0 + 1.5 * flash)
		// the hot shards flare the moment it happens, so a tap answers at once
		+ step(0.7, b) * step(age, 60.0) * 1.4 * exp(-age * 1.2);
	alpha *= appear * (1.0 + 2.0 * appear * (1.0 - appear));
	float s = (0.8 + 1.0 * b) * uPx * pow(near, 0.7);
	float sc = max(s, 1.6);
	alpha *= (s * s) / (sc * sc);
	gl_PointSize = max(sc + 1.0, uPickMin);
	vA = alpha * uGain;
}`;

const DEBRIS_FS = /* glsl */ `#version 300 es
precision highp float;
in float vA;
in float vSod;
in float vRed;
uniform vec3 uColor;
uniform vec3 uSodium;
uniform vec3 uRed;
out vec4 o;
void main() {
	float r = length(gl_PointCoord * 2.0 - 1.0);
	float m = 1.0 - smoothstep(0.3, 1.0, r);
	o = vec4(mix(mix(uColor, uSodium, vSod), uRed, vRed), vA * m);
}`;

// pick pass: each visible dot writes its index (+1) as a colour
const PICK_FS = /* glsl */ `#version 300 es
precision highp float;
in float vA;
flat in float vId;
out vec4 o;
void main() {
	if (vA < 0.03 || length(gl_PointCoord * 2.0 - 1.0) > 1.0) discard;
	float id = vId + 1.0;
	o = vec4(mod(id, 256.0), mod(floor(id / 256.0), 256.0), floor(id / 65536.0), 255.0) / 255.0;
}`;

const LINE_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in float aU;
uniform mat4 uVP;
uniform vec3 uEye;
uniform vec4 uEl;     // a e inc raan
uniform float uArgp;
uniform float uMode;  // 0 = full loop, 1 = trail behind uM
uniform float uM;
uniform float uLen;
uniform float uAlpha;
out float vA;
${ORBIT}
void main() {
	vec3 p;
	float fade = 1.0;
	if (uMode < 0.5) {
		p = orbitE(uEl.x, uEl.y, uEl.z, uEl.w, uArgp, aU * 6.2831853);
	} else {
		p = orbitM(uEl.x, uEl.y, uEl.z, uEl.w, uArgp, uM - aU * uLen);
		fade = pow(1.0 - aU, 1.7);
	}
	gl_Position = uVP * vec4(p, 1.0);
	float side = dot(p, normalize(uEye));
	vA = uAlpha * fade * mix(0.4, 1.0, smoothstep(-1.6, 1.0, side));
}`;

const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
in float vA;
uniform vec3 uColor;
out vec4 o;
void main() { o = vec4(uColor, vA); }`;

const MARK_VS = /* glsl */ `#version 300 es
precision highp float;
uniform mat4 uVP;
uniform vec3 uPos;
uniform float uSize;
void main() {
	gl_Position = uVP * vec4(uPos, 1.0);
	gl_PointSize = uSize;
}`;

const MARK_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uSize;
uniform float uRing;  // 0 = dot, 1 = hairline ring
uniform float uLineW;
out vec4 o;
void main() {
	float d = length(gl_PointCoord - 0.5) * uSize;
	float a;
	if (uRing > 0.5) {
		float R = uSize * 0.5 - 1.5;
		a = 1.0 - smoothstep(uLineW * 0.5, uLineW * 0.5 + 0.9, abs(d - R));
	} else {
		a = 1.0 - smoothstep(uSize * 0.5 - 1.2, uSize * 0.5, d);
	}
	o = vec4(uColor, a * uAlpha);
}`;

const PLANET_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aP;
void main() { gl_Position = vec4(aP, 0.0, 1.0); }`;

const PLANET_FS = /* glsl */ `#version 300 es
precision highp float;
uniform mat4 uInv;
uniform mat4 uVP;
uniform vec3 uEye;
uniform vec3 uSun;
uniform vec2 uRes;
uniform float uPxW;   // world units per device pixel at the limb
uniform float uLineW; // limb width, device px
uniform vec3 uGround;
uniform vec3 uLight;
uniform vec3 uReveal; // xy: planet centre (device px), z: 0..1 of the limb drawn
uniform float uStart; // screen angle the limb starts drawing from (the sunward side)
out vec4 o;
void main() {
	vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
	vec4 f = uInv * vec4(ndc, 1.0, 1.0);
	vec3 rd = normalize(f.xyz / f.w - uEye);
	float b = dot(uEye, rd);
	float c = dot(uEye, uEye) - 1.0;
	float h = b * b - c;
	float dmin = sqrt(max(dot(uEye, uEye) - b * b, 0.0));
	vec3 cp = uEye - rd * b;
	float px = (dmin - 1.0) / uPxW;              // signed device px from the limb

	float sunward = dot(normalize(cp), uSun);
	float lit = smoothstep(-0.35, 0.75, sunward);
	float ring = 1.0 - smoothstep(uLineW * 0.5, uLineW * 0.5 + 1.0, abs(px));
	float ang = atan(gl_FragCoord.y - uReveal.y, gl_FragCoord.x - uReveal.x);
	float sweep = fract((ang - uStart) / 6.2831853 + 1.0);
	float drawn = uReveal.z >= 1.0 ? 1.0 : 1.0 - smoothstep(uReveal.z - 0.015, uReveal.z, sweep);
	float tone = ring * mix(0.1, 0.68, lit) * drawn;
	// the faintest breath of atmosphere just inside the lit limb
	float air = h > 0.0 ? exp(px / (5.0 * uLineW)) * lit * lit * 0.05 : 0.0;
	vec3 col = uGround + (uLight - uGround) * (tone + air * drawn);

	if (h > 0.0) {
		vec3 hit = uEye + rd * (-b - sqrt(h));
		// the day side is a shade off the ground, just enough to feel like a body
		float day = max(dot(normalize(hit), uSun), 0.0);
		col += (uLight - uGround) * 0.022 * day * day * uReveal.z;
		vec4 cc = uVP * vec4(hit, 1.0);
		gl_FragDepth = cc.z / cc.w * 0.5 + 0.5;
		o = vec4(col, 1.0);
	} else {
		if (tone < 0.002) discard;
		gl_FragDepth = 1.0;
		o = vec4(col, 1.0);
	}
}`;

// ---------------------------------------------------------------- orbital helpers (CPU mirror)

type El = { a: number; e: number; inc: number; raan: number; argp: number };

function kepler(M: number, e: number) {
	let E = M + e * Math.sin(M);
	E = M + e * Math.sin(E);
	return E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
}

function orbitE(a: number, e: number, inc: number, raan: number, argp: number, E: number, out: number[]) {
	const x = a * (Math.cos(E) - e);
	const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
	const ca = Math.cos(argp), sa = Math.sin(argp);
	const qx = ca * x - sa * y, qy = sa * x + ca * y;
	const ci = Math.cos(inc), si = Math.sin(inc), cO = Math.cos(raan), sO = Math.sin(raan);
	const px = qx, py = qy * ci, pz = qy * si;
	out[0] = cO * px - sO * py;
	out[1] = pz;
	out[2] = sO * px + cO * py;
	return out;
}

const wrap = (M: number) => ((M % TAU) + TAU) % TAU;

function project(m: M4, p: number[]): [number, number, number, number] {
	const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
	const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
	const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
	const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
	return [x / w, y / w, z / w, w];
}

/** is p hidden behind the unit sphere as seen from eye? */
function occluded(eye: number[], p: number[]) {
	let dx = p[0] - eye[0], dy = p[1] - eye[1], dz = p[2] - eye[2];
	const L = Math.hypot(dx, dy, dz);
	dx /= L; dy /= L; dz /= L;
	const b = eye[0] * dx + eye[1] * dy + eye[2] * dz;
	const c = eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2] - 1;
	const h = b * b - c;
	if (h <= 0) return false;
	const t0 = -b - Math.sqrt(h);
	return t0 > 0 && t0 < L;
}

function invert(m: M4): M4 {
	const o = new Float32Array(16);
	const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
	const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
	const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
	const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
	const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
	const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
	o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
	o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
	o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
	o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
	o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
	o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
	o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
	o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
	o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
	o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
	o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
	o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
	o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
	o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
	o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
	o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
	return o;
}

// ---------------------------------------------------------------- camera

type Cam = { eye: number[]; vp: M4; inv: M4; tanHalf: number; dist: number };

// ---- 3x3 rotations (column-major) for a free trackball: no fixed up, so it rolls over the poles
type R3 = number[];
const r3 = {
	y: (a: number): R3 => [Math.cos(a), 0, -Math.sin(a), 0, 1, 0, Math.sin(a), 0, Math.cos(a)],
	x: (a: number): R3 => [1, 0, 0, 0, Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a)],
	mul: (a: R3, b: R3): R3 => {
		const o = new Array(9);
		for (let c = 0; c < 3; c++)
			for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
		return o;
	},
	/** re-orthonormalise after many small multiplications */
	fix: (m: R3): R3 => {
		const x = [m[0], m[1], m[2]], y = [m[3], m[4], m[5]];
		const n = (v: number[]) => {
			const l = Math.hypot(v[0], v[1], v[2]) || 1;
			return v.map((c) => c / l);
		};
		const X = n(x);
		const d = X[0] * y[0] + X[1] * y[1] + X[2] * y[2];
		const Y = n([y[0] - d * X[0], y[1] - d * X[1], y[2] - d * X[2]]);
		const Z = [X[1] * Y[2] - X[2] * Y[1], X[2] * Y[0] - X[0] * Y[2], X[0] * Y[1] - X[1] * Y[0]];
		return [...X, ...Y, ...Z];
	}
};
/** the resting view: yaw about the world axis, then pitch */
const base = (yaw: number, pitch: number) => r3.mul(r3.y(yaw), r3.x(-pitch));

function camera(rot: R3, aspect: number, zoom = 1): Cam {
	// narrow screens: keep roughly the same horizontal share for the planet by
	// widening the lens a little and stepping back the rest of the way
	const need = aspect < 1.2 ? Math.max(1, 0.31 / aspect / Math.tan(19 * DEG)) : 1;
	const lens = Math.pow(need, 0.45);
	const dist = DIST * (need / lens) * zoom;
	const tanHalf = Math.tan(19 * DEG) * lens;
	// camera sits on its local +z, looking at the planet, with its own up
	const eye = [rot[6] * dist, rot[7] * dist, rot[8] * dist];
	const view = m4.lookAt(eye, [0, 0, 0], [rot[3], rot[4], rot[5]]);
	const proj = m4.perspective(2 * Math.atan(tanHalf), aspect, 0.05, 60);
	// off-axis shift: planet sits lower-left, debris sweeps across the frame
	const shift = m4.identity();
	shift[12] = aspect < 1 ? -0.3 : -0.46;
	shift[13] = aspect < 1 ? -0.26 : -0.44;
	const vp = m4.mul(shift, m4.mul(proj, view));
	return { eye, vp, inv: invert(vp), tanHalf, dist };
}

// ---------------------------------------------------------------- the swarm

function gauss(r: () => number) {
	return Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(TAU * r());
}

function sunDir(): number[] {
	// fixed in the world; chosen relative to the opening camera so the lit
	// limb reads on the left and the shadow cuts through the debris to the right
	const eye = [Math.cos(PITCH0) * Math.sin(YAW0), Math.sin(PITCH0), Math.cos(PITCH0) * Math.cos(YAW0)];
	const f = [-eye[0], -eye[1], -eye[2]];
	const r = [-f[2], 0, f[0]]; // camera right = f × up
	const rl = Math.hypot(r[0], r[2]);
	r[0] /= rl; r[2] /= rl;
	const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
	const s = [0, 1, 2].map((i) => -0.82 * r[i] + 0.3 * u[i] + 0.3 * f[i]);
	const l = Math.hypot(s[0], s[1], s[2]);
	return s.map((v) => v / l);
}

// display altitudes (Earth radii), exaggerated ~2.5x so the shells separate at the limb
const SHELLS = [0.1, 0.125, 0.185, 0.215, 0.31, 0.36, 0.47];

/** `keep` thins the background at generation time (small screens draw fewer dots) */
function build(sun: number[], keep: number) {
	const r = rng(0x6b657373);
	const thin = rng(0x7468696e);
	const g = () => gauss(r);
	let out = new Float32Array(150000 * STRIDE);
	let n = 0;
	const push = (
		a: number, e: number, inc: number, raan: number, argp: number, M0: number, b: number,
		birth = OLD, da = 0, dinc = 0, draan = 0, dM = 0, dN = 0, always = false
	) => {
		if (!always && keep < 1 && thin() > keep) return;
		if (n + STRIDE > out.length) {
			const grown = new Float32Array(out.length * 2);
			grown.set(out);
			out = grown;
		}
		const o = out;
		o[n] = a; o[n + 1] = e; o[n + 2] = inc; o[n + 3] = raan; o[n + 4] = argp; o[n + 5] = M0; o[n + 6] = b;
		o[n + 7] = birth; o[n + 8] = da; o[n + 9] = dinc; o[n + 10] = draan; o[n + 11] = dM; o[n + 12] = dN;
		n += STRIDE;
	};
	const bright = (p = 4) => 0.14 + 0.86 * Math.pow(r(), p * 1.5);
	const sunAz = Math.atan2(sun[2], sun[0]);

	// LEO debris lives in families: every breakup leaves its pieces sharing a
	// plane, so the swarm is woven from hundreds of dotted orbits (full rings
	// when old, arcs when young) over a thin haze of strays.
	const orbitFamily = () => {
		const h = r() < 0.75 ? SHELLS[Math.floor(r() * SHELLS.length)] + 0.004 * g() : 0.08 + 0.45 * Math.pow(r(), 1.6);
		const a = 1 + h;
		const band = r();
		let inc: number;
		let raan = r() * TAU;
		if (band < 0.34) {
			inc = (98.2 + 0.7 * g()) * DEG; // sun-synchronous, planes locked to local time
			const lt = r() < 0.55 ? (r() < 0.5 ? 6 : 18) : r() < 0.6 ? 10.5 : 13.5;
			raan = sunAz + (lt - 12 + 1.2 * g()) * 15 * DEG;
		} else if (band < 0.48) inc = (53 + 0.4 * g()) * DEG;
		else if (band < 0.62) inc = (71 + 4 * g()) * DEG;
		else if (band < 0.72) inc = (86.4 + 1.2 * g()) * DEG;
		else if (band < 0.86) inc = (28 + 25 * r()) * DEG;
		else inc = r() * 110 * DEG;
		const e = Math.min(r() * r() * r() * 0.02, (a - 1.06) / a);
		return { a, e, inc, raan, argp: r() * TAU };
	};
	const HAZE = 4500;
	for (let i = 0; i < HAZE; i++) {
		const f = orbitFamily();
		push(f.a, f.e, f.inc, f.raan, f.argp, r() * TAU, bright());
	}
	const FAMILIES = 320;
	for (let k = 0; k < FAMILIES; k++) {
		const f = orbitFamily();
		const n = Math.round(60 + 440 * Math.pow(r(), 2.2));
		const ring = r() < 0.45;
		const span = ring ? TAU : 0.5 + 4.5 * r() * r();
		const centre = r() * TAU;
		const fb = 0.6 + 0.5 * r();
		for (let i = 0; i < n; i++) {
			const u = ring ? r() : (r() + r() + r()) / 3; // arcs taper at the ends
			push(
				f.a + 0.0025 * g(), f.e, f.inc + 0.0015 * g(), f.raan + 0.0015 * g(), f.argp,
				centre + span * (u - 0.5), bright() * fb
			);
		}
	}

	// a mega-constellation shell: the order that fed the chaos
	const P = 44, S = 46;
	for (let p = 0; p < P; p++)
		for (let s = 0; s < S; s++) {
			if (r() < 0.12) continue;
			push(1.125 + 0.0008 * g(), 0.0002, 53 * DEG, (p / P) * TAU, 0, TAU * (s / S + (p * 17) / (P * S)) + 0.004 * g(), bright(5) * 0.85);
		}
	// a polar shell, fewer planes
	for (let p = 0; p < 9; p++)
		for (let s = 0; s < 44; s++) push(1.215, 0.0002, 97.6 * DEG, sunAz + (p / 9) * Math.PI, 0, TAU * (s / 44 + p * 0.011) + 0.003 * g(), bright(5) * 0.8);

	// medium orbit navigation shells (compressed radius)
	for (let p = 0; p < 6; p++)
		for (let s = 0; s < 340; s++) push(2.0 + 0.006 * g() + (p % 2) * 0.07, 0.002 * r(), (55 + 0.25 * g() + (p % 3) * 2) * DEG, (p / 6) * TAU + 0.3, r() * TAU, r() * TAU, bright(3) * 0.75);

	// Molniya loops
	for (let p = 0; p < 4; p++)
		for (let s = 0; s < 110; s++) push(2.1 + 0.01 * g(), 0.44 + 0.01 * g(), (63.4 + 0.4 * g()) * DEG, (p / 4) * TAU + 1.1, 270 * DEG + 0.02 * g(), r() * TAU, bright(3) * 0.8);

	// transfer-orbit rocket bodies
	for (let i = 0; i < 320; i++) push(1.85 + 0.12 * g(), 0.42 + 0.03 * g(), (4 + 24 * r()) * DEG, r() * TAU, r() * TAU, r() * TAU, bright(3) * 0.8);

	// geostationary belt: clustered longitudes, a graveyard just above
	const lons = [0.4, 1.9, 3.1, 4.6, 5.5];
	for (let i = 0; i < 7000; i++) {
		const graveyard = r() < 0.18;
		const drift = r() < 0.2;
		const lon = r() < 0.7 ? lons[Math.floor(r() * lons.length)] + 0.28 * g() : r() * TAU;
		push(
			2.62 + (graveyard ? 0.05 : 0) + 0.003 * g(),
			0.0005,
			(drift ? 3 + 11 * r() : Math.abs(g()) * 0.25) * DEG,
			r() * TAU,
			0,
			lon,
			bright(3) * 0.85
		);
	}

	// fragmentation clouds of various ages: a young streak, older arcs, near-rings
	const cloud = (n: number, el: El, M: number, age: number, spread: number, dnSpread: number, b = 0.85) => {
		for (let i = 0; i < n; i++)
			push(
				el.a, Math.min(0.05, el.e + Math.abs(0.004 * g())), el.inc, el.raan, el.argp, M, bright(4) * b,
				-age, spread * g(), spread * 0.8 * g(), spread * 0.8 * g(), spread * 1.4 * g(), dnSpread * g()
			);
	};
	cloud(3200, { a: 1.36, e: 0.002, inc: 98.8 * DEG, raan: sunAz - 1.2, argp: 0 }, 0.5, 900, 0.012, 0.0035);
	cloud(1600, { a: 1.31, e: 0.001, inc: 74 * DEG, raan: 2.2, argp: 0 }, 1.0, 320, 0.009, 0.004);
	cloud(1400, { a: 1.31, e: 0.001, inc: 86.4 * DEG, raan: 4.1, argp: 0 }, 2.5, 260, 0.009, 0.004);
	cloud(1200, { a: 1.47, e: 0.004, inc: 65 * DEG, raan: 5.0, argp: 1 }, 4.0, 110, 0.01, 0.006);
	cloud(1100, YOUNG, YOUNG_M, 38, 0.008, 0.01, 1);

	const staticCount = n / STRIDE;
	for (let i = staticCount - 1; i > 0; i--) {
		const j = Math.floor(r() * (i + 1));
		for (let k = 0; k < STRIDE; k++) {
			const t = out[i * STRIDE + k];
			out[i * STRIDE + k] = out[j * STRIDE + k];
			out[j * STRIDE + k] = t;
		}
	}
	// event slots start unborn
	for (let i = 0; i < EVENT_SLOTS * EVENT_N; i++) push(1.1, 0, 0, 0, 0, 0, 0, 1e9, 0, 0, 0, 0, 0, true);
	return { data: out.slice(0, n), staticCount };
}

const YOUNG: El = { a: 1.185, e: 0.001, inc: 53.6 * DEG, raan: 0.2, argp: 0 };
const YOUNG_M = 2.2;

// ---------------------------------------------------------------- piece

export type KesslerHooks = {
	/** every frame: the tracked object in CSS px, and how visible it is (0..1) */
	track?: (x: number, y: number, visible: number) => void;
	/** someone shot down the tracked object */
	qi?: () => void;
	/** someone tapped one of the red dots that rise out of their wreckage */
	rick?: () => void;
	/** fired once when the opening sequence has settled */
	settled?: () => void;
};

/** opening sequence length, seconds */
export const INTRO = 4.2;

const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const ramp = (t: number, a: number, b: number) => Math.min(1, Math.max(0, (t - a) / (b - a)));

export const setup: Setup = (ctx) => createKessler()(ctx);

export const createKessler = (hooks: KesslerHooks = {}): Setup => (ctx) => {
	const { gl } = ctx;
	const sun = sunDir();
	// small screens: fewer dots from the start; slow frames thin further (share)
	const keep = ctx.coarse || Math.min(innerWidth, innerHeight) < 600 ? 0.55 : 1;
	const { data, staticCount } = build(sun, keep);
	// a random sample of long-lived LEO objects can be hovered and tapped
	const pickable: number[] = [];
	for (let i = 0; i < staticCount && pickable.length < PICKABLE; i++)
		if (data[i * STRIDE] < 1.6 && data[i * STRIDE + 7] === OLD) pickable.push(i);
	const total = data.length / STRIDE;

	// quality: share of the background swarm drawn, stepped down if frames run long
	let share = 1;
	let tier = 0;
	let perfT = 0, perfN = 0;

	// debris buffer (interleaved, event slots rewritten in place)
	const dvao = gl.createVertexArray()!;
	const dbuf = gl.createBuffer()!;
	gl.bindVertexArray(dvao);
	gl.bindBuffer(gl.ARRAY_BUFFER, dbuf);
	gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
	const layout: [number, number, number][] = [[0, 4, 0], [1, 4, 4], [2, 4, 8], [3, 1, 12]];
	for (const [loc, size, off] of layout) {
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4);
	}
	gl.bindVertexArray(null);

	const LOOP_N = 720, TRAIL_N = 90;
	const loopVao = vao(gl, { 0: [Float32Array.from({ length: LOOP_N }, (_, i) => i / LOOP_N), 1] });
	const trailVao = vao(gl, { 0: [Float32Array.from({ length: TRAIL_N }, (_, i) => i / (TRAIL_N - 1)), 1] });
	const triVao = vao(gl, { 0: [new Float32Array([-1, -1, 3, -1, -1, 3]), 2] });
	const markVao = gl.createVertexArray()!;

	const pDebris = ctx.program(DEBRIS_VS, DEBRIS_FS);
	const pPick = ctx.program(DEBRIS_VS, PICK_FS);
	const pLine = ctx.program(LINE_VS, LINE_FS);
	const pMark = ctx.program(MARK_VS, MARK_FS);
	const pPlanet = ctx.program(PLANET_VS, PLANET_FS);
	const U = (p: WebGLProgram, names: string[]) =>
		Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)])) as Record<string, WebGLUniformLocation | null>;
	const DEBRIS_U = ['uVP', 'uEye', 'uSun', 'uT', 'uK', 'uPx', 'uDist', 'uGain', 'uColor', 'uSodium', 'uRed', 'uIntro', 'uPickMin', 'uInf'];
	const uD = U(pDebris, DEBRIS_U);
	const uK = U(pPick, DEBRIS_U);
	const uL = U(pLine, ['uVP', 'uEye', 'uEl', 'uArgp', 'uMode', 'uM', 'uLen', 'uAlpha', 'uColor']);
	const uM = U(pMark, ['uVP', 'uPos', 'uSize', 'uColor', 'uAlpha', 'uRing', 'uLineW']);
	const uP = U(pPlanet, ['uInv', 'uVP', 'uEye', 'uSun', 'uRes', 'uPxW', 'uLineW', 'uGround', 'uLight', 'uReveal', 'uStart']);

	const nOf = (a: number) => K * Math.pow(a, -1.5);

	// the tracked object and the dim rules
	const TRACK: El = { a: 1.62, e: 0.035, inc: 41 * DEG, raan: 2.75, argp: 0.9 };
	const rules: { el: El; alpha: number }[] = [
		{ el: TRACK, alpha: 0.34 },
		{ el: { a: 2.62, e: 0, inc: 0, raan: 0, argp: 0 }, alpha: 0.26 },
		{ el: { a: 2.1, e: 0.44, inc: 63.4 * DEG, raan: 1.1 + Math.PI / 2, argp: 270 * DEG }, alpha: 0.22 },
		{ el: YOUNG, alpha: 0.2 },
		{ el: { a: 1.36, e: 0.002, inc: 98.8 * DEG, raan: Math.atan2(sun[2], sun[0]) - 1.2, argp: 0 }, alpha: 0.16 }
	];
	// place the tracked object on the near side, up and to the right, at t = 0
	let trackM0 = 0;
	{
		const cam = camera(base(YAW0, PITCH0), 1.6);
		let best = 1e9;
		const p = [0, 0, 0];
		for (let i = 0; i < 360; i++) {
			const M = (i / 360) * TAU;
			orbitE(TRACK.a, TRACK.e, TRACK.inc, TRACK.raan, TRACK.argp, kepler(M, TRACK.e), p);
			const [x, y] = project(cam.vp, p);
			const d = Math.hypot(x - 0.05, y - 0.12) + (occluded(cam.eye, p) ? 9 : 0);
			if (d < best) (best = d), (trackM0 = M);
		}
	}

	// ---- picking + fragmentation events
	const tmp = [0, 0, 0];
	/** effective elements + mean anomaly of particle i at time t, mirroring the vertex shader */
	const stateOf = (i: number, t: number): { el: El; M: number } => {
		const o = i * STRIDE;
		const age = t - data[o + 7];
		const ex = 1 - Math.exp(-age * 1.3);
		const n = nOf(data[o] + data[o + 8]) + data[o + 12];
		return {
			el: {
				a: data[o] + data[o + 8] * ex,
				e: data[o + 1],
				inc: data[o + 2] + data[o + 9] * ex,
				raan: data[o + 3] + data[o + 10] * ex,
				argp: data[o + 4]
			},
			M: wrap(data[o + 5] + data[o + 11] * ex + n * age)
		};
	};
	const posOf = (i: number, t: number, out: number[]) => {
		const { el, M } = stateOf(i, t);
		return orbitE(el.a, el.e, el.inc, el.raan, el.argp, kepler(M, el.e), out);
	};
	const alive = (i: number) => data[i * STRIDE + 6] !== 0;
	/** CSS px between an NDC point and a world position; Infinity if behind the camera */
	const pxTo = (x: number, y: number, p: number[]) => {
		const [px, py, , w] = project(cam.vp, p);
		if (w <= 0) return Infinity;
		return Math.hypot(((px - x) * ctx.w) / 2 / ctx.dpr, ((py - y) * ctx.h) / 2 / ctx.dpr);
	};

	/** CPU pick over a sample, only for choosing where the cascade strikes next */
	const pickNear = (x: number, y: number, maxPx: number) => {
		let best = -1, bd = maxPx;
		const drawn = staticCount * share;
		for (const i of pickable) {
			if (i >= drawn) break;
			if (!alive(i)) continue;
			posOf(i, sim, tmp);
			const d = pxTo(x, y, tmp);
			if (d < bd && !occluded(cam.eye, tmp)) (bd = d), (best = i);
		}
		return best;
	};

	// GPU pick: redraw the swarm into a small window around the pointer with each
	// dot's index as its colour, read it back, take the nearest dot that is in view
	const PICK_MAX = 128;
	const pickTex = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_2D, pickTex);
	gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, PICK_MAX, PICK_MAX);
	const pickFbo = gl.createFramebuffer()!;
	gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	const pickBuf = new Uint8Array(PICK_MAX * PICK_MAX * 4);

	let gain = 1;
	const debrisUniforms = (u: Record<string, WebGLUniformLocation | null>, vp: M4, pickMin: number) => {
		gl.uniformMatrix4fv(u.uVP, false, vp);
		gl.uniform3fv(u.uEye, cam.eye);
		gl.uniform3fv(u.uSun, sun);
		gl.uniform1f(u.uT, sim);
		gl.uniform1f(u.uK, K);
		gl.uniform1f(u.uPx, Math.sqrt(ctx.dpr));
		gl.uniform1f(u.uDist, cam.dist);
		gl.uniform1f(u.uIntro, intro);
		gl.uniform1f(u.uGain, gain);
		gl.uniform3fv(u.uColor, C_LIGHT);
		gl.uniform3fv(u.uSodium, C_SODIUM);
		gl.uniform3fv(u.uRed, C_RED);
		// it takes hold slowly, then tears through the whole swarm
		const ti = rickAt >= 0 ? intro - rickAt : 0;
		gl.uniform4f(u.uInf, rickPos[0], rickPos[1], rickPos[2], rickAt >= 0 ? 0.02 + 0.35 * ti + 0.9 * ti * ti : 0);
		gl.uniform1f(u.uPickMin, pickMin);
	};
	const drawDebris = () => {
		gl.bindVertexArray(dvao);
		gl.drawArrays(gl.POINTS, 0, Math.floor(staticCount * share));
		gl.drawArrays(gl.POINTS, staticCount, total - staticCount);
	};

	const pickAt = (x: number, y: number, R: number) => {
		const S = Math.min(PICK_MAX, Math.ceil(2 * R * ctx.dpr));
		const win = m4.identity();
		win[0] = ctx.w / S;
		win[5] = ctx.h / S;
		win[12] = -win[0] * x;
		win[13] = -win[5] * y;
		gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
		gl.viewport(0, 0, S, S);
		gl.disable(gl.BLEND);
		gl.disable(gl.DEPTH_TEST);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.useProgram(pPick);
		debrisUniforms(uK, m4.mul(win, cam.vp), 5 * ctx.dpr);
		drawDebris();
		gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, pickBuf);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, ctx.w, ctx.h);

		const near = new Map<number, number>();
		const c = (S - 1) / 2;
		for (let py = 0; py < S; py++)
			for (let px = 0; px < S; px++) {
				const k = (py * S + px) * 4;
				const id = pickBuf[k] | (pickBuf[k + 1] << 8) | (pickBuf[k + 2] << 16);
				if (!id) continue;
				const d = Math.hypot(px - c, py - c) / ctx.dpr;
				const prev = near.get(id - 1);
				if (d <= R && (prev === undefined || d < prev)) near.set(id - 1, d);
			}
		const order = [...near].sort((a, b) => a[1] - b[1]);
		for (const [i] of order.slice(0, 16)) {
			if (i >= total || !alive(i)) continue;
			if (!occluded(cam.eye, posOf(i, sim, tmp))) return i;
		}
		return -1;
	};

	let slot = 0;
	const r = rng(0x51);
	// shockwave ring where the last breakup happened: world position + wall time
	let ringAt = -99;
	const ringPos = [0, 0, 0];
	let ringColor = C_LIGHT;

	/** a new cloud on orbit `el`, currently at mean anomaly M (at time t) */
	const burst = (el: El, M: number, t: number, birth: number, amber: boolean) => {
		const base = staticCount + slot * EVENT_N;
		slot = (slot + 1) % EVENT_SLOTS;
		const chunk = new Float32Array(EVENT_N * STRIDE);
		for (let i = 0; i < EVENT_N; i++) {
			const k = i * STRIDE;
			const g = () => gauss(r);
			const hot = r() < 0.08; // a few bright shards
			const b = hot ? 0.8 : 0.2 + 0.45 * Math.pow(r(), 3);
			chunk.set(
				[
					el.a, Math.min(0.05, el.e + Math.abs(0.003 * g())), el.inc, el.raan, el.argp, M + nOf(el.a) * (birth - t),
					b + (amber && (hot || r() < 0.5) ? 10 : 0), birth,
					0.018 * g(), 0.014 * g(), 0.014 * g(), 0.04 * g(), 0.02 * g()
				],
				k
			);
		}
		data.set(chunk, base * STRIDE);
		gl.bindBuffer(gl.ARRAY_BUFFER, dbuf);
		gl.bufferSubData(gl.ARRAY_BUFFER, base * STRIDE * 4, chunk);
	};

	const fragment = (parent: number, t: number, birth: number, user: boolean) => {
		const { el, M } = stateOf(parent, t);
		if (user) {
			posOf(parent, t, ringPos);
			ringAt = intro;
			ringColor = C_LIGHT;
			// keep at it long enough and something starts coming round the back of the planet
			if (++kills >= RED_AFTER) spawnRed(t);
		}
		burst(el, M, t, birth, false);
		// the parent is gone: it is the cloud now
		const o = parent * STRIDE;
		data[o + 6] = 0;
		gl.bindBuffer(gl.ARRAY_BUFFER, dbuf);
		gl.bufferSubData(gl.ARRAY_BUFFER, (o + 6) * 4, data.subarray(o + 6, o + 7));
	};

	// ---- state
	let sim = 0;
	// the opening sequence runs on wall time so it plays even while the sim is frozen
	let intro = ctx.motion ? 0 : 99;
	let settledFired = false;
	const QI = -2; // the tracked object, as a hover target
	let qiAlive = true, qiGone = 0;
	const trackPos = [0, 0, 0];
	let hover = -1, hoverA = 0, hoverShown = -1, pickTick = 0;
	let lastPick = [9, 9];
	let pendingTap: [number, number] | null = null;
	let nextAuto = 9;
	let cam = camera(base(YAW0, PITCH0), ctx.w / ctx.h);
	// the visitor's accumulated drag, applied in the camera's own frame
	let spin: R3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	let lastYaw = ctx.orbit.yaw, lastPitch = ctx.orbit.pitch;

	// the red dots: hover values at or below RED_H index into `reds`
	const RED_MAX = 24, RED_H = -10, RED_AFTER = 15;
	const reds: { el: El; M: number; t0: number; born: number }[] = [];
	let kills = 0;
	// the red dot that was clicked, pinned where it was while the next page loads
	let rickAt = -99;
	const rickPos = [0, 0, 0];
	const redPos = (k: number, out: number[]) => {
		const { el, M, t0 } = reds[k];
		return orbitE(el.a, el.e, el.inc, el.raan, el.argp, kepler(wrap(M + nOf(el.a) * (sim - t0)), el.e), out);
	};
	/** a red dot on some random low orbit, starting from anywhere hidden behind the planet */
	const spawnRed = (t: number) => {
		const el: El = { a: 1.12 + 0.4 * r(), e: 0.002 * r(), inc: r() * Math.PI, raan: r() * TAU, argp: r() * TAU };
		const N = 240, step = TAU / N;
		const hid: number[] = [];
		let far = 0, farD = Infinity;
		for (let i = 0; i < N; i++) {
			orbitE(el.a, el.e, el.inc, el.raan, el.argp, kepler(i * step, el.e), tmp);
			if (occluded(cam.eye, tmp)) hid.push(i);
			const toEye = tmp[0] * cam.eye[0] + tmp[1] * cam.eye[1] + tmp[2] * cam.eye[2];
			if (toEye < farD) (farD = toEye), (far = i);
		}
		const M = (hid.length ? hid[Math.floor(r() * hid.length)] : far) * step;
		reds.push({ el, M, t0: t, born: intro });
		if (reds.length > RED_MAX) reds.shift();
	};
	const redHit = (x: number, y: number, R: number) => {
		for (let k = reds.length - 1; k >= 0; k--) {
			if (intro - reds[k].born < 0.6) continue;
			redPos(k, tmp);
			if (!occluded(cam.eye, tmp) && pxTo(x, y, tmp) < R) return k;
		}
		return -1;
	};

	/** clicked a red dot: pin it, and let it infect everything while the browser moves on */
	const rickroll = (pos: number[]) => {
		rickPos.splice(0, 3, ...pos);
		rickAt = intro;
		hooks.rick?.();
	};

	const qiHit = (x: number, y: number, R: number) =>
		qiAlive && !occluded(cam.eye, trackPos) && pxTo(x, y, trackPos) < R;

	const destroyQI = () => {
		qiAlive = false;
		qiGone = intro;
		const M = wrap(trackM0 + nOf(TRACK.a) * sim);
		burst(TRACK, M, sim, ctx.motion ? sim : sim - 40, true);
		ringPos.splice(0, 3, ...trackPos);
		ringAt = intro;
		ringColor = C_SODIUM;
		hover = -1;
		hooks.qi?.();
	};

	const drawLoop = (el: El, alpha: number, color: number[], part = 1) => {
		gl.uniform4f(uL.uEl, el.a, el.e, el.inc, el.raan);
		gl.uniform1f(uL.uArgp, el.argp);
		gl.uniform1f(uL.uMode, 0);
		gl.uniform1f(uL.uAlpha, alpha);
		gl.uniform3fv(uL.uColor, color);
		if (part >= 1) gl.drawArrays(gl.LINE_LOOP, 0, LOOP_N);
		else if (part > 0) gl.drawArrays(gl.LINE_STRIP, 0, Math.max(2, Math.floor(LOOP_N * part)));
	};

	/** adaptive quality: after the intro, watch 2 s windows of frame time */
	const watchPerf = (dt: number) => {
		if (intro < INTRO + 1 || tier >= 2 || document.hidden) return;
		perfT += dt;
		perfN++;
		if (perfT < 2) return;
		const avg = perfT / perfN;
		perfT = perfN = 0;
		if (avg > 1 / 45) {
			tier++;
			share *= 0.6;
			ctx.setMaxDpr(tier === 1 ? 1.5 : 1);
		}
	};

	const frame = (_t: number, dt: number) => {
		sim += dt * ctx.motion;
		intro += dt;
		watchPerf(dt);
		const k = easeOut(intro / INTRO);
		const aspect = ctx.w / ctx.h;
		// no pointer parallax: the dot you aim at has to stay under the cursor
		const yaw = YAW0 - 0.32 * (1 - k) + sim * DRIFT;
		// portrait: look up at the belt a little more steeply so it fills the sky
		const tilt = aspect < 1 ? -0.36 * Math.min(1, (1 - aspect) * 2) : 0;
		const pitch = PITCH0 + tilt + 0.12 * (1 - k);
		// drag (with its inertia) turns the view about the camera's own axes, so it goes over the poles
		const dy = ctx.orbit.yaw - lastYaw, dp = ctx.orbit.pitch - lastPitch;
		lastYaw = ctx.orbit.yaw;
		lastPitch = ctx.orbit.pitch;
		// grab-the-globe: the scene follows the pointer both ways (camera moves opposite)
		if (dy || dp) spin = r3.fix(r3.mul(spin, r3.mul(r3.y(-dy), r3.x(-dp))));
		cam = camera(r3.mul(base(yaw, pitch), spin), aspect, 1 + 0.5 * (1 - k));
		const dprS = Math.sqrt(ctx.dpr);
		const limb = easeOut(ramp(intro, 0.1, 1.9));
		const rulesIn = ramp(intro, 1.6, 3.6);
		const trackIn = ramp(intro, 2.8, 3.8) * (qiAlive ? 1 : 1 - ramp(intro, qiGone, qiGone + 0.25));
		const ready = intro > INTRO;
		if (!settledFired && ready) {
			settledFired = true;
			hooks.settled?.();
		}
		const trackM = trackM0 + nOf(TRACK.a) * sim;
		orbitE(TRACK.a, TRACK.e, TRACK.inc, TRACK.raan, TRACK.argp, kepler(wrap(trackM), TRACK.e), trackPos);
		// same number of dots in a smaller picture would saturate: scale the gain with apparent size;
		// a thinned swarm gets a little brighter to hold its weight
		const planetPx = ctx.h / 2 / ctx.dpr / (cam.dist * cam.tanHalf);
		gain = 1.15 * Math.min(1.15, Math.max(0.4, Math.pow(planetPx / 300, 0.9))) * Math.pow(1 / (keep * share), 0.35);

		// taps: the exact dot under the finger, or the tracked object
		if (pendingTap) {
			const [x, y] = pendingTap;
			pendingTap = null;
			if (ready && rickAt < 0) {
				const R = ctx.coarse ? 28 : 18;
				const red = hover <= RED_H ? RED_H - hover : redHit(x, y, R + 4);
				if (red >= 0 && red < reds.length) {
					rickroll(redPos(red, tmp));
					reds.splice(red, 1);
				} else if (hover === QI || qiHit(x, y, R + 4)) destroyQI();
				else {
					// what the ring shows is what gets hit; otherwise the dot under the finger
					const p = hover >= 0 && alive(hover) ? hover : pickAt(x, y, R);
					// under reduced motion, skip straight to a sheared streak
					if (p >= 0) fragment(p, sim, ctx.motion ? sim : sim - 40, true);
				}
				hover = -1;
				lastPick = [9, 9];
			}
		}

		// hover (mouse only): lock onto the dot under the pointer, re-picking as it moves
		if (!ctx.coarse && ctx.pointer.inside && !ctx.orbit.dragging && ready && rickAt < 0) {
			const x = ctx.pointer.tx, y = ctx.pointer.ty;
			const red = redHit(x, y, 20);
			if (red >= 0) hover = RED_H - red;
			else if (qiHit(x, y, 20)) hover = QI;
			else {
				let holds = false;
				if (hover >= 0 && alive(hover)) {
					posOf(hover, sim, tmp);
					holds = pxTo(x, y, tmp) < 16 && !occluded(cam.eye, tmp);
				}
				const moved = Math.hypot(((x - lastPick[0]) * ctx.w) / 2 / ctx.dpr, ((y - lastPick[1]) * ctx.h) / 2 / ctx.dpr) > 3;
				if ((!holds || moved) && ++pickTick % 2 === 0) {
					hover = pickAt(x, y, 16);
					lastPick = [x, y];
				} else if (!holds && hover < -1) hover = -1;
			}
		} else hover = -1;
		if (hover !== -1) hoverShown = hover;
		hoverA += ((hover !== -1 ? 1 : 0) - hoverA) * (1 - Math.exp(-dt * 8));

		// the cascade continues on its own
		if (ctx.motion && sim > nextAuto) {
			nextAuto = sim + 16 + r() * 14;
			const p = pickNear(0.1 + 0.5 * (r() - 0.5), 0.15 + 0.5 * (r() - 0.5), 400);
			if (p >= 0) fragment(p, sim, sim, false);
		}

		gl.clearColor(C_GROUND[0], C_GROUND[1], C_GROUND[2], 1);
		gl.clearDepth(1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);

		// planet: occluder + hairline limb, scissored to its screen bounds
		const c = project(cam.vp, [0, 0, 0]);
		const cx = (c[0] * 0.5 + 0.5) * ctx.w, cy = (c[1] * 0.5 + 0.5) * ctx.h;
		// angular radius -> px, generous for the off-axis stretch and the air
		const rad = (1 / Math.sqrt(cam.dist * cam.dist - 1) / cam.tanHalf) * (ctx.h / 2) * 1.25 + 12;
		const sx0 = Math.max(0, Math.floor(cx - rad)), sy0 = Math.max(0, Math.floor(cy - rad));
		const sx1 = Math.min(ctx.w, Math.ceil(cx + rad)), sy1 = Math.min(ctx.h, Math.ceil(cy + rad));
		const sp = project(cam.vp, sun);
		if (sx1 > sx0 && sy1 > sy0) {
			gl.enable(gl.SCISSOR_TEST);
			gl.scissor(sx0, sy0, sx1 - sx0, sy1 - sy0);
			gl.disable(gl.BLEND);
			gl.depthMask(true);
			gl.useProgram(pPlanet);
			gl.uniformMatrix4fv(uP.uInv, false, cam.inv);
			gl.uniformMatrix4fv(uP.uVP, false, cam.vp);
			gl.uniform3fv(uP.uEye, cam.eye);
			gl.uniform3fv(uP.uSun, sun);
			gl.uniform2f(uP.uRes, ctx.w, ctx.h);
			gl.uniform1f(uP.uPxW, (2 * cam.tanHalf * Math.sqrt(cam.dist * cam.dist - 1)) / ctx.h);
			gl.uniform1f(uP.uLineW, Math.max(1, 0.8 * ctx.dpr));
			gl.uniform3fv(uP.uGround, C_GROUND);
			gl.uniform3fv(uP.uLight, C_LIGHT);
			gl.uniform3f(uP.uReveal, cx, cy, limb);
			gl.uniform1f(uP.uStart, Math.atan2(sp[1] - c[1], (sp[0] - c[0]) * aspect) - 0.6);
			gl.bindVertexArray(triVao);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			gl.disable(gl.SCISSOR_TEST);
		}

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
		gl.depthMask(false);

		// orbit rules trace themselves in, one after another; the tracked orbit goes with its object
		gl.useProgram(pLine);
		gl.uniformMatrix4fv(uL.uVP, false, cam.vp);
		gl.uniform3fv(uL.uEye, cam.eye);
		gl.bindVertexArray(loopVao);
		rules.forEach(({ el, alpha }, i) =>
			drawLoop(el, alpha * (el === TRACK && !qiAlive ? 1 - ramp(intro, qiGone, qiGone + 1.5) : 1), C_RULE, easeOut(rulesIn * 1.6 - i * 0.15))
		);
		if (hoverA > 0.01 && hoverShown >= 0) drawLoop(stateOf(hoverShown, sim).el, 0.3 * hoverA, C_LIGHT);

		// tracked object trail
		gl.bindVertexArray(trailVao);
		gl.uniform4f(uL.uEl, TRACK.a, TRACK.e, TRACK.inc, TRACK.raan);
		gl.uniform1f(uL.uArgp, TRACK.argp);
		gl.uniform1f(uL.uMode, 1);
		gl.uniform1f(uL.uM, trackM);
		gl.uniform1f(uL.uLen, 0.8 * trackIn);
		gl.uniform1f(uL.uAlpha, 0.85 * trackIn);
		gl.uniform3fv(uL.uColor, C_SODIUM);
		if (trackIn > 0) gl.drawArrays(gl.LINE_STRIP, 0, TRAIL_N);

		// debris: a prefix of the shuffled swarm, plus every live breakup
		gl.useProgram(pDebris);
		debrisUniforms(uD, cam.vp, 0);
		drawDebris();

		// markers
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.useProgram(pMark);
		gl.uniformMatrix4fv(uM.uVP, false, cam.vp);
		gl.bindVertexArray(markVao);
		const ring = (pos: number[], size: number, color: number[], alpha: number) => {
			gl.uniform3fv(uM.uPos, pos);
			gl.uniform1f(uM.uSize, size * ctx.dpr);
			gl.uniform3fv(uM.uColor, color);
			gl.uniform1f(uM.uAlpha, alpha);
			gl.uniform1f(uM.uRing, 1);
			gl.uniform1f(uM.uLineW, Math.max(1, 0.8 * ctx.dpr));
			gl.drawArrays(gl.POINTS, 0, 1);
		};
		if (trackIn > 0) {
			gl.uniform3fv(uM.uPos, trackPos);
			gl.uniform1f(uM.uSize, 3.4 * dprS + 1);
			gl.uniform3fv(uM.uColor, C_SODIUM);
			gl.uniform1f(uM.uAlpha, trackIn);
			gl.uniform1f(uM.uRing, 0);
			gl.drawArrays(gl.POINTS, 0, 1);
		}
		reds.forEach((_, k) => {
			const t = intro - reds[k].born;
			// pops out of the flash a beat after the kill
			const a = easeOut(ramp(t, 0.35, 0.9));
			if (a <= 0 || occluded(cam.eye, redPos(k, tmp))) return;
			gl.uniform3fv(uM.uPos, tmp);
			gl.uniform1f(uM.uSize, (3.4 * dprS + 1) * (1 + 0.6 * (1 - a) + 0.12 * Math.sin(t * 5)));
			gl.uniform3fv(uM.uColor, C_RED);
			gl.uniform1f(uM.uAlpha, a);
			gl.uniform1f(uM.uRing, 0);
			gl.drawArrays(gl.POINTS, 0, 1);
		});
		if (hoverA > 0.01 && hoverShown !== -1) {
			const isQI = hoverShown === QI;
			const red = hoverShown <= RED_H ? RED_H - hoverShown : -1;
			if (red >= 0) {
				if (red < reds.length) ring(redPos(red, tmp), 15 + 5 * (1 - hoverA), C_RED, 0.7 * hoverA);
			} else if (!isQI || qiAlive)
				ring(isQI ? trackPos : posOf(hoverShown, sim, tmp), 15 + 5 * (1 - hoverA), isQI ? C_SODIUM : C_LIGHT, 0.7 * hoverA);
		}
		if (rickAt >= 0) {
			const t = intro - rickAt;
			// press: a quick squash, a bounce, then a steady throb while it waits
			const press = t < 0.08 ? 1 - 0.45 * (t / 0.08) : t < 0.45 ? 0.55 + 1.25 * easeOut((t - 0.08) / 0.37) : 1.8 + 0.25 * Math.sin((t - 0.45) * 7);
			gl.uniform3fv(uM.uPos, rickPos);
			gl.uniform1f(uM.uSize, (3.4 * dprS + 1) * press);
			gl.uniform3fv(uM.uColor, C_RED);
			gl.uniform1f(uM.uAlpha, 1);
			gl.uniform1f(uM.uRing, 0);
			gl.drawArrays(gl.POINTS, 0, 1);
			// one shockwave as it bursts; the infection spreading through the swarm does the rest
			if (t < 1.2) ring(rickPos, 14 + 70 * easeOut(t / 1.2), C_RED, 0.55 * (1 - easeOut(t / 1.2)));
		}
		const ringT = intro - ringAt;
		if (ringT < 1.2) {
			const e = easeOut(ringT / 1.2);
			ring(ringPos, 14 + 70 * e, ringColor, 0.55 * (1 - e));
		}
		gl.depthMask(true);

		if (hooks.track) {
			const [px, py, , w] = project(cam.vp, trackPos);
			const vis = w > 0 && !occluded(cam.eye, trackPos) ? trackIn : 0;
			hooks.track(((px + 1) / 2) * (ctx.w / ctx.dpr), ((1 - py) / 2) * (ctx.h / ctx.dpr), vis);
		}
	};

	return {
		frame,
		tap(x, y) {
			pendingTap = [x, y];
		},
		destroy() {
			gl.deleteBuffer(dbuf);
			gl.deleteFramebuffer(pickFbo);
			gl.deleteTexture(pickTex);
			for (const v of [dvao, loopVao, trailVao, triVao, markVao]) gl.deleteVertexArray(v);
			for (const p of [pDebris, pPick, pLine, pMark, pPlanet]) gl.deleteProgram(p);
		}
	};
};
