package app

// State represents a step in the installation state machine.
type State int

const (
	StateDetectPlatform State = iota
	StateCheckExisting
	StateFetchVersions
	StatePromptVersion
	StatePromptUpgrade
	StateValidateVer
	StateDownload
	StateVerifySum
	StateVerifySig
	StateInstall
	StateConfigurePATH
	StateInstallCompletions
	StateSuccess

	// Terminal failure states.
	StateFailPlatform
	StateFailNetwork
	StateFailVerify
	StateFailPermission
)

func (s State) String() string {
	switch s {
	case StateDetectPlatform:
		return "DetectPlatform"
	case StateCheckExisting:
		return "CheckExisting"
	case StateFetchVersions:
		return "FetchVersions"
	case StatePromptVersion:
		return "PromptVersion"
	case StatePromptUpgrade:
		return "PromptUpgrade"
	case StateValidateVer:
		return "ValidateVer"
	case StateDownload:
		return "Download"
	case StateVerifySum:
		return "VerifySum"
	case StateVerifySig:
		return "VerifySig"
	case StateInstall:
		return "Install"
	case StateConfigurePATH:
		return "ConfigurePATH"
	case StateInstallCompletions:
		return "InstallCompletions"
	case StateSuccess:
		return "Success"
	case StateFailPlatform:
		return "FAIL_PLATFORM"
	case StateFailNetwork:
		return "FAIL_NETWORK"
	case StateFailVerify:
		return "FAIL_VERIFY"
	case StateFailPermission:
		return "FAIL_PERMISSION"
	default:
		return "Unknown"
	}
}

// IsTerminal returns true if the state is a success or failure endpoint.
func (s State) IsTerminal() bool {
	return s == StateSuccess ||
		s == StateFailPlatform ||
		s == StateFailNetwork ||
		s == StateFailVerify ||
		s == StateFailPermission
}
