package kafka

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCloudEvent_MarshalRoundTrip(t *testing.T) {
	data := ExpirationCompleteData{OrderID: "order-123"}
	dataBytes, err := json.Marshal(data)
	require.NoError(t, err)

	event := CloudEvent{
		SpecVersion:     "1.0",
		Type:            TopicExpirationComplete,
		Source:          "expiration-service",
		ID:              "evt-001",
		Time:            "2026-03-20T10:00:00Z",
		DataContentType: "application/json",
		Data:            dataBytes,
	}

	raw, err := json.Marshal(event)
	require.NoError(t, err)

	var decoded CloudEvent
	require.NoError(t, json.Unmarshal(raw, &decoded))

	assert.Equal(t, "1.0", decoded.SpecVersion)
	assert.Equal(t, TopicExpirationComplete, decoded.Type)
	assert.Equal(t, "expiration-service", decoded.Source)

	var decodedData ExpirationCompleteData
	require.NoError(t, json.Unmarshal(decoded.Data, &decodedData))
	assert.Equal(t, "order-123", decodedData.OrderID)
}

func TestOrderCreatedData_Deserialise(t *testing.T) {
	raw := `{
		"orderId":     "ord-abc",
		"userId":      "usr-xyz",
		"ticketId":    "tkt-1",
		"ticketTitle": "Concert",
		"ticketPrice": 49.99,
		"expiresAt":   "2026-03-20T11:00:00Z",
		"version":     0
	}`

	var data OrderCreatedData
	require.NoError(t, json.Unmarshal([]byte(raw), &data))

	assert.Equal(t, "ord-abc", data.OrderID)
	assert.Equal(t, "usr-xyz", data.UserID)
	assert.Equal(t, "tkt-1", data.TicketID)
	assert.Equal(t, "Concert", data.TicketTitle)
	assert.InDelta(t, 49.99, data.TicketPrice, 0.001)
	assert.Equal(t, "2026-03-20T11:00:00Z", data.ExpiresAt)
	assert.Equal(t, 0, data.Version)
}

func TestJoinBrokers_SingleBroker(t *testing.T) {
	result := joinBrokers([]string{"localhost:9092"})
	assert.Equal(t, "localhost:9092", result)
}

func TestJoinBrokers_MultipleBrokers(t *testing.T) {
	result := joinBrokers([]string{"b1:9092", "b2:9092", "b3:9092"})
	assert.Equal(t, "b1:9092,b2:9092,b3:9092", result)
}

func TestJoinBrokers_EmptySlice(t *testing.T) {
	result := joinBrokers([]string{})
	assert.Equal(t, "", result)
}
