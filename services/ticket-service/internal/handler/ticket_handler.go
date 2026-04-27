package handler

import (
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/security"
	"github.com/acme/ticket-service/internal/service"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// uuidRE matches a canonical UUID v4 string (case-insensitive).
var uuidRE = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// decimalPriceRE matches a positive decimal string with up to 15 integer digits and 4 decimal places.
var decimalPriceRE = regexp.MustCompile(`^\d{1,15}(\.\d{1,4})?$`)

// TicketHandler handles HTTP requests for ticket operations.
type TicketHandler struct {
	svc                *service.TicketService
	log                *zap.Logger
	signatureValidator *security.UserIDSignatureValidator
}

// NewTicketHandler creates a new TicketHandler.
func NewTicketHandler(svc *service.TicketService, log *zap.Logger, sigValidator *security.UserIDSignatureValidator) *TicketHandler {
	return &TicketHandler{
		svc:                svc,
		log:                log,
		signatureValidator: sigValidator,
	}
}

// createTicketRequest is the request body for POST /api/tickets.
// Price is a decimal string to avoid IEEE 754 precision drift on purchase paths.
// Event is optional; if provided, startsAt is required.
// WS8: Event metadata support.
type createTicketRequest struct {
	Title      string `json:"title"`
	Price      string `json:"price"`
	Quota      int    `json:"quota"`
	MaxPerUser int    `json:"maxPerUser"`
	Event      *struct {
		Title        string     `json:"title"`
		Description  string     `json:"description,omitempty"`
		StartsAt     time.Time  `json:"startsAt"`
		EndsAt       *time.Time `json:"endsAt,omitempty"`
		ImageURL     string     `json:"imageUrl,omitempty"`
		VenueName    string     `json:"venueName,omitempty"`
		VenueAddress string     `json:"venueAddress,omitempty"`
	} `json:"event,omitempty"`
}

// updateTicketRequest is the request body for PUT /api/tickets/:id.
// SeatingPlanID is optional; if provided and non-empty, the ticket will be linked to a venue-service seating plan.
type updateTicketRequest struct {
	Title         string `json:"title"`
	Price         string `json:"price"`
	SeatingPlanID string `json:"seatingPlanId,omitempty"`
	TicketType    string `json:"ticketType,omitempty"`
}

// ticketResponse is the JSON response shape for a ticket.
// WS8: Event is nullable to support legacy tickets without event metadata.
// WS3: TicketType denormalizes assignment mode from linked seating plan.
type ticketResponse struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Price         string `json:"price"`
	UserID        string `json:"userId"`
	OrderID       string `json:"orderId,omitempty"`
	SeatingPlanID string `json:"seatingPlanId,omitempty"`
	TicketType    string `json:"ticketType,omitempty"`
	Quota         int    `json:"quota"`
	Reserved      int    `json:"reserved"`
	Sold          int    `json:"sold"`
	MaxPerUser    int    `json:"maxPerUser"`
	Version       int    `json:"version"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
	Event         *struct {
		Title        string  `json:"title"`
		Description  string  `json:"description,omitempty"`
		StartsAt     string  `json:"startsAt"`
		EndsAt       *string `json:"endsAt,omitempty"`
		ImageURL     string  `json:"imageUrl,omitempty"`
		VenueName    string  `json:"venueName,omitempty"`
		VenueAddress string  `json:"venueAddress,omitempty"`
	} `json:"event,omitempty"`
}

func toResponse(t *repository.Ticket) ticketResponse {
	resp := ticketResponse{
		ID:            t.ID,
		Title:         t.Title,
		Price:         t.Price,
		UserID:        t.UserID,
		OrderID:       t.OrderID,
		SeatingPlanID: t.SeatingPlanID,
		TicketType:    t.TicketType,
		Quota:         t.Quota,
		Reserved:      t.Reserved,
		Sold:          t.Sold,
		MaxPerUser:    t.MaxPerUser,
		Version:       t.Version,
		CreatedAt:     t.CreatedAt.Format("2006-01-02T15:04:05Z"),
		UpdatedAt:     t.UpdatedAt.Format("2006-01-02T15:04:05Z"),
	}
	// WS8: Convert event if present
	if t.Event != nil {
		endsAt := (*string)(nil)
		if t.Event.EndsAt != nil {
			s := t.Event.EndsAt.Format("2006-01-02T15:04:05Z")
			endsAt = &s
		}
		resp.Event = &struct {
			Title        string  `json:"title"`
			Description  string  `json:"description,omitempty"`
			StartsAt     string  `json:"startsAt"`
			EndsAt       *string `json:"endsAt,omitempty"`
			ImageURL     string  `json:"imageUrl,omitempty"`
			VenueName    string  `json:"venueName,omitempty"`
			VenueAddress string  `json:"venueAddress,omitempty"`
		}{
			Title:        t.Event.Title,
			Description:  t.Event.Description,
			StartsAt:     t.Event.StartsAt.Format("2006-01-02T15:04:05Z"),
			EndsAt:       endsAt,
			ImageURL:     t.Event.ImageURL,
			VenueName:    t.Event.VenueName,
			VenueAddress: t.Event.VenueAddress,
		}
	}
	return resp
}

// validatePrice checks that price is a non-negative decimal string with up to 15 integer
// digits and 4 decimal places. Returns the trimmed raw string on success.
func validatePrice(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("price is required")
	}
	if !decimalPriceRE.MatchString(raw) {
		return "", errors.New("price must be a positive decimal number with up to 15 integer digits and 4 decimal places (e.g. \"9.99\")")
	}
	return raw, nil
}

// Create handles POST /api/tickets.
func (h *TicketHandler) Create(c echo.Context) error {
	userID := c.Request().Header.Get("X-User-Id")
	if userID == "" {
		return errorResponse(c, http.StatusUnauthorized, "UNAUTHORIZED", "Authentication required", nil)
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.signatureValidator.IsValidSignature(userID, signature) {
		return errorResponse(c, http.StatusUnauthorized, "INVALID_SIGNATURE", "Invalid user ID signature", nil)
	}

	rolesHeader := c.Request().Header.Get("X-User-Roles")
	roles := security.ParseUserRoles(rolesHeader)
	if !security.HasRole(roles, "organizer") {
		return errorResponse(c, http.StatusForbidden, "FORBIDDEN", "Only organizers can create tickets", nil)
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
	if utf8.RuneCountInString(req.Title) > 200 {
		details = append(details, map[string]string{"field": "title", "issue": "must not exceed 200 characters"})
	}
	normPrice, priceErr := validatePrice(req.Price)
	if priceErr != nil {
		details = append(details, map[string]string{"field": "price", "issue": priceErr.Error()})
	}
	if req.Quota < 0 {
		details = append(details, map[string]string{"field": "quota", "issue": "must be a non-negative integer"})
	}
	if req.MaxPerUser < 0 {
		details = append(details, map[string]string{"field": "maxPerUser", "issue": "must be a non-negative integer"})
	}
	if len(details) > 0 {
		return errorResponse(c, http.StatusBadRequest, "VALIDATION_FAILED", "Request validation failed", details)
	}

	// WS8: Map event data if provided
	var eventData *repository.TicketEvent
	if req.Event != nil {
		eventData = &repository.TicketEvent{
			Title:        req.Event.Title,
			Description:  req.Event.Description,
			StartsAt:     req.Event.StartsAt,
			EndsAt:       req.Event.EndsAt,
			ImageURL:     req.Event.ImageURL,
			VenueName:    req.Event.VenueName,
			VenueAddress: req.Event.VenueAddress,
		}
	}

	ticket, err := h.svc.CreateTicket(c.Request().Context(), service.CreateTicketInput{
		Title:      req.Title,
		Price:      normPrice,
		UserID:     userID,
		Quota:      req.Quota,
		MaxPerUser: req.MaxPerUser,
		Event:      eventData,
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
//   - available: boolean (true/false) — filter to show only available tickets (GA: sold < quota; SEATED: not fully booked)
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

	// Parse optional 'available' filter
	if rawAvailable := c.QueryParam("available"); rawAvailable != "" {
		p.AvailableOnly = rawAvailable == "true"
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
	if !uuidRE.MatchString(id) {
		return errorResponse(c, http.StatusBadRequest, "VALIDATION_FAILED", "id must be a valid UUID", nil)
	}
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

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.signatureValidator.IsValidSignature(userID, signature) {
		return errorResponse(c, http.StatusUnauthorized, "INVALID_SIGNATURE", "Invalid user ID signature", nil)
	}

	rolesHeader := c.Request().Header.Get("X-User-Roles")
	roles := security.ParseUserRoles(rolesHeader)
	if !security.HasRole(roles, "organizer") {
		return errorResponse(c, http.StatusForbidden, "FORBIDDEN", "Only organizers can update tickets", nil)
	}

	id := c.Param("id")
	if !uuidRE.MatchString(id) {
		return errorResponse(c, http.StatusBadRequest, "VALIDATION_FAILED", "id must be a valid UUID", nil)
	}

	var req updateTicketRequest
	if err := c.Bind(&req); err != nil {
		return errorResponse(c, http.StatusBadRequest, "INVALID_JSON", "Invalid request body", nil)
	}

	// Validate input
	var details []map[string]string
	if req.Title == "" {
		details = append(details, map[string]string{"field": "title", "issue": "must not be empty"})
	}
	if utf8.RuneCountInString(req.Title) > 200 {
		details = append(details, map[string]string{"field": "title", "issue": "must not exceed 200 characters"})
	}
	normPrice, priceErr := validatePrice(req.Price)
	if priceErr != nil {
		details = append(details, map[string]string{"field": "price", "issue": priceErr.Error()})
	}
	if req.SeatingPlanID != "" && !uuidRE.MatchString(req.SeatingPlanID) {
		details = append(details, map[string]string{"field": "seatingPlanId", "issue": "must be a valid UUID"})
	}
	if len(details) > 0 {
		return errorResponse(c, http.StatusBadRequest, "VALIDATION_FAILED", "Request validation failed", details)
	}

	ticket, err := h.svc.UpdateTicket(c.Request().Context(), service.UpdateTicketInput{
		ID:            id,
		Title:         req.Title,
		Price:         normPrice,
		UserID:        userID,
		SeatingPlanID: req.SeatingPlanID,
		TicketType:    req.TicketType,
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
		case errors.Is(err, repository.ErrSeatingPlanAlreadyAttached):
			return errorResponse(c, http.StatusConflict, "CONFLICT", "Ticket already has a seating plan attached — detach it first", nil)
		case errors.Is(err, service.ErrVenueServiceUnavailable):
			return errorResponse(c, http.StatusServiceUnavailable, "DEPENDENCY_UNAVAILABLE", "Venue service is temporarily unavailable", nil)
		case errors.Is(err, service.ErrVenueServiceTimeout):
			return errorResponse(c, http.StatusGatewayTimeout, "DEPENDENCY_TIMEOUT", "Venue service did not respond in time", nil)
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
