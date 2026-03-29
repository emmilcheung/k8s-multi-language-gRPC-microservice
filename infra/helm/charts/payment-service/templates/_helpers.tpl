{{/*
Expand the full name: <release>-<chart>, truncated to 63 chars.
*/}}
{{- define "payment-service.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to all resources.
*/}}
{{- define "payment-service.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/*
Selector labels (subset of labels used in matchLabels / pod template labels).
*/}}
{{- define "payment-service.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name — uses .Values.serviceAccount.name if set, otherwise fullname.
*/}}
{{- define "payment-service.serviceAccountName" -}}
{{- .Values.serviceAccount.name | default (include "payment-service.fullname" .) }}
{{- end }}

{{/*
Full image reference: [registry/]repository:tag
Prepends global.imageRegistry when set (non-empty), otherwise uses repository directly.
*/}}
{{- define "payment-service.image" -}}
{{- $registry := .Values.global.imageRegistry | default "" }}
{{- $repo := .Values.image.repository }}
{{- $tag := .Values.image.tag | default "latest" }}
{{- if $registry }}
{{- printf "%s/%s:%s" $registry $repo $tag }}
{{- else }}
{{- printf "%s:%s" $repo $tag }}
{{- end }}
{{- end }}
