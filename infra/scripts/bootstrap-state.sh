#!/usr/bin/env bash
# infra/scripts/bootstrap-state.sh
#
# Bootstraps shared Terraform remote state resources in AWS:
#   - S3 bucket for state files
#   - DynamoDB table for state locking
#
# The script is idempotent and safe to re-run.

set -euo pipefail

PROJECT="${PROJECT:-ticketing}"
AWS_REGION="${AWS_REGION:-us-east-1}"

if ! command -v aws >/dev/null 2>&1; then
  echo "[ERROR] aws CLI is required but not installed." >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
if [[ -z "${ACCOUNT_ID}" || "${ACCOUNT_ID}" == "None" ]]; then
  echo "[ERROR] Failed to resolve AWS account ID via STS." >&2
  exit 1
fi

STATE_BUCKET="${TF_STATE_BUCKET:-${PROJECT}-tf-state-${ACCOUNT_ID}}"
LOCK_TABLE="${TF_LOCK_TABLE:-${PROJECT}-tf-lock}"

echo "[INFO] Project: ${PROJECT}"
echo "[INFO] Region: ${AWS_REGION}"
echo "[INFO] State bucket: ${STATE_BUCKET}"
echo "[INFO] Lock table: ${LOCK_TABLE}"

echo "[STEP] Ensuring S3 bucket exists..."
if aws s3api head-bucket --bucket "${STATE_BUCKET}" 2>/dev/null; then
  echo "[INFO] S3 bucket already exists."
else
  if [[ "${AWS_REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${STATE_BUCKET}" --region "${AWS_REGION}" >/dev/null
  else
    aws s3api create-bucket \
      --bucket "${STATE_BUCKET}" \
      --region "${AWS_REGION}" \
      --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
  fi
  echo "[INFO] S3 bucket created."
fi

echo "[STEP] Enabling S3 versioning and encryption..."
aws s3api put-bucket-versioning \
  --bucket "${STATE_BUCKET}" \
  --versioning-configuration Status=Enabled >/dev/null

aws s3api put-bucket-encryption \
  --bucket "${STATE_BUCKET}" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null

aws s3api put-public-access-block \
  --bucket "${STATE_BUCKET}" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null

echo "[STEP] Ensuring DynamoDB lock table exists..."
if aws dynamodb describe-table --table-name "${LOCK_TABLE}" --region "${AWS_REGION}" >/dev/null 2>&1; then
  echo "[INFO] DynamoDB lock table already exists."
else
  aws dynamodb create-table \
    --table-name "${LOCK_TABLE}" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "${AWS_REGION}" >/dev/null

  aws dynamodb wait table-exists --table-name "${LOCK_TABLE}" --region "${AWS_REGION}"
  echo "[INFO] DynamoDB lock table created."
fi

cat <<EOF

[DONE] Terraform remote state bootstrap complete.

Use these backend values in:
- infra/terraform/environments/dev/backend.hcl
- infra/terraform/environments/staging/backend.hcl
- infra/terraform/environments/prod/backend.hcl

bucket         = "${STATE_BUCKET}"
dynamodb_table = "${LOCK_TABLE}"
region         = "${AWS_REGION}"

Example init command:
terraform -chdir=infra/terraform/environments/dev init -backend-config=backend.hcl
EOF
