// Option 4, "Volume": a volumetric LED cube. A fixed lattice of point LEDs,
// with a 3D Q rasterised into it on the GPU. The Q turns slowly inside the
// lattice, so the letter only exists as quantised, stepping light.

import { m4, type M4, type Setup } from '$lib/stage';

export const GROUND = '#101218';

/** LEDs per edge */
const N = 24;
/** lattice half-extent in model units */
const HALF = 1;
const VOX = (2 * HALF) / (N - 1);
/** glyph scale: glyph-space (≈1 unit tall) -> lattice units */
const QS = 1.46;
/** PWM steps (4-bit) */
const LEVELS = 16;
/** seconds for the power-on sweep */
const BOOT = 2.6;
/** scanline: sweep time and total period */
const SWEEP = 5.5;
const PERIOD = 13;
const STILL_T = 4.4;

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

const VS = /* glsl */ `#version 300 es
precision highp float;

uniform mat4 uMVP;
uniform mat3 uQ;       // lattice -> glyph-local
uniform float uPx;     // device px per model unit at view depth 1
uniform float uDpr;
uniform vec2 uDepth;   // near / far view depth of the cube, for fog
uniform float uScan;   // scanline position in layers (top = N-1), large negative = off
uniform float uBoot;   // power-on sweep position in layers; <= -1 means fully on
uniform vec4 uRip;     // ages of the last four taps, seconds (<0 or large = idle)
uniform vec3 uGround, uUnlit, uLit, uRule;
uniform float uMaxPt;

out vec3 vCol;
out vec3 vHalo;
out float vCore;
out float vSize;

const int N = ${N};
const float VOX = ${VOX.toFixed(6)};
const float HALF = ${HALF.toFixed(3)};
const float S = ${QS.toFixed(3)};
const float LEVELS = ${LEVELS.toFixed(1)};

// ---- the Q, in glyph space (see glyph.frag for the 2D proportions) ----
const float R = 0.36;
const float W = 0.072;
const float EZ = 0.035; // half-depth of the extrusion, before rounding
const vec2 C = vec2(0.0, 0.05);
const vec2 DIR = vec2(0.68, -0.73);

float smin(float a, float b, float k) {
	float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
	return mix(b, a, h) - k * h * (1.0 - h);
}

float glyph(vec3 p) {
	p /= S;
	p.x += 0.034; // centre the glyph's bounding box on the lattice
	// ring: a torus whose tube is a stadium (round stroke, extruded in z)
	vec2 q = vec2(length(p.xy - C) - R, max(abs(p.z) - EZ, 0.0));
	float ring = length(q) - W;
	// tail: a capsule with the same extrusion
	vec3 a = vec3(C + DIR * 0.30, 0.0), b = vec3(C + DIR * 0.64, 0.0);
	vec3 pa = p - a, ba = b - a;
	vec3 e = pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
	e.z = max(abs(e.z) - EZ, 0.0);
	float tail = length(e) - W * 0.92;
	return smin(ring, tail, 0.05) * S;
}

uint hash(uint x) {
	x ^= x >> 16; x *= 0x7feb352du;
	x ^= x >> 15; x *= 0x846ca68bu;
	x ^= x >> 16;
	return x;
}

void main() {
	int id = gl_VertexID;
	ivec3 ijk = ivec3(id % N, (id / N) % N, id / (N * N));
	vec3 p = (vec3(ijk) * VOX) - HALF;
	float jitter = float(hash(uint(id)) & 0xffffu) / 65535.0;

	// glyph coverage, anti-aliased over ~2 voxels
	float d = glyph(uQ * p);
	float lit = smoothstep(1.5 * VOX, -0.7 * VOX, d);
	// power-on: layers light top-down as the first sweep passes
	float layer = float(ijk.y);
	lit *= smoothstep(uBoot - 0.5, uBoot + 0.5, layer);

	// scanline refresh: sharp leading edge, soft phosphor-ish trail
	float ds = layer - uScan;
	float scan = ds >= 0.0 ? exp(-ds * 0.55) : exp(ds * 3.0);

	// tap ripples: brightness shells expanding from the centre
	float rr = length(p);
	float rip = 0.0;
	for (int i = 0; i < 4; i++) {
		float age = uRip[i];
		if (age < 0.0 || age > 6.0) continue;
		float rad = age * 0.62;
		float x = (rr - rad) / (1.5 * VOX);
		rip += exp(-x * x) * exp(-age * 0.55) * smoothstep(0.0, 0.2, age);
	}

	// per-LED tolerance, like real parts
	float tol = 0.9 + 0.2 * jitter;
	float level = lit * tol + scan * (0.42 + 0.3 * lit) + rip * 0.8;
	level = clamp(level, 0.0, 1.0);
	level = floor(level * LEVELS + 0.25) / LEVELS; // PWM steps

	vec4 clip = uMVP * vec4(p, 1.0);
	gl_Position = clip;
	float w = clip.w;
	float fog = mix(1.0, 0.24, clamp((w - uDepth.x) / (uDepth.y - uDepth.x), 0.0, 1.0));
	fog = mix(fog, 1.0, 0.55 * level); // emitters carry through the haze better than bare parts

	// dot size: a fraction of the projected lattice pitch, nearer = larger
	float pitchPx = VOX * uPx / w;
	float core = clamp(pitchPx * 0.055, 0.65 * uDpr, 2.0 * uDpr) * (1.0 + 1.1 * level);
	float halo = level * level;
	vCore = core;
	vSize = ceil(core * 2.0 + 2.0 + halo * core * 9.0);
	vSize = min(vSize, uMaxPt);
	gl_PointSize = vSize;

	// the cube's twelve edges read a touch brighter, so the volume keeps its shape
	bvec3 rim = equal(ijk % (N - 1), ivec3(0));
	float edge = float(rim.x) + float(rim.y) + float(rim.z) >= 2.0 ? 1.0 : 0.0;
	vec3 unlit = mix(uUnlit, uRule, 0.4 * edge);

	float e = pow(level, 1.1);
	vec3 col = unlit * (1.0 - 0.6 * e) + uLit * e;
	vCol = uGround + (col - uGround) * fog;
	vHalo = uLit * halo * 0.55 * fog;
}
`;

