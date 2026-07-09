#!/usr/bin/env node
import 'source-map-support/register';
import { App, Stack } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { LambdaPostgresApi, Confidentiality, Environment, applyNagChecks, applyStandardTags } from '@phila/constructs';
import { NagSuppressions } from 'cdk-nag';

const app = new App();

// Environment is determined by CDK context
const environment = app.node.tryGetContext('environment') as Environment;

if (!environment) {
  throw new Error('Environment must be specified via context. Use: cdk deploy -c environment=dev');
}

// Read compliance frameworks from context
const compliance = app.node.tryGetContext('compliance');
const complianceFrameworks = compliance ? compliance.split(',') : [];

// Application context with governance metadata
const context = {
  appName: 'pgsearch',
  environment,
  department: '4-oit',
  team: 'Software Engineering',
  contact: 'darren.mcdowell@phila.gov',
  compliance: complianceFrameworks,
  confidentiality: Confidentiality.LOW,
  cliVersion: '0.4.7',
};

// Stack name follows pattern: {appName}-{environment}
const stack = new Stack(app, 'pgsearch-' + environment, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  stackName: 'pgsearch-' + environment,
});

const networkCidrsRaw = app.node.tryGetContext('networkCidrs') as string | undefined;
const networkCidrs = networkCidrsRaw ? networkCidrsRaw.split(',') : undefined;

// Scope as any so linked @phila/constructs resolves to a single Construct type at runtime.
const pgsearchApi = new LambdaPostgresApi(stack as any, 'pgsearchApi', {
  ...context,
  apiId: 'api',
  runtime: 'nodejs22',
  handler: 'index.handler',
  codeDir: '../apps/api/dist',
  reservedConcurrentExecutions: 5,
  multiAz: environment === 'prod' ? true : false,
  ...(networkCidrs ? { networkCidrs } : {}),
  // Uncomment for serverless Aurora instead of provisioned RDS:
  // serverless: true,
});

// pg_cron runs the BM25 reconcile_index_stats job in-DB, off the 30s request-path
// ceiling. It must be in shared_preload_libraries — a static parameter the default
// parameter group cannot carry — so attach a custom one. A freshly-created instance
// boots with it preloaded; an existing instance needs a one-time reboot to pick it
// up. cron.database_name pins the cron schema (and permits CREATE EXTENSION) to the
// application database.
const dbParams = new rds.ParameterGroup(stack, 'PgCronParameters', {
  engine: rds.DatabaseInstanceEngine.postgres({
    version: rds.PostgresEngineVersion.of('15.17', '15'),
  }),
  description: 'pgsearch: enable pg_cron alongside pg_stat_statements',
  parameters: {
    shared_preload_libraries: 'pg_stat_statements,pg_cron',
    'cron.database_name': 'pgsearch',
  },
});

const cfnDb = pgsearchApi.database.instance!.node.defaultChild as rds.CfnDBInstance;
cfnDb.dbParameterGroupName = dbParams.bindToInstance({}).parameterGroupName;

// WAF overrides: the AWS Managed Common Rule Set inspects the whole request body
// for signatures that only make sense on a body whose fields are interpreted.
// A document ingest payload is prose, stored as text and never executed nor used
// as a filesystem path, so these three rules can only produce false positives on
// POST /public/index/*/documents. Count keeps every match observable in CloudWatch
// and the WAF logs without blocking; the rules stay non-terminating, so a matching
// request is still evaluated against the rest of the ACL. Delete this block once
// @phila/constructs exposes a first-class commonRuleSetOverrides prop.
//
//   SizeRestrictions_BODY  — bodies over 8 KiB; parsed markdown runs 10-60 KB.
//   CrossSiteScripting_BODY — any tag bearing a style attribute, and any iframe;
//                             matches phila.gov pages that quote embed code.
//   GenericLFI_BODY        — the substring "../"; matches links whose URL elides
//                             a path segment, e.g. "example.org/.../grant-program/".
//
// XSS defence for these documents belongs at render time in the search clients
// that display them, not in signature matching on ingest.
const webAcl = pgsearchApi.api.node
  .findChild('Waf')
  .node.findChild('WebAcl') as wafv2.CfnWebACL;
webAcl.addPropertyOverride(
  'Rules.0.Statement.ManagedRuleGroupStatement.RuleActionOverrides',
  [
    { Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } },
    { Name: 'CrossSiteScripting_BODY', ActionToUse: { Count: {} } },
    { Name: 'GenericLFI_BODY', ActionToUse: { Count: {} } },
  ],
);

// The WAF RateLimitRule (priority 2) defaults to 1000 requests / 5 min per IP.
// Bulk document ingest — the govsync sync upserts thousands of docs in a single
// reconcile — exceeds that and gets 403'd. Raise the limit to accommodate it.
webAcl.addPropertyOverride('Rules.1.Statement.RateBasedStatement.Limit', 10000);

// Allow the Lambda to call Bedrock: Titan Embed v2 for per-index embeddings
// and Claude Haiku 4.5 via the US inference profile for RAG synthesis.
// Inference profiles require both the profile ARN and InvokeModel on the
// underlying foundation model in every region the profile may route to
// (us-east-1, us-east-2, us-west-2 for the US profile).
// cdk-nag rejects wildcards — list every ARN explicitly.
pgsearchApi.api.lambda.function.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [
      `arn:aws:bedrock:${stack.region}::foundation-model/amazon.titan-embed-text-v2:0`,
      `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
      `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
      `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
      `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
    ],
  }),
);

// Anthropic models on Bedrock are delivered via AWS Marketplace. The execution
// role needs marketplace subscription permissions to invoke them — Bedrock
// runs that check separately from bedrock:InvokeModel. These actions are
// account-level and do not accept resource ARNs, so '*' is the only valid
// resource. Suppress the cdk-nag wildcard rule with evidence below.
pgsearchApi.api.lambda.function.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
    resources: ['*'],
  }),
);
NagSuppressions.addResourceSuppressions(
  pgsearchApi.api.lambda.function.role!,
  [
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'aws-marketplace:ViewSubscriptions and Subscribe are required for Bedrock Anthropic model invocation and only accept "*" as the resource (account-level actions).',
      appliesTo: [
        'Action::aws-marketplace:ViewSubscriptions',
        'Action::aws-marketplace:Subscribe',
        'Resource::*',
      ],
    },
  ],
  true,
);

// Disable API Gateway stage-level response caching. @phila/constructs
// PhilaApiGateway enables caching with a 5-minute TTL on all methods under
// `/*/*`, but the proxy routes `/public/{proxy+}` and `/private/key/{proxy+}`
// don't declare cache key parameters, so API Gateway collapses every request
// under a proxy prefix to a single cache key. The result is that any GET
// (search, health, admin reads) returns whichever response was cached first,
// regardless of the actual query, path, or auth. Strip that out entirely for
// pgsearch — the construct needs an upstream knob for this.
const stageCfn = pgsearchApi.api.api.api.deploymentStage.node.defaultChild as apigateway.CfnStage;
stageCfn.addPropertyOverride('CacheClusterEnabled', false);
stageCfn.addPropertyOverride('MethodSettings', [
  {
    HttpMethod: '*',
    ResourcePath: '/*',
    CachingEnabled: false,
    MetricsEnabled: true,
    LoggingLevel: 'INFO',
  },
]);

// Apply standard tags to all taggable resources
applyStandardTags(app, context);
applyNagChecks(app);

app.synth();
