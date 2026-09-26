<script lang="ts">
	import Stage from '$lib/Stage.svelte';
	import { createKessler, GROUND } from '$lib/options/kessler';

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

	let line: HTMLSpanElement;
	let leader: SVGPathElement;
	let down = $state(false);

	// the title keeps a hairline on the tracked object, like a callout on a plot
	let shown = 0;
	const track = (x: number, y: number, visible: number) => {
		if (!line || !leader) return;
		const onScreen = x > 8 && y > 8 && x < innerWidth - 8 && y < innerHeight - 8 ? 1 : 0;
		shown += (visible * onScreen - shown) * 0.08;
		const range = document.createRange();
		range.selectNodeContents(line);
		const r = range.getBoundingClientRect();
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

	const setup = createKessler({ track, qi });
</script>

<svelte:head>
	<title>{NAME}</title>
	<meta name="description" content={DESC} />
	<link rel="canonical" href="{SITE}/" />
	<link rel="preload" href="/fonts/jetbrains-mono-800-title.woff2" as="font" type="font/woff2" crossorigin="anonymous" />

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

<Stage {setup} ground={GROUND} />

<svg class="leader" aria-hidden="true">
	<path bind:this={leader} pathLength="1" />
</svg>

<h1 class:down>
	<a href={ORG} rel="me"><span>Questionable</span> <span bind:this={line}>Innovations</span></a>
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
		position: fixed;
		top: max(2rem, env(safe-area-inset-top));
		right: max(2.5rem, env(safe-area-inset-right));
		margin: 0;
		font: 800 clamp(2.75rem, 1rem + 5.6vw, 7.25rem) / 0.94 'JetBrains Mono Title', ui-monospace, monospace;
		letter-spacing: -0.03em;
		text-align: right;
		animation: reveal 1.1s cubic-bezier(0.2, 0.7, 0.2, 1) 3.9s both;
	}
	h1 span {
		display: block;
	}

	h1 a {
		color: transparent;
		-webkit-text-stroke: 1px #e9eaf1;
		text-decoration: none;
		transition: color 0.35s;
	}
	h1 a:hover {
		color: #e9eaf1;
	}
	h1 a:focus-visible {
		outline: 1px solid #e9eaf1;
		outline-offset: 10px;
	}
	@media (min-resolution: 2dppx) {
		h1 a {
			-webkit-text-stroke-width: 0.7px;
		}
	}

	/* the title is revealed left to right, as the callout lands on it */
	@keyframes reveal {
		from {
			clip-path: inset(-0.2em 100% -0.2em 0);
		}
		to {
			clip-path: inset(-0.2em -0.2em -0.2em -0.2em);
		}
	}

	/* power failing after the tracked object is lost */
	h1.down a {
		-webkit-text-stroke-color: #d9a55b;
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
			top: max(1.25rem, env(safe-area-inset-top));
			right: auto;
			left: max(1.25rem, env(safe-area-inset-left));
			font-size: min(12.4vw, 4rem);
			text-align: left;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		h1,
		.leader path {
			animation: none;
		}
	}
</style>
