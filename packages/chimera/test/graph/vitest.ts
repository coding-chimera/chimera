import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe as bunDescribe,
  expect,
  it as bunIt,
  mock,
  spyOn,
  test as bunTest,
} from "bun:test"

function withConditionalHelpers<T extends { skip: T }>(runner: T) {
  return Object.assign(runner, {
    skipIf: (condition: boolean) => (condition ? runner.skip : runner),
    runIf: (condition: boolean) => (condition ? runner : runner.skip),
  })
}

export const describe = withConditionalHelpers(bunDescribe)
export const it = withConditionalHelpers(bunIt)
export const test = withConditionalHelpers(bunTest)
export { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn }

export const vi = {
  fn: mock,
  spyOn,
  mock: mock.module,
}
