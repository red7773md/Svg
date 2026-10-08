package handler

import (
	"bytes"
	"fmt"
	"image"
	_ "image/jpeg" // register JPEG decoder
	"image/png"    // register PNG decoder and encode PNG output
	"net/http"
	"runtime"
	"strconv"
	"time"

	"github.com/fogleman/primitive/primitive"
	"github.com/nfnt/resize"
)

const (
	maxUploadBytes = 4 << 20 // stay under Vercel's 4.5 MB request body limit
	maxShapes      = 500
	maxOutputSize  = 1024
	analysisSize   = 256              // input is downscaled to this before the search
	workBudget     = 50 * time.Second // leaves headroom under the 60 s function limit
)

// Handler implements POST /api/primitive.
//
// Form fields:
//
//	image   (file, required)  PNG or JPEG, up to 4 MB
//	n       shapes to place, 1-200 (default 50)
//	mode    0=combo 1=triangle 2=rect 3=ellipse 4=circle 5=rotatedrect 6=beziers 7=rotatedellipse 8=polygon (default 1)
//	alpha   0-255, 0 lets the algorithm choose per shape (default 128)
//	size    output longest side in pixels, 64-1024 (default 512)
//	format  png | svg | json (default png)
//
// Response headers X-Shapes-Requested and X-Shapes-Placed report how many
// shapes were requested and how many finished before the time budget ran out.
func Handler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST with a multipart form", http.StatusMethodNotAllowed)
		return
	}
	deadline := time.Now().Add(workBudget)

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		http.Error(w, "could not read upload (max 4 MB): "+err.Error(), http.StatusBadRequest)
		return
	}

	file, _, err := r.FormFile("image")
	if err != nil {
		http.Error(w, "missing 'image' file field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	src, _, err := image.Decode(file)
	if err != nil {
		http.Error(w, "unsupported or corrupt image (use PNG or JPEG)", http.StatusBadRequest)
		return
	}

	count, err := intParam(r, "n", 50, 1, maxShapes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	mode, err := intParam(r, "mode", 1, 0, 8)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	alpha, err := intParam(r, "alpha", 128, 0, 255)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	size, err := intParam(r, "size", 512, 64, maxOutputSize)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	format := r.FormValue("format")
	if format == "" {
		format = "png"
	}
	if format != "png" && format != "svg" && format != "json" {
		http.Error(w, "format must be png, svg, or json", http.StatusBadRequest)
		return
	}

	target := resize.Thumbnail(analysisSize, analysisSize, src, resize.Bilinear)
	bg := primitive.MakeColor(primitive.AverageImageColor(target))
	model, placed := primitive.Run(target, bg, size, runtime.NumCPU(), count, mode, alpha, 0, deadline)

	w.Header().Set("X-Shapes-Requested", strconv.Itoa(count))
	w.Header().Set("X-Shapes-Placed", strconv.Itoa(placed))

	switch format {
	case "svg":
		w.Header().Set("Content-Type", "image/svg+xml")
		fmt.Fprint(w, model.SVG())
	case "json":
		data, err := model.JSON()
		if err != nil {
			http.Error(w, "could not encode result", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
	default:
		var buf bytes.Buffer
		if err := png.Encode(&buf, model.Context.Image()); err != nil {
			http.Error(w, "could not encode result", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Write(buf.Bytes())
	}
}

// intParam reads an optional integer form field and checks its range.
func intParam(r *http.Request, name string, def, lo, hi int) (int, error) {
	s := r.FormValue(name)
	if s == "" {
		return def, nil
	}
	v, err := strconv.Atoi(s)
	if err != nil || v < lo || v > hi {
		return 0, fmt.Errorf("%s must be an integer from %d to %d", name, lo, hi)
	}
	return v, nil
}
