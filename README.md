# pgsearch

Lambda API with PostgreSQL database using Philadelphia constructs and Hono.

Generated on {{timestamp}}

## Architecture

![Architecture Diagram](https://github.com/CityOfPhiladelphia/phila-ctl/blob/main/packages/constructs/docs/diagrams/lambda-postgres-api.drawio)

View the [architecture diagram](https://github.com/CityOfPhiladelphia/phila-ctl/blob/main/packages/constructs/docs/diagrams/lambda-postgres-api.drawio) in draw.io or VS Code with the Draw.io extension.

## Quick Start

### Prerequisites

- Node.js 20+
- AWS CLI configured with SSO
- AWS profile named `phila-pgsearch`

### Setup

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm run build
```

### Deployment

```bash
# Configure AWS profile
export AWS_PROFILE=phila-pgsearch

# Deploy to dev environment
city deploy dev

# Deploy to test environment
city deploy test

# Deploy to production (requires confirmation)
city deploy prod
```

### Development

```bash
# Build TypeScript
pnpm run build

# View CDK diff before deploying
pnpm run diff

# Synthesize CloudFormation template
pnpm run synth
```

## Project Structure

```
.
├── cdk/                    # CDK infrastructure code
│   └── app.ts              # Main CDK application
├── apps/                   # Lambda function code
│   └── api/     # Lambda handler
│       └── index.ts        # Handler implementation
└── city.config.json        # City CLI configuration
```

## API Usage

After deployment, the API URL is available in SSM Parameter Store:

```bash
aws ssm get-parameter --name "/dev/pgsearch/api/main/url" --query Parameter.Value --output text
```

Or use the City CLI:

```bash
city config list --env dev
```

## API Authentication

The API uses path-based authentication with two endpoint patterns:

| Path Pattern | Authentication | Use Case |
|--------------|----------------|----------|
| `/public/*` | None | Health checks, public data, webhooks |
| `/private/key/*` | API Key required | Protected endpoints |

### Using Protected Endpoints

Protected endpoints require the `x-api-key` header. The API key is stored in AWS Secrets Manager and encrypted with a dedicated KMS key.

**Retrieve the API key:**

```bash
# Get the secret ARN from Parameter Store
SECRET_ARN=$(aws ssm get-parameter \
  --name "/dev/pgsearch/api/main/key-secret-arn" \
  --query Parameter.Value --output text)

# Retrieve the API key value
API_KEY=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ARN" \
  --query SecretString --output text)
```

**Call a protected endpoint:**

```bash
curl -H "x-api-key: $API_KEY" \
  "https://<api-id>.execute-api.us-east-1.amazonaws.com/dev/private/key/items"
```

### API Key Rotation

API keys are **not** automatically rotated. When you need to rotate:

1. Generate a new secret value in Secrets Manager
2. Update the API Gateway API key
3. Coordinate with all API consumers to update their keys
4. Delete the old API key after migration

This manual approach ensures controlled rollover without breaking existing integrations.

## Routing with Hono

This template uses [Hono](https://hono.dev) for HTTP routing.

### Defining Routes

```typescript
import { Hono } from 'hono';

const app = new Hono();

// Simple response
app.get('/public/health', (c) => c.json({ status: 'healthy' }));

// With database query
app.get('/public/items', async (c) => {
  const db = await getDbConnection();
  const items = await db.query('SELECT * FROM items');
  return c.json({ items });
});
```

### Request Data

```typescript
// Path parameters
const id = c.req.param('id');

// Query parameters
const name = c.req.query('name');

// Request body
const body = await c.req.json();
```

### Responses

```typescript
// JSON response
return c.json({ item });

// With status code
return c.json({ item }, 201);

// Error response
return c.json({ error: 'Not found' }, 404);
```

### Error Handling

```typescript
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});
```

### Middleware

```typescript
import { cors } from 'hono/cors';

app.use('*', cors());

app.use('/private/*', async (c, next) => {
  // auth check
  await next();
});
```

## Database Connection

The Lambda function receives database connection information via environment variables:

| Variable | Description |
|----------|-------------|
| `DB_SECRET_ARN` | ARN of Secrets Manager secret with database credentials |
| `DB_NAME` | Database name |

### Retrieving Credentials

Use the AWS SDK to retrieve credentials from Secrets Manager:

```typescript
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

async function getDbCredentials() {
  const client = new SecretsManagerClient({});
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN })
  );
  return JSON.parse(response.SecretString || '{}');
}
```

The secret contains:
- `username` - Database username
- `password` - Database password
- `host` - Database hostname (retrieved from SSM parameters)
- `port` - Database port (default: 5432)

### Connection Options

Choose your preferred PostgreSQL client library:

- **pg** - Low-level PostgreSQL client
- **knex** - SQL query builder
- **TypeORM** - Full ORM
- **Prisma** - Type-safe ORM
- **drizzle-orm** - Lightweight ORM

Add your chosen library to `apps/api/package.json`.

## Environment Variables

Lambda functions automatically receive:
- `APP_NAME` - Application name (pgsearch)
- `ENVIRONMENT` - Current environment (dev/test/prod)
- `DB_SECRET_ARN` - Database credentials secret ARN
- `DB_NAME` - Database name

## Resources Created

This application creates:
- **API Gateway REST API** - HTTP endpoint with path-based auth
- **API Key & Usage Plan** - For protected endpoint authentication
- **Secrets Manager Secrets** - API key and database credentials (KMS encrypted)
- **KMS Keys** - Encrypts API key and database secrets (auto-rotate annually)
- **WAF Web ACL** - Protects API from common attacks
- **Lambda Function** - Serverless compute for handling requests
- **RDS PostgreSQL** - Managed database instance
- **VPC Security Groups** - Network security for Lambda and database
- **IAM Roles** - Permissions for Lambda, Secrets Manager, and database access
- **SSM Parameters** - Resource discovery (API URL, API key secret ARN, database endpoint)
- **CloudWatch Logs** - Application and API Gateway access logs

## Serverless Aurora

To use Aurora Serverless v2 instead of provisioned RDS, edit `cdk/app.ts`:

```typescript
new LambdaPostgresApi(stack as any, 'pgsearchApi', {
  ...context,
  apiId: 'main',
  runtime: 'nodejs22',
  handler: 'index.handler',
  codeDir: '../apps/api/dist',
  serverless: true,  // Use Aurora Serverless v2
});
```

## Next Steps

1. Add a PostgreSQL client library to your Lambda
2. Implement database connection logic using `DB_SECRET_ARN`
3. Define your routes in `apps/api/index.ts`
4. Add route handlers for validation and business logic
5. Write tests for your handlers
6. Set up CI/CD pipeline

## Support

For issues or questions:
- [Philadelphia Infrastructure Library Documentation](https://github.com/CityOfPhiladelphia/phila-ctl)
- [Hono Documentation](https://hono.dev)
- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
- [API Gateway Developer Guide](https://docs.aws.amazon.com/apigateway/)
- [RDS PostgreSQL Documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html)
