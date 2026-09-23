package update

import "testing"

func TestParseVersionAcceptsTagsAndRejectsMalformedValues(t *testing.T) {
	valid := map[string]Version{
		"0.1.2":            {Major: 0, Minor: 1, Patch: 2},
		"v1.10.0":          {Major: 1, Minor: 10, Patch: 0},
		" v2.0.0-rc.1 ":    {Major: 2, Prerelease: "rc.1"},
		"1.2.3+build.7":    {Major: 1, Minor: 2, Patch: 3},
		"1.2.3-beta+exp.1": {Major: 1, Minor: 2, Patch: 3, Prerelease: "beta"},
	}
	for input, want := range valid {
		got, err := ParseVersion(input)
		if err != nil || got != want {
			t.Errorf("ParseVersion(%q) = %+v, %v; want %+v", input, got, err, want)
		}
	}
	for _, input := range []string{"", "1.2", "1.2.3.4", "01.2.3", "1.x.3", "1.2.3-", "1.2.3-beta..1", "1.2.3-bad_char", "latest"} {
		if _, err := ParseVersion(input); err == nil {
			t.Errorf("ParseVersion(%q) succeeded; want error", input)
		}
	}
}

func TestVersionCompareFollowsSemVerPrecedence(t *testing.T) {
	ordered := []string{"0.1.2", "0.1.10", "0.2.0-alpha", "0.2.0-alpha.1", "0.2.0-alpha.beta", "0.2.0-beta.2", "0.2.0-beta.11", "0.2.0-rc.1", "0.2.0", "1.0.0"}
	for index := 0; index+1 < len(ordered); index++ {
		left, _ := ParseVersion(ordered[index])
		right, _ := ParseVersion(ordered[index+1])
		if left.Compare(right) != -1 || right.Compare(left) != 1 {
			t.Errorf("expected %s < %s", ordered[index], ordered[index+1])
		}
	}
	same, _ := ParseVersion("v1.2.3+meta")
	if other, _ := ParseVersion("1.2.3"); same.Compare(other) != 0 {
		t.Fatal("build metadata must not affect precedence")
	}
}
