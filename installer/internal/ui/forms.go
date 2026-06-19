package ui

import (
	"os"

	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-isatty"
)

const (
	LocationLocalBin = "~/.local/bin"
	LocationUsrLocal = "/usr/local/bin"
	LocationCustom   = "custom"
)

// VeilTheme returns a custom huh theme with Veil's pink/purple colors
func VeilTheme() *huh.Theme {
	t := huh.ThemeBase()

	// Primary colors
	pink := lipgloss.AdaptiveColor{Light: "205", Dark: "205"}
	pinkDim := lipgloss.AdaptiveColor{Light: "168", Dark: "168"}
	muted := lipgloss.AdaptiveColor{Light: "240", Dark: "240"}
	green := lipgloss.AdaptiveColor{Light: "42", Dark: "42"}

	// Focus styling
	t.Focused.Base = t.Focused.Base.BorderForeground(pink)
	t.Focused.Title = t.Focused.Title.Foreground(pink).Bold(true)
	t.Focused.Description = t.Focused.Description.Foreground(muted)
	t.Focused.SelectSelector = t.Focused.SelectSelector.Foreground(pink)
	t.Focused.SelectedOption = t.Focused.SelectedOption.Foreground(pink).Bold(true)
	t.Focused.UnselectedOption = t.Focused.UnselectedOption.Foreground(muted)
	t.Focused.FocusedButton = t.Focused.FocusedButton.Background(pink).Foreground(lipgloss.Color("0"))
	t.Focused.BlurredButton = t.Focused.BlurredButton.Foreground(pinkDim)
	t.Focused.TextInput.Cursor = t.Focused.TextInput.Cursor.Foreground(pink)
	t.Focused.TextInput.Prompt = t.Focused.TextInput.Prompt.Foreground(pink)

	// Blurred styling
	t.Blurred.Base = t.Blurred.Base.BorderForeground(muted)
	t.Blurred.Title = t.Blurred.Title.Foreground(pinkDim)
	t.Blurred.SelectSelector = t.Blurred.SelectSelector.Foreground(pinkDim)
	t.Blurred.SelectedOption = t.Blurred.SelectedOption.Foreground(green)

	return t
}

// IsTTY reports whether stdin is an interactive terminal.
func IsTTY() bool {
	return isatty.IsTerminal(os.Stdin.Fd()) || isatty.IsCygwinTerminal(os.Stdin.Fd())
}

// PromptInstallLocation asks the user where to install the binary.
// In non-TTY mode it returns LocationLocalBin without prompting.
func PromptInstallLocation() (string, error) {
	if !IsTTY() {
		return LocationLocalBin, nil
	}

	var choice string
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Install location").
				Options(
					huh.NewOption("~/.local/bin (recommended)", LocationLocalBin),
					huh.NewOption("/usr/local/bin (requires sudo)", LocationUsrLocal),
					huh.NewOption("Custom...", LocationCustom),
				).
				Value(&choice),
		),
	).WithTheme(VeilTheme())

	if err := form.Run(); err != nil {
		return "", err
	}

	if choice == LocationCustom {
		var custom string
		customForm := huh.NewForm(
			huh.NewGroup(
				huh.NewInput().
					Title("Custom install path").
					Value(&custom),
			),
		).WithTheme(VeilTheme())
		if err := customForm.Run(); err != nil {
			return "", err
		}
		return custom, nil
	}

	return choice, nil
}

// PromptPATH asks whether to add the install location to PATH via rcFile.
// In non-TTY mode it returns true without prompting.
func PromptPATH(rcFile string) (bool, error) {
	if !IsTTY() {
		return true, nil
	}

	var consent bool
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title("Add to PATH? (" + rcFile + ")").
				Value(&consent),
		),
	).WithTheme(VeilTheme())

	if err := form.Run(); err != nil {
		return false, err
	}

	return consent, nil
}

// PromptCompletions asks whether to install shell completions for the given shell.
// In non-TTY mode it returns true without prompting.
func PromptCompletions(shell string) (bool, error) {
	if !IsTTY() {
		return true, nil
	}

	var consent bool
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title("Install shell completions? (" + shell + ")").
				Value(&consent),
		),
	).WithTheme(VeilTheme())

	if err := form.Run(); err != nil {
		return false, err
	}

	return consent, nil
}

// PromptTelemetry asks the user to opt in to anonymous telemetry.
// In non-TTY mode it returns false (opt-out) without prompting.
func PromptTelemetry() (bool, error) {
	if !IsTTY() {
		return false, nil
	}

	var consent bool
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title("Send anonymous usage data to help improve Veil?").
				Description("No personal data is collected. You can change this later.").
				Value(&consent),
		),
	).WithTheme(VeilTheme())

	if err := form.Run(); err != nil {
		return false, err
	}

	return consent, nil
}
