package ui

import (
	"os"

	"github.com/charmbracelet/huh"
	"github.com/mattn/go-isatty"
)

const (
	LocationLocalBin = "~/.local/bin"
	LocationUsrLocal = "/usr/local/bin"
	LocationCustom   = "custom"
)

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
	)

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
		)
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
	)

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
	)

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
	)

	if err := form.Run(); err != nil {
		return false, err
	}

	return consent, nil
}
