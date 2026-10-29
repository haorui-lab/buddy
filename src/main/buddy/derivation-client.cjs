// Invoked by actors during a turn. The socket belongs to that turn's actor.
const http = require('node:http')
const fs = require('node:fs')

function request(socketPath, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: '/',
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    }, res => {
      let text = ''
      res.on('data', data => { text += data })
      res.on('end', () => {
        try {
          const value = text ? JSON.parse(text) : {}
          if (res.statusCode !== 200) reject(new Error(value.error || `HTTP ${res.statusCode}`))
          else resolve(value)
        } catch (error) { reject(error) }
      })
    })
    req.setTimeout(20000, () => req.destroy(new Error('Buddy derivation request timed out')))
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

function flag(args, name) {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) return ''
  return args[index + 1]
}

async function main(args) {
  const [action, ...rest] = args
  if (!process.env.BUDDY_DERIVATION_SOCKET || !process.env.BUDDY_DERIVATION_TOKEN) {
    throw new Error('No active Buddy derivation session')
  }
  let body = { action }
  if (action === 'propose') {
    const file = rest[0]
    if (!file) throw new Error('Usage: propose /path/to/derivation-spec.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    body.specs = Array.isArray(parsed) ? parsed : parsed.specs
  } else if (action === 'decide') {
    const decision = rest[0]
    if (decision !== 'agree' && decision !== 'disagree') throw new Error('Usage: decide agree|disagree REASON')
    body.decision = decision
    body.reason = rest.slice(1).join(' ')
  } else if (action === 'submit') {
    body.version = flag(rest, '--version')
    body.artifacts = flag(rest, '--artifacts')
    body.verification = flag(rest, '--verification')
    body.open_issues = flag(rest, '--issues')
  } else if (action === 'review') {
    const [childTaskId, decision, ...comment] = rest
    if (!childTaskId || (decision !== 'accept' && decision !== 'reject')) {
      throw new Error('Usage: review CHILD_TASK_ID accept|reject COMMENT')
    }
    body.child_task_id = childTaskId
    body.decision = decision
    body.comment = comment.join(' ')
  } else if (action === 'waive') {
    const [childTaskId, ...reason] = rest
    if (!childTaskId || reason.join(' ').trim() === '') throw new Error('Usage: waive CHILD_TASK_ID REASON')
    body.child_task_id = childTaskId
    body.reason = reason.join(' ')
  } else if (action === 'restart') {
    const childTaskId = rest[0]
    if (!childTaskId) throw new Error('Usage: restart CHILD_TASK_ID')
    body.child_task_id = childTaskId
  } else if (!['status', 'create', 'wait'].includes(action)) {
    throw new Error('Use status, propose, decide, create, wait, submit, review, waive or restart')
  }
  return request(process.env.BUDDY_DERIVATION_SOCKET, process.env.BUDDY_DERIVATION_TOKEN, body)
}

main(process.argv.slice(2)).then(value => console.log(JSON.stringify(value))).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
