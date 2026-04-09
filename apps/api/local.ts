// ABOUTME: Local Node entrypoint for the pgsearch API.
// ABOUTME: Runs the same Hono app as the Lambda handler under @hono/node-server for dev iteration.

import { serve } from '@hono/node-server'
import { app } from './index'

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`pgsearch API listening on http://localhost:${info.port}`)
})
