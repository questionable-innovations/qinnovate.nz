// Stackup: an exploded four-layer printed circuit board, drawn only in
// hairlines and dots. Top: footprints and their fanout; inner 1: a hatched
// ground plane full of clearance holes; inner 2: long buses; bottom: sparse.
// Through-vias tie the layers together with thin verticals. On the top layer
// one group of traces is routed as an octagonal Q: a four-trace guard ring
// that jumps under its own tail on the bottom layer.
//
// Routing is procedural (seeded): pad rows fan out, then a lane-group walker
// moves whole buses in 45°/90° steps with mitred offsets, avoiding other nets
// through a coarse occupancy grid, dropping through vias between stages.
// Signal pulses are computed in the fragment shaders from per-vertex arc
// length, so a frame costs no CPU work beyond a handful of uniforms.

import { m4, rng, type M4, type Setup } from '$lib/stage';

export const GROUND = '#13151c';

type V2 = [number, number];
/** u, v on the board, layer index (0 = top) */
type Pt = [number, number, number];

const C_GROUND = [0.075, 0.082, 0.11];
const C_LIGHT = [0.914, 0.918, 0.945];
const C_DIM = [0.412, 0.431, 0.51];
const C_GOLD = [0.784, 0.663, 0.416];
const mix3 = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i] - x) * t);

/** routing pitch, board units (the board spans -1..1) */
const G = 0.025;
/** arc length credited to one layer hop */
const HOP = 0.7;
const S2 = Math.SQRT1_2;
const DIRS: V2[] = [
	[1, 0], [S2, S2], [0, 1], [-S2, S2],
	[-1, 0], [-S2, -S2], [0, -1], [S2, -S2]
];
const CHAMFER = 0.09;
const KEEP = 0.885;
const VIA_R = 0.0105;
const PAD_R = 0.0072;

const FOV = 22 * (Math.PI / 180);
const YAW0 = 0.4;
/** pulse clock used for the reduced-motion still */
const T_STILL = 41.3;

// colours (rgb, alpha)
const TRACE = [
	[...mix3(C_DIM, C_LIGHT, 0.88), 0.9],
	[...C_DIM, 0.55],
	[...mix3(C_DIM, C_LIGHT, 0.5), 0.72],
	[...mix3(C_DIM, C_LIGHT, 0.22), 0.62]
];
const OUTLINE = [
	[...C_LIGHT, 0.6],
	[...mix3(C_DIM, C_LIGHT, 0.3), 0.5],
	[...mix3(C_DIM, C_LIGHT, 0.3), 0.5],
	[...mix3(C_DIM, C_LIGHT, 0.2), 0.45]
];
const HATCH = [...C_DIM, 0.26];
const VERT = [...C_DIM, 0.2];
const VERT_GND = [...C_DIM, 0.12];
const RULE = [...C_DIM, 0.4];
const PAD = [...C_GOLD, 0.82];
const VIA = [...C_GOLD, 0.62];
const VIA_IDLE = [...C_GOLD, 0.3];
const VEIL_A = 0.42;

// ---------------------------------------------------------------- geometry

type Built = {
	segs: number[][]; // 0..3 layers, 4..6 gaps below layer k
	dots: number[][]; // per layer
	picks: { u: number; v: number; l: number; g: number; f: number }[];
};

function lanePaths(lead: V2[], offs: number[]): V2[][] {
	const n: V2[] = [];
	for (let k = 0; k < lead.length - 1; k++) {
		const dx = lead[k + 1][0] - lead[k][0], dy = lead[k + 1][1] - lead[k][1];
		const l = Math.hypot(dx, dy) || 1;
		n.push([-dy / l, dx / l]);
	}
	return offs.map((o) =>
		lead.map((P, k): V2 => {
			if (k === 0) return [P[0] + n[0][0] * o, P[1] + n[0][1] * o];
			if (k === lead.length - 1) return [P[0] + n[k - 1][0] * o, P[1] + n[k - 1][1] * o];
			const a = n[k - 1], b = n[k];
			const s = o / (1 + a[0] * b[0] + a[1] * b[1]);
			return [P[0] + (a[0] + b[0]) * s, P[1] + (a[1] + b[1]) * s];
		})
	);
}

