// Shared plumbing for the full-bleed WebGL pieces: context, sizing, pointer,
// drag-to-orbit with inertia, reduced motion, pause when hidden.

export type Ctx = {
	gl: WebGL2RenderingContext;
	canvas: HTMLCanvasElement;
	/** drawing-buffer size in device pixels */
	w: number;
	h: number;
	dpr: number;
	/** pointer in NDC (-1..1, +y up), smoothed; raw target in `pointer.tx/ty` */
	pointer: { x: number; y: number; tx: number; ty: number; inside: boolean };
	/** accumulated drag rotation in radians, with inertia; add your own idle drift on top */
	orbit: { yaw: number; pitch: number; vyaw: number; vpitch: number; dragging: boolean };
	/** 1 normally, 0 under prefers-reduced-motion */
	motion: number;
	program: (vs: string, fs: string) => WebGLProgram;
	/** change the DPR cap at runtime (adaptive quality); triggers a resize */
	setMaxDpr: (v: number) => void;
	/** true on touch-first devices, where there is no hover */
	coarse: boolean;
};

export type Piece = {
	frame: (t: number, dt: number) => void;
	resize?: () => void;
	destroy?: () => void;
	/** optional tap handler, NDC coords */
	tap?: (x: number, y: number) => void;
};

export type Setup = (ctx: Ctx) => Piece;

export type StageOptions = {
	/** MSAA; defaults to on below DPR 2, where hairlines need it most */
	antialias?: boolean;
	maxDpr?: number;
	/** clamp for drag pitch, radians */
	pitchLimit?: number;
};

export function mount(canvas: HTMLCanvasElement, setup: Setup, opts: StageOptions = {}): (() => void) | null {
	const gl = canvas.getContext('webgl2', {
		antialias: opts.antialias ?? (devicePixelRatio || 1) < 2,
		alpha: false,
		premultipliedAlpha: false,
		powerPreference: 'high-performance'
	});
	if (!gl) return null;

	const compile = (type: number, src: string) => {
		const s = gl.createShader(type)!;
		gl.shaderSource(s, src);
		gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
		return s;
	};
	const program = (vs: string, fs: string) => {
		const p = gl.createProgram()!;
		gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
		gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
		return p;
	};

	const reduced = matchMedia('(prefers-reduced-motion: reduce)');
	const ctx: Ctx = {
		gl,
		canvas,
		w: 1,
		h: 1,
		dpr: 1,
		pointer: { x: 0, y: 0, tx: 0, ty: 0, inside: false },
		orbit: { yaw: 0, pitch: 0, vyaw: 0, vpitch: 0, dragging: false },
		motion: reduced.matches ? 0 : 1,
		program,
		setMaxDpr: (v) => {
			maxDpr = v;
			resize();
		},
		coarse: matchMedia('(pointer: coarse)').matches
	};
	let maxDpr = opts.maxDpr ?? 2;
	const onMotion = () => (ctx.motion = reduced.matches ? 0 : 1);
	reduced.addEventListener('change', onMotion);

	const piece = setup(ctx);

	const resize = () => {
		ctx.dpr = Math.min(devicePixelRatio || 1, maxDpr);
		ctx.w = Math.max(1, Math.round(canvas.clientWidth * ctx.dpr));
		ctx.h = Math.max(1, Math.round(canvas.clientHeight * ctx.dpr));
		canvas.width = ctx.w;
		canvas.height = ctx.h;
		gl.viewport(0, 0, ctx.w, ctx.h);
		piece.resize?.();
	};
	resize();
	const ro = new ResizeObserver(resize);
	ro.observe(canvas);

	const ndc = (e: PointerEvent) => [(e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2];
	let last: [number, number] | null = null;
	let downAt: [number, number, number] | null = null;
	const pitchLimit = opts.pitchLimit ?? 1.2;
	const onMove = (e: PointerEvent) => {
		const [x, y] = ndc(e);
		ctx.pointer.tx = x;
		ctx.pointer.ty = y;
		ctx.pointer.inside = true;
		if (ctx.orbit.dragging && last) {
			const dx = (e.clientX - last[0]) / innerHeight;
			const dy = (e.clientY - last[1]) / innerHeight;
			ctx.orbit.yaw += dx * 3;
			ctx.orbit.pitch = Math.max(-pitchLimit, Math.min(pitchLimit, ctx.orbit.pitch + dy * 3));
			ctx.orbit.vyaw = dx * 3 * 60;
			ctx.orbit.vpitch = dy * 3 * 60;
			last = [e.clientX, e.clientY];
		}
	};
	const onDown = (e: PointerEvent) => {
		ctx.orbit.dragging = true;
		last = [e.clientX, e.clientY];
		downAt = [e.clientX, e.clientY, performance.now()];
		canvas.setPointerCapture?.(e.pointerId);
	};
	const onUp = (e: PointerEvent) => {
		ctx.orbit.dragging = false;
		last = null;
		if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 6 && performance.now() - downAt[2] < 400) {
			const [x, y] = ndc(e);
			piece.tap?.(x, y);
		}
		downAt = null;
	};
	const onLeave = () => (ctx.pointer.inside = false);
	addEventListener('pointermove', onMove, { passive: true });
	canvas.addEventListener('pointerdown', onDown);
	addEventListener('pointerup', onUp);
	addEventListener('pointercancel', onUp);
	document.addEventListener('pointerleave', onLeave);

	const start = performance.now();
	let prev = start;
	let raf = 0;
	const frame = (now: number) => {
		const dt = Math.min(0.05, (now - prev) / 1000);
		prev = now;
		const k = 1 - Math.exp(-dt * 4);
		ctx.pointer.x += (ctx.pointer.tx - ctx.pointer.x) * k;
		ctx.pointer.y += (ctx.pointer.ty - ctx.pointer.y) * k;
		if (!ctx.orbit.dragging) {
			ctx.orbit.yaw += ctx.orbit.vyaw * dt;
			ctx.orbit.pitch = Math.max(-pitchLimit, Math.min(pitchLimit, ctx.orbit.pitch + ctx.orbit.vpitch * dt));
			const damp = Math.exp(-dt * 2.5);
			ctx.orbit.vyaw *= damp;
			ctx.orbit.vpitch *= damp;
		}
		piece.frame((now - start) / 1000, dt);
		raf = requestAnimationFrame(frame);
	};
	const run = () => {
		cancelAnimationFrame(raf);
		prev = performance.now();
		raf = requestAnimationFrame(frame);
	};
	run();
	const onVis = () => (document.hidden ? cancelAnimationFrame(raf) : run());
	document.addEventListener('visibilitychange', onVis);

	return () => {
		cancelAnimationFrame(raf);
		ro.disconnect();
		reduced.removeEventListener('change', onMotion);
		removeEventListener('pointermove', onMove);
		canvas.removeEventListener('pointerdown', onDown);
		removeEventListener('pointerup', onUp);
		removeEventListener('pointercancel', onUp);
		document.removeEventListener('pointerleave', onLeave);
		document.removeEventListener('visibilitychange', onVis);
		piece.destroy?.();
	};
}

