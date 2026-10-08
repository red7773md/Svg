package primitive

import (
	"fmt"
	"math"
)

// ShapeSnapshot is a serializable copy of one placed shape. Nums holds the
// shape's coordinates in a fixed order per type; Flag holds the ellipse
// "circle" bit or the polygon "convex" bit.
type ShapeSnapshot struct {
	Type  string    `json:"type"`
	Color [4]int    `json:"color"`
	Score float64   `json:"score"`
	Nums  []float64 `json:"nums"`
	Flag  bool      `json:"flag,omitempty"`
}

// RunState is everything needed to continue a run in a later request.
type RunState struct {
	Background string          `json:"background"`
	Shapes     []ShapeSnapshot `json:"shapes"`
}

const maxCoordinate = 1e5

// snapshotShape converts a placed shape into its type name and numbers.
func snapshotShape(shape Shape) (string, []float64, bool, error) {
	switch s := shape.(type) {
	case *Triangle:
		return "triangle", []float64{float64(s.X1), float64(s.Y1), float64(s.X2), float64(s.Y2), float64(s.X3), float64(s.Y3)}, false, nil
	case *Rectangle:
		return "rectangle", []float64{float64(s.X1), float64(s.Y1), float64(s.X2), float64(s.Y2)}, false, nil
	case *RotatedRectangle:
		return "rotatedrect", []float64{float64(s.X), float64(s.Y), float64(s.Sx), float64(s.Sy), float64(s.Angle)}, false, nil
	case *Ellipse:
		return "ellipse", []float64{float64(s.X), float64(s.Y), float64(s.Rx), float64(s.Ry)}, s.Circle, nil
	case *RotatedEllipse:
		return "rotatedellipse", []float64{s.X, s.Y, s.Rx, s.Ry, s.Angle}, false, nil
	case *Quadratic:
		return "quadratic", []float64{s.X1, s.Y1, s.X2, s.Y2, s.X3, s.Y3, s.Width}, false, nil
	case *Polygon:
		nums := make([]float64, 0, 2*len(s.X))
		for i := range s.X {
			nums = append(nums, s.X[i], s.Y[i])
		}
		return "polygon", nums, s.Convex, nil
	}
	return "", nil, false, fmt.Errorf("cannot snapshot shape %T", shape)
}

// Snapshot returns every placed shape, including shapes restored from an
// earlier run, in drawing order.
func (model *Model) Snapshot() ([]ShapeSnapshot, error) {
	snaps := make([]ShapeSnapshot, 0, len(model.Shapes))
	for i, shape := range model.Shapes {
		typ, nums, flag, err := snapshotShape(shape)
		if err != nil {
			return nil, err
		}
		c := model.Colors[i]
		snaps = append(snaps, ShapeSnapshot{
			Type:  typ,
			Color: [4]int{c.R, c.G, c.B, c.A},
			Score: model.Scores[i],
			Nums:  nums,
			Flag:  flag,
		})
	}
	return snaps, nil
}

// Restore redraws previously placed shapes onto a fresh model, so the
// search can continue from them. It must be called before any Step.
func (model *Model) Restore(snaps []ShapeSnapshot) error {
	worker := model.Workers[0]
	for _, snap := range snaps {
		shape, err := snap.toShape(worker)
		if err != nil {
			return err
		}
		c := Color{snap.Color[0], snap.Color[1], snap.Color[2], snap.Color[3]}
		lines := shape.Rasterize()
		drawLines(model.Current, c, lines)
		model.Shapes = append(model.Shapes, shape)
		model.Colors = append(model.Colors, c)
		model.Scores = append(model.Scores, snap.Score)
		model.Context.SetRGBA255(c.R, c.G, c.B, c.A)
		shape.Draw(model.Context, model.Scale)
	}
	model.Score = differenceFull(model.Target, model.Current)
	return nil
}

// toShape rebuilds a shape from its snapshot, checking the number count and
// value range first because the state comes from the client.
func (snap ShapeSnapshot) toShape(worker *Worker) (Shape, error) {
	n := snap.Nums
	for _, v := range n {
		if math.IsNaN(v) || math.Abs(v) > maxCoordinate {
			return nil, fmt.Errorf("%s has an out-of-range value", snap.Type)
		}
	}
	need := map[string]int{
		"triangle":       6,
		"rectangle":      4,
		"rotatedrect":    5,
		"ellipse":        4,
		"rotatedellipse": 5,
		"quadratic":      7,
	}
	if k, ok := need[snap.Type]; ok && len(n) != k {
		return nil, fmt.Errorf("%s needs %d numbers, got %d", snap.Type, k, len(n))
	}
	switch snap.Type {
	case "triangle":
		return &Triangle{Worker: worker, X1: int(n[0]), Y1: int(n[1]), X2: int(n[2]), Y2: int(n[3]), X3: int(n[4]), Y3: int(n[5])}, nil
	case "rectangle":
		return &Rectangle{Worker: worker, X1: int(n[0]), Y1: int(n[1]), X2: int(n[2]), Y2: int(n[3])}, nil
	case "rotatedrect":
		return &RotatedRectangle{Worker: worker, X: int(n[0]), Y: int(n[1]), Sx: int(n[2]), Sy: int(n[3]), Angle: int(n[4])}, nil
	case "ellipse":
		return &Ellipse{Worker: worker, X: int(n[0]), Y: int(n[1]), Rx: int(n[2]), Ry: int(n[3]), Circle: snap.Flag}, nil
	case "rotatedellipse":
		return &RotatedEllipse{Worker: worker, X: n[0], Y: n[1], Rx: n[2], Ry: n[3], Angle: n[4]}, nil
	case "quadratic":
		return &Quadratic{Worker: worker, X1: n[0], Y1: n[1], X2: n[2], Y2: n[3], X3: n[4], Y3: n[5], Width: n[6]}, nil
	case "polygon":
		if len(n) < 6 || len(n)%2 != 0 {
			return nil, fmt.Errorf("polygon needs at least 3 points")
		}
		order := len(n) / 2
		xs := make([]float64, order)
		ys := make([]float64, order)
		for i := 0; i < order; i++ {
			xs[i] = n[2*i]
			ys[i] = n[2*i+1]
		}
		return &Polygon{Worker: worker, Order: order, Convex: snap.Flag, X: xs, Y: ys}, nil
	}
	return nil, fmt.Errorf("unknown shape type %q", snap.Type)
}
