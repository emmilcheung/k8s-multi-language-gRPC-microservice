# infra/terraform/environments/dev/variables.tf

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "ticketing"
}

variable "kong_tls_enabled" {
  description = "Enable TLS termination for Kong NLB in this environment."
  type        = bool
  default     = false
}

variable "kong_tls_certificate_arn" {
  description = "Existing ACM certificate ARN for Kong NLB TLS listener."
  type        = string
  default     = ""
}

variable "kong_tls_domain_name" {
  description = "Domain for ACM cert creation when TLS is enabled and ARN is not provided."
  type        = string
  default     = ""
}

variable "kong_tls_hosted_zone_id" {
  description = "Route53 hosted zone ID used for ACM DNS validation."
  type        = string
  default     = ""
}
