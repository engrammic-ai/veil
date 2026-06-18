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
}

func TestStyles(t *testing.T) {
	got := SuccessStyle.Render("ok")
	if !strings.Contains(got, "ok") {
		t.Errorf("SuccessStyle.Render should contain the input text")
	}
	got = ErrorStyle.Render("err")
	if !strings.Contains(got, "err") {
		t.Errorf("ErrorStyle.Render should contain the input text")
	}
	got = MutedStyle.Render("muted")
	if !strings.Contains(got, "muted") {
		t.Errorf("MutedStyle.Render should contain the input text")
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
	if !strings.Contains(out, CatMini) {
		t.Errorf("RenderMini should contain the mini cat")
	}
	if !strings.Contains(out, "v0.3.1") {
		t.Errorf("RenderMini should contain the version")
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
