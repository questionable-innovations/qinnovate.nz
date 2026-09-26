// Phosphor: an XY-mode oscilloscope drawing a 3D wire Q with one continuous
// beam. The Q (glyph.frag proportions) is a (7,2) torus winding around the
// ring's stroke tube plus a four-wire tail, traversed as a single closed path
// with faint un-blanked retraces. It periodically dissolves, loop by loop,
// into 3D Lissajous figures and condenses back out of them.
//
// Rendering is energy-conserving: each sub-stepped beam segment deposits
// power × dwell-time, spread along the segment with a gaussian cross-section,
// so slow strokes glow and fast strokes are faint. The persistence buffer
// holds two P7 layers: a fast blue-white fluorescence (R) and a slow
// yellow-green phosphorescence (G), each with its own decay.

import type { Setup } from '../stage';

export const GROUND = '#0f1215';

const N = 4096; // path samples
const T_TRACE = 2.0; // seconds for the beam to traverse the whole path once
const TAU_F = 0.075; // fluorescence decay (s)
const TAU_G = 1.15; // phosphorescence decay (s)
const STAGGER = 0.8; // morph wave width along the path
const CAM_D = 2.6; // camera distance in glyph units
const LIS_AMP = 0.44;
const LIS: [number, number, number][] = [
	[3, 2, 1],
	[2, 3, 4],
	[5, 4, 3],
	[1, 2, 3],
	[4, 3, 5]
];

// glyph proportions (glyph.frag)
const R = 0.36;
const W = 0.072;
const CX = 0;
const CY = 0.05;
const DX = 0.68;
const DY = -0.73;
const PIV_X = 0.034;

type Pt = { c: number[]; u: number[]; v: number[]; a: number };
type Stroke = { dur: number; at: (s: number) => Pt };

const lerp3 = (a: number[], b: number[], s: number) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
const dist3 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The Q as one closed beam path, sampled uniformly in beam time. */
function buildQ() {
	const TAU = Math.PI * 2;
	const LOOPS = 8, TWIST = 1;
	const th0 = Math.PI / 2;
	const ring: Stroke = {
		dur: LOOPS * TAU * R,
		at: (s) => {
			const th = th0 + TAU * LOOPS * s, ct = Math.cos(th), st = Math.sin(th);
			return { c: [CX + R * ct, CY + R * st, 0], u: [W * ct, W * st, 0], v: [0, 0, W], a: TAU * TWIST * s };
		}
	};
	const A = [CX + DX * 0.3, CY + DY * 0.3, 0];
	const B = [CX + DX * 0.64, CY + DY * 0.64, 0];
	const tw = W * 0.92;
	const tu = [-DY * tw, DX * tw, 0], tv = [0, 0, tw];
	const TAIL_SPEED = 0.45;
	const ease = (s: number) => s + (0.5 - 0.5 * Math.cos(Math.PI * s) - s) * 0.8;
	const tail: Stroke[] = [];
	for (let j = 0; j < 4; j++) {
		const psi = Math.PI / 4 + (j * Math.PI) / 2;
		const from = j % 2 ? B : A, to = j % 2 ? A : B;
		tail.push({ dur: dist3(A, B) / TAIL_SPEED, at: (s) => ({ c: lerp3(from, to, ease(s)), u: tu, v: tv, a: psi }) });
		if (j < 3) tail.push({ dur: (tw * Math.PI) / 2 / TAIL_SPEED, at: (s) => ({ c: to, u: tu, v: tv, a: psi + (s * Math.PI) / 2 }) });
	}
	const RETRACE_SPEED = 14;
	const retrace = (p: Pt, q: Pt): Stroke => {
		let da = (q.a - p.a) % TAU;
		if (da > Math.PI) da -= TAU;
		if (da < -Math.PI) da += TAU;
		return {
			dur: dist3(p.c, q.c) / RETRACE_SPEED + 0.004,
			at: (s) => ({ c: lerp3(p.c, q.c, s), u: lerp3(p.u, q.u, s), v: lerp3(p.v, q.v, s), a: p.a + da * s })
		};
	};
	const strokes = [ring, retrace(ring.at(1), tail[0].at(0)), ...tail, retrace(tail[tail.length - 1].at(1), ring.at(0))];
	const total = strokes.reduce((a, s) => a + s.dur, 0);
	const C = new Float32Array(N * 3), U = new Float32Array(N * 3), V = new Float32Array(N * 3), An = new Float32Array(N);
	let k = 0, t0 = 0;
	for (let i = 0; i < N; i++) {
		const t = (i / N) * total;
		while (k < strokes.length - 1 && t > t0 + strokes[k].dur) t0 += strokes[k++].dur;
		const p = strokes[k].at(Math.min(1, (t - t0) / strokes[k].dur));
		for (let j = 0; j < 3; j++) {
			C[i * 3 + j] = p.c[j] - (j === 0 ? PIV_X : 0);
			U[i * 3 + j] = p.u[j];
			V[i * 3 + j] = p.v[j];
		}
		An[i] = p.a;
	}
	return { C, U, V, An };
}

