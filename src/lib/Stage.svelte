<script lang="ts">
	import { onMount } from 'svelte';
	import { mount, type Setup, type StageOptions } from './stage';

	let { setup, options = {}, ground = '#13151c' }: { setup: Setup; options?: StageOptions; ground?: string } = $props();

	let canvas: HTMLCanvasElement;
	let unsupported = $state(false);

	onMount(() => {
		const stop = mount(canvas, setup, options);
		if (!stop) unsupported = true;
		return () => stop?.();
	});
</script>

<svelte:head>
	<meta name="theme-color" content={ground} />
</svelte:head>

<div role="img" aria-label="QInnovate" style:--ground={ground}>
	<canvas bind:this={canvas} class:unsupported></canvas>
</div>

<style>
	:global(html, body) {
		margin: 0;
		height: 100%;
		overflow: hidden;
	}
	div {
		position: fixed;
		inset: 0;
		background: var(--ground);
	}
	canvas {
		width: 100%;
		height: 100%;
		display: block;
		touch-action: none;
		cursor: grab;
	}
	canvas:active {
		cursor: grabbing;
	}
	canvas.unsupported {
		visibility: hidden;
	}
</style>
