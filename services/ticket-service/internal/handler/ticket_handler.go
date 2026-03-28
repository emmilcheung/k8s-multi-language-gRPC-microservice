package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/service"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// TicketHandler handles HTTP requests for ticket operations.
type TicketHandler struct {
	svc *service.TicketService
	log *zap.Logger
}

// NewTicketHandler creates a new TicketHandler.
func NewTicketHandler(svc *service.TicketService, log *zap.Logger) *TicketHandler {
	return &TicketHandler{svc: svc, log: log}
}

// createTicketRequest is the request body for POST /api/tickets.
type createTicketRequest struct {
	Title string  `json:"title"`
	Price float64 `json:"price"`
}

// updateTicketRequest is the request body for PUT /api/tickets/:id.
type updateTicketRequest struct {
	Title string  `json:"title"`
	Price float64 `json:"price"`
}

// ticketResponse is the JSON response shape for a ticket.
type ticketResponse struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Price     float64 `json:"price"`
	UserID    string  `json:"userId"`
	OrderID   string  `json:"orderId,omitempty"`
	Version   int     `json:"version"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

func toResponse(t *repository.Ticket) ticketResponse {
	return ticketResponse{
		ID:        t.ID,
		Title:     t.Title,
		Price:     t.Price,
		UserID:    t.UserID,
		OrderID:   t.OrderID,
		Version:   t.Version,
		CreatedAt: t.CreatedAt.Format("2006-01-02T15:04:05Z"),
		UpdatedAt: t.UpdatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

// Create handles POST /api/tickets.
func (h *TicketHandler) Create(c echo.Context) error {
	userID := c.Request().Header.Get("X-User-Id")
	if userID == "" {
		return errorResponse(c, http.StatusUnauthorized, "UNAUTHORIZED", "Authentication required", nil)
	}

	var req createTicketRequest
	if err := c.Bind(&req); err != nil {
		return errorResponse(c, http.StatusBadRequest, "INVALID_JSON", "Invalid request body", nil)
	}

	// Validate input
	var details []map[string]string
	if req.Title == "" {
		details = append(details, map[string]string{"field": "title", "issue": "must not be empty"})
	}
	if len(req.Title) > 200 {
		details = append(details, map[string]string{"field": "title", "issue": "must not exceed 200 characters"})
	}
	if req.Price < 0 {
		details = append(details, map[string]string{"field": "price", "issue": "must be a non-negative number"})
	}
	if len(details) > 0 {
		return errorResponse(c, http.StatusBadRequest, "VALIDATION_FAILED", "Request validation failed", details)
	}

	ticket, err := h.svc.CreateTicket(c.Request().Context(), service.CreateTicketInput{
		Title:  req.Title,
		Price:  req.Price,
		UserID: userID,
	})
	if err != nil {
		h.log.Error("create ticket failed", zap.Error(err))
		return errorResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected error occurred", nil)
	}

	return c.JSON(http.StatusCreated, toResponse(ticket))
}

// List handles GET /api/tickets.
// Query params:
//   - limit: max results per page (1–100, default 20)
//   - after: cursor — the id of the last ticket from the previous page
func (h *TicketHandler) List(c echo.Context) error {
	var p repository.PaginationParams
	p.After = c.QueryParam("after")
	if rawLimit := c.QueryParam("limit"); rawLimit != "" {
		n, err := strconv.Atoi(rawLimit)
		if err != nil || n < 1 || n > 100 {
			return errorResponse(c, http.StatusBadRequest, "VALIDATION_FAILED", "limit must be an integer between 1 and 100", nil)
		}
		p.Limit = n
	}

	tickets, err := h.svc.ListTickets(c.Request().Context(), p)
	if err != nil {
		h.log.Error("list tickets failed", zap.Error(err))
		return errorResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected error occurred", nil)
	}

	resp := make([]ticketResponse, len(tickets))
	for i, t := range tickets {
		resp[i] = toResponse(t)
	}
	return c.JSON(http.StatusOK, resp)
}

// GetByID handles GET /api/tickets/:id.
func (h *TicketHandler) GetByID(c echo.Context) error {
	id := c.Param("id")
	ticket, err := h.svc.GetTicketByID(c.Request().Context(), id)
	if err != nil {
		if errors.Is(err, repository.ErrTicketNotFound) {
			return errorResponse(c, http.StatusNotFound, "NOT_FOUND", "Ticket not found", nil)
		}
		h.log.Error("get ticket failed", zap.Error(err), zap.String("ticketId", id))
		return errorResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected error occurred", nil)
	}
	return c.JSON(http.StatusOK, toResponse(ticket))
}

// Update handles PUT /api/tickets/:id.
func (h *TicketHandler) Update(c echo.Context) error {
	userID := c.Request().Header.Get("X-User-Id")
	if userID == "" {
		return errorResponse(c, http.StatusUnauthorized, "UNAUTHORIZED", "Authentication required", nil)
	}

	id := c.Param("id")

	var req updateTicketRequest
	if err := c.Bind(&req); err != nil {
		return errorResponse(c, http.StatusBadRequest, "INVALID_JSON", "Invalid request body", nil)
	}

	// Validate input
	var details []map[string]string
	if req.Title == "" {
		details = append(details, map[string]string{"field": "title", "issue": "must not be empty"})
	}
	if len(req.Title) > 200 {
		details = append(details, map[string]string{"field": "title", "issue": "must not exceed 200 characters"})
	}
	if req.Price < 0 {
		details = append(details, map[string]string{"field": "price", "issue": "must be a non-negative number"})
	}
	if len(details) > 0 {
		return errorResponse(c, http.StatusBadRequest, "VALIDATION_FAILED", "Request validation failed", details)
	}

	ticket, err := h.svc.UpdateTicket(c.Request().Context(), service.UpdateTicketInput{
		ID:     id,
		Title:  req.Title,
		Price:  req.Price,
		UserID: userID,
	})
	if err != nil {
		switch {
		case errors.Is(err, repository.ErrTicketNotFound):
			return errorResponse(c, http.StatusNotFound, "NOT_FOUND", "Ticket not found", nil)
		case errors.Is(err, service.ErrUnauthorized):
			return errorResponse(c, http.StatusForbidden, "FORBIDDEN", "Not authorised to modify this ticket", nil)
		case errors.Is(err, repository.ErrTicketReserved):
			return errorResponse(c, http.StatusConflict, "CONFLICT", "Cannot edit a reserved ticket", nil)
		case errors.Is(err, repository.ErrVersionConflict):
			return errorResponse(c, http.StatusConflict, "VERSION_CONFLICT", "Ticket was modified concurrently — please retry with fresh data", nil)
		default:
			h.log.Error("update ticket failed", zap.Error(err), zap.String("ticketId", id))
			return errorResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected error occurred", nil)
		}
	}

	return c.JSON(http.StatusOK, toResponse(ticket))
}

// errorResponse writes a consistent error response body matching the platform standard.
func errorResponse(c echo.Context, status int, code, message string, details interface{}) error {
	body := map[string]interface{}{
		"error": map[string]interface{}{
			"code":    code,
			"message": message,
			"details": details,
		},
	}
	return c.JSON(status, body)
}
