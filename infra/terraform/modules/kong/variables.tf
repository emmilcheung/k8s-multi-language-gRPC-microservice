# infra/terraform/modules/kong/variables.tf

variable "project" {
  description = "Project name used as a prefix for resource names."
  type        = string
}

variable "environment" {
  description = "Deployment environment: dev | staging | prod."
  type        = string
}

variable "namespace" {
  description = "Kubernetes namespace where Kong is deployed."
  type        = string
  default     = "infra"
}

variable "kong_chart_version" {
  description = "Version of the Kong Helm chart (kong/kong)."
  type        = string
  default     = "2.38.0"
}

variable "replica_count" {
  description = "Number of Kong proxy replicas."
  type        = number
  default     = 2
}

variable "proxy_service_type" {
  description = "Kubernetes Service type for the Kong proxy (LoadBalancer in EKS, NodePort/ClusterIP locally)."
  type        = string
  default     = "LoadBalancer"
}

variable "kong_config_map_name" {
  description = "Name of the Kubernetes ConfigMap that holds the declarative Kong configuration (kong.yml)."
  type        = string
  default     = "kong-dbless-config"
}

variable "admin_service_enabled" {
  description = "Whether to expose the Kong Admin API service (disable in production)."
  type        = bool
  default     = false
}

variable "cpu_request" {
  description = "CPU request for the Kong proxy container."
  type        = string
  default     = "250m"
}

variable "memory_request" {
  description = "Memory request for the Kong proxy container."
  type        = string
  default     = "256Mi"
}

variable "cpu_limit" {
  description = "CPU limit for the Kong proxy container."
  type        = string
  default     = "500m"
}

variable "memory_limit" {
  description = "Memory limit for the Kong proxy container."
  type        = string
  default     = "512Mi"
}

variable "tls_enabled" {
  description = "Enable TLS termination at the Kong NLB service."
  type        = bool
  default     = false
}

variable "tls_certificate_arn" {
  description = "Existing ACM certificate ARN for Kong TLS termination. If empty and tls_enabled=true, the module can create one when tls_domain_name and tls_hosted_zone_id are set."
  type        = string
  default     = ""
}

variable "tls_domain_name" {
  description = "Domain name for creating an ACM certificate when tls_enabled=true and tls_certificate_arn is not provided."
  type        = string
  default     = ""
}

variable "tls_hosted_zone_id" {
  description = "Route53 hosted zone ID used for ACM DNS validation when creating a new certificate."
  type        = string
  default     = ""
}
