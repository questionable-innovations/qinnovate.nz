// Drive calligrapher.ai (its handwriting model runs in the page) to write
// "Questionable" and "Innovations" in a given style, and save the pen paths.
//   OUT=hand-raw node scripts/generate-handwriting.mjs <per-style> <workers> <styles> <from-index> <min-bias>
//   e.g.  node scripts/generate-handwriting.mjs 6 6 1,11,21,23,30,44,19 0 0.85
// Needs playwright-core and a Chromium (npx playwright install chromium).
// Then eyeball the results and run pack-handwriting.mjs with the keepers.
import { chromium } from 'playwright-core';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
const OUT = process.env.OUT ?? 'hand-raw';
mkdirSync(OUT, { recursive: true });
const STYLES = (process.argv[4] ?? '44,23,1,19,30,11,21,6,54,-').split(',');
const PER = +(process.argv[2] ?? 14), WORKERS = +(process.argv[3] ?? 6), FROM = +(process.argv[5] ?? 0), B0 = +(process.argv[6] ?? 0.7);
const jobs = [];
for (let i = FROM; i < FROM + PER; i++) for (const s of STYLES) jobs.push({ style: s, i, bias: (B0 + Math.random() * 0.35).toFixed(2) });
const b = await chromium.launch();
let done = 0;
const worker = async () => {
	const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
	await p.goto('https://www.calligrapher.ai/', { waitUntil: 'networkidle' });
	const setRange = (id, v) => p.evaluate(([id, v]) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, [id, v]);
	for (let job; (job = jobs.shift()); ) {
		const id = `${job.style === '-' ? 'r' : job.style}-${String(job.i).padStart(2, '0')}`;
		if (existsSync(`${OUT}/${id}.json`)) continue;
		const pair = { style: job.style, bias: +job.bias };
		for (const word of ['Questionable', 'Innovations']) {
			await p.selectOption('#select-style', job.style);
			await setRange('speed-slider', '9.51');
			await setRange('bias-slider', job.bias);
			await setRange('width-slider', '0.75');
			await p.fill('#text-input', word);
			await p.click('#draw-button');
			let last = '', same = 0;
			for (let k = 0; k < 250 && same < 6; k++) {
				await p.waitForTimeout(200);
				const now = await p.evaluate(() => document.getElementById('canvas').innerHTML.length);
				same = now === last ? same + 1 : 0;
				last = now;
			}
			pair[word] = await p.evaluate(() => {
				const svg = document.getElementById('canvas');
				const bb = svg.getBBox();
				return { vb: [bb.x, bb.y, bb.width, bb.height], paths: [...svg.querySelectorAll('path')].map((q) => q.getAttribute('d')) };
			});
		}
		writeFileSync(`${OUT}/${id}.json`, JSON.stringify(pair));
		console.log(++done, id, job.bias);
	}
};
await Promise.all(Array.from({ length: WORKERS }, worker));
await b.close();
