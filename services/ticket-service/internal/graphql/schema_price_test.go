package graph

import "testing"

func TestIntPriceToDecimalString(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input int
		want  string
	}{
		{name: "whole dollars", input: 7500, want: "75.00"},
		{name: "fractional dollars", input: 1250, want: "12.50"},
		{name: "zero", input: 0, want: "0.00"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := intPriceToDecimalString(tt.input)
			if got != tt.want {
				t.Fatalf("intPriceToDecimalString(%d) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
