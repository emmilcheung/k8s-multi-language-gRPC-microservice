# infra/terraform/environments/prod/variables.tf

variable "aws_region" {
  description = "AWS region for all production resources."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Project name used as a prefix for all resource names."
  type        = string
  default     = "ticketing"
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

# ── CloudFront edge CDN ───────────────────────────────────────────────────────

variable "cloudfront_enabled" {
  description = "Provision the CloudFront edge CDN in front of the Kong NLB. Disabled by default until a public domain/ACM cert exist."
  type        = bool
  default     = false
}

variable "cloudfront_origin_domain_name" {
  description = "Origin hostname CloudFront forwards to. Empty uses the Kong NLB hostname (module.kong.proxy_url); set a stable public domain in production."
  type        = string
  default     = ""
}

variable "cloudfront_origin_protocol_policy" {
  description = "How CloudFront connects to the Kong origin: https-only | http-only | match-viewer."
  type        = string
  default     = "https-only"
}

variable "cloudfront_aliases" {
  description = "Custom domains served by CloudFront (requires cloudfront_acm_certificate_arn in us-east-1)."
  type        = list(string)
  default     = []
}

variable "cloudfront_acm_certificate_arn" {
  description = "us-east-1 ACM certificate ARN for the CloudFront aliases. Empty uses the default *.cloudfront.net certificate."
  type        = string
  default     = ""
}
