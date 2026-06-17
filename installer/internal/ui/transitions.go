package ui

import "strings"

// CrossfadeTransition blends between two views using opacity steps.
type CrossfadeTransition struct {
	From    string
	To      string
	Steps   int
	Current int
}

// NewCrossfade creates a transition from one view string to another over steps frames.
func NewCrossfade(from, to string, steps int) *CrossfadeTransition {
	return &CrossfadeTransition{From: from, To: to, Steps: steps}
}

// Tick advances the transition by one frame.
func (t *CrossfadeTransition) Tick() {
	if t.Current < t.Steps {
		t.Current++
	}
}

// Done reports whether the transition has completed.
func (t *CrossfadeTransition) Done() bool {
	return t.Current >= t.Steps
}

// View returns the current frame. During transition it renders the incoming
// view with dimmed styling; once complete it renders the target view directly.
func (t *CrossfadeTransition) View() string {
	if t.Done() {
		return t.To
	}
	return MutedStyle.Render(t.To)
}

// SlideUpTransition reveals content by showing it line-by-line from the top.
type SlideUpTransition struct {
	lines   []string
	visible int
}

// NewSlideUp creates a transition that reveals content one line per Tick.
func NewSlideUp(content string) *SlideUpTransition {
	return &SlideUpTransition{lines: strings.Split(content, "\n")}
}

// Tick reveals one more line.
func (t *SlideUpTransition) Tick() {
	if t.visible < len(t.lines) {
		t.visible++
	}
}

// Done reports whether all lines are visible.
func (t *SlideUpTransition) Done() bool {
	return t.visible >= len(t.lines)
}

// View returns the currently visible portion of the content.
func (t *SlideUpTransition) View() string {
	end := t.visible
	if end > len(t.lines) {
		end = len(t.lines)
	}
	return strings.Join(t.lines[:end], "\n")
}
