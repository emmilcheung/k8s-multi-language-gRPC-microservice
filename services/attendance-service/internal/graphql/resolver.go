package graph

import (
	"github.com/acme/attendance-service/internal/service"
)

// Resolver is the root GraphQL resolver wired with the attendance service.
type Resolver struct {
	Svc service.AttendanceService
}
