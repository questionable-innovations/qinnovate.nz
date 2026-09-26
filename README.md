# qinnovate.nz

Landing page for Questionable Innovations: low Earth orbit after a Kessler
cascade, about 100k debris points propagated on the GPU from orbital elements.
Tap an object to break it up (the amber one is load-bearing). Raw WebGL2, no 3D library.

SvelteKit on a Cloudflare Worker, prerendered.

```sh
pnpm install
pnpm dev      # local
pnpm deploy   # build + wrangler deploy (needs a wrangler login with access to the qinnovate.nz zone)
```

- `src/lib/options/kessler.ts`: the scene (swarm generation, shaders, intro, adaptive quality)
- `src/lib/stage.ts`: canvas/context plumbing shared by the pieces
- `src/routes/(options)/1`–`5`: the five design explorations (noindex), ←/→ to step through
- `static/og.png` is a capture of the page at 1200×630
