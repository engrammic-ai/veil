package ui

import (
	"time"

	"github.com/charmbracelet/bubbles/spinner"
)

var SpinnerDots = spinner.Spinner{
	Frames: []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"},
	FPS:    time.Second / 12,
}

var SpinnerBounce = spinner.Spinner{
	Frames: []string{"⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"},
	FPS:    time.Second / 10,
}

var SpinnerCheck = spinner.Spinner{
	Frames: []string{"○", "◔", "◑", "◕", "●", "✓"},
	FPS:    time.Second / 8,
}

var SpinnerFail = spinner.Spinner{
	Frames: []string{"○", "◔", "◑", "◕", "●", "✗"},
	FPS:    time.Second / 8,
}

// NewSpinner returns a default dots spinner styled with Pink.
func NewSpinner() spinner.Model {
	s := spinner.New()
	s.Spinner = SpinnerDots
	s.Style = SpinnerStyle
	return s
}
