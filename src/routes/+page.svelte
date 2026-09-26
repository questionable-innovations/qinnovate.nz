<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import Stage from '$lib/Stage.svelte';
	import { createKessler, GROUND } from '$lib/options/kessler';
	import { HAND_COUNT } from '$lib/hand-count';

	const SITE = 'https://qinnovate.nz';
	const ORG = 'https://github.com/questionable-innovations';
	const NAME = 'Questionable Innovations';
	const DESC = 'A New Zealand collective of engineers building questionable hardware and software.';
	const OG = `${SITE}/og.png`;
	const OG_ALT = 'Dots of orbital debris wrapped around a dark Earth, with one tracked object in amber.';

	const jsonld = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'Organization',
		name: NAME,
		alternateName: 'QInnovate',
		url: SITE,
		logo: `${SITE}/apple-touch-icon.png`,
		sameAs: [ORG]
	});

	type Word = { w: number; h: number; d: string[] };
	type Hand = { q: Word; i: Word };

	let line: Element | undefined = $state();
	let leader: SVGPathElement;
	let heading: HTMLElement;
	let down = $state(false);
	// one of the pre-generated handwritten titles (calligrapher.ai), picked per visit
	let hand: Hand | null = $state(null);
	let plain = $state(false);
	let writing = $state(false);

	const WRITE_FOR = 3;

	// ask for the title straight away, before the scene spends its first frames building
	// (?hand=N picks a specific one, for reviewing them)
	const pick = () => {
		const n = Number(new URLSearchParams(location.search).get('hand') ?? NaN);
		return Number.isInteger(n) && n >= 0 && n < HAND_COUNT ? n : Math.floor(Math.random() * HAND_COUNT);
	};
	const request = browser
		? fetch(`/hand/${pick()}.json`).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
		: null;

	onMount(() => {
		request!
			.then(async (h: Hand) => {
				hand = h;
				await tick();
				line = heading.querySelector('[data-last]') ?? undefined;
				// pace each stroke by its length, one after another, with a short pen lift between
				const pens = [...heading.querySelectorAll<SVGPathElement>('.pen')];
				const lens = pens.map((p) => p.getTotalLength() / 2);
				const total = lens.reduce((a, b) => a + b, 0);
				const lift = 0.012;
				const speed = total / (WRITE_FOR - lift * pens.length);
				let at = 0.05;
				pens.forEach((p, i) => {
					const dur = lens[i] / speed;
					p.style.animationDelay = `${at.toFixed(3)}s`;
					p.style.animationDuration = `${dur.toFixed(3)}s`;
					at += dur + lift;
				});
				writing = true;
			})
			.catch(async () => {
				plain = true;
				await tick();
				line = heading.querySelector('[data-last]') ?? undefined;
			});
	});

	// the title keeps a hairline on the tracked object, like a callout on a plot
	let shown = 0;
	const track = (x: number, y: number, visible: number) => {
		if (!line || !leader) return;
		const onScreen = x > 8 && y > 8 && x < innerWidth - 8 && y < innerHeight - 8 ? 1 : 0;
		shown += (visible * onScreen - shown) * 0.08;
		let r: DOMRect;
		if (line instanceof SVGElement) r = line.getBoundingClientRect();
		else {
			const range = document.createRange();
			range.selectNodeContents(line);
			r = range.getBoundingClientRect();
		}
		// attach to whichever end of the last line faces the object
		const left = x < (r.left + r.right) / 2;
		const ax = left ? r.left - 12 : r.right + 12;
		const bx = left ? ax - 22 : ax + 22;
		const ay = r.top + r.height * 0.55;
		// stop short of the dot so it keeps its own space
		const dx = x - bx, dy = y - ay;
		const len = Math.hypot(dx, dy) || 1;
		const ex = x - (dx / len) * 9, ey = y - (dy / len) * 9;
		leader.setAttribute('d', `M${ex.toFixed(1)} ${ey.toFixed(1)}L${bx.toFixed(1)} ${ay.toFixed(1)}H${ax.toFixed(1)}`);
		leader.style.opacity = (shown * 0.8).toFixed(3);
	};

	// shoot down the tracked object and the site takes itself offline
	const qi = () => {
		down = true;
		setTimeout(() => {
			// only works when this tab has no history (browsers guard window.close)
			window.close();
			setTimeout(() => {
				const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
				if (!still) document.body.classList.add('crt-off');
				setTimeout(() => location.reload(), still ? 400 : 1800);
			}, 300);
		}, 1400);
	};

	// never gonna give you up
	const rick = () => {
		document.documentElement.style.cursor = 'progress';
		// coming back via the back button would restore the frozen, pulsing page: start fresh
		addEventListener('pageshow', (e) => e.persisted && location.reload(), { once: true });
		location.assign('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
	};

	const setup = createKessler({ track, qi, rick });
</script>

<svelte:head>
	<title>{NAME}</title>
	<meta name="description" content={DESC} />
	<link rel="canonical" href="{SITE}/" />

	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={NAME} />
	<meta property="og:locale" content="en_NZ" />
	<meta property="og:url" content="{SITE}/" />
	<meta property="og:title" content={NAME} />
	<meta property="og:description" content={DESC} />
	<meta property="og:image" content={OG} />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content={OG_ALT} />

	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={NAME} />
	<meta name="twitter:description" content={DESC} />
	<meta name="twitter:image" content={OG} />
	<meta name="twitter:image:alt" content={OG_ALT} />

	{@html `<script type="application/ld+json">${jsonld}</script>`}
</svelte:head>

<Stage {setup} ground={GROUND} poster="/poster.avif" options={{ pitchLimit: Infinity }} />

<svg class="leader" aria-hidden="true">
	<path bind:this={leader} pathLength="1" />
</svg>

<h1 class:down class:plain class:writing bind:this={heading} style:--qw={hand?.q.w} style:--qh={hand?.q.h}>
	<a href={ORG} rel="me">
		{#if hand}
			<span class="sr">{NAME}</span>
			{#each [hand.q, hand.i] as word, wi (wi)}
				<svg
					viewBox="0 0 {word.w} {word.h}"
					style:--w={word.w}
					aria-hidden="true"
					data-last={wi === 1 ? '' : undefined}
				>
					<defs>
						{#each word.d as d, j (j)}
							<mask id="pen-{wi}-{j}">
								<path class="pen" {d} pathLength="1" />
							</mask>
						{/each}
					</defs>
					{#each word.d as d, j (j)}
						<path class="ink" {d} mask="url(#pen-{wi}-{j})" />
					{/each}
				</svg>
			{/each}
		{:else}
			<span class:sr={!plain}>Questionable</span> <span class:sr={!plain} data-last>Innovations</span>
		{/if}
	</a>
</h1>

<style>
	@font-face {
		font-family: 'JetBrains Mono Title';
		font-weight: 800;
		font-display: swap;
		src: url('/fonts/jetbrains-mono-800-title.woff2') format('woff2');
	}

	:global(html) {
		background: #0e1117;
	}
	:global(body) {
		background: #0e1117;
		color: #e9eaf1;
	}

	h1 {
		/* width "Questionable" is drawn at; every sample is scaled to it */
		--tw: clamp(18rem, 42vw, 44rem);
		position: fixed;
		top: max(1.75rem, env(safe-area-inset-top));
		right: max(2.5rem, env(safe-area-inset-right));
		margin: 0;
		font-size: 1rem;
	}
	h1 a {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		color: #e9eaf1;
		text-decoration: none;
		transition: color 0.35s;
	}
	h1 a:hover {
		color: #d9a55b;
	}
	h1 a:focus-visible {
		outline: 1px solid #e9eaf1;
		outline-offset: 10px;
	}

	svg {
		display: block;
		/* the samples come in at different sizes; scale each pair so its first word is --tw wide */
		width: calc(var(--w) * var(--tw) / var(--qw));
		height: auto;
		overflow: visible;
	}
	svg + svg {
		margin-top: calc(var(--qh) * var(--tw) / var(--qw) * -0.18);
	}
	.ink {
		fill: currentColor;
	}
	.pen {
		fill: none;
		stroke: #fff;
		stroke-width: 18;
		stroke-linecap: round;
		stroke-linejoin: round;
		/* the outline runs out along one edge of the stroke and back along the other:
		   revealing its first half with a fat pen uncovers the stroke in writing order */
		stroke-dasharray: 0.52 2;
		stroke-dashoffset: 0.52;
	}
	h1.writing .pen {
		animation: write linear both;
	}
	@keyframes write {
		to {
			stroke-dashoffset: 0;
		}
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/* fallback if the handwriting can't load */
	h1.plain {
		font: 800 clamp(2.75rem, 1rem + 5.6vw, 7.25rem) / 0.94 'JetBrains Mono Title', ui-monospace, monospace;
		letter-spacing: -0.03em;
		text-align: right;
	}
	h1.plain a {
		display: block;
		color: transparent;
		-webkit-text-stroke: 1px #e9eaf1;
	}
	h1.plain span {
		display: block;
	}

	/* power failing after the tracked object is lost */
	h1.down a {
		color: #d9a55b;
		animation: flicker 1.5s steps(1) both;
	}
	@keyframes flicker {
		0%, 12%, 30%, 46%, 71% { opacity: 1; }
		8%, 26%, 40%, 58%, 64%, 84% { opacity: 0.15; }
		92%, 100% { opacity: 0; }
	}

	/* ...and the screen switches off like an old CRT */
	:global(body.crt-off) {
		animation: crt-off 0.55s cubic-bezier(0.7, 0, 0.3, 1) forwards;
	}
	@keyframes -global-crt-off {
		0% {
			transform: none;
			filter: brightness(1);
		}
		45% {
			transform: scale(1, 0.004);
			filter: brightness(4);
		}
		100% {
			transform: scale(0, 0.004);
			filter: brightness(8);
			opacity: 0.4;
		}
	}

	.leader {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		overflow: visible;
	}
	.leader path {
		fill: none;
		stroke: #696e82;
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
		stroke-dasharray: 1;
		opacity: 0;
		animation: draw 0.9s cubic-bezier(0.5, 0, 0.2, 1) 3.1s both;
	}
	@media (min-resolution: 2dppx) {
		.leader path {
			stroke-width: 0.6;
		}
	}
	@keyframes draw {
		from {
			stroke-dashoffset: 1;
		}
		to {
			stroke-dashoffset: 0;
		}
	}

	/* phones: stacked top-left, as wide as the screen allows */
	@media (max-width: 700px) {
		h1 {
			--tw: calc(100vw - 3rem);
			top: max(1.25rem, env(safe-area-inset-top));
			right: auto;
			left: max(1.5rem, env(safe-area-inset-left));
		}
		h1 a {
			align-items: flex-start;
		}
		h1.plain {
			font-size: min(12.4vw, 4rem);
			text-align: left;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.leader path,
		h1.writing .pen {
			animation: none;
			stroke-dashoffset: 0;
		}
	}
</style>
