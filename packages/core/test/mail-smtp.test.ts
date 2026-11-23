import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { MailClient } from '../src/mail/client.js'
import { MailAccountSchema } from '../src/settings/schema.js'

// A real SMTP conversation against a local server: login, envelope, headers, threading, signature.
describe('MailClient.send over SMTP', () => {
  const received: { from: string; to: string[]; raw: string; user?: string }[] = []
  let port = 0
  const server = new SMTPServer({
    // Plain on connect, then STARTTLS with smtp-server's built-in self-signed certificate, like port 587.
    secure: false,
    authOptional: false,
    onAuth(auth, _session, cb) {
      if (auth.username === 'me@shop.test' && auth.password === 'app-pw') cb(null, { user: auth.username })
      else cb(new Error('Invalid login'))
    },
    onData(stream, session, cb) {
      let raw = ''
      stream.on('data', (c: Buffer) => (raw += c.toString('utf8')))
      stream.on('end', () => {
        received.push({ from: (session.envelope.mailFrom || { address: '' }).address, to: session.envelope.rcptTo.map((r) => r.address), raw, user: session.user as string })
        cb()
      })
    },
  })

  beforeAll(
    () =>
      new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => {
          port = (server.server.address() as { port: number }).port
          resolve()
        }),
      ),
  )
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const account = () =>
    MailAccountSchema.parse({
      id: 'shop',
      name: 'Shop',
      provider: 'gmail', // skips filing a copy in Sent over IMAP
      address: 'me@shop.test',
      fromName: 'Gonca from Shop',
      smtp: { host: '127.0.0.1', port, secure: false },
      signature: 'Shop · +90 555 000 00 00',
    })

  it('upgrades to TLS and sends a threaded reply with the signature, to every recipient', async () => {
    const id = await new MailClient(account(), 'app-pw', { rejectUnauthorized: false }).send({
      to: ['ann@cust.test'],
      cc: ['bob@cust.test'],
      subject: 'Re: Your order',
      text: 'Hi Ann,\n\nYour chairs ship on Monday.',
      inReplyTo: '<orig@cust.test>',
      references: ['<first@cust.test>', '<orig@cust.test>'],
      footer: 'This email was written with help from AI.',
    })
    expect(id).toMatch(/^<.+>$/)
    const got = received.at(-1)!
    expect(got.user).toBe('me@shop.test')
    expect(got.from).toBe('me@shop.test')
    expect(got.to).toEqual(['ann@cust.test', 'bob@cust.test'])
    const mail = await simpleParser(got.raw)
    expect(mail.from?.value[0]).toMatchObject({ name: 'Gonca from Shop', address: 'me@shop.test' })
    expect(mail.subject).toBe('Re: Your order')
    expect(mail.inReplyTo).toBe('<orig@cust.test>')
    expect(mail.references).toEqual(['<first@cust.test>', '<orig@cust.test>'])
    expect(mail.text).toContain('Your chairs ship on Monday.')
    // The disclosure sits between the text and the signature.
    expect(mail.text).toContain('Your chairs ship on Monday.\n\nThis email was written with help from AI.\n\n-- \nShop · +90 555 000 00 00')
  })

  it('explains a refused login', async () => {
    await expect(new MailClient(account(), 'wrong', { rejectUnauthorized: false }).send({ to: ['ann@cust.test'], cc: [], subject: 's', text: 'b' })).rejects.toThrow(/SMTP login was refused.*app password/)
  })
})
