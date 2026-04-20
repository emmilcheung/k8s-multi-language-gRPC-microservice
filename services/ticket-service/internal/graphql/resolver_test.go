package graph_test

import (
	"testing"

	"github.com/99designs/gqlgen/graphql/handler"
	graph "github.com/acme/ticket-service/internal/graphql"
	"github.com/acme/ticket-service/internal/repository"
)

// TestSchemaWiring verifies that the GraphQL schema and resolver plumbing compile
// and wire together correctly without panicking at construction time.
func TestSchemaWiring(t *testing.T) {
	r := &graph.Resolver{} // nil TicketService — only tests wiring, not runtime calls
	schema := graph.NewExecutableSchema(graph.Config{Resolvers: r})
	srv := handler.NewDefaultServer(schema)
	if srv == nil {
		t.Fatal("expected non-nil handler")
	}
	t.Log("GraphQL schema and resolver wiring compiles correctly")
}

// TestTicketTypeEnums verifies the generated enum values match the expected string constants.
func TestTicketTypeEnums(t *testing.T) {
	if graph.TicketTypeGeneralAdmission.String() != "GENERAL_ADMISSION" {
		t.Errorf("expected GENERAL_ADMISSION, got %s", graph.TicketTypeGeneralAdmission.String())
	}
	if graph.TicketTypeSeated.String() != "SEATED" {
		t.Errorf("expected SEATED, got %s", graph.TicketTypeSeated.String())
	}
}

// Compile-time assertion: PaginationParams zero value is usable (prevents import drift).
var _ = repository.PaginationParams{}
