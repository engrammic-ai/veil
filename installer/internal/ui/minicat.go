package ui

import (
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// CatState represents the current state of the mini cat.
type CatState int

const (
	CatIdle CatState = iota
	CatWorking
	CatSuccess
	CatError
)

// MiniCat is an animated mini cat for progress indication.
type MiniCat struct {
	state     CatState
	frame     int
	lastTick  time.Time
	interval  time.Duration
}

// Cat frames for each state - 3 lines each
// Only eyes animate, mouth (> ^ <) stays fixed
var catFrames = map[CatState][][]string{
	CatIdle: {
		{"  /\\___/\\  ", " (  o.o  ) ", "  >  ^  <  "},
		{"  /\\___/\\  ", " (  o.o  ) ", "  >  ^  <  "},
		{"  /\\___/\\  ", " (  :3   ) ", "  >  ^  <  "}, // happy blink
		{"  /\\___/\\  ", " (  o.o  ) ", "  >  ^  <  "},
	},
	CatWorking: {
		{"  /\\_/\\  ", " ( o.o ) ", "  > ^ <  "}, // center
		{"  /\\_/\\  ", " (  o.o) ", "  > ^ <  "},  // look right
		{"  /\\_/\\  ", " ( -.- ) ", "  > ^ <  "}, // center
		{"  /\\_/\\  ", " (o.o  ) ", "  > ^ <  "},  // look left
		{"  /\\_/\\  ", " ( o.o ) ", "  > ^ <  "}, // center
		{"  /\\_/\\  ", " ( -.- ) ", "  > ^ <  "}, // blink
	},
	CatSuccess: {
		{"  /\\_/\\  ", " ( ^.^ ) ", "  > ^ <  "},
	},
	CatError: {
		{"  /\\_/\\  ", " ( x.x ) ", "  > ^ <  "},
	},
}

var catColors = map[CatState]lipgloss.Color{
	CatIdle:    Pink,
	CatWorking: Pink,
	CatSuccess: Green,
	CatError:   Red,
}

// NewMiniCat creates a new mini cat component.
func NewMiniCat() *MiniCat {
	return &MiniCat{
		state:    CatIdle,
		frame:    0,
		interval: 600 * time.Millisecond, // chill ~1.5 FPS
	}
}

// SetState changes the cat's state.
func (c *MiniCat) SetState(state CatState) {
	if c.state != state {
		c.state = state
		c.frame = 0
	}
}

// TickMsg triggers animation frame advance.
type TickMsg time.Time

// Tick returns a command that sends a tick after the interval.
func (c *MiniCat) Tick() tea.Cmd {
	return tea.Tick(c.interval, func(t time.Time) tea.Msg {
		return TickMsg(t)
	})
}

// Update handles tick messages to advance animation.
func (c *MiniCat) Update(msg tea.Msg) tea.Cmd {
	if _, ok := msg.(TickMsg); ok {
		frames := catFrames[c.state]
		if len(frames) > 1 {
			c.frame = (c.frame + 1) % len(frames)
		}
		return c.Tick()
	}
	return nil
}

// View renders the current cat frame.
func (c *MiniCat) View() string {
	frames := catFrames[c.state]
	if len(frames) == 0 {
		return ""
	}

	frame := frames[c.frame%len(frames)]
	color := catColors[c.state]
	style := lipgloss.NewStyle().Foreground(color)

	var result string
	for i, line := range frame {
		result += style.Render(line)
		if i < len(frame)-1 {
			result += "\n"
		}
	}
	return result
}

// ViewWithStatus renders the cat with a status message beside it.
func (c *MiniCat) ViewWithStatus(status string, spinner string) string {
	frames := catFrames[c.state]
	if len(frames) == 0 {
		return ""
	}

	frame := frames[c.frame%len(frames)]
	color := catColors[c.state]
	catStyle := lipgloss.NewStyle().Foreground(color)
	statusStyle := MutedStyle

	lines := make([]string, len(frame))
	for i, line := range frame {
		catPart := catStyle.Render(line)
		if i == 1 {
			// Put status next to the middle line (the face)
			if spinner != "" {
				lines[i] = catPart + "  " + spinner + " " + statusStyle.Render(status)
			} else {
				lines[i] = catPart + "  " + statusStyle.Render(status)
			}
		} else {
			lines[i] = catPart
		}
	}

	var result string
	for i, line := range lines {
		result += line
		if i < len(lines)-1 {
			result += "\n"
		}
	}
	return result
}
