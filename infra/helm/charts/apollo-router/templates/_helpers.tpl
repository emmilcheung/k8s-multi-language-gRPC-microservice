{{/*
Expand the full name: <release>-<chart>, truncated to 63 chars.
*/}}
{{- define "apollo-router.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to all resources.
*/}}
{{- define "apollo-router.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/*
Selector labels (subset of labels used in matchLabels / pod template labels).
*/}}
{{- define "apollo-router.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name — uses .Values.serviceAccount.name if set, otherwise fullname.
*/}}
{{- define "apollo-router.serviceAccountName" -}}
{{- .Values.serviceAccount.name | default (include "apollo-router.fullname" .) }}
{{- end }}

{{/*
Full image reference: repository:tag
Apollo Router is published to GHCR; the repository field already contains the full
image path (ghcr.io/apollographql/router), so we never prepend global.imageRegistry.
*/}}
{{- define "apollo-router.image" -}}
{{- $repo := .Values.image.repository }}
{{- $tag := .Values.image.tag | default "v2.1.1" }}
{{- printf "%s:%s" $repo $tag }}
{{- end }}