function build(seed: number): Built {
	const R = rng(seed);
	const rnd = (a: number, b: number) => a + (b - a) * R();

	// ---- occupancy: one grid per layer, cells hold group id + 1
	const CELL = 0.01, N = 200, WALL = 1 << 30;
	const occ = [0, 1, 2, 3].map(() => new Int32Array(N * N));
	for (const o of occ)
		for (let j = 0; j < N; j++)
			for (let i = 0; i < N; i++) {
				const u = -1 + (i + 0.5) * CELL, v = -1 + (j + 0.5) * CELL;
				if (Math.abs(u) > KEEP || Math.abs(v) > KEEP) o[j * N + i] = WALL;
			}
	const disc = (l: number, u: number, v: number, r: number, gid: number, mark: boolean) => {
		if (!mark && (Math.abs(u) > 1 || Math.abs(v) > 1)) return false;
		const rr = (r + CELL * 0.5) ** 2;
		const i0 = Math.max(0, Math.floor((u - r + 1) / CELL)), i1 = Math.min(N - 1, Math.floor((u + r + 1) / CELL));
		const j0 = Math.max(0, Math.floor((v - r + 1) / CELL)), j1 = Math.min(N - 1, Math.floor((v + r + 1) / CELL));
		const o = occ[l];
		for (let j = j0; j <= j1; j++)
			for (let i = i0; i <= i1; i++) {
				const cu = -1 + (i + 0.5) * CELL - u, cv = -1 + (j + 0.5) * CELL - v;
				if (cu * cu + cv * cv > rr) continue;
				const k = j * N + i;
				if (mark) {
					if (o[k] === 0) o[k] = gid + 1;
				} else if (o[k] !== 0 && o[k] !== gid + 1) return false;
			}
		return true;
	};
	const seg = (l: number, a: V2, b: V2, r: number, gid: number, mark: boolean) => {
		const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL * 0.5)));
		for (let i = 0; i <= n; i++) {
			const t = i / n;
			if (!disc(l, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, r, gid, mark) && !mark) return false;
		}
		return true;
	};
	const MARK = 0.004, CHECK = 0.022;
	const viaClear = (u: number, v: number, gid: number, r = 0.02) => [0, 1, 2, 3].every((l) => disc(l, u, v, r, gid, false));
	const viaMark = (u: number, v: number, gid: number, r = 0.012) => [0, 1, 2, 3].forEach((l) => disc(l, u, v, r, gid, true));

	// ---- nets and groups
	type Net = { id: number; g: number; pts: Pt[]; pads: { i: number; r: number }[] };
	type Grp = { period: number; phase: number; rev: number };
	const nets: Net[] = [];
	const groups: Grp[] = [];
	const newGroup = (pulse = true) => {
		groups.push({ period: pulse ? rnd(12, 28) : 0, phase: R(), rev: R() < 0.5 ? 1 : 0 });
		return groups.length - 1;
	};
	const newNet = (g: number, p: Pt): Net => {
		const n: Net = { id: nets.length, g, pts: [p], pads: [] };
		nets.push(n);
		return n;
	};
	const tip = (n: Net) => n.pts[n.pts.length - 1];
	const lineTo = (n: Net, u: number, v: number) => {
		const p = tip(n);
		if (Math.hypot(u - p[0], v - p[1]) > 1e-6) n.pts.push([u, v, p[2]]);
	};
	const pad = (n: Net, r = PAD_R) => n.pads.push({ i: n.pts.length - 1, r });

	type Via = { u: number; v: number; net: number; kind: 0 | 1 | 2 };
	const vias: Via[] = [];
	const hop = (n: Net, to: number) => {
		const p = tip(n);
		vias.push({ u: p[0], v: p[1], net: n.id, kind: 0 });
		viaMark(p[0], p[1], n.g);
		const s = to > p[2] ? 1 : -1;
		for (let l = p[2] + s; s > 0 ? l <= to : l >= to; l += s) n.pts.push([p[0], p[1], l]);
	};
	const holes: V2[] = [[-0.855, -0.855], [0.855, -0.855], [-0.855, 0.855], [0.855, 0.855]];
	for (const h of holes) for (let l = 0; l < 4; l++) disc(l, h[0], h[1], 0.11, -2, true);

	/** component bodies drawn as a faint outline, with a pin-1 dot */
	const bodies: [number, number, number, number][] = [];

	// ---- lane-group walker
	type Walk = { steps: number; run: [number, number]; diag: [number, number]; turn: number };
	const walk = (gid: number, l: number, starts: V2[], d0: number, o: Walk) => {
		const d = DIRS[d0], nrm: V2 = [-d[1], d[0]];
		const cx = starts.reduce((s, p) => s + p[0], 0) / starts.length;
		const cy = starts.reduce((s, p) => s + p[1], 0) / starts.length;
		const offs = starts.map((s) => (s[0] - cx) * nrm[0] + (s[1] - cy) * nrm[1]);
		const amax = Math.max(...starts.map((s) => (s[0] - cx) * d[0] + (s[1] - cy) * d[1]));
		const lead: V2[] = [[cx + d[0] * amax, cy + d[1] * amax]];
		const dirs: number[] = [];
		const ok = (cand: V2[]) => {
			const lanes = lanePaths(cand, offs);
			const m = cand.length - 1;
			for (let i = 0; i < lanes.length; i++) {
				const ln = lanes[i];
				if (!seg(l, ln[m - 1], ln[m], CHECK, gid, false)) return false;
				if (m >= 2 && !seg(l, ln[m - 2], ln[m - 1], CHECK, gid, false)) return false;
				if (m === 1 && !seg(l, starts[i], ln[0], CHECK, gid, false)) return false;
			}
			return true;
		};
		const tryMove = (dir: number, lens: number[]) => {
			const P = lead[lead.length - 1];
			for (const L of lens) {
				const c: V2[] = [...lead, [P[0] + DIRS[dir][0] * L, P[1] + DIRS[dir][1] * L]];
				if (ok(c)) {
					lead.push(c[c.length - 1]);
					dirs.push(dir);
					return true;
				}
			}
			return false;
		};
		const turned = (x: number) => ((x - d0 + 12) % 8) - 4;
		let cur = d0;
		for (let s = 0; s < o.steps; s++) {
			let cands = s === 0 ? [d0] : [(cur + 1) % 8, (cur + 7) % 8];
			if (R() < 0.5) cands.reverse();
			cands = cands.filter((c) => Math.abs(turned(c)) <= o.turn);
			let moved = false;
			for (const c of cands) {
				const [a, b] = c % 2 ? o.diag : o.run;
				const L = rnd(a, b);
				if (tryMove(c, [L, L * 0.7, L * 0.45, a * 0.6])) {
					cur = c;
					moved = true;
					break;
				}
			}
			if (!moved) break;
		}
		// finish on a straight: buses end square to their via rows
		if (cur % 2 && dirs.length) {
			for (const c of R() < 0.5 ? [(cur + 1) % 8, (cur + 7) % 8] : [(cur + 7) % 8, (cur + 1) % 8]) {
				if (Math.abs(turned(c)) <= o.turn && tryMove(c, [0.08, 0.05])) {
					cur = c;
					break;
				}
			}
		}
		if (!dirs.length) return null;
		const lanes = lanePaths(lead, offs).map((ln, i) =>
			Math.hypot(ln[0][0] - starts[i][0], ln[0][1] - starts[i][1]) > 1e-6 ? [starts[i], ...ln] : ln
		);
		const len = lead.reduce((s, p, k) => (k ? s + Math.hypot(p[0] - lead[k - 1][0], p[1] - lead[k - 1][1]) : 0), 0);
		return { lanes, dir: cur, len };
	};

	type Stage = { l: number; steps: number; end: 'via' | 'pad'; run?: [number, number]; diag?: [number, number]; turn?: number; min?: number };
	const chain = (gid: number, ns: Net[], starts: V2[], d0: number, stages: Stage[]) => {
		let pos = starts, dir = d0;
		for (let k = 0; k < stages.length; k++) {
			const st = stages[k];
			const opt: Walk = { steps: st.steps, run: st.run ?? [0.12, 0.42], diag: st.diag ?? [0.04, 0.16], turn: st.turn ?? 2 };
			let best: { lanes: V2[][]; dir: number; len: number } | null = null;
			let ends: V2[] | null = null;
			for (let tries = 0; tries < 40 && !ends; tries++) {
				const d = k > 0 && R() < 0.45 ? (dir + 4) % 8 : dir;
				const w = walk(gid, st.l, pos, d, opt);
				if (!w || w.len < (st.min ?? 0.1)) continue;
				const e = w.lanes.map((ln) => ln[ln.length - 1]);
				if (st.end === 'via') {
					const pitch = e.length > 1 ? Math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]) : 1;
					const dd = DIRS[w.dir];
					const stag = pitch < 0.034 ? 0.032 : 0;
					const ve = e.map((p, i): V2 => [p[0] + dd[0] * (i % 2) * stag, p[1] + dd[1] * (i % 2) * stag]);
					if (ve.every((p) => viaClear(p[0], p[1], gid)) && ve.every((p, i) => seg(st.l, e[i], p, CHECK, gid, false))) {
						best = w;
						ends = ve;
					}
				} else if (e.every((p) => disc(st.l, p[0], p[1], 0.016, gid, false))) {
					best = w;
					ends = e;
				}
			}
			if (!best || !ends) {
				if (st.l === 0 || st.l === 3) ns.forEach((n) => pad(n));
				return;
			}
			best.lanes.forEach((ln, i) => {
				const n = ns[i];
				for (let j = 1; j < ln.length; j++) {
					lineTo(n, ln[j][0], ln[j][1]);
					seg(st.l, ln[j - 1], ln[j], MARK, gid, true);
				}
				lineTo(n, ends![i][0], ends![i][1]);
				seg(st.l, ln[ln.length - 1], ends![i], MARK, gid, true);
				if (st.end === 'via') hop(n, stages[k + 1]?.l ?? (st.l === 0 ? 3 : 0));
				else pad(n);
			});
			pos = ends;
			dir = best.dir;
			if (st.end === 'pad') return;
		}
	};

	// pad row + fanout, returns nets and fan-front points
	const padRow = (l: number, c: V2, dir: number, n: number, pitch: number, f: number, a0: number, a1: number, padR = PAD_R) => {
		const gid = newGroup();
		const d = DIRS[dir], t: V2 = [-d[1], d[0]];
		const ns: Net[] = [], ends: V2[] = [];
		const maxD = ((n - 1) / 2) * pitch * (f - 1);
		for (let i = 0; i < n; i++) {
			const o = (i - (n - 1) / 2) * pitch;
			const p: V2 = [c[0] + t[0] * o, c[1] + t[1] * o];
			const net = newNet(gid, [p[0], p[1], l]);
			pad(net, padR);
			const dl = Math.abs(o) * (f - 1), sg = Math.sign(o);
			let q: V2 = [p[0] + d[0] * a0, p[1] + d[1] * a0];
			lineTo(net, q[0], q[1]);
			if (dl > 1e-6) {
				q = [q[0] + (d[0] + t[0] * sg) * dl, q[1] + (d[1] + t[1] * sg) * dl];
				lineTo(net, q[0], q[1]);
			}
			q = [q[0] + d[0] * (maxD - dl + a1), q[1] + d[1] * (maxD - dl + a1)];
			lineTo(net, q[0], q[1]);
			for (let j = 1; j < net.pts.length; j++) seg(l, net.pts[j - 1] as unknown as V2, net.pts[j] as unknown as V2, MARK, gid, true);
			disc(l, p[0], p[1], padR + 0.004, gid, true);
			ns.push(net);
			ends.push(q);
		}
		return { gid, ns, ends };
	};

	// ================================================================ layout

	// stitching vias along the edge (ground), and board keepouts
	for (let s = -0.72; s <= 0.721; s += 0.12)
		for (const [u, v] of [[s, 0.945], [s, -0.945], [0.945, s], [-0.945, s]] as V2[]) {
			vias.push({ u, v, net: -1, kind: 1 });
		}

	// ---- the Q: four-trace octagonal guard ring, tail of four traces
	{
		const Rq = 0.2, S = Rq / 0.36;
		const c: V2 = [0.4, -0.37];
		const ringG = newGroup();
		groups[ringG].period = 26;
		const td: V2 = [S2, -S2], tn: V2 = [S2, S2];
		const offs = [-1.5, -0.5, 0.5, 1.5].map((x) => x * G);
		offs.forEach((o, i) => {
			const a = Rq + o, rho = a / Math.cos(Math.PI / 8);
			const M: V2 = [c[0] + td[0] * a, c[1] + td[1] * a];
			const gg = 0.064 + (i % 2) * 0.024;
			const B: V2 = [M[0] + tn[0] * gg, M[1] + tn[1] * gg];
			const A: V2 = [M[0] - tn[0] * gg, M[1] - tn[1] * gg];
			const n = newNet(ringG, [B[0], B[1], 0]);
			for (const k of [7, 0, 1, 2, 3, 4, 5, 6]) {
				const th = Math.PI / 8 + (k * Math.PI) / 4;
				lineTo(n, c[0] + Math.cos(th) * rho, c[1] + Math.sin(th) * rho);
			}
			lineTo(n, A[0], A[1]);
			hop(n, 3);
			lineTo(n, B[0], B[1]);
			hop(n, 0);
			for (let j = 1; j < n.pts.length; j++) {
				const p = n.pts[j - 1], q = n.pts[j];
				if (p[2] === q[2]) seg(p[2], [p[0], p[1]], [q[0], q[1]], MARK, ringG, true);
			}
		});
		// keep the counter of the Q clear
		disc(0, c[0], c[1], Rq - 2 * G - 0.01, -3, true);
		const tailG = newGroup();
		const ns: Net[] = [], ends: V2[] = [];
		offs.forEach((o, i) => {
			const r0 = 0.3 * S, r1 = 0.64 * S - (i % 2) * 0.03;
			const p0: V2 = [c[0] + td[0] * r0 + tn[0] * o, c[1] + td[1] * r0 + tn[1] * o];
			const p1: V2 = [c[0] + td[0] * r1 + tn[0] * o, c[1] + td[1] * r1 + tn[1] * o];
			const n = newNet(tailG, [p0[0], p0[1], 0]);
			pad(n, 0.0055);
			lineTo(n, p1[0], p1[1]);
			seg(0, p0, p1, MARK, tailG, true);
			hop(n, 2);
			ns.push(n);
			ends.push(p1);
		});
		chain(tailG, ns, ends, 7, [
			{ l: 2, steps: 5, end: 'via', min: 0.7 },
			{ l: 3, steps: 2, end: 'pad', run: [0.08, 0.2] }
		]);
	}

	// ---- U1: QFP-32
	{
		const c: V2 = [-0.36, 0.3], D = 0.125;
		bodies.push([c[0], c[1], D - 0.03, D - 0.03]);
		for (let l = 0; l < 1; l++)
			for (let j = -1; j <= 1; j += 0.02) for (let i = -1; i <= 1; i += 0.02) disc(l, c[0] + i * (D - 0.02), c[1] + j * (D - 0.02), 0.01, -4, true);
		const plan: [number, Stage[]][] = [
			[0, [{ l: 0, steps: 2, end: 'via', run: [0.06, 0.16] }, { l: 2, steps: 6, end: 'via', min: 0.9 }, { l: 3, steps: 2, end: 'pad', run: [0.06, 0.18] }]],
			[2, [{ l: 0, steps: 4, end: 'via', min: 0.3 }, { l: 2, steps: 5, end: 'via', min: 0.6 }, { l: 0, steps: 1, end: 'pad', run: [0.04, 0.1] }]],
			[4, [{ l: 0, steps: 2, end: 'via', run: [0.05, 0.12] }, { l: 2, steps: 5, end: 'via', min: 0.8 }, { l: 3, steps: 2, end: 'pad', run: [0.06, 0.2] }]],
			[6, [{ l: 0, steps: 3, end: 'via', min: 0.2 }, { l: 2, steps: 4, end: 'via', min: 0.5 }, { l: 3, steps: 2, end: 'pad', run: [0.05, 0.16] }]]
		];
		for (const [dir, stages] of plan) {
			const d = DIRS[dir];
			const row = padRow(0, [c[0] + d[0] * D, c[1] + d[1] * D], dir, 8, G, 1.75, 0.012, 0.02);
			chain(row.gid, row.ns, row.ends, dir, stages);
		}
	}

	// ---- U2: SOIC-8
	{
		const c: V2 = [0.46, 0.5];
		bodies.push([c[0], c[1], 0.1, 0.05]);
		for (let i = -1; i <= 1; i += 0.05) for (let j = -1; j <= 1; j += 0.1) disc(0, c[0] + i * 0.09, c[1] + j * 0.06, 0.012, -5, true);
		for (const [dir, dv] of [[2, 0.085], [6, -0.085]] as [number, number][]) {
			const row = padRow(0, [c[0], c[1] + dv], dir, 4, 0.05, 1, 0.03, 0.02, 0.011);
			chain(row.gid, row.ns, row.ends, dir, [
				{ l: 0, steps: 3, end: 'via', run: [0.08, 0.3], min: 0.15 },
				{ l: 2, steps: 4, end: 'via', min: 0.5 },
				{ l: 3, steps: 2, end: 'pad', run: [0.05, 0.16] }
			]);
		}
	}

	// ---- J1: 1x8 through-hole header on the bottom edge
	{
		const gid = newGroup();
		const ns: Net[] = [], starts: V2[] = [];
		for (let i = 0; i < 8; i++) {
			const u = -0.6 + i * 0.06, v = -0.8;
			const n = newNet(gid, [u, v, 3]);
			vias.push({ u, v, net: n.id, kind: 2 });
			viaMark(u, v, gid, 0.022);
			ns.push(n);
			starts.push([u, v]);
		}
		chain(gid, ns, starts, 2, [
			{ l: 3, steps: 3, end: 'via', min: 0.25 },
			{ l: 2, steps: 4, end: 'via', min: 0.4 },
			{ l: 0, steps: 2, end: 'pad', run: [0.06, 0.2] }
		]);
	}

	// ---- sparse fillers
	const filler = (l: number, count: number, lanesMax: number) => {
		let made = 0;
		for (let tries = 0; tries < 400 && made < count; tries++) {
			const k = 1 + Math.floor(R() * lanesMax);
			const dir = Math.floor(R() * 4) * 2;
			const d = DIRS[dir], t: V2 = [-d[1], d[0]];
			const c: V2 = [rnd(-0.8, 0.8), rnd(-0.8, 0.8)];
			const pts: V2[] = [];
			for (let i = 0; i < k; i++) {
				const o = (i - (k - 1) / 2) * G * 1.4;
				pts.push([c[0] + t[0] * o, c[1] + t[1] * o]);
			}
			const inner = l === 1 || l === 2;
			if (!pts.every((p) => (inner ? viaClear(p[0], p[1], -9, 0.03) : disc(l, p[0], p[1], 0.03, -9, false)))) continue;
			const gid = newGroup();
			const ns = pts.map((p) => {
				const n = newNet(gid, [p[0], p[1], inner ? 0 : l]);
				if (inner) hop(n, l);
				else pad(n);
				return n;
			});
			const before = nets.length;
			chain(gid, ns, pts, dir, [{ l, steps: 3, end: 'via', min: 0.2 }, ...(inner ? [{ l: 3, steps: 1, end: 'pad' as const, run: [0.04, 0.1] as [number, number] }] : [])]);
			if (nets.length === before && ns[0].pts.length > 1) made++;
		}
	};
	filler(0, 5, 3);
	filler(2, 2, 4);
	filler(3, 6, 2);

	// ================================================================ emit

	const segs: number[][] = [[], [], [], [], [], [], []];
	const dots: number[][] = [[], [], [], []];
	const picks: Built['picks'] = [];
	const NONET = [-1, 0, 0, 0];
	const addSeg = (key: number, a: Pt, b: Pt, s0: number, s1: number, col: number[], net = NONET, grp = [-1, 0]) =>
		segs[key].push(a[0], a[1], a[2], b[0], b[1], b[2], s0, s1, ...col, ...net, ...grp);
	const addDot = (p: Pt, r: number, kind: number, col: number[], net = NONET, s = 0, g = -1) =>
		dots[p[2]].push(p[0], p[1], p[2], r, kind, ...col, ...net, s, g);

	for (const [cx, cy, hx, hy] of bodies) {
		const k: V2[] = [[cx - hx, cy - hy], [cx + hx, cy - hy], [cx + hx, cy + hy], [cx - hx, cy + hy]];
		for (let i = 0; i < 4; i++) addSeg(0, [k[i][0], k[i][1], 0], [k[(i + 1) % 4][0], k[(i + 1) % 4][1], 0], 0, 0, RULE);
		addDot([cx - hx + 0.022, cy + hy - 0.022, 0], 0.006, 2, RULE);
	}

	// board outlines
	const outline: V2[] = [];
	const ch = CHAMFER;
	for (const [x, y] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as V2[]) {
		outline.push([x * (x * y > 0 ? 1 : 1 - ch), y * (x * y > 0 ? 1 - ch : 1)]);
		outline.push([x * (x * y > 0 ? 1 - ch : 1), y * (x * y > 0 ? 1 : 1 - ch)]);
	}
	for (let l = 0; l < 4; l++)
		for (let i = 0; i < outline.length; i++) {
			const a = outline[i], b = outline[(i + 1) % outline.length];
			addSeg(l, [a[0], a[1], l], [b[0], b[1], l], 0, 0, OUTLINE[l]);
		}

	// nets
	for (const n of nets) {
		const g = groups[n.g];
		const s: number[] = [0];
		for (let j = 1; j < n.pts.length; j++) {
			const p = n.pts[j - 1], q = n.pts[j];
			s.push(s[j - 1] + (p[2] === q[2] ? Math.hypot(q[0] - p[0], q[1] - p[1]) : HOP));
		}
		const len = s[s.length - 1];
		const net = [n.id, len, g.period, g.phase + (R() - 0.5) * 0.004];
		const grp = [n.g, g.rev];
		for (let j = 1; j < n.pts.length; j++) {
			const p = n.pts[j - 1], q = n.pts[j];
			if (p[2] === q[2]) addSeg(p[2], p, q, s[j - 1], s[j], TRACE[p[2]], net, grp);
			else addSeg(4 + Math.min(p[2], q[2]), p, q, s[j - 1], s[j], [0, 0, 0, 0], net, grp);
		}
		for (const pd of n.pads) {
			addDot(n.pts[pd.i], pd.r, 0, PAD, net, s[pd.i], n.g);
			const p = n.pts[pd.i];
			picks.push({ u: p[0], v: p[1], l: p[2], g: n.g, f: len ? s[pd.i] / len : 0 });
		}
		(n as Net & { s?: number[]; net?: number[] }).s = s;
		(n as Net & { s?: number[]; net?: number[] }).net = net;
	}

	// vias through every layer
	const holesL1: [number, number, number][] = [];
	for (const v of vias) {
		const n = v.net >= 0 ? (nets[v.net] as Net & { s: number[]; net: number[] }) : null;
		const r = v.kind === 2 ? 0.019 : VIA_R;
		for (let l = 0; l < 4; l++) {
			let net = NONET, s = 0, g = -1, j = -1;
			if (n) {
				j = n.pts.findIndex((p) => p[2] === l && Math.abs(p[0] - v.u) < 1e-6 && Math.abs(p[1] - v.v) < 1e-6);
				if (j >= 0) {
					net = n.net;
					s = n.s[j];
					g = n.g;
					if (l === 0 || l === 3) picks.push({ u: v.u, v: v.v, l, g, f: n.net[1] ? s / n.net[1] : 0 });
				}
			}
			addDot([v.u, v.v, l], r, 1, v.kind === 1 ? [...C_GOLD, 0.3] : j >= 0 ? VIA : VIA_IDLE, net, s, g);
			if (v.kind === 2) addDot([v.u, v.v, l], r * 0.5, 2, [...C_GOLD, 0.35]);
			if (l < 3) addSeg(4 + l, [v.u, v.v, l], [v.u, v.v, l + 1], 0, 0, v.kind === 1 ? VERT_GND : VERT);
		}
		holesL1.push([v.u, v.v, v.kind === 2 ? 0.036 : 0.026]);
		if (v.kind === 1) {
			for (let k = 0; k < 4; k++) {
				const a = Math.PI / 4 + (k * Math.PI) / 2;
				const ca = Math.cos(a), sa = Math.sin(a);
				addSeg(1, [v.u + ca * VIA_R, v.v + sa * VIA_R, 1], [v.u + ca * 0.026, v.v + sa * 0.026, 1], 0, 0, HATCH);
			}
		} else addDot([v.u, v.v, 1], v.kind === 2 ? 0.036 : 0.026, 2, [...C_DIM, 0.4]);
	}

	// mounting holes, with a dashed centre rule through the stack
	for (const h of holes) {
		for (let l = 0; l < 4; l++) {
			addDot([h[0], h[1], l], 0.05, 2, [...mix3(C_DIM, C_LIGHT, 0.4), 0.5]);
			addDot([h[0], h[1], l], 0.072, 2, [...C_GOLD, 0.35]);
		}
		holesL1.push([h[0], h[1], 0.1]);
		const ext = 0.7;
		const keys: [number, number, number][] = [[0, -ext, 0], [4, 0, 1], [5, 1, 2], [6, 2, 3], [3, 3, 3 + ext]];
		let s = 0;
		for (const [key, a, b] of keys) {
			const ds = (b - a) * 0.55;
			addSeg(key, [h[0], h[1], a], [h[0], h[1], b], s, s + ds, RULE, NONET, [-1, 2]);
			s += ds;
		}
	}

	// inner 1: hatched ground pour, clipped by the plane outline and every clearance
	{
		const inset = 0.04, lim = 1 - inset, chl = 2 - ch - inset * 2 * (1 - S2);
		// octagon as half-planes n·p <= c
		const planes: [number, number, number][] = [
			[1, 0, lim], [-1, 0, lim], [0, 1, lim], [0, -1, lim],
			[S2, S2, chl * S2], [-S2, S2, chl * S2], [-S2, -S2, chl * S2], [S2, -S2, chl * S2]
		];
		const poly: V2[] = [];
		for (const [x, y] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as V2[]) {
			const e = chl - lim;
			poly.push([x * (x * y > 0 ? lim : e), y * (x * y > 0 ? e : lim)]);
			poly.push([x * (x * y > 0 ? e : lim), y * (x * y > 0 ? lim : e)]);
		}
		for (let i = 0; i < poly.length; i++) {
			const a = poly[i], b = poly[(i + 1) % poly.length];
			addSeg(1, [a[0], a[1], 1], [b[0], b[1], 1], 0, 0, [...C_DIM, 0.5]);
		}
		const H = 0.095;
		for (const dir of [[S2, S2], [S2, -S2]] as V2[]) {
			const nn: V2 = [-dir[1], dir[0]];
			for (let c = -1.45; c <= 1.45; c += H) {
				const o: V2 = [nn[0] * c, nn[1] * c];
				let t0 = -3, t1 = 3;
				for (const [px, py, pc] of planes) {
					const den = px * dir[0] + py * dir[1], num = pc - (px * o[0] + py * o[1]);
					if (Math.abs(den) < 1e-9) {
						if (num < 0) t1 = -1;
						continue;
					}
					const t = num / den;
					if (den > 0) t1 = Math.min(t1, t);
					else t0 = Math.max(t0, t);
				}
				if (t1 <= t0) continue;
				let cuts: [number, number][] = [];
				for (const [hu, hv, hr] of holesL1) {
					const rx = hu - o[0], ry = hv - o[1];
					const tc = rx * dir[0] + ry * dir[1];
					const dd = rx * nn[0] + ry * nn[1];
					if (Math.abs(dd) >= hr) continue;
					const w = Math.sqrt(hr * hr - dd * dd);
					cuts.push([tc - w, tc + w]);
				}
				cuts = cuts.sort((a, b) => a[0] - b[0]);
				let t = t0;
				const emit = (a: number, b: number) => {
					if (b - a > 0.004) addSeg(1, [o[0] + dir[0] * a, o[1] + dir[1] * a, 1], [o[0] + dir[0] * b, o[1] + dir[1] * b, 1], 0, 0, HATCH);
				};
				for (const [a, b] of cuts) {
					if (b <= t) continue;
					if (a > t) emit(t, Math.min(a, t1));
					t = Math.max(t, b);
					if (t >= t1) break;
				}
				if (t < t1) emit(t, t1);
			}
		}
	}

	return { segs, dots, picks };
}

