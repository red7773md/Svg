# Deploying the web app to Vercel

The web app is a static page (`public/index.html`) plus one Go serverless
function (`api/primitive.go`). The function reuses the same `primitive`
package as the command-line tool.

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

## Test it

Open the deployment URL, choose an image, and generate a picture. You can
also call the function directly:

```sh
curl -F image=@examples/owl.png -F n=50 -F format=svg \
  https://<your-deployment>.vercel.app/api/primitive -o owl.svg
```

## Limits

| Setting | Value | Why |
| --- | --- | --- |
| Upload size | 4 MB | Vercel's request body limit is 4.5 MB |
| Shapes per request | 200 | Keeps work within the time budget |
| Output size | 64-1024 px | Larger images cost more memory and time |
| Work budget | 50 s | Function limit is 60 s (`vercel.json`); Hobby allows up to 300 s |

If the time budget runs out, the function returns the shapes placed so far
and sets `X-Shapes-Placed` lower than `X-Shapes-Requested`.
