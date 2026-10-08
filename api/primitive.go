package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
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
	maxUploadBytes  = 4 << 20 // stay under Vercel's 4.5 MB request body limit
	maxShapesPerRun = 300
	maxTotalShapes  = 3000
	maxOutputSize   = 1024
	analysisSize    = 256              // input is downscaled to this before the search
	workBudget      = 50 * time.Second // one run; leaves headroom under the 60 s function limit
)

// runResponse is one run's result. The client sends State back on the next
// run to continue from the same shapes.
type runResponse struct {
	Image        string             `json:"image"` // PNG, base64-encoded
	Width        int                `json:"width"`
	Height       int                `json:"height"`
	Score        float64            `json:"score"`
	Placed       int                `json:"placed"`
	Total        int                `json:"total"`
	Requested    int                `json:"requested"`
	StoppedEarly bool               `json:"stoppedEarly"`
	Seconds      float64            `json:"seconds"`
	State        primitive.RunState `json:"state"`
}

// Handler implements POST /api/primitive: one time-limited run.
//
// Form fields:
//
//	image  (file, required)  PNG or JPEG, up to 4 MB
//	state  (text, optional)  RunState JSON from the previous run; omit on the first run
//	n      shapes to place this run, 1-300 (default 150)
//	mode   0=combo 1=triangle 2=rect 3=ellipse 4=circle 5=rotatedrect 6=beziers 7=rotatedellipse 8=polygon (default 1)
//	alpha  0-255, 0 lets the algorithm choose per shape (default 128)
//	size   output longest side in pixels, 64-1024 (default 512)
//
// The response is JSON (runResponse). It includes the image for this run and
// the full state to send back for the next run.
func Handler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST with a multipart form", http.StatusMethodNotAllowed)
		return
	}
	start := time.Now()
	deadline := start.Add(workBudget)

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

	count, err := intParam(r, "n", 150, 1, maxShapesPerRun)
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

	var state primitive.RunState
	hasState := false
	if raw := r.FormValue("state"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &state); err != nil {
			http.Error(w, "state is not valid JSON: "+err.Error(), http.StatusBadRequest)
			return
		}
		hasState = true
	}

	remaining := maxTotalShapes - len(state.Shapes)
	if remaining <= 0 {
		http.Error(w, "shape limit reached for this image", http.StatusConflict)
		return
	}
	if count > remaining {
		count = remaining
	}

	target := resize.Thumbnail(analysisSize, analysisSize, src, resize.Bilinear)
	var bg primitive.Color
	if hasState {
		bg = primitive.MakeHexColor(state.Background)
	} else {
		bg = primitive.MakeColor(primitive.AverageImageColor(target))
	}

	model, placed, err := primitive.Resume(target, bg, size, runtime.NumCPU(), state.Shapes, count, mode, alpha, deadline)
	if err != nil {
		http.Error(w, "state could not be restored: "+err.Error(), http.StatusBadRequest)
		return
	}
	snaps, err := model.Snapshot()
	if err != nil {
		http.Error(w, "could not save shapes: "+err.Error(), http.StatusInternalServerError)
		return
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, model.Context.Image()); err != nil {
		http.Error(w, "could not encode image", http.StatusInternalServerError)
		return
	}

	bgHex := fmt.Sprintf("#%02x%02x%02x", model.Background.R, model.Background.G, model.Background.B)
	resp := runResponse{
		Image:        base64.StdEncoding.EncodeToString(buf.Bytes()),
		Width:        model.Sw,
		Height:       model.Sh,
		Score:        model.Score,
		Placed:       placed,
		Total:        len(snaps),
		Requested:    count,
		StoppedEarly: placed < count,
		Seconds:      time.Since(start).Seconds(),
		State:        primitive.RunState{Background: bgHex, Shapes: snaps},
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(resp)
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
