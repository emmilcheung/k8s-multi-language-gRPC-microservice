package graph

import (
	"github.com/acme/attendance-service/internal/repository"
)

func mapCredentialToGQL(c *repository.AdmissionCredential, transfer *repository.AdmissionTransfer) *AdmissionPass {
	ap := &AdmissionPass{
		ID:            c.ID,
		TicketID:      c.TicketID,
		OrderID:       c.OrderID,
		EventID:       c.EventID,
		Status:        CredentialStatus(c.Status),
		IssuedAt:      c.IssuedAt.Format("2006-01-02T15:04:05Z07:00"),
		TransferState: TransferStateNone,
	}
	if c.UsedAt != nil {
		usedAt := c.UsedAt.Format("2006-01-02T15:04:05Z07:00")
		ap.UsedAt = &usedAt
	}
	if c.QRToken != nil {
		ap.QRToken = c.QRToken
	}
	if transfer != nil {
		ap.TransferState = TransferState(transfer.State)
		ap.TransferredTo = transfer.RecipientUserID
		if transfer.AcceptedAt != nil {
			value := transfer.AcceptedAt.Format("2006-01-02T15:04:05Z07:00")
			ap.TransferredAt = &value
		}
		if transfer.RecalledAt != nil {
			value := transfer.RecalledAt.Format("2006-01-02T15:04:05Z07:00")
			ap.TransferredAt = &value
		}
	}
	return ap
}

func mapCredentialToCheckin(c *repository.AdmissionCredential) *EventCheckin {
	checkedInAt := c.IssuedAt.Format("2006-01-02T15:04:05Z07:00")
	if c.UsedAt != nil {
		checkedInAt = c.UsedAt.Format("2006-01-02T15:04:05Z07:00")
	}
	return &EventCheckin{
		ID:          c.ID,
		EventID:     c.EventID,
		TicketID:    c.TicketID,
		OrderID:     c.OrderID,
		UserID:      c.BuyerUserID,
		CheckedInAt: checkedInAt,
		Source:      CheckinSourceQRScan,
	}
}
