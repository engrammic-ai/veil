package ui

import "strings"

var sparkBlocks = []rune{'▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'}

// Sparkline renders a fixed-width inline speed graph.
type Sparkline struct {
	history []float64
	width   int
}

// NewSparkline creates a Sparkline that keeps at most width samples.
func NewSparkline(width int) *Sparkline {
	return &Sparkline{width: width}
}

// Push adds a new sample, dropping the oldest when at capacity.
func (s *Sparkline) Push(value float64) {
	s.history = append(s.history, value)
	if len(s.history) > s.width {
		s.history = s.history[len(s.history)-s.width:]
	}
}

// View renders the sparkline as a string of block characters.
func (s *Sparkline) View() string {
	if len(s.history) == 0 {
		return strings.Repeat(string(sparkBlocks[0]), s.width)
	}

	max := s.history[0]
	for _, v := range s.history {
		if v > max {
			max = v
		}
	}

	var sb strings.Builder
	for _, v := range s.history {
		idx := 0
		if max > 0 {
			idx = int(v / max * float64(len(sparkBlocks)-1))
		}
		sb.WriteRune(sparkBlocks[idx])
	}
	return SpinnerStyle.Render(sb.String())
}