// ---------------------------------------------------------------- shaders

const COMMON = /* glsl */ `
uniform mat4 uVP;
uniform float uY[4];
uniform float uGap;
uniform vec3 uEye;
uniform vec2 uFog;
float layerY(float l) {
	float lc = clamp(l, 0.0, 3.0);
	int i = int(floor(lc));
	int j = min(i + 1, 3);
	return mix(uY[i], uY[j], lc - float(i)) + (lc - l) * uGap;
}
vec3 world(vec3 p) { return vec3(p.x, layerY(p.z), -p.y); }
`;

const PULSE = /* glsl */ `
uniform float uT;      // pulse clock (frozen under reduced motion)
uniform float uTR;     // real clock, for taps
uniform float uMotion;
uniform vec4 uBurst[8]; // group, t0, fraction along net, active
const vec3 GOLD = vec3(0.784, 0.663, 0.416);
const vec3 LIGHT = vec3(0.914, 0.918, 0.945);
const float SPEED = 0.26;
float hash(float x) { return fract(sin(x * 91.3458) * 47453.5453); }
// x: brightness along a comet tail, y: the bead at its head
vec2 dash(float d) {
	return d < 0.0 ? vec2(smoothstep(-0.006, 0.0, d)) : vec2(exp(-d * 7.0), exp(-d * 60.0));
}
vec2 pulse(float s, vec4 net, vec2 grp) {
	vec2 p = vec2(0.0);
	if (net.z > 0.0) {
		float x = uT / net.z + net.w;
		float cyc = floor(x);
		float lit = step(0.4, hash(net.x * 1.713 + cyc * 7.37));
		float ss = grp.y > 0.5 ? net.y - s : s;
		float head = fract(x) * net.z * SPEED - 0.1;
		p += lit * dash(head - ss);
	}
	for (int i = 0; i < 8; i++) {
		vec4 b = uBurst[i];
		if (b.w > 0.0 && abs(b.x - grp.x) < 0.5) {
			if (uMotion < 0.5) { p += vec2(0.55, 0.0); continue; }
			float r = abs(s - b.z * net.y);
			float age = uTR - b.y;
			for (int k = 0; k < 3; k++) {
				float h = age * 0.62 - float(k) * 0.14;
				if (h > 0.0) p += dash(h - r) * (1.0 - 0.25 * float(k));
			}
		}
	}
	return p;
}
`;

