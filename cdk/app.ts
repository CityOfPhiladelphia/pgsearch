#!/usr/bin/env node
import 'source-map-support/register';
import { App, Stack } from 'aws-cdk-lib';
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
new LambdaPostgresApi(stack as any, 'pgsearchApi', {
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

// Apply standard tags to all taggable resources
applyStandardTags(app, context);
applyNagChecks(app);

app.synth();
