# Moving work to and from a box

A box only sees what is on `origin`. Use the first rung that fits.

## 1. Committed work through `origin` (the supported path)

Caller, before a remote dispatch:

1. Commit the base and `git push -u origin <branch>`.
2. Place with `--base <branch> --branch <worker-branch>` so `briefAddendum` names them.
3. `delegate_task` with `target` from the placement and **no `isolation`** (T3 refuses `isolation: "worktree"` on a
   box). Append `briefAddendum` verbatim to the full task.

Worker on the box, as the addendum says:

```sh
git fetch origin
git worktree add ~/work/<worker-branch> -b <worker-branch> origin/<branch>   # or the repo's worktreeCommand
# work only in that worktree, commit, then
git push -u origin HEAD                                                     # wip commits too, if BLOCKED
```

A read-only task uses `git worktree add --detach ~/work/<task> origin/<branch>` and returns findings in its final
message. Each task gets its own branch and path. The box's shared project checkout may be stale or dirty; leave it.

Caller after the result: `git fetch origin <worker-branch>` before reviewing or merging.

Branch names and `worktreeRoot` are put into a shell line the worker runs. The router rejects names that fail
`git check-ref-format --branch` or use characters outside `A-Z a-z 0-9 . _ / -` (plus a leading `~` for
`worktreeRoot`) before booking anything.

## 2. Uncommitted work

The router moves nothing itself. Either commit it (a `wip:` commit on a throwaway branch is fine) and use rung 1, or
use the user's own hooks: `box-router handoff --slot <id>` sends uncommitted work to the placed box and
`box-router fetch --slot <id>` brings results back. Both run only the commands the user configured
([setup.md](setup.md#lifecycle-hooks)); the router keeps no copy of what moves.

## 3. Small inputs through T3 attachments

`t3_attachment_prepare_upload`, POST the bytes, then `t3_thread_send_attachments` to an existing child thread (up
to eight files; respect the size limit of the upload branch you used). `delegate_task` itself takes text only.
Whether an attachment uploaded here reaches a thread on another environment is **unverified**: test once with a
small synthetic file before relying on it.

## 4. Results back

Text in the worker's final message; code on its pushed branch, proven by `branch@sha`. There is no T3 file return
channel. A screenshot or build output that must come back has to be committed to a branch or described in text.

## Not dispatch paths

- `t3 thread start` from a shell: exploratory only; remote targeting and outcomes are unverified.
- `t3_thread_launch`: a new top-level thread, only when the user asks for one. Whether it honours a worktree
  strategy on a linked box is unverified.

## Secrets

Never move a secret. Credentials are provisioned on the box by the user and appear only as `secret:<name>` tags.
Keep values out of tasks, commits, attachments and observations.
