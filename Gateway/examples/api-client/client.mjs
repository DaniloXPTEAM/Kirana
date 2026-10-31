const base = process.env.GATEWAY_URL || 'http://127.0.0.1:1455';
const key = process.env.GATEWAY_API_KEY;
if (!key) throw new Error('Set GATEWAY_API_KEY in the client process. Do not commit it.');
const model = process.argv[2];
if (!model) throw new Error('Usage: node examples/api-client/client.mjs MODEL_SLUG');
const response = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    stream: true,
    messages: [{ role: 'user', content: 'Responda em português brasileiro: diga olá e explique em uma frase o que você consegue fazer.' }],
  }),
});
if (!response.ok) throw new Error(`Gateway error ${response.status}: ${await response.text()}`);
for await (const chunk of response.body) process.stdout.write(chunk);
