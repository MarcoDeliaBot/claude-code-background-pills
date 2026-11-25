# background-pills

A Claude Code mod: one row of pills above the message box, one pill for each piece of background
work in the session (workflows, background agents, background shell commands), shown only while
it runs.

- The pill fills as the work moves toward its end, with the percent and the time left: exact when
  a command states its wait, estimated (`~`) from earlier runs or from a workflow's pace otherwise.
- Work with no known end shows a breathing dot, a passing light and the time running.
- Pointing at a pill shows its detail on the same row.
- Work that ends well turns green with a ✓ for two seconds, then goes.
- Pills that do not fit the row are counted in `+N`.
- With the band collapsed, the status line under the message box says the same in a few words.

Pictures, install steps and details: see the [repository README](../README.md).

Turn it off: **+** next to the message box → **Plugins** → turn off `background-pills`, or
`claude plugin disable background-pills@background-pills`.
