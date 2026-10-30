# Deployment guide

Manual commands to package, deploy, test, and remove this sample. `./deploy.sh` runs steps 1 to 3 for you. For the architecture overview, see [README.md](README.md).

## Prerequisites

- The tools listed in the README [Requirements](README.md#requirements).
- A code bucket with **versioning enabled**. Lambda requires it. Use a bucket dedicated to this stack, because the stack replaces its bucket policy.

Set variables used throughout:

```bash
export AWS_REGION=us-east-1
export STACK_NAME=lwf-cloudfront-private-vpc
export CODE_BUCKET=amzn-s3-demo-bucket
export CODE_KEY=web-function/app.zip
```

## 1. Package the code and upload it to S3

Web Functions deploy only from an S3 object. Install production dependencies and zip the app with `index.js` at the root:

```bash
cd src
npm ci --omit=dev
zip -r ../app.zip index.js package.json global-bundle.pem node_modules
cd ..
aws s3 cp app.zip "s3://${CODE_BUCKET}/${CODE_KEY}" --region "${AWS_REGION}"

export CODE_VERSION_ID=$(aws s3api head-object \
  --bucket "${CODE_BUCKET}" --key "${CODE_KEY}" \
  --region "${AWS_REGION}" --query VersionId --output text)
```

## 2. Build

```bash
sam build
```

## 3. Deploy

> **Before you deploy:** `sam deploy` doesn't upload Web Function code. Complete step 1 first, or the stack fails with *"The specified S3 object does not exist"*.

```bash
sam deploy \
  --stack-name "${STACK_NAME}" \
  --region "${AWS_REGION}" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --tags sample=sample-lambda-web-functions-cloudfront-private-vpc stack="${STACK_NAME}" \
  --parameter-overrides \
    CodeBucket="${CODE_BUCKET}" \
    CodeKey="${CODE_KEY}" \
    CodeVersionId="${CODE_VERSION_ID}"
```

The first deploy takes about 15 minutes. During the deploy, a setup function creates the `app_user` database user and the `visits` table through the RDS Data API.

Optional parameters: `VpcCidr` (default `10.20.0.0/16`), `DatabaseName` (default `appdb`), `DbMinCapacity` (default `0.5`), `DbMaxCapacity` (default `2`), `BackupRetentionDays` (default `7`), `LogRetentionDays` (default `30`).

## 4. Get the outputs

```bash
aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --region "${AWS_REGION}" \
  --query "Stacks[0].Outputs" --output table
```

| Output | Use |
|---|---|
| `AppUrl` | Open in a browser |
| `WebFunctionEndpointDomain` | Direct endpoint, which denies unsigned requests |
| `DatabaseEndpoint` | Private Aurora endpoint |
| `NetworkConnectorLatestVersionArn` | Connector version the revision uses |
| `DatabaseAdminSecretArn` | Master user credentials, for administrators only. The app doesn't use it. |

## 5. Test

```bash
curl -s "https://<CloudFront domain>/" | grep -E "Served through CloudFront|Connected to Aurora"
curl -i "https://<WebFunctionEndpointDomain>/"   # expect 403 Forbidden
```

## 6. Deploy new code

Revisions are immutable. Repeat steps 1 to 3 with your changes, or run `./deploy.sh`. Each upload creates a new S3 object version and a new revision.

## 7. Clean up

```bash
sam delete --stack-name "${STACK_NAME}" --region "${AWS_REGION}"
```

This deletes the Aurora cluster, its data, and the log groups. The code bucket isn't part of the stack. Because it's versioned, `aws s3 rm` only hides the current object; to remove it fully, empty the bucket including all versions (for example, from the S3 console with **Empty**), then delete it:

```bash
aws s3 rb "s3://${CODE_BUCKET}" --region "${AWS_REGION}"   # after emptying all versions
```
