# infra/terraform/modules/rds/variables.tf

variable "project" { type = string }
variable "environment" { type = string }

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnet IDs for the DB subnet group."
  type        = list(string)
}

variable "instance_class" {
  type    = string
  default = "db.t3.micro"
}
