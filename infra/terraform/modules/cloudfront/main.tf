# CloudFront distribution fronting the Kong NLB — the edge CDN designed in
# docs/diagrams/01-aws-infrastructure (Route53 -> CloudFront -> ALB/NLB -> Kong).
#
# It serves two roles:
#   1. Long-lived edge cache for immutable Next.js build assets (/_next/static/*).
#   2. Honors origin Cache-Control for everything else, so public ISR pages
#      (Cache-Control: public, s-maxage, stale-while-revalidate) are cached at the
#      edge while dynamic/personalized responses (Cache-Control: private, no-store)
#      bypass the cache automatically.
#
# All request methods pass through to the origin (server actions / GraphQL are
# POST); only GET/HEAD are cached.

locals {
  name      = "${var.project}-${var.environment}"
  origin_id = "kong-origin"
  # Custom aliases require a us-east-1 ACM cert. Without one, fall back to the
  # default *.cloudfront.net domain (no custom domain) so this works on a fresh
  # account before DNS/ACM are set up.
  effective_aliases = var.acm_certificate_arn != "" ? var.aliases : []
}

# AWS-managed policies (referenced by name so we don't hardcode IDs).
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  comment         = "${local.name} edge CDN (Kong origin)"
  price_class     = var.price_class
  is_ipv6_enabled = true
  http_version    = "http2and3"
  aliases         = local.effective_aliases

  origin {
    domain_name = var.origin_domain_name
    origin_id   = local.origin_id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = var.origin_protocol_policy
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Default behavior: dynamic + SSR. Honor origin Cache-Control so `public,
  # s-maxage` is cached and `private`/`no-store` bypasses. All methods pass
  # through (server actions are POST); only GET/HEAD are cached.
  default_cache_behavior {
    target_origin_id         = local.origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_optimized.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  # Immutable Next.js build assets (hashed filenames) — long-lived edge cache.
  ordered_cache_behavior {
    path_pattern             = "/_next/static/*"
    target_origin_id         = local.origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_optimized.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # Custom cert (us-east-1) when aliases are configured; otherwise the default
  # CloudFront certificate for the *.cloudfront.net domain.
  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == ""
    acm_certificate_arn            = var.acm_certificate_arn != "" ? var.acm_certificate_arn : null
    ssl_support_method             = var.acm_certificate_arn != "" ? "sni-only" : null
    minimum_protocol_version       = var.acm_certificate_arn != "" ? "TLSv1.2_2021" : "TLSv1"
  }

  tags = merge(var.tags, { Name = "${local.name}-cdn" })
}
