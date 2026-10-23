/**
 * Regression: a risk-policy escalation that DELEGATES (`onHighRisk:
 * 'delegate'`, the default) is not a denial — the answerer did not settle
 * the request, it continued the chain (`outcome` is absent from the verdict
 * event, exactly as the answerer writes it). Only an escalation that
 * settles `rejected` (`onHighRisk: 'deny'`) denied the request. Counting
 * delegated escalations as denials trips the rejection circuit breaker on
 * requests nobody denied and lists them for `/auto-review approve`.
 * @module dsh-auto-review/test/escalation-denial.spec
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  consecutiveDeniesInOpenTurn,
  deniesInRecentVerdicts,
  isDenial,
  lastDeniedVerdicts,
} from '../src/events.ts'
import { applyAutoReview, initAutoReviewProjection, viewAutoReview } from '../src/projection.ts'

function sessionWith(...events: { type: string; data: unknown }[]): Session {
  const session = Session.create(SessionId(`escalation-${events.length}`))
  const append = session.append as unknown as (type: string, data: unknown) => unknown
  for (const event of events) {
    append.call(session, event.type, event.data)
  }
  return session
}

/** The exact verdict payload the answerer appends for a DELEGATED escalation (no outcome). */
const delegatedEscalation = {
  reviewId: 'r-delegated', approvalId: 'a-delegated', toolName: 'bash', provider: 'fork',
  durationMs: 1, decision: 'allow', reason: 'risky but reversible', riskLevel: 'high',
  escalation: 'risk-policy',
} as const

/** The exact verdict payload the answerer appends for a DENIED escalation. */
const deniedEscalation = {
  ...delegatedEscalation,
  reviewId: 'r-denied', approvalId: 'a-denied', outcome: 'rejected',
} as const

describe('isDenial', () => {
  it('does not count a delegated risk-policy escalation as a denial', () => {
    expect(isDenial(delegatedEscalation as never)).toBe(false)
  })

  it('counts a risk-policy escalation that settled rejected as a denial', () => {
    expect(isDenial(deniedEscalation as never)).toBe(true)
  })
})

describe('circuit-breaker folds over delegated escalations', () => {
  it('does not build a consecutive-denial run out of delegated escalations', () => {
    const session = sessionWith(
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'autoReview/verdict', data: { ...delegatedEscalation, reviewId: 'r1', approvalId: 'a1' } },
      { type: 'autoReview/verdict', data: { ...delegatedEscalation, reviewId: 'r2', approvalId: 'a2' } },
      { type: 'autoReview/verdict', data: { ...delegatedEscalation, reviewId: 'r3', approvalId: 'a3' } },
    )
    // The default breaker trips at 3 consecutive denials: three delegated
    // high-risk allows in one turn must not trip it.
    expect(consecutiveDeniesInOpenTurn(session.snapshotEvents())).toBe(0)
    expect(deniesInRecentVerdicts(session.snapshotEvents(), 10)).toBe(0)
  })

  it('still counts denied escalations toward the breaker', () => {
    const session = sessionWith(
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'autoReview/verdict', data: deniedEscalation },
    )
    expect(consecutiveDeniesInOpenTurn(session.snapshotEvents())).toBe(1)
    expect(deniesInRecentVerdicts(session.snapshotEvents(), 10)).toBe(1)
  })
})

describe('approve list over delegated escalations', () => {
  it('does not list a delegated escalation as a denial to approve', () => {
    const session = sessionWith(
      { type: 'autoReview/verdict', data: delegatedEscalation },
    )
    expect(lastDeniedVerdicts(session.snapshotEvents(), 5)).toEqual([])
  })

  it('still lists a denied escalation', () => {
    const session = sessionWith(
      { type: 'autoReview/verdict', data: deniedEscalation },
    )
    expect(lastDeniedVerdicts(session.snapshotEvents(), 5).map(row => row.reviewId)).toEqual(['r-denied'])
  })
})

describe('projection deny feed over delegated escalations', () => {
  function rawEvent(type: string, data: unknown): never {
    return { type, seq: 0, time: 0, data } as never
  }

  it('does not add a delegated escalation to recentDenies', () => {
    let state = initAutoReviewProjection(true, 's1')
    state = applyAutoReview(state, rawEvent('autoReview/verdict', delegatedEscalation))
    expect(viewAutoReview(state).recentDenies).toEqual([])
  })

  it('still adds a denied escalation to recentDenies', () => {
    let state = initAutoReviewProjection(true, 's1')
    state = applyAutoReview(state, rawEvent('autoReview/verdict', deniedEscalation))
    expect(viewAutoReview(state).recentDenies.map(row => row.reviewId)).toEqual(['r-denied'])
  })
})
