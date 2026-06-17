// Package exitcodes defines standard exit codes for the veil-installer and
// helper functions for terminating the process with a meaningful message.
package exitcodes

import (
	"fmt"
	"os"
)

// Standard exit codes.
const (
	// OK indicates successful completion.
	OK = 0
	// ErrGeneral is a catch-all for unexpected errors.
	ErrGeneral = 1
	// ErrNetwork is returned when a network or download operation fails.
	ErrNetwork = 2
	// ErrVerification is returned when a checksum or signature check fails.
	ErrVerification = 3
	// ErrPermission is returned when an operation is denied due to permissions.
	ErrPermission = 4
	// ErrNotInstalled is returned when veil is not installed but is required
	// (e.g. update or uninstall invoked without a prior install).
	ErrNotInstalled = 5
	// ErrAlreadyInstalled is returned when veil is already at the latest version.
	ErrAlreadyInstalled = 6
	// ErrUserCancelled is returned when the user interrupts the process (Ctrl+C).
	ErrUserCancelled = 130
)

// Exit prints msg to stderr and terminates the process with the given code.
// A trailing newline is added if msg is not empty.
func Exit(code int, msg string) {
	if msg != "" {
		fmt.Fprintln(os.Stderr, msg)
	}
	os.Exit(code)
}

// ExitError prints err.Error() to stderr and terminates the process with code.
func ExitError(code int, err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
	}
	os.Exit(code)
}
