package ui

import "github.com/charmbracelet/lipgloss"

var (
	Pink       = lipgloss.Color("205")
	PinkDim    = lipgloss.Color("168")
	PinkBright = lipgloss.Color("212")
)

var (
	TitleStyle = lipgloss.NewStyle().
			Foreground(PinkBright).
			Bold(true)

	SuccessStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("82"))

	ErrorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("196"))

	MutedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("240"))

	SpinnerStyle = lipgloss.NewStyle().
			Foreground(Pink)
)
