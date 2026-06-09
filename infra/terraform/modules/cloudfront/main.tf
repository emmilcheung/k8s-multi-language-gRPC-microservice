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
# CachingOptimized (MinTTL=1s, no query strings in key) is ONLY safe for the
# immutable /_next/static/* assets — never for HTML/API responses.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# Forwards everything EXCEPT the viewer Host header. Forwarding Host to a
# custom origin (the Kong NLB) breaks TLS/host matching and routing — AWS's
# recommended policy for custom origins.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# Cache policy for dynamic/SSR content that strictly honors origin Cache-Control.
# MinTTL MUST be 0: with MinTTL > 0 CloudFront caches responses for MinTTL even
# when the origin sends `private` / `no-cache` / `no-store` — a brief cross-user
# leak window for personalized SSR pages. DefaultTTL 0 means nothing is cached
# unless the origin explicitly opts in (the ISR pages' `public, s-maxage`).
# Query strings are part of the cache key so parameterized pages can never serve
# the wrong variant; cookies are excluded because the public shell does not vary
# by cookie (per-user responses are `private` and therefore never cached).
resource "aws_cloudfront_cache_policy" "honor_origin" {
  name    = "${local.name}-honor-origin"
  comment = "Honor origin Cache-Control exactly; query strings in cache key"

  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "all"
    }
  }
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
    cache_policy_id          = aws_cloudfront_cache_policy.honor_origin.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
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
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
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
