package config

import "github.com/Masterminds/semver/v3"

// ParseVersion parses a semver string.
func ParseVersion(v string) (*semver.Version, error) {
	return semver.NewVersion(v)
}
