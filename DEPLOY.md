# Deploying the web app to Vercel

The web app is a static page (`public/`) plus one Go serverless function
(`api/primitive.go`). The function reuses the same `primitive` package as the
command-line tool.

## Before the first deploy

1. Make the Go module complete. The committed `go.mod` only has the module
   line, so run this once on a machine with module access:

   ```sh
   go mod tidy
   go build ./primitive && go vet ./primitive
   ```

   Then commit `go.mod` and `go.sum`. Vercel reads dependencies from these
   files and won't fetch them for you.

2. Check the framework preset. The repo root has the CLI `main.go`, which
   Vercel may detect as a standalone Go server. In the project settings, set
   the framework preset to **Other** so only `api/` and `public/` are used.

## Deploy

- **Dashboard:** import the Git repository, set the framework to Other, and
  deploy. Each push to the branch redeploys.
- **CLI:** `npm i -g vercel`, then run `vercel` in the repo root.

## How a picture is built

A picture is built in **runs**. Each run is one request that places as many
shapes as fit in 50 seconds, then returns the image and the full shape list.
The browser sends that shape list back with the next run, so the picture keeps
improving. The browser stops when a run improves the score by less than 0.5%,
or after 12 runs, or at 3000 shapes.

Every run is saved in the browser's IndexedDB, so a picture that was
interrupted can be continued on a later visit.

Before upload, the browser re-encodes each image as a JPEG of at most 1024 px.
This removes metadata. If the result is still over 4 MB, it shrinks further and
logs each step.

## API

`POST /api/primitive` with `multipart/form-data`:

| Field | Required | Meaning |
| --- | --- | --- |
| `image` | yes | PNG or JPEG, up to 4 MB |
| `state` | no | `state` from the previous run's response (JSON). Omit on the first run. |
| `n` | no | shapes to place this run, 1-300 (default 150) |
| `mode` | no | 0=combo 1=triangle 2=rect 3=ellipse 4=circle 5=rotatedrect 6=beziers 7=rotatedellipse 8=polygon (default 1) |
| `alpha` | no | 0-255 (default 128) |
| `size` | no | output longest side, 64-1024 px (default 512) |

The response is JSON: `image` (base64 PNG), `width`, `height`, `score`
(lower is better), `placed`, `total`, `requested`, `stoppedEarly`, `seconds`,
and `state` (send this back on the next run).

Quick check from the command line (first run only):

```sh
curl -F image=@examples/owl.png -F n=50 \
  https://<your-deployment>.vercel.app/api/primitive -o run1.json
```

## Limits

| Setting | Value | Why |
| --- | --- | --- |
| Upload size | 4 MB | Vercel's request body limit is 4.5 MB; larger images are re-encoded in the browser |
| Shapes per run | 300 | Upper bound for one request |
| Shapes per picture | 3000 | Keeps the saved state and requests a reasonable size |
| Work per run | 50 s | Function limit is 60 s (`vercel.json`); Hobby allows up to 300 s |
| Runs per picture | 12 | Stops early when a run improves the score by under 0.5% |
| Output size | 64-1024 px | Larger images cost more memory and time |

If a run runs out of time, the response contains the shapes placed so far, and
`stoppedEarly` is `true`.
