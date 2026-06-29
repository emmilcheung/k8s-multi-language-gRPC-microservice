{{- define "opensearch.fullname" -}}
{{- printf "%s-opensearch" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
