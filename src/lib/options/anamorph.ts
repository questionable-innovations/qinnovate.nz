// Anamorphosis: a cloud of hairline fragments that only resolves into the Q
// from one secret viewpoint V. Every fragment is a piece of an engraved Q
// (outline + hatching) slid along the rays from V to a random depth, so from V
// the projection is exact and from anywhere else it is a wire scribble.

import { m4, rng, vao, type Setup } from '$lib/stage';

export const GROUND = '#13151c';
const LIGHT = [0.914, 0.918, 0.945];
const DIM = [0.412, 0.431, 0.51];

// secret viewpoint sits on +z at distance D, looking at the Q plane (z = 0)
const D = 3.4;

// ---- the Q, as in glyph.frag ----
const R = 0.36;
const W = 0.072;
const C = [-0.03, 0.05]; // x nudged so the glyph's bbox is centred
const DIR = [0.68, -0.73];
const TA = [C[0] + DIR[0] * 0.3, C[1] + DIR[1] * 0.3];
const TB = [C[0] + DIR[0] * 0.64, C[1] + DIR[1] * 0.64];

function sdSeg(px: number, py: number) {
	const ax = px - TA[0], ay = py - TA[1], bx = TB[0] - TA[0], by = TB[1] - TA[1];
	const h = Math.max(0, Math.min(1, (ax * bx + ay * by) / (bx * bx + by * by)));
	return Math.hypot(ax - bx * h, ay - by * h);
}
function smin(a: number, b: number, k: number) {
	const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
	return b + (a - b) * h - k * h * (1 - h);
}
function glyph(px: number, py: number) {
	const bowl = Math.abs(Math.hypot(px - C[0], py - C[1]) - R) - W;
	const tail = sdSeg(px, py) - W * 0.92;
	return smin(bowl, tail, 0.05);
}
function grad(px: number, py: number): [number, number] {
	const e = 1e-4;
	return [
		(glyph(px + e, py) - glyph(px - e, py)) / (2 * e),
		(glyph(px, py + e) - glyph(px, py - e)) / (2 * e)
	];
}

/** walk the zero set of the glyph field from a start point, returns a closed polyline */
function contour(sx: number, sy: number, h = 0.003): number[][] {
	let p = [sx, sy];
	const settle = () => {
		for (let i = 0; i < 3; i++) {
			const f = glyph(p[0], p[1]);
			const [gx, gy] = grad(p[0], p[1]);
			const g2 = gx * gx + gy * gy || 1;
			p = [p[0] - (f * gx) / g2, p[1] - (f * gy) / g2];
		}
	};
	settle();
	const start = [...p];
	const pts = [[...p]];
	let len = 0;
	for (let i = 0; i < 6000; i++) {
		const [gx, gy] = grad(p[0], p[1]);
		const gl = Math.hypot(gx, gy) || 1;
		p = [p[0] - (gy / gl) * h, p[1] + (gx / gl) * h];
		settle();
		len += h;
		if (len > 0.1 && Math.hypot(p[0] - start[0], p[1] - start[1]) < h * 1.2) break;
		pts.push([...p]);
	}
	pts.push([...start]);
	return pts;
}

