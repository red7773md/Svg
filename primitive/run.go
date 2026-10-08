package primitive

import (
	"image"
	"time"
)

// Run places up to count shapes on target and returns the model and the
// number of shapes actually placed. It stops early once the deadline passes,
// so callers with a time limit (such as serverless functions) still get a
// usable partial result.
func Run(target image.Image, bg Color, outSize, workers, count, mode, alpha, repeat int, deadline time.Time) (*Model, int) {
	model := NewModel(target, bg, outSize, workers)
	placed := 0
	for placed < count && time.Now().Before(deadline) {
		model.Step(ShapeType(mode), alpha, repeat)
		placed++
	}
	return model, placed
}
