package ui

import (
	"strings"

	"github.com/charmbracelet/bubbles/progress"
)

const progressWidth = 40

// NewProgressBar returns a progress.Model configured with the pink theme.
func NewProgressBar() progress.Model {
	return progress.New(
		progress.WithSolidFill(string(Pink)),
		progress.WithWidth(progressWidth),
		progress.WithoutPercentage(),
	)
}

// ProgressWithPulse renders a fixed-width progress bar with an animated pulse
// on the leading edge. pct is 0.0–1.0 and tick cycles the pulse character.
func ProgressWithPulse(pct float64, tick int) string {
	filled := int(pct * float64(progressWidth))
	if filled > progressWidth {
		filled = progressWidth
	}

	pulseChars := []string{"░", "▒", "▓", "█"}
	pulse := pulseChars[tick%len(pulseChars)]

	filledPart := SpinnerStyle.Render(strings.Repeat("█", filled))
	if filled >= progressWidth {
		return filledPart
	}

	emptyCount := progressWidth - filled - 1
	empty := MutedStyle.Render(strings.Repeat("░", emptyCount))
	return filledPart + SpinnerStyle.Render(pulse) + empty
}
