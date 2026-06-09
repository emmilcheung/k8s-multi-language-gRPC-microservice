variable "project" {
  description = "Project name, used in resource naming/tags."
  type        = string
}

variable "environment" {
  description = "Deployment environment: dev | staging | prod."
  type        = string
}

variable "origin_domain_name" {
  description = "Public domain/hostname of the Kong NLB that CloudFront forwards to (the origin). Use the stable Kong proxy domain (module.kong.proxy_url or the Route53 record pointing at the NLB)."
  type        = string
}

variable "origin_protocol_policy" {
  description = "How CloudFront connects to the origin: https-only | http-only | match-viewer."
  type        = string
  default     = "https-only"

  validation {
    condition     = contains(["https-only", "http-only", "match-viewer"], var.origin_protocol_policy)
    error_message = "origin_protocol_policy must be https-only, http-only, or match-viewer."
  }
}

variable "aliases" {
  description = "Custom domain names served by the distribution (e.g. [\"app.example.com\"]). Requires acm_certificate_arn in us-east-1; ignored when no cert is provided."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 covering the aliases. Empty string uses the default *.cloudfront.net certificate (no custom domain)."
  type        = string
  default     = ""
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 (NA + EU) is the cheapest / most free-tier-friendly."
  type        = string
  default     = "PriceClass_100"
}

variable "tags" {
  description = "Additional tags applied to the distribution."
  type        = map(string)
  default     = {}
}