const LINE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aA;
layout(location = 1) in vec3 aB;
layout(location = 2) in vec2 aS;
layout(location = 3) in vec4 aCol;
layout(location = 4) in vec4 aNet;
layout(location = 5) in vec2 aGrp;
${COMMON}
uniform vec2 uRes;
uniform float uHW;
out float vS;
out float vX;
out float vFog;
flat out vec4 vCol;
flat out vec4 vNet;
flat out vec2 vGrp;
void main() {
	int id = gl_VertexID;
	float t = (id == 1 || id == 2 || id == 4) ? 1.0 : 0.0;
	float side = (id == 2 || id == 4 || id == 5) ? 1.0 : -1.0;
	vec3 wa = world(aA), wb = world(aB);
	vec4 ca = uVP * vec4(wa, 1.0), cb = uVP * vec4(wb, 1.0);
	vec2 sa = ca.xy / ca.w * uRes * 0.5, sb = cb.xy / cb.w * uRes * 0.5;
	vec2 d = sb - sa;
	float L = length(d);
	d = L > 1e-4 ? d / L : vec2(1.0, 0.0);
	vec4 c = t < 0.5 ? ca : cb;
	c.xy += vec2(-d.y, d.x) * side * uHW / (uRes * 0.5) * c.w;
	gl_Position = c;
	vX = side * uHW;
	vS = mix(aS.x, aS.y, t);
	vFog = smoothstep(uFog.x, uFog.y, distance(mix(wa, wb, t), uEye));
	vCol = aCol;
	vNet = aNet;
	vGrp = aGrp;
}`;

const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
${PULSE}
uniform float uLW;
in float vS;
in float vX;
in float vFog;
flat in vec4 vCol;
flat in vec4 vNet;
flat in vec2 vGrp;
out vec4 o;
void main() {
	vec2 p = vNet.z > 0.0 || vGrp.x >= 0.0 ? pulse(vS, vNet, vGrp) : vec2(0.0);
	float pc = clamp(p.x, 0.0, 1.0);
	float hw = uLW * (1.0 + 0.5 * pc + 2.2 * clamp(p.y, 0.0, 1.0));
	float cov = clamp(hw + 0.5 - abs(vX), 0.0, 1.0);
	if (vGrp.y > 1.5) cov *= step(0.5, fract(vS * 12.0));
	float a0 = vCol.a * (1.0 - 0.55 * vFog);
	vec3 gold = mix(GOLD, LIGHT, 0.4 * smoothstep(0.7, 1.0, pc));
	float ap = pc * (1.0 - 0.35 * vFog);
	o = vec4(vCol.rgb * a0 * (1.0 - ap) + gold * ap, a0 + ap - a0 * ap) * cov;
}`;

