import { describe, expect, it } from 'vitest'
import { classifyUpstreamError, prepareChatBody, regionOf } from '../src/upstream.ts'

describe('prepareChatBody', () => {
  it('forces stream true', () => {
    expect(JSON.parse(prepareChatBody('{"model":"auto","messages":[]}'))['stream']).toBe(true)
  })

  it('keeps invalid JSON untouched', () => {
    expect(prepareChatBody('not json')).toBe('not json')
  })

  it('flattens object tool_choice auto', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'auto' } })))
    expect(body['tool_choice']).toBe('auto')
  })

  it('flattens named function tool_choice to the function name', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: { type: 'function', function: { name: 'grep' } },
    })))
    expect(body['tool_choice']).toBe('grep')
  })

  it('drops tool_choice and tools for none', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: { type: 'none' },
      tools: [{ type: 'function', function: { name: 'grep' } }],
    })))
    expect('tool_choice' in body).toBe(false)
    expect('tools' in body).toBe(false)
  })

  it('drops an unrecognized object tool_choice', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'weird' } })))
    expect('tool_choice' in body).toBe(false)
  })

  it('preserves the reasoning_effort the model picker selects', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'xhigh',
    })))
    expect(body['reasoning_effort']).toBe('xhigh')
    expect(body['stream']).toBe(true)
  })

  it('drops a reasoning level that came from another provider', () => {
    // A real session switched from a `trae` selection carrying `extra_high`;
    // pi-ai forwards an unmapped level verbatim and the provider rejects the
    // whole request with 11133.
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'extra_high',
    })))
    expect('reasoning_effort' in body).toBe(false)
  })

  it('drops a non-string reasoning_effort shape', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'glm-5.3', messages: [], reasoning_effort: { type: 'enabled' },
    })))
    expect('reasoning_effort' in body).toBe(false)
  })

  it('normalizes the case and surroundings of a valid level', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'glm-5.3', messages: [], reasoning_effort: '  XHIGH ',
    })))
    expect(body['reasoning_effort']).toBe('xhigh')
  })

  it('drops a level the selected model does not accept', () => {
    const policy = (model: string): readonly string[] | undefined =>
      model === 'glm-5.3' ? ['low', 'high', 'xhigh', 'off'] : undefined
    const dropped = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'glm-5.3', messages: [], reasoning_effort: 'max',
    }), policy))
    expect('reasoning_effort' in dropped).toBe(false)
    const kept = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'glm-5.3', messages: [], reasoning_effort: 'off',
    }), policy))
    expect(kept['reasoning_effort']).toBe('off')
  })

  it('rewrites developer messages to system (upstream rejects developer)', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'developer', content: 'system prompt' },
        { role: 'user', content: 'hi' },
      ],
      reasoning_effort: 'max',
    })))
    const roles = body['messages'].map((message: { role: string }) => message.role)
    expect(roles).toEqual(['system', 'user'])
    expect(body['reasoning_effort']).toBe('max')
  })

  it('demotes a harness prompt carried by a developer message, text untouched', () => {
    // DSH's own prompt arrives as `developer` (pi-ai's OpenAI shape). It becomes
    // `system` first — the upstream rejects `developer` outright — and is then
    // demoted to `user`, the role the channel check accepts. Demotion (not
    // rewording) is what makes this stable across prompt changes.
    const content = 'You are an AI agent powered by DeepSeek Harness. Use tools carefully.'
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'developer', content }, { role: 'user', content: 'hi' }],
    })))
    const system = body['messages'][0] as { role: string, content: string }
    expect(system.role).toBe('user')
    expect(system.content).toBe(content)
  })

  it('demotes the paired Web GUI sentences carried as text shards', () => {
    const first = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.'
    const second = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.'
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{
        role: 'system',
        content: [{ type: 'text', text: `${first} ${second} The browser provides no implicit DOM.` }],
      }],
    })))
    expect((body['messages'][0] as { role: string }).role).toBe('user')
    const text = (body['messages'][0] as { content: { type: string, text: string }[] }).content[0]!.text
    // The text is preserved verbatim: demotion, not rewording, is the fix.
    expect(text).toContain('You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.')
    expect(text).toContain('The browser provides no implicit DOM.')
  })

  it('demotes the legacy Web GUI paragraph that embedded the URL directly', () => {
    const content = 'You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:58031/. Do not start a replacement server.'
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'system', content }],
    })))
    const message = body['messages'][0] as { role: string, content: string }
    expect(message.role).toBe('user')
  })

  it('keeps a neutral system prompt on the system role', () => {
    // A plain OpenAI client's system message must not be demoted: the check
    // keys on the harness fingerprint, not on the role by itself.
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'system', content: 'Be concise and answer in English.' }, { role: 'user', content: 'hi' }],
    })))
    expect((body['messages'][0] as { role: string }).role).toBe('system')
  })

  it('rewrites the @-file-reference paragraph that trips 11128 as a whole', () => {
    // `FILE_REFERENCE_PROMPT` from dsh-file-reference. Measured in issue #12:
    // the full paragraph is rejected, every sentence of it passes alone.
    const content = [
      'Tokens prefixed with @ are paths the user explicitly referenced.',
      'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.',
      'A trailing slash marks a directory: list it when its contents matter.',
      'Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading.',
      '@"..." quotes a path containing spaces.',
    ].join(' ')
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'system', content }],
    })))
    const scrubbed = (body['messages'][0] as { content: string }).content
    expect(scrubbed).not.toContain('Tokens prefixed with @')
    expect(scrubbed).toContain('A token prefixed with @ names a path the user explicitly referenced.')
    // The rest of the paragraph must survive untouched — the channel check
    // needs the whole block, one reworded sentence is enough to clear it.
    expect(scrubbed).toContain('A trailing slash marks a directory: list it when its contents matter.')
    expect(scrubbed).toContain('@"..." quotes a path containing spaces.')
  })

  it('scrubs fingerprints an assistant message quotes but leaves user and tool roles verbatim', () => {
    const quoted = 'You are an AI agent powered by DeepSeek Harness. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.'
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'assistant', content: `The prompt says: ${quoted}` },
        { role: 'user', content: `Repeat after me: ${quoted}` },
        { role: 'tool', content: `grep hit: ${quoted}`, tool_call_id: 'call-1' },
      ],
    })))
    const messages = body['messages'] as { role: string, content: string }[]
    const assistant = messages[0]!
    const user = messages[1]!
    const tool = messages[2]!
    expect(assistant.content).not.toContain('DeepSeek Harness')
    expect(assistant.content).toContain('The prompt says: You are an AI agent.')
    expect(user.content).toBe(`Repeat after me: ${quoted}`)
    expect(tool.content).toBe(`grep hit: ${quoted}`)
  })

  it('rewrites the top-level system string when a body carries one', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4-flash',
      system: 'You are an AI agent powered by DeepSeek Harness.',
      messages: [{ role: 'user', content: 'hi' }],
    })))
    expect(body['system']).toBe('You are an AI agent.')
  })
})

describe('classifyUpstreamError', () => {
  it('classifies 402 as hard credit', () => {
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
  })

  it('classifies credit wording in a 200-shaped business error', () => {
    expect(classifyUpstreamError(200, 'code=1 msg=积分不足，请充值')).toBe('hard_credit')
  })

  it('classifies the offline session marker as session dead', () => {
    expect(classifyUpstreamError(401, 'Offline user session not found')).toBe('session_dead')
  })

  it('classifies 429 as soft rate', () => {
    expect(classifyUpstreamError(429, 'slow down')).toBe('soft_rate')
  })

  it('classifies 404 as transient not-found', () => {
    expect(classifyUpstreamError(404, '')).toBe('not_found')
  })

  it('classifies 5xx as server and other 4xx as client', () => {
    expect(classifyUpstreamError(503, '')).toBe('server')
    expect(classifyUpstreamError(400, 'bad')).toBe('client')
  })
})

describe('regionOf', () => {
  it('treats workbuddy.ai domains as global and everything else as cn', () => {
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('workbuddy.ai')).toBe('global')
    expect(regionOf('US.WorkBuddy.AI')).toBe('global')
    expect(regionOf('')).toBe('cn')
  })
})
