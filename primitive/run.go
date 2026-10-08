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

// Resume continues a run from shapes saved by an earlier run. It restores
// prior onto a fresh model with background bg, then places up to count new
// shapes before the deadline. The returned model contains prior and the new
// shapes, so it can be snapshotted and resumed again.
func Resume(target image.Image, bg Color, outSize, workers int, prior []ShapeSnapshot, count, mode, alpha int, deadline time.Time) (*Model, int, error) {
	model := NewModel(target, bg, outSize, workers)
	if err := model.Restore(prior); err != nil {
		return nil, 0, err
	}
	placed := 0
	for placed < count && time.Now().Before(deadline) {
		model.Step(ShapeType(mode), alpha, 0)
		placed++
	}
	return model, placed, nil
}
