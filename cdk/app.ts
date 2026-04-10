#!/usr/bin/env node
import 'source-map-support/register';
import { App, Stack } from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { LambdaPostgresApi, Confidentiality, Environment, applyNagChecks, applyStandardTags } from '@phila/constructs';

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

// WAF override: the AWS Managed Common Rule Set includes SizeRestrictions_BODY,
// which blocks any request body over 8 KiB. Document ingest payloads are routinely
// 10-60 KB of parsed markdown, so without this override every POST /public/index/*
// /documents call is rejected with a 403 before reaching the Lambda. Set the rule to
// Count so it's still observable in CloudWatch without blocking. Delete this block
// once @phila/constructs exposes a first-class commonRuleSetOverrides prop.
const webAcl = pgsearchApi.api.node
  .findChild('Waf')
  .node.findChild('WebAcl') as wafv2.CfnWebACL;
webAcl.addPropertyOverride(
  'Rules.0.Statement.ManagedRuleGroupStatement.RuleActionOverrides',
  [{ Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }],
);

// Apply standard tags to all taggable resources
applyStandardTags(app, context);
applyNagChecks(app);

app.synth();
