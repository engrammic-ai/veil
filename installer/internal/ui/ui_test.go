package ui

import (
	"strings"
	"testing"
)

func TestColors(t *testing.T) {
	if string(Pink) == "" {
		t.Fatal("Pink color must not be empty")
	}
	if string(PinkDim) == "" {
		t.Fatal("PinkDim color must not be empty")
	}
	if string(PinkBright) == "" {
		t.Fatal("PinkBright color must not be empty")
	}
}

func TestStyles(t *testing.T) {
	got := TitleStyle.Render("hello")
	if !strings.Contains(got, "hello") {
		t.Errorf("TitleStyle.Render should contain the input text")
	}
	got = SuccessStyle.Render("ok")
	if !strings.Contains(got, "ok") {
		t.Errorf("SuccessStyle.Render should contain the input text")
	}
}

func TestRenderBanner(t *testing.T) {
	out := RenderBanner()
	if out == "" {
		t.Errorf("RenderBanner should return non-empty output")
	}
}

func TestRenderMini(t *testing.T) {
	out := RenderMini("v0.3.1")
	if !strings.Contains(out, MiniCat) {
		t.Errorf("RenderMini should contain the mini cat")
	}
	if !strings.Contains(out, "v0.3.1") {
		t.Errorf("RenderMini should contain the version")
	}
}

func TestCatFrames(t *testing.T) {
	if len(CatFrames) == 0 {
		t.Fatal("CatFrames must not be empty")
	}
}

func TestSpinners(t *testing.T) {
	if len(SpinnerDots.Frames) == 0 {
		t.Error("SpinnerDots must have frames")
	}
	if len(SpinnerBounce.Frames) == 0 {
		t.Error("SpinnerBounce must have frames")
	}
	if len(SpinnerCheck.Frames) == 0 {
		t.Error("SpinnerCheck must have frames")
	}
	if len(SpinnerFail.Frames) == 0 {
		t.Error("SpinnerFail must have frames")
	}
	s := NewSpinner()
	if s.Spinner.FPS == 0 {
		t.Error("NewSpinner FPS must not be zero")
	}
}

func TestNewProgressBar(t *testing.T) {
	pb := NewProgressBar()
	_ = pb // just verify it constructs without panic
}

func TestProgressWithPulse(t *testing.T) {
	for _, pct := range []float64{0, 0.5, 1.0} {
		out := ProgressWithPulse(pct, 0)
		if out == "" {
			t.Errorf("ProgressWithPulse(%v) returned empty string", pct)
		}
	}
}

func TestSparkline(t *testing.T) {
	sl := NewSparkline(8)
	// Empty view should not panic.
	out := sl.View()
	if out == "" {
		t.Error("Sparkline.View() must not return empty string")
	}

	for _, v := range []float64{10, 20, 5, 40, 30, 15, 25, 35} {
		sl.Push(v)
	}
	out = sl.View()
	if out == "" {
		t.Error("Sparkline.View() after Push must not return empty string")
	}

	// Should not grow past width.
	for i := 0; i < 20; i++ {
		sl.Push(float64(i))
	}
	if len(sl.history) > sl.width {
		t.Errorf("Sparkline history grew past width: %d > %d", len(sl.history), sl.width)
	}
}

func TestCrossfade(t *testing.T) {
	cf := NewCrossfade("old", "new", 3)
	if cf.Done() {
		t.Error("Crossfade should not be done immediately")
	}
	for i := 0; i < 3; i++ {
		cf.Tick()
	}
	if !cf.Done() {
		t.Error("Crossfade should be done after Steps ticks")
	}
	if !strings.Contains(cf.View(), "new") {
		t.Error("Crossfade.View() after completion should contain target content")
	}
}

func TestSlideUp(t *testing.T) {
	content := "line1\nline2\nline3"
	su := NewSlideUp(content)
	if su.Done() {
		t.Error("SlideUp should not be done immediately")
	}
	out := su.View()
	if out != "" {
		t.Errorf("SlideUp.View() before any Tick should be empty, got %q", out)
	}
	su.Tick()
	out = su.View()
	if !strings.Contains(out, "line1") {
		t.Error("After first Tick, line1 should be visible")
	}
	su.Tick()
	su.Tick()
	if !su.Done() {
		t.Error("SlideUp should be done after ticking all lines")
	}
	if !strings.Contains(su.View(), "line3") {
		t.Error("After completion, all lines should be visible")
	}
}
