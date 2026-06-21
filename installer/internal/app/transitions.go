package app

// Result codes returned by each step's worker command.
type Result int

const (
	ResultOK Result = iota
	ResultUnsupported
	ResultConflict      // existing install found
	ResultVersionSet    // --version flag provided
	ResultAlreadyLatest // already at target version
	ResultTimeout
	ResultError
	ResultMismatch
	ResultInvalidSig
	ResultDenied
	ResultSkip
)

// nextState returns the successor state given the current state and step result.
// Terminal states return themselves unchanged.
func nextState(current State, result Result) State {
	if current.IsTerminal() {
		return current
	}

	switch current {
	case StateDetectPlatform:
		if result == ResultOK {
			return StateCheckExisting
		}
		return StateFailPlatform

	case StateCheckExisting:
		switch result {
		case ResultOK:
			return StateFetchVersions
		case ResultConflict:
			return StatePromptUpgrade
		}
		return StateFailPlatform

	case StatePromptUpgrade:
		if result == ResultOK {
			return StateFetchVersions
		}
		// User declined upgrade — treat as success (no-op).
		return StateSuccess

	case StateFetchVersions:
		// Both ResultOK (got latest) and ResultVersionSet (user specified) go straight to download
		if result == ResultOK || result == ResultVersionSet {
			return StateDownload
		}
		if result == ResultAlreadyLatest {
			return StatePromptForce
		}
		return StateFailNetwork

	case StatePromptForce:
		if result == ResultOK {
			return StateDownload // User chose to force reinstall
		}
		return StateSuccess // User declined, exit successfully

	case StatePromptVersion, StateValidateVer:
		if result == ResultOK {
			return StateDownload
		}
		return StateFailPlatform

	case StateDownload:
		switch result {
		case ResultOK:
			return StateVerifySum
		case ResultTimeout, ResultError:
			return StateFailNetwork
		}
		return StateFailNetwork

	case StateVerifySum:
		if result == ResultOK {
			return StateVerifySig
		}
		return StateFailVerify

	case StateVerifySig:
		if result == ResultOK {
			return StateInstall
		}
		return StateFailVerify

	case StateInstall:
		if result == ResultOK {
			return StateConfigurePATH
		}
		return StateFailPermission

	case StateConfigurePATH:
		// PATH configuration is best-effort; warn but continue on failure.
		return StateInstallCompletions

	case StateInstallCompletions:
		return StatePromptEmbedder

	case StatePromptEmbedder:
		return StateConfigureEmbedder

	case StateConfigureEmbedder:
		return StateStartEmbedder

	case StateStartEmbedder:
		return StatePromptExtensions

	case StatePromptExtensions:
		if result == ResultSkip {
			return StateSuccess
		}
		return StateInstallExtensions

	case StateInstallExtensions:
		return StateSuccess
	}

	return current
}