const FS = /* glsl */ `#version 300 es
precision highp float;

in vec3 vCol;
in vec3 vHalo;
in float vCore;
in float vSize;
uniform vec3 uGround;
out vec4 o;

void main() {
	float r = length(gl_PointCoord - 0.5) * vSize; // device px from centre
	float edge = vSize * 0.5;
	if (r > edge) discard;
	float cov = clamp(vCore - r + 0.5, 0.0, 1.0);
	float h = exp(-max(r - vCore, 0.0) / (vCore * 1.1)) * (1.0 - smoothstep(edge * 0.55, edge, r));
	float hot = clamp(1.0 - r / vCore, 0.0, 1.0);
	o = vec4(mix(uGround, vCol, cov) + vHalo * h * (1.0 - cov) + vHalo * hot * 0.8, 1.0);
}
`;

const mat3of = (m: M4) => new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);

export const setup: Setup = (ctx) => {
	const { gl } = ctx;
	const prog = ctx.program(VS, FS);
	const u = (n: string) => gl.getUniformLocation(prog, n);
	const U = {
		mvp: u('uMVP'),
		q: u('uQ'),
		px: u('uPx'),
		dpr: u('uDpr'),
		depth: u('uDepth'),
		scan: u('uScan'),
		boot: u('uBoot'),
		rip: u('uRip'),
		ground: u('uGround'),
		unlit: u('uUnlit'),
		lit: u('uLit'),
		rule: u('uRule'),
		maxPt: u('uMaxPt')
	};
	const empty = gl.createVertexArray();
	const ground = hex(GROUND);
	const maxPoint = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array)[1];

	// static uniforms
	gl.useProgram(prog);
	gl.uniform3fv(U.ground, ground);
	gl.uniform3fv(U.unlit, hex('#262a36'));
	gl.uniform3fv(U.lit, hex('#ffe2b8'));
	gl.uniform3fv(U.rule, hex('#696e82'));
	gl.uniform1f(U.maxPt, maxPoint);

	let proj = m4.identity();
	let dist = 6;
	let pxPerUnit = 1;
	const FOV = 0.5;
	const resize = () => {
		const aspect = ctx.w / ctx.h;
		// fit the cube's bounding sphere in the narrower axis, with room to breathe
		const half = Math.min(FOV / 2, Math.atan(Math.tan(FOV / 2) * aspect));
		const fill = aspect < 1 ? 1.5 : 1.74;
		dist = (HALF * fill) / Math.sin(half);
		proj = m4.perspective(FOV, aspect, 0.1, dist * 3);
		pxPerUnit = (0.5 * ctx.h) / Math.tan(FOV / 2);
	};
	resize();

	// tap times (seconds on the stage clock); ages go to the shader
	const taps = [-1e3, -1e3, -1e3, -1e3];
	let tapNext = 0;
	let clock = 0;
	let now = 0;

	const frame = (t: number) => {
		const moving = ctx.motion > 0;
		now = t;
		clock = moving ? t : STILL_T;
		const px = ctx.pointer.x, py = ctx.pointer.y;

		// lattice: 3/4 view, slow sway that never quite goes face-on; view: drag orbit + pointer parallax
		const latYaw = 0.76 + 0.44 * Math.sin(clock * 0.047 + 0.3);
		const yaw = ctx.orbit.yaw + px * 0.16;
		const pitch = 0.4 + ctx.orbit.pitch - py * 0.1;
		const L = m4.rotY(latYaw);
		const V = m4.mul(m4.lookAt([0, 0, dist], [0, 0, 0]), m4.mul(m4.rotX(pitch), m4.rotY(yaw)));
		const mvp = m4.mul(proj, m4.mul(V, L));

		// the Q lives in world space, facing the viewer and swaying; the lattice turns under it.
		// It also leans toward the pointer, so moving the pointer re-quantises it: the voxels shimmer.
		const qYaw = -0.2 + 0.62 * Math.sin(clock * 0.12) + px * 0.45;
		const qPitch = -0.22 + 0.16 * Math.sin(clock * 0.083 + 1.3) - py * 0.3;
		const qRoll = 0.07 * Math.sin(clock * 0.061 + 0.4);
		// lattice -> glyph-local = Qr^-1 * L, with Qr = rotX(qPitch) rotY(qYaw) rotZ(qRoll)
		const Qinv = m4.mul(m4.rotZ(-qRoll), m4.mul(m4.rotY(-qYaw), m4.rotX(-qPitch)));
		const Q = mat3of(m4.mul(Qinv, L));

		const boot = moving ? N - 1 + 1.5 - (t / BOOT) * (N + 2) : -2;
		// the power-on sweep doubles as the first scanline
		let scan = moving && t <= BOOT ? boot : -1e3;
		if (moving && t > BOOT) {
			const ph = (t - BOOT + PERIOD - SWEEP) % PERIOD;
			if (ph < SWEEP + 3) scan = N - 1 + 1 - (ph / SWEEP) * (N + 1);
		}

		gl.clearColor(ground[0], ground[1], ground[2], 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.useProgram(prog);
		gl.uniformMatrix4fv(U.mvp, false, mvp);
		gl.uniformMatrix3fv(U.q, false, Q);
		gl.uniform1f(U.px, pxPerUnit);
		gl.uniform1f(U.dpr, ctx.dpr);
		gl.uniform2f(U.depth, dist - Math.sqrt(3) * HALF, dist + Math.sqrt(3) * HALF);
		gl.uniform1f(U.scan, scan);
		gl.uniform1f(U.boot, Math.max(boot, -2));
		gl.uniform4f(U.rip, now - taps[0], now - taps[1], now - taps[2], now - taps[3]);

		// max blending: LEDs are order-independent light, and halos never blow out
		gl.enable(gl.BLEND);
		gl.blendEquation(gl.MAX);
		gl.bindVertexArray(empty);
		gl.drawArrays(gl.POINTS, 0, N * N * N);
		gl.bindVertexArray(null);
		gl.disable(gl.BLEND);
	};

	return {
		frame,
		resize,
		tap: () => {
			taps[tapNext] = now;
			tapNext = (tapNext + 1) % 4;
		},
		destroy: () => {
			gl.deleteProgram(prog);
			gl.deleteVertexArray(empty);
		}
	};
};
