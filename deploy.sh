#!/usr/bin/env bash
#
# deploy.sh — one-command deploy for sample-lambda-web-functions-cloudfront-private-vpc.
#
# Lambda Web Functions deploy code only from a .zip object in Amazon S3, and
# `sam deploy` does not upload it. This script installs production dependencies,
# packages src/ (including node_modules), uploads it to a versioned S3 bucket,
# then runs sam build + sam deploy. Re-run it to ship new code; each run creates
# a new immutable revision.
#
# First deploy takes about 15 minutes, mostly Aurora and CloudFront provisioning.
# The stack also runs a one-time setup function that creates the least-privilege
# app_user (IAM database authentication) and the visits table.
#
# Usage:
#   ./deploy.sh [--stack-name NAME] [--bucket BUCKET] [--key KEY] [--region REGION]
#
# Defaults:
#   stack name : lwf-cloudfront-private-vpc
#   bucket     : <stack-name>-code-<account-id>-<region>   (created if missing)
#   key        : web-function/app.zip
#   region     : --region → $AWS_REGION → $AWS_DEFAULT_REGION → aws configure → error
#
set -euo pipefail

STACK_NAME="lwf-cloudfront-private-vpc"
CODE_KEY="web-function/app.zip"
CODE_BUCKET=""
REGION_FLAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack-name) STACK_NAME="$2"; shift 2;;
    --bucket)     CODE_BUCKET="$2"; shift 2;;
    --key)        CODE_KEY="$2"; shift 2;;
    --region)     REGION_FLAG="$2"; shift 2;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Unknown argument: $1" >&2; exit 1;;
  esac
done

for cmd in aws sam npm zip; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: '$cmd' is required but not installed." >&2; exit 1; }
done

REGION="${REGION_FLAG:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}}"
if [[ -z "${REGION}" ]]; then
  echo "ERROR: No AWS region. Pass --region, set AWS_REGION, or run 'aws configure'." >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CODE_BUCKET="${CODE_BUCKET:-${STACK_NAME}-code-${ACCOUNT_ID}-${REGION}}"

echo "==> Region:  ${REGION}"
echo "==> Account: ${ACCOUNT_ID}"
echo "==> Stack:   ${STACK_NAME}"
echo "==> Code:    s3://${CODE_BUCKET}/${CODE_KEY}"

# ----- code bucket: versioned (required by Lambda), private, encrypted -------
if aws s3api head-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" 2>/dev/null; then
  echo "==> Bucket exists: ${CODE_BUCKET}"
  STATUS="$(aws s3api get-bucket-versioning --bucket "${CODE_BUCKET}" --region "${REGION}" --query Status --output text)"
  if [[ "${STATUS}" != "Enabled" ]]; then
    echo "ERROR: ${CODE_BUCKET} does not have versioning enabled. Lambda requires it." >&2
    exit 1
  fi
else
  echo "==> Creating bucket: ${CODE_BUCKET}"
  if [[ "${REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${CODE_BUCKET}" --region "${REGION}"
  else
    aws s3api create-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}"
  fi
  aws s3api put-bucket-versioning --bucket "${CODE_BUCKET}" --region "${REGION}" \
    --versioning-configuration Status=Enabled
  aws s3api put-public-access-block --bucket "${CODE_BUCKET}" --region "${REGION}" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket "${CODE_BUCKET}" --region "${REGION}" \
    --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
fi

# ----- install deps and package src/ (index.js at the zip root) ----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "${BUILD_DIR}"' EXIT

echo "==> Installing production dependencies"
# A committed lockfile makes installs reproducible; refuse to build without one.
if [[ ! -f "${SCRIPT_DIR}/src/package-lock.json" ]]; then
  echo "ERROR: src/package-lock.json is missing. Run 'npm install --package-lock-only' in src/ and commit it." >&2
  exit 1
fi
cp "${SCRIPT_DIR}/src/index.js" "${SCRIPT_DIR}/src/package.json" "${SCRIPT_DIR}/src/package-lock.json" \
   "${SCRIPT_DIR}/src/global-bundle.pem" "${BUILD_DIR}/"
( cd "${BUILD_DIR}" && npm ci --omit=dev --no-audit --no-fund )

ZIP_PATH="${BUILD_DIR}/app.zip"
echo "==> Zipping -> ${ZIP_PATH}"
( cd "${BUILD_DIR}" && zip -r -q app.zip index.js package.json global-bundle.pem node_modules )

echo "==> Uploading to s3://${CODE_BUCKET}/${CODE_KEY}"
aws s3 cp "${ZIP_PATH}" "s3://${CODE_BUCKET}/${CODE_KEY}" --region "${REGION}"
CODE_VERSION_ID="$(aws s3api head-object --bucket "${CODE_BUCKET}" --key "${CODE_KEY}" \
  --region "${REGION}" --query VersionId --output text)"
echo "==> Object version: ${CODE_VERSION_ID}"

# ----- build & deploy --------------------------------------------------------
echo "==> sam build"
( cd "${SCRIPT_DIR}" && sam build )

echo "==> sam deploy (first deploy takes about 15 minutes)"
( cd "${SCRIPT_DIR}" && sam deploy \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --tags sample=sample-lambda-web-functions-cloudfront-private-vpc stack="${STACK_NAME}" \
  --parameter-overrides \
    CodeBucket="${CODE_BUCKET}" \
    CodeKey="${CODE_KEY}" \
    CodeVersionId="${CODE_VERSION_ID}" )

echo
echo "==> Done. Open the AppUrl output in a browser:"
aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --region "${REGION}" \
  --query "Stacks[0].Outputs" --output table
