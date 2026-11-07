import { Fragment, type ReactNode } from 'react'

/**
 * A translated sentence with elements in it: `rich(t('…', textVars), { folder: <code>…</code> })`.
 * `t` leaves placeholders it has no value for as written, so `{folder}` is still there to swap.
 */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1]
    return name && Object.prototype.hasOwnProperty.call(nodes, name) ? <Fragment key={i}>{nodes[name]}</Fragment> : part
  })
}
