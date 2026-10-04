{{- define "queue-system.name" -}}queue-system{{- end -}}
{{- define "queue-system.labels" -}}
app.kubernetes.io/name: {{ include "queue-system.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- /* The Secret queue-service reads its keys from: secretRef when set, else the one this chart (or its ExternalSecret) writes. */ -}}
{{- define "queue-system.secretName" -}}{{ .Values.secretRef | default "queue-secret" }}{{- end -}}