const FS_VS = `#version 300 es
void main() {
	vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4.0 - 1.0;
	gl_Position = vec4(p, 0.0, 1.0);
}`;

const FADE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec3 uDecay; // fluor, phos, epsilon
out vec4 o;
void main() {
	vec4 p = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
	o = vec4(max(p.r * uDecay.x - uDecay.z, 0.0), max(p.g * uDecay.y - uDecay.z, 0.0), 0.0, 1.0);
}`;

const BEAM_VS = `#version 300 es
layout(location = 0) in vec4 aSeg; // x0 y0 x1 y1 (device px)
layout(location = 1) in vec4 aE;   // fluor energy, phos energy, sigma
uniform vec2 uRes;
out vec2 vL;
flat out float vLen;
flat out vec3 vE;
void main() {
	vec2 c = vec2(gl_VertexID & 1, gl_VertexID >> 1);
	vec2 d = aSeg.zw - aSeg.xy;
	float L = length(d);
	vec2 t = L > 1e-4 ? d / L : vec2(1.0, 0.0);
	vec2 n = vec2(-t.y, t.x);
	float r = 3.5 * aE.z + 0.5;
	float along = mix(-r, L + r, c.x);
	float across = mix(-r, r, c.y);
	vL = vec2(along, across);
	vLen = L;
	vE = aE.xyz;
	gl_Position = vec4((aSeg.xy + t * along + n * across) / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

const BEAM_FS = `#version 300 es
precision highp float;
in vec2 vL;
flat in float vLen;
flat in vec3 vE;
out vec4 o;
float erf(float x) {
	float s = sign(x);
	x = abs(x);
	float t = 1.0 / (1.0 + 0.3275911 * x);
	float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
	return s * y;
}
void main() {
	float sg = vE.z;
	float L = max(vLen, 1e-3);
	float k = 0.70710678 / sg;
	// gaussian beam spot integrated along the segment, per unit length: sums seamlessly across joints
	float along = (erf(vL.x * k) - erf((vL.x - L) * k)) * 0.5 / L;
	float across = exp(-0.5 * vL.y * vL.y / (sg * sg)) / (2.5066283 * sg);
	float dens = along * across;
	o = vec4(vE.x * dens, vE.y * dens, 0.0, 0.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uStep; // uv step
uniform vec2 uOut;  // output size
out vec4 o;
const float w[5] = float[](0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
void main() {
	vec2 uv = gl_FragCoord.xy / uOut;
	vec4 s = texture(uSrc, uv) * w[0];
	for (int i = 1; i < 5; i++) s += (texture(uSrc, uv + uStep * float(i)) + texture(uSrc, uv - uStep * float(i))) * w[i];
	o = s;
}`;

const COMP_FS = `#version 300 es
precision highp float;
uniform sampler2D uP;
uniform sampler2D uH;
uniform vec2 uRes;
uniform vec4 uGrid;  // centre xy, division px, dpr
uniform vec2 uCount; // divisions x, y
uniform vec3 uGain;  // fluor, phos, halo
out vec4 o;

const vec3 GROUND = vec3(0.059, 0.071, 0.082); // #0f1215
const vec3 GRAT   = vec3(0.227, 0.251, 0.275); // #3a4046
const vec3 FRESH  = vec3(0.60, 0.78, 1.0);   // reads as #d6e6ff once tone-mapped
const vec3 AFTER  = vec3(0.624, 0.702, 0.337); // #9fb356

float hash(vec2 p) {
	p = fract(p * vec2(123.34, 456.21));
	p += dot(p, p + 45.32);
	return fract(p.x * p.y);
}

float graticule(vec2 fc) {
	float d = uGrid.z, dpr = uGrid.w;
	vec2 q = (fc - uGrid.xy) / d;
	vec2 hn = uCount * 0.5;
	vec2 edge = (hn - abs(q)) * d; // px inside the frame
	if (min(edge.x, edge.y) < -2.0 * dpr) return 0.0;
	vec2 gi = abs(q - round(q)) * d;               // px to nearest major line
	vec2 gm = abs(q * 5.0 - round(q * 5.0)) * d / 5.0; // px to nearest fifth-division
	float r = 0.62 * dpr;
	float dots = max(
		smoothstep(r + 0.7, r - 0.7, length(vec2(gi.x, gm.y))),
		smoothstep(r + 0.7, r - 0.7, length(vec2(gm.x, gi.y))));
	// minor ticks on the centre axes
	float tl = 3.2 * dpr, tw = 0.42 * dpr;
	vec2 aq = abs(q) * d;
	float ticks = max(
		smoothstep(tl + 0.7, tl - 0.7, aq.y) * smoothstep(tw + 0.7, tw - 0.7, gm.x),
		smoothstep(tl + 0.7, tl - 0.7, aq.x) * smoothstep(tw + 0.7, tw - 0.7, gm.y));
	float g = max(dots, ticks * 0.9);
	return g * smoothstep(-2.0 * dpr, -0.5 * dpr, min(edge.x, edge.y));
}

void main() {
	vec2 fc = gl_FragCoord.xy;
	vec4 p = texelFetch(uP, ivec2(fc), 0);
	vec4 h = texture(uH, fc / uRes);
	vec3 e = (p.r + h.r * uGain.z) * uGain.x * FRESH + (p.g + h.g * uGain.z) * uGain.y * AFTER;
	vec3 beam = 1.0 - exp(-e);
	vec3 col = mix(GROUND, GRAT, graticule(fc)) + beam;
	col += (hash(fc) - 0.5) / 255.0;
	o = vec4(col, 1.0);
}`;

type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };
type Params = { yaw: number; pitch: number; phi: number; dx: number; dz: number; M: number; k: number };

const smooth = (x: number) => x * x * (3 - 2 * x);
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));

