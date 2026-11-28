import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gateFailures, requiredWorkflows, type WorkflowRun } from './release-gate.ts'

const sha = 'a'.repeat(40)
const passing = (): WorkflowRun[] => requiredWorkflows.map((path, index) =>
  ({ id: index + 10, path, event: 'push', head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'success' }))

test('publishing requires the commit on main and successful main push CI', () => {
  assert.deepEqual(gateFailures(sha, 'ahead', passing()), [])
  assert.deepEqual(gateFailures(sha, 'identical', passing()), [])
  for (const status of ['diverged', 'behind']) assert.match(gateFailures(sha, status, passing()).join(), /not on main/)
  for (const path of requiredWorkflows) {
    assert.match(gateFailures(sha, 'ahead', passing().filter(run => run.path !== path)).join(), /no main push run/, path)
    for (const change of [{ conclusion: 'failure' }, { conclusion: null, status: 'in_progress' }, { conclusion: 'cancelled' }]) {
      const runs = passing().map(run => run.path === path ? { ...run, ...change } : run)
      assert.match(gateFailures(sha, 'ahead', runs).join(), /not completed\/success/, `${path} ${JSON.stringify(change)}`)
    }
    // Runs from a pull request, another branch or another commit never count.
    for (const change of [{ event: 'pull_request' }, { head_branch: 'feature' }, { head_sha: 'b'.repeat(40) }]) {
      const runs = passing().map(run => run.path === path ? { ...run, ...change } : run)
      assert.match(gateFailures(sha, 'ahead', runs).join(), /no main push run/, `${path} ${JSON.stringify(change)}`)
    }
  }
  // The newest run (a re-run after a failure) decides.
  const rerun = [...passing().map(run => ({ ...run, conclusion: 'failure' })), ...passing().map(run => ({ ...run, id: run.id + 100 }))]
  assert.deepEqual(gateFailures(sha, 'ahead', rerun), [])
  assert.equal(gateFailures(sha, 'ahead', rerun.map(run => run.id > 100 ? { ...run, conclusion: 'failure' } : run)).length, 4)
})
