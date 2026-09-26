<script lang="ts">
	import { onMount } from 'svelte';
	import { mount, type Setup, type StageOptions } from './stage';

	let {
		setup,
		options = {},
		ground = '#13151c',
		poster
	}: {
		setup: Setup;
		options?: StageOptions;
		ground?: string;
		/** still shown instead when there's no hardware-accelerated WebGL2 */
		poster?: string;
	} = $props();

	let canvas: HTMLCanvasElement;
	let unsupported = $state(false);

	onMount(() => {
		const stop = mount(canvas, setup, { ...options, onFail: () => (unsupported = true) });
		if (!stop) unsupported = true;
		return () => stop?.();
	});
</script>

<svelte:head>
	<meta name="theme-color" content={ground} />
</svelte:head>

<div
	role="img"
	aria-label="QInnovate"
	style:--ground={ground}
	style:--poster={unsupported && poster ? `url(${poster})` : undefined}
>
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
		background: var(--ground) var(--poster, none) center / cover no-repeat;
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
		display: none;
	}
</style>
