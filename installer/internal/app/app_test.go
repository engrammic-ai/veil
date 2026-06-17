package app

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// --- State.String() ---

func TestStateString(t *testing.T) {
	cases := []struct {
		state State
		want  string
	}{
		{StateDetectPlatform, "DetectPlatform"},
		{StateCheckExisting, "CheckExisting"},
		{StateFetchVersions, "FetchVersions"},
		{StatePromptVersion, "PromptVersion"},
		{StatePromptUpgrade, "PromptUpgrade"},
		{StateValidateVer, "ValidateVer"},
		{StateDownload, "Download"},
		{StateVerifySum, "VerifySum"},
		{StateVerifySig, "VerifySig"},
		{StateInstall, "Install"},
		{StateConfigurePATH, "ConfigurePATH"},
		{StateInstallCompletions, "InstallCompletions"},
		{StateSuccess, "Success"},
		{StateFailPlatform, "FAIL_PLATFORM"},
		{StateFailNetwork, "FAIL_NETWORK"},
		{StateFailVerify, "FAIL_VERIFY"},
		{StateFailPermission, "FAIL_PERMISSION"},
	}
	for _, c := range cases {
		if got := c.state.String(); got != c.want {
			t.Errorf("State(%d).String() = %q, want %q", c.state, got, c.want)
		}
	}
}

func TestStateIsTerminal(t *testing.T) {
	terminals := []State{StateSuccess, StateFailPlatform, StateFailNetwork, StateFailVerify, StateFailPermission}
	for _, s := range terminals {
		if !s.IsTerminal() {
			t.Errorf("expected %s to be terminal", s)
		}
	}
	nonTerminals := []State{StateDetectPlatform, StateDownload, StateInstall}
	for _, s := range nonTerminals {
		if s.IsTerminal() {
			t.Errorf("expected %s to NOT be terminal", s)
		}
	}
}

// --- nextState() transitions ---

func TestNextStateHappyPath(t *testing.T) {
	transitions := []struct {
		from   State
		result Result
		want   State
	}{
		{StateDetectPlatform, ResultOK, StateCheckExisting},
		{StateCheckExisting, ResultOK, StateFetchVersions},
		{StateCheckExisting, ResultConflict, StatePromptUpgrade},
		{StatePromptUpgrade, ResultOK, StateFetchVersions},
		{StateFetchVersions, ResultOK, StatePromptVersion},
		{StateFetchVersions, ResultVersionSet, StateValidateVer},
		{StateValidateVer, ResultOK, StateDownload},
		{StatePromptVersion, ResultOK, StateDownload},
		{StateDownload, ResultOK, StateVerifySum},
		{StateVerifySum, ResultOK, StateVerifySig},
		{StateVerifySig, ResultOK, StateInstall},
		{StateInstall, ResultOK, StateConfigurePATH},
		{StateConfigurePATH, ResultOK, StateSuccess},
		{StateConfigurePATH, ResultError, StateSuccess}, // best-effort
		{StateInstallCompletions, ResultOK, StateSuccess},
	}
	for _, tr := range transitions {
		got := nextState(tr.from, tr.result)
		if got != tr.want {
			t.Errorf("nextState(%s, %d) = %s, want %s", tr.from, tr.result, got, tr.want)
		}
	}
}

func TestNextStateFailurePaths(t *testing.T) {
	cases := []struct {
		from   State
		result Result
		want   State
	}{
		{StateDetectPlatform, ResultUnsupported, StateFailPlatform},
		{StateDownload, ResultTimeout, StateFailNetwork},
		{StateDownload, ResultError, StateFailNetwork},
		{StateVerifySum, ResultMismatch, StateFailVerify},
		{StateVerifySig, ResultInvalidSig, StateFailVerify},
		{StateInstall, ResultDenied, StateFailPermission},
	}
	for _, c := range cases {
		got := nextState(c.from, c.result)
		if got != c.want {
			t.Errorf("nextState(%s, %d) = %s, want %s", c.from, c.result, got, c.want)
		}
	}
}

func TestNextStateTerminalIsIdempotent(t *testing.T) {
	terminals := []State{StateSuccess, StateFailPlatform, StateFailNetwork, StateFailVerify, StateFailPermission}
	for _, s := range terminals {
		if got := nextState(s, ResultOK); got != s {
			t.Errorf("nextState(%s, OK) should be idempotent, got %s", s, got)
		}
	}
}

// --- Model ---

func TestNewModel(t *testing.T) {
	m := New(Options{})
	if m.state != StateDetectPlatform {
		t.Errorf("expected initial state DetectPlatform, got %s", m.state)
	}
}

func TestModelInitReturnsCmd(t *testing.T) {
	m := New(Options{})
	cmd := m.Init()
	if cmd == nil {
		t.Error("Init() should return a non-nil command")
	}
}

func TestModelQuitOnCtrlC(t *testing.T) {
	m := New(Options{})
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil {
		t.Fatal("expected quit command")
	}
	msg := cmd()
	if _, ok := msg.(tea.QuitMsg); !ok {
		t.Errorf("expected tea.QuitMsg, got %T", msg)
	}
}

func TestModelStepDoneMsgAdvancesState(t *testing.T) {
	m := New(Options{})
	// Manually send a stepDoneMsg with OK result from DetectPlatform.
	next, _ := m.Update(stepDoneMsg{result: ResultOK})
	nm := next.(*Model)
	if nm.state != StateCheckExisting {
		t.Errorf("expected CheckExisting after DetectPlatform OK, got %s", nm.state)
	}
}

func TestModelViewRendersState(t *testing.T) {
	m := New(Options{})
	view := m.View()
	if view == "" {
		t.Error("View() should not return empty string")
	}
}

func TestModelFailStateRecordsError(t *testing.T) {
	m := New(Options{})
	m.state = StateDownload
	next, cmd := m.Update(stepDoneMsg{result: ResultTimeout, err: errStub("connection timed out")})
	nm := next.(*Model)
	if nm.state != StateFailNetwork {
		t.Errorf("expected FAIL_NETWORK, got %s", nm.state)
	}
	if nm.err == nil {
		t.Error("expected error to be stored on model")
	}
	// Terminal state — cmd should be quit.
	if cmd == nil {
		t.Fatal("expected quit command after terminal state")
	}
}

type errStub string

func (e errStub) Error() string { return string(e) }