// ---- tiny column-major mat4 kit ----
export type M4 = Float32Array;

export const m4 = {
	identity(): M4 {
		const o = new Float32Array(16);
		o[0] = o[5] = o[10] = o[15] = 1;
		return o;
	},
	perspective(fovy: number, aspect: number, near: number, far: number): M4 {
		const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
		const o = new Float32Array(16);
		o[0] = f / aspect;
		o[5] = f;
		o[10] = (far + near) * nf;
		o[11] = -1;
		o[14] = 2 * far * near * nf;
		return o;
	},
	lookAt(eye: number[], at: number[], up = [0, 1, 0]): M4 {
		let zx = eye[0] - at[0], zy = eye[1] - at[1], zz = eye[2] - at[2];
		let l = Math.hypot(zx, zy, zz) || 1;
		zx /= l; zy /= l; zz /= l;
		let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
		l = Math.hypot(xx, xy, xz) || 1;
		xx /= l; xy /= l; xz /= l;
		const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
		const o = new Float32Array(16);
		o[0] = xx; o[1] = yx; o[2] = zx;
		o[4] = xy; o[5] = yy; o[6] = zy;
		o[8] = xz; o[9] = yz; o[10] = zz;
		o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
		o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
		o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
		o[15] = 1;
		return o;
	},
	mul(a: M4, b: M4): M4 {
		const o = new Float32Array(16);
		for (let c = 0; c < 4; c++)
			for (let r = 0; r < 4; r++)
				o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
		return o;
	},
	rotX(a: number): M4 {
		const o = m4.identity(), c = Math.cos(a), s = Math.sin(a);
		o[5] = c; o[6] = s; o[9] = -s; o[10] = c;
		return o;
	},
	rotY(a: number): M4 {
		const o = m4.identity(), c = Math.cos(a), s = Math.sin(a);
		o[0] = c; o[2] = -s; o[8] = s; o[10] = c;
		return o;
	},
	rotZ(a: number): M4 {
		const o = m4.identity(), c = Math.cos(a), s = Math.sin(a);
		o[0] = c; o[1] = s; o[4] = -s; o[5] = c;
		return o;
	}
};

/** deterministic PRNG so every load draws the same piece */
export function rng(seed = 1) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** make a VAO from float attributes: { location: [data, size] } */
export function vao(gl: WebGL2RenderingContext, attrs: Record<number, [Float32Array, number]>, divisors: Record<number, number> = {}) {
	const v = gl.createVertexArray()!;
	gl.bindVertexArray(v);
	for (const [loc, [data, size]] of Object.entries(attrs)) {
		const b = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, b);
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(+loc);
		gl.vertexAttribPointer(+loc, size, gl.FLOAT, false, 0, 0);
		if (divisors[+loc]) gl.vertexAttribDivisor(+loc, divisors[+loc]);
	}
	gl.bindVertexArray(null);
	return v;
}