/** parallel rules across the glyph, clipped to its inside */
function hatches(spacing: number, n = [0.42, 1], keep = (_x: number, _y: number) => true): number[][][] {
	const nl = Math.hypot(n[0], n[1]);
	n[0] /= nl;
	n[1] /= nl;
	const d = [n[1], -n[0]];
	const out: number[][][] = [];
	const step = 0.002;
	const at = (k: number, t: number) => [n[0] * k + d[0] * t, n[1] * k + d[1] * t];
	const refine = (k: number, t0: number, t1: number) => {
		// t0 outside, t1 inside (or vice versa); bisect to the edge
		let a = t0, b = t1;
		const inQ = (t: number) => {
			const [x, y] = at(k, t);
			return glyph(x, y) < 0 && keep(x, y);
		};
		const fa = inQ(a);
		for (let i = 0; i < 20; i++) {
			const m = (a + b) / 2;
			if (inQ(m) === fa) a = m;
			else b = m;
		}
		return (a + b) / 2;
	};
	const kc = n[0] * C[0] + n[1] * C[1];
	for (let k = kc - 0.62; k < kc + 0.62; k += spacing) {
		let inside = false, t0 = 0;
		for (let t = -0.9; t <= 0.9; t += step) {
			const [x, y] = at(k, t);
			const now = glyph(x, y) < 0 && keep(x, y);
			if (now && !inside) t0 = refine(k, t - step, t);
			if (!now && inside) {
				const t1 = refine(k, t - step, t);
				if (t1 - t0 > 0.006) out.push([at(k, t0), at(k, t1)]);
			}
			inside = now;
		}
	}
	return out;
}

/** build the sculpture: chop polylines into fragments and push them along rays from V */
function build() {
	const rand = rng(0x51a7);
	const pos: number[] = [];
	const info: number[] = [];
	const lnLo = Math.log(0.58), lnHi = Math.log(1.55);
	const depth = () => {
		// keep a thin band clear around the true plane so the Q never shows off-axis
		let l = 0;
		do l = lnLo + (lnHi - lnLo) * rand();
		while (Math.abs(l) < 0.05);
		return Math.exp(l);
	};
	const put = (x: number, y: number, s: number, r: number, kind: number) => {
		pos.push(x * s, y * s, D * (1 - s));
		info.push(s, r, kind);
	};

	const chop = (line: number[][], kind: number, lo: number, hi: number, gap: number) => {
		// cumulative length
		const cum = [0];
		for (let i = 1; i < line.length; i++)
			cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
		const total = cum[cum.length - 1];
		const sample = (L: number) => {
			let i = 1;
			while (i < cum.length - 1 && cum[i] < L) i++;
			const f = (L - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
			return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f, i];
		};
		let L = rand() * lo * 0.5;
		while (L < total - 0.004) {
			const len = Math.min(lo + (hi - lo) * rand(), total - L);
			const a = L, b = L + len;
			const sa = depth();
			const sb = sa * Math.exp((rand() - 0.5) * 0.22);
			const r = rand() < 0.28 ? 0.35 + rand() * 0.2 : 0.75 + rand() * 0.25;
			// points of this fragment: start, interior vertices, end
			const pts: number[][] = [];
			const [ax, ay, ai] = sample(a);
			const [bx, by, bi] = sample(b);
			pts.push([ax, ay, a]);
			for (let i = ai; i < bi; i++) pts.push([line[i][0], line[i][1], cum[i]]);
			pts.push([bx, by, b]);
			for (let i = 1; i < pts.length; i++) {
				const s0 = sa + (sb - sa) * ((pts[i - 1][2] - a) / (len || 1));
				const s1 = sa + (sb - sa) * ((pts[i][2] - a) / (len || 1));
				put(pts[i - 1][0], pts[i - 1][1], s0, r, kind);
				put(pts[i][0], pts[i][1], s1, r, kind);
			}
			L = b + gap;
		}
	};

	chop(contour(C[0] - R - W, C[1]), 1, 0.03, 0.07, 0.004);
	chop(contour(C[0] - R + W, C[1]), 1, 0.03, 0.07, 0.004);
	for (const h of hatches(1 / 56)) chop(h, 0, 0.022, 0.06, 0.003);
	// cross-hatching on the shadowed side of the ring and down the tail, feathered edge
	const shade = (x: number, y: number) => {
		const dx = x - C[0], dy = y - C[1];
		const l = Math.hypot(dx, dy) || 1;
		const lit = (dx * 0.62 - dy * 0.78) / l; // towards lower right
		const feather = Math.sin(x * 91.7 + y * 53.3) * 0.12;
		return lit + feather > 0.25;
	};
	for (const h of hatches(1 / 44, [1, -0.36], shade)) chop(h, 0, 0.022, 0.06, 0.003);

	return { pos: new Float32Array(pos), info: new Float32Array(info) };
}

const VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aInfo; // depth scale s, alpha, kind (1 outline, 0 hatch)
uniform mat4 uVP;
uniform vec3 uEye;
uniform vec3 uV;
uniform vec2 uRes;
uniform float uPx;
uniform float uNear; // global nearness to V, 0..1
uniform float uDist; // camera distance to the Q plane centre
out vec4 vCol;
const vec3 LIGHT = vec3(${LIGHT.join(',')});
const vec3 DIM = vec3(${DIM.join(',')});
void main() {
	vec4 cp = uVP * vec4(aPos, 1.0);
	gl_Position = cp;
	// where this point would sit if it lay on the Q plane: its image from V
	vec3 home = uV + (aPos - uV) / aInfo.x;
	vec4 ch = uVP * vec4(home, 1.0);
	float err = length((cp.xy / max(cp.w, 1e-3) - ch.xy / ch.w) * uRes * 0.5) / uPx;
	float al = exp(-err / 5.0);
	float dist = length(aPos - uEye);
	float near = clamp(0.55 - (dist - uDist) / 3.2, 0.0, 1.0);
	float fade = mix(0.16, 1.0, pow(near, 1.4));
	float kind = aInfo.z;
	vec3 col = mix(DIM, LIGHT, clamp(0.18 + al * 0.82 + kind * 0.2 + uNear * 0.1, 0.0, 1.0));
	float a = mix(0.56 + 0.2 * kind, 1.0, al) * mix(fade, 1.0, al * 0.7) * aInfo.y;
	vCol = vec4(col, a);
}`;

const FS = `#version 300 es
precision mediump float;
in vec4 vCol;
out vec4 o;
void main() { o = vCol; }`;

// idle camera: a rosette of petals around V, touching V once per cycle with a short dwell
const T = 19;
const DWELL = 1.8;
function hash(k: number) {
	const x = Math.sin(k * 127.1 + 311.7) * 43758.5453;
	return x - Math.floor(x);
}
function idle(t: number): [number, number] {
	const k = Math.floor(t / T);
	const u = t - k * T;
	const w = Math.max(0, Math.min(1, (u - DWELL) / (T - DWELL)));
	const amp = 0.34 + 0.22 * hash(k);
	const spin = hash(k + 17) < 0.5 ? -1 : 1;
	const th = k * 2.39996 + 0.6 + (w - 0.5) * 1.6 * spin;
	const a = amp * Math.sin(Math.PI * w) ** 2;
	return [a * Math.cos(th), a * Math.sin(th) * 0.6];
}

export const setup: Setup = (ctx) => {
	const { gl } = ctx;
	const prog = ctx.program(VS, FS);
	const { pos, info } = build();
	const va = vao(gl, { 0: [pos, 3], 1: [info, 3] });
	const count = pos.length / 3;
	const u = (n: string) => gl.getUniformLocation(prog, n);
	const uVP = u('uVP'), uEye = u('uEye'), uV = u('uV'), uRes = u('uRes'), uPx = u('uPx'), uNear = u('uNear'), uDist = u('uDist');

	// dev-only review hooks: ?at=<idle seconds> freezes the drift, ?still forces reduced motion
	const q = import.meta.env.DEV ? new URLSearchParams(location.search) : null;
	const at = q?.get('at');
	const still = q?.has('still');

	let mode: 'idle' | 'user' = 'idle';
	let it = T - 6.5; // start drifting in, first alignment after ~6.5 s
	let lastTouch = -1e9;
	const rest = { x: 0, y: 0 };
	const TAU = Math.PI * 2;

	return {
		frame(t, dt) {
			if (still) ctx.motion = 0;
			if (at) it = +at - dt;
			const o = ctx.orbit;
			const moving = Math.abs(o.vyaw) + Math.abs(o.vpitch) > 0.02;
			if (o.dragging || moving) lastTouch = t;

			// yaw/pitch offset of the camera from V
			let yaw: number, pitch: number;
			if (mode === 'idle') {
				if (o.dragging) mode = 'user';
				else {
					if (ctx.motion) it += dt;
					const [iy, ip] = ctx.motion ? idle(it) : [0.045, 0.028];
					// keep orbit in step so a drag picks up exactly where the drift is
					o.yaw = -iy;
					o.pitch = ip;
					o.vyaw = o.vpitch = 0;
				}
			}
			if (mode === 'user' && !o.dragging) {
				const ty = Math.round(o.yaw / TAU) * TAU;
				const off = Math.hypot(o.yaw - ty, o.pitch);
				// a faint magnet near the secret viewpoint
				if (off < 0.07 && !moving) {
					const k = 1 - Math.exp(-dt * 3);
					o.yaw += (ty - o.yaw) * k;
					o.pitch += -o.pitch * k;
				}
				// left alone for a while: drift home to V, then resume the idle rosette
				if (ctx.motion && t - lastTouch > 7) {
					const k = 1 - Math.exp(-dt * 0.9);
					o.yaw += (ty - o.yaw) * k;
					o.pitch += -o.pitch * k;
					if (Math.hypot(o.yaw - ty, o.pitch) < 0.0015) {
						o.yaw = 0;
						o.pitch = 0;
						mode = 'idle';
						it = Math.ceil(it / T) * T;
					}
				}
			}
			yaw = -o.yaw;
			pitch = o.pitch;

			// pointer: a relative parallax that relaxes back, so a resting cursor never blocks alignment
			const p = ctx.pointer;
			const kr = 1 - Math.exp(-dt / 2.2);
			rest.x += (p.x - rest.x) * kr;
			rest.y += (p.y - rest.y) * kr;
			if (ctx.motion) {
				yaw += (p.x - rest.x) * 0.3;
				pitch -= (p.y - rest.y) * 0.2;
			}

			// step back as the view swings off-axis, so from the side the sculpture reads as an object
			const cp = Math.cos(pitch);
			const off = 1 - Math.cos(yaw) * cp;
			const dist = D * (1 + 0.8 * Math.min(off, 1));
			const eye = [dist * Math.sin(yaw) * cp, dist * Math.sin(pitch), dist * Math.cos(yaw) * cp];
			// off-axis, aim a little into the near half of the cloud so it stays centred on screen
			const aim = 0.45 * Math.min(1, off * 8);
			const aspect = ctx.w / ctx.h;
			// frame the Q in the short side: ~1.05 half-height landscape, ~0.88 half-width portrait
			const half = aspect >= 1 ? 1.05 : 0.88 / aspect;
			const fov = 2 * Math.atan(half / D);
			const vp = m4.mul(m4.perspective(fov, aspect, 0.05, 40), m4.lookAt(eye, [0, 0, aim]));

			const ang = Math.acos(Math.max(-1, Math.min(1, eye[2] / dist)));
			const near = Math.exp(-((ang / 0.12) ** 2));

			gl.clearColor(0.075, 0.082, 0.11, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
			gl.useProgram(prog);
			gl.uniformMatrix4fv(uVP, false, vp);
			gl.uniform3fv(uEye, eye);
			gl.uniform3f(uV, 0, 0, D);
			gl.uniform2f(uRes, ctx.w, ctx.h);
			gl.uniform1f(uPx, ctx.dpr);
			gl.uniform1f(uNear, near);
			gl.uniform1f(uDist, dist);
			gl.bindVertexArray(va);
			gl.drawArrays(gl.LINES, 0, count);
		},
		destroy() {
			gl.deleteVertexArray(va);
			gl.deleteProgram(prog);
		}
	};
};
