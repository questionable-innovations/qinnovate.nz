<script lang="ts">
	import { onMount } from 'svelte';
	import frag from './glyph.frag?raw';
	import vert from './glyph.vert?raw';

	let canvas: HTMLCanvasElement;
	let unsupported = $state(false);

	onMount(() => {
		const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
		if (!gl) {
			unsupported = true;
			return;
		}

		const compile = (type: number, src: string) => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
			return s;
		};
		const prog = gl.createProgram()!;
		gl.attachShader(prog, compile(gl.VERTEX_SHADER, vert));
		gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
		gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
		gl.useProgram(prog);
		gl.bindVertexArray(gl.createVertexArray());

		const u = (name: string) => gl.getUniformLocation(prog, name);
		const uRes = u('uRes'), uTime = u('uTime'), uMouse = u('uMouse'),
			uIntro = u('uIntro'), uPulse = u('uPulse'), uMotion = u('uMotion');

		const reduced = matchMedia('(prefers-reduced-motion: reduce)');
		let motion = reduced.matches ? 0 : 1;
		reduced.addEventListener('change', () => { motion = reduced.matches ? 0 : 1; });

		let w = 0, h = 0, dpr = 1;
		const resize = () => {
			dpr = Math.min(devicePixelRatio || 1, 1.75);
			w = Math.round(canvas.clientWidth * dpr);
			h = Math.round(canvas.clientHeight * dpr);
			canvas.width = w;
			canvas.height = h;
			gl.viewport(0, 0, w, h);
		};
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(canvas);

		// pointer in glyph space (same mapping as the shader)
		const toGlyph = (x: number, y: number) => {
			const scale = w < h ? 1.35 * (h / w) * 0.75 : 1.55;
			return [((x * dpr - w * 0.5) / h) * scale, ((h - y * dpr - h * 0.5) / h) * scale];
		};
		let target = [0.9, 0.7], mouse = [0.9, 0.7];
		let pulse = [0, 0, 99];
		let pulseAt = -1e9;
		addEventListener('pointermove', (e) => { target = toGlyph(e.clientX, e.clientY); }, { passive: true });
		addEventListener('pointerdown', (e) => {
			const g = toGlyph(e.clientX, e.clientY);
			pulse = [g[0], g[1], 0];
			pulseAt = performance.now();
		}, { passive: true });

		const start = performance.now();
		let raf = 0;
		const frame = (now: number) => {
			const t = (now - start) / 1000;
			const k = 1 - Math.pow(0.001, 1 / 60); // ~exponential smoothing
			mouse[0] += (target[0] - mouse[0]) * k * 0.35;
			mouse[1] += (target[1] - mouse[1]) * k * 0.35;
			const intro = motion ? Math.pow(Math.max(0, 1 - t / 2.8), 3) : 0;
			pulse[2] = motion ? (now - pulseAt) / 1000 : 99;

			gl.uniform2f(uRes, w, h);
			gl.uniform1f(uTime, motion ? t : 11.7);
			gl.uniform2f(uMouse, mouse[0], mouse[1]);
			gl.uniform1f(uIntro, intro);
			gl.uniform3f(uPulse, pulse[0], pulse[1], pulse[2]);
			gl.uniform1f(uMotion, motion);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			raf = requestAnimationFrame(frame);
		};
		const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); };
		run();
		const onVis = () => (document.hidden ? cancelAnimationFrame(raf) : run());
		document.addEventListener('visibilitychange', onVis);

		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
			document.removeEventListener('visibilitychange', onVis);
		};
	});
</script>

<div role="img" aria-label="QInnovate">
	<canvas bind:this={canvas} class:unsupported></canvas>
</div>
{#if unsupported}
	<span class="fallback" aria-hidden="true">?</span>
{/if}

<style>
	canvas {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
		background: #dcdde3;
		touch-action: none;
	}
	canvas.unsupported { visibility: hidden; }
	.fallback {
		position: fixed;
		inset: 0;
		display: grid;
		place-items: center;
		font: 700 min(62vh, 62vw) / 1 ui-serif, Georgia, serif;
		color: #23212b;
		background: #dcdde3;
	}
</style>