/** morph schedule: 0 = Q, 1 = Lissajous; k picks the harmonic figure */
function schedule(t: number): { M: number; k: number } {
	const INTRO = 2.5, COND = 5, HOLD = 15, DISS = 5, LH = 9;
	if (t < INTRO) return { M: 1, k: 0 };
	if (t < INTRO + COND) return { M: 1 - ease((t - INTRO) / COND), k: 0 };
	const cyc = HOLD + DISS + LH + COND;
	let u = t - INTRO - COND;
	const n = Math.floor(u / cyc);
	u -= n * cyc;
	const k = n + 1;
	if (u < HOLD) return { M: 0, k };
	if (u < HOLD + DISS) return { M: ease((u - HOLD) / DISS), k };
	if (u < HOLD + DISS + LH) return { M: 1, k };
	return { M: 1 - ease((u - HOLD - DISS - LH) / COND), k };
}

export const setup: Setup = (ctx) => {
	const { gl } = ctx;
	const Q = buildQ();
	const floatOK = !!gl.getExtension('EXT_color_buffer_float');

	const progFade = ctx.program(FS_VS, FADE_FS);
	const progBeam = ctx.program(BEAM_VS, BEAM_FS);
	const progBlur = ctx.program(FS_VS, BLUR_FS);
	const progComp = ctx.program(FS_VS, COMP_FS);
	const U = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
	const uFade = { src: U(progFade, 'uSrc'), decay: U(progFade, 'uDecay') };
	const uBeam = { res: U(progBeam, 'uRes') };
	const uBlur = { src: U(progBlur, 'uSrc'), step: U(progBlur, 'uStep'), out: U(progBlur, 'uOut') };
	const uComp = {
		p: U(progComp, 'uP'), h: U(progComp, 'uH'), res: U(progComp, 'uRes'),
		grid: U(progComp, 'uGrid'), count: U(progComp, 'uCount'), gain: U(progComp, 'uGain')
	};

	const empty = gl.createVertexArray()!;
	const MAX_SEG = N + 64;
	const inst = new Float32Array(MAX_SEG * 8);
	const beamVao = gl.createVertexArray()!;
	const instBuf = gl.createBuffer()!;
	gl.bindVertexArray(beamVao);
	gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
	gl.bufferData(gl.ARRAY_BUFFER, inst.byteLength, gl.DYNAMIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
	gl.vertexAttribDivisor(0, 1);
	gl.enableVertexAttribArray(1);
	gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
	gl.vertexAttribDivisor(1, 1);
	gl.bindVertexArray(null);

	let half = floatOK;
	const makeTarget = (w: number, h: number): Target => {
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
		else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		const fbo = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		if (half && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
			gl.deleteFramebuffer(fbo);
			gl.deleteTexture(tex);
			half = false;
			return makeTarget(w, h);
		}
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		return { tex, fbo, w, h };
	};
	const freeTarget = (t: Target | null) => {
		if (!t) return;
		gl.deleteFramebuffer(t.fbo);
		gl.deleteTexture(t.tex);
	};

	let pA: Target | null = null, pB: Target | null = null, hA: Target | null = null, hB: Target | null = null;
	// layout (device px)
	let cx = 0, cy = 0, div = 1, unit = 1, sigma = 0.6, nx = 10, ny = 8;
	let stillKey = ''; // reduced motion: last rendered orbit/size

	const resize = () => {
		[pA, pB, hA, hB].forEach(freeTarget);
		const w = ctx.w, h = ctx.h;
		pA = makeTarget(w, h);
		pB = makeTarget(w, h);
		hA = makeTarget(Math.ceil(w / 2), Math.ceil(h / 2));
		hB = makeTarget(Math.ceil(w / 2), Math.ceil(h / 2));
		const portrait = h > w;
		nx = portrait ? 8 : 10;
		ny = portrait ? 10 : 8;
		const m = Math.max(26 * ctx.dpr, 0.075 * Math.min(w, h));
		div = Math.min((w - 2 * m) / nx, (h - 2 * m) / ny);
		unit = div * (portrait ? 6.2 : 5.3);
		stillKey = '';
		cx = w / 2;
		cy = h / 2;
		sigma = 0.6 + 0.12 * (ctx.dpr - 1);
	};

	// ---- beam path evaluation ----
	const P: Params = { yaw: 0, pitch: 0, phi: 0, dx: 0, dz: 0, M: 0, k: 0 };
	const world = (i: number, p: Params, o: number[]) => {
		const s = i / N;
		let m = p.M * (1 + STAGGER) - STAGGER * s;
		m = m <= 0 ? 0 : m >= 1 ? 1 : smooth(m);
		const a = Q.An[i] + p.phi, ca = Math.cos(a), sa = Math.sin(a), j = i * 3;
		let x = Q.C[j] + Q.U[j] * ca + Q.V[j] * sa;
		let y = Q.C[j + 1] + Q.U[j + 1] * ca + Q.V[j + 1] * sa;
		let z = Q.C[j + 2] + Q.U[j + 2] * ca + Q.V[j + 2] * sa;
		if (m > 0) {
			const [la, lb, lc] = LIS[p.k % LIS.length], u = s * Math.PI * 2;
			x += (LIS_AMP * Math.sin(la * u + p.dx) - x) * m;
			y += (LIS_AMP * Math.sin(lb * u) - y) * m;
			z += (LIS_AMP * Math.sin(lc * u + p.dz) - z) * m;
		}
		o[0] = x; o[1] = y; o[2] = z;
	};
	const wa = [0, 0, 0], wb = [0, 0, 0];
	/** screen position (device px) and perspective scale of fractional sample x */
	const project = (x: number, p: Params, o: number[]) => {
		const fl = Math.floor(x), f = x - fl;
		const i0 = ((fl % N) + N) % N, i1 = (i0 + 1) % N;
		world(i0, p, wa);
		if (f > 0) {
			world(i1, p, wb);
			wa[0] += (wb[0] - wa[0]) * f; wa[1] += (wb[1] - wa[1]) * f; wa[2] += (wb[2] - wa[2]) * f;
		}
		const cyw = Math.cos(p.yaw), syw = Math.sin(p.yaw), cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
		const x1 = wa[0] * cyw + wa[2] * syw, z1 = -wa[0] * syw + wa[2] * cyw;
		const y2 = wa[1] * cp - z1 * sp, z2 = wa[1] * sp + z1 * cp;
		const k = CAM_D / (CAM_D - z2);
		o[0] = cx + x1 * k * unit;
		o[1] = cy + y2 * k * unit;
		o[2] = k;
	};

	let count = 0;
	const push = (a: number[], b: number[], eF: number, eG: number) => {
		if (count >= MAX_SEG) return;
		const k = (a[2] + b[2]) * 0.5, o = count++ * 8;
		const depth = k * k * k;
		const sg = sigma * (1 + 0.9 * Math.max(0, 1 - k));
		inst[o] = a[0]; inst[o + 1] = a[1]; inst[o + 2] = b[0]; inst[o + 3] = b[1];
		inst[o + 4] = eF * depth; inst[o + 5] = eG * depth; inst[o + 6] = sg; inst[o + 7] = 0;
	};
	/** energy for `bt` seconds of beam time, resolution independent */
	const K = 26;
	const energy = (bt: number) => K * bt * unit * sigma;

	const params = (t: number, o: Params) => {
		const s = schedule(t);
		const px = ctx.pointer.x, py = ctx.pointer.y;
		o.yaw = ctx.orbit.yaw + 0.42 * Math.sin(t * 0.13) + 0.18 * Math.sin(t * 0.071 + 1.3) + px * 0.35;
		o.pitch = ctx.orbit.pitch + 0.16 + 0.12 * Math.sin(t * 0.097 + 0.4) - py * 0.25;
		o.phi = t * 0.07 + px * 2.2;
		o.dx = t * 0.21 + px * 2.0;
		o.dz = t * 0.09 + py * 1.6;
		o.M = s.M;
		o.k = s.k;
	};
	const stillParams = (o: Params) => {
		o.yaw = ctx.orbit.yaw - 0.42;
		o.pitch = ctx.orbit.pitch + 0.2;
		o.phi = 0.5;
		o.dx = o.dz = 0;
		o.M = 0;
		o.k = 0;
	};

	let head = 0;
	const P0: Params = { ...P }, P1: Params = { ...P };
	let started = false;
	let dwell: { x: number; y: number; left: number; t: number; entered: boolean } | null = null;
	let lastT = 0;
	const pa = [0, 0, 0], pb = [0, 0, 0], ph = [0, 0, 0];
	const STILL_HEAD = N * 0.62;

	const frame = (t: number, dt: number) => {
		if (!pA || !pB || !hA || !hB) resize();
		lastT = t;
		const still = ctx.motion === 0;
		count = 0;

		if (still) {
			// the still frame only changes when dragged, resized or tapped
			const key = `${ctx.orbit.yaw},${ctx.orbit.pitch},${ctx.w},${ctx.h}`;
			if (key === stillKey && !dwell) return;
			stillKey = key;
			stillParams(P1);
			const bt = T_TRACE / N;
			const e = energy(bt);
			const gF = 1 / (1 - Math.exp(-T_TRACE / TAU_F)), gG = 1 / (1 - Math.exp(-T_TRACE / TAU_G));
			project(0, P1, pa);
			for (let i = 0; i < N; i++) {
				project(i + 1, P1, pb);
				const age = ((((STILL_HEAD - i - 0.5) % N) + N) % N) * bt;
				push(pa, pb, e * Math.exp(-age / TAU_F) * gF, e * Math.exp(-age / TAU_G) * gG);
				pa[0] = pb[0]; pa[1] = pb[1]; pa[2] = pb[2];
			}
			if (dwell) {
				const age = t - dwell.t;
				const pt = [dwell.x, dwell.y, 1];
				const e2 = energy(0.25);
				push(pt, pt, e2 * Math.exp(-age / TAU_F), e2 * Math.exp(-age / TAU_G));
				if (age > 6) dwell = null;
			}
			started = false;
		} else {
			stillKey = '';
			if (!started) {
				params(t, P0);
				started = true;
			}
			params(t, P1);
			const lerpP = (f: number) => {
				P.yaw = P0.yaw + (P1.yaw - P0.yaw) * f;
				P.pitch = P0.pitch + (P1.pitch - P0.pitch) * f;
				P.phi = P0.phi + (P1.phi - P0.phi) * f;
				P.dx = P0.dx + (P1.dx - P0.dx) * f;
				P.dz = P0.dz + (P1.dz - P0.dz) * f;
				P.M = P0.M + (P1.M - P0.M) * f;
				P.k = P1.M < P0.M ? P0.k : P1.k;
				return P;
			};
			if (dwell) {
				// beam parked on the tapped spot: the figure stops being drawn
				const pt = [dwell.x, dwell.y, 1];
				if (!dwell.entered) {
					project(head, lerpP(0), ph);
					push(ph, pt, energy(0.0015), energy(0.0015));
					dwell.entered = true;
				}
				const take = Math.min(dt, dwell.left);
				push(pt, pt, energy(take), energy(take));
				dwell.left -= dt;
				if (dwell.left <= 0) {
					project(head, lerpP(1), ph);
					push(pt, ph, energy(0.0015), energy(0.0015));
					dwell = null;
				}
			} else {
				const h0 = head, h1 = head + (dt / T_TRACE) * N;
				project(h0, lerpP(0), pa);
				let x = h0;
				while (x < h1 && count < MAX_SEG) {
					const nxt = Math.min(Math.floor(x) + 1, h1);
					project(nxt, lerpP((nxt - h0) / (h1 - h0)), pb);
					// a Lissajous is a shorter path than the Q, so the same beam would burn it brighter
					const e = energy(((nxt - x) * T_TRACE) / N) * (1 - 0.4 * P.M);
					push(pa, pb, e, e);
					pa[0] = pb[0]; pa[1] = pb[1]; pa[2] = pb[2];
					x = nxt;
				}
				head = h1 >= N ? h1 - N : h1;
			}
			Object.assign(P0, P1);
		}

		// ---- persistence ----
		gl.disable(gl.DEPTH_TEST);
		gl.viewport(0, 0, ctx.w, ctx.h);
		if (still) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, pA!.fbo);
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
		} else {
			gl.bindFramebuffer(gl.FRAMEBUFFER, pB!.fbo);
			gl.useProgram(progFade);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, pA!.tex);
			gl.uniform1i(uFade.src, 0);
			gl.uniform3f(uFade.decay, Math.exp(-dt / TAU_F), Math.exp(-dt / TAU_G), half ? 1e-5 : 0.6 / 255);
			gl.bindVertexArray(empty);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			[pA, pB] = [pB, pA];
		}
		if (count) {
			gl.useProgram(progBeam);
			gl.uniform2f(uBeam.res, ctx.w, ctx.h);
			gl.bindVertexArray(beamVao);
			gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, count * 8);
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ONE, gl.ONE);
			gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
			gl.disable(gl.BLEND);
		}

		// ---- halo: separable blur at half res ----
		gl.useProgram(progBlur);
		gl.bindVertexArray(empty);
		gl.uniform1i(uBlur.src, 0);
		gl.activeTexture(gl.TEXTURE0);
		// pass 1 reads full res at half-res texel centres: a 2x2 box downsample for free
		const blur = (src: Target, dst: Target, sx: number, sy: number) => {
			gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
			gl.bindTexture(gl.TEXTURE_2D, src.tex);
			gl.uniform2f(uBlur.step, sx / dst.w, sy / dst.h);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		};
		gl.viewport(0, 0, hA!.w, hA!.h);
		gl.uniform2f(uBlur.out, hA!.w, hA!.h);
		const wide = 1.2 + 1.2 * ctx.dpr;
		blur(pA!, hA!, 1, 0);
		blur(hA!, hB!, 0, 1);
		blur(hB!, hA!, wide, 0);
		blur(hA!, hB!, 0, wide);

		// ---- composite ----
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, ctx.w, ctx.h);
		gl.useProgram(progComp);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, pA!.tex);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, hB!.tex);
		gl.uniform1i(uComp.p, 0);
		gl.uniform1i(uComp.h, 1);
		gl.uniform2f(uComp.res, ctx.w, ctx.h);
		gl.uniform4f(uComp.grid, cx, cy, div, ctx.dpr);
		gl.uniform2f(uComp.count, nx, ny);
		gl.uniform3f(uComp.gain, 0.6, 0.48, 0.4);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindVertexArray(null);
	};

	return {
		frame,
		resize,
		tap: (x, y) => {
			dwell = { x: ((x + 1) / 2) * ctx.w, y: ((y + 1) / 2) * ctx.h, left: 0.22, t: lastT, entered: false };
		},
		destroy: () => {
			[pA, pB, hA, hB].forEach(freeTarget);
			gl.deleteBuffer(instBuf);
			gl.deleteVertexArray(beamVao);
			gl.deleteVertexArray(empty);
			[progFade, progBeam, progBlur, progComp].forEach((p) => gl.deleteProgram(p));
		}
	};
};
