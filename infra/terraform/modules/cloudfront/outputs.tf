output "distribution_id" {
  description = "CloudFront distribution ID."
  value       = aws_cloudfront_distribution.this.id
}

output "domain_name" {
  description = "CloudFront distribution domain name (point a Route53 alias record at this)."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "hosted_zone_id" {
  description = "CloudFront hosted zone ID (for Route53 alias records)."
  value       = aws_cloudfront_distribution.this.hosted_zone_id
}
