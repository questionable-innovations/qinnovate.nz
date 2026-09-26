<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	let { children } = $props();

	// review helper: ← / → steps through the five options
	const onKey = (e: KeyboardEvent) => {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		const n = Number(page.url.pathname.slice(1)) || 1;
		const next = ((n - 1 + (e.key === 'ArrowRight' ? 1 : 4)) % 5) + 1;
		goto(`/${next}`);
	};
</script>

<svelte:head>
	<meta name="robots" content="noindex" />
</svelte:head>

<svelte:window onkeydown={onKey} />

{@render children()}
