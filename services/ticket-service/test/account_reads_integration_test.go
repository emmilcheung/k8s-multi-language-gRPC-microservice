package integration_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/acme/ticket-service/internal/audit"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFindByAccount_ShouldReturnOnlyThatAccountsEventsNewestFirstAcrossPages(t *testing.T) {
	env := newAuditEnv(t)
	ctx := context.Background()
	for i, account := range []string{"acct-1", "acct-2", "acct-1", "acct-1"} {
		require.NoError(t, env.repo.Create(ctx, &repository.Ticket{
			ID: fmt.Sprintf("t%d", i), Title: "Show", Price: "10.00", UserID: "u", AccountID: account,
		}))
		time.Sleep(5 * time.Millisecond) // distinct createdAt so the order is defined
	}

	page1, err := env.repo.FindByAccount(ctx, "acct-1", 2, "")
	require.NoError(t, err)
	require.Len(t, page1, 2)
	assert.Equal(t, []string{"t3", "t2"}, []string{page1[0].ID, page1[1].ID})

	last := page1[1]
	page2, err := env.repo.FindByAccount(ctx, "acct-1", 2, fmt.Sprintf("%d:%s", last.CreatedAt.UnixMilli(), last.ID))
	require.NoError(t, err)
	require.Len(t, page2, 1, "the other account's event must never appear")
	assert.Equal(t, "t0", page2[0].ID)
}

func TestListAuditByResource_ShouldReturnOneEventsHistoryNewestFirstAcrossPages(t *testing.T) {
	env := newAuditEnv(t)
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Millisecond)
	for i, e := range []audit.Entry{
		{At: base.Add(-2 * time.Hour), Action: "event.create", Resource: "ticket:t1", ActorUserID: "u"},
		{At: base.Add(-1 * time.Hour), Action: "event.edit", Resource: "ticket:t1", ActorUserID: "u", ActorAccountID: "acct-1"},
		{At: base, Action: "event.edit", Resource: "ticket:t1", ActorUserID: "u"},
		{At: base, Action: "event.create", Resource: "ticket:other", ActorUserID: "u"},
	} {
		require.NoError(t, env.repo.WriteAuditEntry(ctx, fmt.Sprintf("evt-%d", i), e))
	}

	page1, err := env.repo.ListAuditByResource(ctx, "ticket:t1", 2, "")
	require.NoError(t, err)
	require.Len(t, page1, 2)
	assert.Equal(t, "evt-2", page1[0].ID)
	assert.Equal(t, "evt-1", page1[1].ID)
	assert.Equal(t, "acct-1", page1[1].ActorAccountID)

	cursor := fmt.Sprintf("%d:%s", page1[1].At.UnixMilli(), page1[1].ID)
	page2, err := env.repo.ListAuditByResource(ctx, "ticket:t1", 2, cursor)
	require.NoError(t, err)
	require.Len(t, page2, 1)
	assert.Equal(t, "evt-0", page2[0].ID)
}
