package ai

import (
	"strings"
	"testing"
)

func TestSystemPromptRequiresPreviewForDataDependentAnswers(t *testing.T) {
	prompt := SystemPrompt()
	for _, requirement := range []string{
		"you MUST call preview_query",
		"Do not stop after propose_sql when data is needed",
		"never assume a numeric-looking column is numeric",
		"use it to correct the SQL",
		"Make at most two correction attempts",
		"Never claim that data was queried or verified unless preview_query succeeded",
		"explicitly say that the data could not be verified",
	} {
		if !strings.Contains(prompt, requirement) {
			t.Fatalf("system prompt is missing %q", requirement)
		}
	}
}
