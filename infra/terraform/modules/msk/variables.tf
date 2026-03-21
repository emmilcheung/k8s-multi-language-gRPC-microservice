# infra/terraform/modules/msk/variables.tf

variable "project" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }

variable "subnet_ids" {
  description = "Private subnets for MSK broker nodes (one per AZ)."
  type        = list(string)
}

variable "instance_type" {
  type    = string
  default = "kafka.t3.small"
}

variable "broker_count" {
  description = "Number of broker nodes. Must equal the number of subnets (one per AZ)."
  type        = number
  default     = 3
}
