<script lang="ts">
	import Stage from '$lib/Stage.svelte';
	import { setup, GROUND } from '$lib/options/kessler';
</script>

<svelte:head><title>QInnovate</title></svelte:head>

<Stage {setup} ground={GROUND} options={{ pitchLimit: Infinity }} />
