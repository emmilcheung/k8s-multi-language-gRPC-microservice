{{- define "queue-system.name" -}}queue-system{{- end -}}
{{- define "queue-system.labels" -}}
app.kubernetes.io/name: {{ include "queue-system.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
