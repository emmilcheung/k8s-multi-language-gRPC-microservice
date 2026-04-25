package graph

import (
	"context"
	"fmt"

	"github.com/acme/venue-service/internal/repository"
	dataloader "github.com/graph-gophers/dataloader/v7"
)

// contextKey is an unexported type used to store per-request values in a
// context without colliding with keys from other packages.
type contextKey string

const planLoaderKey contextKey = "planLoader"

// planBatchFn is the DataLoader batch function. It receives all plan IDs
// queued during one event-loop tick, fetches the plans in a single FindByIDs
// query, then hydrates the sections for each plan before fanning results back
// in input order.
func planBatchFn(repo repository.PlanRepository, sectionRepo repository.SectionRepository) dataloader.BatchFunc[string, *SeatingPlan] {
	return func(ctx context.Context, keys []string) []*dataloader.Result[*SeatingPlan] {
		plans, err := repo.FindByIDs(ctx, keys)
		results := make([]*dataloader.Result[*SeatingPlan], len(keys))
		if err != nil {
			for i := range keys {
				results[i] = &dataloader.Result[*SeatingPlan]{Error: fmt.Errorf("planloader: %w", err)}
			}
			return results
		}
		for i, p := range plans {
			if p == nil {
				results[i] = &dataloader.Result[*SeatingPlan]{Data: nil}
			} else {
				sections, err := loadSections(ctx, sectionRepo, p.ID)
				if err != nil {
					results[i] = &dataloader.Result[*SeatingPlan]{Error: fmt.Errorf("planloader sections: %w", err)}
					continue
				}
				results[i] = &dataloader.Result[*SeatingPlan]{Data: mapPlanToGQL(p, sections)}
			}
		}
		return results
	}
}

// NewPlanLoader constructs a per-request DataLoader backed by the given repo.
func NewPlanLoader(repo repository.PlanRepository, sectionRepo repository.SectionRepository) *dataloader.Loader[string, *SeatingPlan] {
	return dataloader.NewBatchedLoader(planBatchFn(repo, sectionRepo))
}

// WithPlanLoader stores a loader instance in the context.
func WithPlanLoader(ctx context.Context, loader *dataloader.Loader[string, *SeatingPlan]) context.Context {
	return context.WithValue(ctx, planLoaderKey, loader)
}

// PlanLoaderFrom retrieves the per-request loader from the context.
// It panics if the loader was not stored — this is a programmer error that
// should be caught during development.
func PlanLoaderFrom(ctx context.Context) *dataloader.Loader[string, *SeatingPlan] {
	loader, ok := ctx.Value(planLoaderKey).(*dataloader.Loader[string, *SeatingPlan])
	if !ok || loader == nil {
		panic("planloader: not found in context — did you forget to attach the middleware?")
	}
	return loader
}

// loadPlan pulls one plan through the per-request loader.
// A nil result with no error means the plan does not exist.
func loadPlan(ctx context.Context, id string) (*SeatingPlan, error) {
	loader := PlanLoaderFrom(ctx)
	thunk := loader.Load(ctx, id)
	plan, err := thunk()
	if err != nil {
		return nil, err
	}
	return plan, nil
}