const DOT_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aP;
layout(location = 1) in vec2 aShape;
layout(location = 2) in vec4 aCol;
layout(location = 3) in vec4 aNet;
layout(location = 4) in vec2 aX;
${COMMON}
out vec2 vQ;
out float vFog;
flat out float vKind;
flat out vec4 vCol;
flat out vec4 vNet;
flat out vec2 vX;
const vec2 Q[6] = vec2[6](vec2(-1, -1), vec2(1, -1), vec2(1, 1), vec2(-1, -1), vec2(1, 1), vec2(-1, 1));
void main() {
	float ext = aShape.y > 2.5 ? 1.0 : 1.7;
	vec2 q = Q[gl_VertexID] * ext;
	vec3 w = vec3(aP.x + q.x * aShape.x, layerY(aP.z), -(aP.y + q.y * aShape.x));
	gl_Position = uVP * vec4(w, 1.0);
	vQ = q;
	vFog = smoothstep(uFog.x, uFog.y, distance(w, uEye));
	vKind = aShape.y;
	vCol = aCol;
	vNet = aNet;
	vX = aX;
}`;

const DOT_FS = /* glsl */ `#version 300 es
precision highp float;
${PULSE}
uniform float uLW;
in vec2 vQ;
in float vFog;
flat in float vKind;
flat in vec4 vCol;
flat in vec4 vNet;
flat in vec2 vX;
out vec4 o;
void main() {
	if (vKind > 2.5) {
		// veil: the board itself, a faint dark sheet that dims what lies behind
		vec2 q = abs(vQ);
		float d = max(max(q.x, q.y) - 1.0, (q.x + q.y - (2.0 - ${CHAMFER.toFixed(3)})) * 0.7071);
		float cov = clamp(-d / fwidth(d) + 0.5, 0.0, 1.0);
		o = vec4(vCol.rgb * vCol.a, vCol.a) * cov;
		return;
	}
	float r = length(vQ);
	float fw = max(fwidth(r), 1e-4);
	float ring = clamp(uLW * 1.1 + 0.5 - abs(r - 1.0) / fw, 0.0, 1.0);
	float disc = clamp((1.0 - r) / fw + 0.5, 0.0, 1.0);
	float cov = vKind < 0.5 ? disc : vKind < 1.5 ? max(ring, disc * 0.2) : ring;
	float p = vX.y >= 0.0 ? clamp(pulse(vX.x, vNet, vec2(vX.y, 0.0)).x, 0.0, 1.0) : 0.0;
	float a = min(1.0, vCol.a * (1.0 - 0.5 * vFog) + p * 0.8);
	vec3 c = mix(vCol.rgb, mix(GOLD, LIGHT, 0.35 * p), p);
	o = vec4(c * a, a) * cov;
}`;

// ---------------------------------------------------------------- piece

export const setup: Setup = (ctx) => {
	const { gl } = ctx;
	const B = build(0x51ac);

	const lineProg = ctx.program(LINE_VS, LINE_FS);
	const dotProg = ctx.program(DOT_VS, DOT_FS);

	const buffers: WebGLBuffer[] = [];
	const vaos: WebGLVertexArrayObject[] = [];
	const mk = (data: number[], layout: [number, number][]) => {
		const stride = layout.reduce((s, [, n]) => s + n, 0);
		const v = gl.createVertexArray()!;
		gl.bindVertexArray(v);
		const b = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, b);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
		let off = 0;
		for (const [loc, n] of layout) {
			gl.enableVertexAttribArray(loc);
			gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride * 4, off * 4);
			gl.vertexAttribDivisor(loc, 1);
			off += n;
		}
		gl.bindVertexArray(null);
		buffers.push(b);
		vaos.push(v);
		return { v, n: data.length / stride };
	};
	const LINE_LAYOUT: [number, number][] = [[0, 3], [1, 3], [2, 2], [3, 4], [4, 4], [5, 2]];
	const DOT_LAYOUT: [number, number][] = [[0, 3], [1, 2], [2, 4], [3, 4], [4, 2]];
	const lines = B.segs.map((s) => mk(s, LINE_LAYOUT));
	const dots = B.dots.map((d) => mk(d, DOT_LAYOUT));
	const veils = [0, 1, 2, 3].map((l) => mk([0, 0, l, 1, 3, ...C_GROUND, VEIL_A, -1, 0, 0, 0, 0, -1], DOT_LAYOUT));

	const U = (p: WebGLProgram) => {
		const cache = new Map<string, WebGLUniformLocation | null>();
		return (n: string) => {
			if (!cache.has(n)) cache.set(n, gl.getUniformLocation(p, n));
			return cache.get(n)!;
		};
	};
	const uL = U(lineProg), uD = U(dotProg);

	const bursts = new Float32Array(32);
	let burstI = 0;

	let dist = 6, gap = 0.5, basePitch = 0.52;
	let proj: M4 = m4.identity();
	let vp: M4 = m4.identity();
	const Y = new Float32Array(4);

	const resize = () => {
		const aspect = ctx.w / ctx.h;
		const portrait = aspect < 0.85;
		gap = portrait ? 1.2 : 0.68;
		basePitch = portrait ? 0.66 : 0.56;
		proj = m4.perspective(FOV, aspect, 0.1, 60);
		// fit the stack (over the idle sway range) inside the frame
		const tanY = Math.tan(FOV / 2) * 0.9, tanX = tanY * aspect;
		const p = basePitch;
		const e = [Math.sin(YAW0) * Math.cos(p), Math.sin(p), Math.cos(YAW0) * Math.cos(p)];
		const rgt = [Math.cos(YAW0), 0, -Math.sin(YAW0)];
		const up = [e[1] * rgt[2] - e[2] * rgt[1], e[2] * rgt[0] - e[0] * rgt[2], e[0] * rgt[1] - e[1] * rgt[0]];
		const H = gap * 1.5 * 1.06 + 0.02;
		let D = 0;
		for (let k = -6; k <= 6; k++) {
			const a = (k / 6) * 0.6, ca = Math.cos(a), sa = Math.sin(a);
			for (const [cu, cv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]])
				for (const y of [H, -H]) {
					const P = [cu * ca - cv * sa, y, -(cu * sa + cv * ca)];
					const dot = (q: number[]) => P[0] * q[0] + P[1] * q[1] + P[2] * q[2];
					const z = dot(e);
					D = Math.max(D, z + Math.abs(dot(rgt)) / tanX, z + Math.abs(dot(up)) / tanY);
				}
		}
		dist = D;
	};

	const tap = (x: number, y: number) => {
		const aspect = ctx.w / ctx.h;
		let best = -1, bd = Infinity;
		B.picks.forEach((pk, i) => {
			const wx = pk.u, wy = Y[pk.l], wz = -pk.v;
			const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
			const cx = (vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / cw;
			const cy = (vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]) / cw;
			const d = Math.hypot((cx - x) * aspect, cy - y) + pk.l * 0.004;
			if (d < bd) {
				bd = d;
				best = i;
			}
		});
		if (best < 0) return;
		const pk = B.picks[best];
		if (!ctx.motion) bursts.fill(0);
		bursts.set([pk.g, now, pk.f, 1], burstI * 4);
		burstI = (burstI + 1) % 8;
	};

	let now = 0;
	const frame = (t: number) => {
		now = t;
		const mo = ctx.motion;
		const tt = mo ? t : 0;
		const tp = mo ? t + 30 : T_STILL;
		for (let i = 0; i < 8; i++) if (bursts[i * 4 + 3] > 0 && mo && t - bursts[i * 4 + 1] > 9) bursts[i * 4 + 3] = 0;

		// layers breathe their separation
		const gaps = [0, 1, 2].map((k) => gap * (1 + mo * 0.07 * Math.sin(tt * 0.19 + k * 2.2)));
		const total = gaps[0] + gaps[1] + gaps[2];
		const bob = mo * 0.025 * Math.sin(tt * 0.13);
		Y[0] = total / 2 + bob;
		Y[1] = Y[0] - gaps[0];
		Y[2] = Y[1] - gaps[1];
		Y[3] = Y[2] - gaps[2];

		const yaw = YAW0 + mo * (0.24 * Math.sin(tt * 0.043) + 0.08 * Math.sin(tt * 0.017 + 2.0)) - ctx.orbit.yaw - ctx.pointer.x * 0.2;
		const pitch = Math.max(-1.4, Math.min(1.4, basePitch + mo * 0.035 * Math.sin(tt * 0.061 + 1.0) + ctx.orbit.pitch + ctx.pointer.y * 0.09));
		const eye = [dist * Math.cos(pitch) * Math.sin(yaw), dist * Math.sin(pitch), dist * Math.cos(pitch) * Math.cos(yaw)];
		vp = m4.mul(proj, m4.lookAt(eye, [0, 0, 0]));

		gl.clearColor(C_GROUND[0], C_GROUND[1], C_GROUND[2], 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.disable(gl.DEPTH_TEST);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

		// hairlines: 1 CSS px on standard screens, a touch finer on dense ones
		const lw = 0.5 * Math.max(1, ctx.dpr * 0.8);
		for (const [prog, u] of [[lineProg, uL], [dotProg, uD]] as const) {
			gl.useProgram(prog);
			gl.uniformMatrix4fv(u('uVP'), false, vp);
			gl.uniform1fv(u('uY'), Y);
			gl.uniform1f(u('uGap'), gap);
			gl.uniform3fv(u('uEye'), eye);
			gl.uniform2f(u('uFog'), dist - 1.3, dist + 1.5);
			gl.uniform1f(u('uT'), tp);
			gl.uniform1f(u('uTR'), t);
			gl.uniform1f(u('uMotion'), mo);
			gl.uniform4fv(u('uBurst'), bursts);
			gl.uniform1f(u('uLW'), lw);
			if (prog === lineProg) {
				gl.uniform2f(u('uRes'), ctx.w, ctx.h);
				gl.uniform1f(u('uHW'), 2.2 * ctx.dpr + 1);
			}
		}

		// painter's order: far layer first, each nearer layer veils what's behind it
		const order = eye[1] >= 0 ? [3, 2, 1, 0] : [0, 1, 2, 3];
		order.forEach((l, i) => {
			if (i > 0) {
				gl.useProgram(dotProg);
				gl.bindVertexArray(veils[l].v);
				gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
			}
			gl.useProgram(lineProg);
			gl.bindVertexArray(lines[l].v);
			gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, lines[l].n);
			gl.useProgram(dotProg);
			gl.bindVertexArray(dots[l].v);
			gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, dots[l].n);
			if (i < 3) {
				const g = lines[4 + Math.min(l, order[i + 1])];
				gl.useProgram(lineProg);
				gl.bindVertexArray(g.v);
				gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, g.n);
			}
		});
		gl.bindVertexArray(null);
	};

	return {
		frame,
		resize,
		tap,
		destroy() {
			buffers.forEach((b) => gl.deleteBuffer(b));
			vaos.forEach((v) => gl.deleteVertexArray(v));
			gl.deleteProgram(lineProg);
			gl.deleteProgram(dotProg);
		}
	};
};
