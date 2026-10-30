# AWS Lambda Web Functions reference architecture: Amazon CloudFront and private VPC access

This reference architecture shows how to run a web application on **AWS Lambda Web Functions** behind **Amazon CloudFront**, with outbound access to private resources in your VPC. It deploys a working example that uses an **Amazon Aurora Serverless v2 (PostgreSQL)** database with no public address as the private resource. The same pattern works for any resource you can reach inside a VPC, such as Amazon RDS, Amazon ElastiCache, an internal Application Load Balancer, or on-premises systems connected through AWS Direct Connect or VPN. See [Use your own private resource](#use-your-own-private-resource).

- **Edge:** CloudFront with Origin Access Control (OAC) signs every request to the Web Function. The Web Function endpoint uses `IamAuth`, so it rejects direct, unsigned calls.
- **Compute:** The Web Function runs a standard Node.js HTTP server.
- **Private access:** A Lambda network connector puts network interfaces in your private subnets, so the function can reach resources that have no public address.
- **Example backend:** Aurora Serverless v2. The function connects with IAM database authentication as a least-privilege database user, so it stores no credentials. Connections use TLS, and the server certificate is verified.

In the example, each page load records a visit, with the viewer's city and country, in the database. The page shows both hops: that the request came through CloudFront, and that the function wrote to and read from the private database. It shows only totals and counts per location, never other visitors' individual visits.

> **Note:** This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory, and compliance requirements before deployment.

> **Public endpoint:** The deployed URL is public and needs no sign-in. Every page load writes a row to the database. The endpoint's `RateLimit` (100 requests per second) and `MaxEnvironments` (10) settings cap the load, but the sample doesn't include AWS WAF. Delete the stack when you're done, and add AWS WAF with a rate-based rule before exposing anything like this to real traffic.

**Important:** This application uses several AWS services, and there are costs beyond the Free Tier. Aurora Serverless v2 bills for its minimum capacity while the stack exists. See the [AWS Pricing page](https://aws.amazon.com/pricing/) for details. You're responsible for any AWS costs. This sample doesn't imply any warranty. Delete the stack when you're done (see [Clean up](#clean-up)).

## Architecture

![Architecture: CloudFront with OAC in front of a Lambda Web Function, which reaches a private resource in your VPC through a network connector. The example private resource is Aurora Serverless v2, reached with IAM database authentication; a one-time setup function creates the database user through the RDS Data API.](docs/architecture.png)

The numbered steps describe the deployed example, with Aurora as the private resource.

1. A browser sends an HTTPS request to the CloudFront distribution.
2. CloudFront signs the request to the Web Function endpoint with SigV4 through OAC.
3. The `IamAuth` endpoint checks the signature against a resource policy that allows only this distribution, then passes the request to the Web Function.
4. The Web Function generates a short-lived IAM authentication token for the `app_user` database user. The token is signed locally with the function's execution role, so no network call is needed.
5. The Web Function connects to Aurora over TLS through the network connector's ENIs. It inserts a row into the `visits` table with the viewer's location, which CloudFront adds as the `CloudFront-Viewer-City` and `CloudFront-Viewer-Country` request headers. Then it reads back the total visit count and the visit counts for the top five locations.
6. The Web Function returns an HTML page through CloudFront.

The Web Function runs on Lambda-managed infrastructure, not in your VPC. Only its egress network interfaces are placed in your subnets.

Dashed boxes in the diagram aren't deployed. The Aurora reader shows where a failover instance would go in production, and **Your private resources** shows other resources you could reach instead of Aurora.

**One-time setup.** During deployment, a CloudFormation custom resource runs a small Lambda function. It reads the master password from AWS Secrets Manager and uses the RDS Data API to create `app_user`, grant it IAM authentication, and create the `visits` table. The Data API works over HTTPS, so the setup function doesn't need VPC access. After setup, nothing in the request path uses the master password.

## How this sample handles security

| Concern | How this sample handles it |
|---|---|
| Direct access to the function | `IamAuth` endpoint plus a resource policy that allows only this CloudFront distribution |
| Database credentials | The app has none. It uses IAM database authentication tokens that expire after 15 minutes |
| Database permissions | The app connects as `app_user`, which can only `SELECT` and `INSERT` on the `visits` table |
| Admin credentials | The master password is generated by RDS and kept in AWS Secrets Manager. Only the one-time setup function and administrators can read it |
| Network access | No internet route in the VPC. The connector may send only PostgreSQL traffic to Aurora, and Aurora accepts traffic only from the connector |
| Encryption in transit | TLS to CloudFront, between CloudFront and the function, and to Aurora, with certificate verification against the Amazon RDS CA bundle |
| Encryption at rest | Aurora storage and the master secret are encrypted with AWS-managed keys |
| IAM scope | Each role has only the permissions it uses, scoped to this stack's resources |

## What gets deployed

| Layer | Resources |
|---|---|
| Edge | CloudFront distribution, OAC, cache policy, and an origin request policy that forwards only the viewer-location headers |
| Compute | Web Function, revision, `IamAuth` endpoint, resource policy, execution role, log groups |
| Networking | VPC, two private subnets, network connector and operator role, security groups |
| Data | Aurora Serverless v2 PostgreSQL cluster and instance, RDS-managed master secret |
| Setup | A Lambda function and custom resource that create `app_user` and the `visits` table through the RDS Data API |

## Requirements

* An AWS account with permissions to create the resources above, including `iam:PassRole` for the execution and operator roles and `lambda:PassNetworkConnector` for the connector
* [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) installed and configured
* [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html) installed
* [Node.js](https://nodejs.org/) and npm, to install the app's dependencies
* `zip` on your PATH
* A Region where Lambda Web Functions is available

## Deploy

The repository includes `src/package-lock.json`, and `deploy.sh` installs exactly those dependency versions with `npm ci`.

```bash
git clone https://github.com/aws-samples/sample-lambda-web-functions-cloudfront-private-vpc
cd sample-lambda-web-functions-cloudfront-private-vpc
./deploy.sh
```

The script creates a versioned code bucket, installs dependencies, packages and uploads the app, and deploys the stack. The first deploy takes about 15 minutes, mostly for Aurora and CloudFront.

Optional flags: `--stack-name NAME --bucket BUCKET --key KEY --region REGION`.

To run each step yourself instead, see [DEPLOYMENT.md](DEPLOYMENT.md). Note that `sam deploy` doesn't upload the Web Function code. You must upload the `.zip` to S3 first, or the stack fails with *"The specified S3 object does not exist"*.

## Test

1. Open the `AppUrl` stack output in a browser. The page should show:
   - **Served through CloudFront**, with your city and country as the viewer location
   - **Connected to Aurora** as `app_user`
   - A visit count that goes up each time you reload, and a table of visit counts for the top five locations
2. Try the Web Function endpoint directly:
   ```bash
   curl -i "https://<WebFunctionEndpointDomain>/"
   ```
   You should get `403 Forbidden`, because the request isn't signed.

If the page shows **Database unreachable**, see [Troubleshooting](#troubleshooting). The page shows only a short reason; the full error is written to CloudWatch Logs so it isn't exposed to visitors.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Stack fails with *"The specified S3 object does not exist"* | The code wasn't uploaded before `sam deploy`. Use `./deploy.sh`, or follow DEPLOYMENT.md step 1. |
| `DatabaseSetup` fails | Check the setup function's CloudWatch logs. The cluster can take a few minutes to accept Data API calls; the function retries for about two and a half minutes. |
| **Database unreachable**, reason *Connection timeout*, once | The first connection from a new execution environment can be slow while the network connector path warms up. The app opens a connection at startup, waits up to 10 seconds, and retries once, so this should be rare. Reload the page. |
| **Database unreachable**, reason *Connection timeout*, on every reload | Security group rules between the connector and Aurora have been changed. The connector group needs outbound TCP 5432 to the database group, and the database group needs inbound TCP 5432 from the connector group. |
| **Database unreachable**, reason *Authentication failed* | `app_user` is missing the `rds_iam` role, or the execution role lacks `rds-db:connect` for `app_user`. |
| **Database unreachable**, reason *TLS certificate error* | `global-bundle.pem` is missing from the deployment package. |
| **Database unreachable**, reason *Permission denied* | `app_user` lacks a grant on the `visits` table. Bump `SchemaVersion` on the `DatabaseSetup` resource and redeploy to rerun the setup SQL. |
| **Database unreachable**, any other reason | The page shows only a category. Find the full error in the Web Function's CloudWatch log group, `/aws/lambda/web/<stack-name>-web-function`. |
| `502` from CloudFront | The app isn't listening on `AWS_LAMBDA_HTTP_ENDPOINT`, or the revision failed to start. Check the Web Function logs. |
| Viewer location shows *not provided* | The origin request policy no longer forwards `CloudFront-Viewer-City` and `CloudFront-Viewer-Country`, or CloudFront couldn't determine the location for that viewer. |
| `429` responses | The endpoint's `RateLimit` or `MaxEnvironments` cap was reached. Tune them in `template.yaml`. |

## Use your own private resource

The edge, compute, and network connector parts of this architecture don't depend on the backend. To point the Web Function at a different private resource, change these parts and leave the rest as is:

| What | Where | Change |
|---|---|---|
| The resource | `template.yaml`, data tier section | Replace the Aurora cluster, instance, and subnet group with your resource, or remove them and reference an existing resource in the same VPC. To use an existing VPC, replace the VPC and subnet resources with parameters. |
| Network path | `template.yaml`, `ConnectorToDatabaseEgress` and `DatabaseFromConnectorIngress` | Set the port to your resource's port, and allow inbound from the connector security group on the resource's security group. For resources without security groups, allow the connector subnets' CIDR blocks instead. |
| Name resolution | VPC settings | Keep DNS support and DNS hostnames turned on. Associate any Route 53 private hosted zones your resource uses with the VPC. |
| Authentication | `template.yaml`, `WebFunctionExecutionRole` | Replace the `rds-db:connect` permission with whatever your resource needs, for example IAM permissions for an internal API, or no permission for a resource that authenticates differently. |
| Client code | `src/index.js` | Replace the `pg` pool and queries with your resource's client. Keep the startup warm-up, the connection timeout, and the single retry: the first connection from a new execution environment can be slow. |
| One-time setup | `template.yaml`, `DatabaseSetupFunction` and `DatabaseSetup` | Remove them if your resource needs no setup, or replace the SQL with your own setup steps. |
| Internet access | VPC | The connector replaces the function's default outbound path. If the app must also reach the internet or public AWS endpoints, add a NAT gateway or VPC endpoints. |

A revision that uses a network connector supports only `HomeRegion` endpoints, whatever the backend.

## Production considerations

This sample is a starting point, not a production-ready design. Review these choices for a real workload:

- **High availability.** The cluster runs a single writer instance. The subnets span two Availability Zones, but there's no reader to fail over to, so an instance or Availability Zone failure causes downtime while Aurora replaces the instance. Add at least one reader instance for a workload that needs fast failover.
- **Monitoring.** The stack creates log groups with bounded retention but no CloudWatch alarms, so failures aren't alerted. Before production, alarm on Web Function errors and throttles, the CloudFront 5xx error rate, and Aurora CPU, capacity, and connection count, and send the alarms to Amazon SNS.
- **Tracing.** Lambda Web Functions don't currently offer an AWS X-Ray tracing setting, and the app reports one total database round-trip time. To break down latency across cold start, the network connector, and the database, instrument the app code, for example with OpenTelemetry.
- **Cost guardrails.** Set an [AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html) alert on your account before you deploy, so a forgotten stack doesn't run up charges. `deploy.sh` and the DEPLOYMENT.md commands tag every resource with `sample=sample-lambda-web-functions-cloudfront-private-vpc` for cost allocation.
- **Data protection.** The cluster has `DeletionPolicy: Delete` and no deletion protection, so the sample cleans up fully. Turn on deletion protection and use `Snapshot` or `Retain` for anything that holds real data. Backups are kept for 7 days (`BackupRetentionDays`).
- **Encryption keys.** Aurora and the master secret use AWS-managed keys. Use customer managed AWS KMS keys if your compliance rules require them.
- **Connection limits.** Each execution environment keeps up to 5 connections, so the fleet opens up to about 50. These numbers come from the configuration, not from load testing. IAM authentication is recommended for fewer than 200 new connections per second. Size `MaxEnvironments`, the pool size, and Aurora capacity together, or add Amazon RDS Proxy.
- **Master password rotation.** The app never uses the master password. If administrators use it, turn on rotation for the RDS-managed secret.
- **Endpoint caps.** `RateLimit: 100` and `MaxEnvironments: 10` are conservative defaults. Tune them to your expected traffic.
- **Edge protection and logging.** The sample has no AWS WAF and no CloudFront access logs, so abusive requests aren't blocked beyond the endpoint caps and can't be investigated afterwards. Attach AWS WAF with a rate-based rule and managed rules, and turn on CloudFront standard logging. Add a custom domain and AWS Certificate Manager certificate too: the template's `MinimumProtocolVersion: TLSv1.2_2021` only takes effect with a custom certificate.
- **RDS Data API.** The cluster has the Data API turned on so the one-time setup can run SQL without VPC access, and it stays on after setup. Calling it requires both `rds-data:ExecuteStatement` and read access to the master secret. If you don't need it after deployment, turn it off with `aws rds disable-http-endpoint`, and turn it back on before rerunning the setup.
- **Deployment package integrity.** The code bucket is private, versioned, and encrypted, and each revision pins an object version. For production, also use Lambda code signing or S3 Object Lock so that a compromised bucket can't ship modified code.
- **Viewer data retention.** The `visits` table stores the viewer's city and country with no expiry. For real data, define a retention period, delete old rows on a schedule, and collect only what you need.
- **Code bucket.** The stack attaches a bucket policy to `CodeBucket` that replaces any existing policy. Use a bucket dedicated to this stack.
- **CA bundle.** `src/global-bundle.pem` is the Amazon RDS global CA bundle. Refresh it from `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` when AWS rotates certificate authorities.

## Clean up

```bash
sam delete --stack-name lwf-cloudfront-private-vpc
```

This deletes every resource in the stack, including the Aurora cluster, its data, and the log groups. The code bucket isn't part of the stack. To remove it, empty it first, including all object versions (for example, from the S3 console with **Empty**), then delete it.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
