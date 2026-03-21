# infra/terraform/modules/msk/main.tf
# Amazon MSK (Managed Streaming for Apache Kafka) — KRaft mode cluster.
# Used by all services for Kafka messaging.

locals {
  name = "${var.project}-${var.environment}"
}

resource "aws_security_group" "msk" {
  name        = "${local.name}-msk"
  description = "Allow Kafka traffic from within the VPC"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 9098
    to_port     = 9098
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
    description = "Kafka TLS (IAM auth)"
  }

  ingress {
    from_port   = 9094
    to_port     = 9094
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
    description = "Kafka TLS (SASL/SCRAM)"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-msk" }
}

resource "aws_msk_cluster" "this" {
  cluster_name           = local.name
  kafka_version          = "3.7.x.kraft"
  number_of_broker_nodes = var.broker_count

  broker_node_group_info {
    instance_type  = var.instance_type
    client_subnets = var.subnet_ids

    storage_info {
      ebs_storage_info {
        volume_size = 100
      }
    }

    security_groups = [aws_security_group.msk.id]
  }

  client_authentication {
    sasl {
      iam = true
    }
  }

  encryption_info {
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }

  # Enable enhanced monitoring for broker-level metrics
  enhanced_monitoring = "PER_BROKER"

  open_monitoring {
    prometheus {
      jmx_exporter {
        enabled_in_broker = true
      }
      node_exporter {
        enabled_in_broker = true
      }
    }
  }

  tags = { Name = local.name }
}
