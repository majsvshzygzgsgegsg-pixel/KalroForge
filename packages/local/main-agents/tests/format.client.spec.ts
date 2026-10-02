import { describe, expect, it } from 'vitest'
import { dependencyLevels, duration, statusDot, statusTone } from '../src/client/format.ts'

describe('workflow view helpers', () => {
  it('lays tasks out in dependency levels so parallel work shares a level', () => {
    const levels = dependencyLevels([
      { id: 'integrate', dependsOn: ['api', 'ui'] },
      { id: 'api', dependsOn: ['plan'] },
      { id: 'plan', dependsOn: [] },
      { id: 'ui', dependsOn: ['plan'] },
    ])
    expect(levels.map(level => level.map(task => task.id))).toEqual([['plan'], ['api', 'ui'], ['integrate']])
  })

  it('terminates on a dependency cycle instead of recursing forever', () => {
    const levels = dependencyLevels([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }])
    expect(levels.flat().map(task => task.id).toSorted()).toEqual(['a', 'b'])
  })

  it('maps every orchestration status to a dot and tone', () => {
    expect(statusDot('running')).toBe('ongoing')
    expect(statusDot('failed')).toBe('error')
    expect(statusDot('paused')).toBe('warning')
    expect(statusDot('completed')).toBe('done')
    expect(statusTone('recurred')).toBe('danger')
    expect(statusTone('recovered')).toBe('success')
    expect(duration(252_000)).toBe('4m 12s')
  })
})
