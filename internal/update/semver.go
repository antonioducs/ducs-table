package update

import (
	"fmt"
	"strconv"
	"strings"
)

// Version is a parsed Semantic Versioning 2.0 value. Build metadata is
// accepted and ignored because it does not affect precedence.
type Version struct {
	Major      int
	Minor      int
	Patch      int
	Prerelease string
}

// ParseVersion accepts MAJOR.MINOR.PATCH with an optional "v" prefix,
// prerelease suffix, and build metadata.
func ParseVersion(value string) (Version, error) {
	text := strings.TrimPrefix(strings.TrimSpace(value), "v")
	if index := strings.IndexByte(text, '+'); index >= 0 {
		text = text[:index]
	}
	core, prerelease, hasPrerelease := strings.Cut(text, "-")
	if hasPrerelease && !validPrerelease(prerelease) {
		return Version{}, fmt.Errorf("invalid prerelease in version %q", value)
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return Version{}, fmt.Errorf("version %q must have MAJOR.MINOR.PATCH", value)
	}
	numbers := make([]int, 3)
	for index, part := range parts {
		number, err := numericIdentifier(part)
		if err != nil {
			return Version{}, fmt.Errorf("invalid version %q: %w", value, err)
		}
		numbers[index] = number
	}
	return Version{Major: numbers[0], Minor: numbers[1], Patch: numbers[2], Prerelease: prerelease}, nil
}

func (v Version) String() string {
	text := fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
	if v.Prerelease != "" {
		text += "-" + v.Prerelease
	}
	return text
}

// Compare returns -1, 0, or 1 following SemVer precedence.
func (v Version) Compare(other Version) int {
	for _, pair := range [][2]int{{v.Major, other.Major}, {v.Minor, other.Minor}, {v.Patch, other.Patch}} {
		if pair[0] != pair[1] {
			return compareInts(pair[0], pair[1])
		}
	}
	switch {
	case v.Prerelease == other.Prerelease:
		return 0
	case v.Prerelease == "":
		return 1
	case other.Prerelease == "":
		return -1
	}
	left, right := strings.Split(v.Prerelease, "."), strings.Split(other.Prerelease, ".")
	for index := 0; index < len(left) && index < len(right); index++ {
		if result := comparePrereleaseIdentifier(left[index], right[index]); result != 0 {
			return result
		}
	}
	return compareInts(len(left), len(right))
}

func numericIdentifier(part string) (int, error) {
	if part == "" {
		return 0, fmt.Errorf("empty numeric identifier")
	}
	if len(part) > 1 && part[0] == '0' {
		return 0, fmt.Errorf("numeric identifier %q has a leading zero", part)
	}
	for _, char := range part {
		if char < '0' || char > '9' {
			return 0, fmt.Errorf("numeric identifier %q is not a number", part)
		}
	}
	return strconv.Atoi(part)
}

func validPrerelease(value string) bool {
	if value == "" {
		return false
	}
	for _, identifier := range strings.Split(value, ".") {
		if identifier == "" {
			return false
		}
		for _, char := range identifier {
			if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char == '-') {
				return false
			}
		}
	}
	return true
}

func comparePrereleaseIdentifier(left, right string) int {
	leftNumber, leftErr := numericIdentifier(left)
	rightNumber, rightErr := numericIdentifier(right)
	switch {
	case leftErr == nil && rightErr == nil:
		return compareInts(leftNumber, rightNumber)
	case leftErr == nil:
		return -1
	case rightErr == nil:
		return 1
	}
	return strings.Compare(left, right)
}

func compareInts(left, right int) int {
	switch {
	case left < right:
		return -1
	case left > right:
		return 1
	}
	return 0
}
