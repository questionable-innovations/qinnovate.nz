<script lang="ts">
	import Stage from '$lib/Stage.svelte';
	import { setup, GROUND } from '$lib/options/phosphor';
</script>

<svelte:head><title>QInnovate</title></svelte:head>

<Stage {setup} ground={GROUND} options={{ antialias: false }} />
