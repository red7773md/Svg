# Primitive Pictures (web app)

A static web app. All the work happens in the visitor's browser: the photo is
never uploaded, and there is no server code to run or pay for.

- `public/` is the whole site (HTML, CSS and ES modules, no build step)
- `public/js/engine/` is the shape-search engine (a JavaScript port of the Go
  algorithm in `primitive/`)
- `tests/` has Node tests for the engine and the GIF encoder

## Run it locally

```sh
npm start          # serves public/ at http://localhost:8000
npm test           # engine and GIF tests (the GIF test needs python3 with Pillow)
```

## Deploy to Vercel

The repository is ready as-is: `vercel.json` sets `public` as the output
directory and skips the build. In the Vercel dashboard import the repository and
deploy (framework preset **Other**), or run `vercel` from the repo root.

`vercel.json` also sets a Content-Security-Policy that only allows the site's
own files plus `blob:` workers and images.

## How a picture is built

1. The photo is re-drawn on a canvas. This removes metadata (location, camera
   info), applies the camera rotation, flattens transparency, and shrinks it to
   at most 1600 px on its longest side. Photos over 5 MB are reported in the
   activity log as they are reduced.
2. The search runs on a copy of at most 256 px (384 px with "Fine" detail). The
   result is vector shapes, so the output stays sharp at any size.
3. Several Web Workers (one per CPU core, up to six) search in parallel. For each
   shape, every worker tries a share of the hill climbs; the best shape wins and
   all workers apply it.
4. The shape list is saved in IndexedDB every 10 shapes or 2.5 seconds, with the
   shrunk photo. Closing the tab loses almost nothing, and an interrupted
   picture can be resumed from the history on the home page.

## Limits

| Setting | Value |
| --- | --- |
| Shapes per picture | 10 to 2,000 (default 500). Defined in `public/js/config.js` |
| Photo file size | up to 100 MB, up to 200 megapixels |
| Photo kept in the browser | 1600 px longest side, JPEG |
| Downloads | PNG/JPG at 1024, 2048 or 4096 px; SVG; GIF (400 px, up to 60 frames); JSON |

Pictures are stored per browser. Clearing site data removes them.

## Command-line tool

The original Go command-line tool is unchanged and still lives in `main.go` and
`primitive/`. This fork adds `-json` (write the shapes as JSON) and `-seed`
(repeatable runs).
