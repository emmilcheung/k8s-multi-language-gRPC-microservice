{{/*
  Expand the name of the chart.
*/}}
{{- define "cp-kafka.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
  Create a default fully qualified app name.
*/}}
{{- define "cp-kafka.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name "cp-kafka" | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
  Common labels.
*/}}
{{- define "cp-kafka.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{ include "cp-kafka.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
  Selector labels.
*/}}
{{- define "cp-kafka.selectorLabels" -}}
app.kubernetes.io/name: cp-kafka
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
