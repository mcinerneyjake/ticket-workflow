# Finished specs

A spec lives in this directory while its spec ticket is open. When the ticket is done, the file is
deleted and indexed here by a permalink to the last commit that held it. There is no archive folder,
because an in-tree archive is still read as current. `ticket-workflow specs` checks this index against
the board; it never edits it.

One line per finished spec:

```
- [<path>](https://github.com/<owner>/<repo>/blob/<sha>/<path>) — <spec ticket id>, finished <YYYY-MM-DD>
```

`<sha>` is the full 40-character commit: a short hex ref could be a branch name, which moves.

None yet.
