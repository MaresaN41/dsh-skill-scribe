import assert from "node:assert/strict"
import { test } from "node:test"
import { REDACTED, redact, redactDeep } from "../src/redact.js"

const cases = [
  ["openai key", "key is sk-abcdefghijklmnopqrstuvwxyz123456 ok", "sk-abcdefghijklmnopqrstuvwxyz123456"],
  ["anthropic key", "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV_xyz", "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV_xyz"],
  ["github pat", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["github fine-grained", "github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz", "github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz"],
  ["aws access key", "AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  ["slack token", "xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
  ["google key", "AIzaSyA-1234567890abcdefghijklmnopqrstu", "AIzaSyA-1234567890abcdefghijklmnopqrstu"],
  ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk123", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk123"],
  ["bearer header", "Authorization: Bearer abcDEF123456789xyz", "abcDEF123456789xyz"],
  ["env assignment", "export OPENAI_API_KEY=hunter2hunter2", "hunter2hunter2"],
  ["env quoted", 'GITHUB_TOKEN="my secret value"', "my secret value"],
  ["json field", '{"api_key": "abc123def456"}', "abc123def456"],
  ["password colon", "password: s3cr3t!", "s3cr3t!"],
  ["url userinfo", "postgres://admin:p4ssw0rd@db.local/app", "p4ssw0rd"],
  ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----", "MIIEabc"],
]

for (const [label, input, secret] of cases) {
  test(`redact: ${label}`, () => {
    const out = redact(input)
    assert.ok(!out.includes(secret), `leaked in: ${out}`)
    assert.ok(out.includes(REDACTED))
  })
}

test("redact keeps ordinary text and names", () => {
  const s = "Run awk on sales.csv and write summary.txt; the token count is 3 and the key column is region."
  assert.equal(redact(s), s)
})

test("redact keeps the variable name, drops the value", () => {
  assert.equal(redact("MY_SECRET_TOKEN=abc12345"), `MY_SECRET_TOKEN=${REDACTED}`)
})

test("redact handles non-strings", () => {
  assert.equal(redact(undefined), "")
  assert.equal(redact(""), "")
})

test("redactDeep walks objects and arrays", () => {
  const out = redactDeep({ a: ["x", { b: "Bearer abcdefgh12345" }], n: 1 })
  assert.equal(out.n, 1)
  assert.ok(out.a[1].b.includes(REDACTED))
})

test("redact masks literal values of secret-named environment variables", () => {
  const key = "SCRIBE_TEST_API_KEY"
  const old = process.env[key]
  process.env[key] = "synthetic-opaque-value-43862"
  try {
    assert.equal(redact(`use ${process.env[key]} here`), `use ${REDACTED} here`)
  } finally {
    if (old === undefined) delete process.env[key]
    else process.env[key] = old
  }
})

test("redact masks complete authentication and cookie headers", () => {
  const inputs = [
    "Authorization: Basic dXNlcjpwYXNz",
    "Proxy-Authorization: Token opaque-value",
    '"Authorization": "Basic dXNlcjpwYXNz"',
    '"Cookie": "session=short"',
    "Set-Cookie: session=short; HttpOnly",
  ]
  for (const input of inputs) {
    const out = redact(input)
    assert.ok(out.includes(REDACTED), input)
    assert.ok(!out.includes("Basic") && !out.includes("Token") && !out.includes("session="), out)
  }
  assert.deepEqual(JSON.parse(redact('{"Authorization": "Basic dXNlcjpwYXNz", "Cookie": "session=short"}')),
    { Authorization: REDACTED, Cookie: REDACTED })
})

test("redact masks Stripe keys and command-line credentials", () => {
  const inputs = [
    "sk_live_ABCDEFGHIJKLMNOPQRSTUVWX",
    "rk_test_ABCDEFGHIJKLMNOPQRSTUVWX",
    "curl -u user:pass https://example.test",
    'curl --user="user:pass" https://example.test',
    'curl -u "user:pass" https://example.test',
    "tool --password short --token=small --api-key 'some value'",
    "mysql -h localhost -psecret123 database",
    "DB_PASS=short PASSWD=small",
    "cookie:session=short",
  ]
  for (const input of inputs) {
    const out = redact(input)
    assert.ok(out.includes(REDACTED), input)
    for (const value of ["ABCDEFGHIJKLMNOPQRSTUVWX", "user:pass", "short", "small", "some value", "secret123", "session=short"]) {
      if (input.includes(value)) assert.ok(!out.includes(value), out)
    }
  }
})

test("redact preserves short ordinary values and author fields", () => {
  const key = "SCRIBE_TEST_FOO_TOKEN"
  const old = process.env[key]
  process.env[key] = "1"
  try {
    assert.equal(redact("1 error; FOO_TOKEN=1; author: Jane Doe; authors: group; authority: team"),
      `1 error; FOO_TOKEN=${REDACTED}; author: Jane Doe; authors: group; authority: team`)
  } finally {
    if (old === undefined) delete process.env[key]
    else process.env[key] = old
  }
})

test("redact masks sshpass passwords and password aliases in context", () => {
  for (const input of [
    "sshpass -p hunter2 ssh host",
    "sshpass -p'quote value' ssh host",
    "sshpass -pvalue ssh host",
    "pwd=small passphrase: 'short value'",
  ]) {
    const out = redact(input)
    assert.ok(out.includes(REDACTED), input)
    for (const secret of ["hunter2", "quote value", "value", "small", "short value"]) {
      if (input.includes(secret)) assert.ok(!out.includes(secret), out)
    }
  }
  assert.equal(redact("ssh -p 2222 host; pwd; author: Jane Doe"), "ssh -p 2222 host; pwd; author: Jane Doe")
  assert.equal(redact("sshpass -p hunter2 ssh -p 2222 host"), `sshpass -p ${REDACTED} ssh -p 2222 host`)
  assert.equal(redact("sshpass -e ssh -p 2222 host"), "sshpass -e ssh -p 2222 host")
})

test("PWD and OLDPWD environment values do not mask ordinary paths", () => {
  const oldPwd = process.env.PWD
  const oldOldPwd = process.env.OLDPWD
  process.env.PWD = "/synthetic/worktree-path"
  process.env.OLDPWD = "/synthetic/previous-path"
  try {
    assert.equal(redact("cwd /synthetic/worktree-path; previous /synthetic/previous-path; pwd"),
      "cwd /synthetic/worktree-path; previous /synthetic/previous-path; pwd")
    assert.equal(redact("pwd=small"), `pwd=${REDACTED}`)
  } finally {
    if (oldPwd === undefined) delete process.env.PWD
    else process.env.PWD = oldPwd
    if (oldOldPwd === undefined) delete process.env.OLDPWD
    else process.env.OLDPWD = oldOldPwd
  }
})

test("credential aliases mask short values without replacing ordinary PWD paths", () => {
  assert.equal(redact("db_pwd=hunter2 DB_PWD: hunter2 export SSHPASS=hunter2"),
    `db_pwd=${REDACTED} DB_PWD: ${REDACTED} export SSHPASS=${REDACTED}`)
  assert.equal(redact("PWD=/synthetic/work MODE=ok OLDPWD=/synthetic/previous"),
    "PWD=/synthetic/work MODE=ok OLDPWD=/synthetic/previous")
  assert.equal(redact("max_tokens:4096, tokens:12, pass:true; const pwd = process.cwd()"),
    "max_tokens:4096, tokens:12, pass:true; const pwd = process.cwd()")
  assert.equal(redact("pwd=process.cwd()"), `pwd=${REDACTED}`)
  assert.equal(redact("db_pwd=1 password: true token=12"),
    `db_pwd=${REDACTED} password: ${REDACTED} token=${REDACTED}`)
  assert.equal(redact("pass:12 tokens:'12' max_tokens=4096"),
    `pass:${REDACTED} tokens:'${REDACTED}' max_tokens=4096`)
})

test("SSHPASS environment literal is masked without masking PWD", () => {
  const old = process.env.SSHPASS
  process.env.SSHPASS = "synthetic-sshpass-8742"
  try {
    assert.equal(redact(`value ${process.env.SSHPASS} here`), `value ${REDACTED} here`)
  } finally {
    if (old === undefined) delete process.env.SSHPASS
    else process.env.SSHPASS = old
  }
})

test("JSON scalar metrics stay intact while numeric credentials remain masked", () => {
  const metrics = JSON.stringify({ max_tokens: 4096, tokens: 12, pass: true })
  assert.equal(redact(metrics), metrics)
  assert.equal(redact('[{"pass":false}]'), '[{"pass":false}]')
  assert.deepEqual(JSON.parse(redact(JSON.stringify({ password: 1234, token: 12, db_pwd: 1 }))),
    { password: REDACTED, token: REDACTED, db_pwd: REDACTED })
  assert.equal(redact("password=12}}"), `password=${REDACTED}`)
  assert.equal(redact("password=ab}cd"), `password=${REDACTED}`)
})

test("long numeric values and uppercase metric-like names are masked", () => {
  assert.equal(redact("max_tokens:4096 tokens:12 max_tokens:999999"), "max_tokens:4096 tokens:12 max_tokens:999999")
  assert.equal(redact("tokens:12345678 TOKENS=12345678 MAX_TOKENS:999999999999"),
    `tokens:${REDACTED} TOKENS=${REDACTED} MAX_TOKENS:${REDACTED}`)
  assert.equal(redact("password:1 token:12345678 api_key:12 db_pwd:9"),
    `password:${REDACTED} token:${REDACTED} api_key:${REDACTED} db_pwd:${REDACTED}`)
})

test("multiline quoted credentials are masked through the closing quote", () => {
  for (const [input, expected] of [
    ['password: "a\nb" status=ok', `password: "${REDACTED}" status=ok`],
    ['password: "a\r\nb" token: tiny', `password: "${REDACTED}" token: ${REDACTED}`],
    ["password: 'a\nb' status=ok", `password: '${REDACTED}' status=ok`],
    ['password: "a\\\nb" status=ok', `password: "${REDACTED}" status=ok`],
    ['Authorization: "Basic a\nb"\npublic text', `Authorization: "${REDACTED}"\npublic text`],
    ['tool --password "a\nb" --mode public', `tool --password "${REDACTED}" --mode public`],
    ['mysql -p"a\nb" database; ssh -p 2222 host', `mysql -p"${REDACTED}" database; ssh -p 2222 host`],
    ['sshpass -p"a\nb" ssh -p 2222 host', `sshpass -p"${REDACTED}" ssh -p 2222 host`],
    ['password: "a\nb', `password: "${REDACTED}"`],
    ['password: "a\nb\\', `password: "${REDACTED}"`],
  ]) assert.equal(redact(input), expected)
})

test("escaped quotes stay inside masked credential values", () => {
  for (const [input, expected] of [
    ['password: "hun\\"ter2"', `password: "${REDACTED}"`],
    ["password: 'hun\\'ter2'", `password: '${REDACTED}'`],
    ['"token": "hun\\"ter2"', `"token": "${REDACTED}"`],
    ['Authorization: "Basic hun\\"ter2"', `Authorization: "${REDACTED}"`],
    ['tool --password "hun\\"ter2"', `tool --password "${REDACTED}"`],
    ['mysql -p"hun\\"ter2" database', `mysql -p"${REDACTED}" database`],
    ['sshpass -p"hun\\"ter2" ssh host', `sshpass -p"${REDACTED}" ssh host`],
    ['pwd="hun\\"ter2"', `pwd="${REDACTED}"`],
    ['password: "hun\\"ter2" token: tiny', `password: "${REDACTED}" token: ${REDACTED}`],
    ['password: "hun\\"ter2', `password: "${REDACTED}"`],
    ['password: "hun\\', `password: "${REDACTED}"`],
  ]) assert.equal(redact(input), expected)
})

test("redact masks webhook URLs, signed URLs, more CLI flags, and secrets stated in prose", () => {
  for (const [input, secret] of [
    ["curl --access-token syntheticSecret12345678 https://example.com", "syntheticSecret12345678"],
    ["fetch --auth-token syntheticSecret12345678", "syntheticSecret12345678"],
    ["tool --client-secret=syntheticSecret12345678", "syntheticSecret12345678"],
    ["https://discord.com/api/webhooks/123456789012345678/syntheticWebhookToken123", "syntheticWebhookToken123"],
    ["https://discordapp.com/api/webhooks/123456789012345678/syntheticWebhookToken123", "syntheticWebhookToken123"],
    ["https://hooks.slack.com/services/T00000000/B00000000/syntheticWebhookToken123", "syntheticWebhookToken123"],
    ["https://example.test/file?X-Amz-Signature=abcdef1234567890&x=1", "abcdef1234567890"],
    ["https://example.test/file?sig=abcdef1234567890", "abcdef1234567890"],
    ["https://example.test/a?X-Goog-Signature=abcdef1234567890", "abcdef1234567890"],
    ["My API key is abc123def456ghi", "abc123def456ghi"],
    ["the password was Hunter2Hunter2", "Hunter2Hunter2"],
    ["パスワードは hunter2hunter2 です", "hunter2hunter2"],
    ["APIキー: abc123def456ghi", "abc123def456ghi"],
  ]) {
    const output = redact(input)
    assert.ok(output.includes(REDACTED), output)
    assert.ok(!output.includes(secret), output)
  }
})

test("redact keeps ordinary commands, URLs, and sentences", () => {
  for (const input of [
    "the token is valid",
    "password is required",
    "the API key is missing from the config",
    "パスワードは必須です",
    "--max-tokens 4096",
    "--token-limit 5",
    "curl https://example.com/a?page=2&sort=name",
    "https://example.com/design?sign=up",
    "https://discord.com/channels/1/2",
    "https://hooks.example.com/services/a/b/c",
    "git commit --author alice",
  ]) assert.equal(redact(input), input)
})

test("redact masks cookies, underscore flags, and auth values in query strings", () => {
  for (const [input, secret] of [
    ["curl --cookie sessionid=syntheticSession123456", "syntheticSession123456"],
    ["curl --cookie=sessionid=syntheticSession123456 https://example.test", "syntheticSession123456"],
    ["curl -b sessionid=syntheticSession123456 https://example.test", "syntheticSession123456"],
    ['curl -b "sessionid=syntheticSession123456; a=1" https://example.test', "syntheticSession123456"],
    ["tool --access_token syntheticSecret12345678", "syntheticSecret12345678"],
    ["tool --access-key syntheticSecret12345678", "syntheticSecret12345678"],
    ["https://example.test/callback?access_key=syntheticAccess123456", "syntheticAccess123456"],
    ["https://example.test/run?session=syntheticSession123456", "syntheticSession123456"],
    ["https://example.test/run?a=1&session_id=syntheticSession123456&b=2", "syntheticSession123456"],
  ]) {
    const output = redact(input)
    assert.ok(output.includes(REDACTED), output)
    assert.ok(!output.includes(secret), output)
  }
})

test("redact keeps -b and session values that are not credentials", () => {
  for (const input of [
    "git checkout -b feature-branch",
    "sort -b names.txt",
    "curl --cookie-jar cookies.txt https://example.test",
    "https://example.test/run?session=summer",
    "https://example.test/talks?session=42&room=3",
  ]) assert.equal(redact(input), input)
})
