<script lang="ts">
	import Stage from '$lib/Stage.svelte';
	import { setup, GROUND } from '$lib/options/voxel';
</script>

<svelte:head><title>QInnovate</title></svelte:head>

<Stage {setup} ground={GROUND} />
