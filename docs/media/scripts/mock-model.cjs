// Scripted OpenAI-compatible model for the demo recordings. No network, no keys.
// Usage: node mock-model.cjs <port> [code|bot]
const http = require('http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mode = process.argv[3] || 'code'
const chunk = (o) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, ...o }] })}\n\n`
async function stream(res, parts, finish = 'stop', delay = 45) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const p of parts) {
    res.write(chunk({ delta: p }))
    await sleep(delay)
  }
  res.write(chunk({ delta: {}, finish_reason: finish }))
  res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [], usage: { prompt_tokens: 2400, completion_tokens: 160 } })}\n\n`)
  res.end('data: [DONE]\n\n')
}
const words = (s) => s.match(/.{1,5}/gs).map((c) => ({ content: c }))
const OLD = "app.post('/orders', (req, res) => {\n  const order = db.insert(req.body)\n"
const NEW = "app.post('/orders', (req, res) => {\n  if (!Array.isArray(req.body.items) || req.body.items.length === 0) {\n    return res.status(400).json({ error: 'items must be a non-empty array' })\n  }\n  const order = db.insert(req.body)\n"
http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock', context_length: 128000 }] }))
      const j = JSON.parse(body || '{}')
      if (!j.tools?.length) return stream(res, [{ content: mode === 'bot' ? 'Weekend plans' : 'Validate orders' }], 'stop', 0)
      const nTools = j.messages.filter((m) => m.role === 'tool').length
      const call = (name, args) => ({ tool_calls: [{ index: 0, id: `call_${nTools}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
      if (mode === 'bot')
        return stream(res, [{ reasoning_content: 'They want a relaxed weekend idea. Keep it short and warm.' }, ...words("Of course! Here's a **lazy Saturday** plan:\n\n1. Slow breakfast and a long walk by the water\n2. Browse the farmers' market for something to cook\n3. Evening: a film and the good tea\n\nWant me to put it in your calendar and remind you to buy tickets?\n")], 'stop', 40)
      if (nTools >= 2) return stream(res, words('Done. `POST /orders` now answers **400** when `items` is missing or empty, before anything touches the database.\n'))
      if (nTools === 1) return stream(res, [...words('Now the guard, right at the top of the handler.\n\n'), call('edit_file', { path: 'src/orders.js', old_string: OLD, new_string: NEW })], 'tool_calls')
      return stream(res, [
        { reasoning_content: 'The route inserts req.body unchecked. Reject a missing or empty items array with a 400 first.' },
        ...words("I'll look at the `POST /orders` handler first.\n\n"),
        call('read_file', { path: 'src/orders.js' }),
      ], 'tool_calls')
    })
  })
  .listen(Number(process.argv[2]), '127.0.0.1')
